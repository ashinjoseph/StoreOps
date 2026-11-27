// Where receipt originals live (card P5-12a; ADR-0026): one small interface, three methods. There is no
// way to remove an original and no way to list the store: put, get and head, nothing else. A key is
// never written twice: `put` looks first and refuses a key that is already there (the keys are made from
// random ids, so this never happens unless the code is wrong; the in-memory store refuses it as well, so
// a test sees it). The bytes go in and come out as they were sent: nothing here resizes, re-encodes or
// strips anything.
//
// Over the Worker's R2 binding (`RECEIPTS` in wrangler.toml) when hosted; `wrangler dev` emulates the
// bucket on disk under ops/.wrangler/ (git-ignored). A binding cannot be denied the right to erase objects: the
// hosted setup puts a retention lock on the bucket (docs/components/receipts.md). Tests use memoryBucket,
// which has the same three methods and nothing more.

/** What the app keeps about a stored object besides its bytes. */
export interface StoredMeta {
  contentType: string;
  /** The SHA-256 of the bytes, as 64 hex characters. */
  sha256: string;
  /** The receipt id the object belongs to. */
  receiptId: string;
}

export interface StoredObject {
  size: number;
  meta: StoredMeta;
}

export interface ReceiptStorage {
  /** Store new bytes under a new key. Throws if the key is already taken (nothing is overwritten). */
  put(key: string, bytes: Uint8Array, meta: StoredMeta): Promise<StoredObject>;
  /** The bytes and what was kept with them, or null when there is no such key. */
  get(key: string): Promise<{ bytes: Uint8Array; object: StoredObject } | null>;
  /** What was kept, without the bytes, or null. */
  head(key: string): Promise<StoredObject | null>;
}

export class StorageKeyTakenError extends Error {
  constructor() {
    super("receipt storage: that key is already taken (an original is never overwritten)");
    this.name = "StorageKeyTakenError";
  }
}

/** The part of an R2 binding this file uses. */
export interface BucketLike {
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string>; sha256: string },
  ): Promise<{ size: number } | null>;
}

const metaOf = (o: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): StoredMeta => ({
  contentType: o.httpMetadata?.contentType ?? "",
  sha256: o.customMetadata?.["sha256"] ?? "",
  receiptId: o.customMetadata?.["receipt_id"] ?? "",
});

/** The interface over an R2 binding (or anything with its put, get and head). */
export function bucketStorage(bucket: BucketLike): ReceiptStorage {
  return {
    async put(key, bytes, meta) {
      if ((await bucket.head(key)) !== null) throw new StorageKeyTakenError();
      // sha256: R2 checks the bytes it received against it and refuses the put on a difference.
      const out = await bucket.put(key, bytes, {
        httpMetadata: { contentType: meta.contentType },
        customMetadata: { sha256: meta.sha256, receipt_id: meta.receiptId },
        sha256: meta.sha256,
      });
      if (out === null) throw new StorageKeyTakenError();
      return { size: out.size, meta: { ...meta } };
    },
    async get(key) {
      const o = await bucket.get(key);
      if (o === null) return null;
      return { bytes: new Uint8Array(await o.arrayBuffer()), object: { size: o.size, meta: metaOf(o) } };
    },
    async head(key) {
      const o = await bucket.head(key);
      return o === null ? null : { size: o.size, meta: metaOf(o) };
    },
  };
}

/** True when `v` has the three methods of a bucket (the Worker's RECEIPTS binding, when it is bound). */
export function isBucket(v: unknown): v is BucketLike {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["put"] === "function" && typeof o["get"] === "function" && typeof o["head"] === "function";
}

interface MemoryEntry {
  bytes: Uint8Array;
  contentType: string;
  custom: Record<string, string>;
}

/** An in-memory bucket for tests: put, get and head only; a second put of a key throws. `puts` counts puts. */
export function memoryBucket(): BucketLike & { readonly keys: () => string[]; readonly puts: () => number } {
  const store = new Map<string, MemoryEntry>();
  let puts = 0;
  const view = (e: MemoryEntry) => ({ size: e.bytes.byteLength, httpMetadata: { contentType: e.contentType }, customMetadata: { ...e.custom } });
  return {
    async head(key) {
      const e = store.get(key);
      return e === undefined ? null : view(e);
    },
    async get(key) {
      const e = store.get(key);
      if (e === undefined) return null;
      const copy = e.bytes.slice();
      return { ...view(e), arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer };
    },
    async put(key, value, options) {
      if (store.has(key)) throw new StorageKeyTakenError();
      const src = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const bytes = src.slice();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (digest !== options.sha256) throw new Error("memory bucket: the sha256 given does not match the bytes");
      puts++;
      store.set(key, { bytes, contentType: options.httpMetadata.contentType, custom: { ...options.customMetadata } });
      return { size: bytes.byteLength };
    },
    keys: () => [...store.keys()],
    puts: () => puts,
  };
}
