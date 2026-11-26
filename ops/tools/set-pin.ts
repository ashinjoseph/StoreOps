// npm --prefix ops run pin:set -- <staff_id> <pin>
//
// Sets a person's PIN in a LOCAL database so a developer can sign in to a
// fresh one. Reads OPS_DB_APP_URL and PIN_PEPPER from the environment (the
// script loads ops/.dev.vars). Refuses any database that is not on this
// machine. Prints "PIN set for <staff_id>" and nothing else: never the PIN.
import { pathToFileURL } from "node:url";
import { setPin } from "../src/auth/pin.ts";
import { connect } from "../src/db/client.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Returns the process exit code. */
export async function main(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  const [staffId, pin] = args;
  if (staffId === undefined || pin === undefined || args.length !== 2) {
    io.err("usage: npm run pin:set -- <staff_id> <pin>");
    return 2;
  }
  const url = env["OPS_DB_APP_URL"];
  const pepper = env["PIN_PEPPER"];
  if (!url || !pepper) {
    io.err("OPS_DB_APP_URL and PIN_PEPPER must be set (copy .dev.vars.example to .dev.vars).");
    return 2;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    io.err("OPS_DB_APP_URL is not a valid postgres:// URL.");
    return 2;
  }
  if (!LOCAL_HOSTS.has(host)) {
    io.err(`refusing: the database host is "${host}". This tool only works on a database on this machine (127.0.0.1 or localhost).`);
    return 1;
  }
  let db: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    db = await connect(url);
    await setPin(db, staffId, pin, pepper);
  } catch (err) {
    io.err(`could not set the PIN: ${err instanceof Error ? err.message : "unknown error"}`);
    return 1;
  } finally {
    await db?.close().catch(() => undefined);
  }
  io.out(`PIN set for ${staffId}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
