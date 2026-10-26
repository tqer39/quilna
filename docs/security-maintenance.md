# Security maintenance

[English](security-maintenance.md) | [日本語](security-maintenance.ja.md)

## Runtime and certificate incident response

The 2026-10-21 [Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) addresses the eMudhra CA incident and other runtime vulnerabilities.
This repository selects [Node.js 26.12.1](https://nodejs.org/en/blog/release/v26.12.1) and [Go 1.27.3](https://go.dev/doc/devel/release#go1.27.0), which includes X.509 security fixes.
The Node security floors are 22.23.4, 24.22.1 and 26.12.1; new major lines need review.
These are dated minimums, not a promise that future vulnerabilities are covered.

No PHP runtime is declared here. The [PHP advisory](https://www.php.net/archive/2026.php) still requires separate action for any other PHP-hosted services.
Node tools/backends use Node's certificate handling; Apple URLSession clients depend on platform trust updates.
Cloudflare Workers uses a platform-managed runtime. Updating the local Node toolchain does not establish that Workers, browsers, OS stores, Python/certifi, Git for Windows or an already running process has been patched.
Inventory each deployed process, update its runtime and trust bundle through its vendor, restart it, and verify its actual version and TLS behavior.
Do not disable certificate verification to restore connectivity to a distrusted chain.

## Maintained checks

```bash
mise install
mise run security:check
mise exec -- npm ci
mise run security:audit
mise exec -- npm audit signatures
mise run security:go
```

`security:check` checks the executing Node version, consistent runtime pins, project install policy, lockfile registry/integrity, and maintained workflow reference/permission forms.
The project enables aggressive mise activation to prevent a system binary ahead of its shims from silently winning in npm child processes.
The checks reject explicit TLS verification bypasses, floating external Actions, privileged PR triggers, and write permissions in these workflows.
They are repository policy checks, not a complete YAML analyzer or a sandbox against a malicious change to the checks themselves.

The project `.npmrc` disables installation hooks and requires engine/TLS verification.
`npm run` still executes its explicit command; build/test dependencies can execute code, so reviewed updates and limited CI permissions remain necessary.
The lockfile uses the npm registry and SHA-512 integrity; npm verifies downloaded content against that lockfile.
`npm audit signatures` checks available registry signatures/provenance, not universal package authorship or the absence of malicious code.

PR/main CI audits production **and development** dependencies before executing lint/tests.
These checks remain active for documentation-only changes under [change-aware CI selection](ci-selection.md).
The daily Ubuntu-only `security.yml` workflow repeats the audit and signature checks and runs the pinned Go vulnerability scanner.
PR dependency review also rejects newly introduced advisories at low severity and above without posting PR comments.
Go scanning covers reachable findings for the scanned platform; an exit-zero scan does not prove every platform or unknown vulnerability safe.
The daily workflow does not rebuild macOS/iOS applications or use deployment secrets.

## Renovate and urgent updates

`renovate.json5` extends [tqer39/renovate-config](https://github.com/tqer39/renovate-config).
The shared preset holds ordinary releases for 14 days, requires release timestamps, suppresses install scripts/plugins and pins Action digests.
This repository explicitly disables automatic merging, including vulnerability PRs and matching package rules.
Known vulnerability PRs bypass release-age and schedule delays but still require review and passing CI.
Runtime/CA advisories may need a manual update even when no package alert or automated PR exists.

A configuration file becomes effective only on the default branch with an installed App that can access the repository.
Confirm a recent Dependency Dashboard or actual update PR and any configuration errors; App installation and file presence alone do not prove a successful bot run.
After a security fix, confirm fresh main CI and Dependabot's rescan. Do not dismiss alerts simply to clear the page.
For an emergency: read the primary advisory, update the affected runtime/package, run these checks and relevant regressions, merge the reviewed fix, then restart/redeploy affected processes and retain evidence.

## Advisory coverage follow-up

On 2026-10-24, Dependabot's post-merge rescan reported [GHSA-xjj6-f33q-929c](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c) for Miniflare's undici 7.29.1, although the full npm audit still returned zero findings.
An exit-zero npm audit does not override a separate advisory or prove the absence of known vulnerabilities.
The scoped `miniflare@5.20261006.1-alpha` override selects patched undici 7.30.1 without changing Miniflare or Wrangler.
Remove the override after an upstream update supplies a patched dependency and the compatibility/regression checks pass.
The regression uses Miniflare's actual resolved fetch implementation in an isolated child process with one loopback response; the old package crashes despite catching the rejected fetch, while the patched package rejects the response and survives.
No external host or high-load payload is used. Keep the installed package distinct from the Node runtime's bundled fetch implementation.
