// Where the nightly copy is kept (card P4-06a; ADR-0028): a second R2 bucket, bound as BACKUPS in
// wrangler.toml, apart from the receipts bucket so that one's permanent retention and this one's 90 days
// never meet. The interface has two methods and nothing else: `put` (a new key only) and `anyUnder`
// (does anything already exist under a folder). There is no way here to delete, overwrite or read back:
// the app writes copies and never touches one again. Keeping only 90 days is a lifecycle rule on the
// bucket, set where the bucket is made (docs/components/backups.md), never code in this app.
//
// A key is never written twice. `put` asks R2 to refuse a key that exists (a conditional put: etagDoesNotMatch
// "*"), and the in-memory bucket for tests refuses it as well. The bytes' SHA-256 goes with the put, and R2
// checks the bytes it received against it. The body is always a whole Uint8Array, so its length is known
// (a stream would need its length stated up front).

export class BackupKeyTakenError extends Error {
  constructor() {
    super("backup storage: that key is already taken (a copy is never overwritten)");
    this.name = "BackupKeyTakenError";
  }
}

export interface BackupStorage {
  /** Write new bytes under a new key. Throws BackupKeyTakenError if the key exists; nothing is overwritten. */
  put(key: string, bytes: Uint8Array, sha256: string, contentType: string): Promise<void>;
  /** True when at least one object has a key starting with `prefix`. */
  anyUnder(prefix: string): Promise<boolean>;
}

/** The part of an R2 binding this file uses. */
export interface BackupBucketLike {
  list(options: { prefix: string; limit: number }): Promise<{ objects: readonly unknown[] }>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options: { httpMetadata: { contentType: string }; sha256: string; onlyIf: { etagDoesNotMatch: string } },
  ): Promise<{ size: number } | null>;
}

/** The interface over an R2 binding (or anything with its list and put). */
export function backupStorage(bucket: BackupBucketLike): BackupStorage {
  return {
    async put(key, bytes, sha256, contentType) {
      const out = await bucket.put(key, bytes, { httpMetadata: { contentType }, sha256, onlyIf: { etagDoesNotMatch: "*" } });
      if (out === null) throw new BackupKeyTakenError();
    },
    async anyUnder(prefix) {
      const res = await bucket.list({ prefix, limit: 1 });
      return res.objects.length > 0;
    },
  };
}

/** True when `v` has the two methods of a bucket this file uses (the Worker's BACKUPS binding, when it is bound). */
export function isBackupBucket(v: unknown): v is BackupBucketLike {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["put"] === "function" && typeof o["list"] === "function";
}

/** An in-memory bucket for tests: list and put only. It refuses a second put of a key, with or without a condition. */
export function memoryBackupBucket(): BackupBucketLike & {
  readonly keys: () => string[];
  readonly bytes: (key: string) => Uint8Array | undefined;
  readonly puts: () => number;
  /** The length of the largest body ever put. */
  readonly largestPut: () => number;
} {
  const store = new Map<string, Uint8Array>();
  let puts = 0;
  let largest = 0;
  return {
    async list({ prefix, limit }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((key) => ({ key })) };
    },
    async put(key, value, options) {
      const src = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const bytes = src.slice();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (digest !== options.sha256) throw new Error("memory bucket: the sha256 given does not match the bytes");
      if (store.has(key)) {
        if (options.onlyIf.etagDoesNotMatch === "*") return null;
        throw new BackupKeyTakenError();
      }
      puts++;
      largest = Math.max(largest, bytes.byteLength);
      store.set(key, bytes);
      return { size: bytes.byteLength };
    },
    keys: () => [...store.keys()].sort(),
    bytes: (key) => store.get(key),
    puts: () => puts,
    largestPut: () => largest,
  };
}
