// The Staff module and its three read RPCs, against a real database with invented people.
//
// What the parity cases cannot cover (the fixture has no inactive person, no blank
// rate, no blank companies, no padded names) is covered here. The expected values
// are what Staff.gs rowToRecord_ and the three rpc* functions in WebApp.gs return.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import * as staff from "../src/modules/staff";
import { rpcGetActiveStaffForLogin, rpcGetAllStaff, rpcGetStaffDirectory } from "../src/rpc/handlers/staff";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };

// Inserted out of id order on purpose: a result in insertion order would pass a sloppy implementation.
const ROWS: Array<[string, string, number | null, boolean, string, string | null, string | null, string | null, string | null]> = [
  // id, name, rate, active, role, companies, email, start_date, notes
  ["S_003", "Cleo Marsh", 18.25, true, "employee", "vape", "cleo@example.test", "2026-03-02", "  keeps spaces  "],
  ["S_001", "  Ada Quill  ", 0, true, "admin", " cstore , vape ,, ", null, null, null],
  ["S_005", "Eli Stone", null, true, "employee", null, null, null, null],
  ["S_002", "Bram Hale", 21, false, "manager", "cstore,vape", "  bram@example.test ", null, ""],
  ["S_004", "Dara Vance", 17.5, true, "payroll_admin", "", null, null, null],
];

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  for (const r of ROWS) {
    await db.query(
      "insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      r,
    );
  }
});
afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

const ctx = (): RpcContext => ({ db: db as never, session: null, config: () => Promise.reject(new Error("no config")), env: {}, fetch, now: new Date(Date.UTC(2026, 5, 1)) });

describe("getAll", () => {
  it("returns everyone, active or not, in staff_id order whatever the insert order", async () => {
    expect((await staff.getAll(db)).map((s) => s.staffId)).toEqual(["S_001", "S_002", "S_003", "S_004", "S_005"]);
  });

  it("trims names and emails, splits and trims companies, keeps notes as typed", async () => {
    const all = await staff.getAll(db);
    expect(all[0]).toMatchObject({ staffId: "S_001", name: "Ada Quill", companiesAuthorized: ["cstore", "vape"], email: "", notes: "" });
    expect(all[1]).toMatchObject({ email: "bram@example.test", active: false });
    expect(all[2]).toMatchObject({ notes: "  keeps spaces  ", email: "cleo@example.test", startDate: "2026-03-02" });
  });

  it("gives a blank or empty companies list as [], and a missing start date as null", async () => {
    const byId = Object.fromEntries((await staff.getAll(db)).map((s) => [s.staffId, s]));
    expect(byId["S_005"]!.companiesAuthorized).toEqual([]);
    expect(byId["S_004"]!.companiesAuthorized).toEqual([]);
    expect(byId["S_005"]!.startDate).toBeNull();
  });

  it("reads a blank rate as 0 (Staff.gs: Number(x) || 0; the old behaviour, kept so parity holds)", async () => {
    const byId = Object.fromEntries((await staff.getAll(db)).map((s) => [s.staffId, s]));
    expect(byId["S_005"]!.hourlyRate).toBe(0);
    expect(byId["S_001"]!.hourlyRate).toBe(0);
    expect(byId["S_003"]!.hourlyRate).toBe(18.25);
  });

  it("never carries a PIN in any form", async () => {
    for (const s of await staff.getAll(db)) expect(Object.keys(s).filter((k) => /code|pin/i.test(k))).toEqual([]);
  });
});

describe("getActive and getById", () => {
  it("getActive leaves out the inactive person and keeps the order", async () => {
    expect((await staff.getActive(db)).map((s) => s.staffId)).toEqual(["S_001", "S_003", "S_004", "S_005"]);
  });
  it("getById finds one, inactive included, or null", async () => {
    expect((await staff.getById(db, "S_002"))?.name).toBe("Bram Hale");
    expect(await staff.getById(db, "S_999")).toBeNull();
  });
});

describe("rpcGetActiveStaffForLogin", () => {
  it("answers { success, staff: [{ staffId, name }] } for active people only, trimmed, in order", async () => {
    expect(await rpcGetActiveStaffForLogin(ctx())).toEqual({
      success: true,
      staff: [
        { staffId: "S_001", name: "Ada Quill" },
        { staffId: "S_003", name: "Cleo Marsh" },
        { staffId: "S_004", name: "Dara Vance" },
        { staffId: "S_005", name: "Eli Stone" },
      ],
    });
  });
  it("answers { success: false, error } when the read fails, as the old one did", async () => {
    const broken = { ...ctx(), db: { query: () => Promise.reject(new Error("boom")) } as never };
    expect(await rpcGetActiveStaffForLogin(broken)).toEqual({ success: false, error: "boom" });
  });
});

describe("rpcGetStaffDirectory", () => {
  it("lists everyone with only { staffId, name, active }, sorted by name", async () => {
    expect(await rpcGetStaffDirectory(ctx())).toEqual([
      { staffId: "S_001", name: "Ada Quill", active: true },
      { staffId: "S_002", name: "Bram Hale", active: false },
      { staffId: "S_003", name: "Cleo Marsh", active: true },
      { staffId: "S_004", name: "Dara Vance", active: true },
      { staffId: "S_005", name: "Eli Stone", active: true },
    ]);
  });
});

describe("rpcGetAllStaff", () => {
  it("returns the eight fields, startDate always null, and no PIN", async () => {
    const out = (await rpcGetAllStaff(ctx())) as Array<Record<string, unknown>>;
    expect(out.map((s) => s["staffId"])).toEqual(["S_001", "S_002", "S_003", "S_004", "S_005"]);
    for (const s of out) {
      expect(Object.keys(s)).toEqual(["staffId", "name", "hourlyRate", "active", "role", "companiesAuthorized", "email", "startDate"]);
      expect(s["startDate"]).toBeNull(); // a Date in the old app; google.script.run delivers null
    }
    expect(out[2]).toMatchObject({ name: "Cleo Marsh", hourlyRate: 18.25, role: "employee", companiesAuthorized: ["vape"] });
  });
});
