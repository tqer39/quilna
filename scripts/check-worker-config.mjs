import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Treat origin-routing policy as part of the deployment contract. Checking only
// the source URL cannot enforce Cloudflare's network boundary.
export function inspectWorkerConfig(
  config,
  { ownerOnly = config?.vars?.PRIVATE_DEV === "true" } = {},
) {
  const errors = [];
  const check = (value, label) => {
    const flags = value?.compatibility_flags;
    if (
      !Array.isArray(flags) ||
      !flags.includes("global_fetch_strictly_public") ||
      flags.includes("global_fetch_private_origin")
    )
      errors.push(`${label}: global fetch must use public Internet routing`);
    if (
      (ownerOnly || value?.vars?.PRIVATE_DEV === "true") &&
      (value?.vars?.PRIVATE_DEV !== "true" ||
        value.assets?.run_worker_first !== true ||
        value.preview_urls !== false)
    )
      errors.push(
        `${label}: owner-only deployment requires PRIVATE_DEV, authentication for every asset, and disabled preview URLs`,
      );
  };
  check(config, "worker");
  for (const [name, env] of Object.entries(config?.env ?? {}))
    // Wrangler vars do not inherit from the top-level configuration.
    check({ ...config, ...env, vars: env.vars ?? {} }, `environment ${name}`);
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkWorkerConfigs(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Worker deployment configuration checks passed.");
}

export function checkWorkerConfigs(root) {
  const errors = [];
  for (const name of [
    "wrangler.jsonc",
    "wrangler.dev.example.jsonc",
    "wrangler.cloud.example.jsonc",
    "wrangler.dev.jsonc",
    "wrangler.cloud.jsonc",
  ]) {
    const path = join(root, name);
    if (!existsSync(path)) {
      if (name.endsWith("example.jsonc") || name === "wrangler.jsonc")
        errors.push(`${name}: required configuration is missing`);
      continue;
    }
    const parsed = ts.parseConfigFileTextToJson(
      name,
      readFileSync(path, "utf8"),
    );
    if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
      errors.push(`${name}: invalid configuration JSON`);
      continue;
    }
    errors.push(
      ...inspectWorkerConfig(parsed.config, {
        ownerOnly: name !== "wrangler.jsonc",
      }).map((error) => `${name}: ${error}`),
    );
  }
  return errors;
}
