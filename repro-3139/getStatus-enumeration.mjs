/**
 * Reproduction for openchamber/openchamber#3139
 *
 * "Project-wide file scanning persists ..."
 *
 * Hypothesis: OpenChamber's Git status path (`getStatus` in
 * packages/web/server/lib/git/service.js) enumerates and reads files under
 * project directories, including generated/dependency directories that are not
 * gitignored. It runs `git status -uall` (which lists EVERY untracked file
 * individually, not just top-level untracked directories) and then, in full
 * (non-light) mode, `stat`s and reads the contents of up to 200 of those
 * untracked files to compute line counts.
 *
 * The reporter's `eslogger open` captured ~9.6k file-open events under
 * `yanxilu/android/app/build` and ~10.5k under `yanxilu/android`. Those counts
 * are consistent with `git status -uall` enumerating every file under an
 * un-ignored generated directory (build output, node_modules, etc.) and then
 * `getStatus` reading up to 200 of them per call.
 *
 * This script reproduces the mechanism deterministically on a synthetic repo:
 * it creates a repo with generated directories that are NOT gitignored, then
 * calls the real `getStatus` and records how many untracked files are
 * enumerated and how many are actually opened/read.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- build a synthetic project ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-3139-'));
const project = path.join(root, 'yanxilu');
fs.mkdirSync(project, { recursive: true });

// tracked source file
fs.writeFileSync(path.join(project, 'README.md'), '# yanxilu\n');
git(project, ['init', '-b', 'main']);
git(project, ['config', 'user.email', 'repro@example.com']);
git(project, ['config', 'user.name', 'Repro']);
git(project, ['add', '.']);
git(project, ['commit', '-m', 'init']);

// generated / dependency directories with MANY files, NOT gitignored
const genDirs = [
  'android/app/build',
  'android/app/.cxx',
  'android/.gradle',
  'node_modules',
  '.venv',
];
let genFileCount = 0;
for (const rel of genDirs) {
  const dir = path.join(project, rel);
  fs.mkdirSync(dir, { recursive: true });
  // 500 files in the largest generated dir to mimic heavy build output
  const n = rel.includes('build') ? 500 : 20;
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x'.repeat(40));
    genFileCount++;
  }
}
console.log(`Created synthetic project with ${genFileCount} untracked generated files (none gitignored).`);

// ---- import the REAL getStatus from the web server package ----
const servicePath = path.resolve(
  import.meta.dirname,
  '../packages/web/server/lib/git/service.js'
);
const { getStatus } = await import(servicePath);

// Instrument fs.stat / fs.readFile at the process level to observe what getStatus opens.
let statCount = 0;
let readCount = 0;
const openedUnderProject = new Set();
const origStat = fs.promises.stat;
const origReadFile = fs.promises.readFile;
fs.promises.stat = async function (...args) {
  statCount++;
  try {
    const p = String(args[0]);
    if (p.startsWith(project)) openedUnderProject.add(p);
  } catch {}
  return origStat.apply(this, args);
};
fs.promises.readFile = async function (...args) {
  readCount++;
  try {
    const p = String(args[0]);
    if (p.startsWith(project)) openedUnderProject.add(p);
  } catch {}
  return origReadFile.apply(this, args);
};

// ---- run getStatus exactly like the UI's /api/git/status full mode ----
console.log('\nCalling getStatus(project) in full mode (what the sidebar/work-status uses)...');
const status = await getStatus(project);
fs.promises.stat = origStat;
fs.promises.readFile = origReadFile;

const untracked = (status.files || []).filter(
  (f) => (f.working_dir || '').trim() === '?' || (f.index || '').trim() === '?'
);
console.log(`\ngit status -uall enumerated files total: ${(status.files || []).length}`);
console.log(`untracked files enumerated: ${untracked.length}`);
console.log(`fs.stat calls on files under the project: ${statCount}`);
console.log(`fs.readFile calls on files under the project: ${readCount}`);

const generatedOpened = [...openedUnderProject].filter((p) =>
  /(build|\/node_modules|\/\.gradle|\.venv|\/\.cxx)/.test(p)
);
console.log(`distinct files opened/read under generated/dependency dirs: ${generatedOpened.length}`);
if (generatedOpened.length > 0) {
  console.log('example opened generated files:');
  generatedOpened.slice(0, 8).forEach((p) => console.log('  ' + p.replace(project, '')));
}

console.log('\n---');
if (untracked.length > 0 && readCount > 0) {
  console.log('REPRODUCED: getStatus enumerates and reads files under un-ignored generated directories.');
} else {
  console.log('NOT reproduced: no untracked generated files were enumerated/read.');
}
