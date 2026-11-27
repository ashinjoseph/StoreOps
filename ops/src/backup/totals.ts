// Per-table totals for the nightly copy's manifest, and the same totals for a restored database (card
// P4-06a). They are the cutover reconcile's own measures (src/cutover/compare.ts): the row count, and the
// sum of every money or whole-number column, in exact integer units (cents for numeric(12,2)) and never as
// floating point, grouped per month in America/Toronto by the column the cutover groups that table by
// (DATE_COLUMN). Pay rates are left out of the sums, as the cutover leaves them out (RATE_COLUMNS).
//
// A blank is not zero (ADR-0004): a NULL adds nothing and is not counted as a figure.
//
// Pure: the caller hands in each row's values as they are written in a file (encode.ts), so the totals of
// what was copied and the totals of what a restore re-read are computed by the same code.
import { DATE_COLUMN, formatUnits, RATE_COLUMNS, toUnits, torontoDay } from "../cutover/compare";
import type { ColumnKind, Encoded } from "./encode";

export interface TotalsColumn {
  name: string;
  /** The column's type as the database prints it, e.g. "numeric(12,2)". */
  type: string;
  kind: ColumnKind;
}

export interface MonthTotals {
  /** "YYYY-MM", or "no date" for a row whose date column is blank. */
  month: string;
  rows: number;
  sums: Record<string, string>;
}

export interface TableTotals {
  rows: number;
  /** column name -> the exact total, as text ("1234.50"). Only money (numeric) and integer columns. */
  sums: Record<string, string>;
  /** Present only for a table the cutover groups by a date. Sorted by month. */
  months?: MonthTotals[];
}

const NO_DATE = "no date";

/** The digits after the point in "numeric(12,2)"; an unconstrained numeric is read to 10 places. */
function scaleOf(type: string): number {
  const m = /^numeric\(\d+,\s*(\d+)\)$/.exec(type);
  return m ? Number(m[1]) : type.startsWith("numeric") ? 10 : 0;
}

interface Acc {
  rows: number;
  sums: bigint[];
}

export class TotalsBuilder {
  private readonly table: string;
  private readonly columns: readonly TotalsColumn[];
  private readonly sumAt: number[];
  private readonly scales: number[];
  private readonly dateAt: number;
  private readonly total: Acc;
  private readonly byMonth = new Map<string, Acc>();

  constructor(table: string, columns: readonly TotalsColumn[]) {
    this.table = table;
    this.columns = columns;
    this.sumAt = [];
    this.scales = [];
    columns.forEach((c, i) => {
      if ((c.kind === "numeric" || c.kind === "integer") && !RATE_COLUMNS.has(`${table}.${c.name}`)) {
        this.sumAt.push(i);
        this.scales.push(c.kind === "integer" ? 0 : scaleOf(c.type));
      }
    });
    const dateColumn = DATE_COLUMN[table];
    this.dateAt = dateColumn ? columns.findIndex((c) => c.name === dateColumn) : -1;
    this.total = this.fresh();
  }

  private fresh(): Acc {
    return { rows: 0, sums: this.sumAt.map(() => 0n) };
  }

  private monthOf(value: Encoded): string {
    if (typeof value !== "string") return NO_DATE;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 7);
    const t = new Date(value);
    return Number.isNaN(t.getTime()) ? NO_DATE : torontoDay(t).slice(0, 7);
  }

  /** Add one row: its values as written in a file, in column order. */
  add(values: readonly Encoded[]): void {
    const month = this.dateAt >= 0 ? this.monthOf(values[this.dateAt]) : null;
    let acc: Acc | undefined;
    if (month !== null) {
      acc = this.byMonth.get(month);
      if (acc === undefined) {
        acc = this.fresh();
        this.byMonth.set(month, acc);
      }
      acc.rows++;
    }
    this.total.rows++;
    this.sumAt.forEach((at, k) => {
      const v = values[at];
      if (v === null || v === undefined) return;
      const units = toUnits(String(v), this.scales[k] as number);
      if (units === null) throw new Error(`totals: a value in ${this.table}.${(this.columns[at] as TotalsColumn).name} is not a plain decimal`);
      this.total.sums[k] = (this.total.sums[k] as bigint) + units;
      if (acc) acc.sums[k] = (acc.sums[k] as bigint) + units;
    });
  }

  private render(a: Acc): Record<string, string> {
    const out: Record<string, string> = {};
    this.sumAt.forEach((at, k) => {
      out[(this.columns[at] as TotalsColumn).name] = formatUnits(a.sums[k] as bigint, this.scales[k] as number);
    });
    return out;
  }

  result(): TableTotals {
    const out: TableTotals = { rows: this.total.rows, sums: this.render(this.total) };
    if (this.dateAt >= 0) {
      out.months = [...this.byMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, a]) => ({ month, rows: a.rows, sums: this.render(a) }));
    }
    return out;
  }
}
