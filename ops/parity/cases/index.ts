// Every parity case, one file per area. A card that ports an area adds its file here.
import type { ParityCase } from "../case";
import { authCases } from "./auth";

export const allCases: readonly ParityCase[] = [...authCases];
