/**
 * The DRC torture board: the showcase board with faults of every kind Konium Designer's DRC checks
 * seeded on it, for running the desktop suite's DRC on the same board and comparing (drcCompare.ts).
 *
 *   npx vite-node tests/tools/drcTorture.ts <in.PcbDoc> <outdir>
 *     reads the showcase board (tests/tools/showcase/main.ts makes it) and writes to <outdir>:
 *     DrcTorture.PcbDoc   the board with the faults and a rule for each kind seeded
 *     Showcase.PcbDoc     the board as read, for opening beside it
 *     injected.md         every seeded fault: rule, objects, layer, where, and whether Konium finds it
 *     Showcase-konium.txt, DrcTorture-konium.txt   Konium's batch DRC, laid out as the suite's text report
 *   npx vite-node tests/tools/drcTorture.ts --report <in.PcbDoc> <out.txt>
 *     Konium's batch DRC of any board, as the suite's text report
 *   npx vite-node tests/tools/drcTorture.ts --demo-wire <outdir>
 *     the demo board with its +3V3 track between U1 and C2 replaced by a wire link, and the rules
 *     tests/wire148.test.ts adds for its DRC test (Demo-wire.PcbDoc), with Konium's report of it
 *
 * Every seeded object is made here, with the model's own record builders and edits; the board's
 * pours are repoured afterwards, so they flow round the new copper as the suite would pour them.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import RBush from 'rbush';
import {
  encodeArc, encodeBody, encodePad, encodeText, layerToName, readPcbDoc, writePcbDoc, writeVertices, type PadFields,
} from '../../src/formats/altium/pcbdoc';
import {
  CHECKED_KINDS, copperShapes, describe, distance, drcRules, drcUnits, lengthIn, outlineEdges, runDrc, type DrcReport, type DrcViolation, type Geom, type Shape,
} from '../../src/model/drc';
import { maskOpenings, textBox } from '../../src/model/drcMore';
import { drcSettings, setDrcSettings } from '../../src/model/drcOptions';
import {
  RULE_KIND_IDS, RULE_TREE, cloneRule, newRule, ruleDescription, ruleEnabled, ruleHeading, ruleKind, ruleLength, ruleName, rulePriority, ruleScope1, ruleScope2, type PcbRule,
} from '../../src/formats/altium/rules';
import { addObjects, addPads, addPolygon, addPrimRecords, addTracks, addVias, freshRecord, removePrims, repour, replaceRules } from '../../src/model/pcbEdit';
import { newPolygonProps } from '../../src/formats/altium/polygonProps';
import { PropertyBag } from '../../src/formats/altium/props';
import { L, layerName, type LayerId } from '../../src/model/layers';
import { NO_NET, inPour, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../../src/model/pcb';
import { formatAltiumLength, mil, mm, type Coord } from '../../src/core/units';
import { pointInPoly, type BBox, type Vec2 } from '../../src/core/geom';
import type { PcbRawRecord } from '../../src/formats/altium/framing';
import { demoPcbDoc } from '../../src/formats/synthetic/demo';
import { copperAt, placeWireLink, wireEnd, wireStart } from '../../src/model/wireLink';

/* ─── Konium's DRC as the suite's text report ─────────────────────────────────────────── */

const TREE_ORDER = new Map(RULE_TREE.map((t, i) => [t.kind, i]));
const two = (n: number) => String(n).padStart(2, '0');

/**
 * Konium's batch DRC of a board, laid out as the suite's text report: each rule checked with its
 * violations ("Processing Rule : …", "   Violation between …", "Rule Violations :n"), then the
 * Report Options' findings the same way, the total, and what Konium didn't check.
 */
export function koniumReport(doc: PcbDocument, fileName: string, kinds: Set<string> = drcSettings(doc).batch, when = new Date()): { text: string; report: DrcReport } {
  const t0 = performance.now();
  const r = runDrc(doc, kinds);
  const ms = performance.now() - t0;
  const units = r.units ?? drcUnits(doc), len = (c: Coord) => lengthIn(units, c);
  const holding = new Set(r.violations.filter((v) => v.error).map((v) => v.rule));
  const checked = drcRules(doc).filter((x) => ruleEnabled(x) && ((kinds.has(ruleKind(x)) && CHECKED_KINDS.includes(ruleKind(x))) || holding.has(ruleName(x))))
    .sort((a, b) => (TREE_ORDER.get(ruleKind(a)) ?? 999) - (TREE_ORDER.get(ruleKind(b)) ?? 999) || rulePriority(a) - rulePriority(b));
  const byRule = new Map<PcbRule, DrcViolation[]>(checked.map((x) => [x, []]));
  const other = new Map<string, DrcViolation[]>();
  for (const v of r.violations) {
    const named = checked.filter((x) => ruleName(x) === v.rule);
    const rule = named.find((x) => ruleKind(x) === v.kind) ?? (v.error ? named[0] : undefined);
    if (rule) byRule.get(rule)!.push(v);
    else { const l = other.get(v.rule) ?? []; l.push(v); other.set(v.rule, l); }
  }
  const out: string[] = [
    'Konium Designer Design Rule Check',
    `PCB File : ${fileName}`,
    `Date     : ${two(when.getDate())}/${two(when.getMonth() + 1)}/${when.getFullYear()}`,
    `Time     : ${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`,
    '',
  ];
  const block = (head: string, vs: DrcViolation[]) => {
    out.push(`Processing Rule : ${head}`);
    for (const v of vs) out.push(`   Violation between ${v.message}`);
    out.push(`Rule Violations :${vs.length}`, '');
  };
  for (const [rule, vs] of byRule) block(ruleHeading(rule, len), vs);
  for (const [name, vs] of other) block(name, vs);
  const s = Math.round(ms / 1000);
  out.push(`Violations Detected : ${r.violations.length}`, `Waived Violations : ${r.waived?.length ?? 0}`, `Time Elapsed        : ${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`);
  if (r.notes.length) out.push('', 'Not checked by Konium Designer:', ...r.notes.map((n) => `Note : ${n}`));
  return { text: `${out.join('\r\n')}\r\n`, report: r };
}

/* ─── Geometry ───────────────────────────────────────────────────────────────────────── */

type Side = 'top' | 'bottom';
const V = (x: number, y: number): Vec2 => ({ x: Math.round(x), y: Math.round(y) });
const plus = (a: Vec2, d: Vec2, t = 1): Vec2 => V(a.x + d.x * t, a.y + d.y * t);
const unit = (deg: number): Vec2 => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
const turn = (u: Vec2, deg: number): Vec2 => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return { x: u.x * c - u.y * s, y: u.x * s + u.y * c }; };
const norm = (d: Vec2): Vec2 => { const n = Math.hypot(d.x, d.y) || 1; return { x: d.x / n, y: d.y / n }; };
const far = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const seg = (a: Vec2, b: Vec2, w: number): Geom => ({ t: 'seg', a, b, r: w / 2 });
const disc = (c: Vec2, d: number): Geom => ({ t: 'circle', c, r: d / 2 });
const rectPts = (c: Vec2, w: number, h: number): Vec2[] => [V(c.x - w / 2, c.y - h / 2), V(c.x + w / 2, c.y - h / 2), V(c.x + w / 2, c.y + h / 2), V(c.x - w / 2, c.y + h / 2)];
const rect = (c: Vec2, w: number, h: number): Geom => ({ t: 'poly', pts: rectPts(c, w, h), holes: [] });
const circlePts = (c: Vec2, d: number): Vec2[] => Array.from({ length: 24 }, (_, k) => plus(c, unit(k * 15), d / 2));
function arcGeoms(c: Vec2, r: number, start: number, end: number, w: number): Geom[] {
  const sweep = ((end - start) % 360 + 360) % 360 || 360, n = Math.max(4, Math.ceil(sweep / 6));
  const pts = Array.from({ length: n + 1 }, (_, k) => plus(c, unit(start + (sweep * k) / n), r));
  return pts.slice(1).map((b, k) => seg(pts[k]!, b, w));
}
const arcEnd = (c: Vec2, r: number, a: number): Vec2 => plus(c, unit(a), r);
function boxOf(g: Geom, by = 0): BBox {
  if (g.t === 'circle') return { minX: g.c.x - g.r - by, minY: g.c.y - g.r - by, maxX: g.c.x + g.r + by, maxY: g.c.y + g.r + by };
  if (g.t === 'seg') return { minX: Math.min(g.a.x, g.b.x) - g.r - by, minY: Math.min(g.a.y, g.b.y) - g.r - by, maxX: Math.max(g.a.x, g.b.x) + g.r + by, maxY: Math.max(g.a.y, g.b.y) + g.r + by };
  const xs = g.pts.map((p) => p.x), ys = g.pts.map((p) => p.y);
  return { minX: Math.min(...xs) - by, minY: Math.min(...ys) - by, maxX: Math.max(...xs) + by, maxY: Math.max(...ys) + by };
}
const centreOf = (g: Geom): Vec2 => { const b = boxOf(g); return V((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2); };
/** The point of a shape nearest to p (a disc's centre; a polygon's outline). */
function nearestPoint(g: Geom, p: Vec2): Vec2 {
  const onSeg = (a: Vec2, b: Vec2) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return { x: a.x + t * dx, y: a.y + t * dy }; };
  if (g.t === 'circle') return g.c;
  if (g.t === 'seg') return onSeg(g.a, g.b);
  let best = g.pts[0]!, d = Infinity;
  g.pts.forEach((a, k) => { const q = onSeg(a, g.pts[(k + 1) % g.pts.length]!); const e = far(q, p); if (e < d) { d = e; best = q; } });
  return best;
}

/* ─── What is on the board already: copper (pours aside: they are repoured), holes, mask, silk, bodies ── */

interface Item extends BBox { i: number; g: Geom; side?: Side; layer?: LayerId; net?: number; bottom?: boolean }
interface Occ { copper: RBush<Shape>; holes: RBush<Item>; openings: RBush<Item>; silk: RBush<Item>; bodies: RBush<Item>; edges: Geom[]; outline: Vec2[] }

function occupancy(doc: PcbDocument): Occ {
  const copper = new RBush<Shape>();
  copper.load(copperShapes(doc).filter((s) => s.role !== 'keepout' && !inPour(doc.prims[s.prim]!)));
  const items = (list: { i: number; g: Geom; side?: Side; bottom?: boolean }[]) => { const t = new RBush<Item>(); t.load(list.map((x) => ({ ...x, ...boxOf(x.g) }))); return t; };
  const holes: { i: number; g: Geom }[] = [], silk: { i: number; g: Geom; side: Side }[] = [], bodies: { i: number; g: Geom; bottom: boolean }[] = [];
  doc.prims.forEach((p, i) => {
    if ((p.kind === 'pad' || p.kind === 'via') && p.hole > 0) holes.push({ i, g: disc(p.at, p.hole) });
    if (p.kind === 'body' && p.outline.length >= 3) bodies.push({ i, g: { t: 'poly', pts: p.outline, holes: [] }, bottom: p.bottom });
    if (p.kind === 'body' || p.kind === 'pad' || p.kind === 'via' || (p.layer !== L.TOP_OVERLAY && p.layer !== L.BOTTOM_OVERLAY)) return;
    const side: Side = p.layer === L.TOP_OVERLAY ? 'top' : 'bottom';
    if (p.kind === 'track') silk.push({ i, g: seg(p.a, p.b, p.width), side });
    else if (p.kind === 'arc') for (const g of arcGeoms(p.c, p.r, p.start, p.end, p.width)) silk.push({ i, g, side });
    else if (p.kind === 'text') { const g = textBox(p); if (g) silk.push({ i, g, side }); }
    else if (p.kind === 'fill') silk.push({ i, g: rect(V((p.a.x + p.b.x) / 2, (p.a.y + p.b.y) / 2), Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y)), side });
  });
  const verts = doc.board.vertices.length >= 3 ? doc.board.vertices : doc.board.outline.map((p) => ({ p }));
  return {
    copper, holes: items(holes), openings: items(maskOpenings(doc).map((o) => ({ i: o.i, g: o.g, side: o.side }))), silk: items(silk), bodies: items(bodies),
    edges: outlineEdges(verts).map(([a, b]) => seg(a, b, 0)), outline: doc.board.outline,
  };
}

/** What a candidate object takes up, with how far other things must keep from it. */
interface Cand {
  copper?: { layer: LayerId; g: Geom; margin?: number; skip?: (s: Shape) => boolean }[];
  holes?: { g: Geom; margin?: number; skip?: (i: number) => boolean }[];
  /** A pad's or via's mask opening; `silk`: kept 12 mil off silkscreen too (a pad: Silk To Solder Mask). */
  openings?: { side: Side; g: Geom; margin?: number; skip?: (i: number) => boolean; silk?: boolean; merge?: boolean }[];
  silk?: { side: Side; g: Geom; margin?: number; skip?: (i: number) => boolean }[];
  bodies?: { bottom: boolean; g: Geom; margin?: number }[];
  /** Inside the board, this far from its edge at least (geometry left out: outline faults). */
  inside?: { g: Geom; margin: number }[];
}
const SIGNAL: LayerId[] = [L.TOP, L.MID1, (L.MID1 + 1) as LayerId, L.BOTTOM];
const MID2 = (L.MID1 + 1) as LayerId;

/* ─── The seeding ─────────────────────────────────────────────────────────────────────── */

interface Fault {
  id: string; what: string;
  /** Rule kinds the suite should report it under; `also`: what follows from it (an open stub's antenna …). */
  rules: string[]; also: string[];
  layer: string; at: Vec2;
  /** The seeded objects, by signature; removed ones by signature too. */
  sigs: string[]; removed: string[];
  /** Text in a violation's message that names it (a component, a net's un-routed connection, a polygon). */
  keys: string[];
  /** Existing objects it is made against, and objects it took away. */
  against: string[];
}

/** An object's signature: kind, layer and coordinates (as stored), for finding it again after reading the file back. */
function sigOf(p: PcbPrim): string | null {
  switch (p.kind) {
    case 'track': return `track|${p.layer}|${p.a.x},${p.a.y}|${p.b.x},${p.b.y}|${p.width}`;
    case 'arc': return `arc|${p.layer}|${p.c.x},${p.c.y}|${p.r}|${p.start.toFixed(6)}|${p.end.toFixed(6)}|${p.width}`;
    case 'via': return `via|${p.at.x},${p.at.y}|${p.diameter}|${p.hole}|${p.layerStart}|${p.layerEnd}`;
    case 'pad': return `pad|${p.layer}|${p.at.x},${p.at.y}|${p.name}|${p.hole}`;
    case 'text': return `text|${p.layer}|${p.at.x},${p.at.y}|${p.text}`;
    case 'body': return `body|${p.outline.map((q) => `${q.x},${q.y}`).join(';')}`;
    default: return null;
  }
}

class Seeder {
  faults: Fault[] = [];
  private occCache: { prims: readonly PcbPrim[]; rules: unknown; occ: Occ } | null = null;
  usedNets = new Set<number>();
  private pending: { id: string; what: string; rules: string[]; also: string[]; layer: string; at: Vec2; against: string[]; keys: string[] } | null = null;
  private attachedCache = new Map<string, { prims: Set<number>; dirs: Vec2[] }>();
  private attachedOf: readonly PcbPrim[] | null = null;
  private sigs: string[] = [];
  private removed: string[] = [];
  constructor(public doc: PcbDocument, private log: (s: string) => void) {}

  get occ(): Occ {
    const d = this.doc;
    if (!this.occCache || this.occCache.prims !== d.prims || this.occCache.rules !== d.rules) this.occCache = { prims: d.prims, rules: d.rules, occ: occupancy(d) };
    return this.occCache.occ;
  }
  net(name: string): number { const n = this.doc.nets.findIndex((x) => x.name === name); if (n < 0) throw new Error(`no net ${name}`); return n; }
  netName(n: number): string { return n === NO_NET ? 'No Net' : this.doc.nets[n]?.name ?? String(n); }
  layerLabel(l: LayerId): string { return this.doc.board.layerNames.get(l) ?? layerName(l); }
  /** A board point from millimetres off the board's origin. */
  P(x: number, y: number): Vec2 { return V(this.doc.board.origin.x + mm(x), this.doc.board.origin.y + mm(y)); }

  /** Whether a candidate keeps clear of what is there (copper 12 mil, holes 15, mask 6, silk 12, bodies 20, the edge 30 by default). */
  fits(c: Cand): boolean {
    const o = this.occ;
    const near = <T extends BBox & { g: Geom }>(tree: RBush<T>, g: Geom, margin: number, ok: (x: T) => boolean) =>
      tree.search(boxOf(g, margin)).some((x) => ok(x) && distance(g, x.g, margin + 1) < margin);
    for (const k of c.copper ?? []) if (near(o.copper, k.g, k.margin ?? mil(12), (s) => s.layer === k.layer && !(k.skip?.(s)))) return false;
    for (const k of c.holes ?? []) if (near(o.holes, k.g, k.margin ?? mil(15), (x) => !(k.skip?.(x.i)))) return false;
    for (const k of c.openings ?? []) {
      // `merge`: an opening may run into another (one opening then, no sliver between them), not stop just short of it
      const m = k.margin ?? mil(6);
      if (o.openings.search(boxOf(k.g, m)).some((x) => { if (x.side !== k.side || k.skip?.(x.i)) return false; const d = distance(k.g, x.g, m + 1); return d < m && !(k.merge && d <= 0); })) return false;
      if (k.silk && near(o.silk, k.g, mil(12), (x) => x.side === k.side)) return false;
    }
    for (const k of c.silk ?? []) {
      if (near(o.silk, k.g, k.margin ?? mil(12), (x) => x.side === k.side && !(k.skip?.(x.i)))) return false;
      if (near(o.openings, k.g, mil(12), (x) => x.side === k.side && !(k.skip?.(x.i)))) return false;
    }
    for (const k of c.bodies ?? []) if (near(o.bodies, k.g, k.margin ?? mil(20), (x) => x.bottom === k.bottom)) return false;
    for (const k of c.inside ?? []) {
      if (!pointInPoly(centreOf(k.g), o.outline)) return false;
      if (o.edges.some((e) => distance(k.g, e, k.margin + 1) < k.margin)) return false;
    }
    return true;
  }

  /** Grid points round a centre, nearest first, inside an optional box (mm). */
  around(centre: Vec2, step = mil(10), reach = mil(1500), box?: [number, number, number, number]): Vec2[] {
    const pts: Vec2[] = [];
    const n = Math.ceil(reach / step);
    const b = box ? [this.P(box[0], box[1]), this.P(box[2], box[3])] : null;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const p = V(centre.x + i * step, centre.y + j * step);
      if (b && (p.x < b[0]!.x || p.y < b[0]!.y || p.x > b[1]!.x || p.y > b[1]!.y)) continue;
      pts.push(p);
    }
    return pts.sort((a, c) => far(a, centre) - far(c, centre));
  }

  /* ── recording ── */
  begin(id: string, what: string, rules: string[], layer: string, also: string[] = []): void { this.pending = { id, what, rules, also, layer, at: { x: 0, y: 0 }, against: [], keys: [] }; this.sigs = []; this.removed = []; }
  at(p: Vec2): void { this.pending!.at = p; }
  against(i: number | string): void { this.pending!.against.push(typeof i === 'string' ? i : describe(this.doc, i)); }
  key(k: string): void { this.pending!.keys.push(k); }
  end(): void { const p = this.pending!; this.faults.push({ ...p, sigs: this.sigs, removed: this.removed }); this.log(`  ${p.id} ${p.what}`); this.pending = null; }
  skipped: { id: string; what: string; why: string }[] = [];
  skip(why: string): void { const p = this.pending!; this.skipped.push({ id: p.id, what: p.what, why }); this.log(`  ${p.id} NOT SEEDED: ${why}`); this.pending = null; }

  /* ── making objects (each applied at once, so the next search sees it) ── */
  track(layer: LayerId, a: Vec2, b: Vec2, width: number, net = NO_NET): void {
    addTracks(this.doc, [{ layer, a, b, width, net: net === NO_NET ? undefined : net }]).apply();
    this.sigs.push(`track|${layer}|${a.x},${a.y}|${b.x},${b.y}|${width}`);
  }
  arc(layer: LayerId, c: Vec2, r: number, start: number, end: number, width: number, net = NO_NET): void {
    const a = { layer, c, r, start, end, width, net: net === NO_NET ? undefined : net };
    addPrimRecords(this.doc, [{ storage: 'Arcs6', rec: freshRecord(this.doc, 'Arcs6', (t) => encodeArc(a, t)) }]).apply();
    this.sigs.push(`arc|${layer}|${c.x},${c.y}|${r}|${start.toFixed(6)}|${end.toFixed(6)}|${width}`);
  }
  via(at: Vec2, diameter: number, hole: number, net = NO_NET, layerStart: LayerId = L.TOP, layerEnd: LayerId = L.BOTTOM): void {
    addVias(this.doc, [{ at, diameter, hole, net: net === NO_NET ? undefined : net, layerStart, layerEnd }]).apply();
    this.sigs.push(`via|${at.x},${at.y}|${diameter}|${hole}|${layerStart}|${layerEnd}`);
  }
  freePad(f: PadFields): void {
    addPads(this.doc, [f]).apply();
    this.sigs.push(`pad|${f.layer}|${f.at.x},${f.at.y}|${f.name}|${f.hole ?? 0}`);
  }
  text(layer: LayerId, at: Vec2, height: number, text: string, mirrored = false): void {
    addPrimRecords(this.doc, [{ storage: 'Texts6', rec: encodeText({ layer, at, height, strokeWidth: Math.round(height * 0.15), text, mirrored }) }]).apply();
    this.sigs.push(`text|${layer}|${at.x},${at.y}|${text}`);
  }
  /** Take a track out (recorded as removed, described as the suite would). */
  remove(t: PcbTrack): void {
    const o = this.doc.board.origin, u = drcUnits(this.doc), pt = (v: Vec2) => `(${lengthIn(u, v.x - o.x)},${lengthIn(u, v.y - o.y)})`;
    this.removed.push(sigOf(t)!);
    this.pending!.against.push(`removed: Track ${pt(t.a)}${pt(t.b)} on ${this.layerLabel(t.layer)} (${this.netName(t.net)}, ${lengthIn(u, t.width)} wide)`);
    removePrims(this.doc, [t]).apply();
  }
  /** Put a track taken out back (as a new record). */
  unremove(t: PcbTrack): void {
    this.removed.pop(); this.pending!.against.pop();
    addTracks(this.doc, [{ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net }]).apply();
  }

  /**
   * A component of this script's own: Components6 record, pads, 3D bodies, its designator and
   * comment (hidden, so its silk takes no part), as Place › Component leaves one.
   */
  component(c: { designator: string; pattern: string; comment: string; description: string; bottom?: boolean; at: Vec2; height: number;
    pads?: Omit<PadFields, 'component'>[]; bodies?: { outline: Vec2[]; z0: number; z1: number; colour: number }[];
    /** Whether the component and its pads are this fault's objects (else only what is added after it). */
    own?: boolean }): void {
    const own = c.own ?? true;
    const len = formatAltiumLength, bottom = !!c.bottom;
    const bag = PropertyBag.from({
      SELECTION: 'FALSE', LAYER: bottom ? 'BOTTOM' : 'TOP', LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0', PRIMITIVELOCK: 'TRUE',
      X: len(c.at.x), Y: len(c.at.y), PATTERN: c.pattern, NAMEON: 'FALSE', COMMENTON: 'FALSE', GROUPNUM: '0', COUNT: '0',
      ROTATION: ' 0.00000000000000E+0000', HEIGHT: len(c.height), NAMEAUTOPOSITION: '0', COMMENTAUTOPOSITION: '0',
      SOURCEDESIGNATOR: c.designator, SOURCEUNIQUEID: '', SOURCEHIERARCHICALPATH: '', SOURCEFOOTPRINTLIBRARY: '', SOURCECOMPONENTLIBRARY: '', SOURCELIBREFERENCE: c.comment,
      SOURCEDESCRIPTION: c.description, FOOTPRINTDESCRIPTION: c.description, COMMENT: c.comment, COMPONENTKIND: '0', CHANNELOFFSET: '-1',
    });
    const records: { storage: string; rec: PcbRawRecord }[] = [];
    for (const p of c.pads ?? []) { records.push({ storage: 'Pads6', rec: encodePad({ ...p, component: 0 }) }); if (own) this.sigs.push(`pad|${p.layer}|${p.at.x},${p.at.y}|${p.name}|${p.hole ?? 0}`); }
    for (const b of c.bodies ?? []) records.push({ storage: 'ComponentBodies6', rec: encodeBody({ component: 0, outline: b.outline, standoff: b.z0, overall: b.z1, colour: b.colour, layer: L.MECH1 + 12, bottom, at: c.at }) });
    const overlay = bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    records.push({ storage: 'Texts6', rec: encodeText({ layer: overlay, at: c.at, height: mil(40), strokeWidth: mil(6), text: c.designator, component: 0, isDesignator: true, mirrored: bottom }) });
    records.push({ storage: 'Texts6', rec: encodeText({ layer: overlay, at: c.at, height: mil(40), strokeWidth: mil(6), text: c.comment, component: 0, isComment: true, mirrored: bottom }) });
    addObjects(this.doc, { records: [], components: [{ bag, records }], polygons: [] }).apply();
    if (own) this.key(`Component ${c.designator}`);
  }

  /* ── finding places ── */

  /** Signal nets for stubs (supplies aside), not used by another fault yet. */
  signalNet(n: number): boolean {
    const name = this.netName(n);
    return n !== NO_NET && !this.usedNets.has(n) && !/^(GND|\+3V3A?|1V2|\+5V|VBUS(_F)?|SW)$/.test(name);
  }
  /** Through vias of signal nets, nearest a point first. */
  anchors(near: Vec2): { i: number; v: PcbVia }[] {
    return this.doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbVia; i: number } => x.p.kind === 'via' && x.p.layerStart === L.TOP && x.p.layerEnd === L.BOTTOM && this.signalNet(x.p.net))
      .map(({ p, i }) => ({ i, v: p })).sort((a, b) => far(a.v.at, near) - far(b.v.at, near));
  }
  /** Tracks and arcs of the via's net on a layer that end on it, and the directions they leave it in. */
  attached(i: number, layer: LayerId): { prims: Set<number>; dirs: Vec2[] } {
    if (this.attachedOf !== this.doc.prims) { this.attachedCache.clear(); this.attachedOf = this.doc.prims; }
    const key = `${i}:${layer}`, hit = this.attachedCache.get(key);
    if (hit) return hit;
    const r = this.attachedNow(i, layer);
    this.attachedCache.set(key, r);
    return r;
  }
  private attachedNow(i: number, layer: LayerId): { prims: Set<number>; dirs: Vec2[] } {
    const v = this.doc.prims[i] as PcbVia;
    const prims = new Set<number>([i]), dirs: Vec2[] = [];
    this.doc.prims.forEach((p, k) => {
      if (p.kind === 'track' && p.layer === layer && p.net === v.net) {
        const ea = far(p.a, v.at) <= v.diameter / 2, eb = far(p.b, v.at) <= v.diameter / 2;
        if (ea || eb) { prims.add(k); dirs.push(norm({ x: (ea ? p.b : p.a).x - v.at.x, y: (ea ? p.b : p.a).y - v.at.y })); }
      } else if (p.kind === 'arc' && p.layer === layer && p.net === v.net && (far(arcEnd(p.c, p.r, p.start), v.at) <= v.diameter / 2 || far(arcEnd(p.c, p.r, p.end), v.at) <= v.diameter / 2)) {
        prims.add(k); dirs.push(norm({ x: p.c.x - v.at.x, y: p.c.y - v.at.y }));
      }
    });
    return { prims, dirs };
  }
  /** Whether a direction leaving a via is at least 90° off every track already leaving it (no sharp corner at the via). */
  freeDir(dirs: Vec2[], u: Vec2): boolean { return dirs.every((d) => d.x * u.x + d.y * u.y <= 1e-6); }

  /**
   * A straight stub from a signal via on a layer, aimed at a target of another net: ending `gap`
   * from it, or (`cross`) passing through it and on past it by that much, or (`into`) that far
   * into it. Clear of everything else by 12 mil.
   */
  approach(o: { layer: LayerId; near: Vec2; target: (p: PcbPrim, s: Shape) => boolean; width: number; gap?: number; cross?: number; into?: number; maxLen?: number }): { via: number; target: number; a: Vec2; b: Vec2 } | null {
    const occ = this.occ, maxLen = o.maxLen ?? mil(150);
    const targets = occ.copper.all().filter((s) => s.layer === o.layer && !s.role && o.target(this.doc.prims[s.prim]!, s)).sort((a, b) => far(centreOf(a.g), o.near) - far(centreOf(b.g), o.near)).slice(0, 400);
    const vias = this.anchors(o.near);
    for (const t of targets) {
      const tc = centreOf(t.g);
      for (const { i, v } of vias) {
        if (v.net === t.net || far(v.at, tc) > maxLen + mil(80)) continue;
        if (far(v.at, tc) < mil(30)) continue;
        const q = nearestPoint(t.g, v.at);
        const L0 = far(q, v.at);
        if (L0 < mil(20)) continue;
        const u = norm({ x: q.x - v.at.x, y: q.y - v.at.y });
        const att = this.attached(i, o.layer);
        if (!this.freeDir(att.dirs, u)) continue;
        // Where the stub's end touches the target, by bisection
        const gapAt = (len: number) => distance(seg(v.at, plus(v.at, u, len), o.width), t.g);
        let lo = 0, hi = L0 + mil(5);
        if (gapAt(hi) > 0) continue;
        const want = o.gap ?? 0;
        for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (gapAt(mid) > want) lo = mid; else hi = mid; }
        let len = lo;
        if (o.cross !== undefined) len = lo + (t.g.t === 'seg' ? 2 * t.g.r : t.g.t === 'circle' ? 2 * t.g.r : mil(40)) + o.width + o.cross;
        if (o.into !== undefined) len = lo + o.into;
        const b = plus(v.at, u, len);
        if (len > maxLen || len < mil(15)) continue;
        if (o.gap !== undefined && Math.abs(distance(seg(v.at, b, o.width), t.g) - o.gap) > mil(0.2)) continue;
        const skip = (s: Shape) => att.prims.has(s.prim) || s.prim === t.prim;
        const g = seg(v.at, b, o.width);
        if (!this.fits({ copper: [{ layer: o.layer, g, skip }], inside: [{ g, margin: mil(30) }] })) continue;
        // and nothing else near the target's end of it closer than 12 mil (the target's neighbours)
        return { via: i, target: t.prim, a: v.at, b };
      }
    }
    return null;
  }

  /** A straight stub of `len` from a signal via, in a direction clear of everything by 12 mil. */
  stub(layer: LayerId, near: Vec2, len: number, width: number, extra?: (v: PcbVia, u: Vec2) => Geom[]): { via: number; a: Vec2; b: Vec2; u: Vec2 } | null {
    for (const { i, v } of this.anchors(near).slice(0, 300)) {
      const att = this.attached(i, layer);
      for (let k = 0; k < 16; k++) {
        const u = unit(k * 22.5);
        if (!this.freeDir(att.dirs, u)) continue;
        const b = plus(v.at, u, len);
        const gs = [seg(v.at, b, width), ...(extra?.(v, u) ?? [])];
        const skip = (s: Shape) => att.prims.has(s.prim);
        if (this.fits({ copper: gs.map((g) => ({ layer, g, skip })), inside: gs.map((g) => ({ g, margin: mil(30) })) })) return { via: i, a: v.at, b, u };
      }
    }
    return null;
  }

  /** A through via's place: clear on every signal layer, of holes, mask and silk (`net` GND: joined by the plane). */
  viaFits(at: Vec2, d: number, hole: number, o: { skipCopper?: (s: Shape) => boolean; skipHole?: (i: number) => boolean; skipOpening?: (i: number) => boolean; layers?: LayerId[]; margin?: number;
    /** A pad (kept off silkscreen, for Silk To Solder Mask); `merge`: its mask opening may run into others. */ pad?: boolean; merge?: boolean } = {}): boolean {
    const g = disc(at, d), mask = disc(at, d + mil(8));
    return this.fits({
      copper: (o.layers ?? SIGNAL).map((layer) => ({ layer, g, skip: o.skipCopper, margin: o.margin })),
      holes: [{ g: disc(at, hole), skip: o.skipHole }],
      openings: (['top', 'bottom'] as const).map((side) => ({ side, g: mask, skip: o.skipOpening, silk: o.pad, merge: o.merge })),
      inside: [{ g, margin: mil(40) }],
    });
  }
  /** The first place round `near` (inside `box`, mm) where `test` fits. */
  spot<T>(near: Vec2, test: (p: Vec2) => T | null, o: { step?: number; reach?: number; box?: [number, number, number, number] } = {}): T | null {
    for (const p of this.around(near, o.step ?? mil(10), o.reach ?? mil(1500), o.box)) { const r = test(p); if (r) return r; }
    return null;
  }
}

/* ─── The rules ───────────────────────────────────────────────────────────────────────── */

/** Every kind Konium checks that the file format numbers. */
export const TORTURE_KINDS = new Set(CHECKED_KINDS.filter((k) => RULE_KIND_IDS[k] !== undefined));

/**
 * The showcase's own rules kept; a rule added for each kind seeded that it has none of; Hole Size
 * gets a rule of its own for vias above the showcase's (which goes down one priority for it).
 */
function setRules(doc: PcbDocument, log: (s: string) => void): void {
  const rules = doc.rules.map(cloneRule);
  const have = (k: string) => rules.some((r) => ruleKind(r) === k);
  const add = (kind: string, name: string, props: Record<string, string>, priority = 1) => {
    const r = newRule(kind, name, priority);
    for (const [k, v] of Object.entries(props)) r.bag.set(k, v);
    rules.push(r);
    log(`  rule ${name}: ${ruleHeading(r, (c) => lengthIn('mil', c))}`);
  };
  for (const r of rules) if (ruleKind(r) === 'HoleSize') r.bag.set('PRIORITY', String(rulePriority(r) + 1));
  add('HoleSize', 'HoleSize_Vias', { SCOPE1EXPRESSION: 'IsVia', MINLIMIT: '6mil', MAXLIMIT: '15mil' }, 1);
  const fresh: [string, Record<string, string>][] = [
    // 4 mil, not 5: the showcase's 0.45 / 0.2 mm vias have rings of 4.92 mil
    ['MinimumAnnularRing', { MINIMUMRING: '4mil' }],
    ['NetAntennae', { NETANTENNAETOLERANCE: '0mil' }],
    ['ComponentClearance', { GAP: '5mil', VERTICALGAP: '5mil' }],
    ['BoardOutlineClearance', { GAP: '10mil' }],
    ['AcuteAngle', { MINIMUM: '90', CHECKTRACKSONLY: 'FALSE' }],
    // SMD To Corner's distance in internal units, as the suite keeps it
    ['SMDToCorner', { DISTANCE: String(mil(5)) }],
    ['SMDNeckDown', { PERCENT: '50' }],
    ['ViasUnderSMD', { ALLOWED: 'FALSE' }],
    ['UnConnectedPin', {}],
    ['SilkToBoardRegionClearance', { GAP: '0mil' }],
    ['LayerPairs', { ENFORCE: 'TRUE' }],
    ['UnpouredPolygon', { ALLOWSHELVED: 'FALSE', ALLOWMODIFIED: 'FALSE' }],
  ];
  for (const [k, props] of fresh) if (!have(k)) add(k, k, props);
  replaceRules(doc, rules).apply();
  // Batch DRC checks every kind Konium checks; the suite stops at 500 violations unless told otherwise
  setDrcSettings(doc, { batch: TORTURE_KINDS, stopAt: 50000 }).apply();
}

/* ─── The faults ──────────────────────────────────────────────────────────────────────── */

const RF: [number, number, number, number] = [91.8, 46.8, 113.8, 69.8];   // inside the top GND pour (GND_RF), mm
const COLOUR = { grey: 0x808080, black: 0x202020, alu: 0xc0c0c0 };

function seed(s: Seeder): void {
  const doc = s.doc;
  const gnd = s.net('GND'), p3v3 = s.net('+3V3');
  // Faults are made against the showcase's own parts, not the ones added here
  const nComp0 = doc.components.length;
  const theirs = (p: PcbPrim) => !('component' in p) || p.component === NO_NET || p.component < nComp0;
  // The net the copper islands (UR-4 to UR-6) are on: no other fault uses it
  const islandNet = s.net('I2C_SDA');
  s.usedNets.add(islandNet);
  const isSmd = (p: PcbPrim): p is PcbPad => p.kind === 'pad' && p.hole === 0 && (p.layer === L.TOP || p.layer === L.BOTTOM);
  const inBox = (q: Vec2, b: [number, number, number, number]) => { const lo = s.P(b[0], b[1]), hi = s.P(b[2], b[3]); return q.x >= lo.x && q.y >= lo.y && q.x <= hi.x && q.y <= hi.y; };
  const W = mil(6);
  const stubFault = (id: string, what: string, rules: string[], also: string[], layer: LayerId, o: Parameters<Seeder['approach']>[0]) => {
    s.begin(id, what, rules, s.layerLabel(layer), also);
    const r = s.approach(o);
    if (!r) return s.skip('no place found');
    const v = doc.prims[r.via] as PcbVia;
    s.usedNets.add(v.net);
    s.against(r.target);
    s.at(r.b);
    s.track(layer, r.a, r.b, o.width, v.net);
    s.end();
  };

  /* ── Clearance (0.15 mm) ── */
  stubFault('CL-1', 'Track of one net ending 3 mil from an SMD pad of another', ['Clearance'], ['NetAntennae'], L.TOP,
    { layer: L.TOP, near: s.P(20, 50), target: (p) => isSmd(p) && theirs(p) && p.net !== NO_NET && p.net !== gnd, width: W, gap: mil(3) });
  stubFault('CL-2', 'Track of one net ending 3 mil from a track of another', ['Clearance'], ['NetAntennae'], L.MID1,
    { layer: L.MID1, near: s.P(55, 20), target: (p) => p.kind === 'track' && p.net !== NO_NET && !inPour(p), width: W, gap: mil(3) });
  stubFault('CL-3', 'Track of one net ending 2.5 mil from a via of another', ['Clearance'], ['NetAntennae'], MID2,
    { layer: MID2, near: s.P(45, 60), target: (p) => p.kind === 'via' && p.net !== NO_NET, width: W, gap: mil(2.5) });
  {
    // Bottom: a GND track 3 mil beside another net's track (the pour round it joins it to GND)
    s.begin('CL-4', 'GND track 3 mil beside a track of another net', ['Clearance'], s.layerLabel(L.BOTTOM));
    const tracks = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbTrack; i: number } => x.p.kind === 'track' && x.p.layer === L.BOTTOM && !inPour(x.p) && x.p.net !== NO_NET && x.p.net !== gnd && far(x.p.a, x.p.b) > mil(80))
      .sort((a, b) => far(a.p.a, s.P(70, 12)) - far(b.p.a, s.P(70, 12)));
    let done = false;
    for (const { p, i } of tracks) {
      const d = norm({ x: p.b.x - p.a.x, y: p.b.y - p.a.y }), n = turn(d, 90), m = V((p.a.x + p.b.x) / 2, (p.a.y + p.b.y) / 2);
      for (const side of [1, -1]) {
        const off = p.width / 2 + mil(3) + W / 2;
        const a = plus(plus(m, n, side * off), d, -mil(20)), b = plus(plus(m, n, side * off), d, mil(20));
        const g = seg(a, b, W);
        if (!s.fits({ copper: [{ layer: L.BOTTOM, g, skip: (x) => x.prim === i }], inside: [{ g, margin: mil(40) }] })) continue;
        s.against(i); s.at(a); s.track(L.BOTTOM, a, b, W, gnd); done = true; break;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    // Top, in the GND pour round the radio: a GND via 3 mil from an SMD pad of another net
    s.begin('CL-5', 'GND via 3 mil from an SMD pad of another net', ['Clearance'], 'Top Layer (via through)');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => isSmd(x.p) && x.p.layer === L.TOP && x.p.net !== gnd && x.p.net !== NO_NET && inBox(x.p.at, RF));
    let done = false;
    for (const { p, i } of pads) {
      for (let k = 0; k < 8 && !done; k++) {
        const u = unit(p.rotation + k * 45);
        // Along the direction, just off the pad's edge by 3 mil
        const shape = s.occ.copper.all().find((x) => x.prim === i)!;
        let t = mil(5);
        while (distance(disc(plus(p.at, u, t), mil(17.716)), shape.g) < mil(3) && t < mil(200)) t += mil(0.25);
        for (let k2 = 0; k2 < 30; k2++) { const dd = distance(disc(plus(p.at, u, t), mil(17.716)), shape.g); if (Math.abs(dd - mil(3)) < mil(0.05)) break; t += (mil(3) - dd) * 0.9; }
        const at = plus(p.at, u, t);
        if (Math.abs(distance(disc(at, mil(17.716)), shape.g) - mil(3)) > mil(0.2)) continue;
        if (!s.viaFits(at, mil(17.716), mil(7.874), { skipCopper: (x) => x.prim === i, skipOpening: (x) => x === i })) continue;
        s.against(i); s.at(at); s.via(at, mil(17.716), mil(7.874), gnd); done = true;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }

  /* ── Short-Circuit ── */
  stubFault('SH-1', 'Track of one net crossing a track of another', ['ShortCircuit', 'Clearance'], ['NetAntennae'], MID2,
    { layer: MID2, near: s.P(30, 35), target: (p) => p.kind === 'track' && p.net !== NO_NET && !inPour(p) && far(p.a, p.b) > mil(60), width: W, cross: mil(15) });
  {
    s.begin('SH-2', 'GND via overlapping a track of another net', ['ShortCircuit', 'Clearance'], 'Bottom Layer (via through)');
    const tracks = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbTrack; i: number } => x.p.kind === 'track' && x.p.layer === L.BOTTOM && !inPour(x.p) && x.p.net !== NO_NET && x.p.net !== gnd && far(x.p.a, x.p.b) > mil(80))
      .sort((a, b) => far(a.p.a, s.P(50, 45)) - far(b.p.a, s.P(50, 45)));
    let done = false;
    for (const { p, i } of tracks) {
      const d = norm({ x: p.b.x - p.a.x, y: p.b.y - p.a.y }), n = turn(d, 90), m = V((p.a.x + p.b.x) / 2, (p.a.y + p.b.y) / 2);
      for (const side of [1, -1]) {
        const at = plus(m, n, side * (p.width / 2 + mil(17.716) / 2 - mil(3)));
        if (!s.viaFits(at, mil(17.716), mil(7.874), { skipCopper: (x) => x.prim === i })) continue;
        s.against(i); s.at(at); s.via(at, mil(17.716), mil(7.874), gnd); done = true; break;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  stubFault('SH-3', 'Track of one net ending 4 mil into an SMD pad of another', ['ShortCircuit', 'Clearance'], ['NetAntennae'], L.TOP,
    { layer: L.TOP, near: s.P(75, 18), target: (p) => isSmd(p) && theirs(p) && p.net !== NO_NET && p.net !== gnd, width: W, into: mil(4) });

  /* ── Width (Min 5 mil, Max 2 mm) ── */
  {
    s.begin('WD-1', 'GND track 3 mil wide (in the top pour)', ['Width'], s.layerLabel(L.TOP));
    const r = s.spot(s.P(108, 50), (p) => {
      const a = p, b = plus(p, unit(0), mil(60)), g = seg(a, b, mil(3));
      return s.fits({ copper: [{ layer: L.TOP, g }], inside: [{ g, margin: mil(40) }] }) ? { a, b } : null;
    }, { box: RF });
    if (r) { s.at(r.a); s.track(L.TOP, r.a, r.b, mil(3), gnd); s.end(); } else s.skip('no place found');
  }
  {
    // Mid-Layer 1: a 3 mil track between two vias of one net (joined at both ends: nothing else to report)
    s.begin('WD-2', 'Track 3 mil wide between two vias of its net', ['Width'], s.layerLabel(L.MID1));
    const vias = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbVia; i: number } => x.p.kind === 'via' && x.p.layerStart === L.TOP && x.p.layerEnd === L.BOTTOM && x.p.net !== NO_NET)
      .sort((a, b) => far(a.p.at, s.P(95, 15)) - far(b.p.at, s.P(95, 15)));
    let done = false;
    for (const a of vias.slice(0, 400)) {
      for (const b of vias) {
        if (b.i <= a.i || b.p.net !== a.p.net) continue;
        const d = far(a.p.at, b.p.at);
        if (d < mil(60) || d > mil(160)) continue;
        const ua = norm({ x: b.p.at.x - a.p.at.x, y: b.p.at.y - a.p.at.y });
        const at1 = s.attached(a.i, L.MID1), at2 = s.attached(b.i, L.MID1);
        if (!s.freeDir(at1.dirs, ua) || !s.freeDir(at2.dirs, { x: -ua.x, y: -ua.y })) continue;
        const g = seg(a.p.at, b.p.at, mil(3));
        if (!s.fits({ copper: [{ layer: L.MID1, g, skip: (x) => at1.prims.has(x.prim) || at2.prims.has(x.prim) }] })) continue;
        s.at(V((a.p.at.x + b.p.at.x) / 2, (a.p.at.y + b.p.at.y) / 2)); s.track(L.MID1, a.p.at, b.p.at, mil(3), a.p.net); done = true; break;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('WD-3', 'GND track 2.3 mm wide (in the bottom pour)', ['Width'], s.layerLabel(L.BOTTOM));
    const w = mm(2.3);
    const r = s.spot(s.P(10, 30), (p) => {
      const a = p, b = plus(p, unit(90), mil(120)), g = seg(a, b, w);
      return s.fits({ copper: [{ layer: L.BOTTOM, g }], inside: [{ g, margin: mil(40) }] }) ? { a, b } : null;
    }, { step: mil(20), reach: mil(3000) });
    if (r) { s.at(r.a); s.track(L.BOTTOM, r.a, r.b, w, gnd); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('WD-4', 'Arc 2.2 mm wide, no net', ['Width'], s.layerLabel(MID2));
    const w = mm(2.2), rad = mil(80);
    const r = s.spot(s.P(15, 60), (p) => {
      const gs = arcGeoms(p, rad, 0, 120, w);
      return s.fits({ copper: gs.map((g) => ({ layer: MID2, g })), inside: gs.map((g) => ({ g, margin: mil(40) })) }) ? p : null;
    }, { step: mil(20), reach: mil(3000) });
    if (r) { s.at(arcEnd(r, rad, 60)); s.arc(MID2, r, rad, 0, 120, w); s.end(); } else s.skip('no place found');
  }

  /* ── Hole Size (vias 6 to 15 mil, the rest 1 mil to 3.5 mm), Routing Via Style ── */
  const gndVia = (id: string, what: string, rules: string[], near: Vec2, d: number, hole: number, box?: [number, number, number, number], also: string[] = []) => {
    s.begin(id, what, rules, 'Through (Top to Bottom)', also);
    const at = s.spot(near, (p) => (s.viaFits(p, d, hole) ? p : null), { box });
    if (!at) return s.skip('no place found');
    s.at(at); s.via(at, d, hole, gnd); s.end();
  };
  gndVia('HS-1', 'GND via with a 4 mil hole (17.7 mil pad)', ['HoleSize', 'RoutingVias'], s.P(96, 66), mil(17.716), mil(4), RF);
  gndVia('HS-2', 'GND via with a 20 mil hole (32 mil pad)', ['HoleSize', 'RoutingVias'], s.P(8, 50), mil(32), mil(20));
  {
    s.begin('HS-3', 'Free plated pad, no net, 3.8 mm hole (4.4 mm pad)', ['HoleSize'], 'Multi-Layer');
    const d = mm(4.4), hole = mm(3.8);
    const at = s.spot(s.P(60, 40), (p) => {
      const g = disc(p, d);
      return s.fits({ copper: SIGNAL.map((layer) => ({ layer, g, margin: mil(20) })), holes: [{ g: disc(p, hole) }], openings: (['top', 'bottom'] as const).map((side) => ({ side, g: disc(p, d + mil(8)), silk: true })), inside: [{ g, margin: mil(60) }] }) ? p : null;
    }, { step: mil(25), reach: mil(4000) });
    if (at) { s.at(at); s.freePad({ name: 'H3', layer: L.MULTI, at, w: d, h: d, shape: 'round', hole }); s.end(); } else s.skip('no place found');
  }

  /* ── Hole To Hole Clearance (0.2 mm) ── */
  {
    s.begin('HH-1', 'Two GND vias whose holes are 4 mil apart', ['HoleToHoleClearance'], 'Through (Top to Bottom)');
    const d = mil(17.716), hole = mil(7.874), pitch = hole + mil(4);
    const at = s.spot(s.P(100, 48), (p) => {
      const q = plus(p, unit(0), pitch);
      return s.viaFits(p, d, hole) && s.viaFits(q, d, hole) ? [p, q] : null;
    }, { box: RF });
    if (at) { s.at(at[0]); s.via(at[0], d, hole, gnd); s.via(at[1], d, hole, gnd); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('HH-2', 'GND via whose hole is 5 mil from a GND through-hole pad\'s', ['HoleToHoleClearance'], 'Through (Top to Bottom)');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => x.p.kind === 'pad' && x.p.layer === L.MULTI && x.p.hole > 0 && x.p.hole < mil(60) && x.p.net === gnd)
      .sort((a, b) => far(a.p.at, s.P(84, 5)) - far(b.p.at, s.P(84, 5)));
    let done = false;
    for (const { p, i } of pads) {
      for (let k = 0; k < 8 && !done; k++) {
        const at = plus(p.at, unit(k * 45), p.hole / 2 + mil(5) + mil(7.874) / 2);
        if (!s.viaFits(at, mil(17.716), mil(7.874), { skipCopper: (x) => x.prim === i, skipHole: (x) => x === i, skipOpening: (x) => x === i })) continue;
        s.against(i); s.at(at); s.via(at, mil(17.716), mil(7.874), gnd); done = true;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }

  /* ── Minimum Annular Ring (4 mil) ── */
  gndVia('AR-1', 'GND via 12 mil across with an 8 mil hole (2 mil ring)', ['MinimumAnnularRing', 'RoutingVias'], s.P(100, 30), mil(12), mil(8));
  {
    s.begin('AR-2', 'Free plated pad, no net, 46 mil across with a 40 mil hole (3 mil ring)', ['MinimumAnnularRing'], 'Multi-Layer');
    const d = mil(46), hole = mil(40);
    const at = s.spot(s.P(30, 70), (p) => (s.viaFits(p, d, hole, { margin: mil(15), pad: true }) ? p : null), { step: mil(15) });
    if (at) { s.at(at); s.freePad({ name: 'R2', layer: L.MULTI, at, w: d, h: d, shape: 'round', hole }); s.end(); } else s.skip('no place found');
  }

  /* ── Un-Routed Net ── */
  const cutSegment = (id: string, layer: LayerId, near: Vec2) => {
    s.begin(id, 'A routed track taken out mid-route', ['UnRoutedNet'], s.layerLabel(layer), ['NetAntennae']);
    const cands = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.layer === layer && !inPour(p) && s.signalNet(p.net) && far(p.a, p.b) > mil(80) && far(p.a, p.b) < mil(500))
      .sort((a, b) => far(a.a, near) - far(b.a, near));
    const unrouted = (net: number) => runDrc(doc, new Set(['UnRoutedNet'])).violations.filter((v) => v.message.includes(`Net ${s.netName(net)} Between`)).length;
    for (const t of cands.slice(0, 40)) {
      // Neither end on a pad: the cut leaves track ends on both sides
      const onPad = (q: Vec2) => doc.prims.some((p) => p.kind === 'pad' && far(p.at, q) < Math.max(p.top.w, p.top.h));
      if (onPad(t.a) || onPad(t.b)) continue;
      const before = unrouted(t.net);
      s.remove(t);
      if (unrouted(t.net) > before) {
        s.usedNets.add(t.net);
        s.at(V((t.a.x + t.b.x) / 2, (t.a.y + t.b.y) / 2));
        s.key(`Un-Routed Net Constraint: Net ${s.netName(t.net)} Between`);
        return s.end();
      }
      // Its net was joined round it as well (a loop): put it back
      s.unremove(t);
    }
    s.skip('no segment whose removal splits its net');
  };
  cutSegment('UR-1', L.MID1, s.P(60, 50));
  cutSegment('UR-2', L.TOP, s.P(30, 30));
  {
    // A 0402 capacitor of the script's own in the radio's GND pour: GND on pad 2, +3V3 on pad 1 with nothing reaching it
    s.begin('UR-3', 'Component pad of +3V3 with nothing reaching it (C90-1)', ['UnRoutedNet'], s.layerLabel(L.TOP));
    const pw = mil(24), ph = mil(22), pitch = mil(40);
    const at = s.spot(s.P(110, 66), (p) => {
      const p1 = plus(p, unit(180), pitch / 2), p2 = plus(p, unit(0), pitch / 2);
      const g1 = rect(p1, pw, ph), g2 = rect(p2, pw, ph), body = rect(p, mil(40), mil(20));
      return s.fits({ copper: [{ layer: L.TOP, g: g1, margin: mil(15) }, { layer: L.TOP, g: g2, margin: mil(15) }], openings: [{ side: 'top', g: rect(p1, pw + mil(8), ph + mil(8)), silk: true }, { side: 'top', g: rect(p2, pw + mil(8), ph + mil(8)), silk: true }],
        bodies: [{ bottom: false, g: body }], inside: [{ g: body, margin: mil(60) }] }) ? { p, p1, p2 } : null;
    }, { box: RF });
    if (at) {
      s.at(at.p1);
      s.component({ designator: 'C90', pattern: 'C0402-TORTURE', comment: '100nF', description: 'Capacitor, 0402 (DRC torture board)', at: at.p, height: mil(22),
        pads: [{ name: '1', layer: L.TOP, at: at.p1, w: pw, h: ph, shape: 'rect', net: p3v3 }, { name: '2', layer: L.TOP, at: at.p2, w: pw, h: ph, shape: 'rect', net: gnd }],
        bodies: [{ outline: rectPts(at.p, mil(40), mil(20)), z0: 0, z1: mil(22), colour: COLOUR.grey }] });
      s.end();
    } else s.skip('no place found');
  }
  const island = (id: string, what: string, layer: LayerId, near: Vec2, make: (p: Vec2) => { gs: Geom[]; put: () => void; at: Vec2 }, rules = ['UnRoutedNet', 'NetAntennae']) => {
    s.begin(id, what, rules, s.layerLabel(layer));
    const r = s.spot(near, (p) => { const m = make(p); return s.fits({ copper: m.gs.map((g) => ({ layer, g, margin: mil(20) })), inside: m.gs.map((g) => ({ g, margin: mil(40) })) }) ? m : null; }, { step: mil(20), reach: mil(3000) });
    if (!r) return s.skip('no place found');
    s.at(r.at); r.put(); s.end();
  };
  island('UR-4', 'Arc of I2C_SDA touching nothing (120°, a copper island with no pad)', L.BOTTOM, s.P(45, 70), (p) => ({ gs: arcGeoms(p, mil(40), 30, 150, W), at: arcEnd(p, mil(40), 30), put: () => s.arc(L.BOTTOM, p, mil(40), 30, 150, W, islandNet) }));
  island('UR-5', 'Full circle of I2C_SDA touching nothing (a copper island with no pad)', MID2, s.P(70, 70), (p) => ({ gs: arcGeoms(p, mil(30), 0, 360, W), at: p, put: () => s.arc(MID2, p, mil(30), 0, 360, W, islandNet) }));
  island('UR-6', 'Track of I2C_SDA touching nothing (a copper island with no pad)', L.TOP, s.P(56, 30), (p) => ({ gs: [seg(p, plus(p, unit(0), mil(50)), W)], at: p, put: () => s.track(L.TOP, p, plus(p, unit(0), mil(50)), W, islandNet) }));

  /* ── Net Antennae (tolerance 0) ── */
  const antenna = (id: string, layer: LayerId, near: Vec2) => {
    s.begin(id, 'Track stub from a via, its far end open', ['NetAntennae'], s.layerLabel(layer));
    const r = s.stub(layer, near, mil(40), W);
    if (!r) return s.skip('no place found');
    s.usedNets.add((doc.prims[r.via] as PcbVia).net);
    s.at(r.b); s.track(layer, r.a, r.b, W, (doc.prims[r.via] as PcbVia).net); s.end();
  };
  antenna('NA-1', L.TOP, s.P(65, 55));
  antenna('NA-2', MID2, s.P(25, 15));
  antenna('NA-3', L.BOTTOM, s.P(95, 35));
  {
    s.begin('NA-4', 'Arc from a via, its far end open (90°, 30 mil radius)', ['NetAntennae'], s.layerLabel(L.MID1));
    const rad = mil(30);
    let done = false;
    for (const { i, v } of s.anchors(s.P(40, 65)).slice(0, 300)) {
      const att = s.attached(i, L.MID1);
      for (let k = 0; k < 8 && !done; k++) {
        // Starts on the via's centre, leaving it along u; the centre is to its left
        const u = unit(k * 45);
        if (!s.freeDir(att.dirs, u)) continue;
        const c = plus(v.at, turn(u, 90), rad), start = Math.atan2(v.at.y - c.y, v.at.x - c.x) * 180 / Math.PI, st = ((start % 360) + 360) % 360;
        const gs = arcGeoms(c, rad, st, st + 90, W);
        if (!s.fits({ copper: gs.map((g) => ({ layer: L.MID1, g, skip: (x: Shape) => att.prims.has(x.prim) })), inside: gs.map((g) => ({ g, margin: mil(40) })) })) continue;
        s.usedNets.add(v.net);
        s.at(arcEnd(c, rad, st + 90)); s.arc(L.MID1, c, rad, st, (st + 90) % 360, W, v.net); done = true;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }

  /* ── Acute Angle (90°) ── */
  const vee = (id: string, layer: LayerId, near: Vec2, angle: number) => {
    s.begin(id, `Two tracks of a net meeting at ${angle}°, from a via, the second's end open`, ['AcuteAngle'], s.layerLabel(layer), ['NetAntennae']);
    const l1 = mil(40), l2 = mil(30);
    const r = s.stub(layer, near, l1, W, (v, u) => { const p1 = plus(v.at, u, l1); return [seg(p1, plus(p1, turn({ x: -u.x, y: -u.y }, angle), l2), W)]; });
    if (!r) return s.skip('no place found');
    const net = (doc.prims[r.via] as PcbVia).net, p2 = plus(r.b, turn({ x: -r.u.x, y: -r.u.y }, angle), l2);
    s.usedNets.add(net);
    s.at(r.b); s.track(layer, r.a, r.b, W, net); s.track(layer, r.b, p2, W, net); s.end();
  };
  vee('AA-1', L.TOP, s.P(20, 35), 30);
  vee('AA-3', L.BOTTOM, s.P(75, 65), 45);
  {
    s.begin('AA-2', 'Triangle of tracks from a via: 30° corners at its two far points', ['AcuteAngle'], s.layerLabel(MID2));
    const side = mil(50);
    const r = s.stub(MID2, s.P(50, 10), side, W, (v, u) => { const p1 = plus(v.at, u, side), p2 = plus(v.at, turn(u, 120), side); return [seg(p1, p2, W), seg(p2, v.at, W)]; });
    let ok = false;
    if (r) {
      const v = doc.prims[r.via] as PcbVia, p2 = plus(v.at, turn(r.u, 120), side);
      if (s.freeDir(s.attached(r.via, MID2).dirs, norm({ x: p2.x - v.at.x, y: p2.y - v.at.y }))) {
        s.usedNets.add(v.net);
        s.at(r.b); s.track(MID2, v.at, r.b, W, v.net); s.track(MID2, r.b, p2, W, v.net); s.track(MID2, p2, v.at, W, v.net); ok = true;
      }
    }
    if (ok) s.end(); else s.skip('no place found');
  }

  /* ── Pads of the radio's GND: SMD To Corner, SMD Neck-Down, Vias Under SMD, mask sliver ── */
  const rfGndPads = () => doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => isSmd(x.p) && x.p.layer === L.TOP && x.p.net === gnd && inBox(x.p.at, RF) && x.p.component !== NO_NET && theirs(x.p))
    .sort((a, b) => a.p.at.x - b.p.at.x || a.p.at.y - b.p.at.y);
  const usedPads = new Set<number>();
  const padOut = (p: PcbPad): Vec2[] => { const r = p.rotation; return p.top.w >= p.top.h ? [unit(r), unit(r + 180), unit(r + 90), unit(r + 270)] : [unit(r + 90), unit(r + 270), unit(r), unit(r + 180)]; };
  const halfAlong = (p: PcbPad, u: Vec2) => { const a = (p.rotation * Math.PI) / 180, lx = Math.abs(u.x * Math.cos(a) + u.y * Math.sin(a)); return lx > 0.5 ? p.top.w / 2 : p.top.h / 2; };
  {
    s.begin('SC-1', 'GND track leaving a GND pad and turning 2 mil past its edge', ['SMDToCorner'], s.layerLabel(L.TOP));
    let done = false;
    for (const { p, i } of rfGndPads()) {
      if (usedPads.has(p.component)) continue;
      for (const u of padOut(p)) for (const side of [90, -90]) {
        if (done) break;
        const p1 = plus(p.at, u, halfAlong(p, u) + mil(2)), p2 = plus(p1, turn(u, side), mil(30));
        const g1 = seg(plus(p.at, u, halfAlong(p, u) + mil(1)), p1, W), g2 = seg(p1, p2, W);
        const skip = (x: Shape) => x.prim === i;
        if (!s.fits({ copper: [{ layer: L.TOP, g: g1, skip, margin: mil(10) }, { layer: L.TOP, g: g2, skip, margin: mil(10) }], inside: [{ g: g2, margin: mil(40) }] })) continue;
        usedPads.add(p.component);
        s.against(i); s.at(p1); s.track(L.TOP, p.at, p1, W, gnd); s.track(L.TOP, p1, p2, W, gnd); done = true;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('NK-1', 'GND track 90 % of a GND pad\'s width leaving it', ['SMDNeckDown'], s.layerLabel(L.TOP));
    let done = false;
    for (const { p, i } of rfGndPads().reverse()) {
      if (usedPads.has(p.component)) continue;
      const w = Math.round(Math.min(p.top.w, p.top.h) * 0.9);
      for (const u of padOut(p)) {
        const b = plus(p.at, u, halfAlong(p, u) + mil(25));
        const g = seg(plus(p.at, u, halfAlong(p, u) + mil(1)), b, w);
        if (!s.fits({ copper: [{ layer: L.TOP, g, skip: (x) => x.prim === i || x.net === gnd, margin: mil(10) }], inside: [{ g, margin: mil(40) }] })) continue;
        usedPads.add(p.component);
        s.against(i); s.at(p.at); s.track(L.TOP, p.at, b, w, gnd); done = true; break;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('VU-1', 'GND via in the middle of a GND SMD pad', ['ViasUnderSMD'], 'Top Layer (via through)');
    let done = false;
    for (const { p, i } of rfGndPads()) {
      if (usedPads.has(p.component) || Math.min(p.top.w, p.top.h) < mil(18)) continue;
      if (!s.viaFits(p.at, mil(17.716), mil(7.874), { skipCopper: (x) => x.prim === i || x.net === gnd, skipOpening: (x) => x === i, merge: true })) continue;
      usedPads.add(p.component);
      s.against(i); s.at(p.at); s.via(p.at, mil(17.716), mil(7.874), gnd); done = true; break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('MS-2', 'GND via whose mask opening is 1 mil from a GND pad\'s', ['MinimumSolderMaskSliver'], 'Top Solder');
    let done = false;
    for (const { p, i } of rfGndPads()) {
      if (usedPads.has(p.component)) continue;
      for (const u of padOut(p)) {
        const at = plus(p.at, u, halfAlong(p, u) + mil(4) + mil(1) + mil(17.716) / 2 + mil(4));
        if (!s.viaFits(at, mil(17.716), mil(7.874), { skipCopper: (x) => x.prim === i || x.net === gnd, skipOpening: (x) => x === i })) continue;
        usedPads.add(p.component);
        s.against(i); s.at(at); s.via(at, mil(17.716), mil(7.874), gnd); done = true; break;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('MS-1', 'Two GND vias whose mask openings are 1 mil apart (top and bottom)', ['MinimumSolderMaskSliver'], 'Top Solder, Bottom Solder');
    const d = mil(17.716), hole = mil(7.874), pitch = d + mil(8) + mil(1);
    const at = s.spot(s.P(12, 8), (p) => { const q = plus(p, unit(0), pitch); return s.viaFits(p, d, hole) && s.viaFits(q, d, hole) ? [p, q] : null; });
    if (at) { s.at(V((at[0].x + at[1].x) / 2, at[0].y)); s.via(at[0], d, hole, gnd); s.via(at[1], d, hole, gnd); s.end(); } else s.skip('no place found');
  }

  /* ── A bottom-side 0805 of the script's own: SMD To Corner, Neck-Down and a via under it on the bottom ── */
  {
    // Decoupling C99 under the board: +3V3 on pad 1 to a via (the +3V3 plane), GND on pad 2 (the bottom pour)
    const pw = mm(1.0), ph = mm(1.3), half = mm(0.95);
    const r = s.spot(s.P(60, 62), (c) => {
      const p1 = plus(c, unit(180), half), p2 = plus(c, unit(0), half);
      const corner = plus(p1, unit(180), pw / 2 + mil(3)), viaAt = plus(corner, unit(270), mil(45)), neckEnd = plus(p2, unit(0), mil(45));
      const cu = [rect(p1, pw, ph), rect(p2, pw, ph), seg(p1, corner, mil(8)), seg(corner, viaAt, mil(8)), seg(p2, neckEnd, mil(30)), disc(viaAt, mil(17.716))];
      const ok = s.fits({ copper: cu.map((g) => ({ layer: L.BOTTOM, g, margin: mil(15) })), openings: [{ side: 'bottom', g: rect(p1, pw + mil(8), ph + mil(8)), silk: true }, { side: 'bottom', g: rect(p2, pw + mil(8), ph + mil(8)), silk: true }],
        bodies: [{ bottom: true, g: rect(c, mm(2.0), mm(1.25)) }], inside: [{ g: rect(c, mm(4), mm(3)), margin: mil(40) }] })
        && s.viaFits(viaAt, mil(17.716), mil(7.874)) && s.viaFits(p2, mil(17.716), mil(7.874), { layers: [L.TOP, L.MID1, MID2] });
      return ok ? { c, p1, p2, corner, viaAt, neckEnd } : null;
    }, { step: mil(20), reach: mil(3000) });
    const padOf = (name: string) => doc.prims.findIndex((p) => p.kind === 'pad' && p.name === name && doc.components[p.component]?.designator === 'C99');
    s.begin('SC-2', '+3V3 track leaving C99-1 (bottom 0805) and turning 3 mil past its edge, on to a via', ['SMDToCorner'], s.layerLabel(L.BOTTOM));
    if (r) {
      s.component({ designator: 'C99', pattern: 'C0805-TORTURE', comment: '10uF', description: 'Capacitor, 0805, bottom side (DRC torture board)', bottom: true, at: r.c, height: mm(0.9), own: false,
        pads: [{ name: '1', layer: L.BOTTOM, at: r.p1, w: pw, h: ph, shape: 'rect', net: p3v3 }, { name: '2', layer: L.BOTTOM, at: r.p2, w: pw, h: ph, shape: 'rect', net: gnd }],
        bodies: [{ outline: rectPts(r.c, mm(2.0), mm(1.25)), z0: 0, z1: mm(0.9), colour: COLOUR.grey }] });
      s.against(padOf('1')); s.at(r.corner);
      s.track(L.BOTTOM, r.p1, r.corner, mil(8), p3v3); s.track(L.BOTTOM, r.corner, r.viaAt, mil(8), p3v3);
      s.via(r.viaAt, mil(17.716), mil(7.874), p3v3);
      s.end();
      s.begin('NK-2', 'GND track 30 mil wide leaving C99-2 (39.4 mil pad)', ['SMDNeckDown'], s.layerLabel(L.BOTTOM));
      s.against(padOf('2')); s.at(r.p2); s.track(L.BOTTOM, r.p2, r.neckEnd, mil(30), gnd); s.end();
      s.begin('VU-2', 'GND via in the middle of C99-2', ['ViasUnderSMD'], 'Bottom Layer (via through)');
      s.against(padOf('2')); s.at(r.p2); s.via(r.p2, mil(17.716), mil(7.874), gnd); s.end();
    } else s.skip('no place found');
  }

  /* ── Un-Connected Pin: test points of the script's own, their pad on no net ── */
  const testPoint = (id: string, des: string, bottom: boolean, near: Vec2) => {
    s.begin(id, `Test point ${des}: its pad on no net, nothing reaching it`, ['UnConnectedPin'], s.layerLabel(bottom ? L.BOTTOM : L.TOP));
    const d = mil(60), layer = bottom ? L.BOTTOM : L.TOP, side: Side = bottom ? 'bottom' : 'top';
    const at = s.spot(near, (p) => (s.fits({ copper: [{ layer, g: disc(p, d), margin: mil(15) }], openings: [{ side, g: disc(p, d + mil(8)), silk: true }], bodies: [{ bottom, g: disc(p, d) }], inside: [{ g: disc(p, d), margin: mil(60) }] }) ? p : null), { step: mil(20), reach: mil(3000) });
    if (!at) return s.skip('no place found');
    s.at(at);
    s.component({ designator: des, pattern: 'TP-TORTURE', comment: 'TP', description: 'Test point, 1.5 mm pad (DRC torture board)', bottom, at, height: 0, pads: [{ name: '1', layer, at, w: d, h: d, shape: 'round' }] });
    s.end();
  };
  testPoint('UP-1', 'TP7', false, s.P(48, 46));
  testPoint('UP-2', 'TP8', true, s.P(90, 20));

  /* ── Silk To Solder Mask (10 mil, pads), Silk To Silk (10 mil), Silk To Board Region ── */
  {
    s.begin('SM-1', 'Top overlay line across an SMD pad', ['SilkToSolderMaskClearance'], 'Top Overlay');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => isSmd(x.p) && x.p.layer === L.TOP && x.p.component !== NO_NET && theirs(x.p)).sort((a, b) => far(a.p.at, s.P(30, 45)) - far(b.p.at, s.P(30, 45)));
    let done = false;
    for (const { p, i } of pads) {
      const u = unit(p.rotation + (p.top.w >= p.top.h ? 90 : 0)), half = Math.max(p.top.w, p.top.h) / 2 + mil(12);
      const a = plus(p.at, u, -half), b = plus(p.at, u, half), g = seg(a, b, W);
      if (!s.fits({ silk: [{ side: 'top', g, skip: (x) => x === i, margin: mil(15) }] })) continue;
      s.against(i); s.at(p.at); s.track(L.TOP_OVERLAY, a, b, W); done = true; break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('SM-2', 'Bottom overlay text over a through-hole pad', ['SilkToSolderMaskClearance'], 'Bottom Overlay');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => x.p.kind === 'pad' && x.p.layer === L.MULTI && x.p.hole > 0 && x.p.hole < mil(60) && theirs(x.p)).sort((a, b) => far(a.p.at, s.P(84, 5)) - far(b.p.at, s.P(84, 5)));
    let done = false;
    for (const { p, i } of pads) {
      // "M2", 1 mm high, mirrored, its first stroke over the pad
      const at = V(p.at.x + mil(20), p.at.y - mil(15));
      const box = rect(V(at.x - mil(30), at.y + mil(20)), mil(70), mil(50));
      if (!s.fits({ silk: [{ side: 'bottom', g: box, skip: (x) => x === i, margin: mil(15) }] })) continue;
      const near = s.occ.openings.search(boxOf(box, mil(12))).filter((x) => x.side === 'bottom' && x.i !== i && distance(box, x.g, mil(13)) < mil(12));
      if (near.length) continue;
      s.against(i); s.at(at); s.text(L.BOTTOM_OVERLAY, at, mm(1), 'M2', true); done = true; break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('SM-3', 'Top overlay arc across a pad', ['SilkToSolderMaskClearance'], 'Top Overlay');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => x.p.kind === 'pad' && x.p.component !== NO_NET && theirs(x.p) && (x.p.layer === L.MULTI || x.p.layer === L.TOP)).sort((a, b) => far(a.p.at, s.P(80, 50)) - far(b.p.at, s.P(80, 50)));
    let done = false;
    for (const { p, i } of pads) {
      for (let k = 0; k < 4 && !done; k++) {
        const c = plus(p.at, unit(k * 90), mil(45)), rad = mil(45);
        const st = (k * 90 + 180 - 40 + 360) % 360;
        const gs = arcGeoms(c, rad, st, st + 80, W);
        if (!s.fits({ silk: gs.map((g) => ({ side: 'top' as Side, g, skip: (x: number) => x === i, margin: mil(12) })) })) continue;
        s.against(i); s.at(p.at); s.arc(L.TOP_OVERLAY, c, rad, st, (st + 80) % 360, W); done = true;
      }
      if (done) break;
    }
    if (done) s.end(); else s.skip('no place found');
  }
  {
    s.begin('SS-1', 'Two top overlay texts overlapping', ['SilkToSilkClearance'], 'Top Overlay');
    const at = s.spot(s.P(58, 58), (p) => {
      const box = rect(V(p.x + mil(80), p.y + mil(25)), mil(200), mil(70));
      return s.fits({ silk: [{ side: 'top', g: box, margin: mil(20) }], inside: [{ g: box, margin: mil(60) }] }) ? p : null;
    }, { step: mil(20), reach: mil(3000) });
    if (at) { s.at(at); s.text(L.TOP_OVERLAY, at, mm(1), 'SILK1'); s.text(L.TOP_OVERLAY, V(at.x + mil(20), at.y + mil(15)), mm(1), 'SILK2'); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('SS-2', 'Bottom overlay text 4 mil above a bottom overlay line', ['SilkToSilkClearance'], 'Bottom Overlay');
    const at = s.spot(s.P(70, 40), (p) => {
      const box = rect(V(p.x - mil(60), p.y + mil(15)), mil(150), mil(70));
      return s.fits({ silk: [{ side: 'bottom', g: box, margin: mil(20) }], inside: [{ g: box, margin: mil(60) }] }) ? p : null;
    }, { step: mil(20), reach: mil(3000) });
    if (at) {
      // The text's strokes are 0.15 mm wide (5.9 mil): the line's edge 4 mil under them
      const yLine = at.y - mil(2.953) - mil(4) - mil(3);
      s.at(at); s.text(L.BOTTOM_OVERLAY, at, mm(1), 'SS2', true); s.track(L.BOTTOM_OVERLAY, V(at.x - mil(130), yLine), V(at.x + mil(10), yLine), W); s.end();
    } else s.skip('no place found');
  }
  {
    s.begin('SB-1', 'Top overlay line crossing the board\'s edge', ['SilkToBoardRegionClearance'], 'Top Overlay');
    const o = doc.board.origin;
    const at = s.spot(s.P(40, 0), (p) => {
      const a = V(p.x, o.y - mil(25)), b = V(p.x, o.y + mil(40)), g = seg(a, b, W);
      return s.fits({ silk: [{ side: 'top', g, margin: mil(20) }] }) ? { a, b } : null;
    }, { box: [20, -1, 90, 1] });
    if (at) { s.at(at.a); s.track(L.TOP_OVERLAY, at.a, at.b, W); s.end(); } else s.skip('no place found');
  }

  /* ── Board Outline Clearance (10 mil) ── */
  const o = doc.board.origin, top = Math.max(...doc.board.outline.map((q) => q.y));
  {
    s.begin('BO-1', 'Track, no net, 3 mil from the left edge', ['BoardOutlineClearance'], s.layerLabel(L.MID1));
    const x = o.x + mil(3) + W / 2;
    const at = s.spot(s.P(0, 30), (p) => { const a = V(x, p.y), b = V(x, p.y + mil(120)), g = seg(a, b, W); return s.fits({ copper: [{ layer: L.MID1, g }] }) ? { a, b } : null; }, { box: [-1, 12, 1, 66] });
    if (at) { s.at(at.a); s.track(L.MID1, at.a, at.b, W); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('BO-2', 'Via, no net, 4 mil from the bottom edge', ['BoardOutlineClearance'], 'Through (Top to Bottom)');
    const y = o.y + mil(4) + mil(17.716) / 2;
    const at = s.spot(s.P(70, 0), (p) => {
      const q = V(p.x, y), g = disc(q, mil(17.716));
      return s.fits({ copper: SIGNAL.map((layer) => ({ layer, g })), holes: [{ g: disc(q, mil(7.874)) }], openings: [{ side: 'top', g: disc(q, mil(26)) }, { side: 'bottom', g: disc(q, mil(26)) }] }) ? q : null;
    }, { box: [15, -1, 100, 1] });
    if (at) { s.at(at); s.via(at, mil(17.716), mil(7.874)); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('BO-3', 'Arc, no net, its middle 5 mil from the top edge', ['BoardOutlineClearance'], s.layerLabel(L.TOP));
    const rad = mil(40);
    const at = s.spot(s.P(55, 78), (p) => {
      const c = V(p.x, top - mil(5) - W / 2 - rad), gs = arcGeoms(c, rad, 30, 150, W);
      return s.fits({ copper: gs.map((g) => ({ layer: L.TOP, g })) }) ? c : null;
    }, { box: [15, 77, 90, 79] });
    if (at) { s.at(V(at.x, at.y + rad)); s.arc(L.TOP, at, rad, 30, 150, W); s.end(); } else s.skip('no place found');
  }

  /* ── Component Clearance (5 mil), Height (max 1000 mil): parts of the script's own with no pads ── */
  {
    s.begin('CC-1', 'Cooling clip HS1 (no pads) placed onto U3', ['ComponentClearance'], 'Top (3D bodies)');
    const u3 = doc.components.findIndex((c) => c.designator === 'U3');
    const at = doc.components[u3]!.at;
    s.against(`Component U3 (${doc.components[u3]!.pattern})`);
    s.at(at);
    s.component({ designator: 'HS1', pattern: 'COOLER-TORTURE', comment: 'Cooling clip', description: 'Clip-on cooler, 4 x 4 mm (DRC torture board)', at, height: mm(4),
      bodies: [{ outline: rectPts(at, mm(4), mm(4)), z0: mm(1), z1: mm(4), colour: COLOUR.alu }] });
    s.end();
  }
  {
    s.begin('CC-2', 'Rubber feet FT1 and FT2 (no pads) 3 mil apart, bottom side', ['ComponentClearance'], 'Bottom (3D bodies)');
    const d = mm(6);
    const at = s.spot(s.P(57, 25), (p) => {
      const q = plus(p, unit(0), d + mil(3));
      return s.fits({ bodies: [{ bottom: true, g: disc(p, d), margin: mil(40) }, { bottom: true, g: disc(q, d), margin: mil(40) }], inside: [{ g: disc(p, d), margin: mil(60) }, { g: disc(q, d), margin: mil(60) }] }) ? [p, q] : null;
    }, { step: mil(40) });
    if (at) {
      s.at(V((at[0].x + at[1].x) / 2, at[0].y));
      for (const [k, c] of at.entries()) s.component({ designator: `FT${k + 1}`, pattern: 'BUMPON-TORTURE', comment: 'Bumpon', description: 'Rubber foot, 6 mm (DRC torture board)', bottom: true, at: c, height: mm(2),
        bodies: [{ outline: circlePts(c, d), z0: 0, z1: mm(2), colour: COLOUR.black }] });
      s.end();
    } else s.skip('no place found');
  }
  {
    s.begin('HT-1', 'Spacer SP1 (no pads) 30 mm tall', ['Height'], 'Top (3D body)');
    const d = mm(4);
    const at = s.spot(s.P(70, 45), (p) => (s.fits({ bodies: [{ bottom: false, g: disc(p, d), margin: mil(40) }], silk: [{ side: 'top', g: disc(p, d), margin: mil(5) }], inside: [{ g: disc(p, d), margin: mil(60) }] }) ? p : null), { step: mil(40), reach: mil(3000) });
    if (at) {
      s.at(at);
      s.component({ designator: 'SP1', pattern: 'SPACER-TORTURE', comment: 'Spacer 30mm', description: 'Board spacer, 30 mm (DRC torture board)', at, height: mm(30),
        bodies: [{ outline: circlePts(at, d), z0: 0, z1: mm(30), colour: COLOUR.alu }] });
      s.end();
    } else s.skip('no place found');
  }

  /* ── Layer Pairs, Modified Polygon, Report Options ── */
  {
    s.begin('LP-1', 'Blind GND via, Top Layer to Mid-Layer 1 (no such drill pair)', ['LayerPairs'], 'Top Layer to Mid-Layer 1');
    const at = s.spot(s.P(112, 55), (p) => (s.viaFits(p, mil(17.716), mil(7.874), { layers: [L.TOP, L.MID1] }) ? p : null), { box: RF });
    if (at) { s.at(at); s.via(at, mil(17.716), mil(7.874), gnd, L.TOP, L.MID1); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('MP-1', 'Shelved GND polygon on Mid-Layer 1 (SHELVED_GND)', ['UnpouredPolygon'], s.layerLabel(L.MID1));
    const a = s.P(5, 70), b = s.P(12, 74);
    const bag = newPolygonProps(layerToName(L.MID1), gnd, 'SHELVED_GND', doc.polygons.length);
    writeVertices(bag, [a, V(b.x, a.y), b, V(a.x, b.y)].map((p) => ({ p })));
    bag.set('SHELVED', 'TRUE');
    // As AD keeps a shelved pour: the layer and net it is restored to
    bag.set('RESTORELAYER', layerToName(L.MID1)); bag.set('RESTORENET', doc.nets[gnd]?.name ?? '');
    addPolygon(doc, bag).apply();
    s.at(a); s.key('Polygon SHELVED_GND'); s.end();
  }
  {
    s.begin('RO-1', 'Free pad on Top Layer with a 20 mil hole (a drilled SMT pad)', ['DrilledSMTPad'], s.layerLabel(L.TOP));
    const at = s.spot(s.P(35, 60), (p) => (s.viaFits(p, mil(50), mil(20), { margin: mil(15), pad: true }) ? p : null), { step: mil(20) });
    if (at) { s.at(at); s.freePad({ name: 'D1', layer: L.TOP, at, w: mil(50), h: mil(50), shape: 'round', hole: mil(20) }); s.end(); } else s.skip('no place found');
  }
  {
    s.begin('RO-2', 'Free pad on Multi-Layer with no hole', ['MultiLayerPadNoHole'], 'Multi-Layer');
    const at = s.spot(s.P(100, 8), (p) => (s.viaFits(p, mil(50), mil(1), { margin: mil(15), pad: true }) ? p : null), { step: mil(20) });
    if (at) { s.at(at); s.freePad({ name: 'Z1', layer: L.MULTI, at, w: mil(50), h: mil(50), shape: 'rect', hole: 0 }); s.end(); } else s.skip('no place found');
  }
}

/* ─── Main ────────────────────────────────────────────────────────────────────────────── */

interface Found { fault: Fault; idx: Set<number>; hits: DrcViolation[]; kinds: Set<string>; missing: string[]; absent: string[] }

function findFaults(doc: PcbDocument, faults: Fault[], vs: DrcViolation[]): Found[] {
  const bySig = new Map<string, number[]>();
  doc.prims.forEach((p, i) => { const k = sigOf(p); if (k) { const l = bySig.get(k) ?? []; l.push(i); bySig.set(k, l); } });
  return faults.map((f) => {
    const idx = new Set(f.sigs.flatMap((k) => bySig.get(k) ?? []));
    // A component of the fault's: all it owns
    for (const k of f.keys) {
      const m = /^Component (\S+)$/.exec(k);
      const c = m ? doc.components.findIndex((x) => x.designator === m[1]) : -1;
      if (c >= 0) doc.prims.forEach((p, i) => { if ('component' in p && p.component === c) idx.add(i); });
    }
    const absent = f.sigs.filter((k) => !bySig.has(k)).concat(f.removed.filter((k) => bySig.has(k)).map((k) => `still there: ${k}`));
    const hits = vs.filter((v) => v.prims.some((i) => idx.has(i)) || f.keys.some((k) => v.message.includes(k)));
    const kinds = new Set(hits.map((v) => v.kind));
    return { fault: f, idx, hits, kinds, missing: f.rules.filter((k) => !kinds.has(k)), absent };
  });
}

const md = (s: string) => s.replace(/\|/g, '\\|');

/** The known gaps (a copper island with no pad isn't un-routed; Net Antennae on arcs), as the faults show them. */
function knownGaps(found: Found[]): string[] {
  const by = (id: string) => found.find((f) => f.fault.id === id);
  const has = (id: string, k: string) => !!by(id)?.kinds.has(k);
  const islands = ['UR-4', 'UR-5', 'UR-6'].filter((id) => by(id));
  const lines = ['## Known gaps', ''];
  if (islands.length) {
    const unrouted = islands.filter((id) => has(id, 'UnRoutedNet'));
    lines.push(`- A net's copper island that touches no pad as Un-Routed Net: ${unrouted.length ? `reported for ${unrouted.join(', ')}` : `confirmed: Konium reports none of ${islands.join(', ')} (an arc, a full circle and a track of I2C_SDA touching nothing); Konium joins only pads into a net's connections`}.`);
  }
  const arcs = [['UR-4', 'an arc touching nothing'], ['NA-4', 'an arc from a via'], ['UR-5', 'a full circle touching nothing']].filter(([id]) => by(id!));
  if (arcs.length) {
    const yes = arcs.filter(([id]) => has(id!, 'NetAntennae')), no = arcs.filter(([id]) => !has(id!, 'NetAntennae'));
    lines.push(`- Net Antennae on arc ends: not confirmed. ${yes.length ? `Konium reports the open end of ${yes.map(([id, w]) => `${w} (${id})`).join(' and ')}` : 'Konium reports no arc'}` +
      `${no.length ? `; it reports nothing for ${no.map(([id, w]) => `${w} (${id})`).join(' and ')}: a full circle has no end, and Konium looks for open ends only (what the suite does with one is for the comparison to show)` : ''}. ` +
      'On the demo board with the wire link, Konium reports the antenna on Arc (1181.102mil,275.591mil) as the suite does once the board has a Net Antennae rule (the demo as Konium makes it has none, so Konium checks nothing there); ' +
      'what it misses there is that arc\'s Un-Routed Net, the gap above.');
  }
  lines.push('');
  return lines;
}

function main(input: string, outDir: string): void {
  const log = (s: string) => console.log(s);
  mkdirSync(outDir, { recursive: true });
  const bytes = readFileSync(input);
  const original = readPcbDoc(bytes, 'Showcase.PcbDoc');
  const showcaseCopy = join(outDir, 'Showcase.PcbDoc');
  if (input !== showcaseCopy) copyFileSync(input, showcaseCopy);

  // Konium's DRC of the showcase as generated
  const base = koniumReport(original, 'Showcase.PcbDoc');
  writeFileSync(join(outDir, 'Showcase-konium.txt'), base.text);
  log(`Showcase: ${base.report.violations.length} violations`);

  // The showcase with the torture board's rules and Rules To Check but no faults: what is there before seeding
  const ruled = readPcbDoc(bytes, 'Showcase.PcbDoc');
  setRules(ruled, () => {});
  const baseline = runDrc(ruled, TORTURE_KINDS);
  log(`Showcase with the torture rules: ${baseline.violations.length} violations`);

  const doc = readPcbDoc(bytes, 'DrcTorture.PcbDoc');
  doc.board.bag?.set('FILENAME', 'DrcTorture.PcbDoc'); doc.dirty.add('Board6');
  log('rules:');
  setRules(doc, log);
  log('faults:');
  const s = new Seeder(doc, log);
  seed(s);
  // The pours flow round what is new, as the suite pours them
  for (const g of doc.polygons) repour(doc, g.index).apply();
  const outFile = join(outDir, 'DrcTorture.PcbDoc');
  writeFileSync(outFile, writePcbDoc(doc));

  // Read back: what the suite will open
  const back = readPcbDoc(readFileSync(outFile), 'DrcTorture.PcbDoc');
  const tort = koniumReport(back, 'DrcTorture.PcbDoc');
  writeFileSync(join(outDir, 'DrcTorture-konium.txt'), tort.text);
  log(`DrcTorture: ${tort.report.violations.length} violations`);
  const found = findFaults(back, s.faults, tort.report.violations);
  const bad = found.filter((f) => f.absent.length);
  for (const f of bad) log(`  ${f.fault.id}: not read back as written: ${f.absent.join('; ')}`);
  const nSigs = s.faults.reduce((n, f) => n + f.sigs.length, 0), nGone = s.faults.reduce((n, f) => n + f.removed.length, 0);
  const readBack = `${nSigs - bad.reduce((n, f) => n + f.absent.filter((x) => !x.startsWith('still there')).length, 0)} of ${nSigs} seeded objects found again, ${nGone - bad.reduce((n, f) => n + f.absent.filter((x) => x.startsWith('still there')).length, 0)} of ${nGone} removed tracks gone`;
  log(`read back: ${readBack}`);
  const xs = back.board.outline.map((q) => q.x), ys = back.board.outline.map((q) => q.y);
  const stats = (d: PcbDocument) => `${d.components.length} components, ${d.nets.length} nets, ${d.prims.length} primitives (${d.prims.filter((p) => p.kind === 'region' && inPour(p)).length} of them poured regions), ${d.polygons.length} polygons`;

  // The table
  const o = back.board.origin, u = drcUnits(back), pt = (v: Vec2) => `(${lengthIn(u, v.x - o.x)},${lengthIn(u, v.y - o.y)})`;
  const objects = (f: Found) => [...f.idx].filter((i) => back.prims[i]!.kind !== 'body' && !(back.prims[i]!.kind === 'text' && (back.prims[i] as { hidden?: boolean }).hidden)).map((i) => describe(back, i));
  const kindsCount = (vs: DrcViolation[]) => { const m = new Map<string, number>(); for (const v of vs) m.set(v.kind, (m.get(v.kind) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const missed = found.filter((f) => f.missing.length);
  const lines: string[] = [
    '# DRC torture board: seeded faults',
    '',
    `Board: ${basename(outFile)}, made from Showcase.PcbDoc by tests/tools/drcTorture.ts. Coordinates are in ${u} from the board origin, as the suite's DRC report gives them. ` +
      'Every seeded object was made by the script with the model\'s own record builders; the pours were repoured afterwards (they flow round the new copper; GND objects seeded inside a GND pour are joined by it).',
    '',
    `- Size ${lengthIn('mm', Math.max(...xs) - Math.min(...xs))} x ${lengthIn('mm', Math.max(...ys) - Math.min(...ys))}, ${back.board.copperStack.length} copper layers (${back.board.copperStack.map((l) => s.layerLabel(l)).join(', ')})`,
    `- Showcase.PcbDoc: ${stats(original)}`,
    `- DrcTorture.PcbDoc: ${stats(back)}`,
    `- Read back from the written file: ${readBack}`,
    '',
    '## Rules',
    '',
    'The showcase\'s own rules are kept as they are, the general Hole Size rule only moved to priority 2 under a new HoleSize_Vias (the showcase\'s routing was made to them: tighter values would flag all of it):',
    '',
    ...original.rules.filter((r) => ruleEnabled(r) && CHECKED_KINDS.includes(ruleKind(r))).map((r) => `- ${ruleName(r)}: ${md(ruleHeading(r, (c) => lengthIn(u, c)))}`),
    '',
    'Added for the kinds seeded (Minimum Annular Ring 4 mil, not 5: the showcase\'s 0.45 / 0.2 mm vias have 4.92 mil rings):',
    '',
    ...back.rules.filter((r) => !original.rules.some((x) => x.bag.get('UNIQUEID') === r.bag.get('UNIQUEID'))).map((r) => `- ${ruleName(r)}: ${md(ruleHeading(r, (c) => lengthIn(u, c)))}`),
    '',
    `Batch DRC (Design Rule Checker Options): every rule kind Konium checks that the file format has a number for (${TORTURE_KINDS.size} kinds); stop at 50000 violations.`,
    '',
    '## Faults',
    '',
    '| Id | Fault | Expected rule | Also expected | Objects | Layer | Location | Konium finds |',
    '|---|---|---|---|---|---|---|---|',
    ...found.map((f) => {
      const k = f.fault;
      const objs = [...k.keys.filter((x) => /^(Component|Polygon) /.test(x)).map((x) => (x.startsWith('Polygon') ? `${x} (GND) on Mid-Layer 1` : x)), ...objects(f), ...k.against.map((a) => (a.startsWith('removed:') ? a : `against ${a}`))];
      const res = f.missing.length ? `missed ${f.missing.join(', ')}${f.kinds.size ? `; finds ${[...f.kinds].join(', ')}` : ''}` : `yes (${[...f.kinds].join(', ')})`;
      return `| ${k.id} | ${md(k.what)} | ${k.rules.join(', ')} | ${k.also.join(', ') || '-'} | ${md(objs.join('<br>'))} | ${md(k.layer)} | ${pt(k.at)} | ${md(res)} |`;
    }),
    '',
    '"Expected rule" is what the suite should report for the fault itself; "Also expected" what follows from how it is made (a stub of a net ends open: Net Antennae). ' +
      'A track taken out (UR-1, UR-2) leaves the tracks either side of the gap open-ended: their Net Antennae violations name those existing tracks, so the table does not count them. ' +
      '"Konium finds" lists every rule kind of the violations Konium reports that involve the fault\'s own objects.',
    '',
    '## Seeded faults Konium misses',
    '',
    ...(missed.length ? missed.map((f) => `- ${f.fault.id} (${f.fault.what}): no ${f.missing.join(', ')} violation${f.kinds.size ? `; Konium reports ${[...f.kinds].join(', ')} for it` : ''}.`) : ['None.']),
    '',
    ...(s.skipped.length ? ['Not seeded (no place found):', '', ...s.skipped.map((k) => `- ${k.id} (${k.what}): ${k.why}`), ''] : []),
    ...knownGaps(found),

    '## Konium\'s DRC totals',
    '',
    `- Showcase.PcbDoc (as generated, its own Rules To Check): ${base.report.violations.length} violations: ${kindsCount(base.report.violations).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `- DrcTorture.PcbDoc (read back from the file): ${tort.report.violations.length} violations: ${kindsCount(tort.report.violations).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `- Showcase.PcbDoc with the torture board's rules and Rules To Check, before any fault is seeded: ${baseline.violations.length} violations: ${kindsCount(baseline.violations).map(([k, n]) => `${k} ${n}`).join(', ')}. ` +
      'These are the showcase\'s own: tracks leaving pads at 45° and its pours\' notches make most of the Acute Angle ones, its tracks wider than the pads they leave the SMD Neck-Down ones, its track-style teardrops crossing by the pads most of the SMD To Corner ones, its unconnected (NC) pins the Un-Connected Pin ones, the thermal vias in U8\'s and U9\'s exposed pads and vias beside pads Vias Under SMD, J2\'s edge-launch pads Board Outline Clearance.',
    `- Violations that involve a seeded object: ${new Set(found.flatMap((f) => f.hits)).size}`,
    '',
  ];
  writeFileSync(join(outDir, 'injected.md'), lines.join('\n'));
  log(`faults: ${s.faults.length}; missed by Konium: ${missed.map((f) => `${f.fault.id} (${f.missing.join(', ')})`).join('; ') || 'none'}`);
  log(`written to ${outDir}`);
}

/** The demo board with the wire link of tests/wire148.test.ts in place of its +3V3 track between U1 and C2, and the rules its DRC test adds. */
function demoWire(outDir: string): void {
  const A = { x: 19448819, y: 17322835 }, B = { x: 22618110, y: 17322835 }, BEND = { x: 21033464, y: 18000000 };
  const doc = readPcbDoc(demoPcbDoc(), 'Demo-wire.PcbDoc');
  removePrims(doc, doc.prims.filter((p) => p.kind === 'track' && p.layer === L.TOP && p.a.x === A.x && p.a.y === A.y && p.b.x === B.x && p.b.y === B.y)).apply();
  const have = new Set(doc.rules.map(ruleKind));
  const extra = ['ComponentClearance', 'NetAntennae', 'SMDNeckDown', 'SMDToCorner', 'SMDEntry', 'ViasUnderSMD', 'AcuteAngle', 'SilkToBoardRegionClearance', 'UnConnectedPin', 'BoardOutlineClearance', 'MinimumSolderMaskSliver', 'SilkToSolderMaskClearance', 'Height'];
  replaceRules(doc, [...doc.rules, ...extra.filter((k) => !have.has(k)).map((k) => newRule(k, k, 1))]).apply();
  const st = wireStart(copperAt(doc, A), L.TOP);
  if ('error' in st) throw new Error(st.error);
  const en = wireEnd(doc, st.hit, copperAt(doc, B));
  if (!en || 'error' in en) throw new Error('the wire link has no end');
  placeWireLink(doc, { path: [st.hit.at, BEND, en.end.at], layer: st.hit.layer, net: st.hit.net }).change.apply();
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'Demo-wire.PcbDoc');
  writeFileSync(file, writePcbDoc(doc));
  const r = koniumReport(readPcbDoc(readFileSync(file), 'Demo-wire.PcbDoc'), 'Demo-wire.PcbDoc');
  writeFileSync(join(outDir, 'Demo-wire-konium.txt'), r.text);
  console.log(`${file}: ${r.report.violations.length} violations, Konium's report in Demo-wire-konium.txt`);
}

const args = process.argv.slice(2);
if (args[0] === '--demo-wire' && args[1]) demoWire(args[1]);
else if (args[0] === '--report') {
  const [, input, out] = args;
  if (!input || !out) throw new Error('usage: drcTorture.ts --report <in.PcbDoc> <out.txt>');
  const doc = readPcbDoc(readFileSync(input), basename(input));
  const r = koniumReport(doc, basename(input));
  writeFileSync(out, r.text);
  console.log(`${r.report.violations.length} violations written to ${out}`);
} else if (args.length >= 2) main(args[0]!, args[1]!);
else if (!process.env.VITEST) console.log('usage: npx vite-node tests/tools/drcTorture.ts <in.PcbDoc> <outdir> | --report <in.PcbDoc> <out.txt> | --demo-wire <outdir>');
