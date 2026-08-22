// Reproduction for https://github.com/openchamber/openchamber/issues/3068
//
// Reported: in "Add a device" (Settings → Remote Instances → Connect to this
// server), the "Home network only" option is always grayed out, and picking
// "Anywhere" still routes all traffic through the relay instead of the local
// network.
//
// Root cause (verified against a live server, see below):
//   The server advertises its pairing transports via
//   GET /api/client-auth/pairing/transports. `resolvePairingTransports`
//   (packages/web/server/index.js:1499) returns `lan: null` whenever the
//   server is bound to loopback (127.0.0.1, the default bind; or
//   localhost/::1). The "Add a device" dialog (RemoteInstancesPage.tsx) then
//   disables the "Home network only" radio (`available: Boolean(transportOptions?.lanUrl)`)
//   and, for the "Anywhere" default, drops the LAN candidate from the pairing
//   link (`includeDirect = false`), so paired devices always ride the relay.
//
// Live verification performed on the real server code:
//   loopback bind (default):   curl /api/client-auth/pairing/transports
//     => {"local":"http://127.0.0.1:3789","lan":null,"relayAvailable":true}
//   network-exposed bind:      OPENCHAMBER_HOST=0.0.0.0 + same endpoint
//     => {"local":"http://127.0.0.1:3789","lan":"http://10.1.0.250:3789","relayAvailable":true}
//
// This script replays the exact decision logic from both files to show how a
// loopback-bound server produces both reported symptoms.

import { isNetworkExposedBindHost } from '../packages/web/server/lib/security/bind-host.js';
import os from 'node:os';

// ---- Verbatim copy of packages/web/server/index.js:1492-1529 ----
const requestReachedLanAddress = (req) => {
  const raw = typeof req?.socket?.localAddress === 'string' ? req.socket.localAddress : '';
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
  if (address.startsWith('127.')) return null;
  return address;
};

const resolvePairingTransports = (req, effectiveBindHost, port) => {
  const activePort = port;
  const local = `http://127.0.0.1:${activePort}`;
  let lanHost = null;
  if (isNetworkExposedBindHost(effectiveBindHost)) {
    lanHost = requestReachedLanAddress(req);
    try {
      if (!lanHost) {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const entry of (list || [])) {
            if (entry.family === 'IPv4' && !entry.internal) { lanHost = entry.address; break; }
          }
          if (lanHost) break;
        }
      }
    } catch {
      lanHost = null;
    }
  } else {
    const h = String(effectiveBindHost || '').toLowerCase();
    if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') lanHost = effectiveBindHost;
  }
  const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort}` : null;
  return { local, lan, relayAvailable: true };
};

// ---- Verbatim decision logic from RemoteInstancesPage.tsx ----
// resolveTransportOptions maps the API response { local, lan, relayAvailable }
// to the dialog state (RemoteInstancesPage.tsx:853-872):
//   { localUrl: transports.local, lanUrl: transports.lan, relayAvailable }
const toTransportOptions = (transports) => ({
  localUrl: transports.local,
  lanUrl: transports.lan,
  relayAvailable: transports.relayAvailable,
});

// Dialog option availability (RemoteInstancesPage.tsx:1702-1717):
//   { key: 'lan', available: Boolean(transportOptions?.lanUrl) }
//   <Radio disabled={!option.available} ... />  +  opacity-45 on the row
const lanOptionAvailable = (transportOptions) => Boolean(transportOptions?.lanUrl);

// "Anywhere" link candidate mapping (RemoteInstancesPage.tsx:906-914):
//   else if (addDeviceFallback && transportOptions.lanUrl) { serverUrl = lanUrl; includeRelay = true }
//   else { includeDirect = false; includeRelay = true }   // relay only
const mapAnywhereTransport = (transportOptions) => {
  const addDeviceTransport = 'relay';
  const addDeviceFallback = true; // the dialog default
  if (addDeviceTransport === 'local') {
    return { serverUrl: transportOptions.localUrl ?? undefined, includeRelay: false };
  } else if (addDeviceTransport === 'lan') {
    return { serverUrl: transportOptions.lanUrl ?? undefined, includeRelay: addDeviceFallback };
  } else if (addDeviceFallback && transportOptions.lanUrl) {
    return { serverUrl: transportOptions.lanUrl, includeRelay: true }; // carry both
  }
  return { includeDirect: false, includeRelay: true }; // relay only
};

const describe = (bindHost) => {
  // UI request over loopback (desktop UI loads on 127.0.0.1) => req.socket.localAddress = '127.0.0.1'
  const req = { socket: { localAddress: '127.0.0.1' } };
  const transports = resolvePairingTransports(req, bindHost, 3789);
  const transportOptions = toTransportOptions(transports);
  const anywhere = mapAnywhereTransport(transportOptions);
  return {
    bindHost,
    transports,
    lanOptionAvailable: lanOptionAvailable(transportOptions),
    anywhereLinkCarriesLanCandidate: anywhere.includeDirect !== false && Boolean(anywhere.serverUrl),
    anywhereSummary: JSON.stringify(anywhere),
  };
};

const loopback = describe('127.0.0.1');
const exposed = describe('0.0.0.0');

console.log('=== Server bind -> "Add a device" behavior (issue #3068) ===\n');
for (const r of [loopback, exposed]) {
  console.log(`bind host: ${r.bindHost}`);
  console.log(`  transports endpoint:            ${JSON.stringify(r.transports)}`);
  console.log(`  "Home network only" selectable: ${r.lanOptionAvailable}`);
  console.log(`  "Anywhere" link LAN candidate:  ${r.anywhereLinkCarriesLanCandidate}`);
  console.log(`  "Anywhere" mapping:             ${r.anywhereSummary}`);
  console.log('');
}

// Assertions: the exact symptoms from the report reproduce on the default bind.
const failures = [];
if (loopback.lanOptionAvailable !== false) failures.push('loopback bind must gray out "Home network only"');
if (loopback.anywhereLinkCarriesLanCandidate !== false) failures.push('loopback bind must produce a relay-only "Anywhere" link');
if (exposed.lanOptionAvailable !== true) failures.push('network-exposed bind must enable "Home network only"');
if (exposed.anywhereLinkCarriesLanCandidate !== true) failures.push('network-exposed bind must carry the LAN candidate in "Anywhere"');

if (failures.length > 0) {
  console.error('Reproduction assertions failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('Reproduced: on the default loopback bind, "Home network only" is disabled and');
console.log('"Anywhere" yields a relay-only link. Both reported symptoms trace to lan: null');
console.log('from GET /api/client-auth/pairing/transports.');