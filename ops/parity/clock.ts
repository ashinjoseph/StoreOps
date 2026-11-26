// One frozen clock for both worlds.
//
// The new side reads it through the router's `now` (ctx.now). The old side
// reads it through `Date`: the old source is evaluated with `new Function` in
// this realm (scripts/docs/runtime.js), so every `new Date()` and `Date.now()`
// in it resolves the GLOBAL `Date` at the moment it runs. OldWorld.run puts a
// frozen `Date` there for the length of one synchronous old call and puts the
// real one back afterwards, so nothing else in the process (the pg driver,
// vitest) ever sees it. No change to scripts/docs/runtime.js was needed.

export interface Duration {
  ms?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
}

export function durationMs(d: Duration): number {
  return (d.ms ?? 0) + (d.seconds ?? 0) * 1000 + (d.minutes ?? 0) * 60_000 + (d.hours ?? 0) * 3_600_000 + (d.days ?? 0) * 86_400_000;
}

/**
 * When the fixture is seeded: Friday 20 November 2026, 09:30 in Toronto. The
 * fixture's "today" and its 120 days of history hang off this instant.
 */
export const FIXTURE_BOOT_AT = new Date("2026-11-20T14:30:00Z");
/**
 * When every case starts: an hour later the same day. Not the boot instant, so
 * an id a case generates (prefix_yyyyMMdd_HHmmss_xxx) can never share its
 * second with an id the fixture generated, and only collide by chance with it.
 */
export const CASE_START_AT = new Date("2026-11-20T15:30:00Z");

export class FrozenClock {
  private ms: number;
  constructor(start: Date = CASE_START_AT) {
    this.ms = start.getTime();
  }
  now(): Date {
    return new RealDate(this.ms);
  }
  nowMs(): number {
    return this.ms;
  }
  set(at: Date | string): void {
    const ms = new RealDate(at).getTime();
    if (!Number.isFinite(ms)) throw new Error(`clock.set: not a time: ${String(at)}`);
    this.ms = ms;
  }
  advance(by: Duration): void {
    const ms = durationMs(by);
    if (!Number.isFinite(ms) || ms < 0) throw new Error("clock.advance: the clock only moves forward");
    this.ms += ms;
  }
}

/** The process's own Date, captured at load (before any old call could replace it). */
export const RealDate: DateConstructor = globalThis.Date;

/**
 * A `Date` constructor whose "now" is `clock`. Everything else is the real
 * Date: `new Date(x)` with arguments, Date.UTC, Date.parse, and instances (they
 * are real Date objects, so `instanceof Date` holds on both sides of a swap).
 */
export function frozenDate(clock: FrozenClock): DateConstructor {
  return new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return args.length === 0 ? Reflect.construct(target, [clock.nowMs()], newTarget) : Reflect.construct(target, args, newTarget);
    },
    apply() {
      // Date() called without new returns a string of now.
      return new RealDate(clock.nowMs()).toString();
    },
    get(target, prop, receiver) {
      if (prop === "now") return () => clock.nowMs();
      return Reflect.get(target, prop, receiver);
    },
  });
}
