import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectReport,
  inspectMeasurements,
  verifyBrowserEvidence,
} from "../../scripts/verify-browser-evidence.mjs";

const source = "a".repeat(40);
const designs = ["studio", "editorial", "focus"];
const searchTitle = (tagged) =>
  `100k originals and translations${tagged ? " with dense tags" : ""}: input to painted results, correctness and contention`;
function report(projects, titles = ["fixture"]) {
  return {
    errors: [],
    stats: {
      expected: projects.length * titles.length,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: titles.map((title, i) => ({
              id: `case-${i}`,
              title,
              ok: true,
              tests: projects.map((projectName) => ({
                projectName,
                expectedStatus: "passed",
                status: "expected",
                results: [{ status: "passed", errors: [], retry: 0 }],
              })),
            })),
          },
        ],
      },
    ],
  };
}
function measurement(tagged) {
  const conditions = [
    { query: "ＳＱＬｉｔｅ 099999" },
    { query: "対象集合" },
    { query: "does-not-exist" },
    ...(tagged
      ? [
          { query: "手動限定" },
          { query: "対象集合", filter: "tag:手動限定", action: "filter" },
          { query: "", filter: "tag:技術・開発", action: "filter" },
          { query: "", filter: "state:手動設定", action: "filter" },
        ]
      : []),
  ];
  return {
    tagged,
    corpus: 100000,
    originalBytes: 2048,
    translationBytes: 2048,
    browser: "fixture",
    os: "fixture",
    seedMs: 1000,
    loadAndPrepareMs: 2500,
    ...(tagged
      ? {
          automaticTagsPerArticle: 8,
          manualTagsPerArticle: 12,
          manualArticleCount: 33333,
        }
      : {}),
    writerCommits: [100, 101],
    maxMs: 10,
    samples: ["idle", "held-write", "continuous-write"].flatMap((group) =>
      conditions.flatMap((c) =>
        Array.from({ length: 30 }, () => ({ group, ...c, ms: 10 })),
      ),
    ),
  };
}

test("report inspection checks actual outcomes instead of trusting green counters", () => {
  const valid = () => report(["desktop", "mobile"]);
  assert.equal(
    inspectReport(valid(), 2, ["desktop", "mobile"], "fixture").length,
    2,
  );
  const mutations = [
    (r) => {
      r.errors.push({ message: "teardown failed" });
    },
    (r) => {
      r.stats.skipped = 1;
    },
    (r) => {
      r.stats.expected = 1;
    },
    (r) => {
      r.suites = [];
    },
    (r) => {
      r.suites[0].suites[0].specs.push(r.suites[0].suites[0].specs[0]);
    },
    ...[
      (t) => {
        t.projectName = "desktop";
      },
      (t) => {
        t.expectedStatus = "failed";
      },
      (t) => {
        t.status = "flaky";
      },
      (t) => {
        t.results = [];
      },
      (t) => {
        t.results[0].status = "timedOut";
      },
      (t) => {
        t.results[0].retry = 1;
      },
      (t) => {
        t.results[0].errors.push({ message: "failed" });
      },
      (t) => {
        t.results.unshift({ status: "failed", errors: [], retry: 0 });
      },
    ].map((change) => (r) => change(r.suites[0].suites[0].specs[0].tests[1])),
  ];
  for (const mutate of mutations) {
    const r = valid();
    mutate(r);
    assert.throws(() => inspectReport(r, 2, ["desktop", "mobile"], "fixture"));
  }
});

test("search evidence requires all 30 samples for every workload and preserves the strict 200ms limit", () => {
  for (const tagged of [false, true]) {
    assert.equal(
      inspectMeasurements(measurement(tagged), "fixture").samples,
      tagged ? 630 : 270,
    );
    const mutations = [
      (r) => {
        r.samples[0].ms = 200;
        r.maxMs = 200;
      },
      (r) => {
        r.samples[0].ms = 203.5;
        r.maxMs = 203.5;
      },
      (r) => {
        r.samples[0].ms = null;
      },
      (r) => {
        r.samples[0].ms = -1;
      },
      (r) => {
        r.samples[0].ms = Infinity;
      },
      (r) => {
        r.maxMs = 1;
      },
      (r) => {
        r.samples.pop();
      },
      // Preserve the aggregate count, but remove one entire workload sample.
      (r) => {
        r.samples[30] = { ...r.samples[0] };
      },
      (r) => {
        r.samples[0].query = "easier-query";
      },
      (r) => {
        r.writerCommits = [];
      },
      (r) => {
        r.writerCommits = [100, 90];
      },
      (r) => {
        r.loadAndPrepareMs = undefined;
      },
      (r) => {
        r.corpus = 1000;
      },
      (r) => {
        r.translationBytes = 0;
      },
      (r) => {
        r.automaticTagsPerArticle = 0;
      },
    ];
    for (const mutate of mutations) {
      const r = measurement(tagged);
      mutate(r);
      assert.throws(() => inspectMeasurements(r, "fixture"));
    }
    const under = measurement(tagged);
    under.samples[0].ms = under.maxMs = 199.999;
    assert.equal(inspectMeasurements(under, "fixture").maxMs, 199.999);
  }
});

async function artifact(t) {
  const root = await mkdtemp(join(tmpdir(), "quilna-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    const file = join(root, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  await put("test-results/source-sha.txt", source + "\n");
  await put("test-results/browser.json", report(["desktop", "mobile"]));
  await put("test-results/reader-runtime.json", report(["desktop", "mobile"]));
  await put(
    "test-results/search.json",
    report(designs, [searchTitle(false), searchTitle(true)]),
  );
  for (const d of designs)
    for (const tagged of [false, true])
      await put(
        `.local-state/search-performance/results/case-${tagged}-${d}/measurements.json`,
        measurement(tagged),
      );
  return { root, put };
}
const expected = { source, functional: 2, runtime: 2 };

test("artifact verifier rejects mismatched source, incomplete inventories and duplicate measurements", async (t) => {
  const { root, put } = await artifact(t);
  const result = await verifyBrowserEvidence(root, expected);
  assert.equal(result.search.length, 6);
  assert.equal(
    result.search.reduce((n, r) => n + r.samples, 0),
    2700,
  );
  assert.equal(Object.keys(result.hashes).length, 10);
  await assert.rejects(
    verifyBrowserEvidence(root, { ...expected, source: "b".repeat(40) }),
    /SHA/,
  );
  await assert.rejects(
    verifyBrowserEvidence(root, { ...expected, functional: 4 }),
    /tests/,
  );
  await assert.rejects(
    verifyBrowserEvidence(root, { ...expected, runtime: 0 }),
    /counts/,
  );
  await put(
    ".local-state/search-performance/results/duplicate-studio/measurements.json",
    measurement(false),
  );
  await assert.rejects(verifyBrowserEvidence(root, expected), /Duplicate/);
  await rm(
    join(root, ".local-state/search-performance/results/duplicate-studio"),
    { recursive: true },
  );
  await rm(
    join(root, ".local-state/search-performance/results/case-false-focus"),
    { recursive: true },
  );
  await assert.rejects(verifyBrowserEvidence(root, expected), /Missing/);
});

test("CLI emits a summary only on success and does not modify evidence", async (t) => {
  const { root, put } = await artifact(t);
  const script = resolve("scripts/verify-browser-evidence.mjs");
  const run = (...args) =>
    spawnSync(process.execPath, [script, root, ...args], { encoding: "utf8" });
  const before = await readFile(
    join(root, "test-results/browser.json"),
    "utf8",
  );
  const ok = run(source, "2", "2");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).source, source);
  assert.equal(
    await readFile(join(root, "test-results/browser.json"), "utf8"),
    before,
  );
  for (const args of [
    [source, "2", "2", "extra"],
    [source, "0", "2"],
    ["bad", "2", "2"],
  ]) {
    const failed = run(...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
  }
  await put("test-results/reader-runtime.json", "{truncated");
  const failed = run(source, "2", "2");
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  await rm(join(root, "test-results/reader-runtime.json"));
  assert.equal(run(source, "2", "2").status, 1);
});
