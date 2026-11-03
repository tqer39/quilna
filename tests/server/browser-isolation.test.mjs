import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

// Keep the production startup policy; isolate only the fixture's TCP endpoint.
function isolatedConfig(config, defaultPort, port) {
  return `
import original from ${JSON.stringify(join(root, config))};
if (!original.webServer.command.includes(" ${defaultPort}") ||
    !original.webServer.wait.stdout.source.includes("${defaultPort}")) {
  throw new Error("Unexpected production server policy");
}
const configuration = { ...original,
  use: { ...original.use, baseURL: "http://127.0.0.1:${port}" },
  webServer: { ...original.webServer,
    command: original.webServer.command.replace(" ${defaultPort}", " ${port}"),
    wait: { ...original.webServer.wait, stdout: new RegExp(
      original.webServer.wait.stdout.source.replaceAll("${defaultPort}", "${port}"),
      original.webServer.wait.stdout.flags) } } };
`;
}

for (const [config, defaultPort] of [
  ["playwright.config.ts", 5197],
  ["playwright.search.config.ts", 5199],
]) {
  test(`${config} runs only after its own Quilna server is ready`, async () => {
    const port = await availablePort();
    const parent = join(root, ".local-state/browser-startup-success");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "probe-"));
    const marker = join(directory, "test-executed");
    try {
      await writeFile(
        join(directory, "config.ts"),
        `
${isolatedConfig(config, defaultPort, port)}
export default { ...configuration, testDir: ${JSON.stringify(directory)},
  testMatch: "probe.spec.ts", reporter: "dot", projects: [{ name: "probe" }],
  outputDir: ${JSON.stringify(join(directory, "results"))},
  webServer: { ...configuration.webServer, cwd: ${JSON.stringify(root)} } };
`,
      );
      await writeFile(
        join(directory, "probe.spec.ts"),
        `
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("the ready server serves Quilna", async () => {
  const response = await fetch("http://127.0.0.1:${port}");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('/src/app.ts');
  expect(html).toContain('Quilna');
  writeFileSync(${JSON.stringify(marker)}, "executed");
});
`,
      );
      await exec(
        process.execPath,
        [
          join(root, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          join(directory, "config.ts"),
        ],
        {
          cwd: root,
          timeout: 15000,
          maxBuffer: 256 * 1024,
        },
      );
      assert.equal(existsSync(marker), true);
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}`),
        "its own server must stop after the run",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const [config, defaultPort] of [
  ["playwright.config.ts", 5197],
  ["playwright.search.config.ts", 5199],
]) {
  test(`${config} refuses an unrelated server before running any test`, async () => {
    const parent = join(root, ".local-state/browser-isolation");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "probe-"));
    const marker = join(directory, "test-executed");
    let requests = 0;
    let port;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Unrelated server: do not use for validation");
    });
    try {
      await new Promise((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", accept);
      });
      port = server.address().port;
      // Retain the real server policy. Only replace the test payload and output
      // so this negative probe needs no browser and cannot erase useful reports.
      await writeFile(
        join(directory, "config.ts"),
        `
${isolatedConfig(config, defaultPort, port)}
export default { ...configuration, testDir: ${JSON.stringify(directory)},
  testMatch: "probe.spec.ts", reporter: "dot", projects: [{ name: "probe" }],
  outputDir: ${JSON.stringify(join(directory, "results"))},
  webServer: { ...configuration.webServer, cwd: ${JSON.stringify(root)} } };
`,
      );
      await writeFile(
        join(directory, "probe.spec.ts"),
        `
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("must not execute against an unrelated server", () => {
  writeFileSync(${JSON.stringify(marker)}, "executed");
});
`,
      );
      await assert.rejects(
        exec(
          process.execPath,
          [
            join(root, "node_modules/@playwright/test/cli.js"),
            "test",
            "--config",
            join(directory, "config.ts"),
          ],
          { cwd: root, timeout: 20000, maxBuffer: 256 * 1024 },
        ),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stdout + error.stderr, /already in use/);
          assert.match(error.stdout + error.stderr, new RegExp(`Port ${port}`));
          return true;
        },
      );
      assert.equal(
        existsSync(marker),
        false,
        "no test may use the existing server",
      );
      assert.equal(
        requests,
        0,
        "readiness must not probe the unrelated HTTP server",
      );
      assert.match(
        await fetch(`http://127.0.0.1:${port}`).then((response) =>
          response.text(),
        ),
        /Unrelated server/,
        "the existing server must remain running",
      );
    } finally {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const [config, defaultPort] of [
  ["playwright.config.ts", 5197],
  ["playwright.search.config.ts", 5199],
]) {
  test(
    `${config} refuses a port claimed after the startup probe`,
    { timeout: 20000 },
    async () => {
      const port = await availablePort();
      const parent = join(root, ".local-state/browser-startup-race");
      await mkdir(parent, { recursive: true });
      const directory = await mkdtemp(join(parent, "probe-"));
      const started = join(directory, "command-started");
      const ready = join(directory, "unrelated-ready");
      const marker = join(directory, "test-executed");
      const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          "<!doctype html><title>Unrelated app with SPA fallback</title>",
        );
      });
      let completion;
      try {
        await writeFile(
          join(directory, "launch.mjs"),
          `
import { writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(started)}, "started");
while (!existsSync(${JSON.stringify(ready)})) await new Promise(r => setTimeout(r, 10));
// The unrelated app is ready before the actual dev server attempts its bind.
await new Promise(r => setTimeout(r, 1000));
const child = spawn(process.env.QUILNA_PROBE_COMMAND, { shell: true, stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
`,
        );
        await writeFile(
          join(directory, "config.ts"),
          `
${isolatedConfig(config, defaultPort, port)}
export default { ...configuration, testDir: ${JSON.stringify(directory)},
  testMatch: "probe.spec.ts", reporter: "dot", projects: [{ name: "probe" }],
  outputDir: ${JSON.stringify(join(directory, "results"))},
  webServer: { ...configuration.webServer, cwd: ${JSON.stringify(root)},
    command: ${JSON.stringify(`node "${join(directory, "launch.mjs")}"`)},
    env: { QUILNA_PROBE_COMMAND: configuration.webServer.command } } };
`,
        );
        await writeFile(
          join(directory, "probe.spec.ts"),
          `
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("must not run against the unrelated app", () => writeFileSync(${JSON.stringify(marker)}, "executed"));
`,
        );
        // Capture rejection immediately; the port is deliberately claimed only
        // after Playwright has started its command, past the initial availability check.
        completion = exec(
          process.execPath,
          [
            join(root, "node_modules/@playwright/test/cli.js"),
            "test",
            "--config",
            join(directory, "config.ts"),
          ],
          {
            cwd: root,
            timeout: 15000,
            maxBuffer: 256 * 1024,
          },
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const deadline = Date.now() + 7000;
        while (!existsSync(started) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        assert.ok(
          existsSync(started),
          "the command must have started after the initial probe",
        );
        await new Promise((accept, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", accept);
        });
        await writeFile(ready, "ready");
        const { error } = await completion;
        assert.ok(
          error,
          "the test runner must reject startup, not run against the unrelated app",
        );
        assert.equal(error.code, 1);
        assert.match(error.stdout + error.stderr, /already in use/);
        assert.equal(existsSync(marker), false, "no test body may run");
        assert.match(
          await fetch(`http://127.0.0.1:${port}/any-path`).then((r) =>
            r.text(),
          ),
          /Unrelated app/,
          "the unrelated server must remain running",
        );
      } finally {
        if (completion) await completion;
        server.closeAllConnections();
        await new Promise((accept) => server.close(accept));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
