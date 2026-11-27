// Where the till's key may be sent. Nothing else in the app decides this.
//
// Pure and dependency-free (no `node:`, no contract loader), so the Worker's client and the
// Settings screen share it. `isTillUrl` is the till's counterpart of `isCloverUrl` / `isMetaUrl`:
// a mistyped or hostile setting must never be able to send the key anywhere else.
//
// TILL_SERVERS is copied by hand from the `servers` list of ops/contracts/till-api.v1.yaml (the
// Worker cannot read a YAML file). test/till-client.test.ts reads the contract and fails if the two
// differ, so a new or renamed server is noticed.

export interface TillServer {
  readonly host: string;
  /** No trailing slash. */
  readonly basePath: string;
  readonly description: string;
}

export const TILL_SERVERS: readonly TillServer[] = [
  { host: "office.scarbromart.ca", basePath: "/ops/v1", description: "production" },
  { host: "staging--scarbromart-office.netlify.app", basePath: "/ops/v1", description: "staging (invented data; its own key)" },
];

/**
 * `https://<one of the till's hosts><that server's base path>…`, nothing else: https only, no user
 * name or password, no port written at all, no fragment, the host exactly one of the contract's
 * (a look-alike, a sub-domain, a trailing dot, an IP address or a non-ASCII spelling is not), and
 * the path inside that server's base path.
 *
 * The authority is read from the text as well as from the parsed URL: the parser would quietly
 * drop an explicit ":443", and "no port" means none is written.
 */
export function isTillUrl(url: unknown): boolean {
  if (typeof url !== "string" || url !== url.trim()) return false;
  const m = /^https:\/\/([^/?#]*)/i.exec(url);
  if (m === null) return false;
  const authority = m[1] as string;
  // Anything but a bare host name: user info, a port, brackets (IPv6), a backslash, a percent escape or a space.
  if (!/^[a-z0-9.-]+$/i.test(authority)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" || u.hash !== "") return false;
  if (url.includes("#")) return false;
  const server = TILL_SERVERS.find((s) => s.host === u.hostname);
  if (server === undefined) return false;
  return u.pathname === server.basePath || u.pathname.startsWith(server.basePath + "/");
}

/**
 * The address the app is configured with: a till address (`isTillUrl`) with no query, and no
 * trailing slash. Null when it is not one. Requests are this plus `/stores` and so on.
 */
export function tillBaseUrl(url: unknown): string | null {
  if (!isTillUrl(url)) return null;
  const text = url as string;
  if (text.includes("?")) return null;
  return text.replace(/\/+$/, "");
}
