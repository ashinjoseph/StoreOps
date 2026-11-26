// One unit of work, one transaction; and row locks for the tables that later
// cards lock before they read-then-write (ADR: money moves are serialised per row).
import type { Db } from "./client";

const IN_TX: unique symbol = Symbol("ops.db.tx");

/** The handle `withTransaction` gives `fn`. Only it can be locked on. */
export interface Tx extends Db {
  readonly [IN_TX]: true;
}

const isTx = (db: Db): db is Tx => (db as Partial<Tx>)[IN_TX] === true;

/**
 * Run `fn` between begin and commit on the connection behind `db`.
 * - `fn` resolves: commit, return its value. A failing commit rejects.
 * - `fn` throws: roll back and rethrow that same error.
 * - A statement inside failed, even if `fn` caught the error: Postgres would turn
 *   COMMIT into a silent ROLLBACK, so this rolls back and rejects instead.
 * - `db` is already a transaction: throws at once (no nesting, no savepoints).
 * Use one connection for one unit at a time; the Worker opens one per request.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isTx(db)) throw new Error("withTransaction cannot be nested: one unit of work, one transaction");

  let finished = false;
  let firstFailure: unknown;
  let failed = false;
  const guard = <A extends unknown[], R>(run: (...a: A) => Promise<R>) => {
    return async (...a: A): Promise<R> => {
      if (finished) throw new Error("this transaction has finished; its handle cannot be used any more");
      try {
        return await run(...a);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstFailure = err;
        }
        throw err;
      }
    };
  };
  const tx: Tx = {
    [IN_TX]: true,
    query: guard(<R>(t: string, p?: readonly unknown[]) => db.query<R>(t, p)) as Db["query"],
    one: guard(<R>(t: string, p?: readonly unknown[]) => db.one<R>(t, p)) as Db["one"],
    maybeOne: guard(<R>(t: string, p?: readonly unknown[]) => db.maybeOne<R>(t, p)) as Db["maybeOne"],
  };

  await db.query("begin");
  let result: T;
  try {
    result = await fn(tx);
  } catch (err) {
    finished = true;
    await db.query("rollback").catch(() => undefined); // the original error is what matters
    throw err;
  }
  finished = true;
  if (failed) {
    await db.query("rollback").catch(() => undefined);
    throw new Error("transaction rolled back: a statement inside it failed, so nothing was kept", { cause: firstFailure });
  }
  try {
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  }
  return result;
}

/** Tables other cards lock a row of, and each one's primary key. Fixed: callers never supply SQL text. */
const LOCKABLE = {
  staff: { sql: "select 1 as found from ops.staff where staff_id = $1 for update" },
  till_sessions: { sql: "select 1 as found from ops.till_sessions where session_id = $1 for update" },
  attendance: { sql: "select 1 as found from ops.attendance where attendance_id = $1 for update" },
  bonuses: { sql: "select 1 as found from ops.bonuses where bonus_id = $1 for update" },
  payments: { sql: "select 1 as found from ops.payments where payment_id = $1 for update" },
  cash_handovers: { sql: "select 1 as found from ops.cash_handovers where handover_id = $1 for update" },
} as const;

export type LockTable = keyof typeof LOCKABLE;

/**
 * `select … for update` on one row by primary key; waits if another transaction
 * holds it. Returns whether the row exists. Throws outside `withTransaction`
 * (a lock outside one is released at once and protects nothing).
 */
export async function lockRow(tx: Db, table: LockTable, id: string): Promise<boolean> {
  if (!isTx(tx)) throw new Error("lockRow must be called inside withTransaction");
  if (!Object.prototype.hasOwnProperty.call(LOCKABLE, table)) throw new Error("cannot lock rows of that table");
  const rows = await tx.query<{ found: number }>(LOCKABLE[table].sql, [id]);
  return rows.length === 1;
}
