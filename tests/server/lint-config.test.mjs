import test from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

// A dependency upgrade must not silently stop linting any source/test tree.
test("lint config still checks JavaScript and TypeScript across all target trees", async () => {
  const eslint = new ESLint();
  for (const filePath of [
    "src/lint-regression.ts",
    "server/lint-regression.mjs",
    "workers/lint-regression.mjs",
    "scripts/lint-regression.mjs",
    "tests/server/lint-regression.mjs",
    "tests/browser/lint-regression.ts",
    "tests/runtime/lint-regression.mjs",
  ]) {
    const [result] = await eslint.lintText("const unusedValue = 1;\n", {
      filePath,
    });
    assert.ok(
      result.messages.some(
        (m) => m.ruleId === "@typescript-eslint/no-unused-vars",
      ),
      `${filePath} must report unused variables`,
    );
    assert.ok(result.errorCount > 0);
  }
  const [typescript] = await eslint.lintText("export type Value = any;\n", {
    filePath: "src/lint-regression.ts",
  });
  assert.ok(
    typescript.messages.some(
      (m) => m.ruleId === "@typescript-eslint/no-explicit-any",
    ),
  );
  for (const filePath of ["dist/output.js", "node_modules/example/index.js"]) {
    assert.equal(await eslint.isPathIgnored(filePath), true);
  }
});
