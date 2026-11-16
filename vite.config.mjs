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
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { feedMiddleware } from "./server/feed-fetch.mjs";

export default defineConfig(() => {
  let registeringServer;
  let disposed = false;
  const sourceStats = new Map(),
    sourceInodes = new Map(),
    sourceWatchers = new Map(),
    checking = new Map();
  // 属性だけの通知を除き、内容の更新・置換に関係する属性を比較する。
  const fingerprint = (info) =>
    JSON.stringify([info.mtimeMs, info.size, info.ino]);
  const recheckSource = async (server, file) => {
    const pending = checking.get(file);
    if (pending) {
      pending.again = true;
      return;
    }
    const state = { again: true };
    checking.set(file, state);
    try {
      while (state.again && !server.watcher.closed && !disposed) {
        state.again = false;
        // 通常通知を先行させ、同梱Chokidarの50msのchange抑制後に確認する。
        await delay(60);
        if (server.watcher.closed || disposed || !sourceStats.has(file)) return;
        const info = await stat(file).catch(() => null);
        if (!sourceStats.has(file)) return;
        // 消失中のファイルは既存のatomic/unlink処理に任せる。
        if (!info?.isFile() || server.watcher.closed) continue;
        // Chokidarの索引を外さず、新しい実体の通知だけを補う。
        // unwatch/addで索引を空にすると、並行するディレクトリ走査が誤ったaddを出す。
        if (
          process.platform === "darwin" &&
          sourceInodes.get(file) !== info.ino &&
          !server.watcher._pendingUnlinks?.has(file)
        ) {
          try {
            const recovery = watch(
              file,
              () => void recheckSource(server, file),
            );
            const previous = sourceWatchers.get(file);
            sourceWatchers.set(file, recovery);
            sourceInodes.set(file, info.ino);
            previous?.close();
            recovery.on("error", (error) => {
              if (sourceWatchers.get(file) !== recovery) return;
              recovery.close();
              sourceWatchers.delete(file);
              sourceInodes.delete(file);
              server.config.logger.error(
                `Source watcher recovery failed: ${error.message}`,
              );
            });
            state.again = true;
          } catch (error) {
            // 監視資源が不足しても、今届いた変更の配信更新は失わない。
            if (!["ENOENT", "ENOTDIR"].includes(error?.code))
              server.config.logger.error(
                `Source watcher recovery failed: ${error instanceof Error ? error.message : "unknown error"}`,
              );
          }
        }
        const next = fingerprint(info);
        if (sourceStats.get(file) !== next) {
          // 同梱Chokidarの正規化経路を使い、all・atomic・書き込み完了待ちを保つ。
          await server.watcher._emit("change", file, info);
        }
      }
    } catch (error) {
      server.config.logger.error(
        `Source watcher recovery failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (checking.get(file) === state) checking.delete(file);
    }
  };
  return {
    plugins: [
      {
        name: "local-artifact-watch",
        closeBundle() {
          disposed = true;
          for (const recovery of sourceWatchers.values()) recovery.close();
          sourceWatchers.clear();
          sourceStats.clear();
          sourceInodes.clear();
          checking.clear();
        },
        load: {
          order: "pre",
          async handler(id) {
            const server = registeringServer;
            if (!server || disposed || id.includes("\0")) return;
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
            const info = await stat(file).catch(() => null);
            // 別クエリのloadで、既存URLのキャッシュの比較基準を上書きしない。
            if (info?.isFile() && !sourceStats.has(resolve(file))) {
              sourceStats.set(resolve(file), fingerprint(info));
              // 索引からnative監視のinodeは確定できないため、初回loadで独立して監視する。
              if (
                process.platform === "darwin" &&
                typeof server.watcher._emit === "function"
              )
                void recheckSource(server, resolve(file));
            }
          },
        },
        configureServer(server) {
          if (server.config.server.watch === null) return;
          disposed = false;
          registeringServer = server;
          if (typeof server.watcher._emit !== "function") {
            server.config.logger.warn(
              "Source watcher recovery is unavailable for this Vite version.",
            );
          }
          server.watcher.on("unlink", (file) => {
            sourceWatchers.get(resolve(file))?.close();
            sourceWatchers.delete(resolve(file));
            sourceStats.delete(resolve(file));
            sourceInodes.delete(resolve(file));
          });
          server.watcher.on("change", (file, info) => {
            const key = resolve(file);
            if (sourceStats.has(key) && info?.isFile())
              sourceStats.set(key, fingerprint(info));
          });
          if (typeof server.watcher._emit === "function")
            server.watcher.on("raw", (_event, path, details) => {
              // Chokidarの通知抑制を補う。既に読み込んだソース以外はstatもしない。
              const candidates = new Set();
              if (typeof details?.watchedPath === "string") {
                candidates.add(resolve(details.watchedPath));
                if (typeof path === "string")
                  candidates.add(resolve(details.watchedPath, path));
              }
              if (typeof path === "string" && isAbsolute(path))
                candidates.add(resolve(path));
              for (const file of candidates)
                if (sourceStats.has(file)) void recheckSource(server, file);
            });
          if (!resolve(server.config.root).split(sep).includes("test-results"))
            return;
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
                // Chokidar's FSEvents backend indexes files before asynchronously
                // installing their listener. fs.watch installs synchronously, so
                // getWatched can safely gate each source before Vite caches it.
                // Disable the macOS polling fallback explicitly as well.
                useFsEvents: false,
                usePolling: false,
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
