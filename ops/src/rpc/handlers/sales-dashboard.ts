// rpcGetSalesDashboard (card P3-11). Thin: reads the page's filters the way the old rpc function in
// WebApp.gs did and shapes the answer. Who may call (admin, manager, payroll admin) is the contract's
// `roles`, applied by the router. The old function had no try/catch, so no error is wrapped here or
// in ERROR_PREFIXED. It returns no Date, so nothing is nulled.
import { parseDate } from "../../lib/dates";
import * as dashboard from "../../modules/sales-dashboard";
import type { RpcHandler } from "../types";

/** One filter as the old `filters.x ? … : null` read it. */
const field = (filters: Record<string, unknown>, key: string): unknown => filters[key];

export const rpcGetSalesDashboard: RpcHandler = async (ctx, filtersArg) => {
  // `filters = filters || {}`: anything falsy is no filters; a text or a number has none of the fields.
  const filters = (filtersArg ? filtersArg : {}) as Record<string, unknown>;
  const startDate = field(filters, "startDate");
  const endDate = field(filters, "endDate");
  const result = await dashboard.getDashboard(
    ctx.db,
    {
      startDate: startDate ? parseDate(startDate) : null,
      endDate: endDate ? parseDate(endDate) : null,
      staffId: field(filters, "staffId") || null,
      company: field(filters, "company") || null,
      page: Number(field(filters, "page")) || 1,
      pageSize: Number(field(filters, "pageSize")) || 50,
    },
    { now: ctx.now },
  );
  // The page reads `rowCount` where the module says `totalCount`.
  return {
    rows: result.rows,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
    rowCount: result.totalCount,
    totals: result.totals,
    daily: result.daily,
    insights: result.insights,
    companies: result.companies,
  };
};
