import { defineConfig } from "vite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { feedMiddleware } from "./server/feed-fetch.mjs";

export default defineConfig({
  plugins: [
    {
      name: "local-artifact-watch",
      configureServer(server) {
        // Vite prepends a global test-results ignore before our rooted predicate.
        // Keep the other defaults, then re-add the root through Chokidar's public
        // API so its cached matcher is rebuilt using the corrected options.
        const ignored = server.watcher.options.ignored;
        if (!Array.isArray(ignored))
          throw new Error("Vite watcher ignored options must be an array");
        const index = ignored.indexOf("**/test-results/**");
        if (index !== -1) {
          ignored.splice(index, 1);
          server.watcher.add(server.config.root);
        }
      },
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
