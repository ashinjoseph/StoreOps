import { describe, expect, it } from "vitest";
import { attendanceId, newId, newLoginCode, newToken, tillSessionId } from "../src/lib/ids";
import { loadOldUtil } from "./_old-util";

const { Util: old, deps } = loadOldUtil();

const MOMENTS = [
  Date.UTC(2026, 5, 15, 16, 0, 0),
  Date.UTC(2026, 0, 1, 4, 59, 59), // 23:59:59 on 2025-12-31 Toronto
  Date.UTC(2026, 0, 1, 5, 0, 1), // 00:00:01 on 2026-01-01 Toronto
  Date.UTC(2026, 2, 8, 6, 59, 59), // just before spring-forward
  Date.UTC(2026, 2, 8, 7, 0, 0), // just after
  Date.UTC(2026, 10, 1, 5, 30, 0), // first 01:30 (EDT)
  Date.UTC(2026, 10, 1, 6, 30, 0), // second 01:30 (EST)
  Date.UTC(2026, 6, 1, 3, 30, 0), // UTC is 07-01, Toronto is 06-30
];
const RANDOMS = [0, 0.5, 0.123456789, 0.999999999999, 1e-10, 0.00001, 0.7071067811865476, 0.36];

describe("newId matches Util.newId", () => {
  for (const ms of MOMENTS) {
    for (const r of RANDOMS) {
      it(`${new Date(ms).toISOString()} random ${r}`, () => {
        deps.nowMs = ms;
        deps.random = () => r;
        expect(newId("SH", { now: new Date(ms), random: () => r })).toBe(old.newId("SH"));
      });
    }
  }
  it("shape: prefix_yyyyMMdd_HHmmss_xxx with a base-36 suffix", () => {
    const id = newId("PAY", { now: new Date(Date.UTC(2026, 5, 15, 16, 0, 0)), random: () => 0.123456789 });
    expect(id).toMatch(/^PAY_20260615_120000_[0-9a-z]{3}$/);
  });
  it("10,000 ids over distinct seconds, default crypto randomness, do not collide", () => {
    const start = Date.UTC(2026, 5, 15, 16, 0, 0);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newId("T", { now: new Date(start + i * 1000) }));
    expect(seen.size).toBe(10_000);
  });
  it("default (no deps) still works and uses the real clock", () => {
    expect(newId("X")).toMatch(/^X_\d{8}_\d{6}_[0-9a-z]{0,3}$/);
  });
});

describe("attendanceId matches Util.attendanceId", () => {
  for (const ms of MOMENTS) {
    for (const staff of ["S1", "staff_042", "", "a b"]) {
      it(`${new Date(ms).toISOString()} ${JSON.stringify(staff)}`, () => {
        expect(attendanceId(new Date(ms), staff)).toBe(old.attendanceId(new Date(ms), staff));
      });
    }
  }
  it("is deterministic", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 16));
    expect(attendanceId(d, "S1")).toBe("A_20260615_S1");
    expect(attendanceId(d, "S1")).toBe(attendanceId(d, "S1"));
  });
  it("stringifies a missing staff id like the old string concatenation", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 16));
    expect(attendanceId(d, undefined as unknown as string)).toBe(old.attendanceId(d, undefined));
  });
});

describe("tillSessionId matches Util.tillSessionId", () => {
  for (const ms of MOMENTS) {
    for (const company of ["cstore", "vape", "", "CSTORE", undefined, null]) {
      it(`${new Date(ms).toISOString()} ${String(company)}`, () => {
        expect(tillSessionId(new Date(ms), "S1", company as string)).toBe(old.tillSessionId(new Date(ms), "S1", company));
      });
    }
  }
  it("cstore is CST, anything else is VAP", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 16));
    expect(tillSessionId(d, "S1", "cstore")).toBe("CST-20260615-S1");
    expect(tillSessionId(d, "S1", "vape")).toBe("VAP-20260615-S1");
  });
});

describe("newToken matches Util.newToken", () => {
  for (const u of ["00000000-0000-4000-8000-000000000001", "", "no-dashes-here-at-all", "abc"]) {
    it(`uuid ${JSON.stringify(u)}`, () => {
      deps.uuid = () => u;
      expect(newToken({ uuid: () => u })).toBe(old.newToken());
    });
  }
  it("default is 32 hex chars and 10,000 do not collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const t = newToken();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(10_000);
  });
});

describe("newLoginCode matches Util.newLoginCode", () => {
  const seqs = [[0, 0.1, 0.25, 0.5, 0.75, 0.99, 0.999999999], [0.95, 0.05]];
  for (const digits of [undefined, 0, 1, 2, 4, 6, 2.5, -1, NaN, "3"]) {
    for (const seq of seqs) {
      it(`digits ${String(digits)} seq ${seq.join(",")}`, () => {
        let i = 0, j = 0;
        deps.random = () => seq[i++ % seq.length] as number;
        const rnd = () => seq[j++ % seq.length] as number;
        expect(newLoginCode(digits as number | undefined, { random: rnd })).toBe(old.newLoginCode(digits));
      });
    }
  }
  it("default is 4 digits, all in 0-9", () => {
    for (let i = 0; i < 2000; i++) expect(newLoginCode()).toMatch(/^\d{4}$/);
  });
  it("digits 0 means 4 (old quirk)", () => {
    expect(newLoginCode(0)).toMatch(/^\d{4}$/);
  });
});
