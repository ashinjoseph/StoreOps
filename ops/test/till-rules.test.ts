import { describe, expect, it } from "vitest";
import {
  checkDailyRow,
  checkDailyRows,
  checkProducts,
  checkSalesSummary,
  checkShift,
  checkTakings,
} from "../src/till/rules";
import { fixture } from "./fixtures/till/load";

const shift = () => fixture("shifts").shifts[0];
const open = () => fixture("shifts").shifts[1];
const days = () => fixture("sales-daily").days;
const paths = (d: { path: string }[]) => d.map((x) => x.path);

describe("shift rules", () => {
  it("holds on a closed and an open shift", () => {
    expect(checkShift(shift(), "s")).toEqual([]);
    expect(checkShift(open(), "s")).toEqual([]);
  });

  it("flags variance one cent off", () => {
    const s = shift();
    s.variance = -0.49;
    expect(checkShift(s, "s")).toEqual([{ severity: "error", path: "s.variance", expected: "-0.50", actual: "-0.49" }]);
  });

  it("is not fooled by float noise", () => {
    const s = shift();
    s.expected = 0.1;
    s.counted = 0.3;
    s.variance = 0.2; // 0.3 - 0.1 is 0.19999999999999998 in floats
    expect(checkShift(s, "s")).toEqual([]);
  });

  it("skips the variance rule when any of the three is null", () => {
    const s = shift();
    s.status = "auto_closed";
    s.counted = null;
    s.variance = null;
    expect(checkShift(s, "s")).toEqual([]);
  });

  it("requires the closing fields to be null while open", () => {
    for (const field of ["expected", "counted", "variance", "closed_at", "closed_by", "z_number"]) {
      const s = open();
      s[field] =
        field === "closed_by" ? { staff_id: "x", name: "y" } : field === "closed_at" ? "2026-11-25T23:00:00Z" : 0;
      expect(paths(checkShift(s, "s")), field).toEqual([`s.${field}`]);
    }
  });

  it("checks the shift's own summary and takings", () => {
    const s = shift();
    s.sales_summary.total = 74.01;
    s.takings.cash.sales_total = 48;
    expect(paths(checkShift(s, "s")).sort()).toEqual(["s.sales_summary.total", "s.takings.cash.net_total"]);
  });

  it("does not demand takings equal the summary total on a shift", () => {
    const s = shift();
    s.takings.cash = { sales_total: 0, refunds_total: 0, net_total: 0 };
    expect(checkShift(s, "s")).toEqual([]);
  });
});

describe("sales summary rules", () => {
  const sum = () => ({ ...shift().sales_summary });

  it("holds on the fixture", () => expect(checkSalesSummary(sum(), "x")).toEqual([]));

  it("flags net off by a cent", () => {
    const s = sum();
    s.net = 65.01;
    s.total = 74.01; // consistent with the wrong net, so only the net rule fires
    expect(checkSalesSummary(s, "x")).toEqual([{ severity: "error", path: "x.net", expected: "65.00", actual: "65.01" }]);
  });

  it("flags total off by a cent", () => {
    const s = sum();
    s.total = 74.01;
    expect(checkSalesSummary(s, "x")).toEqual([
      { severity: "error", path: "x.total", expected: "74.00", actual: "74.01" },
    ]);
  });

  it("accepts float noise (0.1 + 0.2 = 0.3) and a negative rounding", () => {
    expect(
      checkSalesSummary({ subtotal: 0.1, discount: 0, net: 0.1, surcharge: 0.2, rounding: 0, hst: 0, total: 0.3 }, "x"),
    ).toEqual([]);
    expect(
      checkSalesSummary({ subtotal: 10, discount: 0, net: 10, surcharge: 0, rounding: -0.01, hst: 1.3, total: 11.29 }, "x"),
    ).toEqual([]);
  });

  it("flags a total that is nowhere near", () => {
    const s = sum();
    s.total = 0;
    expect(paths(checkSalesSummary(s, "x"))).toEqual(["x.total"]);
  });
});

describe("takings rules", () => {
  const t = () => structuredClone(shift().takings);

  it("holds on the fixture", () => expect(checkTakings(t(), "t")).toEqual([]));

  it("flags net_total that is not sales + refunds", () => {
    const x = t();
    x.cash.net_total = 44.01;
    expect(checkTakings(x, "t")).toEqual([
      { severity: "error", path: "t.cash.net_total", expected: "44.00", actual: "44.01" },
    ]);
  });

  it("flags a negative sales_total and a positive refunds_total", () => {
    const x = t();
    x.debit = { sales_total: -1, refunds_total: 0, net_total: -1 };
    x.etransfer = { sales_total: 5, refunds_total: 2, net_total: 7 };
    expect(paths(checkTakings(x, "t")).sort()).toEqual(["t.debit.sales_total", "t.etransfer.refunds_total"]);
  });

  it("is not fooled by float noise", () => {
    const x = t();
    x.other = { sales_total: 0.1, refunds_total: 0, net_total: 0.1 };
    x.cash = { sales_total: 0.3, refunds_total: -0.1, net_total: 0.19999999999999998 };
    expect(checkTakings(x, "t")).toEqual([]);
  });
});

describe("daily row rules", () => {
  it("holds on the fixture rows", () => {
    for (const [i, row] of days().entries()) expect(checkDailyRow(row, `d[${i}]`), String(i)).toEqual([]);
  });

  it("warns, not errors, when the five net_totals do not add up to the total", () => {
    const row = days()[0];
    row.takings.cash = { sales_total: 40, refunds_total: -5, net_total: 35 };
    expect(checkDailyRow(row, "d")).toEqual([
      { severity: "warning", path: "d.takings", expected: "74.00", actual: "65.00" },
    ]);
  });

  it("errors on a delivery object outside the delivery channel", () => {
    const row = days()[0];
    row.delivery = { orders: 1, fees: 1 };
    expect(checkDailyRow(row, "d")).toEqual([
      { severity: "error", path: "d.delivery", expected: "absent unless channel is delivery", actual: "present on till" },
    ]);
  });

  it("accepts a delivery object on the delivery channel", () => {
    expect(checkDailyRow(days()[2], "d")).toEqual([]);
  });

  it("also runs the summary and takings rules", () => {
    const row = days()[1];
    row.sales_summary.net = 1;
    row.takings.etransfer.net_total = 0;
    expect(paths(checkDailyRow(row, "d").filter((x) => x.severity === "error")).sort()).toEqual([
      "d.sales_summary.net",
      "d.sales_summary.total", // the stated net no longer leads to the stated total
      "d.takings.etransfer.net_total",
    ]);
  });
});

describe("daily rows as a set", () => {
  it("holds on the fixture", () => expect(checkDailyRows(days(), "2026-11-19", "2026-11-25", "days")).toEqual([]));

  it("flags a second row for the same day and channel", () => {
    const d = days();
    d.push(structuredClone(d[0]));
    expect(checkDailyRows(d, "2026-11-19", "2026-11-25", "days")).toEqual([
      {
        severity: "error",
        path: "days[3]",
        expected: "one row per business_day and channel",
        actual: "2026-11-24 till again (first at days[0])",
      },
    ]);
  });

  it("flags a day outside the range asked", () => {
    const d = days();
    d[2].business_day = "2026-11-26";
    expect(paths(checkDailyRows(d, "2026-11-19", "2026-11-25", "days"))).toEqual(["days[2].business_day"]);
    d[2].business_day = "2026-11-18";
    expect(paths(checkDailyRows(d, "2026-11-19", "2026-11-25", "days"))).toEqual(["days[2].business_day"]);
  });
});

describe("product rules", () => {
  const products = () => fixture("products").products;
  const suppliers = () => fixture("suppliers").suppliers;

  it("holds on the fixtures", () => expect(checkProducts(products(), suppliers(), "products")).toEqual([]));

  it("flags a duplicate sku", () => {
    const p = products();
    p[1].sku = p[0].sku;
    p[1].sku_pending = false;
    expect(checkProducts(p, suppliers(), "products")).toEqual([
      { severity: "error", path: "products[1].sku", expected: "unique", actual: "same as products[0].sku" },
    ]);
  });

  it("flags a vendor missing from the suppliers list", () => {
    const p = products();
    p[0].suppliers[0].vendor = "GHOST";
    expect(checkProducts(p, suppliers(), "products")).toEqual([
      {
        severity: "error",
        path: "products[0].suppliers[0].vendor",
        expected: "a vendor listed by /suppliers",
        actual: "GHOST",
      },
    ]);
  });

  it("flags sku_pending that disagrees with a TMP- sku, both ways", () => {
    const p = products();
    p[0].sku_pending = true;
    p[1].sku_pending = false;
    expect(paths(checkProducts(p, suppliers(), "products")).sort()).toEqual([
      "products[0].sku_pending",
      "products[1].sku_pending",
    ]);
  });
});
