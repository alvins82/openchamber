#!/usr/bin/env node
// Fake "opencode" CLI used to reproduce issue #2870.
//
// The real opencode CLI:
//   - `opencode --version` prints the CLI version
//   - `opencode serve --hostname H --port P` prints
//     "opencode server listening on http://H:P" to stdout and serves the
//     OpenCode HTTP API, including GET /global/health which returns
//     { healthy: true, version: "<cli version>" }.
//
// This fake binary mimics exactly those two observable behaviors. Its version
// is driven by the FAKE_OPENCODE_VERSION env var so we can stage two binaries:
// the OpenChamber-bundled CLI (1.18.16) and the user's newer PATH install
// (1.18.18).
import http from 'node:http';

const version = process.env.FAKE_OPENCODE_VERSION || '0.0.0';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (args[0] !== 'serve') {
  process.stderr.write(`fake opencode: unsupported args: ${args.join(' ')}\n`);
  process.exit(1);
}

const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : 0;
const hostIndex = args.indexOf('--hostname');
const hostname = hostIndex >= 0 ? args[hostIndex + 1] : '127.0.0.1';

const server = http.createServer((req, res) => {
  if (req.url === '/global/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({}));
});

server.listen(port, hostname, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  process.stdout.write(`opencode server listening on http://${hostname}:${actualPort}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
