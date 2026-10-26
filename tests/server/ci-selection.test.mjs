import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectChecks,
  changedPaths,
  checkResults,
} from "../../scripts/ci-selection.mjs";

const full = { web: true, harness: true, apple: true };
test("documentation retains maintained checks without selecting platform builds", () => {
  assert.deepEqual(
    selectChecks([
      "README.ja.md",
      "docs/product-development.md",
      "apple/README.md",
      "harness/README.ja.md",
    ]),
    { web: false, harness: false, apple: false },
  );
  assert.deepEqual(selectChecks([]), {
    web: false,
    harness: false,
    apple: false,
  });
});
test("product changes select their platforms and mixed changes union them", () => {
  assert.deepEqual(
    selectChecks([
      "src/main.ts",
      "workers/http.mjs",
      "tests/browser/reader.spec.ts",
      "playwright.search.config.ts",
    ]),
    { web: true, harness: false, apple: false },
  );
  assert.deepEqual(selectChecks(["apple/Sources/TextbookCore/Library.swift"]), {
    web: false,
    harness: false,
    apple: true,
  });
  assert.deepEqual(selectChecks(["harness/task.go", "src/main.ts"]), {
    web: true,
    harness: true,
    apple: false,
  });
});
test("dependencies, runtimes, control files, unknown paths and manual runs select everything", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "mise.toml",
    "harness/go.mod",
    "harness/go.sum",
    "scripts/check-harness.sh",
    "scripts/ci-selection.mjs",
    "tests/server/ci-selection.test.mjs",
    ".github/workflows/ci.yml",
    ".agents/skills/independent-review/SKILL.md",
    "AGENTS.md",
    "contracts/example.json",
    "docs/example.fixture",
    "new-platform/code.rs",
  ])
    assert.deepEqual(selectChecks([path]), full, path);
  assert.deepEqual(selectChecks(["README.md"], true), full);
  assert.equal(changedPaths("workflow_dispatch", {}), null);
  assert.equal(changedPaths("unknown", {}), null);
  assert.equal(
    changedPaths("push", { before: "0".repeat(40), after: "a".repeat(40) }),
    null,
  );
});
test("real git comparison includes deletion, rename origins and newline filenames, excluding base-only changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "quilna-ci-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "branch.autoSetupMerge", "false");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src/removed.ts"), "original");
  git("add", ".");
  git("commit", "-qm", "base");
  const original = git("rev-parse", "HEAD");
  git("checkout", "-qb", "base-change");
  mkdirSync(join(root, "apple"));
  writeFileSync(join(root, "apple/unrelated.swift"), "base only");
  git("add", ".");
  git("commit", "-qm", "base advancement");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "pr", original);
  git("mv", "src/removed.ts", "docs/renamed.md");
  writeFileSync(join(root, "src/line\nbreak.ts"), "new");
  git("add", ".");
  git("commit", "-qm", "PR changes");
  const head = git("rev-parse", "HEAD");
  const paths = changedPaths(
    "pull_request",
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    root,
  );
  assert.deepEqual(paths.sort(), [
    "docs/renamed.md",
    "src/line\nbreak.ts",
    "src/removed.ts",
  ]);
  assert.deepEqual(selectChecks(paths), {
    web: true,
    harness: false,
    apple: false,
  });
  assert.deepEqual(
    changedPaths("push", { before: original, after: head }, root).sort(),
    paths,
  );
  assert.throws(() => changedPaths("pull_request", {}, root), /commit SHA/);
  assert.throws(() =>
    changedPaths("push", { before: "a".repeat(40), after: head }, root),
  );
});
const result = (harness = "false", apple = "false") => ({
  selection: { result: "success", outputs: { web: "false", harness, apple } },
  checks: { result: "success" },
  harness: { result: harness === "true" ? "success" : "skipped" },
  apple: { result: apple === "true" ? "success" : "skipped" },
});
test("required result accepts intentional skips but rejects missing, failed, cancelled or wrongly skipped work", () => {
  assert.deepEqual(checkResults(result()), []);
  assert.deepEqual(checkResults(result("true", "true")), []);
  for (const job of ["selection", "checks", "harness", "apple"])
    for (const state of ["failure", "cancelled", "skipped", undefined]) {
      const needs = result("true", "true");
      needs[job].result = state;
      assert.ok(checkResults(needs).length > 0, `${job}: ${state}`);
    }
  for (const output of ["web", "harness", "apple"]) {
    const needs = result();
    delete needs.selection.outputs[output];
    assert.ok(checkResults(needs).length > 0);
  }
  assert.ok(checkResults({}).length > 0);
  const unexpected = result();
  unexpected.harness.result = "success";
  assert.ok(checkResults(unexpected).length > 0);
});

test("the selected web job retains functional and 200ms search gates plus failure evidence", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const checks = workflow.slice(
    workflow.indexOf("  checks:\n"),
    workflow.indexOf("  harness:\n"),
  );
  // These reviewed workflows use explicit block-style steps (also checked by actionlint).
  const steps = checks.split(/(?=^ {6}- )/m).slice(1);
  for (const command of [
    "npm run test:browser",
    "npm run test:search-performance",
  ]) {
    const matching = steps.filter((step) =>
      step.split("\n").some((line) => line.trim() === `run: ${command}`),
    );
    assert.equal(matching.length, 1, `required web gate: ${command}`);
    assert.match(matching[0], /- if: needs\.selection\.outputs\.web == 'true'/);
    assert.doesNotMatch(matching[0], /continue-on-error:/);
  }
  const source = steps.find((step) => /id: browser-source/.test(step));
  assert.ok(source, "record the source before starting browser validation");
  assert.match(source, /if: needs\.selection\.outputs\.web == 'true'/);
  assert.match(source, /git rev-parse HEAD > test-results\/source-sha\.txt/);
  const evidence = steps.find((step) =>
    /uses: actions\/upload-artifact@/.test(step),
  );
  assert.ok(evidence, "retain failures as well as passing measurements");
  assert.equal(
    evidence
      .split("\n")
      .find((line) => line.trim().startsWith("if:"))
      ?.trim(),
    "if: ${{ !cancelled() && needs.selection.outputs.web == 'true' && steps.browser-source.outcome == 'success' }}",
  );
  assert.match(evidence, /test-results\//);
  assert.match(
    evidence,
    /\.local-state\/search-performance\/results\/\*\*\/measurements\.json/,
  );
  assert.match(evidence, /include-hidden-files: true/);
  assert.match(evidence, /if-no-files-found: error/);
});
