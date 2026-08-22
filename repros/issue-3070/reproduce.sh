#!/bin/bash
# End-to-end reproduction for openchamber/openchamber#3070:
# "Loop exits silently on orphaned interrupted tool — should retry or surface error to user"
#
# Requires: a locally installed `opencode` CLI on PATH (the OpenChamber-managed
# runtime), node, and curl. Uses a throwaway config/data home so nothing in the
# user's real opencode setup is touched.
#
# What it does:
#   1. Starts the mock OpenAI-compatible provider (repros/issue-3070/mock-server.mjs)
#   2. Starts `opencode serve` pointed at it
#   3. Sends one user message through the HTTP API
#   4. Prints the serve log lines around the loop exit and the persisted
#      assistant message, which shows the orphaned interrupted tool part and
#      NO assistant text.
#
# Expected observable output (issue's "Actual behavior"):
#   WARN loop exit with orphaned interrupted tool session.id=... tool=read callID=call_orphan_1
#   INFO exiting loop session.id=...
#   assistant message parts: step-start, tool (status=error, input={},
#   error="Tool execution aborted", metadata.interrupted=true), step-finish
#   -> no text part, zero tokens.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
MOCK_PORT="${MOCK_PORT:-8787}"
SERVE_PORT="${SERVE_PORT:-4099}"
WORKDIR="$(mktemp -d)"
LOG_DIR="$WORKDIR"

cleanup() {
  [ -n "${SERVE_PID:-}" ] && kill "$SERVE_PID" 2>/dev/null
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> starting mock provider on :$MOCK_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_MODE="${MOCK_MODE:-partial-abort}" MOCK_TOOL="${MOCK_TOOL:-read}" \
  node "$DIR/mock-server.mjs" > "$LOG_DIR/mock.log" 2>&1 &
MOCK_PID=$!

echo "==> starting opencode serve on :$SERVE_PORT (logs: $LOG_DIR/serve.log)"
OPENCODE_CONFIG="$DIR/opencode.json" \
  XDG_CONFIG_HOME="$WORKDIR/config" \
  XDG_DATA_HOME="$WORKDIR/data" \
  XDG_STATE_HOME="$WORKDIR/state" \
  XDG_CACHE_HOME="$WORKDIR/cache" \
  HOME="$WORKDIR/home" \
  opencode serve --hostname 127.0.0.1 --port "$SERVE_PORT" --print-logs --log-level DEBUG \
  > "$LOG_DIR/serve.log" 2>&1 &
SERVE_PID=$!

echo "==> waiting for servers"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:$SERVE_PORT/config" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "==> creating session"
SID="$(curl -s -X POST "http://127.0.0.1:$SERVE_PORT/session" -H "content-type: application/json" \
  -d '{"directory":"'$WORKDIR'"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -z "$SID" ]; then
  echo "failed to create session"
  tail -5 "$LOG_DIR/serve.log"
  exit 1
fi
echo "session: $SID"

echo "==> sending user message (this triggers the loop)"
curl -sN -X POST "http://127.0.0.1:$SERVE_PORT/session/$SID/message" \
  -H "content-type: application/json" \
  -d '{"model":{"providerID":"mock","modelID":"mock-model"},"parts":[{"type":"text","text":"Read the file '"$DIR"'/opencode.json and summarize it."}]}' \
  > "$LOG_DIR/message-sse.txt" 2>&1
echo "(message POST returned)"

echo
echo "==================== serve log (session-scoped) ===================="
grep "$SID" "$LOG_DIR/serve.log" | grep -E "loop|orphaned|exiting|process|stream|error" | tail -20

echo
echo "==================== persisted assistant message ===================="
curl -s "http://127.0.0.1:$SERVE_PORT/session/$SID/message?limit=10" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs:
    if m['info']['role'] != 'assistant':
        continue
    parts = []
    for p in m.get('parts', []):
        if p['type'] == 'tool':
            parts.append({'type': 'tool', 'tool': p.get('tool'), 'callID': p.get('callID'), 'state': p.get('state')})
        elif p['type'] == 'text':
            parts.append({'type': 'text', 'text': p.get('text')})
        else:
            parts.append({'type': p['type']})
    print(json.dumps({'id': m['info']['id'], 'finish': m['info'].get('finish'),
                      'tokens': m['info'].get('tokens'), 'parts': parts}, indent=2))
"

echo
echo "==================== assertion ===================="
if grep -q "loop exit with orphaned interrupted tool" "$LOG_DIR/serve.log" \
  && grep -q "exiting loop" "$LOG_DIR/serve.log"; then
  echo "REPRODUCED: 'loop exit with orphaned interrupted tool' + 'exiting loop' present,"
  echo "assistant message above has no text part (silent exit, zero tokens)."
else
  echo "NOT REPRODUCED: expected WARN/INFO lines missing from $LOG_DIR/serve.log"
  exit 1
fi