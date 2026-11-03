import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

for (const ancestor of [".local-state", "test-results", "playwright-report"])
  test(
    `${ancestor} ancestor: a nested Vite root refreshes source while ignoring its own validation artifacts`,
    { timeout: 20000 },
    async () => {
      const parent = join(repository, ".local-state/vite-watch", ancestor);
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, "project-"));
      const source = join(root, "main.js");
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/main.js"></script>',
      );
      await writeFile(source, 'export const value = "before";');
      const server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: { host: "127.0.0.1", port: 0, strictPort: false },
      });
      try {
        await server.listen();
        // HTTP readiness does not establish filesystem watcher readiness.
        const watchDeadline = Date.now() + 5000;
        while (!server.watcher.getWatched()[root]?.includes("main.js")) {
          assert.ok(
            Date.now() < watchDeadline,
            "fixture source must be watched before it is served or changed",
          );
          await new Promise((accept) => setTimeout(accept, 10));
        }
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        const module = () =>
          fetch(`${origin}/main.js`).then((response) => response.text());
        assert.match(await module(), /"before"/);
        const changed = new Promise((accept, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("source change was not observed")),
            5000,
          );
          server.watcher.on("change", function onChange(path) {
            if (path !== source) return;
            clearTimeout(timeout);
            server.watcher.off("change", onChange);
            accept();
          });
        });
        const updated = new Promise((accept, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("source update was not announced")),
            5000,
          );
          const send = server.ws.send;
          server.ws.send = (...args) => {
            const result = send.apply(server.ws, args);
            if (["full-reload", "update"].includes(args[0]?.type)) {
              clearTimeout(timeout);
              server.ws.send = send;
              accept();
            }
            return result;
          };
        });
        await writeFile(source, 'export const value = "after";');
        await Promise.all([changed, updated]);
        assert.match(
          await module(),
          /"after"/,
          "the already-transformed module must be invalidated",
        );

        const artifactEvents = [];
        const messages = [];
        server.watcher.on("all", (event, path) =>
          artifactEvents.push([event, path]),
        );
        const originalSend = server.ws.send;
        server.ws.send = (...args) => {
          messages.push(args);
          return originalSend.apply(server.ws, args);
        };
        for (const directory of [
          ".local-state",
          "test-results",
          "playwright-report",
          ".git",
          "node_modules",
          "node_modules/.vite",
          "dist",
          "src/.local-state",
          "src/test-results",
          "src/playwright-report",
        ]) {
          await mkdir(join(root, directory), { recursive: true });
          await writeFile(join(root, directory, "evidence.json"), "{}");
          await writeFile(
            join(root, directory, "evidence.json"),
            '{"updated":true}',
          );
        }
        // Bound the negative observation to multiple watcher polling intervals.
        await new Promise((accept) => setTimeout(accept, 500));
        assert.deepEqual(
          artifactEvents,
          [],
          "validation output must stay outside the watcher",
        );
        assert.deepEqual(
          messages,
          [],
          "validation output must not reload the page",
        );
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
