import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const designs = ["studio", "editorial", "focus"];
const groups = ["idle", "held-write", "continuous-write"];
const shaPattern = /^[a-f0-9]{40}$/;
const requireEvidence = (condition, message) => {
  if (!condition) throw Error(message);
};
const positive = (n) => Number.isFinite(n) && n > 0;
const count = (n) => Number.isSafeInteger(n) && n > 0;

// Inspect individual outcomes too: aggregate counters alone can conceal a
// truncated report, an expected failure, or a failed attempt followed by a pass.
export function inspectReport(report, expected, projects, label) {
  requireEvidence(count(expected), `${label}: invalid expected test count`);
  requireEvidence(
    Array.isArray(report.errors) &&
      report.errors.length === 0 &&
      report.stats?.expected === expected &&
      ["unexpected", "flaky", "skipped"].every((k) => report.stats[k] === 0),
    `${label}: missing, failed, flaky or skipped tests`,
  );
  const tests = [],
    ids = new Set();
  const visit = (suites) => {
    requireEvidence(Array.isArray(suites), `${label}: missing suites`);
    for (const suite of suites) {
      requireEvidence(Array.isArray(suite.specs), `${label}: missing specs`);
      for (const spec of suite.specs) {
        requireEvidence(
          spec.ok === true &&
            typeof spec.id === "string" &&
            spec.id &&
            Array.isArray(spec.tests) &&
            spec.tests.length > 0,
          `${label}: incomplete spec`,
        );
        for (const test of spec.tests) {
          const id = `${spec.id}:${test.projectName}`;
          const result = test.results?.[0];
          requireEvidence(
            !ids.has(id) &&
              projects.includes(test.projectName) &&
              test.expectedStatus === "passed" &&
              test.status === "expected" &&
              Array.isArray(test.results) &&
              test.results.length === 1 &&
              result?.status === "passed" &&
              result.retry === 0 &&
              Array.isArray(result.errors) &&
              result.errors.length === 0 &&
              !result.error,
            `${label}: duplicate, incomplete or unsuccessful test result`,
          );
          ids.add(id);
          tests.push({ project: test.projectName, title: spec.title });
        }
      }
      if (suite.suites !== undefined) visit(suite.suites);
    }
  };
  visit(report.suites);
  requireEvidence(
    tests.length === expected &&
      projects.every(
        (p) =>
          tests.filter((t) => t.project === p).length ===
          expected / projects.length,
      ),
    `${label}: test inventory does not match expected projects/count`,
  );
  return tests;
}

export function inspectMeasurements(report, label) {
  const tagged = report.tagged;
  requireEvidence(
    typeof tagged === "boolean" &&
      report.corpus === 100000 &&
      report.originalBytes === 2048 &&
      report.translationBytes === 2048 &&
      typeof report.browser === "string" &&
      report.browser.length > 0 &&
      typeof report.os === "string" &&
      report.os.length > 0 &&
      positive(report.seedMs) &&
      positive(report.loadAndPrepareMs) &&
      (tagged
        ? report.automaticTagsPerArticle === 8 &&
          report.manualTagsPerArticle === 12 &&
          report.manualArticleCount === 33333
        : [
            "automaticTagsPerArticle",
            "manualTagsPerArticle",
            "manualArticleCount",
          ].every((k) => report[k] === undefined)),
    `${label}: missing or changed corpus/environment/preparation`,
  );
  const cases = [
    ["ＳＱＬｉｔｅ 099999", "", "query"],
    ["対象集合", "", "query"],
    ["does-not-exist", "", "query"],
    ...(tagged
      ? [
          ["手動限定", "", "query"],
          ["対象集合", "tag:手動限定", "filter"],
          ["", "tag:技術・開発", "filter"],
          ["", "state:手動設定", "filter"],
        ]
      : []),
  ];
  const buckets = new Map(
    groups.flatMap((group) =>
      cases.map((c) => [JSON.stringify([group, ...c]), 0]),
    ),
  );
  requireEvidence(Array.isArray(report.samples), `${label}: missing samples`);
  for (const sample of report.samples) {
    const key = JSON.stringify([
      sample.group,
      sample.query,
      sample.filter ?? "",
      sample.action ?? "query",
    ]);
    requireEvidence(buckets.has(key), `${label}: unknown sample condition`);
    requireEvidence(
      Number.isFinite(sample.ms) && sample.ms >= 0 && sample.ms < 200,
      `${label}: a search sample is invalid or reaches 200 ms`,
    );
    buckets.set(key, buckets.get(key) + 1);
  }
  requireEvidence(
    [...buckets.values()].every((n) => n === 30),
    `${label}: every condition must contain 30 samples`,
  );
  const maxMs = Math.max(...report.samples.map((s) => s.ms));
  requireEvidence(
    report.maxMs === maxMs,
    `${label}: maximum does not match raw samples`,
  );
  requireEvidence(
    Array.isArray(report.writerCommits) &&
      report.writerCommits.length > 0 &&
      report.writerCommits.every(
        (n, i, all) =>
          Number.isSafeInteger(n) && n > 0 && (!i || n >= all[i - 1]),
      ),
    `${label}: missing successful concurrent writes`,
  );
  return {
    tagged,
    samples: report.samples.length,
    maxMs,
    prepareMs: report.loadAndPrepareMs,
    seedMs: report.seedMs,
    writerCommits: report.writerCommits.length,
    browser: report.browser,
    os: report.os,
  };
}

export async function verifyBrowserEvidence(
  root,
  { source, functional, runtime },
) {
  requireEvidence(
    shaPattern.test(source),
    "Expected checked-out SHA must be a full lowercase commit SHA",
  );
  requireEvidence(
    count(functional) && count(runtime),
    "Expected functional/runtime counts must be positive integers",
  );
  const hashes = {};
  const read = async (path) => {
    const file = join(root, path),
      info = await stat(file);
    requireEvidence(
      info.isFile() && info.size <= 64 * 1024 * 1024,
      `${path}: not a bounded regular file`,
    );
    const bytes = await readFile(file);
    requireEvidence(
      bytes.length <= 64 * 1024 * 1024,
      `${path}: file too large`,
    );
    hashes[path] = createHash("sha256").update(bytes).digest("hex");
    return bytes.toString("utf8");
  };
  requireEvidence(
    (await read("test-results/source-sha.txt")).trim() === source,
    "Artifact checked-out SHA does not match the expected source",
  );
  const reports = {};
  let searchTests;
  for (const [name, expected, projects] of [
    ["browser", functional, ["desktop", "mobile"]],
    ["reader-runtime", runtime, ["desktop", "mobile"]],
    ["search", 6, designs],
  ]) {
    const tests = inspectReport(
      JSON.parse(await read(`test-results/${name}.json`)),
      expected,
      projects,
      name,
    );
    reports[name] = tests.length;
    if (name === "search") searchTests = tests;
  }
  const measurementRoot = ".local-state/search-performance/results";
  const entries = await readdir(join(root, measurementRoot), {
    withFileTypes: true,
  });
  const search = [],
    seen = new Set();
  for (const entry of entries) {
    if (entry.name === ".last-run.json" && entry.isFile()) continue;
    requireEvidence(
      entry.isDirectory(),
      "Unexpected entry in search measurements",
    );
    const design = designs.find((d) => entry.name.endsWith(`-${d}`));
    requireEvidence(design, "Unknown search project directory");
    const path = `${measurementRoot}/${entry.name}/measurements.json`;
    const result = inspectMeasurements(JSON.parse(await read(path)), path);
    const key = `${design}:${result.tagged}`;
    const title = `100k originals and translations${result.tagged ? " with dense tags" : ""}: input to painted results, correctness and contention`;
    requireEvidence(
      !seen.has(key) &&
        searchTests.filter((t) => t.project === design && t.title === title)
          .length === 1,
      "Duplicate or unmatched search measurement condition",
    );
    seen.add(key);
    search.push({ design, ...result });
  }
  requireEvidence(
    seen.size === 6,
    "Missing design/baseline/dense-tag measurements",
  );
  search.sort(
    (a, b) =>
      a.design.localeCompare(b.design) || Number(a.tagged) - Number(b.tagged),
  );
  return { source, reports, search, hashes };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [root, source, functional, runtime, ...extra] = process.argv.slice(2);
    requireEvidence(
      root &&
        extra.length === 0 &&
        /^\d+$/.test(functional) &&
        /^\d+$/.test(runtime),
      "Usage: node scripts/verify-browser-evidence.mjs ARTIFACT_DIR CHECKED_OUT_SHA FUNCTIONAL_COUNT RUNTIME_COUNT",
    );
    const summary = await verifyBrowserEvidence(root, {
      source,
      functional: Number(functional),
      runtime: Number(runtime),
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`Browser evidence rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
