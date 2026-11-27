// Day arithmetic the till client and the fake till share. Pure: no clock of its own, nothing from `node:`.

/** A real `YYYY-MM-DD`: month and day in range for that year. */
export function isRealDay(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Whole days from `a` to `b` (both real days). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string): number => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** A day and `n` more days (n may be negative), `YYYY-MM-DD`. */
export function addDays(day: string, n: number): string {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n)).toISOString().slice(0, 10);
}

/** The Toronto calendar day of an instant. */
export function torontoDay(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
