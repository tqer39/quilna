import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { writeFileSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  rename,
  utimes,
  stat,
  chmod,
  open,
} from "node:fs/promises";
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

for (const awaitWriteFinish of [
  false,
  { stabilityThreshold: 100, pollInterval: 10 },
])
  test(
    `a real raw source notification refreshes cached query variants with coalesced native changes (awaitWriteFinish=${!!awaitWriteFinish})`,
    { timeout: 20000 },
    async () => {
      const parent = join(repository, ".local-state/vite-watch");
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, "coalesced-source-")),
        source = join(root, "main.js"),
        fixed = 1700000000;
      await writeFile(source, 'export const value = "before";');
      await utimes(source, fixed, fixed);
      let releaseParent, edited, suppressed, rawReceived, captured;
      let holdRaw = false;
      const queuedRaw = [];
      let releaseRaw = () => {};
      let waitedForWriteFinish = false;
      const parentGate = new Promise((resolve) => {
          releaseParent = resolve;
        }),
        editDone = new Promise((resolve) => {
          edited = resolve;
        }),
        nativeSuppressed = new Promise((resolve) => {
          suppressed = resolve;
        }),
        rawCaptured = new Promise((resolve) => {
          captured = resolve;
        }),
        actualRaw = new Promise((resolve) => {
          rawReceived = resolve;
        });
      let armed = false,
        holdWatch = false;
      const server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          watch: { awaitWriteFinish },
        },
        plugins: [
          {
            name: "hold-native-source-coalescing",
            enforce: "pre",
            configureServer(server) {
              const watcher = server.watcher,
                handler = watcher._nodeFsHandler;
              assert.ok(
                handler,
                "the configured Node filesystem backend must be active",
              );
              const finish = watcher._awaitWriteFinish.bind(watcher);
              watcher._awaitWriteFinish = (...args) => {
                if (args[0] === source) waitedForWriteFinish = true;
                return finish(...args);
              };
              const emitRaw = watcher._emitRaw.bind(watcher);
              watcher._emitRaw = (...args) => {
                if (holdRaw) {
                  queuedRaw.push(args);
                  if (holdWatch && args[2]?.watchedPath === source) captured();
                  return;
                }
                return emitRaw(...args);
              };
              releaseRaw = () => {
                holdRaw = false;
                for (const args of queuedRaw.splice(0)) emitRaw(...args);
              };
              const read = handler._handleRead.bind(handler);
              handler._handleRead = async (...args) => {
                const result = await read(...args);
                if (args[0] === root && args[1]) await parentGate;
                return result;
              };
              const throttle = watcher._throttle.bind(watcher);
              watcher._throttle = (action, path, timeout) => {
                // Chokidarの5ms抑制と同じ分岐を固定し、OS配送の速さに検査を依存させない。
                if (action === "watch" && path === source && holdWatch) {
                  suppressed();
                  return false;
                }
                return throttle(action, path, timeout);
              };
              const watch = handler._watchWithNodeFs.bind(handler);
              handler._watchWithNodeFs = (path, listener) =>
                watch(
                  path,
                  path === source
                    ? async (...args) => {
                        await listener(...args);
                        if (armed && !holdWatch) {
                          holdWatch = true;
                          writeFileSync(
                            source,
                            'export const value = "after";',
                          );
                          edited();
                        }
                      }
                    : listener,
                );
              watcher.on("raw", (_event, _path, details) => {
                if (holdWatch && details?.watchedPath === source) rawReceived();
              });
            },
          },
        ],
      });
      let timer;
      const allChanges = [];
      server.watcher.on("all", (event, path) => {
        if (event === "change" && path === source) allChanges.push(path);
      });
      try {
        await server.listen();
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`,
          module = async (suffix = "") => {
            const r = await fetch(`${origin}/main.js${suffix}`);
            assert.equal(r.status, 200);
            return r.text();
          };
        assert.match(await module(), /"before"/);
        const changed = new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
          server.watcher.on("change", (path) => {
            if (path === source && holdWatch) {
              clearTimeout(timer);
              resolve(true);
            }
          });
        });
        holdRaw = true;
        armed = true;
        // mtimeを保つ属性通知の処理直後に編集し、実際のOS通知が抑制される順序を作る。
        await utimes(source, fixed + 3600, fixed);
        await Promise.all([editDone, nativeSuppressed, rawCaptured]);
        // 別クエリの初回loadで、既存URLの古いキャッシュの比較基準を上書きしない。
        assert.match(await module("?fresh"), /"after"/);
        const ready = server.watcher._readyEmitted
          ? Promise.resolve()
          : once(server.watcher, "ready");
        releaseParent();
        await ready;
        assert.equal(server.watcher._readyEmitted, true);
        releaseRaw();
        await actualRaw;
        const receivedChange = await changed;
        assert.match(
          await module(),
          /"after"/,
          "a received OS notification must not leave cached source stale",
        );
        assert.equal(receivedChange, true);
        assert.equal(waitedForWriteFinish, !!awaitWriteFinish);
        // 安定した本文について、遅れて補う通知も含めて二重発行を観測する。
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(
          allChanges.length,
          1,
          "the recovered change must reach all subscribers once",
        );
      } finally {
        releaseRaw();
        releaseParent();
        clearTimeout(timer);
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

for (const awaitWriteFinish of [
  false,
  { stabilityThreshold: 100, pollInterval: 10 },
])
  test(
    `source watching follows atomic editor replacement and the next save (awaitWriteFinish=${!!awaitWriteFinish})`,
    { timeout: 20000 },
    async () => {
      const parent = join(repository, ".local-state/vite-watch");
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, "atomic-editor-"));
      const source = join(root, "main.js");
      await writeFile(source, 'export const value = "before";');
      const registrations = [];
      const server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          watch: { awaitWriteFinish },
        },
        plugins: [
          {
            name: "observe-atomic-registration",
            enforce: "pre",
            configureServer(current) {
              const handler = current.watcher._nodeFsHandler;
              const watch = handler._watchWithNodeFs.bind(handler);
              handler._watchWithNodeFs = (path, listener) => {
                let inode;
                try {
                  inode = statSync(path).ino;
                } catch {
                  // 観測の失敗で監視登録を妨げない。
                }
                registrations.push(["register", path, Date.now(), inode]);
                const close = watch(path, listener);
                return () => {
                  registrations.push(["close", path, Date.now()]);
                  return close?.();
                };
              };
              current.watcher.on("ready", () =>
                registrations.push(["ready", Date.now()]),
              );
              current.watcher.on("raw", (...args) =>
                registrations.push(["raw", ...args]),
              );
            },
          },
        ],
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
          const observed = [];
          const observe = (event, ...args) =>
            observed.push([
              event,
              ...args.map((arg) =>
                typeof arg === "string"
                  ? arg
                  : (arg?.watchedPath ?? arg?.mtimeMs),
              ),
            ]);
          const raw = (...args) => observe("raw", ...args);
          const change = (...args) => observe("change", ...args);
          server.watcher.on("raw", raw);
          server.watcher.on("change", change);
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
              const inode = (await stat(source)).ino;
              const deadline = Date.now() + 5000;
              while (
                process.platform !== "darwin" &&
                !registrations.some(
                  ([kind, path, , ino]) =>
                    kind === "register" && path === source && ino === inode,
                )
              ) {
                assert.ok(
                  Date.now() < deadline,
                  "an inode replacement must install a listener for the new file",
                );
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            } else await writeFile(source, `export const value = "${value}";`);
            assert.equal(
              await outcome,
              null,
              JSON.stringify({ replacement, observed, registrations }),
            );
            assert.ok((await module()).includes(`"${value}"`));
          } finally {
            clearTimeout(timer);
            server.watcher.off("raw", raw);
            server.watcher.off("change", change);
          }
        }
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

test(
  "metadata-only notifications do not reload and completed saves reach all subscribers",
  { timeout: 20000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "metadata-only-")),
      source = join(root, "main.js");
    await writeFile(source, 'export const value = "before";');
    // utimesの精度変換でmtimeまで変わることを避け、属性だけの通知を作る。
    await utimes(source, 1700000000, 1700000000);
    const server = await createServer({
      root,
      configFile: join(repository, "vite.config.mjs"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const module = () => fetch(`${origin}/main.js`).then((r) => r.text());
      assert.match(await module(), /"before"/);
      const changes = [],
        all = [],
        messages = [];
      server.watcher.on("change", (path) => {
        if (path === source) changes.push(path);
      });
      server.watcher.on("all", (event, path) => {
        if (path === source && event === "change") all.push(path);
      });
      const send = server.ws.send.bind(server.ws);
      server.ws.send = (...args) => {
        if (["update", "full-reload"].includes(args[0]?.type))
          messages.push(args[0]);
        return send(...args);
      };
      const raw = () =>
        new Promise((resolve) => {
          server.watcher.on("raw", function listener(_event, _path, details) {
            if (details?.watchedPath !== source) return;
            server.watcher.off("raw", listener);
            resolve();
          });
        });
      const info = await stat(source);
      let received = raw();
      await utimes(source, new Date(info.mtimeMs + 3600000), info.mtime);
      await received;
      received = raw();
      await chmod(source, 0o600);
      await received;
      // 負の観測だけに上限を設け、60msの補完確認と50msの抑制窓を越えて確認する。
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(changes, []);
      assert.deepEqual(all, []);
      assert.deepEqual(messages, []);
      const changed = once(server.watcher, "change");
      await writeFile(source, 'export const value = "after";');
      await changed;
      assert.match(await module(), /"after"/);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // truncate直後の通知に続く補完は、途中の本文をキャッシュに残さないために必要。
      assert.ok(changes.length >= 1);
      assert.equal(all.length, changes.length);
      assert.ok(messages.length >= 1);
      assert.match(await module(), /"after"/);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a cached truncated source is refreshed after the completed write even when native callbacks are coalesced",
  { timeout: 20000 },
  async () => {
    const parent = join(repository, ".local-state/vite-watch");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "partial-write-")),
      source = join(root, "main.js");
    await writeFile(source, 'export const value = "before";');
    const server = await createServer({
      root,
      configFile: join(repository, "vite.config.mjs"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    let handle, timer;
    const watcher = server.watcher,
      throttle = watcher._throttle.bind(watcher);
    try {
      await server.listen();
      if (!watcher._readyEmitted) await once(watcher, "ready");
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const module = () => fetch(`${origin}/main.js`).then((r) => r.text());
      assert.match(await module(), /"before"/);
      const changed = () =>
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("source change was not observed")),
            5000,
          );
          watcher.on("change", function listener(path) {
            if (path !== source) return;
            clearTimeout(timer);
            watcher.off("change", listener);
            resolve();
          });
        });
      const first = changed();
      handle = await open(source, "w");
      await first;
      assert.doesNotMatch(await module(), /"before"/);
      // 切り詰め後の通知で空の本文を読み込んだ後も、最後の内容の反映を間引かない。
      watcher._throttle = (action, path, ...args) =>
        action === "watch" && path === source
          ? false
          : throttle(action, path, ...args);
      const completed = changed();
      await handle.writeFile('export const value = "after";');
      await handle.close();
      handle = undefined;
      await completed;
      assert.match(await module(), /"after"/);
    } finally {
      watcher._throttle = throttle;
      clearTimeout(timer);
      await handle?.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const awaitWriteFinish of [
  false,
  { stabilityThreshold: 100, pollInterval: 10 },
])
  test(
    `atomic replacement keeps existing-source semantics and recovers after Chokidar stops notifying (awaitWriteFinish=${!!awaitWriteFinish})`,
    { timeout: 30000 },
    async (t) => {
      const parent = join(repository, ".local-state/vite-watch");
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, "rebind-gap-")),
        source = join(root, "main.js");
      await writeFile(source, 'export const value="before";');
      let armed = false,
        forcing = false,
        intercepted = false,
        suppressNative = false,
        parentArgs;
      let phase = "initial";
      let observationError;
      let cleanupError;
      const unexpectedAdds = [],
        timers = [];
      const owned = [];
      let ownCreated = () => {},
        ownChanged = () => {};
      const signal = (install, label) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error(label)), 5000);
          timers.push(timer);
          install((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
      const closed = (record) =>
        signal(
          (resolve) => record.closed.then(resolve),
          "owned watch did not close",
        );
      const created = () =>
        process.platform === "darwin"
          ? signal((resolve) => {
              ownCreated = resolve;
            }, "replacement watch was not created")
          : Promise.resolve();
      const ownEvent = () =>
        process.platform === "darwin"
          ? signal((resolve) => {
              ownChanged = resolve;
            }, "replacement watch did not receive an OS event")
          : Promise.resolve();
      const originalWatch = fs.watch;
      fs.watch = (file, ...args) => {
        if (
          file !== source ||
          args.length !== 1 ||
          typeof args[0] !== "function"
        )
          return originalWatch(file, ...args);
        const callback = args[0];
        let record;
        const handle = originalWatch(file, (...event) => {
          record.events++;
          callback(...event);
          ownChanged(record);
        });
        record = {
          handle,
          events: 0,
          closed: new Promise((resolve) => handle.once("close", resolve)),
        };
        owned.push(record);
        ownCreated(record);
        return handle;
      };
      syncBuiltinESMExports();
      t.after(() => {
        fs.watch = originalWatch;
        syncBuiltinESMExports();
      });
      const server = await createServer({
        root,
        configFile: join(repository, "vite.config.mjs"),
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          watch: { awaitWriteFinish },
        },
        plugins: [
          {
            name: "interleave-directory-scan-with-file-rebind",
            enforce: "pre",
            configureServer(server) {
              const watcher = server.watcher,
                handler = watcher._nodeFsHandler;
              assert.ok(handler, "the Node filesystem backend must be active");
              const read = handler._handleRead.bind(handler),
                add = handler._addToNodeFs.bind(handler),
                throttle = watcher._throttle.bind(watcher),
                watch = handler._watchWithNodeFs.bind(handler),
                raw = watcher._emitRaw.bind(watcher);
              handler._handleRead = (...args) => {
                if (args[0] === root && args[1]) parentArgs = args;
                return read(...args);
              };
              watcher._throttle = (action, path, ...args) =>
                forcing && action === "readdir" && path === root
                  ? { clear: () => false }
                  : throttle(action, path, ...args);
              handler._addToNodeFs = (path, initial, ...args) => {
                if (armed && !intercepted && path === source && initial) {
                  intercepted = true;
                  forcing = true;
                  return new Promise((resolve) => {
                    let timer;
                    const finish = () => {
                      clearTimeout(timer);
                      forcing = false;
                      watcher.off("add", listener);
                      Promise.resolve(add(path, initial, ...args)).then(
                        resolve,
                      );
                    };
                    const listener = (path) => {
                      if (path === source) finish();
                    };
                    watcher.on("add", listener);
                    timer = setTimeout(finish, 2000);
                    timers.push(timer);
                    assert.ok(
                      parentArgs,
                      "the initial directory scan must have been observed",
                    );
                    const scan = [...parentArgs];
                    scan[1] = false;
                    void read(...scan);
                  });
                }
                return add(path, initial, ...args);
              };
              // macOSで置換後の実体から通知が途切れる境界を固定する。
              handler._watchWithNodeFs = (path, listener) =>
                watch(path, (...args) => {
                  if (!suppressNative || ![root, source].includes(path))
                    return listener(...args);
                });
              watcher._emitRaw = (...args) => {
                if (
                  !suppressNative ||
                  ![root, source].includes(args[2]?.watchedPath)
                )
                  return raw(...args);
              };
              watcher.on("add", (path) => {
                if (armed && path === source) unexpectedAdds.push(path);
              });
            },
          },
        ],
      });
      const changed = (name = "change") =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error(`source update missing during ${phase}`)),
            5000,
          );
          timers.push(timer);
          server.watcher.on(name, function listener(path) {
            if (path !== source) return;
            clearTimeout(timer);
            server.watcher.off(name, listener);
            resolve();
          });
        });
      try {
        await server.listen();
        if (!server.watcher._readyEmitted) await once(server.watcher, "ready");
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        const module = () => fetch(`${origin}/main.js`).then((r) => r.text());
        assert.match(await module(), /"before"/);
        armed = true;
        phase = "first replacement";
        const firstOwned = created();
        const replacement = changed();
        await writeFile(`${source}.tmp`, 'export const value="replacement";');
        await rename(`${source}.tmp`, source);
        await replacement;
        const first = await firstOwned;
        assert.match(await module(), /"replacement"/);
        assert.deepEqual(
          unexpectedAdds,
          [],
          "an existing replaced source must not be announced as a new file",
        );
        suppressNative = process.platform === "darwin";
        for (const value of ["next-one", "next-two", "next-three"]) {
          phase = value;
          const observed = ownEvent(),
            next = changed();
          await writeFile(source, `export const value="${value}";`);
          await observed;
          await next;
          assert.ok((await module()).includes(`"${value}"`));
        }
        phase = "second replacement";
        const secondOwned = created(),
          secondChange = changed();
        await writeFile(
          `${source}.tmp`,
          'export const value="second-replacement";',
        );
        await rename(`${source}.tmp`, source);
        await secondChange;
        const second = await secondOwned;
        if (first) await closed(first);
        assert.match(await module(), /"second-replacement"/);
        suppressNative = false;
        phase = "unlink";
        const removed = changed("unlink");
        await rm(source);
        await removed;
        if (second) await closed(second);
        armed = false;
        const added = changed("add");
        await writeFile(source, 'export const value="recreated";');
        await added;
        assert.match(await module(), /"recreated"/);
        armed = true;
        phase = "final replacement";
        const finalOwned = created(),
          finalChange = changed();
        await writeFile(`${source}.tmp`, 'export const value="shutdown";');
        await rename(`${source}.tmp`, source);
        await finalChange;
        await finalOwned;
        assert.match(await module(), /"shutdown"/);
        assert.deepEqual(unexpectedAdds, []);
        if (process.platform === "darwin") {
          assert.ok(owned.length >= 3);
          await Promise.all(owned.slice(0, -1).map(closed));
        }
      } catch (error) {
        observationError = error;
      } finally {
        suppressNative = false;
        for (const timer of timers) clearTimeout(timer);
        let timer;
        try {
          await server.close();
          const closed = await Promise.race([
            Promise.all(owned.map((record) => record.closed)).then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 5000);
            }),
          ]);
          assert.equal(
            closed,
            true,
            "plugin shutdown must close its owned watches",
          );
        } catch (error) {
          cleanupError = error;
        } finally {
          clearTimeout(timer);
          for (const record of owned) record.handle.close();
          await rm(root, { recursive: true, force: true });
        }
      }
      if (observationError && cleanupError)
        throw new AggregateError(
          [observationError, cleanupError],
          "Source observation and watcher cleanup both failed",
        );
      if (observationError) throw observationError;
      if (cleanupError) throw cleanupError;
    },
  );

test(
  "macOS recovery still invalidates current source when an additional watch cannot be opened",
  { timeout: 20000, skip: process.platform !== "darwin" },
  async (t) => {
    const parent = join(repository, ".local-state/vite-watch");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "watch-exhaustion-")),
      source = join(root, "main.js");
    await writeFile(source, 'export const value="before";');
    let armed = false,
      attempts = 0;
    const originalWatch = fs.watch;
    fs.watch = (file, ...args) => {
      if (
        file === source &&
        args.length === 1 &&
        typeof args[0] === "function"
      ) {
        attempts++;
        throw Object.assign(Error("EMFILE: controlled watch exhaustion"), {
          code: "EMFILE",
        });
      }
      return originalWatch(file, ...args);
    };
    syncBuiltinESMExports();
    t.after(() => {
      fs.watch = originalWatch;
      syncBuiltinESMExports();
    });
    const server = await createServer({
      root,
      configFile: join(repository, "vite.config.mjs"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [
        {
          name: "suppress-normal-source-callbacks",
          enforce: "pre",
          configureServer(server) {
            const handler = server.watcher._nodeFsHandler,
              watch = handler._watchWithNodeFs.bind(handler);
            handler._watchWithNodeFs = (path, listener) =>
              watch(path, (...args) => {
                if (!armed || ![root, source].includes(path))
                  return listener(...args);
              });
          },
        },
      ],
    });
    const errors = [];
    server.config.logger.error = (message) => {
      errors.push(String(message));
    };
    let timer;
    try {
      await server.listen();
      if (!server.watcher._readyEmitted) await once(server.watcher, "ready");
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`,
        module = () => fetch(`${origin}/main.js`).then((r) => r.text());
      assert.match(await module(), /"before"/);
      armed = true;
      const changed = new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error("current source was left stale after watch exhaustion"),
            ),
          5000,
        );
        server.watcher.on("change", function listener(path) {
          if (path !== source) return;
          clearTimeout(timer);
          server.watcher.off("change", listener);
          resolve();
        });
      });
      await writeFile(`${source}.tmp`, 'export const value="after";');
      await rename(`${source}.tmp`, source);
      await changed;
      assert.match(await module(), /"after"/);
      assert.ok(attempts > 0);
      assert.ok(errors.some((error) => error.includes("EMFILE")));
    } finally {
      clearTimeout(timer);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
