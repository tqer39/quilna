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

for (const [config, port] of [
  ["playwright.config.ts", 5197],
  ["playwright.search.config.ts", 5199],
]) {
  test(`${config} refuses an unrelated server before running any test`, async () => {
    const parent = join(root, ".local-state/browser-isolation");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "probe-"));
    const marker = join(directory, "test-executed");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Unrelated server: do not use for validation");
    });
    try {
      await new Promise((accept, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", accept);
      });
      // Retain the real server policy. Only replace the test payload and output
      // so this negative probe needs no browser and cannot erase useful reports.
      await writeFile(join(directory, "config.ts"), `
import original from ${JSON.stringify(join(root, config))};
export default { ...original, testDir: ${JSON.stringify(directory)},
  testMatch: "probe.spec.ts", reporter: "dot", projects: [{ name: "probe" }],
  outputDir: ${JSON.stringify(join(directory, "results"))} };
`);
      await writeFile(join(directory, "probe.spec.ts"), `
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("must not execute against an unrelated server", () => {
  writeFileSync(${JSON.stringify(marker)}, "executed");
});
`);
      await assert.rejects(
        exec(process.execPath, [
          join(root, "node_modules/@playwright/test/cli.js"),
          "test", "--config", join(directory, "config.ts"),
        ], { cwd: root, timeout: 20000, maxBuffer: 256 * 1024 }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stdout + error.stderr, /already used/);
          assert.match(error.stdout + error.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
          return true;
        },
      );
      assert.ok(requests > 0, "the existing server must be observed");
      assert.equal(existsSync(marker), false, "no test may use the existing server");
    } finally {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
