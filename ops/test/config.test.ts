import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, OPS_ONLY_KEYS, type ConfigKey } from "../src/lib/config-keys";
import {
  Config,
  MissingSecretError,
  SecretInConfigError,
  SettingAsSecretError,
  UnknownConfigKeyError,
  maybeSecret,
  secret,
} from "../src/lib/config";

// ── The old code, read from the repo ─────────────────────────
const setupSource = readFileSync(new URL("../../src/Setup.gs", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../../src/Auth.gs", import.meta.url), "utf8");

type OldHelper = (key: string, def?: unknown) => unknown;
/** The real configValue_ from src/Auth.gs (the other six copies apply the same rule), run over a fixed map. */
function oldHelper(map: Record<string, unknown>): OldHelper {
  const m = /function configValue_\(key, defaultValue\) \{[\s\S]*?\n  \}/.exec(authSource);
  if (!m) throw new Error("configValue_ not found in src/Auth.gs");
  return new Function("getConfigMap_", `${m[0]}\nreturn configValue_;`)(() => map) as OldHelper;
}

/** Every [key, default] in Setup.gs's configDefaults_(): the literal, or "<dynamic>" for the timezone call. */
function setupDefaults(): Map<string, string> {
  const body = /function configDefaults_\(\) \{([\s\S]*?)\n\}/.exec(setupSource);
  if (!body?.[1]) throw new Error("configDefaults_ not found in src/Setup.gs");
  const out = new Map<string, string>();
  for (const line of body[1].split("\n")) {
    const m = /^\s*\['([a-z0-9_]+)',\s*('[^']*'|Session\.getScriptTimeZone\(\)),/.exec(line);
    if (!m) continue;
    out.set(m[1] as string, (m[2] as string).startsWith("'") ? (m[2] as string).slice(1, -1) : "<dynamic>");
  }
  return out;
}

/** Keys in Setup.gs that belong only to areas that are not moved (plan: "Not migrated: deprecated areas"). */
const LEFT_OUT: Readonly<Record<string, string>> = {
  whatsapp_template_shopping_list: "shopping-list WhatsApp message; the shopping list is not migrated",
};
/**
 * Keys that exist only in the Operations app: Setup.gs has no row for them because the Sheet never had
 * the feature (the till link, cards P5-02a on). Each is registered here and nowhere in the old app.
 */
const OPS_ONLY: Readonly<Record<string, string>> = {
  till_enabled: "the till link's switch (card P5-02a)",
  till_api_url: "the till's address (card P5-02a)",
  till_key_expires_on: "the day the till key expires (card P5-02a)",
  till_api_key: "the till's key: a Worker secret (card P5-02a)",
};
/** Secrets whose name does not match the naming rule but whose value is a credential. Empty on purpose. */
const SECRET_BY_DESCRIPTION: readonly string[] = [];
const NAMING_RULE = /(_token|_key|_secret)$|password/;
/** Registry defaults that cannot equal Setup.gs's literal, with the reason. */
const DYNAMIC_DEFAULT: Readonly<Record<string, string>> = {
  timezone: "Setup.gs calls Session.getScriptTimeZone(); the manifest (src/appsscript.json) sets America/Toronto",
};

const k = (s: string) => s as ConfigKey;
const row = (key: string, value: string | null) => ({ key, value });
const cfg = (rows: Array<{ key: string; value: string | null }>) => Config.fromRows(rows);

describe("registry honesty against src/Setup.gs", () => {
  const defaults = setupDefaults();

  it("parses the Setup.gs list (guards the parser itself)", () => {
    expect(defaults.size).toBeGreaterThan(30);
    expect(defaults.get("cstore_default_opening_float")).toBe("250");
    expect(defaults.get("timezone")).toBe("<dynamic>");
  });

  it("every registry key exists in Setup.gs with the same default", () => {
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
      if (OPS_ONLY_KEYS.includes(key)) {
        expect(defaults.has(key), `${key} is listed as Operations-only but is in Setup.gs`).toBe(false);
        continue;
      }
      expect(defaults.has(key), `${key} is not in Setup.gs`).toBe(true);
      if (key in DYNAMIC_DEFAULT) continue;
      expect(spec.default, `default of ${key}`).toBe(defaults.get(key));
    }
  });

  it("every Setup.gs key is in the registry or in the explicit left-out list", () => {
    for (const key of defaults.keys()) {
      const inRegistry = key in CONFIG_KEYS;
      const leftOut = key in LEFT_OUT;
      expect(inRegistry || leftOut, `${key} is neither registered nor left out`).toBe(true);
      expect(inRegistry && leftOut, `${key} is both registered and left out`).toBe(false);
    }
    for (const key of Object.keys(LEFT_OUT)) expect(defaults.has(key), `stale left-out entry ${key}`).toBe(true);
    for (const key of Object.keys(DYNAMIC_DEFAULT)) expect(key in CONFIG_KEYS).toBe(true);
    for (const key of OPS_ONLY_KEYS) expect(key in CONFIG_KEYS, `stale Operations-only entry ${key}`).toBe(true);
  });

  it("the Operations-only keys are registered, and Setup.gs really does not have them", () => {
    for (const key of Object.keys(OPS_ONLY)) {
      expect(key in CONFIG_KEYS, `${key} is not registered`).toBe(true);
      expect(defaults.has(key), `${key} is in Setup.gs: it is not Operations-only`).toBe(false);
    }
  });

  it("secret kind follows the naming rule, plus the explicit by-description list", () => {
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
      if (spec.kind === "secret") {
        expect(NAMING_RULE.test(key) || SECRET_BY_DESCRIPTION.includes(key), `${key} is marked secret without reason`).toBe(true);
      } else {
        expect(NAMING_RULE.test(key), `${key} matches the secret naming rule but is a setting`).toBe(false);
        expect(SECRET_BY_DESCRIPTION.includes(key)).toBe(false);
      }
    }
    const secrets = Object.entries(CONFIG_KEYS)
      .filter(([, s]) => s.kind === "secret")
      .map(([n]) => n);
    expect(secrets.sort()).toEqual(["clover_cstore_token", "clover_vape_token", "till_api_key", "whatsapp_api_token"]);
  });

  it("secrets have a blank default", () => {
    for (const spec of Object.values(CONFIG_KEYS)) if (spec.kind === "secret") expect(spec.default).toBe("");
  });
});

describe("Config.value vs the old configValue_", () => {
  // missing row, NULL (an empty cell in the Sheet), '', ' ', normal
  const cases: Array<{ name: string; rows: Array<{ key: string; value: string | null }>; sheet: Record<string, unknown> }> = [
    { name: "missing row", rows: [], sheet: {} },
    { name: "NULL", rows: [row("cstore_business_name", null)], sheet: { cstore_business_name: "" } },
    { name: "empty string", rows: [row("cstore_business_name", "")], sheet: { cstore_business_name: "" } },
    { name: "a single space", rows: [row("cstore_business_name", " ")], sheet: { cstore_business_name: " " } },
    { name: "padded text", rows: [row("cstore_business_name", "  Corner Shop ")], sheet: { cstore_business_name: "  Corner Shop " } },
    { name: "normal", rows: [row("cstore_business_name", "Corner Shop")], sheet: { cstore_business_name: "Corner Shop" } },
  ];
  for (const c of cases) {
    it(`${c.name}: same as the old helper, with the caller's default and with the registry's`, () => {
      const old = oldHelper(c.sheet);
      const config = cfg(c.rows);
      expect(config.value(k("cstore_business_name"), "Caller Default")).toBe(old("cstore_business_name", "Caller Default"));
      expect(config.value(k("cstore_business_name"))).toBe(old("cstore_business_name", "Scarbro Mart"));
    });
  }

  it("a space is a value and is returned exactly as stored", () => {
    expect(cfg([row("cstore_business_name", " ")]).value(k("cstore_business_name"))).toBe(" ");
    expect(cfg([row("cstore_business_name", "  x  ")]).value(k("cstore_business_name"))).toBe("  x  ");
  });

  it("the caller's default beats the registry default; the registry default is used otherwise", () => {
    const empty = cfg([]);
    expect(empty.value(k("cstore_business_name"))).toBe("Scarbro Mart");
    expect(empty.value(k("cstore_business_name"), "Mine")).toBe("Mine");
    expect(empty.value(k("cstore_business_name"), "")).toBe("");
  });

  it("a stored value beats both defaults", () => {
    expect(cfg([row("session_hours", "8")]).value(k("session_hours"), "99")).toBe("8");
  });
});

describe("typed readers mirror the old call-site expressions", () => {
  const inputs = ["true", "TRUE", "True", "false", "", "1", "0", "abc", " 12 ", "12.5", "-3", "a, b ,c", " "];
  const sheetOf = (key: string, v: string) => ({ [key]: v });

  // src/Auth.gs:97,169,196,214,215  src/Reconcile.gs:54,161,234,470,471  src/TillSessions.gs:112,113
  //   Number(configValue_(key, D)) || D
  // src/Commissions.gs:327 applies the same rule to the raw row: if (row[1] !== '') Number(row[1]) || 9
  it("number() equals Number(configValue_(k, D)) || D", () => {
    const keys: Array<[ConfigKey, number]> = [
      [k("session_hours"), 24],
      [k("login_lockout_mins"), 60],
      [k("login_max_fails"), 5],
      [k("card_variance_threshold"), 1],
      [k("variance_ok_threshold"), 1],
      [k("variance_minor_threshold"), 30],
      [k("commission_run_hour"), 9],
    ];
    for (const [key, d] of keys) {
      for (const v of inputs) {
        const old = oldHelper(sheetOf(key, v));
        const expected = Number(old(key, d)) || d;
        expect(cfg([row(key, v)]).number(key), `${key}=${JSON.stringify(v)}`).toBe(expected);
        expect(cfg([row(key, v)]).number(key, d)).toBe(expected);
      }
      expect(cfg([]).number(key)).toBe(d);
      expect(cfg([row(key, null)]).number(key)).toBe(d);
    }
  });

  it("number(): a blank setting is its default, never 0; an explicit '0' also falls back (old `|| D`)", () => {
    expect(cfg([row("session_hours", "")]).number(k("session_hours"))).toBe(24);
    expect(cfg([row("session_hours", " ")]).number(k("session_hours"))).toBe(24); // Number(' ') is 0, so || D
    expect(cfg([row("session_hours", "0")]).number(k("session_hours"))).toBe(24);
    expect(cfg([row("session_hours", "abc")]).number(k("session_hours"))).toBe(24);
    expect(cfg([row("session_hours", " 12 ")]).number(k("session_hours"))).toBe(12);
    expect(cfg([row("session_hours", "12.5")]).number(k("session_hours"))).toBe(12.5);
    expect(cfg([row("session_hours", "-3")]).number(k("session_hours"))).toBe(-3); // old code keeps a negative here
  });

  it("number(): the caller's default wins over the registry's", () => {
    expect(cfg([]).number(k("session_hours"), 6)).toBe(6);
    expect(cfg([row("session_hours", "abc")]).number(k("session_hours"), 6)).toBe(6);
  });

  // ODD SITES (not what number() does; listed in the card report):
  // src/CashHandling.gs:115  n = Number(v); isNaN(n) || n <= 0 ? 7 : n   (a negative gives 7, not the negative)
  // src/TillSessions.gs:50,57  Number(configValue_(k, D)) || 0          (garbage or '0' gives 0, not D)
  it("documents where number() differs from the two odd sites", () => {
    const cash = (v: string) => {
      const n = Number(oldHelper({ cash_handover_stale_days: v })("cash_handover_stale_days", 7));
      return isNaN(n) || n <= 0 ? 7 : n;
    };
    const till = (v: string) => Number(oldHelper({ lotto_reserve_default: v })("lotto_reserve_default", 500)) || 0;
    const c = (key: string, v: string) => cfg([row(key, v)]);
    for (const v of ["", "abc", "0", "12", "-3"]) {
      const mine = c("cash_handover_stale_days", v).number(k("cash_handover_stale_days"));
      const mineTill = c("lotto_reserve_default", v).number(k("lotto_reserve_default"));
      if (v === "-3") expect([mine, cash(v)]).toEqual([-3, 7]);
      else expect(mine).toBe(cash(v));
      if (v === "abc" || v === "0") expect([mineTill, till(v)]).toEqual([500, 0]);
      else expect(mineTill).toBe(till(v));
    }
  });

  // src/Clover.gs:29, src/Notifier.gs:36:  raw === true || String(raw).toLowerCase() === 'true'
  it("boolean() equals the Clover/Notifier expression", () => {
    for (const key of [k("clover_enabled"), k("notifier_enabled")]) {
      for (const v of inputs) {
        const raw = oldHelper(sheetOf(key, v))(key, "false");
        const expected = raw === true || String(raw).toLowerCase() === "true";
        expect(cfg([row(key, v)]).boolean(key), `${key}=${JSON.stringify(v)}`).toBe(expected);
      }
      expect(cfg([]).boolean(key)).toBe(false);
      expect(cfg([row(key, null)]).boolean(key)).toBe(false);
    }
    expect(cfg([row("clover_enabled", " true")]).boolean(k("clover_enabled"))).toBe(false); // no trim, as before
    expect(cfg([]).boolean(k("clover_enabled"), true)).toBe(true);
    expect(cfg([]).boolean(k("clover_enabled"), "TRUE")).toBe(true);
  });

  // ODD SITE: src/Sales.gs:54  String(configValue_(company + '_card_split', 'true')).trim().toLowerCase() !== 'false'
  // (true unless 'false'; and its default is 'true' for BOTH companies, where Setup.gs says cstore 'false').
  it("documents where boolean() differs from the card_split site", () => {
    const sales = (v: string) => String(oldHelper({ vape_card_split: v })("vape_card_split", "true")).trim().toLowerCase() !== "false";
    expect(sales("1")).toBe(true);
    expect(cfg([row("vape_card_split", "1")]).boolean(k("vape_card_split"))).toBe(false);
    expect(sales("")).toBe(true);
    expect(cfg([row("cstore_card_split", "")]).boolean(k("cstore_card_split"))).toBe(false); // registry default is Setup.gs's 'false'
    expect(cfg([row("cstore_card_split", "")]).boolean(k("cstore_card_split"), true)).toBe(true); // a reader can pass the site's own default
    expect(cfg([row("vape_card_split", "true")]).boolean(k("vape_card_split"))).toBe(true);
  });

  // src/Notifier.gs:143-144  String(configValue_('whatsapp_target_number', '') || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
  it("list() equals the recipients_ expression", () => {
    const key = k("whatsapp_target_number");
    for (const v of ["", " ", "a, b ,c", "14165551234", "1;2 3,,4", ",", "  a  "]) {
      const raw = oldHelper(sheetOf(key, v))(key, "");
      const expected = String(raw || "")
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      expect(cfg([row(key, v)]).list(key), JSON.stringify(v)).toEqual(expected);
    }
    expect(cfg([]).list(key)).toEqual([]);
    expect(cfg([row(key, null)]).list(key)).toEqual([]);
    expect(cfg([row(key, "a, b ,c")]).list(key)).toEqual(["a", "b", "c"]);
    expect(cfg([]).list(key, "x,y")).toEqual(["x", "y"]);
  });
});

describe("guards on keys", () => {
  const secretRow = "FAKE-TOKEN-do-not-use-0001";
  const withSecrets = cfg([row("whatsapp_api_token", secretRow), row("clover_cstore_token", "")]);

  it("every reader refuses a secret key, whether or not the table has a row", () => {
    for (const config of [withSecrets, cfg([])]) {
      for (const read of [
        () => config.value(k("whatsapp_api_token")),
        () => config.value(k("whatsapp_api_token"), "x"),
        () => config.number(k("clover_vape_token")),
        () => config.boolean(k("clover_cstore_token")),
        () => config.list(k("whatsapp_api_token")),
      ]) {
        expect(read).toThrow(SecretInConfigError);
      }
    }
  });

  it("the secret error names the key and never the stored value", () => {
    let message = "";
    try {
      withSecrets.value(k("whatsapp_api_token"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("whatsapp_api_token");
    expect(message).not.toContain(secretRow);
  });

  it("an unknown key throws on every reader", () => {
    const config = cfg([row("sesion_hours", "5")]);
    for (const read of [
      () => config.value(k("sesion_hours")),
      () => config.number(k("sesion_hours"), 3),
      () => config.boolean(k("sesion_hours")),
      () => config.list(k("sesion_hours")),
      () => config.value(k("whatsapp_template_shopping_list")),
    ]) {
      expect(read).toThrow(UnknownConfigKeyError);
    }
    expect(() => config.value(k("toString"))).toThrow(UnknownConfigKeyError); // not an inherited property
    expect(() => config.value(k("__proto__"))).toThrow(UnknownConfigKeyError);
  });

  it("secretsFoundInTable lists non-blank secret rows by name, never a value", () => {
    expect(withSecrets.secretsFoundInTable()).toEqual(["whatsapp_api_token"]);
    expect(cfg([row("clover_vape_token", "   "), row("clover_cstore_token", null)]).secretsFoundInTable()).toEqual([]);
    expect(cfg([]).secretsFoundInTable()).toEqual([]);
    expect(JSON.stringify(withSecrets.secretsFoundInTable())).not.toContain(secretRow);
    // a non-secret row never shows up, nor does a row for an unknown key
    expect(cfg([row("session_hours", "8"), row("nonsense_token", "x")]).secretsFoundInTable()).toEqual([]);
  });

  it("the snapshot cannot be changed by the caller", () => {
    const config = cfg([row("session_hours", "8")]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as unknown as Record<string, unknown>)["value"] = () => "x";
    }).toThrow();
    const found = withSecrets.secretsFoundInTable();
    found.push("session_hours");
    expect(withSecrets.secretsFoundInTable()).toEqual(["whatsapp_api_token"]);
    const rows = [row("session_hours", "8")];
    const built = cfg(rows);
    rows[0] = row("session_hours", "99");
    expect(built.value(k("session_hours"))).toBe("8"); // the input array is copied
  });
});

describe("secret / maybeSecret", () => {
  const FAKE = "FAKE-SECRET-VALUE-zq81-do-not-use";
  const env: Record<string, unknown> = {
    WHATSAPP_API_TOKEN: FAKE,
    CLOVER_CSTORE_TOKEN: "",
    CLOVER_VAPE_TOKEN: { fake: FAKE },
  };

  it("reads the upper-cased binding from the env object", () => {
    expect(secret(env, k("whatsapp_api_token"))).toBe(FAKE);
    expect(maybeSecret(env, k("whatsapp_api_token"))).toBe(FAKE);
  });

  it("absent: secret throws naming the binding; maybeSecret gives null", () => {
    expect(() => secret({}, k("whatsapp_api_token"))).toThrow(MissingSecretError);
    expect(() => secret({}, k("whatsapp_api_token"))).toThrow(/WHATSAPP_API_TOKEN/);
    expect(maybeSecret({}, k("whatsapp_api_token"))).toBeNull();
  });

  it("empty string counts as absent", () => {
    expect(() => secret(env, k("clover_cstore_token"))).toThrow(/CLOVER_CSTORE_TOKEN/);
    expect(maybeSecret(env, k("clover_cstore_token"))).toBeNull();
  });

  it("a non-string binding counts as absent, and its content never reaches the message", () => {
    for (const bad of [{ fake: FAKE }, 12345, true, null, undefined, [FAKE]]) {
      const e = { CLOVER_VAPE_TOKEN: bad };
      let message = "";
      try {
        secret(e, k("clover_vape_token"));
      } catch (err) {
        expect(err).toBeInstanceOf(MissingSecretError);
        message = (err as Error).message;
      }
      expect(message).toContain("CLOVER_VAPE_TOKEN");
      expect(message).not.toContain(FAKE);
      expect(maybeSecret(e, k("clover_vape_token"))).toBeNull();
    }
  });

  it("asking for a setting as a secret throws, even if a binding of that name exists", () => {
    const e = { SESSION_HOURS: "8", CSTORE_BUSINESS_NAME: FAKE };
    expect(() => secret(e, k("session_hours"))).toThrow(SettingAsSecretError);
    expect(() => maybeSecret(e, k("cstore_business_name"))).toThrow(SettingAsSecretError);
    let message = "";
    try {
      secret(e, k("cstore_business_name"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(FAKE);
  });

  it("an unknown key throws", () => {
    expect(() => secret({ NOPE_TOKEN: FAKE }, k("nope_token"))).toThrow(UnknownConfigKeyError);
    expect(() => maybeSecret({}, k("nope_token"))).toThrow(UnknownConfigKeyError);
  });

  it("no thrown message from any path contains the secret value", () => {
    const messages: string[] = [];
    const attempt = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        messages.push((e as Error).message);
      }
    };
    const config = cfg([row("whatsapp_api_token", FAKE)]);
    attempt(() => config.value(k("whatsapp_api_token")));
    attempt(() => config.number(k("whatsapp_api_token")));
    attempt(() => secret({ WHATSAPP_API_TOKEN: "" }, k("whatsapp_api_token")));
    attempt(() => secret({ SESSION_HOURS: FAKE }, k("session_hours")));
    expect(messages.length).toBe(4);
    for (const m of messages) expect(m).not.toContain(FAKE);
  });
});
