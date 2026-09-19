import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  webServer: {
    command: "node server.mjs",
    port: 4173,
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
