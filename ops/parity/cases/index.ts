// Every parity case, one file per area. A card that ports an area adds its file here.
import type { ParityCase } from "../case";
import { attendanceCases } from "./attendance";
import { authCases } from "./auth";
import { staffCases } from "./staff";

export const allCases: readonly ParityCase[] = [...authCases, ...staffCases, ...attendanceCases];
