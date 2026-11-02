#!/usr/bin/env bash
set -eu

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$ ]]; then
  echo 'Expected a pinned mise calendar version.' >&2
  exit 2
fi
url="https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-linux-x64.tar.zst"
echo "Diagnostic GET after mise setup failed: $url"
echo 'This is a later probe, not the HTTP status of the original failed request.'
# Discard the response body. Never install or execute an unverified probe result.
# One bounded attempt; TLS verification and HTTPS-only redirects remain enabled.
status=0
curl --proto '=https' --proto-redir '=https' --location --silent --show-error \
  --connect-timeout 10 --max-time 30 --output /dev/null \
  --write-out 'HTTP %{http_code}; redirects %{num_redirects}; total %{time_total}s\n' \
  "$url" || status=$?
echo "Diagnostic curl exit: $status"
echo 'The original setup failure remains a failed security job; the scanner did not run.'
