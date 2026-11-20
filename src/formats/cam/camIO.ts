/**
 * The CAM editor's File › Import and Export (CAMtastic): IPC-D-356 netlists (read, to compare with;
 * written from the extracted nets), IPC-D-350 [est: a subset], DXF (read: lines, arcs, circles,
 * polylines with bulges, text, solids, blocks; written: R12), HPGL / HPGL-2 plots, ODB++ jobs (read
 * and written as .tgz), Windows bitmaps of the films, part centroids, aperture libraries (.LIB:
 * aperture macros and their D-codes), and a CAM document turned into a board (Export to PCB).
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_INCH, UNITS_PER_MM, type Aperture, type DrillLayer, type GerberLayer, type GerberObject } from '../gerber/gerberRead';
import { readGerber } from '../gerber/gerberRead';
import { camExtent, colourOf, sortLayers, type CamDocument, type CamLayer, type CamLayerType } from './camDoc';
import { apertureDefText, findOrAddAperture, findOrAddTool, liveObjects, objectOrder, textDraws } from './camModel';
import { coverOf } from './camOps';
import { boardOutline } from './camProcess';
import { platedLayers } from './camAnalysis';
import { gzip, tar } from '../tar';

const um = (c: number) => Math.round(c / UNITS_PER_MM * 1000);
const f6 = (c: number) => String(+(c / UNITS_PER_MM).toFixed(6));
const emptyGerber = (units: 'in' | 'mm' = 'mm'): GerberLayer => ({ kind: 'gerber', units, attributes: {}, apertures: new Map(), macros: new Map(), objects: [], negative: false, warnings: [] });
const emptyDrill = (units: 'in' | 'mm' = 'mm'): DrillLayer => ({ kind: 'drill', units, tools: new Map(), hits: [], routes: [], warnings: [] });
const layerOf = (name: string, type: CamLayerType, data: GerberLayer | DrillLayer): CamLayer => ({ name, type, colour: colourOf(type), visible: true, text: '', data, edited: true });

/* ─── IPC-D-356 ────────────────────────────────────────────────────────────────────── */

export type RefNet = NonNullable<CamDocument['refNets']>[number];

/** An IPC-D-356(A) netlist: each net's test points (317 through-hole, 327 surface) with their side, part and pin. */
export function readIpc356(text: string): RefNet[] {
  let k = UNITS_PER_INCH / 10000;
  const alias = new Map<string, string>();
  const nets = new Map<string, RefNet>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^P\s+UNITS\s+CUST\s+1/i.test(line) || /^P\s+UNITS\s+SI/i.test(line)) k = UNITS_PER_MM / 1000;
    else if (/^P\s+UNITS\s+CUST\s+[02]/i.test(line)) k = UNITS_PER_INCH / 10000;
    const al = /^P\s+(NNAME\d+)\s+(.+)$/.exec(line);
    if (al) { alias.set(al[1]!, al[2]!.trim()); continue; }
    if (!/^3[1-6]7/.test(line)) continue;
    let name = line.slice(3, 17).trim();
    name = alias.get(name) ?? name;
    if (!name || name === 'N/C') continue;
    const ref = line.slice(20, 26).trim(), pin = line.slice(27, 31).trim();
    const xy = /X([+-]\d+)\s*Y([+-]\d+)/.exec(line.slice(30)) ?? /X([+-]\d+)\s*Y([+-]\d+)/.exec(line);
    if (!xy) continue;
    const acc = /A(\d\d)/.exec(line.slice(30));
    const side = acc?.[1] === '01' ? 'top' : acc?.[1] === '02' ? 'bottom' : 'both';
    const n = nets.get(name) ?? { name, points: [] };
    n.points.push({ at: { x: Number(xy[1]) * k, y: Number(xy[2]) * k }, side, ...(ref ? { ref } : {}), ...(pin ? { pin } : {}) });
    nets.set(name, n);
  }
  return [...nets.values()];
}

/** The test points of the extracted nets: each plated hole, and each pad flashed on an outer copper layer without a hole. */
function testPoints(d: CamDocument): { net: string; at: Vec2; hole: number; plated: boolean; side: 'top' | 'bottom' | 'both'; w: number; h: number }[] {
  const out: { net: string; at: Vec2; hole: number; plated: boolean; side: 'top' | 'bottom' | 'both'; w: number; h: number }[] = [];
  const byName = new Map(d.layers.map((l) => [l.name, l]));
  const plated = new Set(platedLayers(d));
  for (const n of d.nets ?? []) {
    const holeAt = new Set<string>();
    for (const [ln, idx] of Object.entries(n.members)) {
      const l = byName.get(ln);
      if (l?.data.kind !== 'drill') continue;
      for (const i of idx) { const h = l.data.hits[i]!; holeAt.add(`${Math.round(h.at.x / 5000)},${Math.round(h.at.y / 5000)}`); out.push({ net: n.name, at: h.at, hole: l.data.tools.get(h.tool) ?? 0, plated: plated.has(l), side: 'both', w: l.data.tools.get(h.tool) ?? 0, h: l.data.tools.get(h.tool) ?? 0 }); }
    }
    for (const [ln, idx] of Object.entries(n.members)) {
      const l = byName.get(ln);
      if (l?.data.kind !== 'gerber' || (l.type !== 'Top' && l.type !== 'Bottom')) continue;
      const g = l.data;
      for (const i of idx) {
        const o = g.objects[i]!;
        if (o.kind !== 'flash' || holeAt.has(`${Math.round(o.at.x / 5000)},${Math.round(o.at.y / 5000)}`)) continue;
        const a = g.apertures.get(o.ap);
        out.push({ net: n.name, at: o.at, hole: 0, plated: false, side: l.type === 'Top' ? 'top' : 'bottom', w: a?.w ?? 0, h: a?.h ?? 0 });
      }
    }
  }
  return out;
}

/** File › Export › Netlist: the extracted nets as IPC-D-356A (0.0001 inch). */
export function writeIpc356(d: CamDocument, now = new Date()): string {
  const u = (c: number) => Math.round(c / 1000);
  const num = (v: number, n: number) => `${v < 0 ? '-' : '+'}${String(Math.min(Math.abs(v), 10 ** n - 1)).padStart(n, '0')}`;
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ');
  const two = (n: number) => String(n).padStart(2, '0');
  const lines = [`C  IPC-D-356A netlist of ${d.name}`, `C  Written by Konium Designer's CAM editor ${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()}`, 'C',
    `P  JOB   ${d.name.replace(/\.cam$/i, '')}`, 'P  UNITS CUST 0', 'P  DIM   N'];
  const alias = new Map<string, string>();
  const col = (n: string) => { if (n.length <= 14) return n; let a = alias.get(n); if (!a) { a = `NNAME${alias.size + 1}`; alias.set(n, a); lines.push(`P  ${pad(a, 8)}${n}`); } return a; };
  const pts = testPoints(d);
  for (const p of pts) col(p.net);
  for (const p of pts) {
    const thru = p.hole > 0;
    lines.push([thru ? '317' : '327', pad(col(p.net), 14), '   ', pad('', 6), ' ', pad('', 4), ' ', thru ? `D${String(Math.min(u(p.hole), 9999)).padStart(4, '0')}${p.plated ? 'P' : 'U'}` : '      ',
      `A${p.side === 'top' ? '01' : p.side === 'bottom' ? '02' : '00'}`, `X${num(u(p.at.x), 6)}Y${num(u(p.at.y), 6)}`,
      `X${String(Math.min(u(p.w), 9999)).padStart(4, '0')}Y${String(Math.min(u(p.h), 9999)).padStart(4, '0')}R000`, ' ', `S${p.side === 'top' ? 1 : p.side === 'bottom' ? 2 : 3}`].join('').padEnd(80, ' '));
  }
  // The board's edge (389 records)
  const outline = boardOutline(d);
  for (const p of outline) lines.push(`389BOARD_EDGE       X${num(u(p.x), 6)}Y${num(u(p.y), 6)}`.padEnd(80, ' '));
  lines.push('999');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * File › Export › IPC-D-350 [est: the subset CAMtastic writes]: the job's parameters, each layer's
 * features counted, the board's edge, then the netlist's test records as IPC-D-350's 3xx records.
 */
export function writeIpc350(d: CamDocument, now = new Date()): string {
  const body = writeIpc356(d, now).split('\r\n').filter((l) => /^(3|999)/.test(l));
  const head = [`C  IPC-D-350 of ${d.name}`, 'C  Written by Konium Designer\'s CAM editor', 'P  UNITS CUST 0', `P  JOB   ${d.name.replace(/\.cam$/i, '')}`];
  d.layers.forEach((l, k) => head.push(`C  LAYER ${String(k + 1).padStart(2, '0')} ${l.name.padEnd(24)} ${l.type.padEnd(14)} ${l.data.kind === 'gerber' ? liveObjects(l).length : l.data.hits.length} features`));
  return `${[...head, ...body].join('\r\n')}\r\n`;
}

/* ─── DXF ──────────────────────────────────────────────────────────────────────────── */

type Pair = [number, string];
function dxfPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]!.trim()), lines[i + 1]!.trim()]);
  return out;
}

/**
 * A DXF drawing's entities as a CAM layer per DXF layer (or all on one): lines, arcs, circles, polylines
 * (their bulges as arcs, a width as the aperture), points, text (the stroke font), solids, and blocks
 * inserted (moved, scaled, turned). Units: the drawing's $INSUNITS, else `unit`.
 */
export function readDxf(text: string, o: { unit: 'mm' | 'in' | 'mil'; width: number; oneLayer?: string }): CamLayer[] {
  const pairs = dxfPairs(text);
  let k = o.unit === 'in' ? UNITS_PER_INCH : o.unit === 'mil' ? UNITS_PER_INCH / 1000 : UNITS_PER_MM;
  // Header: $INSUNITS
  for (let i = 0; i < pairs.length; i++) if (pairs[i]![1] === '$INSUNITS' && pairs[i + 1]) { const u = Number(pairs[i + 1]![1]); k = u === 1 ? UNITS_PER_INCH : u === 2 ? UNITS_PER_INCH * 12 : u === 4 ? UNITS_PER_MM : u === 5 ? UNITS_PER_MM * 10 : u === 6 ? UNITS_PER_MM * 1000 : u === 9 ? UNITS_PER_INCH / 1000 : k; break; }
  type Ent = { type: string; layer: string; g: Map<number, string[]>; pairs: Pair[]; bulge?: number[] };
  const entities: Ent[] = [], blocks = new Map<string, { base: Vec2; ents: Ent[] }>();
  let section = '', block: { name: string; base: Vec2; ents: Ent[] } | null = null, cur: Ent | null = null;
  const flush = () => { if (cur) { if (block) block.ents.push(cur); else if (section === 'ENTITIES') entities.push(cur); } cur = null; };
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i]!;
    if (c === 0) {
      flush();
      if (v === 'SECTION') { section = pairs[i + 1]?.[1] ?? ''; continue; }
      if (v === 'ENDSEC') { section = ''; continue; }
      if (section === 'BLOCKS' && v === 'BLOCK') { block = { name: '', base: { x: 0, y: 0 }, ents: [] }; cur = null; let j = i + 1; for (; j < pairs.length && pairs[j]![0] !== 0; j++) { const [cc, vv] = pairs[j]!; if (cc === 2) block.name = vv; if (cc === 10) block.base.x = Number(vv); if (cc === 20) block.base.y = Number(vv); } i = j - 1; continue; }
      if (v === 'ENDBLK') { if (block) blocks.set(block.name, { base: block.base, ents: block.ents }); block = null; continue; }
      if (section === 'ENTITIES' || block) cur = { type: v, layer: '0', g: new Map(), pairs: [] };
      continue;
    }
    if (cur) { if (c === 8) cur.layer = v; const a = cur.g.get(c); if (a) a.push(v); else cur.g.set(c, [v]); cur.pairs.push([c, v]); }
  }
  flush();
  const layers = new Map<string, CamLayer>();
  const layerFor = (name: string) => {
    const n = o.oneLayer ?? name;
    let l = layers.get(n);
    if (!l) { l = layerOf(o.oneLayer ? n : `${n}.DXF`, 'Mechanical', emptyGerber('mm')); layers.set(n, l); }
    return l;
  };
  type T = (p: Vec2) => Vec2;
  const num = (e: Ent, c: number, at = 0, def = 0) => { const v = e.g.get(c)?.[at]; return v === undefined ? def : Number(v); };
  const emit = (e: Ent, T: T, scale: number, depth: number) => {
    const l = layerFor(e.layer), g = l.data as GerberLayer;
    const ap = (w: number) => findOrAddAperture(g, 'C', Math.max(1, w > 0 ? w * k * scale : o.width));
    const P = (x: number, y: number) => T({ x: x * k, y: y * k });
    const arcObj = (c: Vec2, r: number, a0: number, a1: number, w: number): GerberObject => {
      const s = (a0 * Math.PI) / 180, en = (a1 * Math.PI) / 180;
      const A = T({ x: c.x + r * Math.cos(s), y: c.y + r * Math.sin(s) }), B = T({ x: c.x + r * Math.cos(en), y: c.y + r * Math.sin(en) }), C = T(c);
      // A transform that mirrors turns the arc's direction (none here: only scale, turn, move)
      return { kind: 'arc', a: A, b: B, c: C, cw: false, ap: ap(w), dark: true };
    };
    switch (e.type) {
      case 'LINE': g.objects.push({ kind: 'draw', a: P(num(e, 10), num(e, 20)), b: P(num(e, 11), num(e, 21)), ap: ap(num(e, 39)), dark: true }); break;
      case 'CIRCLE': { const r = num(e, 40) * k; const c = { x: num(e, 10) * k, y: num(e, 20) * k }; const A = T({ x: c.x + r, y: c.y }); g.objects.push({ kind: 'arc', a: A, b: A, c: T(c), cw: false, ap: ap(num(e, 39)), dark: true }); break; }
      case 'ARC': g.objects.push(arcObj({ x: num(e, 10) * k, y: num(e, 20) * k }, num(e, 40) * k, num(e, 50), num(e, 51), num(e, 39))); break;
      case 'POINT': g.objects.push({ kind: 'flash', at: P(num(e, 10), num(e, 20)), ap: ap(0), dark: true }); break;
      case 'SOLID': case 'TRACE': case '3DFACE': {
        const pts = [P(num(e, 10), num(e, 20)), P(num(e, 11), num(e, 21)), P(num(e, 13), num(e, 23)), P(num(e, 12), num(e, 22))];
        g.objects.push({ kind: 'region', contours: [pts], dark: true });
        break;
      }
      case 'LWPOLYLINE': case 'POLYLINE': {
        const xs = e.g.get(10) ?? [], ys = e.g.get(20) ?? [];
        const closed = (num(e, 70) & 1) === 1;
        const w = num(e, 43, 0, num(e, 40));
        const pts = xs.map((x, i) => ({ x: Number(x) * k, y: Number(ys[i] ?? 0) * k }));
        polyObjects(pts, closed, e.bulge ?? [], T, ap(w)).forEach((x) => g.objects.push(x));
        break;
      }
      case 'TEXT': case 'MTEXT': {
        const s = (e.g.get(1)?.[0] ?? '').replace(/\\P/g, '\n').replace(/\{|\}|\\[A-Za-z][^;]*;/g, '');
        if (!s) break;
        const h = num(e, 40, 0, 2.5) * k * scale;
        for (const x of textDraws(s, P(num(e, 10), num(e, 20)), h, num(e, 50), false, ap(0), true, 0)) g.objects.push({ ...x, grp: undefined });
        break;
      }
      case 'INSERT': {
        if (depth > 4) break;
        const b = blocks.get(e.g.get(2)?.[0] ?? '');
        if (!b) break;
        const sx = num(e, 41, 0, 1), sy = num(e, 42, 0, 1), rot = (num(e, 50) * Math.PI) / 180, at = { x: num(e, 10) * k, y: num(e, 20) * k };
        const inner: T = (p) => { const x = (p.x - b.base.x * k) * sx, y = (p.y - b.base.y * k) * sy; return T({ x: at.x + x * Math.cos(rot) - y * Math.sin(rot), y: at.y + x * Math.sin(rot) + y * Math.cos(rot) }); };
        for (const be of b.ents) emit({ ...be, layer: be.layer === '0' ? e.layer : be.layer }, inner, scale * Math.abs(sx), depth + 1);
        break;
      }
    }
  };
  // A heavy POLYLINE's VERTEX entities are entities of their own: gather them into it
  const merged: Ent[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    if (e.type !== 'POLYLINE') { if (e.type !== 'VERTEX' && e.type !== 'SEQEND') merged.push(e); continue; }
    const xs: string[] = [], ys: string[] = [], bulge: number[] = [];
    for (i++; i < entities.length && entities[i]!.type === 'VERTEX'; i++) { const v = entities[i]!; xs.push(v.g.get(10)?.[0] ?? '0'); ys.push(v.g.get(20)?.[0] ?? '0'); bulge.push(Number(v.g.get(42)?.[0] ?? 0)); }
    const pe: Ent = { ...e, g: new Map(e.g), bulge };
    pe.g.set(10, xs); pe.g.set(20, ys);
    merged.push(pe);
  }
  // LWPOLYLINE bulges: each 42 belongs to the vertex (10) before it
  for (const e of merged) {
    if (e.type !== 'LWPOLYLINE') continue;
    const b: number[] = [];
    for (const [c, v] of e.pairs) { if (c === 10) b.push(0); else if (c === 42 && b.length) b[b.length - 1] = Number(v); }
    e.bulge = b;
  }
  for (const e of merged) emit(e, (p) => p, 1, 0);
  return [...layers.values()].filter((l) => (l.data as GerberLayer).objects.length);
}

/** A polyline's segments: lines, and arcs where a vertex has a bulge (the tangent of a quarter of the arc's angle). */
function polyObjects(pts: Vec2[], closed: boolean, bulges: number[], T: (p: Vec2) => Vec2, ap: number): GerberObject[] {
  const out: GerberObject[] = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!, bulge = bulges[i] ?? 0;
    if (!bulge) { out.push({ kind: 'draw', a: T(a), b: T(b), ap, dark: true }); continue; }
    const theta = 4 * Math.atan(bulge), chord = Math.hypot(b.x - a.x, b.y - a.y);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
    const u = { x: (b.x - a.x) / chord, y: (b.y - a.y) / chord }, nrm = { x: -u.y, y: u.x };
    const s = (bulge > 0) === (Math.abs(theta) < Math.PI) ? 1 : -1;
    const c = { x: mid.x + nrm.x * h * s, y: mid.y + nrm.y * h * s };
    out.push({ kind: 'arc', a: T(a), b: T(b), c: T(c), cw: bulge < 0, ap, dark: true });
  }
  return out;
}

/** File › Export › DXF: the shown layers as an R12 drawing in millimetres — a DXF layer each; draws as wide polylines, arcs, flashes and polygons as closed polylines, holes as circles. */
export function writeDxf(d: CamDocument): string {
  const out: string[] = [];
  const put = (c: number, v: string | number) => out.push(String(c), typeof v === 'number' ? String(+v.toFixed(6)) : v);
  const mmv = (c: number) => c / UNITS_PER_MM;
  const name = (l: CamLayer) => l.name.replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
  const shown = d.layers.filter((l) => l.visible);
  put(0, 'SECTION'); put(2, 'HEADER'); put(9, '$ACADVER'); put(1, 'AC1009'); put(9, '$INSUNITS'); put(70, 4); put(0, 'ENDSEC');
  put(0, 'SECTION'); put(2, 'TABLES'); put(0, 'TABLE'); put(2, 'LAYER'); put(70, shown.length);
  shown.forEach((l, k) => { put(0, 'LAYER'); put(2, name(l)); put(70, 0); put(62, (k % 6) + 1); put(6, 'CONTINUOUS'); });
  put(0, 'ENDTAB'); put(0, 'ENDSEC');
  put(0, 'SECTION'); put(2, 'ENTITIES');
  const poly = (ln: string, pts: Vec2[], closed: boolean, w = 0) => {
    put(0, 'POLYLINE'); put(8, ln); put(66, 1); put(10, 0); put(20, 0); put(30, 0); put(70, closed ? 1 : 0); if (w) { put(40, mmv(w)); put(41, mmv(w)); }
    for (const p of pts) { put(0, 'VERTEX'); put(8, ln); put(10, mmv(p.x)); put(20, mmv(p.y)); put(30, 0); }
    put(0, 'SEQEND'); put(8, ln);
  };
  for (const l of shown) {
    const ln = name(l);
    if (l.data.kind === 'drill') {
      const dd = l.data, er = new Set(l.erased ?? []);
      dd.hits.forEach((h, i) => { if (er.has(i)) return; const r = (dd.tools.get(h.tool) ?? 0) / 2; if (h.slot) poly(ln, [h.at, h.slot], false, 2 * r); else { put(0, 'CIRCLE'); put(8, ln); put(10, mmv(h.at.x)); put(20, mmv(h.at.y)); put(30, 0); put(40, mmv(h.circle ? h.circle / 2 : r)); } });
      for (const r of dd.routes) if (r.path.length > 1) poly(ln, r.path, false, dd.tools.get(r.tool) ?? 0);
      continue;
    }
    const g = l.data;
    for (const { o } of liveObjects(l)) {
      const a = o.kind === 'region' ? undefined : g.apertures.get(o.ap);
      const w = a ? Math.min(a.w, a.h) || a.w : 0;
      if (o.kind === 'draw') poly(ln, [o.a, o.b], false, w);
      else if (o.kind === 'arc') {
        const r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
        let s = (Math.atan2(o.a.y - o.c.y, o.a.x - o.c.x) * 180) / Math.PI, e = (Math.atan2(o.b.y - o.c.y, o.b.x - o.c.x) * 180) / Math.PI;
        if (o.cw) [s, e] = [e, s];
        if (Math.hypot(o.a.x - o.b.x, o.a.y - o.b.y) < 1) { put(0, 'CIRCLE'); put(8, ln); put(10, mmv(o.c.x)); put(20, mmv(o.c.y)); put(30, 0); put(40, mmv(r)); }
        else { put(0, 'ARC'); put(8, ln); put(10, mmv(o.c.x)); put(20, mmv(o.c.y)); put(30, 0); put(40, mmv(r)); put(50, s); put(51, e); }
      } else if (o.kind === 'flash' && a) for (const s of coverOf(o, g)) poly(ln, s, true);
      else if (o.kind === 'region') for (const c of o.contours) poly(ln, c, true);
    }
  }
  put(0, 'ENDSEC'); put(0, 'EOF');
  return `${out.join('\n')}\n`;
}

/* ─── HPGL ─────────────────────────────────────────────────────────────────────────── */

/** An HPGL / HPGL-2 plot as a layer: pen-down moves as draws of the pen's width, circles and arcs; plotter units 0.025 mm. */
export function readHpgl(text: string, name: string, penWidth = UNITS_PER_MM * 0.35): CamLayer {
  const g = emptyGerber('mm');
  const U = UNITS_PER_MM * 0.025;
  let x = 0, y = 0, down = false, abs = true, pen = 1;
  const widths = new Map<number, number>();
  const ap = () => findOrAddAperture(g, 'C', widths.get(pen) ?? penWidth);
  const src = text.replace(/\x1b%-?\d*[A-Z]/g, ';').replace(/\r?\n/g, ';');
  const re = /([A-Z]{2})([^A-Z;]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cmd = m[1]!.toUpperCase();
    const args = m[2]!.split(/[,\s]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
    const moveTo = (nx: number, ny: number) => { const to = abs ? { x: nx * U, y: ny * U } : { x: x + nx * U, y: y + ny * U }; if (down) g.objects.push({ kind: 'draw', a: { x, y }, b: to, ap: ap(), dark: true }); x = to.x; y = to.y; };
    switch (cmd) {
      case 'IN': x = 0; y = 0; down = false; abs = true; break;
      case 'SP': pen = args[0] ?? 1; break;
      case 'PW': if (args[0] !== undefined) widths.set(args[1] ?? pen, args[0] * UNITS_PER_MM); break;
      case 'PA': abs = true; for (let i = 0; i + 1 < args.length; i += 2) moveTo(args[i]!, args[i + 1]!); break;
      case 'PR': abs = false; for (let i = 0; i + 1 < args.length; i += 2) moveTo(args[i]!, args[i + 1]!); break;
      case 'PU': down = false; for (let i = 0; i + 1 < args.length; i += 2) moveTo(args[i]!, args[i + 1]!); break;
      case 'PD': down = true; for (let i = 0; i + 1 < args.length; i += 2) moveTo(args[i]!, args[i + 1]!); break;
      case 'CI': { const r = (args[0] ?? 0) * U; if (r > 0) { const a = { x: x + r, y }; g.objects.push({ kind: 'arc', a, b: a, c: { x, y }, cw: false, ap: ap(), dark: true }); } break; }
      case 'AA': case 'AR': {
        const c = cmd === 'AA' ? { x: (args[0] ?? 0) * U, y: (args[1] ?? 0) * U } : { x: x + (args[0] ?? 0) * U, y: y + (args[1] ?? 0) * U };
        const sweep = ((args[2] ?? 0) * Math.PI) / 180, r = Math.hypot(x - c.x, y - c.y), s = Math.atan2(y - c.y, x - c.x);
        const e = { x: c.x + r * Math.cos(s + sweep), y: c.y + r * Math.sin(s + sweep) };
        if (down && r > 0) g.objects.push({ kind: 'arc', a: { x, y }, b: Math.abs(sweep) >= 2 * Math.PI - 1e-9 ? { x, y } : e, c, cw: sweep < 0, ap: ap(), dark: true });
        x = e.x; y = e.y;
        break;
      }
      case 'EA': case 'ER': case 'RA': case 'RR': {
        const to = cmd[1] === 'A' ? { x: (args[0] ?? 0) * U, y: (args[1] ?? 0) * U } : { x: x + (args[0] ?? 0) * U, y: y + (args[1] ?? 0) * U };
        const c = [{ x, y }, { x: to.x, y }, to, { x, y: to.y }];
        if (cmd[0] === 'R') g.objects.push({ kind: 'region', contours: [c], dark: true });
        else for (let i = 0; i < 4; i++) g.objects.push({ kind: 'draw', a: c[i]!, b: c[(i + 1) % 4]!, ap: ap(), dark: true });
        break;
      }
    }
  }
  return layerOf(name, 'Mechanical', g);
}

/* ─── Bitmaps ──────────────────────────────────────────────────────────────────────── */

/** The shown layers drawn into pixels (the field black, each layer in its colour, clear objects cutting), `dpi` dots an inch. */
export function rasterise(d: CamDocument, dpi: number, maxPixels = 40e6): { w: number; h: number; rgb: Uint8Array } | null {
  const e = camExtent(d);
  if (!e) return null;
  const px = UNITS_PER_INCH / dpi;
  const w = Math.max(1, Math.ceil((e.maxX - e.minX) / px) + 2), h = Math.max(1, Math.ceil((e.maxY - e.minY) / px) + 2);
  if (w * h > maxPixels) return null;
  const rgb = new Uint8Array(w * h * 3);
  const fill = (poly: Vec2[], col: [number, number, number]) => {
    if (poly.length < 3) return;
    const P = poly.map((p) => ({ x: (p.x - e.minX) / px + 1, y: (e.maxY - p.y) / px + 1 }));
    let y0 = Infinity, y1 = -Infinity;
    for (const p of P) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    for (let yy = Math.max(0, Math.floor(y0)); yy <= Math.min(h - 1, Math.ceil(y1)); yy++) {
      const sy = yy + 0.5, xs: number[] = [];
      for (let i = 0; i < P.length; i++) { const a = P[i]!, b = P[(i + 1) % P.length]!; if ((a.y > sy) !== (b.y > sy)) xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y)); }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let xx = Math.max(0, Math.ceil(xs[k]! - 0.5)); xx <= Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5)); xx++) { const o = (yy * w + xx) * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2]; }
      }
    }
  };
  for (const l of d.layers) {
    if (!l.visible) continue;
    const c = parseInt(l.colour.replace('#', ''), 16) || 0xffffff;
    const col: [number, number, number] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    if (l.data.kind === 'drill') {
      const dd = l.data, er = new Set(l.erased ?? []);
      dd.hits.forEach((hh, i) => { if (er.has(i)) return; const r = (dd.tools.get(hh.tool) ?? 0) / 2; fill(Array.from({ length: 24 }, (_, k) => ({ x: hh.at.x + r * Math.cos((k * Math.PI) / 12), y: hh.at.y + r * Math.sin((k * Math.PI) / 12) })), col); });
      continue;
    }
    const g = l.data, er = new Set(l.erased ?? []);
    for (const i of objectOrder(l)) {
      if (er.has(i)) continue;
      const o = g.objects[i]!;
      const dark = l.composite?.length ? (l.composite[o.sub ?? 0]?.dark ?? true) === o.dark : o.dark;
      for (const s of coverOf(o, g)) fill(s, dark !== g.negative ? col : [0, 0, 0]);
    }
  }
  return { w, h, rgb };
}

/** A Windows bitmap (24 bits, rows bottom up) of pixels given top down. */
export function bmp(w: number, h: number, rgb: Uint8Array, dpi = 600): Uint8Array {
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h;
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true); const ppm = Math.round(dpi / 0.0254); v.setInt32(38, ppm, true); v.setInt32(42, ppm, true);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) { const s = (y * w + x) * 3; out[o + x * 3] = rgb[s + 2]!; out[o + x * 3 + 1] = rgb[s + 1]!; out[o + x * 3 + 2] = rgb[s]!; }
  }
  return out;
}

/* ─── Centroids, aperture libraries ────────────────────────────────────────────────── */

/** File › Export › Part Centroids: the parts as a pick-and-place table (CSV). */
export function centroidsCsv(d: CamDocument, unit: 'mil' | 'mm'): string {
  const f = (c: number) => (unit === 'mm' ? (c / UNITS_PER_MM).toFixed(4) : (c / 10000).toFixed(2));
  const o0 = d.origin ?? { x: 0, y: 0 };
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [`Designator,Mid X (${unit}),Mid Y (${unit}),Rotation,Layer,Value,Footprint`];
  for (const p of d.parts ?? []) rows.push([q(p.ref), f(p.at.x - o0.x), f(p.at.y - o0.y), String(p.rot), p.side === 'bottom' ? 'BottomLayer' : 'TopLayer', q(p.value ?? ''), q(p.footprint ?? '')].join(','));
  return `${rows.join('\r\n')}\r\n`;
}

/** File › Export › Aperture Library: a layer's aperture macros and apertures as Gerber's own definitions (a .LIB). */
export function apertureLibrary(l: CamLayer): string {
  const g = l.data as GerberLayer;
  const out = [`G04 Aperture library of ${l.name}, written by Konium Designer's CAM editor*`, `%MO${g.units === 'in' ? 'IN' : 'MM'}*%`];
  for (const [name, body] of g.macros) out.push(`%AM${name}*\n${body.join('*\n')}*%`);
  for (const code of [...g.apertures.keys()].sort((a, b) => a - b)) out.push(`%${g.apertures.get(code)!.def}*%`);
  return `${out.join('\n')}\n`;
}

/** File › Import › Custom Aperture Library: the library's macros and apertures added to a layer (D-codes in use given new numbers). Returns the D-codes added. */
export function readApertureLibrary(text: string, g: GerberLayer): number[] {
  const lib = readGerber(`${text}\nM02*`);
  const added: number[] = [];
  for (const [name, body] of lib.macros) if (!g.macros.has(name)) g.macros.set(name, body);
  for (const a of lib.apertures.values()) {
    let code = a.code;
    if (g.apertures.has(code)) { code = 10; for (const k of g.apertures.keys()) code = Math.max(code, k + 1); }
    // Kept in the layer's units: sizes as read, the definition written again for a standard aperture
    const def = a.shape === 'M' ? a.def.replace(/^ADD\d+/, `ADD${code}`) : apertureDefText(g.units, code, a.shape, a.w, a.h, a.vertices ?? 0, a.rotation ?? 0, a.hole ?? 0);
    g.apertures.set(code, { ...a, code, def });
    added.push(code);
  }
  return added;
}

/* ─── ODB++ ────────────────────────────────────────────────────────────────────────── */

const ODB_TYPE: Partial<Record<CamLayerType, string>> = { Top: 'SIGNAL', Bottom: 'SIGNAL', Internal: 'SIGNAL', Plane: 'POWER_GROUND', 'Top Silk': 'SILK_SCREEN', 'Bottom Silk': 'SILK_SCREEN', 'Top Mask': 'SOLDER_MASK', 'Bottom Mask': 'SOLDER_MASK', 'Top Paste': 'SOLDER_PASTE', 'Bottom Paste': 'SOLDER_PASTE', 'Drill Top': 'DRILL' };
const odbName = (s: string) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9_+\-.]+/g, '_').replace(/^_+|_+$/g, '') || 'layer';

/** An aperture as an ODB++ standard symbol (sizes in microns), or null for a shape that needs a surface. */
function odbSymbol(a: Aperture): string | null {
  if (a.hole) return null;
  if (a.shape === 'C') return `r${um(a.w)}`;
  if (a.shape === 'R') return a.w === a.h ? `s${um(a.w)}` : `rect${um(a.w)}x${um(a.h)}`;
  if (a.shape === 'O') return `oval${um(a.w)}x${um(a.h)}`;
  return null;
}

/** A layer's ODB++ features (millimetres, symbols in microns): lines, arcs, pads, surfaces; drill hits as pads. */
function odbFeatures(l: CamLayer): string {
  const syms: string[] = [];
  const sym = (s: string) => { let k = syms.indexOf(s); if (k < 0) { k = syms.length; syms.push(s); } return k; };
  const rec: string[] = [];
  const surf = (contours: Vec2[][], pol: string) => {
    rec.push(`S ${pol} 0`);
    contours.forEach((c, k) => { const ccw = c.reduce((t, p, i) => t + (p.x * c[(i + 1) % c.length]!.y - c[(i + 1) % c.length]!.x * p.y), 0) > 0; const pts = (k === 0) === ccw ? c : [...c].reverse(); rec.push(`OB ${f6(pts[0]!.x)} ${f6(pts[0]!.y)} ${k === 0 ? 'I' : 'H'}`); for (const p of [...pts.slice(1), pts[0]!]) rec.push(`OS ${f6(p.x)} ${f6(p.y)}`); rec.push('OE'); });
    rec.push('SE');
  };
  if (l.data.kind === 'drill') {
    const dd = l.data, er = new Set(l.erased ?? []);
    dd.hits.forEach((h, i) => { if (er.has(i)) return; const s = sym(`r${um(dd.tools.get(h.tool) ?? 0)}`); if (h.slot) rec.push(`L ${f6(h.at.x)} ${f6(h.at.y)} ${f6(h.slot.x)} ${f6(h.slot.y)} ${s} P 0`); else rec.push(`P ${f6(h.at.x)} ${f6(h.at.y)} ${s} P 0 0`); });
    for (const r of dd.routes) { const s = sym(`r${um(dd.tools.get(r.tool) ?? 0)}`); for (let k = 1; k < r.path.length; k++) rec.push(`L ${f6(r.path[k - 1]!.x)} ${f6(r.path[k - 1]!.y)} ${f6(r.path[k]!.x)} ${f6(r.path[k]!.y)} ${s} P 0`); }
  } else {
    const g = l.data;
    for (const i of objectOrder(l)) {
      if ((l.erased ?? []).includes(i)) continue;
      const o = g.objects[i]!;
      const pol = o.dark !== g.negative ? 'P' : 'N';
      if (o.kind === 'region') { surf(o.contours, pol); continue; }
      const a = g.apertures.get(o.ap);
      if (!a) continue;
      const s = odbSymbol(a);
      if (o.kind === 'flash') {
        // A shape with no standard symbol (a macro, a hole, a mirrored or scaled flash): its outline as a surface
        if (!s || o.mirror || o.scale) { for (const poly of coverOf(o, g)) surf([poly], pol); continue; }
        const rot = o.rot ?? 0;
        rec.push(rot % 90 === 0 ? `P ${f6(o.at.x)} ${f6(o.at.y)} ${sym(s)} ${pol} 0 ${(((-rot / 90) % 4) + 4) % 4}` : `P ${f6(o.at.x)} ${f6(o.at.y)} ${sym(s)} ${pol} 0 8 ${+((360 - rot) % 360).toFixed(3)}`);
        continue;
      }
      const ls = sym(s && a.shape === 'C' ? s : `r${um(Math.min(a.w, a.h) || a.w)}`);
      if (o.kind === 'draw') rec.push(`L ${f6(o.a.x)} ${f6(o.a.y)} ${f6(o.b.x)} ${f6(o.b.y)} ${ls} ${pol} 0`);
      else rec.push(`A ${f6(o.a.x)} ${f6(o.a.y)} ${f6(o.b.x)} ${f6(o.b.y)} ${f6(o.c.x)} ${f6(o.c.y)} ${ls} ${pol} 0 ${o.cw ? 'Y' : 'N'}`);
    }
  }
  return ['UNITS=MM', '#', '#Feature symbol names', '#', ...syms.map((s, k) => `$${k} ${s}`), '#', '#Layer features', '#', ...rec, ''].join('\n');
}

/** File › Export › ODB++: the document as an ODB++ (7) job: the matrix in stack order, a profile from the board's outline, each layer's features. */
export async function writeCamOdb(d: CamDocument, when = new Date()): Promise<{ name: string; bytes: Uint8Array }> {
  const job = odbName(d.name.replace(/\.cam$/i, ''));
  const files: { name: string; bytes: Uint8Array }[] = [];
  const enc = new TextEncoder();
  const put = (path: string, text: string) => files.push({ name: `${job}/${path}`, bytes: enc.encode(text) });
  const layers = [...d.layers].reverse(); // top of the stack first
  const used = new Set<string>();
  const nameOf = new Map<CamLayer, string>();
  for (const l of layers) { let n = odbName(l.name); while (used.has(n)) n = `${n}_1`; used.add(n); nameOf.set(l, n); }
  const copper = layers.filter((l) => ODB_TYPE[l.type] === 'SIGNAL' || l.type === 'Plane');
  const rows = layers.map((l, k) => {
    const type = ODB_TYPE[l.type] ?? 'DOCUMENT';
    return ['LAYER {', `   ROW=${k + 1}`, `   CONTEXT=${type === 'DOCUMENT' ? 'MISC' : 'BOARD'}`, `   TYPE=${type}`, `   NAME=${nameOf.get(l)}`, `   POLARITY=${l.data.kind === 'gerber' && l.data.negative ? 'NEGATIVE' : 'POSITIVE'}`,
      ...(type === 'DRILL' && copper.length ? [`   START_NAME=${nameOf.get(copper[0]!)}`, `   END_NAME=${nameOf.get(copper.at(-1)!)}`] : []), '   OLD_NAME=', '}', ''];
  });
  put('matrix/matrix', ['STEP {', '   COL=1', '   NAME=PCB', '}', '', ...rows.flat(), ''].join('\n'));
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}.${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
  put('misc/info', [`JOB_NAME=${job}`, 'ODB_VERSION_MAJOR=7', 'ODB_VERSION_MINOR=0', 'ODB_SOURCE=Konium Designer CAM editor', `CREATION_DATE=${stamp}`, `SAVE_DATE=${stamp}`, 'UNITS=MM', ''].join('\n'));
  put('steps/pcb/stephdr', ['UNITS=MM', 'X_DATUM=0', 'Y_DATUM=0', 'X_ORIGIN=0', 'Y_ORIGIN=0', ''].join('\n'));
  const outline = boardOutline(d);
  const prof = ['UNITS=MM', '#', '#Layer features', '#'];
  if (outline.length >= 3) { prof.push('S P 0', `OB ${f6(outline[0]!.x)} ${f6(outline[0]!.y)} I`, ...[...outline.slice(1), outline[0]!].map((p) => `OS ${f6(p.x)} ${f6(p.y)}`), 'OE', 'SE'); }
  put('steps/pcb/profile', [...prof, ''].join('\n'));
  for (const l of layers) put(`steps/pcb/layers/${nameOf.get(l)}/features`, odbFeatures(l));
  return { name: `${job}.tgz`, bytes: await gzip(tar(files, when)) };
}

/** Files of a tar archive. */
export function untar(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let o = 0, longName = '';
  while (o + 512 <= bytes.length) {
    const h = bytes.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => dec.decode(h.subarray(a, a + n)).replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix && str(257, 5) === 'ustar') name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156]!);
    const data = bytes.subarray(o + 512, o + 512 + size);
    if (type === 'L') longName = dec.decode(data).replace(/\0.*$/s, '');
    else if (type === '0' || type === '\0') { out.set(longName || name, data); longName = ''; }
    else longName = '';
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** File › Import › ODB++: a job (.tgz or .tar) as CAM layers — its matrix's layers in order, each one's lines, arcs, pads and surfaces; drill layers' pads as holes. */
export async function readOdb(bytes: Uint8Array): Promise<{ layers: CamLayer[]; warnings: string[] }> {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  const files = untar(raw);
  const dec = new TextDecoder();
  const find = (re: RegExp) => [...files.keys()].find((k) => re.test(k));
  const matrixKey = find(/(^|\/)matrix\/matrix$/);
  if (!matrixKey) throw new Error('No matrix/matrix in the archive: not an ODB++ job');
  const root = matrixKey.replace(/matrix\/matrix$/, '');
  const matrix = dec.decode(files.get(matrixKey));
  const blocks = [...matrix.matchAll(/(STEP|LAYER)\s*\{([^}]*)\}/g)].map((m) => ({ kind: m[1]!, props: Object.fromEntries([...m[2]!.matchAll(/(\w+)=([^\n\r]*)/g)].map((x) => [x[1]!.toUpperCase(), x[2]!.trim()])) }));
  const step = blocks.find((b) => b.kind === 'STEP')?.props.NAME?.toLowerCase() ?? [...files.keys()].map((k) => /steps\/([^/]+)\//.exec(k)?.[1]).find(Boolean) ?? 'pcb';
  const rows = blocks.filter((b) => b.kind === 'LAYER').sort((a, b) => Number(a.props.ROW) - Number(b.props.ROW));
  const signals = rows.filter((r) => ['SIGNAL', 'POWER_GROUND', 'MIXED'].includes(r.props.TYPE ?? ''));
  const warnings: string[] = [];
  const layers: CamLayer[] = [];
  for (const r of rows) {
    const name = (r.props.NAME ?? '').toLowerCase();
    const type0 = r.props.TYPE ?? 'DOCUMENT';
    if (type0 === 'COMPONENT') continue;
    const key = [...files.keys()].find((k) => k.toLowerCase() === `${root}steps/${step}/layers/${name}/features`.toLowerCase());
    if (!key) { if ([...files.keys()].some((k) => k.toLowerCase().startsWith(`${root}steps/${step}/layers/${name}/features.`.toLowerCase()))) warnings.push(`${name}: compressed features (features.z) can't be read`); continue; }
    const text = dec.decode(files.get(key));
    const si = signals.indexOf(r), above = rows.indexOf(r) < rows.indexOf(signals[Math.floor(signals.length / 2)] ?? r);
    const type: CamLayerType = type0 === 'SIGNAL' || type0 === 'MIXED' ? (si === 0 ? 'Top' : si === signals.length - 1 ? 'Bottom' : 'Internal')
      : type0 === 'POWER_GROUND' ? 'Plane' : type0 === 'SOLDER_MASK' ? (above ? 'Top Mask' : 'Bottom Mask') : type0 === 'SILK_SCREEN' ? (above ? 'Top Silk' : 'Bottom Silk')
        : type0 === 'SOLDER_PASTE' ? (above ? 'Top Paste' : 'Bottom Paste') : type0 === 'DRILL' ? 'Drill Top' : type0 === 'ROUT' ? 'Border' : 'Mechanical';
    const l = odbLayer(name, type, text, type0 === 'DRILL' || type0 === 'ROUT', r.props.POLARITY === 'NEGATIVE', warnings);
    if (l) layers.push(l);
  }
  return { layers: sortLayers(layers), warnings };
}

function odbLayer(name: string, type: CamLayerType, text: string, drill: boolean, negative: boolean, warnings: string[]): CamLayer | null {
  let k = UNITS_PER_MM, sk = UNITS_PER_MM / 1000;
  const syms = new Map<number, string>();
  const g = emptyGerber('mm'), d = emptyDrill('mm');
  g.negative = negative;
  const P = (x: string, y: string) => ({ x: Number(x) * k, y: Number(y) * k });
  let surf: { dark: boolean; contours: Vec2[][]; cur: Vec2[] | null } | null = null;
  const apOf = (n: number): number | null => {
    const s = (syms.get(n) ?? '').toLowerCase();
    const nums = (/[\d.]+(?:x[\d.]+)*/.exec(s)?.[0] ?? '').split('x').map(Number);
    if (/^r[\d.]/.test(s)) return findOrAddAperture(g, 'C', nums[0]! * sk);
    if (/^s[\d.]/.test(s)) return findOrAddAperture(g, 'R', nums[0]! * sk);
    if (/^rect/.test(s)) return findOrAddAperture(g, 'R', nums[0]! * sk, (nums[1] ?? nums[0]!) * sk);
    if (/^oval/.test(s)) return findOrAddAperture(g, 'O', nums[0]! * sk, (nums[1] ?? nums[0]!) * sk);
    if (/^donut_r/.test(s)) { const c = nextCode(g); g.apertures.set(c, { code: c, shape: 'C', w: nums[0]! * sk, h: nums[0]! * sk, hole: (nums[1] ?? 0) * sk, def: apertureDefText(g.units, c, 'C', nums[0]! * sk, nums[0]! * sk, 0, 0, (nums[1] ?? 0) * sk) }); return c; }
    if (nums[0]) { warnings.push(`${name}: symbol ${s} drawn as a round one of its first size [est]`); return findOrAddAperture(g, 'C', nums[0] * sk); }
    return null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^UNITS\s*=\s*INCH/i.test(line) || /^U\s+INCH/i.test(line)) { k = UNITS_PER_INCH; sk = UNITS_PER_INCH / 1000; continue; }
    if (/^UNITS\s*=\s*MM/i.test(line) || /^U\s+MM/i.test(line)) { k = UNITS_PER_MM; sk = UNITS_PER_MM / 1000; continue; }
    const sm = /^\$(\d+)\s+(\S+)/.exec(line);
    if (sm) { syms.set(Number(sm[1]), sm[2]!); continue; }
    const t = line.split(/\s+/);
    const pol = (p: string | undefined) => p !== 'N';
    if (surf) {
      if (t[0] === 'OB') { surf.cur = [P(t[1]!, t[2]!)]; continue; }
      if (t[0] === 'OS' && surf.cur) { surf.cur.push(P(t[1]!, t[2]!)); continue; }
      if (t[0] === 'OC' && surf.cur) {
        const from = surf.cur.at(-1)!, to = P(t[1]!, t[2]!), c = P(t[3]!, t[4]!), cw = t[5] === 'Y';
        const r = Math.hypot(from.x - c.x, from.y - c.y); let s = Math.atan2(from.y - c.y, from.x - c.x), e = Math.atan2(to.y - c.y, to.x - c.x);
        if (cw) { while (e >= s) e -= 2 * Math.PI; } else { while (e <= s) e += 2 * Math.PI; }
        const n = Math.max(4, Math.ceil(Math.abs(e - s) / (Math.PI / 24)));
        for (let j = 1; j <= n; j++) surf.cur.push({ x: c.x + r * Math.cos(s + ((e - s) * j) / n), y: c.y + r * Math.sin(s + ((e - s) * j) / n) });
        continue;
      }
      if (t[0] === 'OE') { if (surf.cur && surf.cur.length >= 3) { const c = surf.cur; if (Math.hypot(c[0]!.x - c.at(-1)!.x, c[0]!.y - c.at(-1)!.y) < 1) c.pop(); surf.contours.push(c); } surf.cur = null; continue; }
      if (t[0] === 'SE') { if (surf.contours.length) g.objects.push({ kind: 'region', contours: surf.contours, dark: surf.dark }); surf = null; continue; }
    }
    if (t[0] === 'S') { surf = { dark: pol(t[1]), contours: [], cur: null }; continue; }
    if (t[0] === 'L') {
      const a = P(t[1]!, t[2]!), b = P(t[3]!, t[4]!);
      if (drill) { const dia = Number((/[\d.]+/.exec(syms.get(Number(t[5])) ?? '')?.[0]) ?? 0) * sk; d.hits.push({ tool: findOrAddTool(d, dia), at: a, slot: b }); continue; }
      const ap = apOf(Number(t[5])); if (ap !== null) g.objects.push({ kind: 'draw', a, b, ap, dark: pol(t[6]) });
    } else if (t[0] === 'A') {
      const a = P(t[1]!, t[2]!), b = P(t[3]!, t[4]!), c = P(t[5]!, t[6]!);
      const ap = apOf(Number(t[7])); if (ap !== null && !drill) g.objects.push({ kind: 'arc', a, b, c, cw: t[10] === 'Y', ap, dark: pol(t[8]) });
    } else if (t[0] === 'P') {
      const at = P(t[1]!, t[2]!), n = Number(t[3]);
      if (drill) { const dia = Number((/[\d.]+/.exec(syms.get(n) ?? '')?.[0]) ?? 0) * sk; d.hits.push({ tool: findOrAddTool(d, dia), at }); continue; }
      const ap = apOf(n);
      if (ap === null) continue;
      const orient = Number(t[6] ?? 0);
      const rot = orient === 8 || orient === 9 ? (360 - Number(t[7] ?? 0)) % 360 : orient < 4 ? (360 - orient * 90) % 360 : (360 - (orient - 4) * 90) % 360;
      g.objects.push({ kind: 'flash', at, ap, dark: pol(t[4]), ...(rot ? { rot } : {}), ...(orient >= 4 && orient !== 8 ? { mirror: 'X' as const } : orient === 9 ? { mirror: 'X' as const } : {}) });
    }
  }
  if (drill) return d.hits.length ? layerOf(name, type, d) : null;
  return layerOf(name, type, g);
}
const nextCode = (g: GerberLayer) => { let c = 10; for (const k of g.apertures.keys()) c = Math.max(c, k + 1); return c; };

/* ─── Mill / rout files ────────────────────────────────────────────────────────────── */

/** File › Import › Mill/Rout: an Excellon rout file as a rout layer (Border). */
export function millLayer(name: string, text: string, make: (name: string, text: string) => CamLayer | null): CamLayer | null {
  const l = make(name, text);
  if (!l || l.data.kind !== 'drill') return null;
  return { ...l, type: 'Border', colour: colourOf('Border') };
}

