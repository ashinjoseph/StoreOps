// PIN hashing (Web Crypto only) and setPin. Test PINs and peppers are fake.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { hashPin, setPin, verifyPin } from "../src/auth/pin";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "test-pepper-not-a-secret";
const FORMAT = /^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/;

describe("hashPin / verifyPin", () => {
  it("round-trips, and the stored text has the documented format", async () => {
    const stored = await hashPin("4821", PEPPER);
    expect(stored).toMatch(FORMAT);
    expect(await verifyPin("4821", stored, PEPPER)).toBe(true);
  });

  it("never contains the PIN, and two hashes of one PIN differ (salt)", async () => {
    const a = await hashPin("4821", PEPPER);
    const b = await hashPin("4821", PEPPER);
    expect(a).not.toBe(b);
    expect(a).not.toContain("4821");
    expect(a.split("$")[2]).not.toBe(b.split("$")[2]);
    expect(await verifyPin("4821", b, PEPPER)).toBe(true);
  });

  it("a wrong PIN fails; a wrong pepper fails", async () => {
    const stored = await hashPin("4821", PEPPER);
    expect(await verifyPin("4822", stored, PEPPER)).toBe(false);
    expect(await verifyPin("", stored, PEPPER)).toBe(false);
    expect(await verifyPin("4821", stored, "another-fake-pepper")).toBe(false);
  });

  it("a tampered salt or hash fails", async () => {
    const stored = await hashPin("4821", PEPPER);
    const [alg, iter, salt, hash] = stored.split("$") as [string, string, string, string];
    const flip = (b64: string) => (b64[0] === "A" ? "B" : "A") + b64.slice(1);
    expect(await verifyPin("4821", [alg, iter, flip(salt), hash].join("$"), PEPPER)).toBe(false);
    expect(await verifyPin("4821", [alg, iter, salt, flip(hash)].join("$"), PEPPER)).toBe(false);
    expect(await verifyPin("4821", [alg, "99999", salt, hash].join("$"), PEPPER)).toBe(false);
  });

  it("malformed or empty stored values return false and never throw", async () => {
    const good = await hashPin("4821", PEPPER);
    const [alg, iter, salt, hash] = good.split("$") as [string, string, string, string];
    const bad = [
      "", "x", "$$$", "a$b$c$d", "pbkdf2-sha256$100000$$", `${alg}$${iter}$${salt}`, `${alg}$${iter}$${salt}$${hash}$extra`,
      `md5$${iter}$${salt}$${hash}`, `${alg}$abc$${salt}$${hash}`, `${alg}$0$${salt}$${hash}`, `${alg}$-5$${salt}$${hash}`,
      `${alg}$1.5$${salt}$${hash}`, `${alg}$${iter}$!!!!$${hash}`, `${alg}$${iter}$${salt}$AAAA`, `${alg}$${iter}$$${hash}`,
      `${alg}$100001$${salt}$${hash}`, // above the Workers cap: refused, not thrown
    ];
    for (const s of bad) expect(await verifyPin("4821", s, PEPPER), s).toBe(false);
    // Not strings at all (a NULL column).
    expect(await verifyPin("4821", null as unknown as string, PEPPER)).toBe(false);
    expect(await verifyPin("4821", undefined as unknown as string, PEPPER)).toBe(false);
  });

  it("reads the iteration count from the stored value (so it can be raised later)", async () => {
    const low = await hashPin("4821", PEPPER, { iterations: 1000 });
    expect(low.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    expect(await verifyPin("4821", low, PEPPER)).toBe(true);
    expect(await verifyPin("4822", low, PEPPER)).toBe(false);
  });

  it("an empty or missing pepper throws, for hashing and for verifying", async () => {
    const stored = await hashPin("4821", PEPPER);
    await expect(hashPin("4821", "")).rejects.toThrow(/pepper/i);
    await expect(hashPin("4821", undefined as unknown as string)).rejects.toThrow(/pepper/i);
    await expect(verifyPin("4821", stored, "")).rejects.toThrow(/pepper/i);
    await expect(verifyPin("4821", stored, undefined as unknown as string)).rejects.toThrow(/pepper/i);
  });

  it('"1234" and " 1234 " verify the same', async () => {
    const stored = await hashPin(" 1234 ", PEPPER);
    expect(await verifyPin("1234", stored, PEPPER)).toBe(true);
    expect(await verifyPin("  1234", stored, PEPPER)).toBe(true);
    const plain = await hashPin("1234", PEPPER);
    expect(await verifyPin(" 1234 ", plain, PEPPER)).toBe(true);
  });

  it("the pepper is really mixed in: the stored hash is not PBKDF2 of the bare PIN", async () => {
    const [, , salt, hash] = (await hashPin("4821", PEPPER)).split("$") as [string, string, string, string];
    const bare = await crypto.subtle.importKey("raw", new TextEncoder().encode("4821"), "PBKDF2", false, ["deriveBits"]);
    const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
    const out = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100000 }, bare, 256));
    expect(btoa(String.fromCharCode(...out))).not.toBe(hash);
  });
});

describe("setPin", () => {
  let testDb: TestDb;
  let db: Db & { close(): Promise<void> };
  beforeAll(async () => {
    testDb = await createTestDb();
    db = await connect(testDb.appUrl);
    await db.query("insert into ops.staff (staff_id, name, active, role) values ('S-PIN', 'Pia Example', true, 'employee')");
  });
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  const hashOf = async () => (await db.one<{ pin_hash: string | null }>("select pin_hash from ops.staff where staff_id = 'S-PIN'")).pin_hash;

  it("stores a verifiable hash (not the PIN) and audits staff.pin_set without PIN or hash", async () => {
    expect(await hashOf()).toBeNull();
    await setPin(db, "S-PIN", " 4821 ", PEPPER);
    const stored = await hashOf();
    expect(stored).toMatch(FORMAT);
    expect(stored).not.toContain("4821");
    expect(await verifyPin("4821", stored as string, PEPPER)).toBe(true);

    const rows = await db.query<Record<string, string | null>>("select * from ops.audit_log where action = 'staff.pin_set'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["target_type"]).toBe("staff");
    expect(rows[0]?.["target_id"]).toBe("S-PIN");
    const all = JSON.stringify(rows[0]);
    expect(all).not.toContain("4821");
    expect(all).not.toContain(stored as string);
    expect(all).not.toContain("pbkdf2");
  });

  it('rejects "12", "abcd", "123456789", "12 34", "" and non-strings, and changes nothing', async () => {
    const before = await hashOf();
    for (const bad of ["12", "abcd", "123456789", "12 34", "", "١٢٣٤", 1234 as unknown as string, null as unknown as string]) {
      await expect(setPin(db, "S-PIN", bad, PEPPER), String(bad)).rejects.toThrow(/4 to 8 digits/);
    }
    expect(await hashOf()).toBe(before);
    expect((await db.query("select 1 from ops.audit_log where action = 'staff.pin_set'")).length).toBe(1);
  });

  it("accepts 4 and 8 digits; an unknown person is an error; an empty pepper is an error", async () => {
    await setPin(db, "S-PIN", "1234", PEPPER);
    await setPin(db, "S-PIN", "12345678", PEPPER);
    await expect(setPin(db, "S-NOBODY", "1234", PEPPER)).rejects.toThrow(/no such staff/i);
    await expect(setPin(db, "S-PIN", "1234", "")).rejects.toThrow(/pepper/i);
  });
});
