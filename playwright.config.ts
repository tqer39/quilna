import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 2,
  outputDir: "test-results/chromium",
  reporter: [["list"], ["json", { outputFile: "test-results/browser.json" }]],
  use: {
    baseURL: "http://127.0.0.1:5197",
    locale: "ja-JP",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5197 --strictPort",
    url: "http://127.0.0.1:5197",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true },
    },
  ],
});
