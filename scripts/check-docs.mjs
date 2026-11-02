import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pages = ["README.md", "apple/README.md", "harness/README.md"];
const errors = [];

function collect(
  directory,
  target = pages,
  include = (path) => path.endsWith(".md"),
) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collect(path, target, include);
    else if (entry.isFile() && include(path)) target.push(path);
  }
}

collect("docs");
for (const path of [...pages]) {
  if (!path.endsWith(".ja.md")) pages.push(path.replace(/\.md$/, ".ja.md"));
}
const documents = new Set(pages);
const skills = [];
if (existsSync(join(root, ".agents/skills"))) {
  collect(".agents/skills", skills, (path) => basename(path) === "SKILL.md");
}

for (const path of [...documents].sort()) {
  const file = join(root, path);
  if (!existsSync(file)) {
    errors.push(`${path}: missing language counterpart`);
    continue;
  }
  const japanese = path.endsWith(".ja.md");
  const english = japanese ? path.replace(/\.ja\.md$/, ".md") : path;
  const translation = english.replace(/\.md$/, ".ja.md");
  if (!documents.has(english) || !existsSync(join(root, english))) {
    errors.push(`${path}: missing English counterpart`);
  }
  const source = readFileSync(file, "utf8");
  const navigation = `[English](${basename(english)}) | [日本語](${basename(translation)})`;
  const lines = source.split(/\r?\n/);
  if (
    !lines[0].startsWith("# ") ||
    lines[1] !== "" ||
    lines[2] !== navigation
  ) {
    errors.push(
      `${path}: put the language switch immediately after the H1 and a blank line`,
    );
  }

  checkLinks(path, source, { navigation });
}

// Tool-discovered English entrypoints do not need a translated manifest.
// Their script/source references must remain usable as well as Markdown links.
for (const path of skills) {
  checkLinks(path, readFileSync(join(root, path), "utf8"), {
    allTargets: true,
  });
}

function checkLinks(
  path,
  source,
  { navigation = "", allTargets = false } = {},
) {
  const file = join(root, path);
  const japanese = path.endsWith(".ja.md");
  // Examples and inline code may intentionally contain non-existent paths.
  const prose = source
    .replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(navigation, "");
  const targets = [
    ...[
      ...prose.matchAll(
        /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g,
      ),
    ].map((m) => m[1] ?? m[2]),
    ...[
      ...prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|([^\s]+))/gm),
    ].map((m) => m[1] ?? m[2]),
  ];
  for (const target of targets) {
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
    let destination;
    try {
      destination = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    } catch {
      errors.push(`${path}: invalid link encoding: ${target}`);
      continue;
    }
    if (!destination || (!allTargets && !destination.endsWith(".md"))) continue;
    const resolved = resolve(dirname(file), destination);
    const linked = relative(root, resolved).split("\\").join("/");
    if (!existsSync(resolved))
      errors.push(`${path}: broken local link: ${target}`);
    if (documents.has(linked) && linked.endsWith(".ja.md") !== japanese) {
      errors.push(
        `${path}: keep document links in the same language: ${target}`,
      );
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checks passed: ${documents.size / 2} English/Japanese pairs; ${skills.length} skill entrypoints.`,
  );
}
