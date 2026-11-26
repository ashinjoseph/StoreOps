// The parity run's own vitest config (npm --prefix ops run parity). It is kept
// beside `npm --prefix ops test`, not inside it (see cli.mjs for why).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    root: new URL("..", import.meta.url).pathname,
    include: ["parity/**/*.test.ts"],
    globalSetup: ["test/helpers/global-setup.ts"],
    // A write case boots a fresh pair of worlds (an old runtime and a database).
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
