import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm, rename } from "node:fs/promises";
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
      const create = () =>
        createServer({
          root,
          configFile: join(repository, "vite.config.mjs"),
          server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
      let server = await create();
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
        let origin = `http://127.0.0.1:${server.httpServer.address().port}`;
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

        // The native backend may emit multiple notifications for one completed
        // editor save. Use a fresh server for the negative artifact phase so a
        // delayed source event cannot be mistaken for an artifact notification.
        await server.close();
        server = await create();
        await server.listen();
        origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        assert.match(await module(), /"after"/);
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

test(
  "a native backend registration delayed past a source edit cannot leave a stale transform",
  { timeout: 20000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "native-registration-"));
    const source = join(root, "main.js");
    await writeFile(source, 'export const value = "before";');
    let releaseNative,
      nativeEntered,
      usesDelayedBackend = false;
    const entered = new Promise((resolve) => {
      nativeEntered = resolve;
    });
    const timers = [];
    const server = await createServer({
      root,
      configFile: join(repository, "vite.config.mjs"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [
        {
          name: "hold-fsevents-registration",
          enforce: "pre",
          configureServer(server) {
            // Instrument the bundled Chokidar 3 backend only in this regression.
            // Other backends install their listener synchronously when a path is indexed.
            const handler = server.watcher._fsEventsHandler;
            if (!handler) return;
            usesDelayedBackend = true;
            const init = handler.initWatch.bind(handler);
            handler.initWatch = (...args) => {
              if (args[1] === root && !releaseNative) {
                releaseNative = () => init(...args);
                nativeEntered();
                return;
              }
              return init(...args);
            };
          },
        },
      ],
    });
    const event = (name, matches) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`${name} was not observed`)),
          5000,
        );
        timers.push(timer);
        server.watcher.on(name, function listener(...args) {
          if (!matches(...args)) return;
          clearTimeout(timer);
          server.watcher.off(name, listener);
          resolve();
        });
      });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const module = async () => {
        const response = await fetch(`${origin}/main.js`);
        assert.equal(response.status, 200);
        return response.text();
      };
      assert.match(await module(), /"before"/);
      if (usesDelayedBackend) await entered;
      const changed = event("change", (path) => path === source).then(
        () => null,
        (error) => error,
      );
      // Receive the actual OS notification before releasing registration. This
      // avoids an arbitrary sleep or relying on the FSEvents batching interval.
      const raw = usesDelayedBackend
        ? event("raw", (_event, path) => path === source).then(
            () => null,
            (error) => error,
          )
        : Promise.resolve(null);
      await writeFile(source, 'export const value = "after";');
      assert.equal(await raw, null);
      if (releaseNative) {
        releaseNative();
        releaseNative = null;
      }
      const changeError = await changed;
      assert.match(
        await module(),
        /"after"/,
        "an edit received before registration must not leave the served module stale",
      );
      assert.equal(changeError, null);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (releaseNative) releaseNative();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "source watching follows atomic editor replacement and the next save",
  { timeout: 20000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "atomic-editor-"));
    const source = join(root, "main.js");
    await writeFile(source, 'export const value = "before";');
    const server = await createServer({
      root,
      configFile: join(repository, "vite.config.mjs"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const module = async () => {
        const r = await fetch(`${origin}/main.js`);
        assert.equal(r.status, 200);
        return r.text();
      };
      assert.match(await module(), /"before"/);
      for (const replacement of [true, false]) {
        // Separate two completed editor saves beyond Chokidar's documented atomic
        // write window; this is not a watcher-startup readiness substitute.
        if (!replacement)
          await new Promise((resolve) => setTimeout(resolve, 200));
        const value = replacement ? "replacement" : "next-save";
        let timer;
        const changed = new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("editor save was not observed")),
            5000,
          );
          server.watcher.on("change", function listener(path) {
            if (path !== source) return;
            clearTimeout(timer);
            server.watcher.off("change", listener);
            resolve();
          });
        });
        const outcome = changed.then(
          () => null,
          (error) => error,
        );
        try {
          if (replacement) {
            await writeFile(
              `${source}.tmp`,
              `export const value = "${value}";`,
            );
            await rename(`${source}.tmp`, source);
          } else await writeFile(source, `export const value = "${value}";`);
          assert.equal(await outcome, null);
          assert.ok((await module()).includes(`"${value}"`));
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
