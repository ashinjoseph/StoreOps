// npm --prefix ops run db:migrate  (reads OPS_DB_OWNER_URL, applies ops/migrations/*.sql)
import { migrate } from "../src/db/migrate.ts";

const url = process.env["OPS_DB_OWNER_URL"];
if (!url) {
  console.error("OPS_DB_OWNER_URL is not set (see ops/.env.example).");
  process.exit(1);
}

try {
  const { applied } = await migrate(url, { log: (line) => console.log(line) });
  console.log(applied.length === 0 ? "nothing to apply: database is up to date" : `applied ${applied.length} migration(s)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
