/**
 * Corpus runner: point it at a folder of real Altium files.
 *   npx vite-node tests/tools/corpus.ts <folder> [report.json]
 *
 * For every SchDoc / PcbDoc / PrjPcb it checks:
 *   - load succeeds, diagnostics produced
 *   - unmodified save is stream-identical to the input (lossless round-trip)
 *   - PcbDoc: decoded primitives vs each storage's Header count; short records
 *   - SchDoc: record types seen, which ones we don't draw yet
 * This is the gate before any provisional layout in pcbLayouts.ts is marked verified.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detect, load, save } from '../../src/formats/registry';
import { isCfb, readCfb, walkCfb, cfbStream } from '../../src/formats/cfb/cfb';
import { bytesEqual } from '../../src/formats/bin';
import { PRIM_STORAGES } from '../../src/formats/altium/pcbdoc';
import { SR_NAME } from '../../src/model/sch';

const root = process.argv[2];
if (!root) { console.error('usage: corpus.ts <folder> [report.json]'); process.exit(2); }

function* files(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(schdoc|pcbdoc|prjpcb|schlib|pcblib|intlib)$/i.test(n)) yield p;
  }
}

function streamsEqual(a: Uint8Array, b: Uint8Array): string[] {
  if (!isCfb(a)) return bytesEqual(a, b) ? [] : ['<whole file>'];
  const m = (x: Uint8Array) => { const o = new Map<string, Uint8Array>(); walkCfb(readCfb(x).root, (e, p) => { if (e.kind === 'stream') o.set(p, e.data); }); return o; };
  const A = m(a), B = m(b);
  return [...new Set([...A.keys(), ...B.keys()])].filter((k) => !A.has(k) || !B.has(k) || !bytesEqual(A.get(k)!, B.get(k)!));
}

const report: Record<string, unknown>[] = [];
const tally = { files: 0, loaded: 0, roundTrip: 0, failed: 0 };
const recordTypes = new Map<number, number>();

for (const path of files(root)) {
  tally.files++;
  const rel = relative(root, path);
  const bytes = new Uint8Array(readFileSync(path));
  const row: Record<string, unknown> = { file: rel, size: bytes.length, kind: detect(bytes, path) };
  const t0 = performance.now();
  try {
    const doc = load(bytes, rel);
    row.loadMs = +(performance.now() - t0).toFixed(1);
    tally.loaded++;
    if ('diags' in doc) row.diags = doc.diags.items.map((d) => `${d.level}: ${d.message}`);
    if (doc.kind === 'PcbDoc') {
      const per: Record<string, string> = {};
      for (const s of PRIM_STORAGES) {
        const hdr = cfbStream(doc.cfb.root, `${s}/Header`);
        const declared = hdr && hdr.length >= 4 ? new DataView(hdr.buffer, hdr.byteOffset).getUint32(0, true) : 0;
        const framed = doc.streams.get(s)?.records.length ?? 0;
        const decoded = doc.prims.filter((p) => p.src.storage === s).length;
        if (declared || framed) per[s] = `${declared} declared, ${framed} framed, ${decoded} decoded`;
      }
      row.primitives = per;
    }
    if (doc.kind === 'SchDoc') {
      for (const o of doc.objects) recordTypes.set(o.record, (recordTypes.get(o.record) ?? 0) + 1);
    }
    if (doc.kind !== 'Inspect') {
      const diff = streamsEqual(bytes, save(doc));
      row.roundTrip = diff.length ? `DIFF in ${diff.slice(0, 5).join(', ')}` : 'identical';
      if (!diff.length) tally.roundTrip++;
    }
  } catch (e) {
    tally.failed++;
    row.error = (e as Error).message;
  }
  report.push(row);
  console.log(`${row.error ? 'FAIL' : row.roundTrip === 'identical' ? 'ok  ' : row.kind === 'Unknown' || !row.roundTrip ? '··· ' : 'DIFF'} ${rel}${row.error ? ' — ' + row.error : ''}`);
}

console.log('\nSchematic record types across corpus:');
for (const [t, n] of [...recordTypes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(t).padStart(4)} ${(SR_NAME[t] ?? '?').padEnd(22)} ${n}`);
console.log(`\n${tally.files} files, ${tally.loaded} loaded, ${tally.roundTrip} lossless round-trips, ${tally.failed} failures`);
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ tally, report }, null, 1));
