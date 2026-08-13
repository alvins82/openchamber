// Reproduction for openchamber/openchamber issue #2870
// "[Bug] 调用opencode的版本不对" (The version of opencode being called is wrong)
//
// Reported (OpenChamber Desktop 1.18.2, macOS):
//   - About dialog shows: OpenChamber 版本 1.18.2 / OpenCode 版本 1.18.16
//   - The user's installed OpenCode is v1.18.18 (latest at the time)
//
// This script demonstrates the code path behind that report:
//   OpenChamber Desktop prefers its BUNDLED opencode CLI (1.18.16, pinned to
//   the @opencode-ai/sdk dependency) over a user-installed, newer opencode on
//   PATH (1.18.18). Therefore:
//     1. `resolveOpencodeCliPath()` returns the bundled binary, and
//     2. the managed OpenCode server that gets spawned reports version
//        "1.18.16" via GET /global/health — exactly what
//        /api/opencode/upgrade-status (`currentVersion`) and the About dialog
//        display — even though the user's opencode is the newer 1.18.18.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServerSrc = path.join(here, 'fake-opencode-server.mjs');
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// Stage two fake opencode binaries
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-2870-repro-'));
const bundledDir = path.join(root, 'bundled-opencode-cli');
const userBinDir = path.join(root, 'user-bin');
fs.mkdirSync(bundledDir, { recursive: true });
fs.mkdirSync(userBinDir, { recursive: true });

const installFake = (dir, version) => {
  const entry = path.join(dir, 'opencode');
  const serverBin = path.join(dir, 'opencode-server-bin');
  fs.copyFileSync(fakeServerSrc, serverBin);
  fs.chmodSync(serverBin, 0o755);
  // The real bundled CLI has no FAKE_OPENCODE_VERSION override; we must bake
  // the version in per-install. Use a wrapper that sets it then runs the
  // server logic.
  const wrapper = `#!/bin/sh\nFAKE_OPENCODE_VERSION=${version} exec "${serverBin}" "$@"\n`;
  fs.writeFileSync(entry, wrapper);
  fs.chmodSync(entry, 0o755);
  return entry;
};

const bundledBinary = installFake(bundledDir, '1.18.16'); // OpenChamber Desktop 1.18.2 bundles opencode 1.18.16
const userBinary = installFake(userBinDir, '1.18.18'); // user's newer opencode on PATH

const versionOf = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();

const bundledVersion = versionOf(bundledBinary);
const userVersion = versionOf(userBinary);
console.log(`staged bundled opencode CLI  : ${bundledBinary} -> ${bundledVersion}`);
console.log(`staged user PATH opencode CLI : ${userBinary} -> ${userVersion}`);

// Simulate the desktop runtime: bundled CLI present in resources, and the
// user's newer binary first on PATH. (Keep node on PATH for the fake shim.)
const nodeBinDir = path.dirname(process.execPath);
process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
process.env.PATH = [userBinDir, nodeBinDir, '/usr/bin', '/bin'].join(path.delimiter);
delete process.env.OPENCODE_BINARY;
delete process.env.OPENCODE_PATH;
delete process.env.OPENCHAMBER_OPENCODE_PATH;
delete process.env.OPENCHAMBER_OPENCODE_BIN;

// ---------------------------------------------------------------------------
// 1) Binary resolution used by the desktop runtime
// ---------------------------------------------------------------------------
const { createOpenCodeEnvRuntime } = await import(
  path.join(repoRoot, 'packages/web/server/lib/opencode/env-runtime.js')
);

const state = {
  resolvedOpencodeBinary: null,
  resolvedOpencodeBinarySource: null,
  useWslForOpencode: false,
  resolvedWslBinary: null,
  resolvedWslOpencodePath: null,
  resolvedWslDistro: null,
  cachedLoginShellEnvSnapshot: undefined,
  resolvedGitBinary: null,
};

const envRuntime = createOpenCodeEnvRuntime({
  state,
  normalizeDirectoryPath: (v) => v,
  readSettingsFromDiskMigrated: async () => ({}),
});

const resolved = envRuntime.resolveOpencodeCliPath();
const resolvedVersion = versionOf(resolved);
console.log('\n[1] resolveOpencodeCliPath() ->', resolved);
console.log(`    source: ${state.resolvedOpencodeBinarySource}, version: ${resolvedVersion}`);
console.log(`    (user's PATH opencode is ${userBinary} -> ${userVersion})`);

if (resolvedVersion === userVersion) {
  console.log('    UNEXPECTED: newer user binary was selected.');
} else {
  console.log(`    => OpenChamber calls the bundled opencode ${resolvedVersion}, NOT the user's ${userVersion}.`);
}

// ---------------------------------------------------------------------------
// 2) What the About dialog reports: version from the spawned server's health
// ---------------------------------------------------------------------------
const { createOpenCodeLifecycleRuntime } = await import(
  path.join(repoRoot, 'packages/web/server/lib/opencode/lifecycle.js')
);
const { createOpenCodeNetworkRuntime } = await import(
  path.join(repoRoot, 'packages/web/server/lib/opencode/network-runtime.js')
);

const lifecycleState = {
  openCodeWorkingDirectory: os.homedir(),
  openCodeProcess: null,
  openCodePort: null,
  openCodeBaseUrl: null,
  currentRestartPromise: null,
  isRestartingOpenCode: false,
  openCodeApiPrefix: '',
  openCodeApiPrefixDetected: false,
  openCodeApiDetectionTimer: null,
  lastOpenCodeError: null,
  lastOpenCodeLaunchDiagnostics: null,
  isOpenCodeReady: false,
  openCodeNotReadySince: 0,
  isExternalOpenCode: false,
  isShuttingDown: false,
  healthCheckInterval: null,
  useWslForOpencode: false,
  resolvedWslBinary: null,
  resolvedWslOpencodePath: null,
  resolvedWslDistro: null,
};

const networkRuntime = createOpenCodeNetworkRuntime({
  state: lifecycleState,
  getOpenCodeAuthHeaders: () => ({}),
  configuredOpenCodeHostname: '127.0.0.1',
});

const lifecycleRuntime = createOpenCodeLifecycleRuntime({
  state: lifecycleState,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT: 0,
    ENV_CONFIGURED_OPENCODE_HOST: null,
    ENV_EFFECTIVE_PORT: 0,
    ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
    ENV_SKIP_OPENCODE_START: false,
  },
  syncToHmrState: () => {},
  syncFromHmrState: () => {},
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: networkRuntime.buildOpenCodeUrl,
  waitForReady: networkRuntime.waitForReady,
  normalizeApiPrefix: networkRuntime.normalizeApiPrefix,
  applyOpencodeBinaryFromSettings: envRuntime.applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv: envRuntime.ensureOpencodeCliEnv,
  ensureLocalOpenCodeServerPassword: async () => 'repro-password',
  resolveManagedOpenCodeLaunchSpec: (binary) => ({ binary, args: [], wrapperType: null }),
  setOpenCodePort: (port) => { lifecycleState.openCodePort = port; },
  setDetectedOpenCodeApiPrefix: networkRuntime.setDetectedOpenCodeApiPrefix,
  setupProxy: () => {},
  ensureOpenCodeApiPrefix: networkRuntime.ensureOpenCodeApiPrefix,
  clearResolvedOpenCodeBinary: () => {},
  buildAugmentedPath: () => [userBinDir, nodeBinDir, '/usr/bin', '/bin'].join(path.delimiter),
  buildManagedOpenCodePath: () => [userBinDir, nodeBinDir, '/usr/bin', '/bin'].join(path.delimiter),
  getManagedOpenCodeShellEnvSnapshot: () => ({}),
  getManagedOpenCodeEnv: async () => ({}),
  getWarmupDirectories: async () => [],
  now: Date.now,
});

console.log('\n[2] starting managed OpenCode server (desktop runtime path)...');
const serverInstance = await lifecycleRuntime.startOpenCode();
console.log('    spawned server URL:', serverInstance.url);

const healthResponse = await fetch(`${serverInstance.url.replace(/\/+$/, '')}/global/health`, {
  headers: { Accept: 'application/json' },
});
const health = await healthResponse.json();
console.log(`    GET /global/health -> healthy=${health.healthy}, version=${health.version}`);
console.log('    (this version is what /api/opencode/upgrade-status returns as');
console.log('     currentVersion, which the About dialog renders as "OpenCode 版本")');

console.log('\nSUMMARY:');
console.log(`  user-installed opencode : ${userVersion}`);
console.log(`  opencode OpenChamber calls & reports : ${health.version}`);
console.log(health.version === userVersion
  ? '  => versions match.'
  : `  => MISMATCH: OpenChamber calls opencode ${health.version} while the user's opencode is ${userVersion}.`);

await serverInstance.close();
fs.rmSync(root, { recursive: true, force: true });
