// Port of the ID helpers in src/Util.gs.
//
// Randomness and the clock are injectable so tests can pin them. The default
// randomness is crypto, not Math.random.

import { formatDateStamp, formatDateTimeStamp } from "./dates";

/** A float in [0, 1) from crypto (53 random bits), the shape Math.random returns. */
export function cryptoRandom(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return ((a[0] ?? 0) * 2 ** 21 + ((a[1] ?? 0) >>> 11)) / 2 ** 53;
}

export interface IdDeps {
  now?: Date;
  random?: () => number;
  /**
   * How many random base-36 characters end the id. Default 3, the old shape.
   * Three repeat within a second often enough to matter where the table has a
   * primary key and several ids are made at once (audit rows, payment items):
   * those callers ask for 10.
   */
  chars?: number;
}

/**
 * `<prefix>_<yyyyMMdd>_<HHmmss>_<xxx>`: Toronto time, then up to 3 base-36 characters.
 * Not unique within one second beyond ~46,000 ids (kept: same shape as the old code).
 */
export function newId(prefix: string, deps: IdDeps = {}): string {
  const stamp = formatDateTimeStamp(deps.now ?? new Date());
  const rand = (deps.random ?? cryptoRandom)().toString(36).substring(2, 2 + (deps.chars ?? 3));
  return prefix + "_" + stamp + "_" + rand;
}

/** Deterministic: the same date and staff always give the same id. */
export function attendanceId(dateObj: Date, staffId: string | number): string {
  return "A_" + formatDateStamp(dateObj) + "_" + staffId;
}

/** `CST-<yyyyMMdd>-<staff>` for cstore, `VAP-...` for anything else. */
export function tillSessionId(dateObj: Date, staffId: string | number, company?: string | null): string {
  const prefix = company === "cstore" ? "CST" : "VAP";
  return prefix + "-" + formatDateStamp(dateObj) + "-" + staffId;
}

/** A UUID with the dashes removed (32 hex characters). */
export function newToken(deps: { uuid?: () => string } = {}): string {
  return (deps.uuid ?? (() => crypto.randomUUID()))().replace(/-/g, "");
}

/** A numeric code of `digits` digits (default 4; 0 also means 4, as before). */
export function newLoginCode(digits?: number, deps: { random?: () => number } = {}): string {
  const n = digits || 4;
  const random = deps.random ?? cryptoRandom;
  let code = "";
  for (let i = 0; i < n; i++) {
    code += Math.floor(random() * 10);
  }
  return code;
}
