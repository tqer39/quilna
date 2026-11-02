import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

async function fixture(t, skillBody) {
  const root = await mkdtemp(join(tmpdir(), "textbook-documentation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  for (const path of [
    "README.md",
    "apple/README.md",
    "harness/README.md",
    "docs/guide.md",
  ]) {
    const basename = path.split("/").at(-1);
    const japanese = basename.replace(/\.md$/, ".ja.md");
    const body = `# Guide\n\n[English](${basename}) | [日本語](${japanese})\n`;
    await write(path, body);
    await write(path.replace(/\.md$/, ".ja.md"), body);
  }
  await write("AGENTS.md", "# Repository instructions\n");
  await write("scripts/check.sh", "#!/bin/sh\nexit 0\n");
  await copyFile(
    new URL("../../scripts/check-docs.mjs", import.meta.url),
    join(root, "scripts/check-docs.mjs"),
  );
  if (skillBody !== undefined) {
    await write(
      ".agents/skills/example/SKILL.md",
      `---\nname: example\ndescription: Review this project.\n---\n\n# Example\n\n${skillBody}\n`,
    );
  }
  return root;
}

function check(root) {
  try {
    return {
      status: 0,
      output: execFileSync(
        process.execPath,
        [join(root, "scripts/check-docs.mjs")],
        { encoding: "utf8", stdio: "pipe" },
      ),
    };
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

test("documentation checks retain support for a checkout without local skills", async (t) => {
  assert.equal(check(await fixture(t)).status, 0);
});

test("a discovered SKILL entrypoint can reference canonical rules and scripts without a translation copy", async (t) => {
  const root = await fixture(
    t,
    "Read [rules](../../../AGENTS.md), [guide](../../../harness/README.md), and [checks](../../../scripts/check.sh). Explicitly invoke `$example`.\n```text\n[example](not-a-real-file.md)\n```",
  );
  assert.equal(check(root).status, 0);
});

test("a missing canonical Markdown target from a skill fails documentation checks", async (t) => {
  const root = await fixture(t, "Read [guide](../../../docs/deleted.md).");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.output, /SKILL\.md.*deleted\.md/);
});

test("a missing script target from a skill fails documentation checks", async (t) => {
  const root = await fixture(t, "Run [checks](../../../scripts/deleted.sh).");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.output, /SKILL\.md.*deleted\.sh/);
});

test("ordinary English and Japanese language-pair validation remains enforced", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "docs/guide.ja.md"));
  assert.equal(check(root).status, 1);
});

test("English skill references to paired guides retain the language-link rule", async (t) => {
  const root = await fixture(t, "Read [guide](../../../harness/README.ja.md).");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.output, /SKILL\.md.*same language/);
});
