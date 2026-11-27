// Every answer of a tool is data (card P5-11; ADR-0025). Text that came from outside the code (a key's
// label, a business name; later a supplier's name or a note on a receipt) can hold words written to
// steer an assistant, or characters that hide or reorder text. It goes out through `asData`, which
// cannot make such text harmless (nothing can) but keeps it to one plain line of bounded length:
// control characters, line and paragraph separators and the bidirectional overrides are removed, and
// the text is cut to `max` characters with "…" at the end.
//
// `toolText` is the one shape of a tool's answer: a one-line summary, then the JSON.

/** C0 and C1 controls (line breaks and tabs included), U+2028/2029, and the bidi embedding/override/isolate marks. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export const DATA_MAX = 200;

/** `text` as one plain, trimmed line of at most `max` characters (code points). null and undefined are "". */
export function asData(text: unknown, max: number = DATA_MAX): string {
  if (text === null || text === undefined) return "";
  const clean = String(text).replace(UNSAFE, "").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return chars.slice(0, Math.max(max - 1, 0)).join("") + "…";
}

/** One text block: the summary (made one line), a line break, then the data as JSON. */
export function toolText(summary: string, data: unknown): string {
  return `${asData(summary, 300)}\n${JSON.stringify(data)}`;
}
