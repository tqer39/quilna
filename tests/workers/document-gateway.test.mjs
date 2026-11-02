import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const source = (
  await build({
    entryPoints: ["workers/document-gateway.mjs"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  })
).outputFiles[0].text;
const { DocumentGateway } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("source quota is atomic across simultaneous reservations, survives reconstruction and never resets corrupt state", async () => {
  const data = new Map();
  let tail = Promise.resolve();
  const storage = {
    transaction: (update) => {
      const work = tail.then(() =>
        update({
          get: async (k) => data.get(k),
          put: async (k, v) => {
            data.set(k, v);
          },
        }),
      );
      tail = work.catch(() => {});
      return work;
    },
  };
  let gateway = new DocumentGateway(storage, {});
  const same = "https://publisher.example.org/same";
  await Promise.all(
    Array.from({ length: 8 }, () => gateway.reserve("owner", same, "private")),
  );
  assert.equal(data.get("documents:source-count"), 1);
  const attempts = await Promise.allSettled(
    Array.from({ length: 1000 }, (_, i) =>
      gateway.reserve("owner", `https://publisher.example.org/${i}`, "private"),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 999);
  assert.equal(
    attempts.filter((r) => r.status === "rejected")[0].reason.message,
    "document-capacity",
  );
  assert.equal(data.get("documents:source-count"), 1000);
  gateway = new DocumentGateway(storage, {});
  await gateway.reserve("owner", same, "private");
  await assert.rejects(
    gateway.reserve("owner", "https://publisher.example.org/new", "private"),
    /document-capacity/,
  );
  data.set("documents:source-count", null);
  await assert.rejects(
    gateway.reserve("owner", same, "private"),
    /document-invalid/,
  );
  assert.equal(data.get("documents:source-count"), null);
});
