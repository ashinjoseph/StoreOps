// Call once at the top of a test file that must never reach the network: the global `fetch` is replaced
// by one that throws (so the test that reached it fails with this message), and the file also fails
// if it was called at all, even by code that swallowed the error.
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

export function noGlobalFetch(): { reached: ReturnType<typeof vi.fn> } {
  const reached = vi.fn(() => {
    throw new Error("a test reached the global fetch (a real network request)");
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", reached);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    expect(reached, "the global fetch was called").not.toHaveBeenCalled();
  });
  return { reached };
}
