import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectPolicy,
  inspectRenovate,
  safeNode,
} from "../../scripts/check-security.mjs";

const workflow = `permissions:\n  contents: read\njobs:\n  check:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)} # v7\n`;
const valid = () => ({
  npmrc:
    "ignore-scripts=true\nengine-strict=true\nstrict-ssl=true\nregistry=https://registry.npmjs.org/\n",
  lock: {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/example": {
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: "sha512-YWJjZA==",
      },
    },
  },
  workflows: { "ci.yml": workflow },
});

test("security minimums reject affected and unreviewed Node releases", () => {
  for (const version of [
    "22.23.3",
    "24.21.0",
    "24.22.0",
    "26.8.2",
    "26.12.0",
    "26.12.1-rc.1",
    "27.0.0",
  ])
    assert.equal(safeNode(version), false, version);
  for (const version of ["22.23.4", "24.22.1", "26.12.1", "26.12.2", "26.13.0"])
    assert.equal(safeNode(version), true, version);
});

test("source, integrity, TLS and Action regressions are rejected", () => {
  assert.deepEqual(inspectPolicy(valid()), []);
  const mutations = [
    (p) => {
      p.npmrc = p.npmrc.replace("ignore-scripts=true", "ignore-scripts=false");
    },
    (p) => {
      p.environment = { NPM_CONFIG_IGNORE_SCRIPTS: "false" };
    },
    (p) => {
      p.environment = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
    },
    (p) => {
      p.environment = { GOSUMDB: "off" };
    },
    (p) => {
      p.lock.packages["node_modules/example"].resolved =
        "https://registry.npmjs.org.evil.invalid/example.tgz";
    },
    (p) => {
      delete p.lock.packages["node_modules/example"].integrity;
    },
    (p) => {
      p.workflows["ci.yml"] = workflow.replace("a".repeat(40), "v7");
    },
    (p) => {
      p.workflows["ci.yml"] += "on: [pull_request_target]\n";
    },
    (p) => {
      p.workflows["ci.yml"] += "    permissions:\n      contents: write\n";
    },
    (p) => {
      p.workflows["ci.yml"] += "      - {uses: 'actions/checkout@v7'}\n";
    },
  ];
  for (const mutate of mutations) {
    const policy = valid();
    mutate(policy);
    assert.ok(inspectPolicy(policy).length > 0, String(mutate));
  }
});

test("Renovate cannot silently restore automatic merges or delay vulnerability fixes", async () => {
  const baseline = JSON.parse(
    await readFile(new URL("../../renovate.json5", import.meta.url), "utf8"),
  );
  assert.deepEqual(inspectRenovate(baseline), []);
  for (const mutate of [
    (p) => {
      p.automerge = true;
    },
    (p) => {
      p.packageRules = [];
    },
    (p) => {
      p.ignoreScripts = false;
    },
    (p) => {
      p.vulnerabilityAlerts.minimumReleaseAge = "14 days";
    },
    (p) => {
      p.vulnerabilityAlerts.platformAutomerge = true;
    },
  ]) {
    const policy = structuredClone(baseline);
    mutate(policy);
    assert.ok(inspectRenovate(policy).length > 0);
  }
});

test("ordinary npm ci suppresses install hooks but explicit npm scripts still run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "textbook-install-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run this regression through npm test");
  const options = {
    cwd: dir,
    env: {
      PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      HOME: dir,
      USERPROFILE: dir,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      npm_config_userconfig: join(dir, "user.npmrc"),
      npm_config_globalconfig: join(dir, "global.npmrc"),
    },
    stdio: "pipe",
  };
  await writeFile(join(dir, "user.npmrc"), "");
  await writeFile(join(dir, "global.npmrc"), "");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "safe-policy-fixture",
      version: "1.0.0",
      scripts: {
        install: "node marker.cjs install-marker",
        verify: "node marker.cjs explicit-marker",
      },
    }),
  );
  await writeFile(
    join(dir, "marker.cjs"),
    "require('node:fs').writeFileSync(process.argv[2], 'synthetic fixture only');\n",
  );
  const run = (...args) =>
    execFileSync(
      process.execPath,
      [npm, ...args, "--offline", "--audit=false", "--fund=false"],
      options,
    );
  run("install", "--package-lock-only", "--ignore-scripts");
  run("ci");
  await access(join(dir, "install-marker"));
  await rm(join(dir, "install-marker"));
  await writeFile(
    join(dir, ".npmrc"),
    await readFile(new URL("../../.npmrc", import.meta.url)),
  );
  run("ci");
  await assert.rejects(access(join(dir, "install-marker")), { code: "ENOENT" });
  run("run", "verify");
  await access(join(dir, "explicit-marker"));
});
