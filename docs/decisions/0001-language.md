# Implementation languages

[English](0001-language.md) | [日本語](0001-language.ja.md)

## Requirements

Keep the browser application, development harness, and existing Apple apps in this repository.
Preserve the browser-first acceptance gate and the existing validation for each component.

## Candidates

TypeScript provides browser APIs and shared types for the application.
Go provides a standalone development harness; Swift provides Apple framework integration.
A single language would require replacing existing working components.

## Selection rationale

Retain TypeScript for the browser, Go in `harness/`, and Swift in `apple/`.
Use dev-standards' `node-npm` primary profile and declare the Go/Swift packages as companions.
The companion tasks run existing Go formatting, vet and race tests, and Swift package tests and macOS builds.
This does not establish native UI acceptance, iOS builds, or performance benchmarks.
Swift companion verification currently limits the combined standards workflow to macOS.
The existing Linux browser/Go CI and Apple CI remain in place.
