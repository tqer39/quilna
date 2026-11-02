import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Miniflare's fetch rejects excessive encodings without crashing its process", () => {
  // One loopback response in an isolated process: an uncaught stream error must
  // fail this check rather than terminate the surrounding test runner.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { createServer } from "node:net";
    import { createRequire } from "node:module";
    import { setTimeout as delay } from "node:timers/promises";
    const require = createRequire(import.meta.resolve("miniflare"));
    const { fetch, Agent } = require("undici");
    const dispatcher = new Agent();
    const server = createServer(socket => {
      socket.once("data", () => socket.end([
        "HTTP/1.1 200 OK",
        "Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip",
        "Content-Length: 16",
        "Connection: close", "", ""
      ].join("\\r\\n")));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        fetch("http://127.0.0.1:" + server.address().port, { dispatcher }),
        error => /too many content-encodings/.test(error.cause?.message ?? "")
      );
      await delay(100);
      console.log("fetch rejected; process survived");
    } finally {
      await dispatcher.close();
      await new Promise(resolve => server.close(resolve));
    }
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /fetch rejected; process survived/);
});
