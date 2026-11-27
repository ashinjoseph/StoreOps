// The config registry: every key of the Sheet's `config` tab (src/Setup.gs,
// configDefaults_()) that a module being moved still uses, written out by hand.
//
//   default  exactly as Setup.gs has it (always text: the table stores text).
//   kind     "setting" lives in the config table; "secret" lives in a Worker
//            secret binding and is never read from, or stored in, the table.
//   read     how call sites parse the stored text: "text" as is, "number"
//            `Number(v) || default`, "boolean" case-insensitive 'true',
//            "list" split on commas, semicolons and spaces.
//
// A key is a secret when its name ends in _token, _key or _secret or contains
// "password", or when its value is a credential by its description. No key is
// a secret by description alone: the Clover merchant ids and the WhatsApp API
// URL (it holds a phone-number id) are identifiers, not credentials.
//
// Left out on purpose (areas not being moved; plan "Not migrated"):
//   whatsapp_template_shopping_list   the shopping-list message.
//
// test/config.test.ts compares this file with Setup.gs, so a key added there
// fails a test until it is added here or listed as left out. A key only the
// Operations app has (the till link's four, at the end) is listed there as OPS_ONLY.

export type ConfigKind = "setting" | "secret";
export type ConfigRead = "text" | "number" | "boolean" | "list";

export interface ConfigKeySpec {
  readonly kind: ConfigKind;
  readonly read: ConfigRead;
  readonly default: string;
}

const setting = (read: ConfigRead, def: string): ConfigKeySpec => ({ kind: "setting", read, default: def });
const credential: ConfigKeySpec = { kind: "secret", read: "text", default: "" };

export const CONFIG_KEYS = {
  cstore_default_opening_float: setting("number", "250"),
  vape_default_opening_float: setting("number", "100"),
  lotto_reserve_default: setting("number", "500"),
  variance_ok_threshold: setting("number", "1"),
  variance_minor_threshold: setting("number", "30"),
  cstore_business_name: setting("text", "Scarbro Mart"),
  vape_business_name: setting("text", "YV Vape Shop"),
  session_hours: setting("number", "24"),
  login_max_fails: setting("number", "5"),
  login_lockout_mins: setting("number", "60"),
  commission_run_day: setting("number", "1"),
  commission_run_hour: setting("number", "9"),
  // Operations app only (card P4-13): pauses the weekly run. See OPS_ONLY_KEYS.
  commission_run_paused: setting("boolean", "false"),
  notifier_enabled: setting("boolean", "false"),
  whatsapp_target_number: setting("list", ""),
  whatsapp_api_url: setting("text", ""),
  whatsapp_api_token: credential,
  whatsapp_template_name: setting("text", ""),
  whatsapp_template_lang: setting("text", "en"),
  whatsapp_template_shift_open: setting("text", ""),
  whatsapp_template_shift_close: setting("text", ""),
  clover_enabled: setting("boolean", "false"),
  clover_base_url: setting("text", "https://api.clover.com"),
  clover_cstore_merchant_id: setting("text", ""),
  clover_cstore_token: credential,
  clover_vape_merchant_id: setting("text", ""),
  clover_vape_token: credential,
  card_variance_threshold: setting("number", "1"),
  cstore_card_split: setting("boolean", "false"),
  vape_card_split: setting("boolean", "true"),
  cstore_epos_from: setting("text", ""),
  whatsapp_template_shift_close_cstore: setting("text", ""),
  whatsapp_template_shift_close_vape: setting("text", ""),
  cash_manager_staff_id: setting("text", ""),
  cash_handover_stale_days: setting("number", "7"),
  public_report_url: setting("text", ""),
  // Setup.gs uses Session.getScriptTimeZone(); the manifest (src/appsscript.json) sets this zone.
  timezone: setting("text", "America/Toronto"),
  // Operations only: the Sheet's config tab never had these, so Setup.gs has no row for them
  // (test/config.test.ts lists them as OPS_ONLY). The till link, switched off (card P5-02a, ADR-0024).
  till_enabled: setting("boolean", "false"),
  till_api_url: setting("text", ""),
  till_key_expires_on: setting("text", ""),
  till_api_key: credential,
  // Operations app only (card P5-11, the MCP door): not in Setup.gs; listed in OPS_ONLY_KEYS below.
  assistants_enabled: setting("boolean", "false"),
  assistant_calls_per_minute: setting("number", "30"),
  assistant_proposals_per_day: setting("number", "200"),
  // card P5-12b: how large an original an assistant is shown in one answer (receipt_original).
  assistant_show_max_mb: setting("number", "8"),
  // Operations app only (card P5-12a, the receipt inbox): not in Setup.gs; listed in OPS_ONLY_KEYS below.
  receipt_max_mb: setting("number", "10"),
  // card P5-05a: the HST rate the receipt drafts' checks use (percent; read as exact text, so 0 is 0).
  hst_rate_percent: setting("number", "13"),
} as const satisfies Record<string, ConfigKeySpec>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

/** The spec for a registered key, or undefined. Own properties only: "toString" is not a key. */
export function configKeySpec(key: string): ConfigKeySpec | undefined {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key) ? (CONFIG_KEYS as Record<string, ConfigKeySpec>)[key] : undefined;
}

/**
 * Keys that exist only in the Operations app: the Sheet's config tab never had them, so they are not
 * in Setup.gs (test/config.test.ts checks both directions against this list).
 */
export const OPS_ONLY_KEYS: readonly string[] = [
  // card P5-02a, the till link
  "till_enabled",
  "till_api_url",
  "till_key_expires_on",
  "till_api_key",
  // card P5-11, the MCP door
  "assistants_enabled",
  "assistant_calls_per_minute",
  "assistant_proposals_per_day",
  "assistant_show_max_mb",
  // card P4-13, pause the Monday commission run
  "commission_run_paused",
  // card P5-12a, the receipt inbox
  "receipt_max_mb",
  // card P5-05a, receipt drafts
  "hst_rate_percent",
];

export const SECRET_KEYS: readonly ConfigKey[] = (Object.keys(CONFIG_KEYS) as ConfigKey[]).filter((key) => CONFIG_KEYS[key].kind === "secret");
