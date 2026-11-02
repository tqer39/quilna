import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const authKeys = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
];
export const referenceKeys = [...authKeys, "CLOUDFLARE_API_TOKEN"];

export function validateConfiguration(env, checkReferences = true) {
  if (
    env.GITHUB_REPOSITORY !== "tqer39/quilna" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.CONFIRM_WORKER !== "quilna-private"
  )
    throw new Error(
      "Only a confirmed manual run on the Quilna main branch is allowed.",
    );
  if (env.RUNNER_DEBUG === "1" || env.ACTIONS_STEP_DEBUG === "true")
    throw new Error(
      "Disable Actions debug logging before loading credentials.",
    );
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? ""))
    throw new Error("Configure CLOUDFLARE_ACCOUNT_ID.");
  if (
    !/^https:\/\/quilna-private\.[a-z0-9-]+\.workers\.dev$/.test(
      env.QUILNA_APP_ORIGIN ?? "",
    )
  )
    throw new Error("Configure the approved Quilna workers.dev origin.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.QUILNA_OWNER_EMAIL ?? ""))
    throw new Error("Configure QUILNA_OWNER_EMAIL.");
  for (const key of checkReferences ? referenceKeys : []) {
    if (
      !/^op:\/\/[^\s/]+\/[^\s/]+\/(?:[^\s/]+\/)?[^\s/?#]+$/.test(
        env[`OP_REF_${key}`] ?? "",
      )
    )
      throw new Error(
        `Configure OP_REF_${key} with a 1Password secret reference using IDs.`,
      );
  }
}

export function secretPayload(env) {
  for (const key of referenceKeys) {
    const value = env[key];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.startsWith("op://") ||
      /[\r\n\0]/.test(value)
    )
      throw new Error(`Missing or invalid resolved credential: ${key}.`);
  }
  if (
    !/^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/.test(
      env.GOOGLE_CLIENT_ID,
    ) ||
    env.GOOGLE_CLIENT_SECRET.length < 10 ||
    env.GOOGLE_CLIENT_SECRET.length > 500 ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    env.BETTER_AUTH_SECRET.length > 500 ||
    env.BETTER_AUTH_SECRET === env.GOOGLE_CLIENT_SECRET
  )
    throw new Error("Invalid Google credential or session signing key format.");
  return {
    secrets: Object.fromEntries(
      authKeys.map((name) => [
        name,
        {
          name,
          type: "secret_text",
          text: env[name],
        },
      ]),
    ),
  };
}

function assertTarget(settings, env) {
  if (!Array.isArray(settings?.bindings))
    throw new Error("Worker settings have no bindings.");
  const names = settings.bindings.map((binding) => binding.name);
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate Worker binding names.");
  const values = Object.fromEntries(
    settings.bindings
      .filter((b) => b.type === "plain_text")
      .map((b) => [b.name, b.text]),
  );
  if (
    values.PRIVATE_DEV !== "true" ||
    values.APP_ORIGIN !== env.QUILNA_APP_ORIGIN ||
    values.GOOGLE_ALLOWED_EMAIL !== env.QUILNA_OWNER_EMAIL
  )
    throw new Error(
      "Existing Worker does not match the approved owner-only target.",
    );
  if (!settings.bindings.some((b) => b.name === "AUTH_DB" && b.type === "d1"))
    throw new Error("Existing Worker has no authentication database binding.");
}

export async function syncCloudAuth(env, fetcher = fetch) {
  validateConfiguration(env, false);
  const body = secretPayload(env);
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/quilna-private`;
  async function request(path, method = "GET", payload) {
    // Never log API bodies, which may echo credentials on failure. Never follow redirects.
    try {
      const response = await fetcher(base + path, {
        method,
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/merge-patch+json",
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (result.success !== true) throw new Error();
      return result.result;
    } catch {
      throw new Error(
        "Cloudflare request failed; response details withheld to protect credentials.",
      );
    }
  }
  const before = await request("/settings");
  assertTarget(before, env);
  // This API only patches the three named secrets. It cannot create a missing Worker.
  // No null values: no deletions, source upload, resource creation or migrations.
  try {
    await request("/secrets-bulk", "PATCH", body);
    const after = await request("/settings");
    assertTarget(after, env);
    if (
      !authKeys.every((name) =>
        after.bindings.some((b) => b.name === name && b.type === "secret_text"),
      )
    )
      throw new Error();
    const otherBindings = (settings) =>
      settings.bindings
        .filter((b) => !authKeys.includes(b.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!isDeepStrictEqual(otherBindings(before), otherBindings(after)))
      throw new Error();
  } catch {
    throw new Error(
      "Credential sync was not verified. Changes may have applied; inspect the Worker before retrying. No automatic retry or rollback was attempted.",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "--check-configuration") {
      validateConfiguration(process.env);
      console.log(
        "Credential sync configuration is valid; no credentials loaded.",
      );
    } else if (process.argv[2] === "--apply") {
      await syncCloudAuth(process.env);
      console.log(
        "Three authentication secret bindings verified; other bindings preserved. Real login still requires verification.",
      );
    } else throw new Error("Use --check-configuration or --apply.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
