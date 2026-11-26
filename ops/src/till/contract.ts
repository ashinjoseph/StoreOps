/// <reference types="node" />
/**
 * Loads the till API contract (OpenAPI 3.1) and validates a JSON value against
 * one of its response schemas, resolving `$ref`s within the file.
 *
 * Node only: it reads the YAML with `fs`. It is a tool, not part of the Worker
 * bundle.
 *
 * `validate(name, value)` takes an endpoint path ("/shifts": its 200 answer) or a
 * component schema name ("Shift"). A value that breaks the contract is an
 * `error`. A field the contract does not list is a `warning`, because the
 * contract says fields may be added in v1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import type { Difference } from "./rules";

export interface Contract {
  validate(name: string, value: unknown): Difference[];
}

const ID = "https://till.contract.invalid/till-api.v1";
const DEFAULT_FILE = fileURLToPath(new URL("../../contracts/till-api.v1.yaml", import.meta.url));
/** Enum values are printed only for fields that cannot hold a person's name. */
const SAFE_ENUM_FIELDS = new Set(["status", "channel", "role", "code", "kind"]);

type Json = Record<string, unknown>;

/** Every object schema with `properties` also gets `additionalProperties: false`. */
function closeObjects(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(closeObjects);
  if (typeof node !== "object" || node === null) return;
  const o = node as Json;
  if (typeof o.properties === "object" && o.properties !== null && o.additionalProperties === undefined) {
    o.additionalProperties = false;
  }
  Object.values(o).forEach(closeObjects);
}

function makeAjv(doc: Json): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: ID });
  return ajv;
}

function pointerFor(doc: Json, name: string): string {
  if (name.startsWith("/")) {
    const paths = doc.paths as Json | undefined;
    if (!paths || !paths[name]) throw new Error(`unknown endpoint in contract: ${name}`);
    return `#/paths/${name.replace(/~/g, "~0").replace(/\//g, "~1")}/get/responses/200/content/application~1json/schema`;
  }
  const schemas = ((doc.components as Json | undefined)?.schemas ?? {}) as Json;
  if (!schemas[name]) throw new Error(`unknown schema in contract: ${name}`);
  return `#/components/schemas/${name}`;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function valueAt(data: unknown, instancePath: string): unknown {
  let cur: unknown = data;
  for (const raw of instancePath.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Json)[key];
  }
  return cur;
}

/** "/shifts/0/opened_by" -> "shifts[0].opened_by". */
function dotted(instancePath: string, extra?: string): string {
  const segs = instancePath.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (extra !== undefined) segs.push(extra);
  let out = "";
  for (const s of segs) out += /^\d+$/.test(s) ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

function convert(e: ErrorObject, data: unknown): Difference {
  const p = e.params as Json;
  switch (e.keyword) {
    case "required":
      return { severity: "error", path: dotted(e.instancePath, String(p.missingProperty)), expected: "present", actual: "missing" };
    case "additionalProperties":
      return {
        severity: "warning",
        path: dotted(e.instancePath, String(p.additionalProperty)),
        expected: "not in the contract",
        actual: "present",
      };
    case "type": {
      const t = Array.isArray(p.type) ? p.type.join("|") : String(p.type);
      return { severity: "error", path: dotted(e.instancePath), expected: t, actual: typeOf(valueAt(data, e.instancePath)) };
    }
    case "enum": {
      const v = valueAt(data, e.instancePath);
      const field = dotted(e.instancePath).split(".").pop()?.replace(/\[\d+\]$/, "") ?? "";
      const show = typeof v === "string" && SAFE_ENUM_FIELDS.has(field) && /^[a-z_]{1,20}$/.test(v);
      return {
        severity: "error",
        path: dotted(e.instancePath),
        expected: `one of ${(p.allowedValues as unknown[]).join("|")}`,
        actual: show ? (v as string) : typeOf(v),
      };
    }
    case "format":
      return { severity: "error", path: dotted(e.instancePath), expected: `${String(p.format)} format`, actual: "a string in another format" };
    case "oneOf":
      return { severity: "error", path: dotted(e.instancePath), expected: "exactly one of the shapes the contract allows", actual: typeOf(valueAt(data, e.instancePath)) };
    default:
      return { severity: "error", path: dotted(e.instancePath), expected: e.keyword, actual: typeOf(valueAt(data, e.instancePath)) };
  }
}

/** Branch errors under a oneOf add noise: keep the oneOf error itself. */
const isBranchNoise = (e: ErrorObject) => e.schemaPath.includes("/oneOf/") || e.schemaPath.includes("/anyOf/");

export function loadContract(file: string = DEFAULT_FILE): Contract {
  const doc = parse(readFileSync(file, "utf8")) as Json;
  const strictDoc = structuredClone(doc);
  closeObjects(strictDoc);
  const lenient = makeAjv(doc);
  const strict = makeAjv(strictDoc);
  const cache = new Map<string, [ValidateFunction, ValidateFunction]>();

  const compiled = (name: string): [ValidateFunction, ValidateFunction] => {
    let c = cache.get(name);
    if (!c) {
      const ref = `${ID}${pointerFor(doc, name)}`;
      const a = lenient.getSchema(ref);
      const b = strict.getSchema(ref);
      if (!a || !b) throw new Error(`cannot compile contract schema: ${name}`);
      c = [a, b];
      cache.set(name, c);
    }
    return c;
  };

  return {
    validate(name, value) {
      const [l, s] = compiled(name);
      const out: Difference[] = [];
      if (!l(value)) {
        for (const e of l.errors ?? []) if (e.keyword === "oneOf" || !isBranchNoise(e)) out.push(convert(e, value));
      }
      if (!s(value)) {
        for (const e of s.errors ?? []) if (e.keyword === "additionalProperties") out.push(convert(e, value));
      }
      return out;
    },
  };
}
