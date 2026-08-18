/**
 * Repro for issue #2977 — Bug 2.
 *
 * Once paired, "activating" a host through Electron's `switchToHostById`
 * (packages/electron/main.mjs:2135) never consults `host.relay`:
 *
 *   targetUrl  = shouldUsePackagedUi() ? buildPackagedUiUrl('/index.html') : host.url;
 *   apiBaseUrl = host.apiUrl || host.url;   // relay is never consulted here
 *
 * This is the code path that runs after a successful OS deep-link pairing
 * (dispatchDeepLink → importConnectDeepLink → switchToHostById(id)) and for the
 * `openchamber://host/<id>` action. A host entry that carries a fully valid
 * relay descriptor alongside a stale/dead direct `apiUrl` is therefore
 * activated against the dead URL — the renderer's fetch to /api/system/info
 * fails ("Failed to fetch") even though the relay is reachable, exactly as
 * reported. By contrast, openMainWindow (main.mjs:2700), DesktopHostSwitcher
 * handleSwitch (packages/ui/src/components/desktop/DesktopHostSwitcher.tsx:448)
 * and restoreDesktopRelayRuntime (packages/ui/src/lib/desktopRelayRestore.ts)
 * all special-case relay hosts.
 *
 * Functions are copied VERBATIM from packages/electron/main.mjs (main.mjs
 * cannot be imported directly: it imports `electron` at top level).
 * sanitizeRuntimeRequestHeaders is imported from its real module.
 *
 * Run: bun repro/issue-2977/switch-relay-ignored.mjs
 */

import { sanitizeRuntimeRequestHeaders } from '../../packages/electron/runtime-request-headers.mjs';

const LOCAL_HOST_ID = 'local';

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

// ---- Verbatim from packages/electron/main.mjs:641 ----------------------------------
const sanitizeHostUrlForStorage = (raw) => normalizeHostUrl(raw);
const sanitizeClientTokenForStorage = (raw) => {
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length > 0 ? token : null;
};

// ---- Verbatim from packages/electron/main.mjs:718 ----------------------------------
const sanitizeHostRelayForStorage = (value) => {
  if (!value || typeof value !== 'object') return null;
  const relayUrl = typeof value.relayUrl === 'string' ? value.relayUrl.trim() : '';
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  const jwk = value.hostEncPubJwk;
  if (!relayUrl || !serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  // Minimal EC public JWK shape check so a malformed descriptor is rejected at
  // storage time instead of surfacing later as a tunnel handshake failure.
  if (typeof jwk.kty !== 'string' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string') return null;
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  } catch {
    return null;
  }
  return { relayUrl, serverId, hostEncPubJwk: jwk };
};

// ---- Verbatim from packages/electron/main.mjs:741 ----------------------------------
const buildStoredHostEntry = (entry) => {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!id || id === LOCAL_HOST_ID) return null;
  const clientToken = sanitizeClientTokenForStorage(entry?.clientToken);
  const requestHeaders = sanitizeRuntimeRequestHeaders(entry?.requestHeaders);
  const headerFields = Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {};
  const tokenField = clientToken ? { clientToken } : {};
  const labelRaw = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : '';

  const relay = sanitizeHostRelayForStorage(entry?.relay);
  const relayField = relay ? { relay } : {};
  const directUrl = sanitizeHostUrlForStorage(entry?.url);
  const apiUrl = directUrl ? (sanitizeHostUrlForStorage(entry?.apiUrl) || directUrl) : null;

  if (directUrl) {
    return { id, label: labelRaw || directUrl, url: directUrl, apiUrl, ...tokenField, ...headerFields, ...relayField };
  }
  if (relay) {
    const url = `relay://${relay.serverId}`;
    return { id, label: labelRaw || url, url, ...tokenField, ...headerFields, relay };
  }
  return null;
};

// ---- Verbatim from packages/electron/main.mjs:2135 (decision logic for the
// non-local host branch — relay is never consulted) ---------------------------------
const switchToHostByIdDecision = (config, id) => {
  const host = config.hosts.find((entry) => entry.id === id);
  if (!host) {
    return { error: `[electron] deep-link host not found: ${id}` };
  }
  const targetUrl = host.url;
  const apiBaseUrl = host.apiUrl || host.url;
  const clientToken = host.clientToken || '';
  const requestHeaders = sanitizeRuntimeRequestHeaders(host.requestHeaders || {});
  if (!targetUrl || !apiBaseUrl) {
    return { error: '[electron] deep-link host has no target URL: ' + id };
  }
  return {
    bootOutcome: { target: 'remote', status: 'ok', hostId: id, url: apiBaseUrl },
    targetUrl,
    apiBaseUrl,
    clientToken,
    requestHeaders,
    relay: host.relay || null, // present on the stored entry but NEVER consulted above
  };
};

const printJson = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
};

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' };

console.log('Issue #2977 — Bug 2: switchToHostById() ignores host.relay on activation');
console.log('=======================================================================');

// 1. Stored host entry exactly like the reporter's settings.json: a fully valid relay
//    descriptor saved alongside a (now dead) direct tunnel address.
const multiTransportHostRaw = {
  id: 'host-tunnel-paired',
  label: 'macbook',
  url: 'http://127.0.0.1:4096',          // the temporary direct tunnel (now dead)
  apiUrl: 'http://127.0.0.1:4096',
  clientToken: 'desktop-client-token',
  relay: { relayUrl: 'wss://relay.openchamber.dev/ws', serverId: 'srv_abc', hostEncPubJwk },
};
const storedHost = buildStoredHostEntry(multiTransportHostRaw);
printJson('Stored host entry (buildStoredHostEntry, VERBATIM main.mjs:741) — relay survives storage', storedHost);
console.log('\n>>> The relay descriptor is valid and persisted alongside the direct URL '
  + '(sanitizeHostRelayForStorage accepts it), matching the reporter\'s settings.json.');

// 2. switchToHostById decision (verbatim logic) — relay never consulted.
const decision = switchToHostByIdDecision({ hosts: [storedHost] }, storedHost.id);
printJson('switchToHostById() activation decision (VERBATIM logic, main.mjs:2135)', decision);
console.log('\n>>> apiBaseUrl = host.apiUrl || host.url = "http://127.0.0.1:4096" — the DEAD tunnel address. '
  + 'host.relay is present but never read. relay field shown above only for comparison; the shipped '
  + 'code does not look at it at all.');

// 3. Live proof: the renderer's fetch against the chosen apiBaseUrl fails.
console.log('\n--- live fetch to the apiBaseUrl switchToHostById picked ---');
try {
  const response = await fetch(`${decision.apiBaseUrl}/api/system/info`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  console.log(`fetch → HTTP ${response.status}`);
} catch (error) {
  console.log(`fetchThrew: ${JSON.stringify(error && error.message ? error.message : String(error))}`);
  console.log('(connection refused — 127.0.0.1:4096 is only reachable from the host machine, '
    + 'and the tunnel that made it work is dead)');
}
console.log('>>> The renderer that activateMainWindow() points at this apiBaseUrl gets exactly '
  + '`fetchThrew: "Failed to fetch"`, matching the issue report — even though host.relay is '
  + 'valid and reachable.');

// 4. Relay-only host: even more clear-cut. buildStoredHostEntry gives relay-only hosts a
//    display-only `relay://<serverId>` pseudo-URL (main.mjs:758-761). switchToHostById
//    would use that pseudo-URL as the API base.
const relayOnlyHost = buildStoredHostEntry({
  id: 'host-relay-only',
  label: 'macbook',
  url: 'relay://srv_abc',
  clientToken: 'desktop-client-token',
  relay: { relayUrl: 'wss://relay.openchamber.dev/ws', serverId: 'srv_abc', hostEncPubJwk },
});
printJson('Relay-only host entry (buildStoredHostEntry — display pseudo-URL)', relayOnlyHost);
const relayOnlyDecision = switchToHostByIdDecision({ hosts: [relayOnlyHost] }, relayOnlyHost.id);
printJson('switchToHostById() decision for the relay-only host', {
  targetUrl: relayOnlyDecision.targetUrl,
  apiBaseUrl: relayOnlyDecision.apiBaseUrl,
});
try {
  await fetch(`${relayOnlyDecision.apiBaseUrl}/api/system/info`, { signal: AbortSignal.timeout(3000) });
} catch (error) {
  console.log(`fetch('relay://srv_abc/api/system/info') threw: ${JSON.stringify(error && error.message ? error.message : String(error))}`);
}
console.log('\n>>> `relay://` is a display-only pseudo-URL (never fetched); using it as the API base '
  + 'can never reach the server. openMainWindow() instead boots the LOCAL UI for this host and lets '
  + 'the renderer restore the tunnel via restoreDesktopRelayRuntime()/switchRuntimeEndpoint({ relay }) '
  + '(main.mjs:2711-2724) — switchToHostById just does not participate in that design.');

// 5. Contrast with the relay-aware paths.
console.log('\n--- Contrast: relay-aware activation paths ---');
console.log('- openMainWindow() (main.mjs:2711): "if (relayHost) { … activateMainWindow(localUiUrl, …) }" — '
  + 'boots local UI, renderer re-opens the E2EE tunnel.');
console.log('- restoreDesktopRelayRuntime() (ui/src/lib/desktopRelayRestore.ts): probes the direct apiUrl '
  + 'first, falls back to switchRuntimeEndpoint({ relay: host.relay, … }) when unreachable.');
console.log('- DesktopHostSwitcher.handleSwitch (ui/src/components/desktop/DesktopHostSwitcher.tsx:448): '
  + 'same probe-direct → relay-fallback flow.');
console.log('- switchToHostById() (main.mjs:2135): apiBaseUrl = host.apiUrl || host.url. NO relay fallback — '
  + 'this is the path used after OS deep-link pairing (dispatchDeepLink → importConnectDeepLink → '
  + 'switchToHostById) and by the openchamber://host/<id> action.');
