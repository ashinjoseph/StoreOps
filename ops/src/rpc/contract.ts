// The RPC contract: ops/contracts/rpc.json, validated once at load. It is the
// rule book the router enforces (who may call what, whether a token is
// expected, whether the RPC has moved). A bad contract throws here, at load,
// never later at call time.
//
// This file reads no file: the caller passes the parsed JSON (the Worker
// bundles it; tests read it with fs).
import { ROLES, type Role } from "../auth/types";

export interface RpcContractEntry {
  readonly name: string;
  readonly params: readonly string[];
  /** Null: any signed-in person (or nobody, when `needs_session` is false). Else the allowed roles, in the contract's order. */
  readonly roles: readonly Role[] | null;
  readonly needs_session: boolean;
  readonly modules: readonly string[];
  readonly migrate: boolean;
}

export interface RpcContract {
  readonly entries: readonly RpcContractEntry[];
  /** The entry for `name`, or undefined. Safe for any string, including "__proto__" and "constructor". */
  get(name: string): RpcContractEntry | undefined;
}

export class RpcContractError extends Error {
  constructor(message: string) {
    super(`rpc contract: ${message}`);
    this.name = "RpcContractError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const KNOWN_ROLES: readonly string[] = ROLES;

export function parseRpcContract(json: unknown): RpcContract {
  if (!isObject(json)) throw new RpcContractError("the contract must be an object with an rpcs list");
  const list = json["rpcs"];
  if (!Array.isArray(list)) throw new RpcContractError("rpcs must be an array");
  if (list.length === 0) throw new RpcContractError("rpcs has no entries");

  const byName = new Map<string, RpcContractEntry>();
  const entries: RpcContractEntry[] = [];
  list.forEach((raw: unknown, i: number) => {
    if (!isObject(raw)) throw new RpcContractError(`entry ${i} must be an object`);
    const name = raw["name"];
    if (typeof name !== "string" || !NAME.test(name) || RESERVED.has(name)) {
      throw new RpcContractError(`entry ${i}: name must be a plain identifier (letters, digits, underscore), got ${JSON.stringify(name)}`);
    }
    const at = `${name}`;
    const params = raw["params"];
    if (!isStringArray(params)) throw new RpcContractError(`${at}: params must be an array of strings`);
    if (typeof raw["needs_session"] !== "boolean") throw new RpcContractError(`${at}: needs_session must be true or false`);
    if (typeof raw["migrate"] !== "boolean") throw new RpcContractError(`${at}: migrate must be true or false`);
    const modules = raw["modules"];
    if (!isStringArray(modules)) throw new RpcContractError(`${at}: modules must be an array of strings`);
    if (!("roles" in raw)) throw new RpcContractError(`${at}: roles is missing (use null for any signed-in person)`);
    const rawRoles = raw["roles"];
    let roles: Role[] | null = null;
    if (rawRoles !== null) {
      if (!Array.isArray(rawRoles)) throw new RpcContractError(`${at}: roles must be null or an array of roles`);
      if (rawRoles.length === 0) throw new RpcContractError(`${at}: roles must be null or a non-empty list (an empty list would refuse everyone)`);
      const seen = new Set<string>();
      for (const r of rawRoles as unknown[]) {
        if (typeof r !== "string") throw new RpcContractError(`${at}: roles must be an array of role names`);
        if (!KNOWN_ROLES.includes(r)) throw new RpcContractError(`${at}: unknown role ${JSON.stringify(r)} (known: ${KNOWN_ROLES.join(", ")})`);
        if (seen.has(r)) throw new RpcContractError(`${at}: duplicate role ${r}`);
        seen.add(r);
      }
      roles = [...(rawRoles as Role[])];
    }
    if (roles !== null && raw["needs_session"] !== true) {
      throw new RpcContractError(`${at}: has roles but needs_session is false; a role rule needs a session to check against`);
    }
    if (raw["needs_session"] === true && params[0] !== "token") {
      throw new RpcContractError(`${at}: needs_session is true, so its first param must be token, got ${JSON.stringify(params[0] ?? null)}`);
    }
    if (byName.has(name)) throw new RpcContractError(`duplicate name ${name}`);

    const entry: RpcContractEntry = Object.freeze({
      name,
      params: Object.freeze([...params]),
      roles: roles === null ? null : Object.freeze(roles),
      needs_session: raw["needs_session"],
      modules: Object.freeze([...modules]),
      migrate: raw["migrate"],
    });
    byName.set(name, entry);
    entries.push(entry);
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    get: (name: string) => byName.get(name),
  });
}

/**
 * The contract the Worker enforces: the current app's RPCs (rpc.json, generated) plus the
 * Operations app's own (rpc-ops.json, written by hand; ADR-0023). Returns one document for
 * parseRpcContract. An own entry:
 *   - may not reuse a name from rpc.json;
 *   - always needs a session and names its roles (`null` for any signed-in person must be written
 *     out): nothing new is open by omission;
 *   - is always live (`migrate`) and belongs to no module of the current app; those two fields are
 *     filled in here and may not be set otherwise.
 * The comparison harness keeps using rpc.json alone: an own RPC has nothing to be compared with.
 */
export function mergeOpsContract(base: unknown, own: unknown): { rpcs: unknown[] } {
  if (!isObject(base) || !Array.isArray(base["rpcs"])) throw new RpcContractError("the contract must be an object with an rpcs list");
  if (!isObject(own) || !Array.isArray(own["rpcs"])) throw new RpcContractError("rpc-ops.json must be an object with an rpcs list");
  const taken = new Set((base["rpcs"] as unknown[]).map((r) => (isObject(r) ? r["name"] : undefined)));
  const added = (own["rpcs"] as unknown[]).map((raw, i) => {
    if (!isObject(raw)) throw new RpcContractError(`rpc-ops.json entry ${i} must be an object`);
    const name = raw["name"];
    if (taken.has(name)) throw new RpcContractError(`rpc-ops.json: ${String(name)} is already in rpc.json (an own RPC needs a name of its own)`);
    if (raw["needs_session"] !== true) throw new RpcContractError(`rpc-ops.json: ${String(name)}: needs_session must be true`);
    if (!("roles" in raw)) throw new RpcContractError(`rpc-ops.json: ${String(name)}: roles is missing (write null for any signed-in person)`);
    if ("migrate" in raw && raw["migrate"] !== true) throw new RpcContractError(`rpc-ops.json: ${String(name)}: migrate cannot be set (an own RPC is always live)`);
    if ("modules" in raw && !(Array.isArray(raw["modules"]) && raw["modules"].length === 0)) {
      throw new RpcContractError(`rpc-ops.json: ${String(name)}: modules cannot be set (they name modules of the current app)`);
    }
    return { ...raw, migrate: true, modules: [] };
  });
  if (added.length === 0) return base as { rpcs: unknown[] };
  return { ...base, rpcs: [...(base["rpcs"] as unknown[]), ...added] };
}
