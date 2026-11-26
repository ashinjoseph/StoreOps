import { describe, expect, it } from "vitest";
import { assertLocalServer } from "./helpers/db";

describe("the test database helper only touches a local server", () => {
  it("accepts this machine", () => {
    for (const url of [
      "postgres://postgres:x@127.0.0.1:54329/ops",
      "postgres://postgres:x@localhost:5432/ops",
      "postgres://postgres:x@[::1]:5432/ops",
    ]) {
      expect(() => assertLocalServer(url)).not.toThrow();
    }
  });

  it("refuses any other host, naming it but never the password", () => {
    const url = "postgres://postgres:s3cret-value@db.example-project.supabase.co:5432/postgres";
    expect(() => assertLocalServer(url)).toThrow(/db\.example-project\.supabase\.co/);
    try {
      assertLocalServer(url);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("s3cret-value");
    }
  });

  it("refuses something that is not a URL", () => {
    expect(() => assertLocalServer("not a url")).toThrow(/not a valid/);
  });
});
