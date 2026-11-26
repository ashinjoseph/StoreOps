// Port of the money helpers in src/Util.gs. Behaviour is identical, quirks included.
//
// These helpers COERCE: a blank, null, undefined or non-numeric input counts as 0.
// That is right for rounding at write time and for sums (ADR-0004: "sums may
// treat null as 0"). It is NOT how to read a measured or optional figure; those
// are read as null (numOrNull) and must never go through these helpers first.

/** Number(x), with NaN and -0 both becoming +0. Same result as the old `Number(x) || 0`. */
function toNumberOrZero(x: unknown): number {
  const n = Number(x);
  return Number.isNaN(n) || n === 0 ? 0 : n;
}

/** Round to cents. Math.round on value*100, so halves go up (towards +Infinity), e.g. -0.005 gives -0. */
export function roundMoney(n: unknown): number {
  return Math.round(toNumberOrZero(n) * 100) / 100;
}

/** True when a and b differ by less than the tolerance. A tolerance of 0, NaN or missing means 0.005. */
export function moneyEquals(a: unknown, b: unknown, tolerance?: number | null): boolean {
  return Math.abs(toNumberOrZero(a) - toNumberOrZero(b)) < (tolerance || 0.005);
}

/** "$12.50". A negative amount keeps its sign after the dollar sign ("$-5.00"). */
export function formatMoney(n: unknown): string {
  return "$" + toNumberOrZero(n).toFixed(2);
}
