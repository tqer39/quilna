---
name: apple-native-validation
description: "Validate Quilna's Swift and SwiftUI changes on macOS and iOS, including concurrency regressions, builds, and actual native UI behavior. Use for native implementation or validation requests; skip native execution for documentation-only changes."
---

# Apple Native Validation

Work from this checkout's Git root and follow [the repository instructions](../../../AGENTS.md).
Use [the Apple guide](../../../apple/README.md) as the maintained procedure; read only **Available features**, **Information collection and translation**, and the build/test sections relevant to the change.
Do not copy build commands or platform support tables into this skill.

## Select and run verification

1. Identify the affected Core/UI behavior and platform branches, including translation availability. Inspect [Package.swift](../../../apple/Package.swift) and the relevant tests for the current concurrency and target configuration.
   Fetch current primary documentation when changing version-dependent Swift or Apple APIs.
2. Use existing tasks in [mise.toml](../../../mise.toml), the guide's iOS build command, and [the macOS bundle script](../../../apple/scripts/build-macos-app.sh) as appropriate.
   Keep diagnostic paths and synthetic fixtures in ignored/private task state. Reuse matching completed builds rather than rebuilding for narration alone.
3. For meaningful async changes, verify observable results with the existing Core/UI regression tests, including cancellation-ignoring completions where relevant.
   A compiler pass does not establish runtime behavior.
4. When UI behavior changes or runtime verification is requested, launch/install the exact built artifacts in a dedicated synthetic test environment and operate the actual app with available native UI tools.
   Follow the guide's navigation regression procedure for search changes; preserve ordinary browsing, old-article details, saved Japanese, errors, filtering, paging, and bookmark behavior as applicable.
5. Record the source identity, toolchain/device/OS, commands and outcomes, actual observations, and artifact hashes.
   Record the whole installed runtime bundle where code can reside in a debug dylib; the launcher executable alone may be unchanged.
   After a persistence mutation, verify the relevant synthetic database state through a read-only connection when that is part of the requirement.

## Report the platform boundary accurately

Use the guide's translation and physical-device limitations. Do not count unavailable Simulator translation as a successful generation test.
Separate automated tests, build success, actual UI verification, and physical-device performance.
If a locked screen or unavailable device prevents UI work, report that prerequisite and continue independent checks; do not invoke source repair for it.
Preserve historical proof as historical after a source change. Documentation-only changes need the documentation checks from the repository instructions, not a fresh native run.
