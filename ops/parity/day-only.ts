// Fields whose column holds a day, not an instant. Stated once, here; printed with every run.
//
// The Sheet kept a full date-time in these cells and the old RPCs answer with its ISO instant. The
// new schema stores the day (a `date` column: the frozen contract, P0-03), so the time of day is
// not kept and the new side answers with an instant rebuilt from the day. Nothing on the page reads
// the time of day of these fields (it shows the day). So for the keys below, wherever they appear
// in an answer, a string that is an ISO instant is compared as its day in America/Toronto on both
// sides. A different day is still a difference; so is null against a date. Any other key keeps its
// time of day to the millisecond.
import { formatDate } from "../src/lib/dates";

export const DAY_ONLY_KEYS: readonly { key: string; reason: string }[] = [
  {
    key: "handedOn",
    reason: "cash_handovers.handed_on is a date. The old record keeps a time of day (the moment recorded when the page sent no date, 10:00 for the fixture's weekly drops); the new side answers Toronto midnight of the same day",
  },
  {
    key: "weekEnd",
    reason: "commission_runs.week_end is a date. The old engine writes the week's last millisecond (Sunday 23:59:59.999) and the fixture's own rows hold 23:59:59.000; the new side answers 23:59:59.000 of the same day",
  },
  {
    key: "periodEnd",
    reason: "bonuses.period_end is a date. A commission's period end is the run's week end, with the same .999 against .000",
  },
];

export const DAY_ONLY_RULE = `compared as the day in Toronto, not the instant: ${DAY_ONLY_KEYS.map((k) => k.key).join(", ")} (the column holds a day; a different day is still a difference)`;

const KEYS = new Set(DAY_ONLY_KEYS.map((k) => k.key));
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A copy of `v` with every day-only field's instant replaced by "<day yyyy-MM-dd>". */
export function dayOnly<T>(v: T): T {
  const walk = (x: unknown, key: string | null): unknown => {
    if (Array.isArray(x)) return x.map((e) => walk(e, null));
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(x)) out[k] = walk(e, k);
      return out;
    }
    if (key !== null && KEYS.has(key) && typeof x === "string" && INSTANT.test(x) && !Number.isNaN(Date.parse(x))) return `<day ${formatDate(new Date(x))}>`;
    return x;
  };
  return walk(v, null) as T;
}
