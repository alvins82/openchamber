/**
 * Repro for issue #3093, part 1: dictation worker dies natively during a
 * segment decode.
 *
 * A tiny loud segment (1-99 samples, 2-198 bytes of PCM16) is committed on
 * finish. sherpa-onnx's sync decode throws an Ort::Exception (invalid input
 * shape {0,128}) that is NOT caught in the native NAPI wrapper
 * (DecodeOfflineStreamWrapper has no try/catch), so std::terminate kills the
 * worker process. The worker client then reports the issue's error verbatim:
 *   Dictation worker exited (code null, signal SIGTRAP)
 * (on plain Node/Linux the signal is SIGABRT; under Electron's allocator
 * shim the same native-death class surfaces as SIGTRAP).
 *
 * Requires the sherpa-onnx platform addon and a speech model, see README.md.
 */
import { DictationWorkerClient, WorkerBackedTranscriptionSession } from '../../../packages/web/server/lib/dictation/local/worker-client.js';
import { DictationStreamManager } from '../../../packages/web/server/lib/dictation/stream-manager.js';

const MODELS_DIR = process.env.MODELS_DIR || '/tmp/repro-3093-models';
const MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';

function tinyLoudChunkBase64(samples) {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? 8000 : -8000; // peak 8000 >= silence threshold 300
  }
  return Buffer.from(arr.buffer).toString('base64');
}

async function main() {
  const workerClient = new DictationWorkerClient();
  const session = new WorkerBackedTranscriptionSession(workerClient, {
    modelsDir: MODELS_DIR,
    modelId: MODEL_ID,
  });

  const messages = [];
  const manager = new DictationStreamManager({
    emit: (msg) => messages.push(msg),
    createSttSession: async () => {
      await session.connect();
      return { session };
    },
  });

  const dictationId = 'dic_tiny_segment';
  await manager.handleStart(dictationId, 'audio/pcm;rate=16000;bits=16', {});

  const deadline = Date.now() + 120000;
  while (!workerClient.worker && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const worker = workerClient.worker;
  if (!worker) {
    console.log('FATAL: no worker (addon/model missing? see README.md)');
    process.exit(2);
  }
  console.log(`worker pid=${worker.pid}`);
  worker.on('close', (code, signal) => {
    console.log(`>>> WORKER CLOSED code=${code} signal=${signal}`);
  });
  worker.stderr?.on('data', (d) => process.stderr.write(`[worker] ${d}`));

  // One tiny loud chunk, then finish. The manager commits the tail because
  // bytesSinceCommit > 0 and peak >= 300.
  manager.handleChunk({ dictationId, seq: 0, audioBase64: tinyLoudChunkBase64(50) });
  console.log('sent 50-sample chunk, finishing...');
  manager.handleFinish(dictationId, 0);

  await new Promise((r) => setTimeout(r, 30000));

  const errorMsg = messages.find((m) => m.type === 'error');
  console.log('error message:', errorMsg ? JSON.stringify(errorMsg.payload) : null);
  console.log('worker state:', { exitCode: worker.exitCode, signalCode: worker.signalCode });
  workerClient.shutdown();

  // Expected: error "Dictation worker exited (code null, signal ...)".
  process.exit(errorMsg ? 1 : 0);
}

main().catch((err) => {
  console.error('REPRO FAILED:', err);
  process.exit(2);
});