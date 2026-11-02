import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/performance",
  workers: 1,
  timeout: 240000,
  outputDir: ".local-state/search-performance/results",
  reporter: [["list"], ["json", { outputFile: "test-results/search.json" }]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    viewport: { width: 1440, height: 1000 },
  },
  projects: ["studio", "editorial", "focus"].map((design) => ({
    name: design,
    use: {
      storageState: {
        cookies: [],
        origins: [
          {
            origin: "http://127.0.0.1:5199",
            localStorage: [{ name: "quilna.reader.design.v1", value: design }],
          },
        ],
      },
    },
  })),
  webServer: {
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: false,
  },
});
