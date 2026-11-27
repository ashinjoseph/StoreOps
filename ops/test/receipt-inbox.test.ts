// The receipt inbox (card P5-12a; ADR-0026): originals kept byte for byte, fingerprinted, listed and
// viewable, never erased or overwritten. NEW in the Operations app (ADR-0023): these tests are its
// specification. Against a real database, with the in-memory bucket, driving the Worker's own fetch for
// the two routes and the REAL router (merged contract) for the RPCs. Invented people and shops only.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import worker from "../src/index";
import { Config } from "../src/lib/config";
import * as originals from "../src/receipts/originals";
import { handleUpload, readCapped, VIEW_CSP, type ReceiptRouteDeps } from "../src/receipts/routes";
import { NOT_ACCEPTED, sniff } from "../src/receipts/sniff";
import { bucketStorage, memoryBucket, StorageKeyTakenError } from "../src/receipts/storage";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };
let bucket: ReturnType<typeof memoryBucket>;

const ORIGIN = "https://ops.test";
const PEPPER = "test-only-pepper-not-a-secret";
const envFor = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ OPS_DB_APP_URL: testDb.appUrl, PIN_PEPPER: PEPPER, RECEIPTS: bucket, ...extra });

/** Invented people. [id, name, role, active] */
const STAFF: Array<[string, string, string, boolean]> = [
  ["S_001", "Ada Quill", "admin", true],
  ["S_002", "Bram Hale", "manager", true],
  ["S_003", "Cleo Marsh", "employee", true],
  ["S_004", "Dara Vance", "payroll_admin", true],
  ["S_005", "Eli Stone", "employee", true],
  ["S_007", "Gus Lowe", "employee", true], // deactivated in a test
];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

beforeEach(async () => {
  for (const t of ["audit_log", "receipt_originals", "business_signs", "sessions", "config", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const [id, name, role, active] of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, $2, $3, $4, 'cstore,vape')", [id, name, active, role]);
  }
  for (const [id] of STAFF) tokens[id] = (await createSession(db, id, Config.fromRows([]), new Date())).token;
  bucket = memoryBucket();
});

// ── Minimal files of each kind, made here ─────────────────

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const cat = (...parts: Array<Uint8Array | number[] | string>): Uint8Array => {
  const bufs = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};
let serial = 0;
/** A unique tail (a comment or trailing bytes) so each file is a new original unless a test wants the same bytes. */
const tail = () => `fictional-${++serial}-${Math.random().toString(36).slice(2)}`;
const FILES = {
  // A 1x1 PNG, then a tEXt-like trailer after IEND (ignored by readers).
  png: () => cat(b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), tail()),
  // SOI, an APP0 JFIF header, a comment segment, EOI.
  jpeg: () => {
    const c = new TextEncoder().encode(tail());
    return cat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00], [0xff, 0xfe, 0x00, c.length + 2], c, [0xff, 0xd9]);
  },
  // A 1x1 lossless WebP, then trailing bytes.
  webp: () => cat(b64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), tail()),
  // An ISO-BMFF ftyp box (brand heic, compatible mif1 heic), then an mdat box.
  heic: () => {
    const body = new TextEncoder().encode(tail());
    return cat([0, 0, 0, 24], "ftyp", "heic", [0, 0, 0, 0], "mif1", "heic", [0, 0, 0, body.length + 8], "mdat", body);
  },
  pdf: () => cat("%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n% ", tail(), "\ntrailer <</Root 1 0 R>>\n%%EOF\n"),
};
const KIND_TYPES: Record<keyof typeof FILES, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", pdf: "application/pdf" };
const sha = async (b: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex");

// ── Calling the Worker ────────────────────────────────────

interface UploadOpts {
  token?: string | null;
  type?: string;
  name?: string;
  note?: string;
  business?: string;
  source?: string;
  origin?: string;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
}
async function upload(bytes: Uint8Array, o: UploadOpts = {}): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = { "content-type": o.type ?? "application/octet-stream", "content-length": String(bytes.byteLength), ...(o.headers ?? {}) };
  const token = o.token === undefined ? tokens["S_003"] : o.token;
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  if (o.name !== undefined) headers["x-receipt-filename"] = encodeURIComponent(o.name);
  if (o.note !== undefined) headers["x-receipt-note"] = encodeURIComponent(o.note);
  if (o.business !== undefined) headers["x-receipt-business"] = o.business;
  if (o.source !== undefined) headers["x-receipt-source"] = o.source;
  if (o.origin !== undefined) headers["origin"] = o.origin;
  const res = await worker.fetch(new Request(`${ORIGIN}/files/receipt-original`, { method: "PUT", headers, body: bytes }), o.env ?? envFor());
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}
const view = (id: string, token: string | null = tokens["S_001"] as string, extra: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}/files/receipt-original/${id}`, { headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra } }), envFor());

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
async function call(name: string, args: unknown[]): Promise<{ ok: boolean; result?: any; error?: { message: string } }> {
  const router = createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: { PIN_PEPPER: PEPPER }, log: () => undefined });
  const res = await router(new Request(`${ORIGIN}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
}

const rows = () => db.query<any>("select receipt_id, encode(sha256, 'hex') as sha, size_bytes, content_type, storage_key, business, status, set_aside_reason, set_aside_by, source, added_by, file_name, note from ops.receipt_originals order by added_at, receipt_id");
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const rowCount = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.receipt_originals")).n;
const setConfig = (key: string, value: string) => owner.query("insert into ops.config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);

// ── Uploads: the type is decided by the bytes ─────────────

describe("upload: what is accepted", () => {
  for (const kind of Object.keys(FILES) as Array<keyof typeof FILES>) {
    it(`a ${kind} is kept with type ${KIND_TYPES[kind]}, whatever header and name were sent`, async () => {
      const bytes = FILES[kind]();
      const r = await upload(bytes, { type: "text/plain", name: "scan.txt", source: "upload" });
      expect(r.status).toBe(201);
      expect(r.body.ok).toBe(true);
      expect(r.body.result.duplicate).toBe(false);
      expect(r.body.result.record.contentType).toBe(KIND_TYPES[kind]);
      expect(r.body.result.message).toMatch(/^Kept\. \d+ bytes, added \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
      const [row] = await rows();
      expect(row.content_type).toBe(KIND_TYPES[kind]);
      expect(row.size_bytes).toBe(bytes.byteLength);
      expect(row.sha).toBe(await sha(bytes)); // the real SHA-256
      // Byte for byte: what storage gives back is what was sent.
      const got = await bucketStorage(bucket).get(row.storage_key);
      expect(got).not.toBeNull();
      expect(await sha(got!.bytes)).toBe(await sha(bytes));
      expect(Buffer.from(got!.bytes).equals(Buffer.from(bytes))).toBe(true);
      expect(got!.object.meta).toEqual({ contentType: KIND_TYPES[kind], sha256: await sha(bytes), receiptId: row.receipt_id });
    });
  }

  it("a mismatched header (image/png on a JPEG, named .png) is stored as what the bytes are", async () => {
    const r = await upload(FILES.jpeg(), { type: "image/png", name: "photo.png" });
    expect(r.status).toBe(201);
    expect((await rows())[0].content_type).toBe("image/jpeg");
  });

  it("the exact signatures: sniff on its own", () => {
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniff(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull();
    expect(sniff(cat("RIFF", [1, 0, 0, 0], "WEBP"))).toBe("image/webp");
    expect(sniff(cat("RIFF", [1, 0, 0, 0], "WAVE"))).toBeNull();
    expect(sniff(cat("%PDF-1.7"))).toBe("application/pdf");
    expect(sniff(cat("%PDF-"))).toBeNull();
    expect(sniff(cat([0, 0, 0, 16], "ftyp", "heic", [0, 0, 0, 0]))).toBe("image/heic");
    expect(sniff(cat([0, 0, 0, 20], "ftyp", "mif1", [0, 0, 0, 0], "heic"))).toBe("image/heic");
    expect(sniff(cat([0, 0, 0, 20], "ftyp", "mif1", [0, 0, 0, 0], "avif"))).toBeNull(); // AVIF is not HEIC
    expect(sniff(cat([0, 0, 0, 20], "ftyp", "isom", [0, 0, 0, 0], "mp41"))).toBeNull(); // an MP4
    expect(sniff(cat([0, 0, 0, 99], "ftyp", "heic", [0, 0, 0, 0]))).toBeNull(); // box larger than the file
  });
});

describe("upload: what is refused, with nothing stored or written", () => {
  const refused: Array<[string, () => Uint8Array, string]> = [
    ["an SVG named .png and sent as image/png", () => cat('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/png"],
    ["an HTML page", () => cat("<!doctype html><html><body><script>parent.alert(1)</script></body></html>"), "image/jpeg"],
    ["a zip archive", () => cat([0x50, 0x4b, 0x03, 0x04], "fictional.txt"), "application/pdf"],
    ["a truncated JPEG signature", () => new Uint8Array([0xff, 0xd8]), "image/jpeg"],
    ["a truncated PNG signature", () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"],
    ["a GIF", () => cat("GIF89a", [1, 0, 1, 0, 0, 0, 0]), "image/gif"],
  ];
  for (const [what, make, type] of refused) {
    it(what, async () => {
      const r = await upload(make(), { type, name: "receipt.png" });
      expect(r.status).toBe(415);
      expect(r.body).toEqual({ ok: false, error: { message: NOT_ACCEPTED } });
      expect(await rowCount()).toBe(0);
      expect(bucket.puts()).toBe(0);
      expect(await audits()).toEqual([]);
    });
  }

  it("an empty body", async () => {
    const r = await upload(new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/empty/);
    expect(await rowCount()).toBe(0);
    expect(bucket.puts()).toBe(0);
  });

  it("no Content-Length: 411, nothing read", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/files/receipt-original`, { method: "PUT", headers: { authorization: `Bearer ${tokens["S_003"]}` }, body: streamOf([FILES.png()]).stream, duplex: "half" } as RequestInit),
      envFor(),
    );
    expect(res.status).toBe(411);
    expect(await rowCount()).toBe(0);
  });
});

/** A body stream that counts how many bytes were pulled from it. */
function streamOf(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let i = 0;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const c = chunks[i++];
      if (c === undefined) return controller.close();
      pulled += c.byteLength;
      controller.enqueue(c);
    },
  }, { highWaterMark: 0 }); // nothing is pulled until somebody reads
  return { stream, pulled: () => pulled };
}
const MB = 1024 * 1024;

describe("upload: the size limit", () => {
  const big = (n: number) => {
    const b = new Uint8Array(n);
    b.set(FILES.jpeg().subarray(0, 64));
    return b;
  };

  it("over 10 MB by Content-Length: 413 before a byte of the body is read", async () => {
    const chunks = Array.from({ length: 12 }, () => big(MB));
    const s = streamOf(chunks);
    const res = await handleUpload(
      new Request(`${ORIGIN}/files/receipt-original`, { method: "PUT", headers: { authorization: `Bearer ${tokens["S_003"]}`, "content-length": String(12 * MB) }, body: s.stream, duplex: "half" } as RequestInit),
      deps(),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.message).toMatch(/larger than 10 MB.*smaller picture size/);
    expect(s.pulled()).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  it("a lying Content-Length: reading stops just past the size claimed, refused, nothing kept", async () => {
    const chunks = Array.from({ length: 30 }, () => big(MB));
    const s = streamOf(chunks);
    const res = await handleUpload(
      new Request(`${ORIGIN}/files/receipt-original`, { method: "PUT", headers: { authorization: `Bearer ${tokens["S_003"]}`, "content-length": String(2 * MB) }, body: s.stream, duplex: "half" } as RequestInit),
      deps(),
    );
    expect(res.status).toBe(413);
    // The cap is the claimed 2 MB: at most one 1 MB chunk beyond it (the one that crossed it) was read.
    expect(s.pulled()).toBeLessThanOrEqual(3 * MB);
    expect(await rowCount()).toBe(0);
    expect(bucket.puts()).toBe(0);
  });

  it("readCapped never buffers more than the cap plus one chunk", async () => {
    const s = streamOf(Array.from({ length: 50 }, () => new Uint8Array(1000)));
    expect(await readCapped(s.stream, 4500)).toBeNull();
    expect(s.pulled()).toBe(5000);
    const t = streamOf([new Uint8Array(10), new Uint8Array(5)]);
    expect((await readCapped(t.stream, 15))?.byteLength).toBe(15);
  });

  it("exactly at the limit is accepted; the limit follows the setting receipt_max_mb", async () => {
    await setConfig("receipt_max_mb", "1");
    const atLimit = big(MB);
    expect((await upload(atLimit)).status).toBe(201);
    const over = big(MB + 1);
    over[MB] = 7;
    const r = await upload(over);
    expect(r.status).toBe(413);
    expect(r.body.error.message).toMatch(/larger than 1 MB/);
    await setConfig("receipt_max_mb", "2");
    expect((await upload(over)).status).toBe(201);
    expect(await rowCount()).toBe(2);
  });

  it("maxBytes: whole MB from 1 to 25, the default 10", () => {
    const at = (v: string | null) => originals.maxBytes(Config.fromRows(v === null ? [] : [{ key: "receipt_max_mb", value: v }]));
    expect([at(null), at(""), at("0"), at("3"), at("99"), at("-4"), at("2.9")]).toEqual([10 * MB, 10 * MB, 10 * MB, 3 * MB, 25 * MB, 1 * MB, 2 * MB]);
  });
});

function deps(over: Partial<ReceiptRouteDeps> = {}): ReceiptRouteDeps {
  return { openDb: () => connect(testDb.appUrl), resolveSession, storage: bucketStorage(bucket), now: () => new Date(), log: () => undefined, ...over };
}

// ── The same bytes twice ──────────────────────────────────

describe("the same file twice is one original", () => {
  it("the second upload stores nothing and names the first", async () => {
    const bytes = FILES.png();
    const first = await upload(bytes, { token: tokens["S_003"] });
    expect(first.status).toBe(201);
    const second = await upload(bytes, { token: tokens["S_002"], name: "again.png", business: "vape" });
    expect(second.status).toBe(200);
    expect(second.body.result.duplicate).toBe(true);
    expect(second.body.result.message).toMatch(/^Already on file, added \d{4}-\d{2}-\d{2} \d{2}:\d{2} by Cleo Marsh\.$/);
    expect(second.body.result.record.id).toBe(first.body.result.record.id);
    expect(await rowCount()).toBe(1);
    expect(bucket.puts()).toBe(1);
    expect(bucket.keys()).toHaveLength(1);
    expect((await audits()).filter((a) => a.action === "receipt_original.add")).toHaveLength(1);
  });

  it("an employee whose duplicate is someone else's original learns who and when, not its name or note", async () => {
    const bytes = FILES.pdf();
    await upload(bytes, { token: tokens["S_001"], name: "Invoice 2231.pdf", note: "fictional note" });
    const r = await upload(bytes, { token: tokens["S_003"] });
    expect(r.body.result.duplicate).toBe(true);
    expect(Object.keys(r.body.result.record).sort()).toEqual(["addedAt", "addedBy", "id"]);
    expect(JSON.stringify(r.body)).not.toContain("fictional note");
  });

  it("two uploads of the same bytes at the same instant, on two connections: one object, one row, both answered", async () => {
    const bytes = FILES.webp();
    const [a, b] = await Promise.all([upload(bytes, { token: tokens["S_003"] }), upload(bytes, { token: tokens["S_005"] })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.result.record.id).toBe(b.body.result.record.id);
    expect([a.body.result.duplicate, b.body.result.duplicate].sort()).toEqual([false, true]);
    expect(await rowCount()).toBe(1);
    expect(bucket.puts()).toBe(1);
  });
});

// ── Never erased, never overwritten ───────────────────────

describe("never erased or overwritten", () => {
  const dir = new URL("../src/receipts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("the word delete appears nowhere under src/receipts/", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/delete/i);
  });

  it("the storage interface has put, get and head, nothing else", () => {
    expect(Object.keys(bucketStorage(memoryBucket())).sort()).toEqual(["get", "head", "put"]);
    expect(Object.keys(memoryBucket()).sort()).toEqual(["get", "head", "keys", "put", "puts"]);
  });

  it("a put never reuses a key: the in-memory bucket and the interface over it both refuse", async () => {
    const m = memoryBucket();
    const s = bucketStorage(m);
    const bytes = FILES.png();
    const meta = { contentType: "image/png", sha256: await sha(bytes), receiptId: "ro" + "0".repeat(24) };
    await s.put("originals/2026-11/ro" + "0".repeat(24), bytes, meta);
    await expect(s.put("originals/2026-11/ro" + "0".repeat(24), FILES.png().subarray(0, 8), meta)).rejects.toBeInstanceOf(StorageKeyTakenError);
    const raw = memoryBucket();
    await raw.put("k", bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: {}, sha256: meta.sha256 });
    await expect(raw.put("k", bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: {}, sha256: meta.sha256 })).rejects.toBeInstanceOf(StorageKeyTakenError);
    expect(m.puts()).toBe(1);
    // The first bytes are still there.
    expect(Buffer.from((await s.get("originals/2026-11/ro" + "0".repeat(24)))!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("the app role cannot remove a row or change the hash, size, type, key or who added it", async () => {
    const r = await upload(FILES.jpeg());
    const id = r.body.result.record.id;
    await expect(db.query("delete from ops.receipt_originals where receipt_id = $1", [id])).rejects.toMatchObject({ kind: "permission" });
    for (const col of ["sha256 = sha256", "size_bytes = 1", "content_type = 'image/png'", "storage_key = storage_key", "added_by = 'S_001'", "source = 'photo'"]) {
      await expect(db.query(`update ops.receipt_originals set ${col} where receipt_id = $1`, [id]), col).rejects.toMatchObject({ kind: "permission" });
    }
  });

  it("set aside and put back leave the object and the hash untouched", async () => {
    const bytes = FILES.heic();
    const r = await upload(bytes);
    const id = r.body.result.record.id;
    const [before] = await rows();
    const aside = await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: true, reason: "Not a receipt: a fictional flyer" }]);
    expect(aside.ok).toBe(true);
    expect(aside.result.record.status).toBe("set_aside");
    const back = await call("rpcSetReceiptAside", [tokens["S_001"], { id, aside: false }]);
    expect(back.result.record.status).toBe("waiting");
    const [after] = await rows();
    expect({ ...after, status: undefined }).toEqual({ ...before, status: undefined });
    expect(bucket.keys()).toEqual([before.storage_key]);
    expect(await sha((await bucketStorage(bucket).get(before.storage_key))!.bytes)).toBe(await sha(bytes));
    expect(bucket.puts()).toBe(1);
  });
});

// ── Who may ───────────────────────────────────────────────

describe("who may add", () => {
  it("every role may add an original; the row says who, from the session", async () => {
    for (const id of ["S_001", "S_002", "S_003", "S_004"]) expect((await upload(FILES.png(), { token: tokens[id] })).status).toBe(201);
    expect((await rows()).map((r) => r.added_by)).toEqual(["S_001", "S_002", "S_003", "S_004"]);
  });

  it("no token, a token in the URL, an unknown token, an expired one, a deactivated person: 401 NOT_LOGGED_IN, nothing kept", async () => {
    const expired = (await createSession(db, "S_005", Config.fromRows([]), new Date(Date.now() - 48 * 3600_000))).token;
    await owner.query("update ops.staff set active = false where staff_id = 'S_007'");
    const urlToken = await worker.fetch(new Request(`${ORIGIN}/files/receipt-original?token=${tokens["S_003"]}`, { method: "PUT", headers: { "content-length": "8" }, body: FILES.png().subarray(0, 8) }), envFor());
    expect(urlToken.status).toBe(401);
    for (const token of [null, "", "not-a-token", "0".repeat(32), expired, tokens["S_007"] as string]) {
      const r = await upload(FILES.png(), { token });
      expect(r.status, String(token)).toBe(401);
      expect(r.body).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
    }
    expect(await rowCount()).toBe(0);
    expect(bucket.puts()).toBe(0);
  });

  it("a planted role, actor or added-by header changes nothing", async () => {
    await upload(FILES.png(), { token: tokens["S_003"], headers: { "x-receipt-added-by": "S_001", "x-role": "admin", "x-actor-id": "S_001" } });
    expect((await rows())[0].added_by).toBe("S_003");
  });

  it("a foreign Origin is refused; none, or the app's own, is accepted", async () => {
    const foreign = await upload(FILES.png(), { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await upload(FILES.png(), { origin: "http://ops.test" })).status).toBe(403); // another scheme is another origin
    expect((await upload(FILES.png(), { origin: ORIGIN })).status).toBe(201);
    expect((await upload(FILES.png())).status).toBe(201);
    expect(await rowCount()).toBe(2);
  });

  it("only PUT adds; no RECEIPTS binding: 503, nothing kept", async () => {
    const post = await worker.fetch(new Request(`${ORIGIN}/files/receipt-original`, { method: "POST", headers: { authorization: `Bearer ${tokens["S_003"]}` }, body: "x" }), envFor());
    expect(post.status).toBe(405);
    const none = await upload(FILES.png(), { env: envFor({ RECEIPTS: undefined }) });
    expect(none.status).toBe(503);
    expect(await rowCount()).toBe(0);
  });
});

describe("the inbox list", () => {
  async function seedThree() {
    const a = (await upload(FILES.png(), { token: tokens["S_003"], name: "cleo-1.png", note: "Fictional Grocer", business: "cstore", source: "photo" })).body.result.record.id;
    const b = (await upload(FILES.pdf(), { token: tokens["S_005"], name: "eli.pdf" })).body.result.record.id;
    const c = (await upload(FILES.jpeg(), { token: tokens["S_003"], name: "cleo-old.jpg" })).body.result.record.id;
    // c was added 8 days ago.
    await owner.query("update ops.receipt_originals set added_at = now() - interval '8 days' where receipt_id = $1", [c]);
    return { a, b, c };
  }

  it("admin, manager and payroll admin: every original, newest first, with counts; never a key or a URL", async () => {
    const { a, b, c } = await seedThree();
    for (const id of ["S_001", "S_002", "S_004"]) {
      const r = await call("rpcGetReceiptInbox", [tokens[id], {}]);
      expect(r.ok, id).toBe(true);
      expect(r.result.scope).toBe("all");
      expect(r.result.items.map((x: any) => x.id)).toEqual([b, a, c]);
      expect(r.result.counts).toEqual({ waiting: 3, drafted: 0, confirmed: 0, set_aside: 0 });
      expect(r.result.canSetAside).toBe(id !== "S_004");
      expect(r.result.maxMb).toBe(10);
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/originals\/|storage|https?:|sha/i);
    }
    const one = (await call("rpcGetReceiptInbox", [tokens["S_001"], {}])).result.items[1];
    expect(Object.keys(one).sort()).toEqual(["addedAt", "addedBy", "business", "contentType", "fileName", "id", "mine", "note", "setAside", "size", "source", "status"]);
    expect(one).toMatchObject({ addedBy: "Cleo Marsh", business: "cstore", source: "photo", contentType: "image/png", fileName: "cleo-1.png", note: "Fictional Grocer", status: "waiting", setAside: null, mine: false });
  });

  it("a page at a time: before and limit (at most 50)", async () => {
    const { a, b, c } = await seedThree();
    const p1 = await call("rpcGetReceiptInbox", [tokens["S_001"], { limit: 2 }]);
    expect(p1.result.items.map((x: any) => x.id)).toEqual([b, a]);
    expect(p1.result.next).toBe(a);
    const p2 = await call("rpcGetReceiptInbox", [tokens["S_001"], { limit: 2, before: a }]);
    expect(p2.result.items.map((x: any) => x.id)).toEqual([c]);
    expect(p2.result.next).toBeNull();
    const big = await call("rpcGetReceiptInbox", [tokens["S_001"], { limit: 5000 }]);
    expect(big.result.items).toHaveLength(3);
  });

  it("an employee sees only their own of the last 7 days, and no counts", async () => {
    const { a } = await seedThree();
    const r = await call("rpcGetReceiptInbox", [tokens["S_003"], { status: "set_aside", limit: 50 }]);
    expect(r.result.scope).toBe("own");
    expect(r.result.items.map((x: any) => x.id)).toEqual([a]);
    expect(r.result.items[0].mine).toBe(true);
    expect(r.result.counts).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("eli.pdf");
  });

  it("a planted role or staffId in the input changes nothing", async () => {
    await seedThree();
    const r = await call("rpcGetReceiptInbox", [tokens["S_003"], { role: "admin", staffId: "S_005", viewerRole: "admin" }]);
    expect(r.result.scope).toBe("own");
    expect(r.result.items.every((x: any) => x.mine)).toBe(true);
  });

  it("no token: NOT_LOGGED_IN", async () => {
    expect((await call("rpcGetReceiptInbox", ["", {}])).error?.message).toBe("NOT_LOGGED_IN");
  });
});

describe("the view route", () => {
  it("an image: exactly the stored bytes, with every header rule 8 lists, no cookie, no CORS", async () => {
    const bytes = FILES.png();
    const id = (await upload(bytes, { name: "../../etc/passwd\".png" })).body.result.record.id;
    const res = await view(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="receipt-${id}.png"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(VIEW_CSP).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
    for (const [name] of res.headers) expect(name).not.toMatch(/^access-control-/);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a PDF: application/pdf, the same headers, a .pdf name made by the app", async () => {
    const id = (await upload(FILES.pdf(), { name: "Invoice <script>.pdf" })).body.result.record.id;
    const res = await view(id, tokens["S_004"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="receipt-${id}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("an employee: their own of the last 7 days only; someone else's, an old one and a made-up id all answer the same 404", async () => {
    const mine = (await upload(FILES.png(), { token: tokens["S_003"] })).body.result.record.id;
    const old = (await upload(FILES.png(), { token: tokens["S_003"] })).body.result.record.id;
    await owner.query("update ops.receipt_originals set added_at = now() - interval '8 days' where receipt_id = $1", [old]);
    const theirs = (await upload(FILES.png(), { token: tokens["S_005"] })).body.result.record.id;
    expect((await view(mine, tokens["S_003"])).status).toBe(200);
    const answers = [];
    for (const id of [theirs, old, "ro" + "a".repeat(24), "nope"]) {
      const res = await view(id, tokens["S_003"]);
      answers.push({ status: res.status, ct: res.headers.get("content-type"), body: await res.text() });
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]!.status).toBe(404);
    // The others still see it.
    for (const id of ["S_001", "S_002", "S_004"]) expect((await view(theirs, tokens[id])).status).toBe(200);
  });

  it("no session, a token in the query, a cookie, an expired session: 401 and no bytes", async () => {
    const id = (await upload(FILES.png())).body.result.record.id;
    const expired = (await createSession(db, "S_001", Config.fromRows([]), new Date(Date.now() - 48 * 3600_000))).token;
    const tries = [
      await view(id, null),
      await worker.fetch(new Request(`${ORIGIN}/files/receipt-original/${id}?token=${tokens["S_001"]}`), envFor()),
      await view(id, null, { cookie: `token=${tokens["S_001"]}` }),
      await view(id, expired),
      await view(id, null, { authorization: tokens["S_001"] as string }), // not "Bearer …"
    ];
    for (const res of tries) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).toBe(JSON.stringify({ ok: false, error: { message: "NOT_LOGGED_IN" } }));
    }
  });

  it("a foreign Origin is refused on the view route too; POST is not allowed", async () => {
    const id = (await upload(FILES.png())).body.result.record.id;
    expect((await view(id, tokens["S_001"], { origin: "https://evil.example" })).status).toBe(403);
    const post = await worker.fetch(new Request(`${ORIGIN}/files/receipt-original/${id}`, { method: "POST", headers: { authorization: `Bearer ${tokens["S_001"]}` } }), envFor());
    expect(post.status).toBe(405);
  });
});

describe("set aside and change business", () => {
  it("set aside: admin and manager only; a reason of 3 to 300 characters; audited; put back", async () => {
    const id = (await upload(FILES.png())).body.result.record.id;
    for (const who of ["S_003", "S_004"]) {
      const r = await call("rpcSetReceiptAside", [tokens[who], { id, aside: true, reason: "Not a receipt" }]);
      expect(r.error?.message, who).toMatch(/^FORBIDDEN/);
    }
    expect((await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: true, reason: "no" }])).error?.message).toMatch(/3 to 300/);
    expect((await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: true, reason: "x".repeat(301) }])).error?.message).toMatch(/3 to 300/);
    expect((await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: true, reason: "two\nlines" }])).error?.message).toMatch(/control/);
    expect((await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: "yes", reason: "Not a receipt" }])).error?.message).toMatch(/aside must be/);
    const ok = await call("rpcSetReceiptAside", [tokens["S_002"], { id, aside: true, reason: "  A fictional menu, not a receipt  ", actorId: "S_001" }]);
    expect(ok.result.changed).toBe(true);
    expect(ok.result.record.setAside).toMatchObject({ reason: "A fictional menu, not a receipt", by: "Bram Hale" });
    expect((await rows())[0]).toMatchObject({ status: "set_aside", set_aside_reason: "A fictional menu, not a receipt", set_aside_by: "S_002" });
    // Twice: nothing more.
    expect((await call("rpcSetReceiptAside", [tokens["S_001"], { id, aside: true, reason: "again here" }])).result.changed).toBe(false);
    // It stays in the list, under its own heading.
    const list = await call("rpcGetReceiptInbox", [tokens["S_004"], { status: "set_aside" }]);
    expect(list.result.items.map((x: any) => x.id)).toEqual([id]);
    expect(list.result.counts).toEqual({ waiting: 0, drafted: 0, confirmed: 0, set_aside: 1 });
    // A set-aside original keeps its business; changing it needs putting back first.
    expect((await call("rpcSetReceiptBusiness", [tokens["S_001"], { id, business: "vape" }])).error?.message).toMatch(/Put it back first/);
    const back = await call("rpcSetReceiptAside", [tokens["S_001"], { id, aside: false }]);
    expect(back.result.record).toMatchObject({ status: "waiting", setAside: null });
    const a = (await audits()).filter((x) => x.action.startsWith("receipt_original.") && x.action !== "receipt_original.add");
    expect(a.map((x) => [x.actor_id, x.action, x.target_id])).toEqual([
      ["S_002", "receipt_original.set_aside", id],
      ["S_001", "receipt_original.put_back", id],
    ]);
    expect(JSON.parse(a[0].after)).toEqual({ status: "set_aside", reason: "A fictional menu, not a receipt" });
    expect(JSON.parse(a[1].before)).toMatchObject({ status: "set_aside", reason: "A fictional menu, not a receipt", by: "S_002" });
  });

  it("change business: admin and manager; cstore, vape or null; audited with before and after", async () => {
    const id = (await upload(FILES.png(), { business: "nonsense" })).body.result.record.id;
    expect((await rows())[0].business).toBeNull(); // "not sure" and anything else: NULL, never guessed
    for (const who of ["S_003", "S_004"]) expect((await call("rpcSetReceiptBusiness", [tokens[who], { id, business: "vape" }])).error?.message).toMatch(/^FORBIDDEN/);
    expect((await call("rpcSetReceiptBusiness", [tokens["S_001"], { id, business: "both" }])).error?.message).toMatch(/cstore, vape, or null/);
    expect((await call("rpcSetReceiptBusiness", [tokens["S_001"], { id: "ro" + "b".repeat(24), business: "vape" }])).error?.message).toBe("No such receipt original.");
    const r = await call("rpcSetReceiptBusiness", [tokens["S_002"], { id, business: "vape" }]);
    expect(r.result).toMatchObject({ changed: true, record: { business: "vape" } });
    expect((await call("rpcSetReceiptBusiness", [tokens["S_002"], { id, business: "vape" }])).result.changed).toBe(false);
    await call("rpcSetReceiptBusiness", [tokens["S_001"], { id, business: null }]);
    const a = (await audits()).filter((x) => x.action === "receipt_original.set_business");
    expect(a.map((x) => [x.actor_id, JSON.parse(x.before), JSON.parse(x.after)])).toEqual([
      ["S_002", { business: null }, { business: "vape" }],
      ["S_001", { business: "vape" }, { business: null }],
    ]);
  });
});

describe("the record and its audit row", () => {
  it("one audit row receipt_original.add: id, hash, size, type, business, source; never the bytes", async () => {
    const bytes = FILES.jpeg();
    const r = await upload(bytes, { business: "cstore", source: "photo" });
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_003", action: "receipt_original.add", target_type: "receipt_originals", target_id: r.body.result.record.id });
    expect(JSON.parse(a.after)).toEqual({ id: r.body.result.record.id, sha256: await sha(bytes), size: bytes.byteLength, type: "image/jpeg", business: "cstore", source: "photo" });
    expect(JSON.stringify(a)).not.toContain(Buffer.from(bytes).toString("base64").slice(0, 20));
  });

  it("the file name and note are cleaned and capped, and never in the storage key", async () => {
    const name = "..\\..\\x/y/\u0000ev\u202eil\u0007\r\n" + "n".repeat(5000) + ".png";
    const note = "line one\nline two\u0000\u2028" + "z".repeat(5000);
    const r = await upload(FILES.png(), { name, note, source: "camera-hack" });
    const [row] = await rows();
    expect(row.file_name).not.toMatch(/[\u0000-\u001f\u202e/\\]/);
    expect([...row.file_name].length).toBeLessThanOrEqual(120);
    expect(row.file_name.startsWith("evil")).toBe(true);
    expect(row.note).not.toMatch(/[\u0000-\u001f\u2028]/);
    expect(row.note.startsWith("line one line two")).toBe(true);
    expect([...row.note].length).toBe(300);
    expect(row.source).toBe("upload");
    expect(row.storage_key).toMatch(/^originals\/\d{4}-\d{2}\/ro[0-9a-f]{24}$/);
    expect(row.storage_key).toBe(`originals/${row.storage_key.slice(10, 17)}/${row.receipt_id}`);
    expect(bucket.keys()).toEqual([row.storage_key]);
    expect(r.body.result.record.fileName).toBe(row.file_name);
  });

  it("cleanFileName and cleanNote on their own", () => {
    expect(originals.cleanFileName("C:\\Users\\x\\IMG_0042.HEIC")).toBe("IMG_0042.HEIC");
    expect(originals.cleanFileName("...hidden")).toBe("hidden");
    expect(originals.cleanFileName("   ")).toBeNull();
    expect(originals.cleanFileName(42)).toBeNull();
    expect(originals.cleanNote(" a\tb ")).toBe("a b");
  });
});

describe("nothing else moves", () => {
  it("till_sessions, sales, payments, attendance and staff are the same before and after", async () => {
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["till_sessions", "sales", "payments", "attendance", "staff"]) out[t] = await db.query(`select * from ops.${t} order by 1`);
      return JSON.stringify(out);
    };
    const before = await snap();
    const id = (await upload(FILES.png())).body.result.record.id;
    await upload(FILES.png(), { token: "bad" });
    await call("rpcSetReceiptAside", [tokens["S_001"], { id, aside: true, reason: "Fictional test" }]);
    await call("rpcSetReceiptBusiness", [tokens["S_001"], { id, business: "vape" }]);
    await view(id);
    expect(await snap()).toBe(before);
  });
});

describe("a failure after the object is stored", () => {
  it("the row cannot be written: the answer is an error, the object stays (unreferenced), nothing is written", async () => {
    const broken = deps({ openDb: async () => {
      const c = await connect(testDb.appUrl);
      return { ...c, query: async (text: string, params?: readonly unknown[]) => { if (text.startsWith("insert into ops.receipt_originals")) throw new Error("planted failure"); return c.query(text, params); }, close: () => c.close() } as unknown as Db & { close(): Promise<void> };
    } });
    const bytes = FILES.png();
    const res = await handleUpload(new Request(`${ORIGIN}/files/receipt-original`, { method: "PUT", headers: { authorization: `Bearer ${tokens["S_003"]}`, "content-length": String(bytes.byteLength) }, body: bytes }), broken);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.message).toBe("SERVER_ERROR");
    expect(await rowCount()).toBe(0);
    expect(await audits()).toEqual([]);
    expect(bucket.keys()).toHaveLength(1);
  });
});

describe("the module on its own", () => {
  it("add answers the same record for the same hash inside one transaction too", async () => {
    const bytes = FILES.png();
    const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const viewer = { staffId: "S_001", role: "admin" };
    const s = bucketStorage(bucket);
    const first = await withTransaction(db, (tx) => originals.add(tx, s, { bytes, sha256, contentType: "image/png", business: "vape", source: "photo", fileName: null, note: null }, viewer, new Date()));
    const again = await withTransaction(db, (tx) => originals.add(tx, s, { bytes, sha256, contentType: "image/png", business: null, source: "upload", fileName: null, note: null }, viewer, new Date()));
    expect(again.duplicate).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(originals.sizeText(512)).toBe("512 bytes");
    expect(originals.sizeText(2.4 * MB)).toBe("2.4 MB");
  });
});
