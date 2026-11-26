import { describe, expect, it } from "vitest";
import { loadContract } from "../src/till/contract";
import type { Difference } from "../src/till/rules";
import { fixture } from "./fixtures/till/load";

const contract = loadContract();
const errors = (v: Difference[]) => v.filter((d) => d.severity === "error");
const warnings = (v: Difference[]) => v.filter((d) => d.severity === "warning");

describe("till contract loader", () => {
  it("accepts every fixture against its endpoint's response schema", () => {
    const pairs: [string, string][] = [
      ["/stores", "stores"],
      ["/staff", "staff"],
      ["/shifts", "shifts"],
      ["/shifts", "shifts-empty"],
      ["/sales/daily", "sales-daily"],
      ["/products", "products"],
      ["/suppliers", "suppliers"],
      ["/orders", "orders"],
    ];
    for (const [name, file] of pairs) {
      expect(contract.validate(name, fixture(file)), `${name} <- ${file}`).toEqual([]);
    }
  });

  it("validates a component schema by name, resolving $refs", () => {
    const shift = fixture("shifts").shifts[0];
    expect(contract.validate("Shift", shift)).toEqual([]);
    shift.takings.cash.net_total = "12";
    const d = contract.validate("Shift", shift);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", path: "takings.cash.net_total" });
  });

  it("names a missing required field by its path", () => {
    const body = fixture("shifts");
    delete body.shifts[0].opened_by;
    const d = contract.validate("/shifts", body);
    expect(d.map((x) => x.path)).toEqual(["shifts[0].opened_by"]);
    expect(d[0]?.severity).toBe("error");
  });

  it("reports a wrong enum, a wrong type and a disallowed null", () => {
    const body = fixture("shifts");
    body.shifts[0].status = "weird";
    body.shifts[0].opening_float = "100";
    body.shifts[0].register = null;
    const d = errors(contract.validate("/shifts", body));
    expect(d.map((x) => x.path).sort()).toEqual([
      "shifts[0].opening_float",
      "shifts[0].register",
      "shifts[0].status",
    ]);
    const byPath = Object.fromEntries(d.map((x) => [x.path, x]));
    expect(byPath["shifts[0].status"]?.actual).toBe("weird");
    expect(byPath["shifts[0].status"]?.expected).toContain("open");
    expect(byPath["shifts[0].opening_float"]?.actual).toBe("string");
    expect(byPath["shifts[0].register"]?.actual).toBe("null");
  });

  it("allows null where the contract does (type arrays and oneOf)", () => {
    const body = fixture("shifts");
    expect(body.shifts[1].closed_by).toBeNull();
    expect(body.shifts[1].z_number).toBeNull();
    expect(contract.validate("/shifts", body)).toEqual([]);
    body.shifts[0].closed_by = 5;
    expect(errors(contract.validate("/shifts", body)).map((x) => x.path)).toContain("shifts[0].closed_by");
  });

  it("checks uuid, date and date-time formats", () => {
    const body = fixture("shifts");
    body.store_id = "not-a-uuid";
    body.business_day = "25/11/2026";
    body.shifts[0].opened_at = "yesterday";
    const paths = errors(contract.validate("/shifts", body)).map((x) => x.path).sort();
    expect(paths).toEqual(["business_day", "shifts[0].opened_at", "store_id"]);
  });

  it("reports a field the contract does not list as a warning, at any depth", () => {
    const body = fixture("shifts");
    body.shifts[0].surprise = 1;
    body.shifts[0].takings.cash.extra = 2;
    body.shifts[0].closed_by.nickname = "x";
    const d = contract.validate("/shifts", body);
    expect(errors(d)).toEqual([]);
    expect(warnings(d).map((x) => x.path).sort()).toEqual([
      "shifts[0].closed_by.nickname",
      "shifts[0].surprise",
      "shifts[0].takings.cash.extra",
    ]);
  });

  it("reports a wrong top-level type", () => {
    const d = contract.validate("/stores", []);
    expect(d[0]).toMatchObject({ severity: "error", path: "" });
  });

  it("throws on an unknown name", () => {
    expect(() => contract.validate("/nope", {})).toThrow();
    expect(() => contract.validate("Nope", {})).toThrow();
  });
});
