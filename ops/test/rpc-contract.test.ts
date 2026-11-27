// The contract loader: a bad rpc.json must fail when it is loaded, never at call time.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeOpsContract, parseRpcContract, RpcContractError } from "../src/rpc/contract";
import { handlers } from "../src/rpc/registry";

const real = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));

/** A deep copy of the real contract with `edit` applied to its entries (or the whole document). */
function doctored(edit: (rpcs: any[], doc: any) => void): unknown {
  const doc = structuredClone(real);
  edit(doc.rpcs, doc);
  return doc;
}
const entry = (rpcs: any[], name: string) => rpcs.find((r) => r.name === name);
const rejects = (json: unknown, pattern: RegExp) => {
  expect(() => parseRpcContract(json)).toThrow(RpcContractError);
  expect(() => parseRpcContract(json)).toThrow(pattern);
};

describe("the real contract", () => {
  it("loads, with all 62 entries and the migrate flag intact", () => {
    const c = parseRpcContract(real);
    expect(c.entries).toHaveLength(62);
    expect(c.entries.filter((e) => e.migrate)).toHaveLength(real.migrate_count);
    expect(c.get("rpcLogin")).toMatchObject({ name: "rpcLogin", params: ["name", "code"], roles: null, needs_session: false, migrate: true });
  });

  it("looks names up without reaching Object.prototype", () => {
    const c = parseRpcContract(real);
    for (const n of ["__proto__", "constructor", "toString", "hasOwnProperty", "rpcNope", ""]) expect(c.get(n)).toBeUndefined();
  });

  it("keeps the contract's own role order (it shows in the FORBIDDEN message)", () => {
    const c = parseRpcContract(real);
    const first = c.entries.find((e) => e.roles && e.roles[0] === "manager");
    expect(first?.roles).toEqual(["manager", "admin", "payroll_admin"]);
  });
});

describe("validation rejects a doctored contract with a clear message", () => {
  it("not an object, or no rpcs list", () => {
    rejects(null, /contract.*object/i);
    rejects([], /contract.*object/i);
    rejects({}, /rpcs.*array/i);
    rejects({ rpcs: "x" }, /rpcs.*array/i);
    rejects({ rpcs: [] }, /no entries|empty/i);
  });

  it("an entry that is not an object", () => {
    rejects(doctored((r) => { r[3] = null; }), /entry 3.*object/i);
  });

  it("a missing or wrongly typed field", () => {
    rejects(doctored((r) => { delete r[0].name; }), /name/);
    rejects(doctored((r) => { r[0].name = ""; }), /name/);
    rejects(doctored((r) => { r[0].name = "rpc.Login"; }), /name/);
    rejects(doctored((r) => { r[0].name = "__proto__"; }), /name/);
    rejects(doctored((r) => { r[1].params = "name,code"; }), /rpcLogin.*params/);
    rejects(doctored((r) => { r[1].params = ["name", 3]; }), /rpcLogin.*params/);
    rejects(doctored((r) => { delete r[1].roles; }), /rpcLogin.*roles/);
    rejects(doctored((r) => { r[1].needs_session = "false"; }), /rpcLogin.*needs_session/);
    rejects(doctored((r) => { delete r[1].needs_session; }), /rpcLogin.*needs_session/);
    rejects(doctored((r) => { r[1].modules = null; }), /rpcLogin.*modules/);
    rejects(doctored((r) => { r[1].migrate = 1; }), /rpcLogin.*migrate/);
    rejects(doctored((r) => { delete r[1].migrate; }), /rpcLogin.*migrate/);
  });

  it("duplicate names", () => {
    rejects(doctored((r) => { r[5].name = r[4].name; }), /duplicate.*rpcGetBootstrap/i);
  });

  it("roles must be null or a non-empty list of known roles", () => {
    const restricted = (r: any[]) => r.find((e) => e.roles && e.roles.length);
    rejects(doctored((r) => { restricted(r).roles = []; }), /roles.*non-empty|empty/i);
    rejects(doctored((r) => { restricted(r).roles = ["superuser"]; }), /unknown role.*superuser/i);
    rejects(doctored((r) => { restricted(r).roles = "admin"; }), /roles/);
    rejects(doctored((r) => { restricted(r).roles = ["admin", "admin"]; }), /duplicate role/i);
    rejects(doctored((r) => { restricted(r).roles = [1]; }), /roles/);
  });

  it("an entry with roles must need a session", () => {
    rejects(
      doctored((r) => { r.find((x) => x.roles).needs_session = false; }),
      /roles.*needs_session|needs_session.*roles/i,
    );
  });

  it("a needs_session entry's first param must be token", () => {
    rejects(doctored((r) => { entry(r, "rpcGetMe").params = []; }), /rpcGetMe.*first param.*token/i);
    rejects(doctored((r) => { entry(r, "rpcGetMe").params = ["session"]; }), /rpcGetMe.*first param.*token/i);
  });
});

// ADR-0023: calls that only the new app has (the admin's settings and schedule corrections) are
// listed in ops/contracts/rpc-ops.json, written by hand. rpc.json stays what it is: generated from
// the current app, and the list the comparison harness checks against.
describe("the new app's own RPCs are added to the contract, never mixed into it", () => {
  const base = { rpcs: [{ name: "rpcOld", params: ["token"], roles: null, needs_session: true, modules: [], migrate: true }] };
  const own = (name: string, extra: object = {}) => ({ name, params: ["token", "input"], roles: ["admin"], needs_session: true, ...extra });

  it("merges the two lists; an own entry is always migrated and has its role rule", () => {
    const c = parseRpcContract(mergeOpsContract(base, { rpcs: [own("rpcNew")] }));
    expect(c.entries.map((e) => e.name)).toEqual(["rpcOld", "rpcNew"]);
    expect(c.get("rpcNew")).toMatchObject({ roles: ["admin"], needs_session: true, migrate: true, modules: [] });
  });
  it("an empty own list changes nothing", () => {
    expect(mergeOpsContract(base, { rpcs: [] })).toEqual(base);
  });
  it("an own entry may not reuse a name of the current app's contract", () => {
    expect(() => mergeOpsContract(base, { rpcs: [own("rpcOld")] })).toThrow(/rpcOld.*already in rpc\.json/);
  });
  it("an own entry must need a session and name its roles: nothing new is open to everyone by default", () => {
    expect(() => mergeOpsContract(base, { rpcs: [own("rpcNew", { needs_session: false })] })).toThrow(/needs_session/);
    expect(() => mergeOpsContract(base, { rpcs: [{ name: "rpcNew", params: ["token"], needs_session: true }] })).toThrow(/roles/);
  });
  it("an own entry cannot switch itself off or claim modules of the current app", () => {
    expect(() => mergeOpsContract(base, { rpcs: [own("rpcNew", { migrate: false })] })).toThrow(/migrate/);
    expect(() => mergeOpsContract(base, { rpcs: [own("rpcNew", { modules: ["Staff"] })] })).toThrow(/modules/);
  });
  it("the real files merge, and every own RPC has a handler and every handler is in the contract", () => {
    const real = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));
    const ops = JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8"));
    const c = parseRpcContract(mergeOpsContract(real, ops));
    for (const e of ops.rpcs as { name: string }[]) expect(Object.hasOwn(handlers, e.name), e.name).toBe(true);
    for (const name of Object.keys(handlers)) expect(c.get(name), name).toBeDefined();
  });
});
