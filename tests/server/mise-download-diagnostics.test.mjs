import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function probe(version, http, exit) {
  const dir = mkdtempSync(join(tmpdir(), "quilna-mise-diagnostic-"));
  try {
    const args = join(dir, "args");
    writeFileSync(
      join(dir, "curl"),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$DIAGNOSTIC_ARGS"\nprintf "HTTP %s; redirects 1; total 0.1s\\n" "$DIAGNOSTIC_HTTP"\nexit "$DIAGNOSTIC_EXIT"\n',
      { mode: 0o700 },
    );
    const result = spawnSync(
      "bash",
      ["scripts/diagnose-mise-download.sh", version],
      {
        encoding: "utf8",
        timeout: 2000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          DIAGNOSTIC_ARGS: args,
          DIAGNOSTIC_HTTP: http,
          DIAGNOSTIC_EXIT: String(exit),
        },
      },
    );
    return {
      ...result,
      args:
        result.status === 2
          ? []
          : readFileSync(args, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mise failure probe records success, HTTP failure and transport failure without installing a response", () => {
  for (const [http, exit] of [
    ["200", 0],
    ["404", 0],
    ["000", 28],
  ]) {
    const result = probe("2026.10.18", http, exit);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`HTTP ${http};`));
    assert.match(result.stdout, new RegExp(`Diagnostic curl exit: ${exit}`));
    assert.match(
      result.stdout,
      /later probe, not the HTTP status of the original/,
    );
    assert.match(result.stdout, /scanner did not run/);
    assert.deepEqual(result.args, [
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "--output",
      "/dev/null",
      "--write-out",
      "HTTP %{http_code}; redirects %{num_redirects}; total %{time_total}s\\n",
      "https://github.com/jdx/mise/releases/download/v2026.10.18/mise-v2026.10.18-linux-x64.tar.zst",
    ]);
  }
});

test("mise probe rejects a version that could change the fixed download target", () => {
  for (const version of ["", "latest", "2026.10.18/../../other", "$(whoami)"])
    assert.equal(probe(version, "200", 0).status, 2);
});

test("security workflow probes only a failed setup and keeps the scanner failure gate", () => {
  const yaml = readFileSync(".github/workflows/security.yml", "utf8");
  assert.match(yaml, /MISE_VERSION: 2026\.10\.18/);
  assert.match(yaml, /version: \$\{\{ env\.MISE_VERSION \}\}/);
  assert.match(
    yaml,
    /if: \$\{\{ failure\(\) && steps\.mise\.outcome == 'failure' \}\}/,
  );
  assert.match(
    yaml,
    /run: bash scripts\/diagnose-mise-download\.sh "\$MISE_VERSION"/,
  );
  assert.match(yaml, /- run: mise run security:go\s*$/);
  assert.doesNotMatch(yaml, /continue-on-error/);
});
