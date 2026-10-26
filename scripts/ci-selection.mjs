import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const full = () => ({ web: true, harness: true, apple: true });

export function selectChecks(paths, forceFull = false) {
  if (forceFull) return full();
  const selected = { web: false, harness: false, apple: false };
  for (const path of paths) {
    // Only recognized paths may narrow validation. Unknown controls stay full.
    if (
      /^docs\/.*\.md$/.test(path) ||
      /^(?:(?:apple|harness)\/)?README(?:\.ja)?\.md$/.test(path)
    )
      continue;
    if (/^harness\/go\.(?:mod|sum)$/.test(path)) return full();
    if (path.startsWith("apple/")) selected.apple = true;
    else if (path.startsWith("harness/")) selected.harness = true;
    else if (
      /^(?:src|server|workers|public|tests)\//.test(path) &&
      path !== "tests/server/ci-selection.test.mjs"
    )
      selected.web = true;
    else if (
      /^(?:index\.html|(?:vite|vitest|playwright)(?:\.[\w-]+)?\.config\.[cm]?[jt]s|tsconfig(?:\.[\w-]+)?\.json)$/.test(
        path,
      )
    )
      selected.web = true;
    else return full();
  }
  return selected;
}

export function changedPaths(eventName, event, cwd = process.cwd()) {
  if (eventName === "workflow_dispatch") return null;
  let base, head, range;
  if (eventName === "pull_request") {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
    range = "...";
  } else if (eventName === "push") {
    base = event.before;
    head = event.after;
    range = "..";
  } else return null;
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? "")))
    throw new Error("Missing or invalid event commit SHA");
  if (/^0+$/.test(base) || /^0+$/.test(head)) return null;
  // Disabling rename detection includes both the removed and added paths.
  // NUL separation preserves spaces and newlines in repository filenames.
  const output = execFileSync(
    "git",
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}${range}${head}`,
      "--",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: "pipe",
    },
  );
  return output.split("\0").filter(Boolean);
}

export function checkResults(needs) {
  const errors = [];
  if (needs.selection?.result !== "success")
    errors.push("selection did not succeed");
  if (needs.checks?.result !== "success")
    errors.push("maintained checks did not succeed");
  for (const job of ["harness", "apple"]) {
    const selected = needs.selection?.outputs?.[job];
    if (selected !== "true" && selected !== "false") {
      errors.push(`${job}: missing selection`);
      continue;
    }
    const expected = selected === "true" ? "success" : "skipped";
    if (needs[job]?.result !== expected)
      errors.push(
        `${job}: expected ${expected}, got ${needs[job]?.result ?? "missing"}`,
      );
  }
  if (!["true", "false"].includes(needs.selection?.outputs?.web))
    errors.push("web: missing selection");
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "select") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const paths = changedPaths(process.env.GITHUB_EVENT_NAME, event);
    const selected = selectChecks(paths ?? [], paths === null);
    const output = Object.entries(selected)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
    appendFileSync(process.env.GITHUB_OUTPUT, output);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Validation selection\n\nMaintained security/lint and selector regressions: always.\n\n${output.replaceAll("\n", "  \n")}\nChanged paths: ${paths?.length ?? "full/manual"}.\n`,
      );
    console.log(output.trim());
  } else if (process.argv[2] === "check") {
    const errors = checkResults(JSON.parse(process.env.NEEDS_JSON));
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else
      console.log(
        "All selected checks succeeded; unrelated platform jobs were explicitly skipped.",
      );
  } else throw new Error("Expected select or check");
}
