/**
 * Repro for issue #2977 — Bug 1.
 *
 * The OS `openchamber://connect` deep-link handler
 * (`parseConnectPairingDeepLinkPayload` in packages/electron/main.mjs:2016)
 * maps every pairing candidate the same way regardless of `type` and requires a
 * `.url` field. Relay-type candidates never carry `.url` — they carry
 * `relayUrl` / `serverId` / `hostEncPubJwk` (see `buildRelayPairingCandidate()`
 * in packages/web/bin/lib/commands-connect-url.js:80). So the relay leg is
 * silently dropped from every link opened via the OS URL scheme, and a
 * loopback-only direct candidate leaves a payload with zero reachable
 * candidates: `[electron] connect pairing deep-link has no reachable candidate`.
 *
 * The functions below are copied VERBATIM from packages/electron/main.mjs
 * (main.mjs cannot be imported directly: it imports `electron` at top level).
 * The in-app Import Link parser is the REAL module
 * (packages/ui/src/lib/connectionPayload.ts), imported via bun.
 *
 * Run: bun repro/issue-2977/deep-link-relay-dropped.mjs
 */

import { parsePairingConnectionPayload } from '../../packages/ui/src/lib/connectionPayload.ts';

const DEEP_LINK_PROTOCOL = 'openchamber';

// ---- Verbatim from packages/electron/main.mjs:628 ----------------------------------
const normalizeHostUrl = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

// ---- Verbatim from packages/electron/main.mjs:2006 ---------------------------------
const decodeBase64UrlJson = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const json = Buffer.from(value.trim(), 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// ---- Verbatim from packages/electron/main.mjs:2016 ---------------------------------
const parseConnectPairingDeepLinkPayload = (raw) => {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== `${DEEP_LINK_PROTOCOL}:` || url.hostname !== 'connect') return null;
    if (url.searchParams.get('v') !== '2') return null;
    const payload = decodeBase64UrlJson(url.searchParams.get('p') || '');
    if (!payload || payload.v !== 2 || typeof payload !== 'object') return null;
    const pairingId = typeof payload.pairingId === 'string' ? payload.pairingId.trim() : '';
    const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
    if (!pairingId || !secret) return null;
    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const type = candidate.type === 'lan' || candidate.type === 'tunnel' || candidate.type === 'relay'
          ? candidate.type
          : null;
        const candidateUrl = normalizeHostUrl(candidate.url || '');
        if (!type || !candidateUrl) return [];
        const priority = Number.isFinite(candidate.priority) ? candidate.priority : 100;
        return [{ type, url: candidateUrl, priority }];
      })
      : [];
    if (candidates.length === 0) return null;
    const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt.trim() : '';
    if (expiresAt) {
      const expiresTime = Date.parse(expiresAt);
      if (!Number.isFinite(expiresTime) || expiresTime <= Date.now()) return null;
    }
    return {
      pairingId,
      secret,
      label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : 'OpenChamber',
      fingerprint: typeof payload.fingerprint === 'string' && payload.fingerprint.trim() ? payload.fingerprint.trim() : '',
      expiresAt: expiresAt || null,
      candidates: candidates.sort((left, right) => left.priority - right.priority),
    };
  } catch {
    return null;
  }
};

// ---- Verbatim from packages/electron/main.mjs:2090 ---------------------------------
const requestJsonWithTimeout = async (url, init = {}, timeoutMs = 8000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
};

// ---- Verbatim from packages/electron/main.mjs:2102 ---------------------------------
const selectPairingCandidateUrl = async (payload) => {
  for (const candidate of payload.candidates || []) {
    try {
      const health = await requestJsonWithTimeout(`${candidate.url.replace(/\/+$/g, '')}/health`, { method: 'GET' }, 3500);
      if (health.ok) return candidate.url.replace(/\/+$/g, '');
    } catch {
    }
  }
  return null;
};

// ---- Mirror of the host CLI link generation ----------------------------------------
// packages/web/bin/lib/commands-connect-url.js:
//   - resolveConnectUrlServerUrl() for a loopback-bound host returns
//     `http://127.0.0.1:<port>` (buildLocalUrl) → a `lan` candidate with priority 10.
//   - buildRelayPairingCandidate() emits `{ type:'relay', relayUrl, serverId,
//     hostEncPubJwk, priority: 30 }` (DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws').
//   - buildPairingPayload() + encodePairingConnectUrl() → `openchamber://connect?v=2&p=…`
const encodePairingConnectUrl = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `openchamber://connect?v=2&p=${encoded}`;
};

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' };

const cliLink = encodePairingConnectUrl({
  v: 2,
  pairingId: 'pair_loopback_with_relay',
  secret: 'one-time-secret',
  label: 'macbook',
  fingerprint: 'ABCD-1234',
  expiresAt: '2099-01-01T00:00:00.000Z',
  candidates: [
    // Host bound to 127.0.0.1: this "lan" address only resolves on the host itself.
    { type: 'lan', url: 'http://127.0.0.1:4096', priority: 10 },
    // buildRelayPairingCandidate() output — no `.url` field by design.
    { type: 'relay', relayUrl: 'wss://relay.openchamber.dev/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
  ],
});

const relayOnlyLink = encodePairingConnectUrl({
  v: 2,
  pairingId: 'pair_relay_only',
  secret: 'one-time-secret',
  label: 'macbook',
  candidates: [
    { type: 'relay', relayUrl: 'wss://relay.openchamber.dev/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
  ],
});

const printJson = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
};

console.log('Issue #2977 — Bug 1: OS deep-link handler drops relay candidates');
console.log('================================================================');

printJson('CLI-generated link (loopback host + --relay), exactly as the host emits it', cliLink);

// 1. Electron OS deep-link parser (verbatim).
const parsedByElectron = parseConnectPairingDeepLinkPayload(cliLink);
printJson(
  'Electron OS deep-link parser: parseConnectPairingDeepLinkPayload() (VERBATIM from main.mjs:2016)',
  parsedByElectron ? {
    pairingId: parsedByElectron.pairingId,
    label: parsedByElectron.label,
    candidates: parsedByElectron.candidates,
  } : null,
);
console.log('\n>>> Relay candidate DROPPED: { type: "relay", relayUrl: "wss://relay.openchamber.dev/ws", '
  + 'serverId: "srv_abc", hostEncPubJwk: {...}, priority: 30 } — because candidate.url is undefined, '
  + 'normalizeHostUrl(candidate.url || "") returns null and the candidate is filtered out.');

// 2. Live candidate selection (verbatim) — the loopback URL is unreachable from any
//    machine other than the host itself.
console.log('\n--- selectPairingCandidateUrl(): live probe of each surviving candidate ---');
const picked = await selectPairingCandidateUrl(parsedByElectron);
console.log('probed candidates:', parsedByElectron.candidates.map((c) => `${c.type} ${c.url}/health`).join(' | '));
printJson('selected serverUrl (null ⇒ "[electron] connect pairing deep-link has no reachable candidate")', picked);

// 3. The same link through the in-app Import Link parser (REAL module).
const parsedByUi = parsePairingConnectionPayload(cliLink);
printJson(
  'In-app Import Link parser: parsePairingConnectionPayload() (REAL source, packages/ui/src/lib/connectionPayload.ts)',
  parsedByUi ? {
    pairingId: parsedByUi.pairingId,
    label: parsedByUi.label,
    candidates: parsedByUi.candidates,
  } : null,
);
console.log('\n>>> The relay candidate is KEPT by the in-app parser — the identical link works when pasted '
  + 'into Settings → Remote Instances → Import Link, but is silently unusable when opened as a URL.');

// 4. Relay-only link: the Electron parser rejects the entire payload.
const relayOnlyParsed = parseConnectPairingDeepLinkPayload(relayOnlyLink);
printJson(
  'Relay-only link through the Electron OS deep-link parser (no direct candidate at all)',
  relayOnlyParsed,
);
console.log('\n>>> candidates.length === 0 ⇒ parseConnectPairingDeepLinkPayload() returns null ⇒ '
  + 'dispatchDeepLink logs "[electron] invalid connect deep-link payload" — a perfectly valid '
  + 'relay-only pairing link is rejected outright by the OS path.');
