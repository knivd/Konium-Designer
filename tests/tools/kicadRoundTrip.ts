/**
 * KiCad round trip, measured: a KiCad project read by Konium Designer's importer and written back
 * by its exporter, then the two boards and the two sets of schematics compared object by object.
 * What doesn't come back the same is what R9 has to keep.
 *
 *   npx vite-node tests/tools/kicadRoundTrip.ts <project folder> [<out folder>] [--max n] [--derive] [--deep]
 *
 * --derive drops the net names kept from KiCad, so the board's go out as the schematics name them.
 * --deep compares every setting of the objects that match (their lists one by one), most frequent first.
 *
 * Boards: footprints (by reference: place, side, angle), pads (by reference and number: place, size,
 * shape, net), tracks, arcs and vias (by geometry and net), zones (by layers and net), board graphics
 * (by layer and kind), groups and tuning patterns (by uuid: their members), nets (by name). Schematics: symbols (by reference: library id, value,
 * footprint, place), wires and buses (by their ends), junctions and no-connects (by place), labels
 * of each kind and texts (by text: place), sheets. Coordinates are
 * compared after the shift the footprints share (KiCad's origin and Konium's can differ), to 2 µm;
 * a track or arc drawn the other way round is the same.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importKicad } from '../../src/formats/kicad/project';
import { exportKicad } from '../../src/formats/kicad/export';
import { keptProjectFiles } from '../../src/formats/kicad/project';
import { symbolItems } from './kicadItems';
import { load } from '../../src/formats/registry';
import { readPrjPcb, iniGet, projectParameters } from '../../src/formats/altium/prjpcb';
import { parseSexpr, kids, kid, str, num, type SList, type SNode } from '../../src/formats/kicad/sexpr';
import type { SchDocument } from '../../src/model/sch';
import type { PcbDocument } from '../../src/model/pcb';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 5;
const [dir, out] = args.filter((a, i) => !a.startsWith('--') && (maxAt < 0 || i !== maxAt + 1));
if (!dir) { console.error('usage: kicadRoundTrip.ts <project folder> [<out folder>] [--max n]'); process.exit(2); }

const td = new TextDecoder();
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

const isList = (n: SNode): n is SList => typeof n === 'object';
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** To 1 µm (Konium keeps lengths in its own units, 2.54 nm: well inside it). */
const q = (v: number) => Math.round(v * 1000) / 1000 + 0;

/* ─── Boards ─────────────────────────────────────────────────────────────────────────── */

interface Bag { kind: string; key: string; detail: string; /** The object itself, for --deep. */ node?: SList; /** Its places are the board's (shifted): left out of --deep. */ placed?: boolean; /** The shift its board has (a footprint's zones and dimensions, in the board's places, compared shifted back). */ d?: [number, number] }

/* ─── --deep: every setting of objects that match, compared ───────────────────────────── */

const DEEP = args.includes('--deep');
/** Lists an object's own comparison covers (its places, its net: KiCad 9 names a zone's net in (net), KiCad 8 in (net_name)) or that are objects of their own (a footprint's pads). */
const OWN = new Set(['uuid', 'tstamp', 'id', 'net', 'net_name', 'instances', 'pad', 'fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly', 'fp_curve', 'fp_text', 'filled_polygon', 'path', 'pin']);
const PLACED = new Set(['at', 'start', 'end', 'mid', 'center', 'pts', 'xy', 'polygon']);
const PLACES = new Set(['at', 'start', 'end', 'mid', 'center', 'xy']);
/** KiCad's flags written bare (KiCad 8) or as (flag yes) (KiCad 9): the same. */
const FLAGS = new Set(['hide', 'locked', 'bold', 'italic']);
/** Settings KiCad 9 writes at their defaults ("none": as the board has it), the same as none written. */
const nothing = (y: SList) => (['tenting', 'covering', 'plugging'].includes(y.k) && y.items.every((z) => isList(z) && z.items.length === 1 && z.items[0] === 'none'))
  || (['capping', 'filling'].includes(y.k) && y.items[0] === 'none') || ((y.k === 'embedded_fonts' || y.k === 'duplicate_pad_numbers_are_jumpers') && y.items[0] === 'no')
  || (y.k === 'island_removal_mode' && y.items[0] === 0) || y.k === 'fields_autoplaced'
  // (no fill, a picture's scale of 1: the same as none written)
  || (y.k === 'fill' && y.items.length === 1 && isList(y.items[0]) && (y.items[0] as SList).k === 'type' && (y.items[0] as SList).items[0] === 'none') || (y.k === 'scale' && y.items.length === 1 && y.items[0] === 1);
const normOf = (x: SNode): string => {
  if (typeof x === 'number') return String(Math.round(x * 1000) / 1000 + 0);
  if (typeof x === 'string') return JSON.stringify(x.replace(/\{slash\}/g, '/'));
  let items = x.items.filter((y) => !(isList(y) && (y.k === 'uuid' || y.k === 'tstamp' || nothing(y))))
    .map((y): SNode => (typeof y === 'string' && FLAGS.has(y) ? { k: y, items: ['yes'] } : y));
  // (an angle of 0 written or not; a pad's layers in any order; a datasheet of "~" none)
  if (x.k === 'at' && items.length === 2) items = [...items, 0];
  if (x.k === 'layers') items = [...items].sort((p, q2) => String(p).localeCompare(String(q2)));
  if (x.k === 'property' && items[0] === 'Datasheet' && items[1] === '~') items = [items[0], '', ...items.slice(2)];
  // (atoms in their order, lists in any)
  return `(${x.k} ${[...items.filter((y) => !isList(y)).map(normOf), ...items.filter(isList).map(normOf).sort()].join(' ')})`;
};
const deepTally = new Map<string, { n: number; ex: string }>();
let deepPairs = 0;
function deepCompare(kind: string, a: Bag, b: Bag): void {
  if (!DEEP || !a.node || !b.node) return;
  deepPairs++;
  // (a footprint's zones and dimensions are in the board's places: shifted back as the board is)
  const back = (c: SList, d: [number, number]): SList => ({ ...c, items: c.items.map((y, i) => (isList(y) ? back(y, d)
    : PLACES.has(c.k) && i < 2 && typeof y === 'number' ? Math.round((y - d[i]!) * 1e6) / 1e6 : y)) });
  const parts = (n: SList, d?: [number, number]) => {
    const m = new Map<string, string[]>();
    // (an oval pad as wide as it is high is a circle to KiCad)
    const round = n.k === 'pad' && r3(num(kid(n, 'size'), 0)) === r3(num(kid(n, 'size'), 1));
    const atoms = n.items.filter((y) => !isList(y) && !(typeof y === 'string' && FLAGS.has(y))).map((y) => (round && y === 'oval' ? 'circle' : y)).map(normOf).join(' ');
    m.set('(atoms)', [atoms]);
    const lists = [...n.items.filter(isList).filter((c) => !nothing(c)), ...n.items.filter((y): y is string => typeof y === 'string' && FLAGS.has(y)).map((y): SList => ({ k: y, items: ['yes'] }))];
    for (const c of lists) {
      if (OWN.has(c.k) || (a.placed && PLACED.has(c.k))) continue;
      // (a text's drawn outlines KiCad caches, a dimension's text: in the board's places, shifted)
      if (a.placed && (c.k === 'render_cache' || (n.k === 'dimension' && c.k === 'gr_text'))) continue;
      // (a footprint's Footprint field: KiCad 8 writes one, KiCad 9 doesn't; the export writes KiCad 8's form)
      if (n.k === 'footprint' && c.k === 'property' && c.items[0] === 'Footprint') continue;
      // (fields by their name)
      const label = c.k === 'property' ? `property ${str(c, 0)}` : c.k;
      m.set(label, [...(m.get(label) ?? []), normOf(n.k === 'footprint' && d && (c.k === 'zone' || c.k === 'dimension') ? back(c, d) : c)]);
    }
    return m;
  };
  const pa = parts(a.node, a.d), pb = parts(b.node, b.d);
  for (const label of new Set([...pa.keys(), ...pb.keys()])) {
    const x = (pa.get(label) ?? []).sort().join(' '), y = (pb.get(label) ?? []).sort().join(' ');
    if (x === y) continue;
    const k = `${kind} ${label}`;
    const t = deepTally.get(k) ?? { n: 0, ex: `[${a.key.slice(0, 40)}] ${x.slice(0, 110) || '(none)'}  ->  ${y.slice(0, 110) || '(none)'}` };
    t.n++;
    deepTally.set(k, t);
  }
}
function deepReport(): string {
  if (!DEEP) return '';
  const rows = [...deepTally].sort((p, q2) => q2[1].n - p[1].n);
  return `\n--deep: ${deepPairs} matched objects compared setting by setting; ${rows.length} kinds of difference\n${rows.slice(0, 40).map(([k, t]) => `  ${String(t.n).padStart(6)}  ${k}\n          ${t.ex}`).join('\n')}`;
}

function netNames(pcb: SList): Map<number, string> {
  const m = new Map<number, string>();
  for (const n of kids(pcb, 'net')) m.set(num(n, 0), str(n, 1) ?? '');
  return m;
}
/** A net as written in an object: (net 3) with the board's table (KiCad 8) or (net "name") (KiCad 9). */
function netOf(o: SList, names: Map<number, string>): string {
  return netRaw(o, names);
}
function netRaw(o: SList, names: Map<number, string>): string {
  const n = kid(o, 'net');
  if (!n) return '';
  const a = n.items[0];
  const name = typeof a === 'number' ? names.get(a) ?? '' : String(a ?? '');
  // KiCad names a lone pad's net itself (unconnected-(R1-Pad2)): no net to keep
  return /^unconnected-\(/.test(name) ? '' : name;
}
function xy(n: SList | undefined, dx = 0, dy = 0): [number, number] { return n ? [q(num(n, 0) - dx), q(num(n, 1) - dy)] : [NaN, NaN]; }

/** A line's ends in an order a micron's rounding doesn't swap (by where they are to 10 µm). */
function ends(a: [number, number], b: [number, number]): string {
  const k = (p: [number, number]) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  return (k(a) < k(b) || (k(a) === k(b) && String(a) <= String(b)) ? [a, b] : [b, a]).map(String).join(' ');
}

function boardObjects(pcb: SList, dx: number, dy: number, rename?: Map<string, string>): Bag[] {
  const table = netNames(pcb);
  const names = new Map([...table].map(([k, v]) => [k, rename?.get(v) ?? v]));
  const netOf_ = netOf;
  const netOf2 = (o: SList, n: Map<number, string>) => { const v = netOf_(o, n); return rename?.get(v) ?? v; };
  const out: Bag[] = [];
  for (const fp of kids(pcb, 'footprint')) {
    const ref = (kids(fp, 'property').find((p) => str(p, 0) === 'Reference') ? str(kids(fp, 'property').find((p) => str(p, 0) === 'Reference'), 1) : undefined)
      ?? (kids(fp, 'fp_text').find((t) => str(t, 0) === 'reference') ? str(kids(fp, 'fp_text').find((t) => str(t, 0) === 'reference'), 1) : '') ?? '';
    const at = kid(fp, 'at');
    const [x, y] = xy(at, dx, dy);
    const side = str(kid(fp, 'layer')) ?? '';
    out.push({ kind: 'footprint', key: ref, detail: `${x},${y} ${r3(((num(at, 2) % 360) + 360) % 360)}° ${side}`, node: fp, placed: true, d: [dx, dy] });
    for (const p of kids(fp, 'pad')) {
      const sz = kid(p, 'size');
      // (an oval as wide as it is high is a circle to KiCad)
      const shape = str(p, 2) === 'oval' && r3(num(sz, 0)) === r3(num(sz, 1)) ? 'circle' : str(p, 2);
      // Its layers (the openings it makes) and a custom pad's primitives, to 0.001 mm
      const layers = (kid(p, 'layers')?.items.map(String) ?? []).sort().join('+');
      const prims = (kid(p, 'primitives')?.items.filter(isList) ?? []).map((g) => `${g.k}(${g.items.filter(isList).map((q) => q.k === 'pts' ? q.items.filter(isList).map((v) => `${r3(num(v, 0))} ${r3(num(v, 1))}`).join(' ') : `${q.k} ${q.items.map((v) => (typeof v === 'number' ? r3(v) : String(v))).join(' ')}`).join(';')})`).join(' ');
      out.push({ kind: 'pad', key: `${ref}-${str(p, 0)}@${xy(kid(p, 'at')).join(',')}`, detail: `${str(p, 1)} ${shape} ${r3(num(sz, 0))}x${r3(num(sz, 1))} ${netOf2(p, names)} ${layers}${prims ? ` ${prims}` : ''}`, node: p });
    }
    // Its own graphics and texts, in its frame: by geometry (a line either way round), a text by its words, place and layer
    for (const g of fp.items.filter(isList).filter((x) => /^fp_(line|rect|circle|arc|poly|curve|text)$/.test(x.k))) {
      const P = (k: string) => xy(kid(g, k)).join(',');
      const geom = g.k === 'fp_line' ? [P('start'), P('end')].sort().join(' ')
        : g.k === 'fp_rect' ? `${P('start')} ${P('end')}` : g.k === 'fp_circle' ? `${P('center')} ${P('end')}`
        : g.k === 'fp_arc' ? [P('start'), P('end')].sort().join(' ') + ` mid ${P('mid')}`
        : g.k === 'fp_poly' || g.k === 'fp_curve' ? (() => { const pts = kids(kid(g, 'pts'), 'xy').map((v) => xy(v).join(',')); return `${pts.length} pts ${pts[0] ?? ''}`; })()
        : `${str(g, 0)} ${P('at')}`;
      out.push({ kind: 'fp graphic', key: `${ref} ${g.k} ${str(kid(g, 'layer'))} ${geom}`, detail: g.k === 'fp_text' ? String(g.items[1] ?? '') : '', node: g });
    }
    // The fields shown: Reference and Value, their place and layer
    for (const pr of kids(fp, 'property').filter((x) => /^(Reference|Value)$/.test(str(x, 0) ?? '') && kid(x, 'layer'))) {
      out.push({ kind: 'fp field', key: `${ref} ${str(pr, 0)} ${str(kid(pr, 'layer'))}`, detail: `${xy(kid(pr, 'at')).join(',')} ${r3(num(kid(pr, 'at'), 2))} ${pr.items.includes('hide') || !!kid(pr, 'hide') ? 'hidden' : ''}`, node: pr });
    }
  }
  for (const s of kids(pcb, 'segment')) out.push({ kind: 'track', key: `${str(kid(s, 'layer'))} ${ends(xy(kid(s, 'start'), dx, dy), xy(kid(s, 'end'), dx, dy))}`, detail: `${r3(num(kid(s, 'width')))} ${netOf2(s, names)}`, node: s, placed: true });
  for (const s of kids(pcb, 'arc')) out.push({ kind: 'arc', key: `${str(kid(s, 'layer'))} ${[String(xy(kid(s, 'start'), dx, dy)), String(xy(kid(s, 'end'), dx, dy))].sort().join(' ')} mid ${xy(kid(s, 'mid'), dx, dy)}`, detail: `${r3(num(kid(s, 'width')))} ${netOf2(s, names)}`, node: s, placed: true });
  for (const v of kids(pcb, 'via')) out.push({ kind: 'via', key: `${xy(kid(v, 'at'), dx, dy)}`, detail: `${r3(num(kid(v, 'size')))}/${r3(num(kid(v, 'drill')))} ${(kid(v, 'layers')?.items ?? []).join('-')} ${netOf2(v, names)}`, node: v, placed: true });
  for (const z of kids(pcb, 'zone')) {
    const layers = kid(z, 'layers') ? (kid(z, 'layers')!.items as string[]).join('+') : str(kid(z, 'layer')) ?? '';
    const keep = kid(z, 'keepout') ? 'keepout' : 'zone';
    // (its first outline's first corner in the detail: a board can have several zones of one net on one layer, paired by it first)
    const c0 = kids(kid(kid(z, 'polygon') ?? kid(z, 'filled_polygon'), 'pts'), 'xy')[0];
    out.push({ kind: keep, key: `${layers} ${netOf2(z, names) || str(kid(z, 'net_name')) || ''}`, detail: `${kids(z, 'filled_polygon').length} filled${c0 ? ` @${xy(c0, dx, dy).join(',')}` : ''}`, node: z, placed: true });
  }
  // Dimensions by their type, layer and points (their text); the title block by its fields
  for (const d of kids(pcb, 'dimension')) out.push({ kind: 'dimension', key: `${str(kid(d, 'type'))} ${str(kid(d, 'layer'))} ${kids(kid(d, 'pts'), 'xy').map((v) => xy(v, dx, dy).join(',')).join(' ')}`, detail: str(kid(d, 'gr_text')) ?? '', node: d, placed: true });
  for (const t of kids(pcb, 'title_block')) out.push({ kind: 'title', key: 'title_block', detail: t.items.filter(isList).map((x) => `${x.k} ${x.items.join(' ')}`).join('; ') });
  // Groups and generated objects (tuning patterns) by their uuid: their members (by uuid, so the items kept theirs)
  for (const g of pcb.items.filter(isList).filter((x) => x.k === 'group' || x.k === 'generated')) {
    const id = str(kid(g, 'uuid')) ?? str(kid(g, 'id')) ?? '';
    const m = (kid(g, 'members')?.items ?? []).map(String).sort();
    let h = 0x811c9dc5;
    for (const c of m.join(' ')) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    out.push({ kind: g.k, key: `${id}${g.k === 'generated' ? ` ${str(kid(g, 'type'))} ${str(kid(g, 'layer'))}` : ` "${str(g, 0) ?? ''}"`}`, detail: `${m.length} members ${h.toString(16)}` });
  }
  // Board graphics by their geometry (a line either way round), a text by its words and place
  for (const g of pcb.items.filter(isList).filter((x) => /^gr_/.test(x.k))) {
    const P = (k: string) => xy(kid(g, k), dx, dy).join(',');
    const geom = g.k === 'gr_line' ? [P('start'), P('end')].sort().join(' ')
      : g.k === 'gr_rect' ? `${P('start')} ${P('end')}`
      : g.k === 'gr_circle' ? `${P('center')} ${P('end')}`
      : g.k === 'gr_arc' ? [P('start'), P('end')].sort().join(' ') + ` mid ${P('mid')}`
      : g.k === 'gr_poly' || g.k === 'gr_curve' ? (() => { const pts = kids(kid(g, 'pts'), 'xy').map((v) => xy(v, dx, dy).join(',')); return `${pts.length} pts ${pts[0] ?? ''}`; })()
      : g.k === 'gr_text' ? `${P('at')}` : '';
    // (fill none) and (fill no), (fill solid) and (fill yes): the same to KiCad 8 and 9
    const fill = kid(g, 'fill') ? ` fill ${/^(yes|solid)$/.test(String(kid(g, 'fill')!.items[0] ?? '')) ? 'yes' : 'no'}` : '';
    out.push({ kind: 'graphic', key: `${g.k} ${str(kid(g, 'layer'))} ${geom}${g.k === 'gr_text' ? '' : fill}`, detail: g.k === 'gr_text' ? String(g.items[0]) : '', node: g, placed: true });
  }
  return out;
}

/** The shift the footprints share between two boards (the most common one). */
function shift(a: SList, b: SList): [number, number] {
  const refOf = (fp: SList) => str(kids(fp, 'property').find((p) => str(p, 0) === 'Reference'), 1) ?? str(kids(fp, 'fp_text').find((t) => str(t, 0) === 'reference'), 1) ?? '';
  // Footprints of one reference (several POLY, say) paired in their order
  const at = new Map<string, (SList | undefined)[]>();
  for (const fp of kids(b, 'footprint')) at.set(refOf(fp), [...(at.get(refOf(fp)) ?? []), kid(fp, 'at')]);
  const used = new Map<string, number>();
  const votes = new Map<string, number>();
  for (const fp of kids(a, 'footprint')) {
    const k = used.get(refOf(fp)) ?? 0;
    used.set(refOf(fp), k + 1);
    const q = at.get(refOf(fp))?.[k];
    if (!q) continue;
    const d = `${Math.round((num(q, 0) - num(kid(fp, 'at'), 0)) * 1e5) / 1e5},${Math.round((num(q, 1) - num(kid(fp, 'at'), 1)) * 1e5) / 1e5}`;
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  // No footprints to go by: the board graphics' lower-left corners
  if (!votes.size) {
    const lo = (t: SList) => { let x = Infinity, y = Infinity; for (const g of t.items.filter(isList).filter((n) => /^gr_(line|arc|rect|circle|poly|curve)$/.test(n.k))) for (const k of ['start', 'end', 'center', 'mid']) { const n = kid(g, k); if (n) { x = Math.min(x, num(n, 0)); y = Math.min(y, num(n, 1)); } } return [x, y]; };
    const [ax, ay] = lo(a), [bx, by] = lo(b);
    if (Number.isFinite(ax) && Number.isFinite(bx)) return [Math.round((bx - ax) * 1e5) / 1e5, Math.round((by - ay) * 1e5) / 1e5];
  }
  const best = [...votes].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '0,0';
  const [x, y] = best.split(',').map(Number);
  return [x!, y!];
}

/* ─── Schematics ─────────────────────────────────────────────────────────────────────── */

function schematicObjects(trees: SList[], project: string): Bag[] {
  const out: Bag[] = [];
  const P = (n: SList | undefined) => (n ? `${Math.round(num(n, 0) * 100) / 100},${Math.round(num(n, 1) * 100) / 100}` : '');
  for (const t of trees) {
    for (const s of kids(t, 'symbol')) {
      const prop = (k: string) => str(kids(s, 'property').find((p) => str(p, 0) === k), 1) ?? '';
      // A symbol of a sheet used more than once has a designator per use, in its instances
      // (this project's: a symbol copied from another keeps that one's too)
      const projects = kids(kid(s, 'instances'), 'project');
      const mine = projects.filter((p) => str(p, 0) === project);
      const uses = (mine.length ? mine : projects).flatMap((p) => kids(p, 'path')).map((p) => str(kid(p, 'reference')) ?? '').filter((r) => r);
      // (each designator once: a path KiCad keeps from an earlier hierarchy can repeat one)
      // (and not R? beside R1: a path to a sheet no longer there keeps the designator it had then)
      const known = uses.filter((r) => !r.endsWith('?'));
      const ref = uses.length ? [...new Set(known.length ? known : uses)].sort().join(',') : prop('Reference');
      if (ref.startsWith('#') || prop('Reference').startsWith('#')) { out.push({ kind: 'power', key: prop('Value'), detail: '' }); continue; }
      out.push({ kind: 'symbol', key: ref, detail: `${str(kid(s, 'lib_id'))} ${prop('Value')} ${prop('Footprint')} @${P(kid(s, 'at'))}`, node: s });
    }
    // Wires and buses by their ends (either way round), the rest by their place (to 0.01 mm)
    const ends = (w: SList) => kids(kid(w, 'pts'), 'xy').map(P).sort().join(' ');
    out.push(...kids(t, 'wire').map((w) => ({ kind: 'wire', key: ends(w), detail: '' })));
    out.push(...kids(t, 'bus').map((w) => ({ kind: 'bus', key: ends(w), detail: '' })));
    out.push(...kids(t, 'junction').map((j) => ({ kind: 'junction', key: P(kid(j, 'at')), detail: '' })));
    out.push(...kids(t, 'no_connect').map((j) => ({ kind: 'no_connect', key: P(kid(j, 'at')), detail: '' })));
    // ({slash} and / in a label are the same to KiCad: files have both)
    for (const k of ['label', 'global_label', 'hierarchical_label']) out.push(...kids(t, k).map((l) => ({ kind: k, key: String(l.items[0]).replace(/\{slash\}/g, '/'), detail: `@${P(kid(l, 'at'))}`, node: l })));
    out.push(...kids(t, 'sheet').map((s) => ({ kind: 'sheet', key: str(kids(s, 'property').find((p) => str(p, 0) === 'Sheetname' || str(p, 0) === 'Sheet name'), 1) ?? '', detail: `@${P(kid(s, 'at'))}`, node: s })));
    out.push(...kids(t, 'text').map((x) => ({ kind: 'text', key: String(x.items[0]), detail: `@${P(kid(x, 'at'))}`, node: x })));
    // Drawings, bus entries, text boxes, net class flags, pictures: by their places
    for (const k of ['polyline', 'rectangle', 'circle', 'arc', 'bezier']) out.push(...kids(t, k).map((g) => ({ kind: `sch ${k}`, key: ['start', 'mid', 'end', 'center'].map((c) => P(kid(g, c))).join(' ') + kids(kid(g, 'pts'), 'xy').map(P).join(' '), detail: '', node: g })));
    out.push(...kids(t, 'bus_entry').map((e) => ({ kind: 'bus_entry', key: P(kid(e, 'at')), detail: '', node: e })));
    out.push(...kids(t, 'text_box').map((x) => ({ kind: 'text_box', key: String(x.items[0]), detail: `@${P(kid(x, 'at'))}`, node: x })));
    out.push(...kids(t, 'netclass_flag').map((x) => ({ kind: 'netclass_flag', key: String(x.items[0]), detail: `@${P(kid(x, 'at'))}`, node: x })));
    out.push(...kids(t, 'image').map((x) => ({ kind: 'image', key: P(kid(x, 'at')), detail: '', node: x })));
  }
  return out;
}

/* ─── Comparing ──────────────────────────────────────────────────────────────────────── */

interface Row { kind: string; before: number; after: number; same: number; changed: number; lost: string[]; added: string[]; diff: string[] }

function compare(a: Bag[], b: Bag[]): Row[] {
  const kinds = [...new Set([...a, ...b].map((x) => x.kind))];
  return kinds.map((kind) => {
    const A = a.filter((x) => x.kind === kind), B = b.filter((x) => x.kind === kind);
    const pool = new Map<string, Bag[]>();
    for (const x of B) { const k = x.key; pool.set(k, [...(pool.get(k) ?? []), x]); }
    let same = 0, changed = 0;
    const lost: string[] = [], diff: string[] = [];
    // The same first (all of them), then each other of a key with the one most alike (most words in common: a zone's corner)
    const open: Bag[] = [];
    for (const x of A) {
      const list = pool.get(x.key);
      const i = list ? list.findIndex((y) => y.detail === x.detail) : -1;
      if (i >= 0) { same++; deepCompare(kind, x, list![i]!); list!.splice(i, 1); } else open.push(x);
    }
    const words = (t: string) => new Set(t.split(/\s+/));
    for (const x of open) {
      const list = pool.get(x.key);
      if (!list?.length) { lost.push(`${x.key} ${x.detail}`.trim()); continue; }
      const w = words(x.detail);
      let best = 0, score = -1;
      list.forEach((y, k) => { const n = [...words(y.detail)].filter((t) => w.has(t)).length; if (n > score) { score = n; best = k; } });
      const y = list[best]!;
      changed++; deepCompare(kind, x, y); diff.push(`${x.key}: ${x.detail} -> ${y.detail}`); list.splice(best, 1);
    }
    // Then the near ones: every number within 2 µm (a half micron in KiCad's file can round either way)
    const rest = [...pool.values()].flat();
    const toks = (t: string) => t.split(/(-?\d+(?:\.\d+)?)/);
    const near = (a: string, b: string) => {
      const p = toks(a), q2 = toks(b);
      return p.length === q2.length && p.every((t, i) => (i % 2 ? Math.abs(Number(t) - Number(q2[i])) <= 0.002 : t === q2[i]));
    };
    for (let i = lost.length - 1; i >= 0; i--) {
      const k = rest.findIndex((y) => near(lost[i]!, `${y.key} ${y.detail}`.trim()));
      if (k >= 0) { same++; lost.splice(i, 1); rest.splice(k, 1); }
    }
    for (let i = diff.length - 1; i >= 0; i--) {
      const [a, b] = diff[i]!.split(' -> ');
      if (b !== undefined && near(a!.replace(/^[^:]*: /, ''), b)) { same++; changed--; diff.splice(i, 1); }
    }
    const added = rest.map((x) => `${x.key} ${x.detail}`.trim());
    return { kind, before: A.length, after: B.length, same, changed, lost, added, diff };
  });
}

function table(title: string, rows: Row[]): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lines = [title, `${pad('Kind', 14)}${pad('KiCad', 8)}${pad('Back', 8)}${pad('Same', 8)}${pad('Changed', 9)}${pad('Lost', 7)}Added`];
  let t = [0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    lines.push(`${pad(r.kind, 14)}${pad(r.before, 8)}${pad(r.after, 8)}${pad(r.same, 8)}${pad(r.changed, 9)}${pad(r.lost.length, 7)}${r.added.length}`);
    t = [t[0]! + r.before, t[1]! + r.after, t[2]! + r.same, t[3]! + r.changed, t[4]! + r.lost.length, t[5]! + r.added.length];
  }
  lines.push(`${pad('Total', 14)}${pad(t[0]!, 8)}${pad(t[1]!, 8)}${pad(t[2]!, 8)}${pad(t[3]!, 9)}${pad(t[4]!, 7)}${t[5]}`);
  for (const r of rows) {
    if (!r.lost.length && !r.diff.length && !r.added.length) continue;
    lines.push(`  ${r.kind}:`);
    for (const x of r.diff.slice(0, MAX)) lines.push(`    changed  ${x}`);
    for (const x of r.lost.slice(0, MAX)) lines.push(`    lost     ${x}`);
    for (const x of r.added.slice(0, MAX)) lines.push(`    added    ${x}`);
  }
  return lines.join('\n');
}

/* ─── Main ───────────────────────────────────────────────────────────────────────────── */

const paths = walk(dir).filter((p) => /\.(kicad_pro|kicad_sch|kicad_pcb|kicad_sym|kicad_mod|kicad_prl|kicad_dru)$/i.test(p) || /fp-lib-table|sym-lib-table/.test(p));
const files = paths.map((p) => ({ path: relative(dir, p).replace(/\\/g, '/'), bytes: new Uint8Array(readFileSync(p)) }));
const t0 = Date.now();
const imported = await importKicad(files);
const proj = imported.projects[0];
if (!proj) { console.error('nothing imported', imported.messages.slice(0, 5)); process.exit(1); }
const docs = proj.documents.filter((d) => /\.(schdoc|pcbdoc)$/i.test(d.name)).map((d) => load(d.bytes, d.name));
const sheets = docs.filter((d): d is SchDocument => d.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d }));
const board = docs.find((d): d is PcbDocument => d.kind === 'PcbDoc');
const mode = Number(iniGet(readPrjPcb(proj.prj.bytes, proj.prj.name), 'Design', 'HierarchyMode') ?? 0);
// --derive: as a project made in Konium would go, without the names kept from KiCad (KiCad's naming from the schematics alone)
if (args.includes('--derive') && board) for (const n of board.nets) { n.bag.delete('KICADNAME'); n.bag.delete('KICADNAMEFOR'); }
const prjFile = readPrjPcb(proj.prj.bytes, proj.prj.name);
const back = exportKicad({ name: proj.name, sheets, board, hierarchyMode: mode, variables: projectParameters(prjFile), kicad: keptProjectFiles((k) => iniGet(prjFile, 'KiCad', k)) });
const ms = Date.now() - t0;
if (out) for (const f of back.files) { const p = join(out, f.path); mkdirSync(p.split('/').slice(0, -1).join('/'), { recursive: true }); writeFileSync(p, f.bytes); }

const report: string[] = [`KiCad round trip: ${relative(process.cwd(), dir) || dir} (${proj.name}): ${sheets.length} sheets, ${board ? 'a board' : 'no board'}; ${ms} ms`];
const origPcb = files.find((f) => /\.kicad_pcb$/i.test(f.path) && f.path.replace(/.*\//, '').replace(/\.kicad_pcb$/i, '') === proj.name) ?? files.find((f) => /\.kicad_pcb$/i.test(f.path));
const backPcb = back.files.find((f) => /\.kicad_pcb$/i.test(f.path));
if (origPcb && backPcb) {
  const a = parseSexpr(td.decode(origPcb.bytes)), b = parseSexpr(td.decode(backPcb.bytes));
  const [dx, dy] = shift(a, b);
  // Each KiCad net's name in Konium's copy, by the pads it reaches (the most of them)
  const padNets = (pcb: SList) => { const t = netNames(pcb); const m = new Map<string, string>(); for (const fp of kids(pcb, 'footprint')) { const ref = str(kids(fp, 'property').find((p) => str(p, 0) === 'Reference'), 1) ?? str(kids(fp, 'fp_text').find((x) => str(x, 0) === 'reference'), 1) ?? ''; for (const p of kids(fp, 'pad')) m.set(`${ref}-${str(p, 0)}@${xy(kid(p, 'at')).join(',')}`, netRaw(p, t)); } return m; };
  const pa = padNets(a), pb = padNets(b);
  const votes = new Map<string, Map<string, number>>();
  for (const [k, n] of pa) { if (!n || !pb.has(k)) continue; const v = votes.get(n) ?? new Map(); v.set(pb.get(k)!, (v.get(pb.get(k)!) ?? 0) + 1); votes.set(n, v); }
  const toBack = new Map([...votes].map(([n, v]) => [n, [...v].sort((x, y) => y[1] - x[1])[0]![0]]));
  const kept = [...toBack].filter(([n, m]) => n === m).length;
  // (a net KiCad named after a pad or a sheet path, Net-(D1-K), /VPP{slash}MCLR, renamed is a loss too)
  const renamed = [...toBack].filter(([n, m]) => n !== m);
  report.push(`\nNets: ${toBack.size} on pads; ${kept} keep their names, ${renamed.length} renamed (${renamed.slice(0, MAX).map(([n, m]) => `${n} -> ${m || '(none)'}`).join('; ')})`);
  const backToOrig = new Map([...toBack].filter(([, m]) => m).map(([n, m]) => [m, n]));
  report.push(table(`\nBoard, nets matched by their pads (Konium's copy shifted by ${dx}, ${dy} mm)`, compare(boardObjects(a, 0, 0), boardObjects(b, dx, dy, backToOrig))));
}
// The project's own sheets: its root and those its sheets name (a folder may hold other projects', or files no sheet uses)
const schFiles = files.filter((f) => /\.kicad_sch$/i.test(f.path));
const base = (p: string) => p.replace(/.*\//, '').replace(/\.kicad_sch$/i, '');
const rootSch = schFiles.find((f) => base(f.path) === proj.name) ?? (schFiles.length === 1 ? schFiles[0] : undefined);
const origSch: SList[] = [], ownSchText: string[] = [];
for (const seen = new Set<string>(), queue = rootSch ? [rootSch.path] : []; queue.length;) {
  const p = queue.shift()!;
  if (seen.has(p.toLowerCase())) continue;
  seen.add(p.toLowerCase());
  const f = schFiles.find((x) => x.path.toLowerCase() === p.toLowerCase());
  if (!f) continue;
  const tree = parseSexpr(td.decode(f.bytes));
  origSch.push(tree);
  ownSchText.push(td.decode(f.bytes));
  const dirOf = p.includes('/') ? p.replace(/\/[^/]*$/, '/') : '';
  for (const sh of kids(tree, 'sheet')) {
    const file = str(kids(sh, 'property').find((x) => /^Sheet ?file$/i.test(str(x, 0) ?? '')), 1);
    if (file) queue.push((dirOf + file.replace(/\\/g, '/')).replace(/(^|\/)\.\//g, '$1'));
  }
}
const unused = schFiles.length - origSch.length;
const backSch = back.files.filter((f) => /\.kicad_sch$/i.test(f.path)).map((f) => parseSexpr(td.decode(f.bytes)));
if (origSch.length) report.push(table(`\nSchematics (${origSch.length} files in${unused ? ` (${unused} more in the folder, not this project's)` : ''}, ${backSch.length} out)`, compare(schematicObjects(origSch, proj.name), schematicObjects(backSch, proj.name))));
// The schematics' library symbols (lib_symbols), by name, item by item
{
  const byName = (trees: SList[]) => { const m = new Map<string, SList>(); for (const t of trees) for (const x of kids(kid(t, 'lib_symbols'), 'symbol')) if (!m.has(str(x) ?? '')) m.set(str(x) ?? '', x); return m; };
  const a = byName(origSch), b = byName(backSch);
  let same = 0, changed = 0, lost = 0;
  const kinds = new Map<string, number>(), ex: string[] = [];
  for (const [name, an] of a) {
    const bn = b.get(name);
    if (!bn) { lost++; if (ex.length < MAX) ex.push(`    lost     ${name}`); continue; }
    const ai = symbolItems(an), bi = symbolItems(bn);
    let ok = true;
    for (const k of new Set([...ai.keys(), ...bi.keys()])) {
      const x = [...(ai.get(k) ?? [])].sort().join('\n'), y = [...(bi.get(k) ?? [])].sort().join('\n');
      if (x === y) continue;
      ok = false;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      if (ex.length < MAX) { const xs = ai.get(k) ?? [], ys = bi.get(k) ?? []; ex.push(`    changed  [${name}] ${k}: ${(xs.find((v) => !ys.includes(v)) ?? '(none)').slice(0, 120)} -> ${(ys.find((v) => !xs.includes(v)) ?? '(none)').slice(0, 120)}`); }
    }
    if (ok) same++; else changed++;
  }
  if (a.size) {
    report.push(`\nLibrary symbols in the schematics: ${a.size}, ${same} the same, ${changed} changed (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}), ${lost} lost, ${[...b.keys()].filter((n) => !a.has(n)).length} added`);
    report.push(...ex);
  }
}
// The project's settings (.kicad_pro, every value by its path), custom rules and local settings
{
  const flat = (v: unknown, at: string, out: Map<string, string>) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flat(x, at ? `${at}.${k}` : k, out);
    else out.set(at, JSON.stringify(v));
    return out;
  };
  const orig = files.find((f) => /\.kicad_pro$/i.test(f.path) && base(f.path.replace(/\.kicad_pro$/i, '.kicad_sch')) === proj.name) ?? files.find((f) => /\.kicad_pro$/i.test(f.path));
  const out = back.files.find((f) => /\.kicad_pro$/i.test(f.path));
  if (orig && out) {
    const a = flat(JSON.parse(td.decode(orig.bytes)), '', new Map()), b = flat(JSON.parse(td.decode(out.bytes)), '', new Map());
    a.delete('meta.filename'); b.delete('meta.filename');
    const changed = [...a].filter(([k, v]) => b.has(k) && b.get(k) !== v), lost = [...a.keys()].filter((k) => !b.has(k)), added = [...b.keys()].filter((k) => !a.has(k));
    report.push(`\nProject settings: ${a.size} values, ${a.size - changed.length - lost.length} the same, ${changed.length} changed, ${lost.length} lost, ${added.length} added`);
    for (const [k, v] of changed.slice(0, MAX)) report.push(`    changed  ${k}: ${v.slice(0, 80)} -> ${b.get(k)!.slice(0, 80)}`);
    for (const k of lost.slice(0, MAX)) report.push(`    lost     ${k}`);
    for (const k of added.slice(0, MAX)) report.push(`    added    ${k}`);
  }
  for (const ext of ['.kicad_dru', '.kicad_prl']) {
    const o = files.find((f) => f.path.toLowerCase().endsWith(ext) && orig && f.path.slice(0, -ext.length) === orig.path.slice(0, -'.kicad_pro'.length));
    if (!o) continue;
    const w = back.files.find((f) => f.path.toLowerCase().endsWith(ext));
    report.push(`${ext}: ${!w ? 'lost' : td.decode(w.bytes) === td.decode(o.bytes) ? 'the same' : 'changed'}`);
  }
}
// KiCad's uuids kept (a file's, each object's): of those in the project's own files, how many are in the files written
{
  const ids = (t: string) => [...t.matchAll(/\((?:uuid|tstamp) "?([0-9a-fA-F-]{36})"?\)/g)].map((m) => m[1]!.toLowerCase());
  const count = (ext: string, orig: string[]) => {
    const a = new Set(orig.flatMap(ids));
    const b = new Set(back.files.filter((f) => f.path.toLowerCase().endsWith(ext)).flatMap((f) => ids(td.decode(f.bytes))));
    return `${[...a].filter((x) => b.has(x)).length} of ${a.size}`;
  };
  // (the project's own files: its sheets, its board)
  const pcbText = files.filter((f) => /\.kicad_pcb$/i.test(f.path) && base(f.path.replace(/\.kicad_pcb$/i, '.kicad_sch')) === proj.name).map((f) => td.decode(f.bytes));
  report.push(`uuids kept: schematics ${count('.kicad_sch', ownSchText)}, board ${count('.kicad_pcb', board ? pcbText : [])}`);
}
if (DEEP) report.push(deepReport());
const warns = [...imported.messages, ...back.messages].filter((m) => m.level !== 'info');
if (warns.length) report.push(`\nMessages (${warns.length}):\n${warns.slice(0, 12).map((m) => `  ${m.level} ${m.source}: ${m.message}`).join('\n')}`);
console.log(report.join('\n'));
