/**
 * Cross-validates the CFB reader and writer against olefile (Python).
 *   npx vite-node tests/tools/cfb-crosscheck.ts [extra.cfb …]
 * 1. Writer: builds a stress tree (nested storages, mini + regular streams, >7 MiB to force
 *    DIFAT), writes it, and checks olefile reads every stream back identically.
 * 2. Reader: for each extra file (e.g. LibreOffice .xls/.doc, real Altium files), compares
 *    our stream hashes with olefile's.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfbPut, newEntry, readCfb, walkCfb, writeCfb } from '../../src/formats/cfb/cfb';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const olefile = (p: string): Record<string, string> =>
  JSON.parse(execFileSync('python3', ['-I', join(import.meta.dirname, 'cfb_dump.py'), p], { encoding: 'utf8', maxBuffer: 1 << 26 }));

function ours(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  walkCfb(readCfb(b).root, (e, p) => { if (e.kind === 'stream') out[p] = sha(e.data); });
  return out;
}

function compare(label: string, a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bad = [...keys].filter((k) => a[k] !== b[k]);
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${label}: ${keys.size} streams${bad.length ? ' mismatched: ' + bad.slice(0, 5).join(', ') : ''}`);
  return bad.length === 0;
}

let pass = true;
const dir = mkdtempSync(join(tmpdir(), 'cfbx-'));

// 1. Writer stress
let seed = 1;
const rnd = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; } return b; };
const root = newEntry('Root Entry', 'root');
const sizes = [0, 1, 63, 64, 65, 4095, 4096, 4097, 100_000];
for (let s = 0; s < 12; s++) for (const [i, n] of sizes.entries()) cfbPut(root, `Storage${s}/Stream${i}`, rnd(n));
cfbPut(root, 'Deep/A/B/C/Leaf', rnd(777));
cfbPut(root, 'Big/Blob', rnd(8 * 1024 * 1024)); // forces > 109 FAT sectors → DIFAT
cfbPut(root, 'FileHeader', rnd(3000));
const written = writeCfb(root);
const wpath = join(dir, 'stress.cfb');
writeFileSync(wpath, written);
const expect: Record<string, string> = {};
walkCfb(root, (e, p) => { if (e.kind === 'stream') expect[p] = sha(e.data); });
pass = compare('writer → olefile', expect, olefile(wpath)) && pass;
pass = compare('writer → our reader', expect, ours(written)) && pass;

// 2. Reader vs olefile on supplied files
for (const p of process.argv.slice(2)) pass = compare(`reader ${p}`, olefile(p), ours(readFileSync(p))) && pass;

console.log(pass ? 'ALL PASS' : 'FAILURES');
process.exit(pass ? 0 : 1);
