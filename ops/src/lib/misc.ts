// Port of the time-of-day helpers in src/Util.gs (custom shift entry).

export interface TimeRange {
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
  hours: number;
}

/**
 * Parse a time-range string like "9am-5pm", "5:30pm-11pm", "5.30pm-11pm".
 * Returns null when it cannot be read, when no am/pm is given at all, or when the
 * end is not after the start (so an overnight "10pm-2am" is null).
 */
export function parseTimeRange(value: unknown): TimeRange | null {
  const v = (value ? String(value) : "").toLowerCase().trim();
  if (!v) return null;

  const rx = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a|p)?\s*(?:[-–—]+|to|until|till)\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a|p)?$/i;
  const m = v.match(rx);
  if (!m) return null;

  let sh = +(m[1] as string);
  const sm = m[2] ? +m[2] : 0;
  let eh = +(m[4] as string);
  const em = m[5] ? +m[5] : 0;
  let sp = (m[3] || "").toLowerCase().replace(/^a$/, "am").replace(/^p$/, "pm");
  const ep = (m[6] || "").toLowerCase().replace(/^a$/, "am").replace(/^p$/, "pm");

  if (sm > 59 || em > 59) return null;
  if (sh > 23 || eh > 23) return null;
  if (!sp && !ep) return null;

  if (!sp && ep) sp = ep === "pm" && sh < eh ? "am" : ep;

  if (sp === "pm" && sh !== 12) sh += 12;
  if (sp === "am" && sh === 12) sh = 0;
  if (ep === "pm" && eh !== 12) eh += 12;
  if (ep === "am" && eh === 12) eh = 0;

  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return null;

  return {
    startHour: sh,
    startMin: sm,
    endHour: eh,
    endMin: em,
    hours: (endMin - startMin) / 60,
  };
}

/** "09:05". Both parts are zero-padded; a missing minute is 0. */
export function formatTimeHHMM(hour: number, min?: number): string {
  const h = String(hour).padStart(2, "0");
  const m = String(min || 0).padStart(2, "0");
  return h + ":" + m;
}
