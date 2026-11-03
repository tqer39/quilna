import { defineConfig } from "vite";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { feedMiddleware } from "./server/feed-fetch.mjs";

export default defineConfig(() => {
  let registeringServer;
  return {
    plugins: [
      {
        name: "local-artifact-watch",
        load: {
          order: "pre",
          async handler(id) {
            const server = registeringServer;
            if (!server || id.includes("\0")) return;
            const file = id.split("?")[0];
            const child = relative(server.config.root, file);
            if (
              !isAbsolute(file) ||
              isAbsolute(child) ||
              child === ".." ||
              child.startsWith(`..${sep}`)
            )
              return;
            const excluded = new Set([
              ".local-state",
              "test-results",
              "playwright-report",
              ".git",
              "node_modules",
            ]);
            if (child.split(sep).some((part) => excluded.has(part))) return;
            for (const directory of [
              server.config.cacheDir,
              resolve(server.config.root, server.config.build.outDir),
            ]) {
              const nested = relative(directory, file);
              if (
                !isAbsolute(nested) &&
                nested !== ".." &&
                !nested.startsWith(`..${sep}`)
              )
                return;
            }
            if (!(await stat(file).catch(() => null))?.isFile()) return;
            // add() is synchronous; ready is emitted only for the initial scan.
            // Wait for this file before any loader can read and cache its contents.
            const deadline = Date.now() + 5000;
            while (
              !server.watcher
                .getWatched()
                [dirname(file)]?.includes(basename(file))
            ) {
              if (server.watcher.closed || Date.now() >= deadline)
                throw new Error(
                  `Source watcher registration did not complete: ${file}`,
                );
              await delay(10);
            }
          },
        },
        configureServer(server) {
          if (
            server.config.server.watch === null ||
            !resolve(server.config.root).split(sep).includes("test-results")
          )
            return;
          // Vite prepends a global test-results ignore before our rooted predicate.
          // Keep the other defaults, then re-add the root through Chokidar's public
          // API so its cached matcher is rebuilt using the corrected options.
          const ignored = server.watcher.options.ignored;
          if (!Array.isArray(ignored))
            throw new Error("Vite watcher ignored options must be an array");
          const index = ignored.indexOf("**/test-results/**");
          if (index !== -1) {
            registeringServer = server;
            ignored.splice(index, 1);
            server.watcher.add(server.config.root);
          }
        },
        config(config) {
          if (config.server?.watch === null) return;
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
  };
});
