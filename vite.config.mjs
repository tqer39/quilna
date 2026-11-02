import { defineConfig } from "vite";
import { feedMiddleware } from "./server/feed-fetch.mjs";

export default defineConfig({
  server: {
    watch: {
      ignored: [
        "**/.local-state/**",
        "**/test-results/**",
        "**/playwright-report/**",
      ],
    },
  },
  plugins: [
    {
      name: "local-rss",
      configureServer(server) {
        server.middlewares.use(feedMiddleware());
      },
    },
  ],
});
