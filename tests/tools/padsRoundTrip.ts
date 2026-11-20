/**
 * PADS round trip, measured (R10): every PADS Layout ASCII board (.asc) under a folder read by
 * Konium Designer's importer and written back by its exporter, the two files read by the same
 * reader and compared object by object. What doesn't come back the same is what R10 has to keep.
 *
 *   npx vite-node tests/tools/padsRoundTrip.ts <folder> [<out folder>] [--max n] [--edit] [--anew]
 *
 * --edit changes each board first, as Konium might (its first part moved 50 mil, a track of a route
 * taken away, a drawing's track taken away, a free text moved 10 mil): what comes back should differ
 * in those only. --anew writes each
 * board from Konium's (as a board changed otherwise is), not the file kept or spliced.
 *
 * Parts (by reference: part type, decal, place, turn, side), decals (by name: pieces, texts,
 * terminals, pad stacks), routes (by net: the points of each connection, widths, layers, vias),
 * vias (by name: drill, stack), pours (by name and net: outline), lines (drafting, copper,
 * keep-outs, board outline: by type and layer, outline), free texts, part types (by name), the
 * layers' names and types, the nets' pins. Numbers in the file's units, to 0.01.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IMPORTERS } from '../../src/formats/importers';
import { exportPadsLayout } from '../../src/formats/pads/writeLayout';
import { parsePadsLayout, type PadsBoard, type Piece } from '../../src/formats/pads/layout';
import { load } from '../../src/formats/registry';
import { exportPadsLogic } from '../../src/formats/pads/writeLogic';
import type { SchDocument } from '../../src/model/sch';
import { NO_NET, type PcbDocument } from '../../src/model/pcb';
import { moveComponent, removePrims, replaceRecords } from '../../src/model/pcbEdit';
import { transformRecord } from '../../src/formats/altium/pcbTransform';
import { padsMark } from '../../src/formats/pads/kept';
import { readPcbDoc, writePcbDoc } from '../../src/formats/altium/pcbdoc';
import { mil } from '../../src/core/units';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 3;
const EDIT = args.includes('--edit');
const ANEW = args.includes('--anew');
const [dir, out] = args.filter((a, i) => !a.startsWith('--') && (maxAt < 0 || i !== maxAt + 1));
if (!dir) { console.error('usage: padsRoundTrip.ts <folder> [<out folder>] [--max n]'); process.exit(2); }
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const td = new TextDecoder('latin1');

/** A number in the file's units (mils, metric or basic), to 0.01. */
const q = (v: number, f: number) => String(Math.round((v * f) * 100) / 100 + 0);
const pieceKey = (p: Piece, f: number) => `${p.type} ${p.level} ${q(p.width, f)} ${p.corners.map((c) => `${q(c.p.x, f)},${q(c.p.y, f)}${c.arc ? `a${q(c.arc.r, f)}` : ''}`).join(' ')}`;

interface Item { key: string; detail: string }
function items(b: PadsBoard): Map<string, Item[]> {
  // (to mils, whatever the file's units: a board written back in other units compares the same)
  const f = b.units === 'MILS' ? 1 : b.units === 'METRIC' ? 1 / 0.0254 : b.units === 'BASIC' ? 1 / 38.1 : 1;
  const m = new Map<string, Item[]>();
  const put = (kind: string, key: string, detail: string) => m.set(kind, [...(m.get(kind) ?? []), { key, detail }]);
  for (const p of b.parts) put('part', p.ref, `${p.type} ${p.decal ?? ''} ${q(p.x, f)},${q(p.y, f)} ${q(p.ori, 1)} ${p.bottom ? 'B' : 'T'}`);
  for (const [name, d] of b.decals) {
    const g = d.units === 'M' ? 1 / 0.0254 : f;
    put('decal', name, `${d.pieces.length} pieces ${d.terms.length} terms ${d.stacks.size} stacks ${d.texts.length + d.labels.length} texts`);
    for (const p of d.pieces) put('decal piece', `${name} ${pieceKey(p, g)}`, '');
    for (const t of d.terms) put('decal term', `${name} ${t.name} ${q(t.x, g)},${q(t.y, g)}`, '');
    for (const [pin, st] of d.stacks) put('decal stack', `${name} ${pin}`, st.map((s) => `${s.level}:${q(s.size, g)}${s.shape}${s.ori ? `@${q(s.ori, 1)}` : ''}${s.length ? `x${q(s.length, g)}` : ''}${s.drill ? `d${q(s.drill, g)}${s.plated ? 'P' : 'N'}` : ''}`).sort().join(' '));
  }
  for (const [name, pt] of b.partTypes) put('part type', name, `${pt.decals.join(':')} ${pt.pinNames.length} pins`);
  for (const r of b.routes) {
    for (const c of r.conns) if (c.length) put('route', `${r.net} ${[c[0], c[c.length - 1]].map((p) => `${q(p!.x, f)},${q(p!.y, f)}`).sort().join(' ')}`, c.map((p) => `${q(p.x, f)},${q(p.y, f)}L${p.layer}W${q(p.width, f)}${p.via ? `V${p.via}` : ''}${p.arc ? p.arc : ''}`).join(' '));
  }
  for (const [name, v] of b.vias) put('via type', name, `${q(v.drill, f)} ${v.start}-${v.end} ${v.stack.map((s) => `${s.level}:${q(s.size, f)}${s.shape}`).join(' ')}`);
  for (const p of b.pours) put('pour', `${p.type} ${p.net} ${p.pieces[0] ? pieceKey(p.pieces[0], f) : ''}`.slice(0, 200), `${p.pieces.length} pieces prio ${p.priority}`);
  // (a line item's pieces where they are on the board: its place and theirs from it)
  const at = (l: PadsBoard['lines'][number], p: Piece): Piece => ({ ...p, corners: p.corners.map((c) => ({ p: { x: c.p.x + l.x, y: c.p.y + l.y }, ...(c.arc ? { arc: { ...c.arc, c: { x: c.arc.c.x + l.x, y: c.arc.c.y + l.y } } } : {}) })) });
  for (const l of b.lines) for (const p of l.pieces) put(`line ${l.type.toLowerCase()}`, pieceKey(at(l, p), f).slice(0, 220), l.net);
  for (const t of b.texts) put('text', `${t.text} ${q(t.x, f)},${q(t.y, f)} L${t.level}`, `${q(t.height, f)} ${q(t.ori, 1)}${t.mirrored ? ' M' : ''}`);
  for (const [n, l] of b.layers) put('layer', String(n), `${l.name} ${l.type}`);
  for (const [net, pins] of b.nets) put('net', net, [...pins].sort().join(' '));
  return m;
}

interface Row { before: number; after: number; same: number; changed: number; lost: number; added: number; ex: string[] }
const totals = new Map<string, Row>();
function compare(a: Map<string, Item[]>, b: Map<string, Item[]>, name: string): string[] {
  const lines: string[] = [];
  for (const kind of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const A = a.get(kind) ?? [], B = b.get(kind) ?? [];
    const pool = new Map<string, Item[]>();
    for (const x of B) pool.set(x.key, [...(pool.get(x.key) ?? []), x]);
    let same = 0, changed = 0, lost = 0;
    const ex: string[] = [];
    for (const x of A) {
      const list = pool.get(x.key);
      if (!list?.length) { lost++; if (ex.length < MAX) ex.push(`lost     ${x.key.slice(0, 120)} ${x.detail.slice(0, 80)}`); continue; }
      const i = list.findIndex((y) => y.detail === x.detail);
      if (i >= 0) { same++; list.splice(i, 1); } else { changed++; if (ex.length < MAX) ex.push(`changed  ${x.key.slice(0, 100)}: ${x.detail.slice(0, 90)} -> ${list[0]!.detail.slice(0, 90)}`); list.splice(0, 1); }
    }
    const rest = [...pool.values()].flat();
    for (const y of rest.slice(0, Math.max(0, MAX - ex.length))) ex.push(`added    ${y.key.slice(0, 120)} ${y.detail.slice(0, 80)}`);
    const t = totals.get(kind) ?? { before: 0, after: 0, same: 0, changed: 0, lost: 0, added: 0, ex: [] };
    t.before += A.length; t.after += B.length; t.same += same; t.changed += changed; t.lost += lost; t.added += rest.length;
    if (t.ex.length < MAX) t.ex.push(...ex.slice(0, MAX - t.ex.length).map((e) => `[${name}] ${e}`));
    totals.set(kind, t);
    lines.push(`${kind.padEnd(14)} ${[A.length, B.length, same, changed, lost, rest.length].map((v) => String(v).padStart(7)).join('')}`);
  }
  return lines;
}

const pads = IMPORTERS.find((i) => i.id === 'pads')!;
const report: string[] = [`PADS round trip: ${relative(process.cwd(), dir) || dir}`];
for (const p of walk(dir).filter((x) => /\.asc$/i.test(x))) {
  const bytes = new Uint8Array(readFileSync(p));
  const name = p.split('/').pop()!;
  try {
    const before = parsePadsLayout(td.decode(bytes));
    const r = await pads.run([{ path: name, bytes }], {});
    const doc = r.projects.flatMap((x) => x.documents).find((d) => /\.pcbdoc$/i.test(d.name));
    if (!doc) { report.push(`  ${name}: no board (${r.messages.map((m) => m.message).join('; ').slice(0, 120)})`); continue; }
    let board = load(doc.bytes, doc.name) as PcbDocument;
    // --edit: as a board changed in Konium might be: its first part moved 50 mil, one track of a route taken away
    let edits = '';
    if (EDIT) {
      if (board.components.length) moveComponent(board, 0, { x: mil(50), y: 0 }, 0).apply();
      const t = board.prims.find((x) => x.kind === 'track' && x.component === NO_NET && x.net !== NO_NET && x.polygon === NO_NET && padsMark(board, x) !== 'I');
      if (t) removePrims(board, [t]).apply();
      const g = board.prims.find((x) => x.kind === 'track' && x.component === NO_NET && x.net === NO_NET && x.polygon === NO_NET);
      if (g) removePrims(board, [g]).apply();
      const tx = board.prims.find((x) => x.kind === 'text' && x.component === NO_NET);
      if (tx) { const rec = board.streams.get(tx.src.storage)!.records[tx.src.index]!; replaceRecords(board, [{ storage: tx.src.storage, index: tx.src.index, after: transformRecord(rec, (q) => ({ x: q.x + mil(10), y: q.y })) }]).apply(); }
      const ed = [board.components.length ? `${board.components[0]!.designator} moved` : '', t && t.kind === 'track' ? `a track of ${board.nets[t.net]?.name} taken away` : '', g ? 'a drawing\'s track taken away' : '', tx ? 'a text moved' : ''].filter(Boolean);
      board = readPcbDoc(writePcbDoc(board), doc.name);
      edits = ed.length ? ` (edited: ${ed.join(', ')})` : '';
    }
    const back = exportPadsLayout(board, name.replace(/\.asc$/i, ''), { raw: ANEW });
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, name), back.bytes); }
    const after = parsePadsLayout(td.decode(back.bytes));
    report.push(`\n${relative(dir, p)} (${before.units}, ${before.version} -> ${after.units}, ${after.version})${edits}${back.spliced ? ` spliced: ${back.spliced.moved} moved, ${back.spliced.rerouted} rerouted${back.spliced.objects ? `, ${back.spliced.objects} objects` : ''}` : back.kept ? ' kept whole' : ' written anew'}`);
    report.push(`${'Kind'.padEnd(14)} ${['Orig', 'Back', 'Same', 'Changed', 'Lost', 'Added'].map((h) => h.padStart(7)).join('')}`);
    report.push(...compare(items(before), items(after), name));
  } catch (e) { report.push(`  ${name}: failed (${(e as Error).message.slice(0, 160)})`); }
}
// PADS Logic designs (.txt): back byte for byte while unchanged
{
  let n = 0, same = 0;
  const odd: string[] = [];
  for (const p of walk(dir).filter((x) => /\.txt$/i.test(x))) {
    const bytes = new Uint8Array(readFileSync(p));
    if (!/^\*PADS-LOGIC/i.test(td.decode(bytes.subarray(0, 40)))) continue;
    n++;
    try {
      const r = await pads.run([{ path: p.split('/').pop()!, bytes }], {});
      const sheets = r.projects.flatMap((x) => x.documents).filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: load(d.bytes, d.name) as SchDocument }));
      if (!sheets.length) { odd.push(`${relative(dir, p)}: no sheets`); continue; }
      const back = exportPadsLogic({ name: 'back', sheets, hierarchyMode: 3 });
      if (back.bytes.length === bytes.length && back.bytes.every((v, i) => v === bytes[i])) same++;
      else odd.push(`${relative(dir, p)}: ${back.kept ? 'kept but different' : 'written anew'}`);
    } catch (e) { odd.push(`${relative(dir, p)}: failed (${(e as Error).message.slice(0, 100)})`); }
  }
  if (n) report.push(`\nPADS Logic: ${same} of ${n} back byte for byte`, ...odd.slice(0, MAX * 3).map((x) => `  ${x}`));
}
report.push(`\nTotals\n${'Kind'.padEnd(14)} ${['Orig', 'Back', 'Same', 'Changed', 'Lost', 'Added'].map((h) => h.padStart(7)).join('')}`);
for (const [k, t] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
  report.push(`${k.padEnd(14)} ${[t.before, t.after, t.same, t.changed, t.lost, t.added].map((v) => String(v).padStart(7)).join('')}`);
  for (const e of t.ex) report.push(`      ${e}`);
}
console.log(report.join('\n'));
