import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/global-setup.ts"],
    // Database tests create databases and wait on locks; allow for a slow CI box.
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
