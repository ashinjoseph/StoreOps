// Every parity case, one file per area. A card that ports an area adds its file here.
import type { ParityCase } from "../case";
import { attendanceCases } from "./attendance";
import { authCases } from "./auth";
import { bonusesCases } from "./bonuses";
import { bootstrapCases } from "./bootstrap";
import { cashHandlingCases } from "./cash-handling";
import { commissionRulesCases } from "./commission-rules";
import { paymentsCases } from "./payments";
import { commissionCases } from "./commissions";
import { notifierCases } from "./notifier";
import { reconcileCases } from "./reconcile";
import { salesDashboardCases } from "./sales-dashboard";
import { shiftCases } from "./shifts";
import { staffCases } from "./staff";

export const allCases: readonly ParityCase[] = [...authCases, ...staffCases, ...attendanceCases, ...notifierCases, ...bonusesCases, ...commissionRulesCases, ...shiftCases, ...paymentsCases, ...salesDashboardCases, ...cashHandlingCases, ...commissionCases, ...bootstrapCases, ...reconcileCases];
