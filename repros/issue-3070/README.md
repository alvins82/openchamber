# Repro for #3070: Loop exits silently on orphaned interrupted tool

End-to-end reproduction of openchamber/openchamber#3070 using the opencode
runtime that OpenChamber launches as a managed process.

## How to run

```sh
bun repros/issue-3070/reproduce.sh   # or: bash repros/issue-3070/reproduce.sh
```

Requirements: an `opencode` CLI on `PATH` (any recent version; verified with
1.18.21), `node`, `curl`. Everything runs in a throwaway config/data home; the
real opencode setup is untouched. The mock provider is a plain
OpenAI-compatible HTTP server, no credentials needed.

The script starts the mock provider + `opencode serve`, sends one user message
through the HTTP API, then prints the loop log lines and the persisted
assistant message.

## What it shows

The assistant message persisted after the turn:

```json
{
  "type": "tool",
  "tool": "read",
  "callID": "call_orphan_1",
  "state": {
    "status": "error",
    "input": {},
    "error": "Tool execution aborted",
    "metadata": { "interrupted": true },
    "time": { "start": 1787392868553, "end": 1787392868553 }
  }
}
```

No text part, zero tokens, `finish: "stop"`. The serve log shows:

```
WARN loop exit with orphaned interrupted tool session.id=... tool=read callID=call_orphan_1
INFO exiting loop session.id=...
```

The user prompt stays unanswered: no assistant text, no error surfaced, no
retry, and the interrupted tool is never fed back to the model as a
`tool_result`, so the model cannot self-correct.

## Mechanism

The interrupted tool part is produced by the opencode processor's `cleanup()`
(`packages/opencode/src/session/processor.ts`), which force-marks any
in-flight tool call as `status: "error"`, `error: "Tool execution aborted"`,
`metadata: { interrupted: true }` when a stream attempt ends (error, abort, or
retry) before the tool completes.

The silent exit is the opencode run loop (`packages/opencode/src/session/prompt.ts`):

```ts
const hasToolCalls =
  lastAssistantMsg?.parts.some(
    (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
  ) ?? false

if (
  lastAssistant?.finish &&
  !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastAssistant.parentID === lastUser.id
) {
  const orphan = lastAssistantMsg?.parts.find(...)
  if (orphan) {
    yield* Effect.logWarning("loop exit with orphaned interrupted tool", { ... })
  }
  yield* Effect.logInfo("exiting loop", { ... })
  break
}
```

Orphaned interrupted tools are excluded from `hasToolCalls`, so a message whose
only tool is the orphan is judged "finished" and the loop breaks with no output
instead of feeding a `tool_result` error back to the model.

## How the mock triggers it

`mock-server.mjs` streams a tool call announcement plus incomplete arguments
(never-valid JSON), so the provider emits `tool-input-start` but never a
complete `tool-call`. The pending tool part is persisted by the processor.
After 1.5 s the connection is destroyed mid-stream. opencode treats the failed
attempt as retryable (`retry.ts` matches "socket connection was closed") and
retries; the retried request completes with an empty response, so the turn ends
with `finish: "stop"` and no assistant text, and `cleanup()` marks the
abandoned tool as interrupted.

## Notes

- The bug lives in the opencode agent loop, not in OpenChamber's own code;
  OpenChamber launches this runtime as a managed process and proxies its SSE
  events to the UI, so the empty result is what the UI renders.
- `MOCK_MODE=stop` (instead of `partial-abort`) ends the first request cleanly
  with `finish_reason: "stop"`; the AI SDK then executes the tool call, which
  produces a normal tool error rather than the orphaned state. The
  `partial-abort` mode is the faithful reproduction of the reported behavior.
- Verified with opencode 1.18.21 on Linux. `time.start == time.end` matches the
  issue's observation of an instant abort with empty input.