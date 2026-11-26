import { describe, expect, it } from "vitest";
import { formatMoney, moneyEquals, roundMoney } from "../src/lib/money";
import { loadOldUtil, norm } from "./_old-util";

const { Util: old } = loadOldUtil();

const INPUTS: unknown[] = [
  0, -0, 1, -1, 0.005, -0.005, 0.004, 1.005, 2.675, 1.115, 1e-9, -1e-9, 0.1 + 0.2,
  1234567.891, 1e15, 1e21, 123456789012345.67, -98765.4321, Infinity, -Infinity,
  "12.50", " 7 ", "1e3", "0x10", "-3.456", "", "   ", "abc", "12abc", "Infinity",
  null, undefined, NaN, true, false, [], [5], [1, 2], {}, new Date(0),
];
const label = (x: unknown) => String(JSON.stringify(x) ?? x);

describe("roundMoney matches Util.roundMoney", () => {
  for (const x of INPUTS) {
    it(`roundMoney(${label(x)})`, () => {
      expect(norm(roundMoney(x))).toEqual(norm(old.roundMoney(x)));
    });
  }
  it("blank-ish inputs become 0 (old behaviour, deliberately kept)", () => {
    expect(roundMoney("")).toBe(0);
    expect(roundMoney(null)).toBe(0);
    expect(roundMoney(undefined)).toBe(0);
    expect(roundMoney("abc")).toBe(0);
  });
  it("rounds on the binary value, like the old code", () => {
    expect(roundMoney(1.005)).toBe(1); // 1.005 is 1.00499999... in binary
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(0.005)).toBe(0.01);
    expect(Object.is(roundMoney(-0.005), -0)).toBe(true); // Math.round(-0.5) is -0
  });
});

describe("formatMoney matches Util.formatMoney", () => {
  for (const x of INPUTS) {
    it(`formatMoney(${label(x)})`, () => {
      expect(formatMoney(x)).toBe(old.formatMoney(x));
    });
  }
  it("keeps the sign after the dollar sign", () => {
    expect(formatMoney(-5)).toBe("$-5.00");
    expect(formatMoney(null)).toBe("$0.00");
  });
});

describe("moneyEquals matches Util.moneyEquals", () => {
  for (const a of INPUTS) {
    for (const b of [0, 0.004, 0.005, 1.005, "12.50", "", null, undefined, "abc", 1e-9]) {
      it(`moneyEquals(${label(a)}, ${label(b)})`, () => {
        expect(moneyEquals(a, b)).toBe(old.moneyEquals(a, b));
      });
    }
  }
  for (const t of [undefined, 0, 0.005, 0.01, 1, -1, NaN, null, "0.5", ""]) {
    it(`tolerance ${label(t)}`, () => {
      for (const [a, b] of [[1, 1.004], [1, 1.005], [1, 1.5], [0, 0], ["", null], [-2, -2.2]] as const) {
        expect(moneyEquals(a, b, t as number | undefined)).toBe(old.moneyEquals(a, b, t));
      }
    });
  }
  it("tolerance 0 falls back to the default 0.005 (old quirk)", () => {
    expect(moneyEquals(1, 1.004, 0)).toBe(true);
  });
});
