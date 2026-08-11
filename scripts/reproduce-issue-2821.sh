#!/bin/bash
# Reproduction for openchamber issue #2821
# "Sessions corrupted after changing git remote in built-in terminal"
#
# Summary
# --------
# OpenCode derives a project's ID from the git remote URL:
#   projectID = sha1("git-remote:" + normalized_origin_url)
# (see packages/core/src/project.ts -> ProjectV2.resolve in the opencode
# 1.18.16 source). Changing `git remote set-url origin <new-url>` therefore
# changes the project ID. On the next directory-scoped request, opencode runs
# Project.fromDirectory -> migrateProjectId, which SELECTs the project rows
# through strict drizzle column decoders (absoluteColumn / absoluteArrayColumn /
# JSON). Any stored value that fails the decoder (e.g. a non-absolute path in
# `worktree` or `sandboxes`, or invalid JSON in `commands`) makes the SELECT
# throw, and every read here is `.pipe(Effect.orDie)`. The instance load for
# the directory then dies, so EVERY directory-scoped endpoint returns
# HTTP 500 `UnknownError` with an `err_<hex>` ref - exactly what the issue
# reports. The failed instance entry is evicted from the cache, so every
# retry re-runs the load and fails again -> "permanently broken".
#
# This script reproduces the exact user-visible symptoms:
#   - ALL directory-scoped endpoints for the affected project return
#     HTTP 500 {"name":"UnknownError","data":{"message":"Unexpected server
#     error. Check server logs for details.","ref":"err_..."}}
#   - the failure persists across OpenChamber restarts
#   - other (healthy) projects keep working
#
# The corrupting data anomaly (here: a non-absolute sandbox entry, written
# directly to the SQLite DB like a legacy/imported row would) is the stand-in
# for the anomalous project row present in the reporter's opencode DB. A clean
# project row migrates fine when the remote changes (verified separately), so
# the reported failure needs the data anomaly to be present in the project row.
#
# Requires: opencode CLI (managed by OpenChamber), node, sqlite3.
# Run from the repo root: bash scripts/reproduce-issue-2821.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/och-issue-2821.XXXXXX)"
PORT="${PORT:-38321}"
BASE="http://127.0.0.1:${PORT}"
CONFIG_DIR="${WORK}/config"
DATA_DIR="${WORK}/data"
CACHE_DIR="${WORK}/cache"

mkdir -p "${CONFIG_DIR}"
cat > "${CONFIG_DIR}/settings.json" <<EOF
{"projects":[
  {"id":"broken-project","path":"${WORK}/broken","label":"broken"},
  {"id":"healthy-project","path":"${WORK}/healthy","label":"healthy"}
]}
EOF

echo "==> workdir: ${WORK}"
echo "==> setting up git repos (broken project starts with an OLD remote)"

# --- the project whose remote will be changed ---
mkdir -p "${WORK}/broken"
git -C "${WORK}/broken" init -q
git -C "${WORK}/broken" config user.email "repro@test.local"
git -C "${WORK}/broken" config user.name "repro"
git -C "${WORK}/broken" remote add origin "git@github.com:old-user/old-repo.git"
echo "x" > "${WORK}/broken/file.txt"
git -C "${WORK}/broken" add -A
git -C "${WORK}/broken" commit -qm init

# --- a healthy control project ---
mkdir -p "${WORK}/healthy"
git -C "${WORK}/healthy" init -q
git -C "${WORK}/healthy" config user.email "repro@test.local"
git -C "${WORK}/healthy" config user.name "repro"
git -C "${WORK}/healthy" remote add origin "https://github.com/healthy-user/healthy-repo.git"
echo "x" > "${WORK}/healthy/file.txt"
git -C "${WORK}/healthy" add -A
git -C "${WORK}/healthy" commit -qm init

echo "==> starting OpenChamber (this starts its managed opencode server)"

setsid env XDG_CONFIG_HOME="${CONFIG_DIR}" XDG_DATA_HOME="${DATA_DIR}" \
  XDG_CACHE_HOME="${CACHE_DIR}" \
  OPENCHAMBER_MANAGED_PROCESS_REGISTRY="${DATA_DIR}/managed" \
  OPENCHAMBER_RUNTIME=web \
  node "${ROOT}/packages/web/bin/cli.js" serve --port "${PORT}" --host 127.0.0.1 \
  --foreground --ui-password testpass > "${WORK}/openchamber.log" 2>&1 < /dev/null &
OCH_PID=$!
trap 'kill ${OCH_PID} 2>/dev/null || true' EXIT

echo "==> waiting for OpenChamber to become ready"
for _ in $(seq 1 60); do
  if curl -sf -m 2 "${BASE}/health" > /dev/null 2>&1; then break; fi
  sleep 1
done

cookie="${WORK}/cookies.txt"
curl -s -m 5 -X POST "${BASE}/auth/session" -H "Content-Type: application/json" \
  -d '{"password":"testpass"}' -c "${cookie}" -o /dev/null
AUTH="Cookie: oc_ui_session=$(awk '$6=="oc_ui_session"{print $7}' "${cookie}")"

enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }
BROKEN_ENC="$(enc "${WORK}/broken")"
HEALTHY_ENC="$(enc "${WORK}/healthy")"

echo "==> creating a session in both projects (healthy baseline)"
curl -s -m 30 -X POST "${BASE}/api/session?directory=${BROKEN_ENC}" -H "${AUTH}" \
  -H "Content-Type: application/json" -d "{\"directory\":\"${WORK}/broken\",\"title\":\"repro\"}" -o /dev/null -w "  create broken: %{http_code}\n"
curl -s -m 30 -X POST "${BASE}/api/session?directory=${HEALTHY_ENC}" -H "${AUTH}" \
  -H "Content-Type: application/json" -d "{\"directory\":\"${WORK}/healthy\",\"title\":\"repro\"}" -o /dev/null -w "  create healthy: %{http_code}\n"

echo "==> session list before corruption (expect 200)"
curl -s -m 30 "${BASE}/api/session?directory=${BROKEN_ENC}&limit=200" -H "${AUTH}" -o /dev/null -w "  broken session list: HTTP %{http_code}\n"

echo "==> simulate the reporter's git remote change in the built-in terminal"
git -C "${WORK}/broken" remote set-url origin "git@github.com:new-user/new-repo.git"

echo "==> (data anomaly present in the reporter's opencode DB - reproduced by"
echo "     corrupting the project row's sandboxes with a non-absolute path)"
DB="${DATA_DIR}/opencode/opencode.db"
PROJECT_ID="$(sqlite3 "${DB}" "SELECT id FROM project WHERE worktree='${WORK}/broken';")"
echo "  broken project id: ${PROJECT_ID}"
sqlite3 "${DB}" "UPDATE project SET sandboxes='[\"relative/path\"]' WHERE id='${PROJECT_ID}';"

echo "==> restart OpenChamber (the user restarts the app)"
kill "${OCH_PID}" 2>/dev/null || true
wait "${OCH_PID}" 2>/dev/null || true
sleep 2
setsid env XDG_CONFIG_HOME="${CONFIG_DIR}" XDG_DATA_HOME="${DATA_DIR}" \
  XDG_CACHE_HOME="${CACHE_DIR}" \
  OPENCHAMBER_MANAGED_PROCESS_REGISTRY="${DATA_DIR}/managed" \
  OPENCHAMBER_RUNTIME=web \
  node "${ROOT}/packages/web/bin/cli.js" serve --port "${PORT}" --host 127.0.0.1 \
  --foreground --ui-password testpass > "${WORK}/openchamber2.log" 2>&1 < /dev/null &
OCH_PID=$!
for _ in $(seq 1 60); do
  if curl -sf -m 2 "${BASE}/health" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -s -m 5 -X POST "${BASE}/auth/session" -H "Content-Type: application/json" \
  -d '{"password":"testpass"}' -c "${cookie}" -o /dev/null
AUTH="Cookie: oc_ui_session=$(awk '$6=="oc_ui_session"{print $7}' "${cookie}")"

echo ""
echo "==> AFTER RESTART: endpoints the issue reports failing for that project =="
for label_url in \
  "session list|/api/session?directory=${BROKEN_ENC}&limit=200" \
  "experimental session list|/api/experimental/session?directory=${BROKEN_ENC}&archived=false&roots=true&limit=500" \
  "session status|/api/session/status?directory=${BROKEN_ENC}" \
  "config providers|/api/config/providers?directory=${BROKEN_ENC}" \
  "agents|/api/agent?directory=${BROKEN_ENC}" \
  "questions|/api/question?directory=${BROKEN_ENC}" \
  "permissions|/api/permission?directory=${BROKEN_ENC}" ; do
  label="${label_url%%|*}"
  url="${label_url#*|}"
  body="$(curl -s -m 40 "${BASE}${url}" -H "${AUTH}")"
  code="$(curl -s -m 40 -o /dev/null -w "%{http_code}" "${BASE}${url}" -H "${AUTH}")"
  echo "  ${label}: HTTP ${code}  ${body}"
done

SID="$(sqlite3 "${DB}" "SELECT id FROM session WHERE project_id='${PROJECT_ID}' LIMIT 1;")"
echo "  session.get (per-session): HTTP $(curl -s -m 40 -o /dev/null -w "%{http_code}" "${BASE}/api/session/${SID}?directory=${BROKEN_ENC}" -H "${AUTH}")"
echo "  session messages: HTTP $(curl -s -m 40 -o /dev/null -w "%{http_code}" "${BASE}/api/session/${SID}/message?directory=${BROKEN_ENC}&limit=50" -H "${AUTH}")"

echo ""
echo "==> healthy control project (issue reports these keep working) =="
echo "  healthy session list: HTTP $(curl -s -m 40 -o /dev/null -w "%{http_code}" "${BASE}/api/session?directory=${HEALTHY_ENC}&limit=200" -H "${AUTH}")"
echo "  healthy agents: HTTP $(curl -s -m 40 -o /dev/null -w "%{http_code}" "${BASE}/api/agent?directory=${HEALTHY_ENC}" -H "${AUTH}")"

echo ""
echo "==> underlying opencode defect (from opencode server log) =="
sleep 2   # let the opencode log flush the error entries
grep "level=ERROR" "${DATA_DIR}/opencode/log/opencode.log" | tail -1 \
  | python3 -c "import sys,re; line=sys.stdin.read(); m=re.search(r'error=\"([^\"]{0,220})', line); print('  ' + (m.group(1) if m else line[:220]))" || true

echo ""
echo "==> expected result: every broken-project endpoint above is HTTP 500 with"
echo "    {\"name\":\"UnknownError\",\"data\":{\"message\":\"Unexpected server error."
echo "    Check server logs for details.\",\"ref\":\"err_...\"}} while the healthy"
echo "    project returns 200. Workdir kept at: ${WORK}"
