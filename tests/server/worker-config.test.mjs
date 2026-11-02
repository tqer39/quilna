import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectWorkerConfig,
  checkWorkerConfigs,
} from "../../scripts/check-worker-config.mjs";

const safe = () => ({
  compatibility_flags: ["global_fetch_strictly_public"],
  vars: { PRIVATE_DEV: "true" },
  assets: { run_worker_first: true },
  preview_urls: false,
});
test("pre-install security policy runs in a checkout without node_modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quilna-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "scripts/check-security.mjs",
    "scripts/check-worker-config.mjs",
    "package.json",
    "package-lock.json",
    ".npmrc",
    "mise.toml",
    "renovate.json5",
    "harness/go.mod",
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
  }
  const output = execFileSync(
    process.execPath,
    ["scripts/check-security.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  assert.match(output, /Security policy checks passed/);
});
test("public fetch cannot silently fall back to private origin routing or unauthenticated assets", () => {
  assert.deepEqual(inspectWorkerConfig(safe()), []);
  for (const mutate of [
    (v) => {
      delete v.compatibility_flags;
    },
    (v) => {
      v.compatibility_flags = ["global_fetch_private_origin"];
    },
    (v) => {
      v.compatibility_flags.push("global_fetch_private_origin");
    },
    (v) => {
      v.env = { production: { compatibility_flags: [] } };
    },
    (v) => {
      v.assets.run_worker_first = ["/api/*"];
    },
    (v) => {
      v.preview_urls = true;
    },
    (v) => {
      delete v.vars.PRIVATE_DEV;
    },
    (v) => {
      v.env = { production: { name: "quilna-private" } };
    },
  ]) {
    const value = safe();
    mutate(value);
    assert.ok(
      inspectWorkerConfig(value, { ownerOnly: true }).length,
      String(mutate),
    );
  }
  assert.deepEqual(
    inspectWorkerConfig({
      ...safe(),
      env: {
        production: { name: "quilna-private", vars: { PRIVATE_DEV: "true" } },
      },
    }),
    [],
  );
});

test("deployment checks include ignored owner config, parse JSONC, and never print configuration secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quilna-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    "wrangler.jsonc",
    "wrangler.dev.example.jsonc",
    "wrangler.cloud.example.jsonc",
  ]) {
    await writeFile(
      join(root, name),
      JSON.stringify(safe()).replace(/}$/, ", // comment\n}"),
    );
  }
  assert.deepEqual(checkWorkerConfigs(root), []);
  await writeFile(
    join(root, "wrangler.cloud.jsonc"),
    JSON.stringify({ vars: { secret: "do-not-print" } }),
  );
  let errors = checkWorkerConfigs(root).join(" ");
  assert.match(errors, /wrangler.cloud.jsonc.*public Internet/);
  assert.match(errors, /wrangler.cloud.jsonc.*requires PRIVATE_DEV/);
  assert.ok(!errors.includes("do-not-print"));
  await writeFile(
    join(root, "wrangler.cloud.jsonc"),
    '{"secret":"do-not-print",broken',
  );
  errors = checkWorkerConfigs(root).join(" ");
  assert.match(errors, /invalid configuration JSON/);
  assert.ok(!errors.includes("do-not-print"));
});
