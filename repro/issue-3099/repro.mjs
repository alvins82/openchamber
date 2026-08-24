// Reproduction for issue #3099: staging many files fails with `spawn ENAMETOOLONG`.
//
// Root cause: OpenChamber stages files by building a single `git add -- <p1> <p2> ...`
// command with every file path as a separate argv element (see
// packages/vscode/src/gitService.ts -> execGit/spawn, and
// packages/web/server/lib/git/service.js -> runGitCommand/simple-git execFile).
// When the combined command line exceeds the OS argument-list limit (ARG_MAX),
// the spawn/execFile fails. Node/libuv surfaces this as `spawn ENAMETOOLONG` on
// macOS (default kern.argmax 256KB) and `spawn E2BIG` on Linux (ARG_MAX ~2-4MB),
// which is why it trips far earlier for the macOS Desktop user with 778 files.
//
// On a Linux box with a 4MB ARG_MAX this needs ~15k long paths to trip; on macOS
// the same failure occurs with only a few hundred. Run with COUNT to tune.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-git-'));

spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });

const count = Number(process.env.COUNT || 15000);
const args = ['add', '--'];
const longSegment = 'x'.repeat(100);
for (let i = 0; i < count; i++) {
  const rel = `${longSegment}/${longSegment}/${i.toString().padStart(4, '0')}-${longSegment}.txt`;
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `file ${i}`);
  args.push(rel);
}

const argvBytes = args.reduce((s, a) => s + a.length + 1, 0);
console.log(`staging ${count} files; total argv bytes ~ ${argvBytes}`);

// execFile path (web/desktop server via simple-git). spawn (VS Code gitService)
// throws the same way, on macOS as `spawn ENAMETOOLONG`.
try {
  await execFileAsync('git', args, { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  console.log('execFile git add: SUCCESS');
} catch (e) {
  console.log('execFile git add: FAILED');
  console.log('  code:', e.code);
  console.log('  message:', e.message?.split('\n')[0]);
}
