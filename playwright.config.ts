/**
 * Playwright config (WP-122): the GUI test runner. Suites compose their
 * own daemon in-process (real stores in a scratch state dir, a real
 * loopback listener on port 0) — there is no shared webServer to start.
 *
 * `test:gui` builds first (suites import the packages' compiled dist) and
 * sets PLAYWRIGHT_FORCE_ASYNC_LOADER=1: Playwright 1.61's default
 * synchronous module hooks (node:module registerHooks) break fastify's
 * cyclic CJS requires of semver on Node 22 ("Unexpected module status 3");
 * the older async loader does not intercept that path. Drop the variable
 * when a Playwright/Node pairing no longer reproduces the failure.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/gui",
  // Each file owns its own daemon + state dir; files may run in parallel,
  // tests within a file share the seeded scenario in order.
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["github"]] : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
