import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { loadConfig } from "../src/lib/config";
import type { ConfigKey } from "../src/lib/config-keys";
import { createTestDb, type TestDb } from "./helpers/db";

type Conn = Db & { close(): Promise<void> };
let testDb: TestDb;
let db: Conn;
beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

const k = (s: string) => s as ConfigKey;
const put = (key: string, value: string | null) =>
  db.query("insert into ops.config (key, value, description) values ($1, $2, '') on conflict (key) do update set value = excluded.value", [key, value]);

/** A Db that records every call it is asked to make. */
function counting(inner: Db): { counted: Db; sql: string[] } {
  const sql: string[] = [];
  const counted: Db = {
    query: (t, p) => (sql.push(t), inner.query(t, p)),
    one: (t, p) => (sql.push(t), inner.one(t, p)),
    maybeOne: (t, p) => (sql.push(t), inner.maybeOne(t, p)),
  };
  return { counted, sql };
}

describe("loadConfig against a real database", () => {
  it("runs exactly one query however many keys are read", async () => {
    await put("session_hours", "8");
    await put("notifier_enabled", "TRUE");
    await put("whatsapp_target_number", "a, b");
    const { counted, sql } = counting(db);
    const config = await loadConfig(counted);
    expect(sql).toHaveLength(1);
    expect(config.number(k("session_hours"))).toBe(8);
    expect(config.boolean(k("notifier_enabled"))).toBe(true);
    expect(config.list(k("whatsapp_target_number"))).toEqual(["a", "b"]);
    expect(config.value(k("login_max_fails"))).toBe("5");
    config.secretsFoundInTable();
    expect(sql).toHaveLength(1); // reading does not query again
  });

  it("reflects rows inserted before the call and not rows inserted after it", async () => {
    await put("cstore_business_name", "Before Shop");
    const snapshot = await loadConfig(db);
    await put("cstore_business_name", "After Shop");
    await put("vape_business_name", "Added Later");
    expect(snapshot.value(k("cstore_business_name"))).toBe("Before Shop");
    expect(snapshot.value(k("vape_business_name"))).toBe("YV Vape Shop");
    const next = await loadConfig(db); // a new request sees the change: nothing is cached across calls
    expect(next.value(k("cstore_business_name"))).toBe("After Shop");
    expect(next.value(k("vape_business_name"))).toBe("Added Later");
  });

  it("treats NULL, '' and ' ' as the old helper does", async () => {
    await put("timezone", null);
    await put("public_report_url", "");
    await put("clover_base_url", " ");
    const config = await loadConfig(db);
    expect(config.value(k("timezone"))).toBe("America/Toronto");
    expect(config.value(k("public_report_url"))).toBe("");
    expect(config.value(k("public_report_url"), "https://x.example")).toBe("https://x.example");
    expect(config.value(k("clover_base_url"))).toBe(" ");
  });

  it("secretsFoundInTable lists a planted secret by name; reading it still throws", async () => {
    const FAKE = "FAKE-TOKEN-in-db-do-not-use";
    await put("whatsapp_api_token", FAKE);
    await put("clover_vape_token", "   ");
    const config = await loadConfig(db);
    expect(config.secretsFoundInTable()).toEqual(["whatsapp_api_token"]);
    expect(() => config.value(k("whatsapp_api_token"))).toThrow(/whatsapp_api_token/);
    let message = "";
    try {
      config.value(k("whatsapp_api_token"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(FAKE);
  });

  it("returns an immutable snapshot; a caller cannot change what later reads see", async () => {
    const config = await loadConfig(db);
    const list = config.secretsFoundInTable();
    list.length = 0;
    list.push("session_hours");
    expect(config.secretsFoundInTable()).toEqual(["whatsapp_api_token"]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as unknown as Record<string, unknown>)["value"] = () => "hacked";
    }).toThrow();
    expect(config.value(k("cstore_business_name"))).toBe("After Shop");
  });

  it("rows for keys the registry does not know are carried but cannot be read", async () => {
    await put("whatsapp_template_shopping_list", "old_template");
    const config = await loadConfig(db);
    expect(() => config.value(k("whatsapp_template_shopping_list"))).toThrow(/not a known config key/);
  });
});
