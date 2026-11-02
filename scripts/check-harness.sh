#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GOTOOLCHAIN=local
export GOCACHE="${GOCACHE:-$task_root/.local-state/go-cache}"
mkdir -p "$GOCACHE"
cd "$task_root/harness"

unformatted="$(gofmt -l .)"
if [[ -n "$unformatted" ]]; then
  printf 'gofmtが必要です:\n%s\n' "$unformatted" >&2
  exit 1
fi
go vet ./...
go test -race ./...

# Opt-in real CLI tool execution with isolated credentials and loopback responses.
codex_fixture_binary="${QUILNA_CODEX_BINARY:-${TSUMIKI_CODEX_BINARY:-}}"
if [[ -n "$codex_fixture_binary" ]]; then
  python3 "$task_root/scripts/test-codex-read-policy.py" --codex-binary "$codex_fixture_binary"
fi
