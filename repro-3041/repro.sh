#!/usr/bin/env bash
# Repro for openchamber#3041: why OS-level voice dictation (Windows Voice
# access, macOS Voice Control/dictation) stops working in the chat prompt box
# but keeps working in notes, todos, plans, and terminal.
#
# The chat composer migrated to a CodeMirror editor (v1.17.0) which renders its
# editable surface as a `contenteditable` div. Notes/todos/plans are native
# <textarea> elements and the terminal is xterm.js (native input handling).
# OS dictation types into the focused NATIVE editable control, which is why the
# one place that fails is the CodeMirror composer.
#
# Run: bash repro.sh   (prints the DOM evidence as JSON)
set -euo pipefail
cd "$(dirname "$0")"

# 1. Bundle CodeMirror exactly as the composer uses it (@codemirror/state + view).
(
  cd ../packages/ui
  bun build ../../repro-3041/editor-bundle.js --outfile=../../repro-3041/codemirror.bundle.js --format=iife >/dev/null
  bun build ../../repro-3041/editor-bundle.js --outfile=../../repro-3041/editor-bundle.mjs --format=esm >/dev/null
)

# 2. Serve the page.
python3 -m http.server 8791 --directory . >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

# 3. Render headless and extract the report.
CHROME="${CHROME:-chromium}"
"$CHROME" --headless --no-sandbox --disable-gpu --virtual-time-budget=8000 \
  --dump-dom http://localhost:8791/index.html 2>/dev/null \
  | sed -n '/<pre id="report">/,/<\/pre>/p' | sed '1d;$d'
