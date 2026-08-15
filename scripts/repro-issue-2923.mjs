// Reproduction for openchamber/openchamber#2923
//
// [Bug] OpenChamber overwrites opencode.jsonc with empty $schema-only stub,
// wiping all plugins/MCPs/providers.
//
// Mechanism (web server runtime, used by OpenChamber Desktop in-process):
//   1. `readConfigFile` (packages/web/server/lib/opencode/shared.js) parses the
//      user's `~/.config/opencode/opencode.jsonc` with jsonc-parser's `parse()`
//      and IGNORES the returned errors array.
//   2. When the config contains a JSONC construct jsonc-parser cannot fully
//      parse (e.g. an unquoted key — a common JSON5-style hand edit), `parse()`
//      silently returns a PARTIAL object — frequently just
//      `{ "$schema": "https://opencode.ai/config.json" }` when the offending
//      construct sits right after the `$schema` line.
//   3. Any OpenChamber config mutation (Settings → MCP/plugin/provider/agent/
//      command create/edit/delete) then calls `writeConfig(config, filePath)`,
//      which first backs up the ORIGINAL file to `<file>.openchamber.backup`
//      and then overwrites the active config with the truncated object.
//
// This script drives the REAL OpenChamber modules (shared.js/mcp.js) against a
// throwaway HOME and shows the reported end state: the original 1300-line
// config is backed up, and `opencode.jsonc` is replaced by a stub containing
// nothing but `{ "$schema": "https://opencode.ai/config.json" }`.
//
// Run:  node scripts/repro-issue-2923.mjs   (from the repo root; relies on
//       packages/web/node_modules for jsonc-parser/yaml resolution)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MUST run before the first os.homedir() call in this process: shared.js
// computes OPENCODE_CONFIG_DIR from os.homedir() at module-evaluation time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-2923-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { readConfigFile } = await import('../packages/web/server/lib/opencode/shared.js');
const { createMcpConfig, deleteMcpConfig } = await import('../packages/web/server/lib/opencode/mcp.js');

const configDir = path.join(home, '.config', 'opencode');
fs.mkdirSync(configDir, { recursive: true });
const configFile = path.join(configDir, 'opencode.jsonc');

// ---------------------------------------------------------------------------
// Step 1: a fully configured opencode.jsonc, shaped like the reporter's file
// (plugins, MCP servers, custom providers, LSP + compaction settings), with a
// single JSONC construct jsonc-parser cannot parse: an UNQUOTED key with an
// OBJECT value (`plugin: { ... }`) directly after `$schema`. jsonc-parser
// hard-stops there, reports the error, and returns the partial tree parsed so
// far — exactly `{ "$schema": ... }`.
// ---------------------------------------------------------------------------
const fullConfig = `{
  "$schema": "https://opencode.ai/config.json",
  // JSON5-style unquoted key + object value: jsonc-parser cannot parse this,
  // hard-stops, and silently returns only the $schema line above.
  plugin: {
    "opencode-see-image": {},
    "@cortexkit/opencode-magic-context": {},
    "@omniroute/opencode-plugin": {},
    "opencode-throughput": {}
  },
  "mcp": {
    "mysql": { "type": "local", "command": ["npx", "mcp-server-mysql"], "enabled": true },
    "openproject": { "type": "remote", "url": "https://openproject.example/mcp", "enabled": true },
    "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/", "enabled": true },
    "memory": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-memory"], "enabled": true }
  },
  "provider": {
    "ollama-cloud": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama Cloud",
      "options": { "baseURL": "https://ollama.com/" },
      "models": { "llama3.1": { "name": "Llama 3.1" }, "llama3.2": { "name": "Llama 3.2" } }
    }
  },
  "experimental.lsp": { "enabled": true },
  "compaction": { "mode": "auto" }
}
`;

fs.writeFileSync(configFile, fullConfig, 'utf8');
const originalSize = fs.statSync(configFile).size;
console.log(`[1] wrote full config -> ${configFile}`);
console.log(`    size ${originalSize} bytes, ${fullConfig.split('\n').length} lines (plugins + MCPs + providers + LSP + compaction)`);

// ---------------------------------------------------------------------------
// Step 2: what OpenChamber actually sees when it reads the file. The parse
// errors are passed as an array but never inspected, so the truncated partial
// object is treated as the authoritative user config.
// ---------------------------------------------------------------------------
const parsed = readConfigFile(configFile);
console.log(`[2] readConfigFile() -> keys: [${Object.keys(parsed).join(', ')}]`);
console.log(`    parsed object: ${JSON.stringify(parsed)}`);
if (Object.keys(parsed).length !== 1 || parsed.$schema !== 'https://opencode.ai/config.json') {
  console.error('FAIL: expected the parse to be silently truncated to { $schema: ... }');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: a normal, user-facing OpenChamber config mutation (Settings → MCP →
// add a server). This is the read-modify-write that destroys the config: it
// backs up the ORIGINAL 1300-line file, then writes the truncated object.
// ---------------------------------------------------------------------------
createMcpConfig('playwright', { type: 'local', command: ['npx', '@playwright/mcp@latest'], enabled: true });

const backupFile = `${configFile}.openchamber.backup`;
const backupSize = fs.existsSync(backupFile) ? fs.statSync(backupFile).size : 0;
const afterCreate = fs.readFileSync(configFile, 'utf8');
console.log(`[3] createMcpConfig('playwright') ran -> active config replaced`);
console.log(`    backup created: ${backupFile} (${backupSize} bytes, original preserved)`);
console.log(`    opencode.jsonc now (${Buffer.byteLength(afterCreate)} bytes):`);
console.log(afterCreate.replace(/^/gm, '    '));
console.log('    -> plugins, providers, LSP and compaction settings are GONE');

// ---------------------------------------------------------------------------
// Step 4: remove the server that was just added. Every remaining section has
// already been lost, so the file now contains the exact reported stub:
// { "$schema": "https://opencode.ai/config.json" }
// ---------------------------------------------------------------------------
deleteMcpConfig('playwright');
const afterDelete = fs.readFileSync(configFile, 'utf8');
console.log(`[4] deleteMcpConfig('playwright') -> opencode.jsonc now (${Buffer.byteLength(afterDelete)} bytes):`);
console.log(afterDelete.replace(/^/gm, '    '));

const finalObject = JSON.parse(afterDelete);
const isSchemaOnlyStub =
  Object.keys(finalObject).length === 1
  && finalObject.$schema === 'https://opencode.ai/config.json';

console.log(`\nRESULT: ${isSchemaOnlyStub ? 'REPRODUCED' : 'NOT REPRODUCED'}`);
console.log(`  backup preserved the original ${backupSize}-byte config at ${backupFile}`);
console.log(`  active opencode.jsonc reduced to the $schema-only stub (${Buffer.byteLength(afterDelete)} bytes)`);

// ---------------------------------------------------------------------------
// Control: a fully VALID JSONC config survives the same mutation intact. This
// proves the data loss above is caused by the silently-ignored partial parse,
// not by the mutation itself.
// ---------------------------------------------------------------------------
const validConfig = fullConfig.replace(/\n  plugin: \{/, '\n  "plugin": {').replace(/\n  \}/, '\n  }');
fs.writeFileSync(configFile, validConfig, 'utf8');
createMcpConfig('control', { type: 'local', command: ['npx', 'control'], enabled: true });
const afterControl = fs.readFileSync(configFile, 'utf8');
const controlParsed = JSON.parse(afterControl);
const controlPreserved = controlParsed.mcp?.mysql !== undefined
  && controlParsed.provider?.['ollama-cloud'] !== undefined
  && controlParsed['experimental.lsp'] !== undefined
  && controlParsed.compaction !== undefined;
console.log(`\nCONTROL (valid JSONC, same mutation): plugins/MCPs/providers/LSP/compaction preserved = ${controlPreserved}`);

fs.rmSync(home, { recursive: true, force: true });
process.exit(isSchemaOnlyStub && controlPreserved ? 0 : 1);
