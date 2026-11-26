// vitest globalSetup: runs once per `vitest run`, before any test file.
// With no OPS_DB_SUPERUSER_URL it does nothing, so tests that need no database
// still run; the ones that do fail in createTestDb() with one clear line.
import { prepareTemplate } from "./db";

export default async function setup(): Promise<void> {
  if (!process.env["OPS_DB_SUPERUSER_URL"]) return;
  await prepareTemplate();
}
