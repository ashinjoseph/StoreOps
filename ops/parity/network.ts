// The guards that keep a parity run off the network (see http.ts).
//
// Outside a case step, the old runtime's UrlFetchApp and the global `fetch` are
// these: they throw and write down the attempt. `takeNetworkLeaks` returns (and
// clears) what was written down; the harness's own tests and parity.test.ts
// assert it is empty. Kept apart from http.ts so old-world.ts can use it
// without a circular import through compare.ts.
const leaks: string[] = [];

/** Every attempt to reach a real network (or the runtime's own UrlFetchApp stub) since the last call; clears the list. */
export function takeNetworkLeaks(): string[] {
  return leaks.splice(0, leaks.length);
}

/** Replaces UrlFetchApp in the old runtime outside a case step. */
export const guardedUrlFetchApp = {
  fetch: (url: unknown): never => {
    leaks.push(`old UrlFetchApp.fetch(${String(url)})`);
    throw new Error("parity: the old runtime's own UrlFetchApp was reached (nothing may leave the process)");
  },
};

/** Replaces the global `fetch` while the new side runs. */
export const guardedFetch: typeof fetch = async (input) => {
  leaks.push(`global fetch(${typeof input === "string" ? input : input instanceof URL ? input.href : input.url})`);
  throw new Error("parity: the real fetch was reached (nothing may leave the process)");
};
