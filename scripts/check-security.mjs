import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const nodeMinimums = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };
export const nodeEngineRange = Object.values(nodeMinimums)
  .map((v) => `^${v}`)
  .join(" || ");

export function safeNode(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts || !nodeMinimums[parts[1]]) return false;
  const actual = parts.slice(1).map(Number);
  const minimum = nodeMinimums[parts[1]].split(".").map(Number);
  return (
    actual[1] > minimum[1] ||
    (actual[1] === minimum[1] && actual[2] >= minimum[2])
  );
}

export function inspectPolicy({ npmrc, lock, workflows, environment = {} }) {
  const errors = [];
  const normalizedEnvironment = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const settings = Object.fromEntries(
    npmrc
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\s*[#;]/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  for (const key of ["ignore-scripts", "engine-strict", "strict-ssl"]) {
    if (settings[key] !== "true") errors.push(`npm ${key} must be true`);
  }
  if (
    settings.registry !== "https://registry.npmjs.org/" ||
    Object.keys(settings).some((key) => key.endsWith(":registry"))
  )
    errors.push("npm registry must be the reviewed npm registry");
  for (const key of [
    "npm_config_ignore_scripts",
    "npm_config_engine_strict",
    "npm_config_strict_ssl",
  ]) {
    if (String(normalizedEnvironment[key]).toLowerCase() === "false")
      errors.push(`${key} overrides security policy`);
  }
  if (
    environment.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    /^(1|true)$/i.test(environment.GIT_SSL_NO_VERIFY ?? "") ||
    environment.GOINSECURE ||
    environment.GOSUMDB === "off"
  )
    errors.push("TLS or module verification is disabled");
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""])
    errors.push("a version-3 npm lockfile is required");
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!name) continue;
    if (
      entry.link ||
      !entry.resolved?.startsWith("https://registry.npmjs.org/") ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")
    )
      errors.push(
        `unreviewed package source or missing SHA-512 integrity: ${name}`,
      );
  }
  for (const [name, yaml] of Object.entries(workflows)) {
    if (/\bpull_request_target\b/.test(yaml.replace(/#.*$/gm, "")))
      errors.push(`${name}: privileged PR trigger is not allowed`);
    if (/persist-credentials:\s*["']?true\b/.test(yaml))
      errors.push(`${name}: checkout credentials must not persist`);
    if (
      !/^permissions:\s*\r?\n {2}contents: read\s*$/m.test(yaml) ||
      /\bwrite-all\b|^\s*(?:contents|actions|checks|deployments|id-token|issues|packages|pages|pull-requests|security-events|statuses):\s*["']?write\b/m.test(
        yaml,
      )
    )
      errors.push(`${name}: workflows must keep read-only permissions`);
    for (const line of yaml.split(/\r?\n/)) {
      const match = /^\s*(?:-\s*)?uses:\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (!match) {
        if (/\buses\s*:/.test(line.split("#")[0]))
          errors.push(`${name}: use an explicit block-style action reference`);
        continue;
      }
      const reference = match[1].replace(/^['"]|['"]$/g, "");
      if (
        !reference.startsWith("./") &&
        !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/i.test(reference) &&
        !/^docker:\/\/[^\s]+@sha256:[a-f0-9]{64}$/i.test(reference)
      )
        errors.push(
          `${name}: external action must use an immutable digest: ${reference}`,
        );
    }
  }
  return errors;
}

export function inspectRenovate(config) {
  const errors = [];
  const lastRule = config.packageRules?.at(-1);
  if (
    !config.extends?.includes("github>tqer39/renovate-config:renovate.json5") ||
    config.automerge !== false ||
    config.platformAutomerge !== false ||
    lastRule?.automerge !== false ||
    lastRule?.matchPackageNames?.join() !== "*"
  )
    errors.push(
      "Renovate must use the shared preset with manually reviewed updates",
    );
  if (config.ignoreScripts !== true || config.ignorePlugins !== true)
    errors.push("Renovate install scripts and plugins must stay disabled");
  const security = config.vulnerabilityAlerts;
  if (
    security?.automerge !== false ||
    security?.platformAutomerge !== false ||
    security?.minimumReleaseAge !== null ||
    security?.prCreation !== "immediate" ||
    security?.schedule?.join() !== "at any time"
  )
    errors.push("vulnerability updates must be immediate and manually merged");
  return errors;
}

export function checkRepository(
  root,
  environment = process.env,
  nodeVersion = process.versions.node,
) {
  const text = (path) => readFileSync(join(root, path), "utf8");
  const pkg = JSON.parse(text("package.json"));
  const workflows = Object.fromEntries(
    readdirSync(join(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, text(`.github/workflows/${name}`)]),
  );
  const errors = inspectPolicy({
    npmrc: text(".npmrc"),
    lock: JSON.parse(text("package-lock.json")),
    workflows,
    environment,
  });
  if (!safeNode(nodeVersion))
    errors.push(`unsupported or unpatched Node.js: ${nodeVersion}`);
  if (pkg.engines?.node !== nodeEngineRange)
    errors.push(
      "package.json must declare the reviewed Node.js security minimums",
    );
  const node = /^node\s*=\s*"([^"]+)"/m.exec(text("mise.toml"))?.[1];
  if (!safeNode(node ?? ""))
    errors.push("mise must pin a patched Node.js release");
  for (const [name, yaml] of Object.entries(workflows)) {
    for (const match of yaml.matchAll(
      /^\s*node-version:\s*["']?([\d.]+)["']?\s*$/gm,
    )) {
      if (match[1] !== node)
        errors.push(`${name}: Node.js pin differs from mise.toml`);
    }
  }
  const go = /^go\s*=\s*"([^"]+)"/m.exec(text("mise.toml"))?.[1];
  const goModule = /^go\s+(\S+)/m.exec(text("harness/go.mod"))?.[1];
  if (
    !/^1\.27\.\d+$/.test(go ?? "") ||
    Number(go.split(".")[2]) < 3 ||
    goModule !== go
  )
    errors.push(
      "Go pins must agree and include the reviewed 1.27.3 security fixes",
    );
  const renovate = JSON.parse(text("renovate.json5"));
  errors.push(...inspectRenovate(renovate));
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkRepository(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Security policy checks passed (Node.js ${process.versions.node}).`,
    );
}
