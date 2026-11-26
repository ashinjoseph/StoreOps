import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET") =>
  worker.fetch(new Request(`https://ops.test${path}`, { method }));

describe("health", () => {
  it("GET /health returns 200 and the service body", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, service: "storeops-ops" });
  });

  it("an unknown path returns 404 with the error shape", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("POST /health is 404 (routes match method and exact path)", async () => {
    const res = await call("/health", "POST");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
