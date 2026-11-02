import { defineConfig } from "vite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { feedMiddleware } from "./server/feed-fetch.mjs";

export default defineConfig({
  plugins: [
    {
      name: "local-artifact-watch",
      config(config) {
        const root = resolve(config.root ?? process.cwd());
        const artifacts = new Set([
          ".local-state",
          "test-results",
          "playwright-report",
        ]);
        return {
          server: {
            watch: {
              ignored(path) {
                const child = relative(root, resolve(path));
                if (
                  isAbsolute(child) ||
                  child === ".." ||
                  child.startsWith(`..${sep}`)
                )
                  return false;
                return child.split(sep).some((part) => artifacts.has(part));
              },
            },
          },
        };
      },
    },
    {
      name: "local-rss",
      configureServer(server) {
        server.middlewares.use(feedMiddleware());
      },
    },
  ],
});
