# Implementation languages

[English](0001-language.md) | [日本語](0001-language.ja.md)

## Requirements

Preserve the browser application, local execution harness, and existing native experiments while making development configuration reproducible.

## Candidates

Compare the existing TypeScript, Go, and Swift components with consolidating the product into a single language.

## Selection rationale

Keep TypeScript for the browser and workers, Go for the harness, and Swift for the Apple experiment.
Use the mise-project profile to run the existing browser and harness checks through shared task names.
Native feature work stays on hold until browser usability is accepted. Apple checks retain their separate macOS CI and local tasks; the Linux common CI does not claim to verify Swift.
