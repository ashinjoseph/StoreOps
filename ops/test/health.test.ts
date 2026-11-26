// The routes that need no database. (/health with a database is in worker.test.ts.)
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET") => worker.fetch(new Request(`https://ops.test${path}`, { method }), {});

describe("health", () => {
  it("GET /health with no database configured is 503 and says db down", async () => {
    const res = await call("/health");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: false, service: "storeops-ops", db: "down" });
  });

  it("an unknown path with no assets returns 404 with the error shape", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("POST /health is 405 (only GET and HEAD reach anything outside /rpc/)", async () => {
    const res = await call("/health", "POST");
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });
});
