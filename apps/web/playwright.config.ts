import { defineConfig } from "@playwright/test";

// Browser tests run against the Vite dev server with a mocked /api, so they never touch
// the real FHIR server. They use the installed Microsoft Edge; no browser download needed.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  reporter: "list",
  use: { baseURL: "http://localhost:5199", channel: "msedge", viewport: { width: 1200, height: 700 } },
  webServer: { command: "bunx vite --port 5199 --strictPort", url: "http://localhost:5199", reuseExistingServer: false, timeout: 60_000 },
});
