import { defineConfig } from "vitest/config";

/**
 * Tests are about product behaviour, not about whatever happens to be in the developer's shell.
 * The rail is resolved from the ambient environment when server.ts is imported, so pin it here:
 * without this, a shell that has exported SATSLOOM_RAIL=lnd to run the live node silently turns
 * the demo-path assertions into live-rail ones, and the suite fails for a reason unrelated to the code.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      NODE_ENV: "test",
      SATSLOOM_RAIL: "fixture",
      // Keep any stray ambient node config from reaching the test process at all.
      SATSLOOM_RAIL_FORCE: "fixture",
    },
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  },
});
