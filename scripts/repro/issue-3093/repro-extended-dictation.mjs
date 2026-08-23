/**
 * Repro for issue #3093, part 2: extended dictation memory and timeout
 * behavior.
 *
 * Drives the real worker with an extended synthetic dictation at (optionally
 * accelerated) real-time pacing. Logs:
 *   - commit segment sizes (the 60 s / 90 s segmentation bounds),
 *   - worker RSS (a single long-segment decode balloons it to ~1.8-2 GB and
 *     the ONNX BFCArena never releases it),
 *   - "Dictation worker request timed out: session.commit" when the worker
 *     is still blocked decoding a long segment past the 30 s request
 *     timeout, which cuts dictation off.
 *
 * Under Electron's allocator shim (the desktop "in-app browser" the reporter
 * used), oversized arena allocations trap with SIGTRAP/EXC_BREAKPOINT
 * instead of throwing bad_alloc, killing the worker and producing the exact
 * reported message.
 *
 * Requires the sherpa-onnx platform addon and a speech model, see README.md.
 */
import { DictationWorkerClient, WorkerBackedTranscriptionSession } from '../../../packages/web/server/lib/dictation/local/worker-client.js';
import { DictationStreamManager } from '../../../packages/web/server/lib/dictation/stream-manager.js';
import fs from 'fs';

const MODELS_DIR = process.env.MODELS_DIR || '/tmp/repro-3093-models';
const MODEL_ID = 'parakeet-tdt-0.6b-v2-int8';
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = SAMPLE_RATE; // ~1s per chunk, like the web client

function speechLikeChunk(seedState) {
  const out = new Int16Array(CHUNK_SAMPLES);
  for (let i = 0; i < CHUNK_SAMPLES; i += 1) {
    seedState.s = (seedState.s * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seedState.s / 0x7fffffff) * 2 - 1;
    const t = i / SAMPLE_RATE;
    const mod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t);
    const tone = Math.sin(2 * Math.PI * 180 * t) * 0.5 + noise * 0.5;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(tone * mod * 32000)));
  }
  return out;
}

const silentChunk = () => new Int16Array(CHUNK_SAMPLES);
const chunkToBase64 = (chunk) => Buffer.from(chunk.buffer).toString('base64');

const rssOf = (pid) => {
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
    return Math.round((parseInt(statm[1], 10) * 4096) / 1024 / 1024);
  } catch {
    return -1;
  }
};

const PACE_MS = Number(process.argv[2] || 100);
const TOTAL_SECONDS = Number(process.argv[3] || 480);

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

  const dictationId = 'dic_repro_3093';
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
  console.log(`session started, worker pid=${worker.pid}`);

  worker.on('close', (code, signal) => {
    console.log(`>>> WORKER CLOSED code=${code} signal=${signal}`);
  });
  worker.stderr?.on('data', (d) => process.stderr.write(`[worker] ${d}`));

  let t = 0;
  const origCommit = session.commit.bind(session);
  const origClear = session.clear.bind(session);
  let bytesAtCommit = 0;
  let commitIdx = 0;
  session.commit = () => {
    commitIdx += 1;
    console.log(
      `commit#${commitIdx} at t=${t}s bytesSinceCommit=${bytesAtCommit} (${(bytesAtCommit / 32000).toFixed(1)}s)`,
    );
    origCommit();
  };
  session.clear = () => {
    console.log(`clear at t=${t}s`);
    origClear();
  };

  const seedState = { s: 987654321 };
  let seq = 0;
  let nextReport = 0;

  while (t < TOTAL_SECONDS) {
    const inSilence = t % 30 >= 28 && t % 30 < 29; // 1s silence every 30s
    const chunk = inSilence ? silentChunk() : speechLikeChunk(seedState);
    manager.handleChunk({ dictationId, seq, audioBase64: chunkToBase64(chunk) });
    seq += 1;
    t += 1;

    const state = manager.streams.get(dictationId);
    if (state) {
      bytesAtCommit = state.bytesSinceCommit;
    }

    if (t >= nextReport) {
      nextReport = t + 60;
      const rss = rssOf(worker.pid);
      const errs = messages.filter((m) => m.type === 'error');
      console.log(
        `t=${String(t).padStart(4)}s seq=${seq} workerRss=${rss >= 0 ? `${rss}MB` : 'n/a'} exit=${worker.exitCode} sig=${worker.signalCode} errors=${errs.length}`,
      );
      if (errs.length > 0) {
        console.log('ERROR MSGS:', JSON.stringify(errs));
        break;
      }
    }
    if (worker.exitCode !== null || worker.signalCode !== null) {
      console.log(`WORKER DIED at t=${t}: code=${worker.exitCode} signal=${worker.signalCode}`);
      break;
    }

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  console.log('--- finish ---');
  manager.handleFinish(dictationId, seq - 1);
  await new Promise((r) => setTimeout(r, 60000));

  const finalMsg = messages.find((m) => m.type === 'final');
  const errorMsg = messages.find((m) => m.type === 'error');
  console.log('final:', finalMsg ? `textLen=${finalMsg.payload.text.length}` : null);
  console.log('error:', errorMsg ? JSON.stringify(errorMsg.payload) : null);
  console.log('worker state:', { exitCode: worker.exitCode, signalCode: worker.signalCode });
  workerClient.shutdown();
  process.exit(errorMsg ? 1 : 0);
}

main().catch((err) => {
  console.error('REPRO FAILED:', err);
  process.exit(2);
});