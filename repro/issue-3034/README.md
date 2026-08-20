# Reproduction: issue #3034 — concurrent sessions share one git working tree

Two OpenChamber sessions created in the same project directory share the same
git working tree. There is no isolation, no lock, and no warning. When one
session runs `git checkout` (or any branch-switching git command), the other
session's working tree silently relocates to the new branch. Files committed
moments earlier appear to vanish, and tooling (file reads, tests, indexing)
silently reads the wrong branch.

## How to run

```
bash repro.sh
```

The script builds a throwaway git repo with two branches, puts Session A on
`feature/branch-a` with committed work, then has Session B run
`git checkout feature/branch-b` in the same working tree. It shows Session A's
files silently disappearing / changing with no warning.

## Where the isolation is missing (OpenChamber code)

- `packages/ui/src/sync/session-actions.ts` -> `createSession` (lines ~724-757)
  creates the session against the resolved project directory with no worktree
  provisioning, no lock, and no warning about an existing session in the same
  working tree.
- `packages/ui/src/sync/session-ui-store.ts` -> `createSession` (lines ~1578-1603)
  resolves the draft directory (normally the current project directory) and
  calls the action above. Nothing checks for a concurrent session on the same
  directory.
- Worktree isolation exists only in the separate opt-in "multi-run" flow:
  `packages/ui/src/stores/useMultiRunStore.ts` (line 159,
  `shouldIsolateRuns`). Plain session creation never isolates.

Because OpenChamber routes every session in a directory to the same OpenCode
server / working directory, `git checkout` performed by one agent mutates the
shared tree seen by every other session. This is data-loss class: uncommitted
changes can be stashed or dropped during recovery, and wrong-branch reads look
correct with no error surfaced.
