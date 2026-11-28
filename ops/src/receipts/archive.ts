// Which receipt originals are "archived" (card P5-12c; docs/components/receipts.md, "Archived files").
//
// The owner's choice (Nov 28): recent files stay at hand, and after a month they move to cheaper archive
// storage, the way a bank shows older statements. The MOVE is not the app's work: it is a rule on the
// storage (R2's "infrequent access" class after N days). An archived file still opens at once, but every
// opening is charged a small fee, so the page and the assistants' door must not open one unasked.
//
// The app never asks the storage which class a file is in (that would itself be a request per file). It
// works the answer out from the file's age with ONE pure function, `isArchived`, and the setting
// `receipt_archive_after_days` must simply match the storage rule's days.
//
// The boundary, exactly: by Toronto calendar days. An original is archived when the number of Toronto
// calendar days from the day it was added to the day of `now` is MORE THAN the setting. With 30: added
// on Oct 28, it is still recent on Nov 27 (30 days on) and archived from Nov 28 00:00 Toronto (31).
// Calendar days, not 24-hour blocks, so a clock change never moves the boundary by an hour or a day.
// The storage's own rule counts from the moment of upload and acts within about a day, so the two can
// differ by up to a day; the setting's words say so (settings.md, receipts.md).
//
// Time is the caller's `now`: nothing here reads a clock. No storage call, no SQL.
import type { Config } from "../lib/config";
import { wallClock } from "../lib/dates";

export const SETTING = "receipt_archive_after_days";
export const DEFAULT_DAYS = 30;
export const MIN_DAYS = 1;
export const MAX_DAYS = 3650;

const DAY_MS = 86_400_000;

/** A whole number of days from 1 to 3650, or null (anything else: a fraction, zero, negative, not a number). */
function wholeDays(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_DAYS && v <= MAX_DAYS ? v : null;
}

/**
 * The setting as the app reads it: plain whole-number text from 1 to 3650; blank, and anything that
 * somehow got stored but is not one (0, -1, 1.5, "abc", "30 days"), reads as 30. Never throws.
 */
export function archiveAfterDays(config: Config): number {
  const text = config.value(SETTING).trim();
  return /^[0-9]{1,5}$/.test(text) ? (wholeDays(Number(text)) ?? DEFAULT_DAYS) : DEFAULT_DAYS;
}

/** The Toronto calendar day of an instant as a day number (days since 1970-01-01), clock changes included. */
function torontoDayNumber(d: Date): number {
  const w = wallClock(d);
  return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / DAY_MS);
}

/**
 * True when an original added at `addedAt` is archived at `now`, with the rule of `afterDays` days:
 * more than `afterDays` Toronto calendar days have passed since the day it was added. `afterDays` that is
 * not a whole number from 1 to 3650 counts as 30. An invalid date is never archived (nothing is
 * claimed about a file whose age is not known).
 */
export function isArchived(addedAt: Date, now: Date, afterDays: number): boolean {
  if (Number.isNaN(addedAt.getTime()) || Number.isNaN(now.getTime())) return false;
  const days = wholeDays(afterDays) ?? DEFAULT_DAYS;
  return torontoDayNumber(now) - torontoDayNumber(addedAt) > days;
}

// ── The words ──────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "November 2026": the Toronto month the original was added. */
export function monthYear(addedAt: Date): string {
  const w = wallClock(addedAt);
  return `${MONTHS[w.month - 1]} ${w.year}`;
}

/** "2.4 MB", "830 KB", "512 bytes" (the same sizes as everywhere else in the app). */
function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** What the tile on the page says in place of a preview: "Archived November 2026 · image/jpeg, 2.4 MB". The page builds the same words. */
export function tileWords(addedAt: Date, contentType: string, size: number): string {
  return `Archived ${monthYear(addedAt)} · ${contentType}, ${sizeWords(size)}`;
}

/** The button on the tile. */
export const OPEN_BUTTON = "Open the original";

/** The notice in the review, where the original is not loaded until asked. */
export const REVIEW_NOTICE = "This file is in the archive. Opening it costs a little; open it when you need to check the figures.";

/** Added to the answer of `receipt_original` about an archived file, so a scheduled task does not sweep the archive unasked. */
export const ASSISTANT_WORDS = "This file is archived: showing it uses the archive, which costs a little each time. Show it only when you need it, not to look through the receipts.";

/** Added to the description of the two tools. */
export const TOOL_DESCRIPTION_WORDS = "An original marked archived: true is in the archive; showing it with receipt_original uses the archive, which costs a little each time, so show an archived one only when it is needed.";
