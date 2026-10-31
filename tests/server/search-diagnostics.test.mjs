import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diagnosticSource } from "../../scripts/diagnose-search.mjs";

const benchmark = readFileSync(
  new URL("../performance/search.spec.ts", import.meta.url),
  "utf8",
);
test("diagnostic adapter refuses missing or ambiguous benchmark anchors", () => {
  const anchor = "                return performance.now() - start;";
  assert.throws(
    () => diagnosticSource(benchmark.replace(anchor, "return 0;")),
    /anchor changed/,
  );
  assert.throws(
    () => diagnosticSource(benchmark + "\n" + anchor),
    /anchor changed/,
  );
});
test("diagnostic copy preserves the workload and acceptance assertion while adding trace evidence", () => {
  const copy = diagnosticSource(benchmark);
  const workloadStart = benchmark.indexOf("      const seedStart");
  const workloadEnd = benchmark.indexOf("      for (const group of");
  assert.ok(copy.includes(benchmark.slice(workloadStart, workloadEnd)));
  const oracleStart = benchmark.indexOf("                const actual =");
  const oracleEnd = benchmark.indexOf(
    "                return performance.now() - start;",
  );
  assert.ok(copy.includes(benchmark.slice(oracleStart, oracleEnd)));
  const assertionsStart = benchmark.indexOf("      report.maxMs");
  const assertionsEnd = benchmark.indexOf("    } finally {");
  assert.ok(assertionsStart >= 0);
  assert.ok(copy.includes(benchmark.slice(assertionsStart, assertionsEnd)));
  assert.match(copy, /Tracing\.start/);
  assert.match(copy, /Tracing\.end/);
  assert.match(copy, /report\.diagnosticOnly = true/);
  // Instrumenting frames must retain both callbacks; stopping at the first
  // would silently shorten the maintained measurement boundary.
  assert.equal((copy.match(/requestAnimationFrame\(/g) ?? []).length, 2);
  assert.equal(
    readFileSync(
      new URL("../performance/search.spec.ts", import.meta.url),
      "utf8",
    ),
    benchmark,
  );
});
