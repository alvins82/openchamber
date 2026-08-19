// Verification script for issue #3010
// Claim: "OpenChamber's internal relay server on localhost:8481 fails to start,
//        causing the main Electron process to spam ERR_CONNECTION_REFUSED retries."
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repo = '/home/runner/work/openchamber/openchamber';

// 1) Search the whole repo for the literal port 8481 (excluding node_modules & .git).
const hits = execSync(
  `grep -rn "8481" "${repo}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" ` +
  `--include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.html" ` +
  `2>/dev/null | grep -v node_modules | grep -v '/.git/' || true`,
  { encoding: 'utf8', maxBuffer: 1024 * 1024 },
).trim().split('\n').filter(Boolean);

console.log('== 1) Literal "8481" occurrences in the repo ==');
console.log(hits.length ? hits.join('\n') : '(none)');

// 2) Where does the desktop server actually bind?
const mainSrc = readFileSync(`${repo}/packages/electron/main.mjs`, 'utf8');
const portMatch = mainSrc.match(/const DEFAULT_DESKTOP_PORT\s*=\s*(\d+)/);
console.log('\n== 2) Electron desktop server default port ==');
console.log(`DEFAULT_DESKTOP_PORT = ${portMatch ? portMatch[1] : '???'}`);

// 3) Is the relay an inbound listener or an outbound client?
const hostClient = readFileSync(`${repo}/packages/web/server/lib/relay/host-client.js`, 'utf8');
const service = readFileSync(`${repo}/packages/web/server/lib/relay/service.js`, 'utf8');
const relayDefault = service.match(/DEFAULT_RELAY_URL\s*=\s*'([^']+)'/);
console.log('\n== 3) Relay topology ==');
console.log(`DEFAULT_RELAY_URL = ${relayDefault ? relayDefault[1] : '???'}`);
console.log('host-client creates WebSocket client(s) (outbound):',
  /new WebSocket\(/.test(hostClient));
console.log('host-client calls server.listen / createServer (inbound listener):',
  /\.listen\(|createServer\(/.test(hostClient));
