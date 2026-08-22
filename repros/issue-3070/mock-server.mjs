// Reproduction for openchamber/openchamber#3070
// "Loop exits silently on orphaned interrupted tool — should retry or surface error to user"
//
// A mock OpenAI-compatible chat completions server. It drives the opencode
// agent loop (the runtime OpenChamber launches as a managed process) into the
// exact state the issue reports:
//
//   1. The main tool-using request streams a tool call announcement plus
//      incomplete arguments, so the AI SDK emits tool-input-start but never a
//      complete tool-call. The opencode processor persists a pending tool part.
//   2. After a short delay the connection is destroyed mid-stream. opencode
//      treats the failed stream attempt as retryable and retries the request.
//   3. The retried request completes with an EMPTY response (no text, no tool
//      calls). processor.cleanup() force-marks the abandoned tool part as:
//        { status: "error", input: {}, error: "Tool execution aborted",
//          metadata: { interrupted: true } }
//   4. The run loop sees the finished message with no open tool calls (the
//      orphan is excluded), logs
//        WARN loop exit with orphaned interrupted tool ...
//        INFO exiting loop ...
//      and exits without any assistant output. The user prompt stays
//      unanswered, exactly as in the issue.
//
// Set MODE to "stop" to end request #1 cleanly with finish_reason "stop"
// instead of cutting the connection.

import http from "node:http"

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const MODE = process.env.MOCK_MODE ?? "partial-abort" // "stop" | "abort" | "partial" | "partial-abort"
const TOOL_NAME = process.env.MOCK_TOOL ?? "read"

let requestCount = 0
let toolRequestsSeen = 0

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chatChunk(id, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function streamToolCall(res, id) {
  // role + content preamble
  sse(res, chatChunk(id, { role: "assistant", content: "" }, null))
  // tool call announcement
  sse(
    res,
    chatChunk(
      id,
      {
        tool_calls: [
          { index: 0, id: "call_orphan_1", type: "function", function: { name: TOOL_NAME, arguments: "" } },
        ],
      },
      null,
    ),
  )
  // tool call arguments (empty object, as observed in the issue)
  sse(res, chatChunk(id, { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, null))
}

// Partial-abort mode: announce a tool call, stream incomplete arguments (so
// no tool-call event is ever emitted), give the server time to persist the
// pending part, then hard-close the connection mid-stream.
function streamPartialThenAbort(res, id) {
  sse(res, chatChunk(id, { role: "assistant", content: "" }, null))
  sse(
    res,
    chatChunk(
      id,
      {
        tool_calls: [
          { index: 0, id: "call_orphan_1", type: "function", function: { name: TOOL_NAME, arguments: "" } },
        ],
      },
      null,
    ),
  )
  // incomplete arguments: never valid JSON, tool call never completes
  sse(res, chatChunk(id, { tool_calls: [{ index: 0, function: { arguments: "{" } }] }, null))
}

// Partial mode: same partial tool call but end cleanly with finish "stop".
function streamPartialToolCall(res, id) {
  streamPartialThenAbort(res, id)
  sse(res, chatChunk(id, {}, "stop"))
  res.write("data: [DONE]\n\n")
  res.end()
}

function streamTextAnswer(res, id) {
  sse(res, chatChunk(id, { role: "assistant", content: "Mock text answer." }, null))
  sse(res, chatChunk(id, { content: "" }, "stop"))
  res.write("data: [DONE]\n\n")
  res.end()
}

// Empty answer: no text, no tool calls, finish "stop". Used for retries so
// the retried turn completes without producing any assistant output.
function streamEmptyAnswer(res, id) {
  sse(res, chatChunk(id, { role: "assistant", content: "" }, null))
  sse(res, chatChunk(id, {}, "stop"))
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = http.createServer((req, res) => {
  if (req.url === "/v1/models" || req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }))
    return
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      requestCount++
      const current = requestCount
      const reqBody = JSON.parse(body || "{}")
      const hasTools = Array.isArray(reqBody.tools) && reqBody.tools.length > 0
      console.log(
        `[mock] request #${current} stream=${reqBody.stream} messages=${reqBody.messages?.length} lastRole=${reqBody.messages?.at(-1)?.role} hasTools=${hasTools}`,
      )

      if (!reqBody.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: "Mock text answer." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
        return
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      const id = `chatcmpl-${current}`
      setTimeout(() => {
        // Only the FIRST main tool-using process request gets the truncated
        // tool call; retries (and title/summary requests) get a text answer
        // so the retried turn completes normally.
        if (hasTools && toolRequestsSeen === 0) {
          toolRequestsSeen++
          if (MODE === "partial-abort") {
            streamPartialThenAbort(res, id)
            console.log(`[mock] request #${current} sent partial tool call, aborting after 1.5s`)
            setTimeout(() => {
              console.log(`[mock] request #${current} destroying connection`)
              res.destroy()
            }, 1500)
            return
          }
          if (MODE === "partial") {
            streamPartialToolCall(res, id)
            console.log(`[mock] request #${current} sent partial tool call + finish_reason=stop`)
            return
          }
          if (MODE === "abort") {
            // Hard-close the stream mid-tool-call (no finish chunk, no [DONE]).
            streamToolCall(res, id)
            console.log(`[mock] request #${current} sent tool call then aborted connection mid-stream`)
            res.destroy()
            return
          }
          // "stop" mode: finish with "stop" while the tool call is in-flight.
          streamToolCall(res, id)
          sse(res, chatChunk(id, {}, "stop"))
          res.write("data: [DONE]\n\n")
          res.end()
          console.log(`[mock] request #${current} sent tool call + finish_reason=stop`)
          return
        }
        // Title/summary requests (no tools) get a normal text answer; retries
        // of the main request complete with an EMPTY response so the turn
        // produces no assistant output at all (silent exit).
        if (!hasTools) {
          streamTextAnswer(res, id)
          console.log(`[mock] request #${current} sent plain text answer`)
          return
        }
        streamEmptyAnswer(res, id)
        console.log(`[mock] request #${current} sent empty answer`)
      }, 100)
    })
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }))
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT} mode=${MODE} tool=${TOOL_NAME}`)
})