import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
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
      const nestedSource = join(root, "src/value.js");
      await writeFile(nestedSource, 'export const value = "nested-before";');
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

        const nestedModule = () =>
          fetch(`${origin}/src/value.js`).then((response) => response.text());
        assert.match(await nestedModule(), /"nested-before"/);
        const nestedChange = new Promise((accept, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("nested source change was not observed")),
            5000,
          );
          server.watcher.on("change", function onChange(path) {
            if (path !== nestedSource) return;
            clearTimeout(timeout);
            server.watcher.off("change", onChange);
            accept();
          });
        });
        await writeFile(nestedSource, 'export const value = "nested-after";');
        await nestedChange;
        assert.match(await nestedModule(), /"nested-after"/);

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

test(
  "a source requested while root registration is delayed cannot be cached before it is watched",
  { timeout: 20000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch/test-results");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "delayed-"));
    await mkdir(join(root, "src"));
    const source = join(root, "src/value.js");
    await writeFile(source, 'export const value = "before";');
    let release;
    let server;
    let transformedBeforeRegistration = false;
    const currentWatched = () =>
      server?.watcher.getWatched()[dirname(source)]?.includes("value.js");
    try {
      server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: { host: "127.0.0.1", port: 0, strictPort: false },
        plugins: [
          {
            name: "delay-root-registration",
            enforce: "pre",
            async configureServer(current) {
              // Let the original (glob-excluded) scan finish. A second `ready`
              // event cannot be used as a registration barrier after this point.
              await once(current.watcher, "ready");
              const add = current.watcher.add.bind(current.watcher);
              current.watcher.add = (paths, ...args) => {
                if (paths === root) {
                  release = () => {
                    release = () => {};
                    current.watcher.add = add;
                    add(paths, ...args);
                  };
                  return current.watcher;
                }
                return add(paths, ...args);
              };
            },
            async transform(_code, id) {
              if (id === source && !currentWatched()) {
                transformedBeforeRegistration = true;
                // The loader has already read "before". Edit while registration
                // is still held, so no change notification can invalidate it.
                await writeFile(source, 'export const value = "after";');
                release();
              }
            },
          },
        ],
      });
      await server.listen();
      assert.equal(
        typeof release,
        "function",
        "root re-registration must be intercepted",
      );
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const request = fetch(`${origin}/src/value.js`).then((response) =>
        response.text(),
      );
      // Hold the registration across an actual request. The test's assertion
      // depends on observed registration at transform time, not the delay length.
      const timer = setTimeout(() => release(), 150);
      try {
        assert.match(await request, /"before"/);
      } finally {
        clearTimeout(timer);
        release();
      }
      if (!transformedBeforeRegistration) {
        const changed = new Promise((accept, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("delayed source change was not observed")),
            5000,
          );
          server.watcher.on("change", function onChange(path) {
            if (path !== source) return;
            clearTimeout(timeout);
            server.watcher.off("change", onChange);
            accept();
          });
        });
        await writeFile(source, 'export const value = "after";');
        await changed;
      } else {
        const deadline = Date.now() + 5000;
        while (!currentWatched()) {
          assert.ok(
            Date.now() < deadline,
            "delayed registration did not complete",
          );
          await new Promise((accept) => setTimeout(accept, 10));
        }
      }
      assert.match(
        await fetch(`${origin}/src/value.js`).then((response) =>
          response.text(),
        ),
        /"after"/,
        "an edit made before registration must not leave a stale transform",
      );
      assert.equal(transformedBeforeRegistration, false);
    } finally {
      release?.();
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "explicitly disabled watching still serves source beneath a test-results ancestor",
  { timeout: 10000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch/test-results");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "disabled-"));
    let server;
    try {
      await writeFile(
        join(root, "main.js"),
        'export const value = "unwatched";',
      );
      server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: { watch: null },
      });
      assert.equal(server.config.server.watch, null);
      assert.match(
        (await server.transformRequest("/main.js")).code,
        /"unwatched"/,
      );
      assert.deepEqual(server.watcher.getWatched(), {});
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
