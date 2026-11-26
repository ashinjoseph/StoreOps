// The database helper every test that needs Postgres uses:
//
//   const db = await createTestDb();      // beforeAll
//   ... connect with db.appUrl / db.readUrl / db.ownerUrl ...
//   await db.drop();                      // afterAll
//
// Needs OPS_DB_SUPERUSER_URL (a superuser connection to any database on a
// Postgres 16 or 17 server). global-setup.ts prepares the migrated template
// once per run; createTestDb() copies it into a database of its own.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

export const TEMPLATE_DB = "ops_template";

// Throwaway passwords for the three roles on the test server only.
export const TEST_PASSWORDS = {
  owner: "test-owner-pw",
  app: "test-app-pw",
  read: "test-read-pw",
} as const;

export interface TestDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
  readUrl: string;
  /** Close nothing of yours first: this terminates any connection still open and drops the database. */
  drop(): Promise<void>;
}

export const MISSING_URL_MESSAGE =
  "OPS_DB_SUPERUSER_URL is not set: start a database with `npm --prefix ops run db:up` and export " +
  "OPS_DB_SUPERUSER_URL=postgres://postgres:local-only-super@127.0.0.1:54329/ops (see ops/.env.example).";

export function superuserUrl(): string {
  const url = process.env["OPS_DB_SUPERUSER_URL"];
  if (!url) throw new Error(MISSING_URL_MESSAGE);
  return url;
}

/** The superuser URL pointed at another database (or role). */
function urlFor(base: string, opts: { db?: string; user?: string; password?: string }): string {
  const u = new URL(base);
  if (opts.db !== undefined) u.pathname = `/${encodeURIComponent(opts.db)}`;
  if (opts.user !== undefined) u.username = opts.user;
  if (opts.password !== undefined) u.password = opts.password;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Database names come from this fixed alphabet only, and are quoted.
const quoteIdent = (name: string): string => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
};

/** Run ops/contracts/roles.sql, as a superuser, in the database `url` points at. */
export async function applyRoles(url: string): Promise<void> {
  const sql = readFileSync(new URL("../../contracts/roles.sql", import.meta.url), "utf8");
  await withClient(url, async (c) => {
    await c.query("select set_config('ops.owner_password', $1, false), set_config('ops.app_password', $2, false), set_config('ops.read_password', $3, false)", [
      TEST_PASSWORDS.owner,
      TEST_PASSWORDS.app,
      TEST_PASSWORDS.read,
    ]);
    await c.query(sql);
  });
}

/** Once per test run (vitest globalSetup): roles exist, ops_template is created and fully migrated. */
export async function prepareTemplate(): Promise<void> {
  const { migrate } = await import("../../src/db/migrate");
  const admin = superuserUrl();
  await withClient(admin, async (c) => {
    await c.query(`drop database if exists ${quoteIdent(TEMPLATE_DB)} with (force)`);
    await c.query(`create database ${quoteIdent(TEMPLATE_DB)}`);
  });
  await applyRoles(urlFor(admin, { db: TEMPLATE_DB }));
  await migrate(urlFor(admin, { db: TEMPLATE_DB, user: "ops_owner", password: TEST_PASSWORDS.owner }));
}

function urlsFor(name: string): Pick<TestDb, "ownerUrl" | "appUrl" | "readUrl"> {
  const admin = superuserUrl();
  return {
    ownerUrl: urlFor(admin, { db: name, user: "ops_owner", password: TEST_PASSWORDS.owner }),
    appUrl: urlFor(admin, { db: name, user: "ops_app", password: TEST_PASSWORDS.app }),
    readUrl: urlFor(admin, { db: name, user: "ops_read", password: TEST_PASSWORDS.read }),
  };
}

async function make(fromTemplate: boolean): Promise<TestDb> {
  const admin = superuserUrl();
  const name = `ops_t_${randomBytes(6).toString("hex")}`;
  await withClient(admin, async (c) => {
    // Postgres refuses to copy a template that has a connection open, and two
    // test files may copy it at the same moment: retry while it is in use.
    const sql = fromTemplate
      ? `create database ${quoteIdent(name)} template ${quoteIdent(TEMPLATE_DB)}`
      : `create database ${quoteIdent(name)} template template0`;
    for (let attempt = 0; ; attempt++) {
      try {
        await c.query(sql);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (fromTemplate && code === "55006" && attempt < 50) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (fromTemplate && code === "3D000") {
          throw new Error(`${TEMPLATE_DB} does not exist: the vitest globalSetup did not run (run tests with \`npm --prefix ops test\`).`);
        }
        throw err;
      }
    }
  });
  return {
    name,
    ...urlsFor(name),
    async drop() {
      await withClient(admin, (c) => c.query(`drop database if exists ${quoteIdent(name)} with (force)`));
    },
  };
}

/** A database of its own, copied from the migrated template. */
export const createTestDb = (): Promise<TestDb> => make(true);

/** A database with the roles and schema ops but no tables: for testing the migration runner itself. */
export async function createEmptyDb(): Promise<TestDb> {
  const db = await make(false);
  await applyRoles(urlFor(superuserUrl(), { db: db.name }));
  return db;
}
