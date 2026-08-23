# Issue 3093 reproduction: dictation worker exits (SIGTRAP) and speech cuts off

Reproduces the reported bug through the real production path:

```
DictationStreamManager -> DictationWorkerClient -> forked worker-process.js
  -> sherpa-onnx native OfflineRecognizer.decode()
```

## Prerequisites

The native sherpa-onnx addon and a speech model are not installed by default
in this repo (bun resolves `sherpa-onnx-linux-x64` but does not link it).

1. Link the platform addon (adjust path to your bun store):

```sh
ln -s "$(pwd)/node_modules/.bun/sherpa-onnx-linux-x64@1.13.3/node_modules/sherpa-onnx-linux-x64" \
  packages/web/node_modules/sherpa-onnx-linux-x64
```

2. Download and extract the default model (parakeet-tdt-0.6b-v2-int8):

```sh
mkdir -p /tmp/repro-3093-models
cd /tmp/repro-3093-models
curl -L -o parakeet.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
tar xjf parakeet.tar.bz2
```

## Run

```sh
MODELS_DIR=/tmp/repro-3093-models node scripts/repro/issue-3093/repro-worker-crash.mjs
MODELS_DIR=/tmp/repro-3093-models node scripts/repro/issue-3093/repro-extended-dictation.mjs [paceMs] [seconds]
```

Both scripts must run from the repo root with Node (the server runs on Node,
the worker is `child_process.fork`ed).

## Findings

- `repro-worker-crash.mjs`: a committed segment shorter than 100 samples
  (0.00625 s) makes the native decode throw an `Ort::Exception` (invalid
  input shape `{0,128}`) that escapes the NAPI boundary and kills the worker
  process. `decodePcm16` only guards `pcm16.length === 0`, so buffers of
  2..198 bytes reach `recognizer.decode()` unguarded. The parent then emits
  the reported error verbatim (`Dictation worker exited (code null, signal
  SIGABRT)` here; SIGTRAP under Electron's allocator shim).
- `repro-extended-dictation.mjs`: an extended dictation decodes ~60-90 s
  segments; a single such decode balloons the worker's RSS to ~1.8-2 GB and
  the ONNX BFCArena never releases it. Under Electron/Chromium's allocator
  shim (the desktop "in-app browser" the reporter used) oversized arena
  allocations trap with SIGTRAP/EXC_BREAKPOINT, matching the pattern
  documented in issues #2265/#2818 and stablyai/orca#7925.
- The same run also reproduces `Dictation worker request timed out:
  session.commit` when the worker is blocked decoding a long segment past the
  30 s request timeout, which cuts dictation off even without a crash.