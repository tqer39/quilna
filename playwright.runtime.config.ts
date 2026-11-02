import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/runtime",
  testMatch: "**/*.spec.mjs",
  workers: 1,
  timeout: 60000,
  outputDir: "test-results/reader-runtime",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/reader-runtime.json" }],
  ],
  use: { locale: "ja-JP", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true },
    },
  ],
});
