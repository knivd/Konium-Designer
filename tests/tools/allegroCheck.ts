/**
 * Allegro boards read, measured (R11): every Allegro board (.brd) under a folder read by Konium
 * Designer's importer; where Allegro's own ASCII extract of it lies beside it (<board>.brd.alg,
 * extracta's output), the board Konium made compared with it: the parts (reference, symbol, place,
 * turn, side), the nets and their pins, the routed copper (each stretch by its net, layer, ends and
 * width) and the vias (by place and net). Each board is also kept with its file, as the Import
 * Wizard keeps it, and that file checked to come back byte for byte while the board is unchanged.
 *
 *   npx vite-node tests/tools/allegroCheck.ts <folder> [--max n]
 *
 * Konium places the board 100 mil or more from its sheet's corner: Allegro's places are compared
 * after that shift (the parts' median). Numbers in mils, to 0.001 (as extracta writes them).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { convertAllegroBrd } from '../../src/formats/allegro/brdBoard';
import { readPcbDoc } from '../../src/formats/altium/pcbdoc';
import { keepBrd, keptBrd } from '../../src/formats/cadenceKept';
import { NO_NET, type PcbDocument } from '../../src/model/pcb';
import { layerName, L } from '../../src/model/layers';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 3;
const [dir] = args.filter((a, i) => !a.startsWith('--') && (maxAt < 0 || i !== maxAt + 1));
if (!dir) { console.error('usage: allegroCheck.ts <folder> [--max n]'); process.exit(2); }
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** extracta's file: each A! line names the fields of the S! rows after it. */
function readAlg(text: string): { units: string; tables: { fields: string[]; rows: string[][] }[] } {
  const tables: { fields: string[]; rows: string[][] }[] = [];
  let units = 'mils';
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('A!')) tables.push({ fields: l.split('!').slice(1), rows: [] });
    else if (l.startsWith('S!') && tables.length) tables[tables.length - 1]!.rows.push(l.split('!').slice(1));
    else if (l.startsWith('J!')) { const f = l.split('!'); if (f[9]) units = f[9]!; }
  }
  return { units, tables };
}
const table = (alg: ReturnType<typeof readAlg>, first: string[]) => alg.tables.filter((t) => first.every((f, i) => t.fields[i] === f));
const get = (t: { fields: string[] }, row: string[], f: string) => row[t.fields.indexOf(f)] ?? '';

const q = (v: number) => (Math.round(v * 1000) / 1000 + 0).toFixed(3);
const report: string[] = [];
const total = new Map<string, number[]>();
const line = (kind: string, a: number, b: number, same: number, note = '') => {
  report.push(`${kind.padEnd(14)} ${[a, b, same, a - same, b - same].map((x) => String(x).padStart(8)).join('')}${note ? `  ${note}` : ''}`);
  const t = total.get(kind) ?? [0, 0, 0, 0, 0];
  [a, b, same, a - same, b - same].forEach((x, i) => (t[i]! += x));
  total.set(kind, t);
};

let keptN = 0, boardsN = 0;
for (const p of walk(dir).filter((x) => /\.brd$/i.test(x)).sort()) {
  boardsN++;
  const name = relative(dir, p);
  let doc: PcbDocument;
  try {
    const t0 = Date.now();
    const src = new Uint8Array(readFileSync(p));
    const r = convertAllegroBrd(src, p.split('/').pop()!);
    // The file kept with the board (as the Import Wizard keeps it): back as it was while the board is unchanged
    doc = readPcbDoc(keepBrd(r.bytes, `${r.name}.PcbDoc`, src, p), `${r.name}.PcbDoc`);
    const back = keptBrd(doc)?.bytes;
    if (back && back.length === src.length && back.every((v, i) => v === src[i])) keptN++;
    report.push(`\n${name}: ${r.stats.components} parts, ${r.stats.nets} nets, ${r.stats.tracks} tracks and arcs, ${r.stats.vias} vias, ${r.stats.pours} pours, ${r.stats.layers} copper layers (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.warnings.length ? `; ${r.warnings.length} warnings: ${r.warnings.slice(0, 2).join('; ').slice(0, 200)}` : ''}`);
  } catch (e) { report.push(`\n${name}: not read: ${(e as Error).message}`); continue; }
  const algPath = `${p}.alg`;
  if (!existsSync(algPath)) continue;
  const alg = readAlg(readFileSync(algPath, 'latin1'));
  const k = /mil/i.test(alg.units) ? 1 : /milli|mm/i.test(alg.units) ? 1 / 0.0254 : /inch/i.test(alg.units) ? 1000 : 1;
  const toMil = (s: string) => Number(s) * k;
  report.push(`${'Kind'.padEnd(14)} ${['Allegro', 'Konium', 'Same', 'Missed', 'Extra'].map((h) => h.padStart(8)).join('')}`);

  /* Parts */
  const syms = table(alg, ['SYM_TYPE', 'SYM_NAME', 'REFDES']).flatMap((t) => t.rows.map((r) => ({ type: get(t, r, 'SYM_TYPE'), sym: get(t, r, 'SYM_NAME'), ref: get(t, r, 'REFDES'), mirror: get(t, r, 'SYM_MIRROR') === 'YES', rot: Number(get(t, r, 'SYM_ROTATE')), x: toMil(get(t, r, 'SYM_X')), y: toMil(get(t, r, 'SYM_Y')) }))).filter((s) => s.ref);
  const comps = new Map(doc.components.map((c) => [c.designator, c]));
  const dx: number[] = [], dy: number[] = [];
  for (const s of syms) { const c = comps.get(s.ref); if (c) { dx.push(c.at.x / 1e4 - s.x); dy.push(c.at.y / 1e4 - s.y); } }
  const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
  const ox = med(dx), oy = med(dy);
  const odd: string[] = [];
  let samePart = 0;
  for (const s of syms) {
    const c = comps.get(s.ref);
    if (!c) { odd.push(`missed part ${s.ref} ${s.sym}`); continue; }
    const bottom = c.layer === L.BOTTOM;
    const rot = ((Math.round((c.rotation) * 1000) / 1000) % 360 + 360) % 360;
    // (a part on the bottom: Allegro mirrors it across the board's Y axis, the desktop software across its X axis, half a turn apart)
    const want = (((s.rot + (s.mirror ? 180 : 0)) % 360) + 360) % 360;
    const where = Math.abs(c.at.x / 1e4 - ox - s.x) < 0.02 && Math.abs(c.at.y / 1e4 - oy - s.y) < 0.02;
    const ok = c.pattern === s.sym && where && bottom === s.mirror && Math.abs(rot - want) < 0.01;
    if (ok) samePart++;
    else odd.push(`part ${s.ref}: ${s.sym} ${q(s.x)},${q(s.y)} ${want} ${s.mirror ? 'B' : 'T'} -> ${c.pattern} ${q(c.at.x / 1e4 - ox)},${q(c.at.y / 1e4 - oy)} ${rot} ${bottom ? 'B' : 'T'}`);
  }
  line('part', syms.length, doc.components.length, samePart, `(Konium's at Allegro's + ${q(ox)}, ${q(oy)} mil)`);

  /* Nets and their pins */
  const pinsOf = new Map<string, Set<string>>();
  for (const t of table(alg, ['NET_NAME_SORT', 'NODE_SORT', 'NET_NAME'])) for (const r of t.rows) {
    const net = get(t, r, 'NET_NAME'), ref = get(t, r, 'REFDES'), pin = get(t, r, 'PIN_NUMBER');
    if (!net || !ref) continue;
    const s = pinsOf.get(net) ?? new Set<string>(); s.add(`${ref}.${pin}`); pinsOf.set(net, s);
  }
  const ours = new Map<string, Set<string>>();
  for (const pr of doc.prims) {
    if (pr.kind !== 'pad' || pr.net === NO_NET || pr.component === NO_NET) continue;
    const net = doc.nets[pr.net]?.name ?? '', ref = doc.components[pr.component]?.designator ?? '';
    const s = ours.get(net) ?? new Set<string>(); s.add(`${ref}.${pr.name}`); ours.set(net, s);
  }
  let sameNet = 0;
  for (const [net, pins] of pinsOf) {
    const o = ours.get(net);
    if (o && o.size === pins.size && [...pins].every((x) => o.has(x))) sameNet++;
    else odd.push(`net ${net}: ${pins.size} pins -> ${o ? `${o.size} pins (${[...pins].filter((x) => !o.has(x)).slice(0, 4).join(' ')} missed)` : 'not there'}`);
  }
  line('net (pins)', pinsOf.size, ours.size, sameNet);

  /* Pins where Allegro has them (the parts' pads) */
  const stab = table(alg, ['SYM_NAME', 'SYM_TYPE', 'COMP_DEVICE_TYPE', 'REFDES']);
  const pinAt = new Map<string, string>();
  for (const t of stab) for (const r of t.rows) if (get(t, r, 'CLASS') === 'PIN' && get(t, r, 'REFDES')) pinAt.set(`${get(t, r, 'REFDES')}.${get(t, r, 'PIN_NUMBER')}`, `${q(toMil(get(t, r, 'PIN_X')))},${q(toMil(get(t, r, 'PIN_Y')))}`);
  const padAt = new Map<string, string>();
  for (const pr of doc.prims) if (pr.kind === 'pad' && pr.component !== NO_NET) padAt.set(`${doc.components[pr.component]?.designator ?? ''}.${pr.name}`, `${q(pr.at.x / 1e4 - ox)},${q(pr.at.y / 1e4 - oy)}`);
  let samePin = 0;
  for (const [k2, v] of pinAt) { if (padAt.get(k2) === v) samePin++; else odd.push(`pin at ${k2}: ${v} -> ${padAt.get(k2) ?? 'none'}`); }
  line('pin place', pinAt.size, padAt.size, samePin);

  /* Routed copper: each stretch by net, layer, ends and width */
  // (the copper layers by their place in the stack: Allegro's conductors in order)
  const conductors = table(alg, ['LAYER_SORT', 'LAYER_SUBCLASS']).flatMap((t) => t.rows.filter((r) => get(t, r, 'LAYER_CONDUCTOR') === 'YES').map((r) => get(t, r, 'LAYER_SUBCLASS').toUpperCase()));
  const layerOfName = new Map<string, number>();
  doc.board.copperStack.forEach((l, i) => layerOfName.set(conductors[i] ?? (doc.board.layerNames.get(l) ?? layerName(l)).toUpperCase(), l));
  const gtab = table(alg, ['CLASS', 'SUBCLASS', 'RECORD_TAG']);
  const key = (net: string, layer: string, a: [number, number], b: [number, number], w: number) => { const e = [`${q(a[0])},${q(a[1])}`, `${q(b[0])},${q(b[1])}`].sort().join(' '); return `${net}|${layer}|${e}|${q(w)}`; };
  const want = new Map<string, number>();
  // (a symbol's own routed copper and vias too: Konium has them on the board)
  for (const t of [...gtab, ...stab]) for (const r of t.rows) {
    if (get(t, r, 'CLASS') !== 'ETCH' || get(t, r, 'GRAPHIC_DATA_10') !== 'CONNECT') continue;
    const g = get(t, r, 'GRAPHIC_DATA_NAME');
    if (g !== 'LINE' && g !== 'ARC') continue;
    const d = (i: number) => toMil(get(t, r, `GRAPHIC_DATA_${i}`));
    const w = g === 'LINE' ? d(5) : d(8);
    const kk = key(get(t, r, 'NET_NAME'), get(t, r, 'SUBCLASS').toUpperCase(), [d(1), d(2)], [d(3), d(4)], w);
    want.set(kk, (want.get(kk) ?? 0) + 1);
  }
  const have = new Map<string, number>();
  const nameOfLayer = new Map([...layerOfName].map(([n, l]) => [l, n]));
  for (const pr of doc.prims) {
    if ((pr.kind !== 'track' && pr.kind !== 'arc') || pr.component !== NO_NET || (pr.polygon !== NO_NET && pr.polygon >= 0) || !nameOfLayer.has(pr.layer)) continue;
    const net = pr.net === NO_NET ? '' : doc.nets[pr.net]?.name ?? '';
    const sh = (v: { x: number; y: number }): [number, number] => [v.x / 1e4 - ox, v.y / 1e4 - oy];
    let a: [number, number], b: [number, number];
    if (pr.kind === 'track') { a = sh(pr.a); b = sh(pr.b); }
    else { const end = (deg: number) => ({ x: pr.c.x + pr.r * Math.cos(deg * Math.PI / 180), y: pr.c.y + pr.r * Math.sin(deg * Math.PI / 180) }); a = sh(end(pr.start)); b = sh(end(pr.end)); }
    const kk = key(net, nameOfLayer.get(pr.layer)!, a, b, pr.width / 1e4);
    have.set(kk, (have.get(kk) ?? 0) + 1);
  }
  let sameCu = 0, nWant = 0, nHave = 0;
  for (const [kk, n] of want) { nWant += n; const h = have.get(kk) ?? 0; sameCu += Math.min(n, h); if (h < n && odd.filter((x) => x.startsWith('stretch')).length < MAX) odd.push(`stretch missed ${kk}`); }
  for (const [kk, n] of have) { nHave += n; if ((want.get(kk) ?? 0) < n && odd.filter((x) => x.startsWith('stretch extra')).length < MAX) odd.push(`stretch extra ${kk}`); }
  line('route stretch', nWant, nHave, sameCu);

  /* Vias: by place and net */
  const vwant = new Set<string>();
  for (const t of [...gtab, ...stab]) for (const r of t.rows) if (get(t, r, 'CLASS') === 'VIA CLASS') vwant.add(`${q(toMil(get(t, r, 'VIA_X') || get(t, r, 'GRAPHIC_DATA_1')))},${q(toMil(get(t, r, 'VIA_Y') || get(t, r, 'GRAPHIC_DATA_2')))}|${get(t, r, 'NET_NAME')}`);
  const vhave = new Set<string>();
  for (const pr of doc.prims) if (pr.kind === 'via') vhave.add(`${q(pr.at.x / 1e4 - ox)},${q(pr.at.y / 1e4 - oy)}|${pr.net === NO_NET ? '' : doc.nets[pr.net]?.name ?? ''}`);
  const sameVia = [...vwant].filter((v) => vhave.has(v)).length;
  for (const v of [...vwant].filter((x) => !vhave.has(x)).slice(0, MAX)) odd.push(`via missed ${v}`);
  for (const v of [...vhave].filter((x) => !vwant.has(x)).slice(0, MAX)) odd.push(`via extra ${v}`);
  line('via', vwant.size, vhave.size, sameVia);

  const kinds = new Map<string, number>();
  for (const o of odd) { const kd = o.split(' ').slice(0, 2).join(' '); kinds.set(kd, (kinds.get(kd) ?? 0) + 1); if (kinds.get(kd)! <= MAX) report.push(`      ${o.slice(0, 220)}`); }
}
report.push(`\nKept and written back byte for byte while unchanged: ${keptN} of ${boardsN} boards`);
report.push('\nTotals', `${'Kind'.padEnd(14)} ${['Allegro', 'Konium', 'Same', 'Missed', 'Extra'].map((h) => h.padStart(8)).join('')}`);
for (const [kind, t] of total) report.push(`${kind.padEnd(14)} ${t.map((x) => String(x).padStart(8)).join('')}`);
console.log(report.join('\n'));
