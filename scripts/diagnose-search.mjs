import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Generate an instrumented COPY. The maintained gate remains byte-for-byte intact.
export function diagnosticSource(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw Error(
        "Search diagnostic anchor changed; review the adapter before running it.",
      );
    source = source.replace(before, after);
  };
  replace(
    "    try {\n      await page.goto",
    "    let cdp;\n    let tracing = false;\n    try {\n      await page.goto",
  );
  replace(
    '      for (const group of ["idle", "held-write", "continuous-write"]) {',
    `      cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.QUILNA_DIAGNOSTIC_CPU_RATE) });
      await cdp.send("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReturnAsStream", streamCompression: "gzip" });
      tracing = true;
      report.diagnosticOnly = true;
      report.cpuSlowdown = Number(process.env.QUILNA_DIAGNOSTIC_CPU_RATE);
      for (const group of ["idle", "held-write", "continuous-write"]) {`,
  );
  replace(
    "            const ms = await page.evaluate(",
    "            const timing = await page.evaluate(",
  );
  replace(
    "                await new Promise<void>((resolve) =>\n                  requestAnimationFrame",
    `                const rendered = performance.now();
                performance.measure("quilna-input-dispatch", { start, end: rendered });
                await new Promise<void>((resolve) =>
                  requestAnimationFrame`,
  );
  replace(
    "                return performance.now() - start;",
    `                const end = performance.now();
                performance.measure("quilna-input-to-paint", { start, end });
                return { ms: end - start, dispatchMs: rendered - start, paintWaitMs: end - rendered };`,
  );
  replace(
    "              ms,\n            });",
    "              ...timing,\n            });",
  );
  replace(
    "    } finally {\n      await writeFile(",
    `    } finally {
      if (tracing && cdp) {
        try {
          const ended = new Promise<{ dataLossOccurred: boolean; stream?: string }>(resolve => cdp.once("Tracing.tracingComplete", resolve));
          await cdp.send("Tracing.end");
          const trace = await ended;
          report.traceDataLoss = trace.dataLossOccurred;
          if (!trace.stream) throw Error("Chromium returned no trace stream");
          const handle = trace.stream;
          const file = await import("node:fs/promises").then(fs => fs.open(info.outputPath("chromium-trace.json.gz"), "w"));
          let bytes = 0;
          try {
            while (true) {
              const chunk = await cdp.send("IO.read", { handle, size: 1048576 });
              const data = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
              bytes += data.length;
              if (bytes > 128 * 1024 * 1024) throw Error("Diagnostic trace exceeded 128 MiB; partial trace retained");
              await file.write(data);
              if (chunk.eof) break;
            }
            report.traceBytes = bytes;
          } finally { await file.close(); await cdp.send("IO.close", { handle }); }
        } catch (error) {
          report.diagnosticError = String(error);
        }
      }
      await writeFile(`,
  );
  return source;
}

function sourceHashes() {
  const files = [
    "package-lock.json",
    "playwright.search.config.ts",
    "tests/performance/search.spec.ts",
    "scripts/diagnose-search.mjs",
  ];
  const collect = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const dir of ["src", "server", "workers"]) collect(dir);
  return Object.fromEntries(
    files.sort().map((path) => [path, hash(readFileSync(join(root, path)))]),
  );
}

async function main() {
  const [project = "all", rate = "1", ...rest] = process.argv.slice(2);
  if (
    rest.length ||
    !["all", "studio", "editorial", "focus"].includes(project) ||
    !["1", "2", "4"].includes(rate)
  )
    throw Error(
      "Usage: node scripts/diagnose-search.mjs [all|studio|editorial|focus] [1|2|4]",
    );
  const directory = join(
    root,
    ".local-state/search-diagnostics",
    `run-${Date.now()}`,
  );
  mkdirSync(directory, { recursive: true });
  const before = sourceHashes();
  const source = diagnosticSource(
    readFileSync(join(root, "tests/performance/search.spec.ts"), "utf8"),
  );
  const config = `import { defineConfig } from '@playwright/test';
import base from '../../../playwright.search.config';
export default defineConfig({ ...base, testDir: '.', testMatch: 'diagnostic.spec.ts', outputDir: 'results', reporter: [['list'], ['json', {outputFile: ${JSON.stringify(join(directory, "results.json"))}}]], projects: base.projects${project === "all" ? "" : `?.filter(p => p.name === ${JSON.stringify(project)})`}, webServer: { ...base.webServer, cwd: ${JSON.stringify(root)} } });\n`;
  writeFileSync(join(directory, "diagnostic.spec.ts"), source);
  writeFileSync(join(directory, "playwright.config.ts"), config);
  const manifest = {
    diagnosticOnly: true,
    source: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    project,
    cpuSlowdown: Number(rate),
    workload:
      "maintained dense-tag corpus, queries, repetitions, contention, correctness and 200ms assertion; additional tracing is NOT acceptance",
    hashes: before,
    diagnosticHash: hash(source),
    configHash: hash(config),
  };
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`Diagnostic only; evidence: ${directory}`);
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      join(directory, "playwright.config.ts"),
      "--grep",
      "with dense tags",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, QUILNA_DIAGNOSTIC_CPU_RATE: rate },
    },
  );
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const unchanged = JSON.stringify(before) === JSON.stringify(sourceHashes());
  const traces = [];
  for (const entry of readdirSync(join(directory, "results"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const report = JSON.parse(
        readFileSync(
          join(directory, "results", entry.name, "measurements.json"),
          "utf8",
        ),
      );
      traces.push({
        name: entry.name,
        bytes: report.traceBytes,
        dataLoss: report.traceDataLoss,
        error: report.diagnosticError,
      });
    } catch {
      /* Missing reports make traceComplete false below. */
    }
  }
  const traceComplete =
    traces.length === (project === "all" ? 3 : 1) &&
    traces.every(
      (trace) => trace.bytes > 0 && trace.dataLoss === false && !trace.error,
    );
  writeFileSync(
    join(directory, "completion.json"),
    JSON.stringify({ ...result, unchanged, traceComplete, traces }, null, 2) +
      "\n",
  );
  process.exitCode = unchanged && traceComplete ? (result.code ?? 1) : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
