// Which connection string a Worker uses, from its bindings (moved out of index.ts, unchanged, so that an
// RPC handler can open a connection of its own without importing the Worker's entry: card P4-06a).
// Never reads the process environment and never carries a connection string in an error.

/** The bindings this file looks at. */
export interface ConnectionEnv {
  /** Cloudflare Hyperdrive: the database connection in a deployed Worker. */
  HYPERDRIVE?: { connectionString: string };
  /** A direct connection string (local development, tests). */
  OPS_DB_APP_URL?: string;
}

/** No database is configured for this Worker. Never carries a connection string. */
export class DbNotConfiguredError extends Error {
  constructor() {
    super("no database configured: bind HYPERDRIVE or set OPS_DB_APP_URL");
    this.name = "DbNotConfiguredError";
  }
}

export function connectionString(env: ConnectionEnv): string {
  const hyperdrive = env.HYPERDRIVE;
  if (hyperdrive !== undefined && typeof hyperdrive.connectionString === "string" && hyperdrive.connectionString !== "") return hyperdrive.connectionString;
  const direct = env.OPS_DB_APP_URL;
  if (typeof direct === "string" && direct !== "") return direct;
  throw new DbNotConfiguredError();
}
