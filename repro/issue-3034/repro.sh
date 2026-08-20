#!/usr/bin/env bash
# Reproduction for OpenChamber issue #3034
#
# Two OpenChamber sessions (A and B) share ONE git working tree when they are
# created in the same project directory. OpenChamber's createSession path
# (packages/ui/src/sync/session-actions.ts -> createSession) provisions no
# worktree, no lock, and no warning. A `git checkout` run by one session
# silently relocates the other session's working tree.
#
# This script reproduces the exact failure the reporter describes:
#   - Session A is on feature/branch-a and has committed work (run.py,
#     src/followup_runner.py).
#   - Session B runs `git checkout feature/branch-b` in the SAME directory.
#   - Session A's files silently disappear: HEAD now points at a branch that
#     never had them, and tooling reads the wrong branch with no error.

set -euo pipefail

echo "=== Setup: git repo with two branches, no worktrees, no isolation ==="
rm -rf wt
git init -q -b main wt
git -C wt config user.email a@b.c
git -C wt config user.name Repro

git -C wt checkout -q -b feature/branch-a
mkdir -p wt/src
printf 'run.py (Session A work)\n' > wt/run.py
printf 'followup (Session A work)\n' > wt/src/followup_runner.py
git -C wt add -A
git -C wt commit -qm "branch-a: session A committed work"

git -C wt checkout -q -b feature/branch-b
printf 'run.py (branch B, different)\n' > wt/run.py
# branch-b NEVER has src/followup_runner.py — it only exists on branch-a
git -C wt rm -q --cached src/followup_runner.py
rm wt/src/followup_runner.py
git -C wt add -A
git -C wt commit -qm "branch-b: different run.py (no followup_runner)"

echo
echo "=== Session A: working on feature/branch-a ==="
git -C wt checkout -q feature/branch-a
echo "Session A sees these files (branch-a):"
git -C wt ls-files | sed 's/^/  /'
echo "  run.py content: $(cat wt/run.py)"

echo
echo "=== Session B (same directory, no warning/lock from OpenChamber) ==="
echo "Session B runs: git checkout feature/branch-b"
git -C wt checkout -q feature/branch-b

echo
echo "=== Result: Session A's working tree now shows branch-b ==="
echo "HEAD: $(git -C wt branch --show-current)"
echo "Session A's files that are now MISSING from the working tree:"
for f in run.py src/followup_runner.py; do
  if [ ! -f "wt/$f" ]; then
    echo "  MISSING: $f"
  else
    echo "  present: $f -> $(cat "wt/$f")"
  fi
done

echo
echo "=== Demonstrating silent wrong-branch reads (Session A tooling) ==="
echo "run.py as Session A's tooling would now read it:"
if [ -f wt/run.py ]; then cat wt/run.py; else echo "  (file does not exist)"; fi
echo "src/followup_runner.py exists? $([ -f wt/src/followup_runner.py ] && echo yes || echo NO)"

echo
echo "=== Uncommitted work check ==="
git -C wt checkout -q feature/branch-a
echo "After switching back to branch-a, uncommitted changes from the recovery:"
git -C wt status --short | sed 's/^/  /' || true
