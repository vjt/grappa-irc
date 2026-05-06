import { defineConfig, devices } from "@playwright/test";

// Grappa e2e Playwright config.
//
// Default browser project: chromium. iOS-shaped specs (M3, M6, BUG7)
// opt in to webkit + iPhone 15 device via the @webkit tag.
//
// Base URL is wired via E2E_BASE_URL — set on the playwright-runner
// container in cicchetto/e2e/compose.yaml. Local-host runs need to
// export it manually (or hit nginx-test directly when on the docker
// network).

const baseURL = process.env.E2E_BASE_URL ?? "http://nginx-test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-iphone-15",
      use: { ...devices["iPhone 15"] },
      grep: /@webkit/,
    },
  ],
});
