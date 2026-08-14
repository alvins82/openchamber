// Reproduction for openchamber issue #2915
//
// Title: [Bug] API proxy opens a new TCP connection per request, exhausting ephemeral ports
//
// Claimed root cause:
//   The createProxyMiddleware call site in
//   packages/web/server/lib/opencode/proxy.js (~line 770) is constructed without an
//   `agent` option. http-proxy@1.18.1 treats a missing agent as `agent: false`,
//   which disables connection pooling AND forces `Connection: close` on every
//   proxied request. Result: a brand-new TCP connection (and ephemeral port) per
//   API request. Under sustained volume the host ephemeral port pool drains into
//   TIME_WAIT and every process on the machine starts failing outbound connects
//   with EADDRNOTAVAIL.
//
// What this script does:
//   1. Starts a stand-in "opencode serve" HTTP/1.1 upstream on 127.0.0.1 that
//      honors keep-alive (Node default) and counts TCP connections + records the
//      `connection` request header it receives.
//   2. Mounts the REAL `registerOpenCodeProxy` (unmodified source) in front of it
//      and sends N sequential requests through a keep-alive client.
//   3. Measures how many TCP connections the upstream had to accept and what
//      `connection` header each request carried.
//   4. Runs two controls through identical middleware options:
//        (a) no agent  -> expected to behave exactly like the real module
//        (b) keep-alive http.Agent (the proposed fix) -> expected to reuse a
//            single connection for all N requests.
//
// Expected buggy result (real module + control (a)):
//   connections == N (one fresh TCP connection per request),
//   every request arrives with `connection: close`.
// Expected fixed result (control (b)):
//   connections == 1, requests arrive with `connection: keep-alive`.
//
// Run: bun repro/issue-2915/proxy-agent-repro.mjs

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { registerOpenCodeProxy } from '../../packages/web/server/lib/opencode/proxy.js';

const N = 20;
const IDENT = 'repro-2915';

let log = (msg) => console.log(`[${IDENT}] ${msg}`);

// Count TCP sockets in TIME_WAIT that involve the upstream listening port on
// either end (the proxy is the client, so on Linux the TIME_WAIT usually shows
// with the proxy's ephemeral port as Local and the target port as Peer; on
// macOS the reporter observed it on the server side). Either way, every
// churned connection leaves one TIME_WAIT tuple behind until it drains.
const countTimeWaitInvolvingPort = (targetPort) => {
  try {
    const out = execFileSync('ss', ['-tan'], { encoding: 'utf8' });
    let count = 0;
    for (const line of out.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      // `ss -tan` columns: State Recv-Q Send-Q Local Address:Port Peer Address:Port
      const state = parts[0];
      const local = parts[3] ?? '';
      const peer = parts[4] ?? '';
      if (state === 'TIME-WAIT' && (local.endsWith(`:${targetPort}`) || peer.endsWith(`:${targetPort}`))) {
        count += 1;
      }
    }
    return count;
  } catch {
    return -1; // ss unavailable
  }
};

// ---------------------------------------------------------------------------
// Stand-in for `opencode serve`: plain HTTP/1.1 server, default keep-alive.
// Counts accepted TCP connections and records the `connection` header seen on
// each request.
// ---------------------------------------------------------------------------
const startTargetServer = () =>
  new Promise((resolve) => {
    const state = { connections: 0, connectionHeaders: [] };
    const server = http.createServer((req, res) => {
      state.connectionHeaders.push(String(req.headers.connection || '').toLowerCase());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, n: state.connectionHeaders.length }));
    });
    server.on('connection', () => {
      state.connections += 1;
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });

// ---------------------------------------------------------------------------
// Client: a single HTTP client with keep-alive so the only party capable of
// forcing per-request connection churn is the proxy under test.
// ---------------------------------------------------------------------------
const sendRequests = async (port, n) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const bodies = [];
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/repro-${i}`,
          method: 'GET',
          agent,
          headers: { accept: 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            bodies.push(data);
            resolve();
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }
  agent.destroy();
  return bodies;
};

// ---------------------------------------------------------------------------
// Deps for the REAL registerOpenCodeProxy. Mirrors server-utils-runtime.js.
// ---------------------------------------------------------------------------
const buildRealProxyApp = async (targetPort) => {
  const app = express();
  const runtimeState = {
    openCodePort: targetPort,
    openCodeBaseUrl: null,
    isOpenCodeReady: true,
    isRestartingOpenCode: false,
    openCodeNotReadySince: 0,
  };
  registerOpenCodeProxy(app, {
    fs: await import('node:fs'),
    os: await import('node:os'),
    path: await import('node:path'),
    OPEN_CODE_READY_GRACE_MS: 60_000,
    LONG_REQUEST_TIMEOUT_MS: 240_000,
    getRuntime: () => runtimeState,
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (p = '/') => `http://127.0.0.1:${targetPort}${p.startsWith('/') ? p : `/${p}`}`,
    ensureOpenCodeApiPrefix: () => {},
    getSseUpstreamStallTimeoutMs: () => 60_000,
  });
  return app;
};

// ---------------------------------------------------------------------------
// Controls: the exact same middleware options as proxy.js `createApiProxy`,
// with and without the keep-alive agent.
// ---------------------------------------------------------------------------
const buildControlApp = async (targetPort, { withAgent = false } = {}) => {
  const app = express();
  const options = {
    target: `http://127.0.0.1:${targetPort}`,
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    timeout: 240_000,
    proxyTimeout: 240_000,
    router: () => `http://127.0.0.1:${targetPort}`,
  };
  if (withAgent) {
    options.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: Infinity,
      maxFreeSockets: 32,
    });
  }
  app.use('/api', createProxyMiddleware(options));
  return app;
};

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });

const close = (server) =>
  new Promise((resolve) => server.close(() => resolve()));

const run = async (name, app, targetState, targetPort) => {
  const { server, port } = await listen(app);
  const before = targetState.connections;
  const timeWaitBefore = countTimeWaitInvolvingPort(targetPort);
  await sendRequests(port, N);
  // allow TIME_WAIT/close bookkeeping to settle
  await new Promise((r) => setTimeout(r, 300));
  const newConnections = targetState.connections - before;
  const headersSeen = targetState.connectionHeaders.slice(targetState.connectionHeaders.length - N);
  const timeWait = countTimeWaitInvolvingPort(targetPort) - timeWaitBefore;
  await close(server);
  log(`${name}: upstream accepted ${newConnections} new TCP connection(s) for ${N} sequential requests`);
  log(`${name}: connection header seen upstream on each request: ${[...new Set(headersSeen)].join(', ')}`);
  log(`${name}: TIME_WAIT sockets involving upstream port created by this run: ${timeWait}`);
  return { newConnections, headersSeen, timeWait };
};

// ---------------------------------------------------------------------------
const main = async () => {
  const { server: target, port: targetPort, state } = await startTargetServer();
  log(`upstream (stand-in for opencode serve) listening on 127.0.0.1:${targetPort}`);

  const real = await run('REAL registerOpenCodeProxy (no agent option)', await buildRealProxyApp(targetPort), state, targetPort);
  const buggyControl = await run('CONTROL createProxyMiddleware without agent', await buildControlApp(targetPort), state, targetPort);
  const fixedControl = await run('CONTROL createProxyMiddleware with keep-alive agent', await buildControlApp(targetPort, { withAgent: true }), state, targetPort);

  await close(target);

  console.log('\n=== Summary ===');
  console.log(`REAL proxy        : ${real.newConnections} connections / ${N} requests (connection: ${[...new Set(real.headersSeen)].join(',')}; new TIME_WAIT: ${real.timeWait})`);
  console.log(`Control (no agent): ${buggyControl.newConnections} connections / ${N} requests (connection: ${[...new Set(buggyControl.headersSeen)].join(',')}; new TIME_WAIT: ${buggyControl.timeWait})`);
  console.log(`Control (agent)   : ${fixedControl.newConnections} connections / ${N} requests (connection: ${[...new Set(fixedControl.headersSeen)].join(',')}; new TIME_WAIT: ${fixedControl.timeWait})`);

  const buggy = real.newConnections;
  const fixed = fixedControl.newConnections;
  if (buggy === N && real.headersSeen.every((h) => h === 'close') && fixed === 1) {
    console.log('\nREPRODUCED: the real proxy opens one fresh TCP connection per request and forces');
    console.log('`Connection: close` upstream (one TIME_WAIT tuple per request). A keep-alive');
    console.log('agent reuses a single connection, confirming the missing `agent` option is');
    console.log('the root cause.');
    process.exitCode = 0;
  } else {
    console.log('\nUnexpected measurements — inspect output above.');
    process.exitCode = 2;
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
