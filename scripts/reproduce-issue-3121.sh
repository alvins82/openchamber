#!/usr/bin/env bash
# Reproduces openchamber/openchamber#3121 against a real opencode binary.
#
# "Update OpenCode" in the OpenChamber UI always fails with a bare "Bad Request"
# toast. Since opencode 1.18.x, POST /global/upgrade requires a `target` field,
# but OpenChamber forwards an empty JSON body `{}` when no explicit version is
# chosen. opencode rejects it with HTTP 400 and a payload shaped
# `{ name, data: { message } }`; OpenChamber reads `payload?.error` (undefined
# for that shape) and falls back to the HTTP statusText, so the UI shows only
# "Bad Request".
#
# This script reproduces the upstream half of the bug. The OpenChamber-server
# half (empty body forwarded verbatim + lost error message) is pinned by
# packages/web/server/lib/opencode/reproduce-3121.test.js.
#
# Requires: opencode >= 1.18.x on PATH (verified with 1.18.22 and 1.18.23).
set -euo pipefail

PORT="${PORT:-43123}"
PASSWORD="repro-password-$(date +%s)"

command -v opencode >/dev/null 2>&1 || { echo "opencode binary not found on PATH" >&2; exit 1; }
echo "opencode version: $(opencode --version)"

OPENCODE_SERVER_PASSWORD="$PASSWORD" opencode serve --hostname 127.0.0.1 --port "$PORT" \
  >/tmp/opencode-3121.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 4

echo
echo "=== POST /global/upgrade with empty body {} (exactly what OpenChamber forwards) ==="
curl -s -w "\nHTTP %{http_code}\n" -u "opencode:$PASSWORD" \
  -X POST "http://127.0.0.1:$PORT/global/upgrade" \
  -H 'Content-Type: application/json' -d '{}'

echo
echo "=== control: explicit but invalid target ==="
curl -s -w "\nHTTP %{http_code}\n" -u "opencode:$PASSWORD" \
  -X POST "http://127.0.0.1:$PORT/global/upgrade" \
  -H 'Content-Type: application/json' -d '{"target":"not-a-version"}'

echo
echo "Expected: both return HTTP 400. The empty-body payload has no 'error'"
echo "field, only data.message, which OpenChamber's server drops (see"
echo "routes.js: payload?.error || response.statusText) leaving the user with"
echo 'the bare "Bad Request".'