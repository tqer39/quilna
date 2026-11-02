# TypeScript tooling

[English](typescript-tools.md) | [日本語](typescript-tools.ja.md)

The browser app uses TypeScript. Vite builds the browser JavaScript; `tsc --noEmit` remains the required type check in normal development, builds and CI.

## Optional tsrs check

[Cloudflare and VoidZero announced tsrs](https://blog.cloudflare.com/typescript-rust-port/) on 2026-10-20.
It is a Rust port of the TypeScript compiler, not a change of the app's implementation language.
The [official project](https://github.com/oxc-project/tsrs) still describes it as experimental and targets TypeScript 7 compatibility.

```bash
mise run typecheck:tsrs
```

The task installs exactly `tsrs@0.18.0-ts7.1.0-dev.20260929` through mise's task-specific npm tool support.
It is not a mandatory project tool or runtime dependency; normal `npm ci`, builds and CI keep using TypeScript 5.9.3 from the lockfile.
Mise suppresses npm installation lifecycle scripts by default. The two packages used by the Mac trial had verified registry signatures and attestations.
Review provenance and known issues when changing the experimental version; this check does not establish arbitrary packages as trustworthy.

The published package supplies macOS arm64 and Linux x64/arm64 GNU/musl binaries.
This trial ran only on macOS arm64. The package does not supply Windows or macOS x64 binaries; use the ordinary `npm run typecheck` there.
Do not make tsrs a required check across platforms without validating that support first.

## Local trial on 2026-10-24

The unchanged project configuration initially passed tsc but failed tsrs with TS2882 on the CSS side-effect import.
Adding Vite's standard client type reference in `src/vite-env.d.ts` resolved the import for both compilers without disabling a check or changing runtime behavior.
With that declaration, both compilers checked the project successfully. Separate valid and invalid fixtures also passed or rejected as expected; both reported TS2322 and TS2741 for the invalid fixture.

Three alternating project checks on the same Mac Studio arm64, under Node 26.12.1, recorded these medians:

| Tool | Elapsed time | Peak process RSS |
| --- | ---: | ---: |
| tsc 5.9.3 | 0.547 s | 319.0 MB |
| tsrs 0.18.0, TypeScript 7.1 development pin | 0.053 s | 78.4 MB |

All three samples are retained in private local evidence; OS caches were not flushed.
These compiler generations and standard libraries differ, so this is a local tool comparison, not a controlled measurement of Rust alone or proof of complete compiler parity.
It does not measure browser startup, runtime performance, end-to-end development time, LSP support or other machines.
Keep the required tsc check while evaluating tsrs and its [known compatibility gaps](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md).
