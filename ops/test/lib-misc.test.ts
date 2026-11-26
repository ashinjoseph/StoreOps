import { describe, expect, it } from "vitest";
import { formatTimeHHMM, parseTimeRange } from "../src/lib/misc";
import { loadOldUtil, norm } from "./_old-util";

const { Util: old } = loadOldUtil();

const RANGES: unknown[] = [
  "9am-5pm", "5:30pm-11pm", "5.30pm-11pm", "9-5pm", "9am-5", "9 am - 5 pm", "9AM-5PM", "9a-5p", "9a - 5p",
  "9to5pm", "9 to 5pm", "9 until 5pm", "9 till 5pm", "9am–5pm", "9am—5pm", "9am--5pm", "9h30am-5h45pm",
  "12am-6am", "12pm-6pm", "12am-12pm", "12pm-12am", "11pm-1am", "10pm-2am", "6am-6am", "5pm-9am",
  "9:60am-5pm", "9am-5:60pm", "24-25", "23-23:30", "0-6am", "9-17", "9-5", "9", "", "   ", "abc", "9am-", "-5pm",
  "9:5am-5pm", "09:00am-05:00pm", "7:15a-3:45p", "1pm-2pm", "11:59pm-11:59pm", "1am-12pm", "12:30am-12:45am",
  "13pm-14pm", "0am-5am", "00:00am-05:00am", "8 - 4pm", "8pm-4", "11-1pm", "11am-1pm", "11-12pm",
  null, undefined, 0, 9, false, [], {}, "9am-5pm ", " 9am-5pm",
];

describe("parseTimeRange matches Util.parseTimeRange", () => {
  for (const v of RANGES) {
    it(`parseTimeRange(${String(JSON.stringify(v) ?? v)})`, () => {
      expect(norm(parseTimeRange(v))).toEqual(norm(old.parseTimeRange(v)));
    });
  }
  it("returns null, not an empty object, when it cannot parse", () => {
    expect(parseTimeRange("abc")).toBeNull();
    expect(parseTimeRange("")).toBeNull();
    expect(parseTimeRange(null)).toBeNull();
  });
  it("parses an ordinary shift", () => {
    expect(parseTimeRange("5:30pm-11pm")).toEqual({ startHour: 17, startMin: 30, endHour: 23, endMin: 0, hours: 5.5 });
  });
});

describe("formatTimeHHMM matches Util.formatTimeHHMM", () => {
  const H: unknown[] = [0, 5, 9, 12, 23, 24, 100, -1, 1.5, "7", "", null, undefined, NaN];
  const M: unknown[] = [undefined, null, 0, 5, 30, 59, 60, 100, "", "8", NaN, -3];
  for (const h of H) {
    for (const m of M) {
      it(`formatTimeHHMM(${String(JSON.stringify(h) ?? h)}, ${String(JSON.stringify(m) ?? m)})`, () => {
        expect(formatTimeHHMM(h as number, m as number | undefined)).toBe(old.formatTimeHHMM(h, m));
      });
    }
  }
  it("pads both parts", () => {
    expect(formatTimeHHMM(9, 5)).toBe("09:05");
    expect(formatTimeHHMM(17)).toBe("17:00");
  });
});
