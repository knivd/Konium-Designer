/**
 * An AD board as KiCad's (.kicad_pcb, KiCad 8's format) and its footprints as a KiCad library
 * (.kicad_mod each): the copper stack (planes as power layers, each with a zone of its net
 * pulled back from the edge, split planes zones over it), the stack-up, nets; components as
 * footprints (pads, graphics, designator and comment, the 3D model linked from the project's
 * 3dmodels folder, the schematic part they come from); tracks, arcs, vias; polygon pours as
 * zones with their poured copper; keep-outs and polygon cut-outs as rule areas; the board shape
 * and its cut-outs on Edge.Cuts. Layers as KiCad has them [est]: Overlay → SilkS, Solder →
 * Mask, Paste → Paste, Mechanical 1 → Dwgs.User, 3 → Cmts.User, 4/5 → Eco1/2.User, 6 →
 * Margin, 9/10 → F/B.Adhes, 13/14 → F/B.Fab, 15/16 → F/B.CrtYd, the other mechanical layers
 * User.1 … User.9 in the order they are met.
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { L as LY, isCopper, isMech, mechNumber, type LayerId } from '../../model/layers';
import { NO_NET, type PcbArc, type PcbBody, type PcbComponent, type PcbDocument, type PcbFill, type PcbPad, type PcbPrim, type PcbRegion, type PcbText, type PcbTrack, type PcbVia, type PolyVertex } from '../../model/pcb';
import { readStack } from '../../model/pcbStack';
import { mechKinds } from '../../model/pcbBoard';
import { bodyBag, placementOf } from '../../model/body3d';
import { resizePolygon } from '../../model/polygonOps';
import { planeCopper } from '../../model/planes';
import type { PcbLibDocument } from '../../model/pcbLib';
import { BINARY_KINDS, connectLength, connectValue, ruleEnabled, ruleKind, ruleLength, rulePriority, ruleScope1, ruleScope2, type PcbRule } from '../altium/rules';
import { boardThickness } from '../../render/gl3d/boardModel';
import { embeddedModels, type ModelFiles } from '../../render/gl3d/stepBodies';
import { signedArea } from '../features';
import { padOutline, pasteMask, solderMask } from '../gerber/gerber';
import { L, bare, isList, kid, kids, writeSexpr, written as writtenAt, type SList, type WNode, type Written } from './sexpr';
import { kicadLibId, kicadNetName } from './netName';
import { padToBoard, primNode, primShapes, readJson, sameShape, type ApertureKept, type Prim } from './padPrims';
import { footprintSig, footprintStore, keptId, keptOf, libFootprintSig, localSig, ownItems, toWNode, vertexSig, withExtras, zoneSig } from './kept';
import { GENERATOR, PCB_VERSION, Tally, UMM, generatorVersion, kicadName, kuuid, r6 } from './write';

/** mm, to 10 nm (AD's imperial units make 101.5 mm 101.499999…). */
const r5 = (v: number) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? 0 : r; };
const mm = (c: number) => r5(c * UMM);
const norm = (a: number) => r6(((a % 360) + 360) % 360);
type P2 = [number, number];
const xy = (k: P2) => L('xy', k[0], k[1]);
// (no spread: a zone's fill can have more points than a call takes arguments)
const pts = (list: P2[]): WNode => ({ k: 'pts', items: list.map(xy) });

/* ── frames: where a footprint's items go ── */

/** Board point → footprint (or board) coordinates, angles, layers and mirroring as the file keeps them. */
interface Frame { pt(p: Vec2): P2; ang(a: number): number; lay(l: LayerId): LayerId; mir(m: boolean): boolean }
const FLIP: Record<number, LayerId> = {
  [LY.TOP]: LY.BOTTOM, [LY.BOTTOM]: LY.TOP, [LY.TOP_OVERLAY]: LY.BOTTOM_OVERLAY, [LY.BOTTOM_OVERLAY]: LY.TOP_OVERLAY, [LY.TOP_PASTE]: LY.BOTTOM_PASTE, [LY.BOTTOM_PASTE]: LY.TOP_PASTE,
  [LY.TOP_SOLDER]: LY.BOTTOM_SOLDER, [LY.BOTTOM_SOLDER]: LY.TOP_SOLDER,
};
/** A component's own frame on the board: KiCad keeps footprint items unturned (a bottom one flipped), pads' and texts' angles as shown. */
function placedFrame(at: Vec2, rot: number): Frame {
  const r = (-rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return {
    pt: (p) => { const dx = p.x - at.x, dy = p.y - at.y; return [mm(dx * c - dy * s), mm(-(dx * s + dy * c))]; },
    ang: (a) => norm(a), lay: (l) => l, mir: (m) => m,
  };
}
/** A component's footprint as its library has it (a bottom one turned back over onto the top). */
function libraryFrame(at: Vec2, rot: number, bottom: boolean): Frame {
  const r = (-rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const mirrorMech = (l: LayerId) => {
    if (!isMech(l)) return FLIP[l] ?? l;
    const n = mechNumber(l);
    // Mechanical pairs as KiCad's F/B layers pair them
    const pair: Record<number, number> = { 9: 10, 10: 9, 13: 14, 14: 13, 15: 16, 16: 15 };
    return pair[n] ? LY.MECH1 + pair[n]! - 1 : l;
  };
  return {
    pt: (p) => { const dx = p.x - at.x, dy = p.y - at.y; const x = dx * c - dy * s, y = dx * s + dy * c; return [mm(x), mm(bottom ? y : -y)]; },
    ang: (a) => norm(bottom ? rot - a : a - rot), lay: (l) => (bottom ? mirrorMech(l) : l), mir: (m) => (bottom ? !m : m),
  };
}
const libDocFrame: Frame = { pt: (p) => [mm(p.x), mm(-p.y)], ang: (a) => norm(a), lay: (l) => l, mir: (m) => m };

/* ── polygons with holes as KiCad's one outline (holes joined to it by hairline bridges) ── */

/** An outline and its holes as one ring: each hole joined by a slit to the edge to its right. */
export function fracture(outline: Vec2[], holes: Vec2[][]): Vec2[] {
  let ring = signedArea(outline) >= 0 ? [...outline] : [...outline].reverse();
  const hs = holes.filter((h) => h.length >= 3).map((h) => (signedArea(h) < 0 ? h : [...h].reverse()));
  const maxX = (h: Vec2[]) => h.reduce((m, p) => Math.max(m, p.x), -Infinity);
  hs.sort((a, b) => maxX(b) - maxX(a));
  for (const h of hs) {
    let j = 0;
    for (let i = 1; i < h.length; i++) if (h[i]!.x > h[j]!.x) j = i;
    const hv = h[j]!;
    let best = -1, bx = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      if ((a.y > hv.y) === (b.y > hv.y)) continue;
      const x = a.x + ((hv.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x >= hv.x && x < bx) { bx = x; best = i; }
    }
    if (best < 0) continue;
    const I = { x: bx, y: hv.y };
    const loop = [...h.slice(j), ...h.slice(0, j), hv];
    ring = [...ring.slice(0, best + 1), I, ...loop, I, ...ring.slice(best + 1)];
  }
  return ring;
}

/* ── rules ── */

/** A rule kind's general rule (All, lowest priority), else its first. */
function generalRule(doc: PcbDocument, kind: string): PcbRule | undefined {
  const rs = doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r));
  const all = rs.filter((r) => /^all$/i.test(ruleScope1(r).trim()) && (!BINARY_KINDS.has(kind) || /^all$/i.test(ruleScope2(r).trim())));
  return (all.length ? all : rs).sort((a, b) => rulePriority(b) - rulePriority(a))[0];
}
const classOfScope = (s: string) => /^InNetClass\(\s*['"](.+?)['"]\s*\)$/i.exec(s.trim())?.[1];

export interface KicadBoardSettings {
  clearance: number; trackWidth: number; viaDiameter: number; viaDrill: number;
  minTrack: number; minClearance: number; minVia: number; minDrill: number; holeToHole: number; copperEdge: number;
  classes: { name: string; clearance?: number; trackWidth?: number; viaDiameter?: number; viaDrill?: number; nets: string[] }[];
  /** Every net by its KiCad name (a project's net class patterns kept while they name the classes' nets). */
  nets?: string[];
}
export function boardSettings(doc: PcbDocument, netNames?: Map<string, string>): KicadBoardSettings {
  const len = (kind: string, key: string, def: string) => { const r = generalRule(doc, kind); return mm(r ? ruleLength(r, key, def) : ruleLength({ prefix: new Uint8Array(), bag: { get: () => undefined } as never }, key, def)); };
  const classes: KicadBoardSettings['classes'] = [];
  for (const c of doc.classes) {
    if (c.kind !== 0 || c.superClass || /^all nets$/i.test(c.name)) continue;
    const rule = (kind: string) => doc.rules.find((r) => ruleKind(r) === kind && ruleEnabled(r) && classOfScope(ruleScope1(r)) === c.name);
    const cl = rule('Clearance'), w = rule('Width'), v = rule('RoutingVias');
    classes.push({ name: c.name, nets: c.members.map((m) => { const n = doc.nets.find((x) => x.name === m); return (n && kicadNetName(n)) ?? netNames?.get(m) ?? m; }), clearance: cl ? mm(ruleLength(cl, 'GAP', '10mil')) : undefined, trackWidth: w ? mm(ruleLength(w, 'PREFEREDWIDTH', '10mil')) : undefined,
      viaDiameter: v ? mm(ruleLength(v, 'WIDTH', '50mil')) : undefined, viaDrill: v ? mm(ruleLength(v, 'HOLEWIDTH', '28mil')) : undefined });
  }
  return {
    clearance: len('Clearance', 'GAP', '10mil'), trackWidth: len('Width', 'PREFEREDWIDTH', '10mil'), viaDiameter: len('RoutingVias', 'WIDTH', '50mil'), viaDrill: len('RoutingVias', 'HOLEWIDTH', '28mil'),
    minTrack: len('Width', 'MINLIMIT', '10mil'), minClearance: len('Clearance', 'GAP', '10mil'), minVia: len('RoutingVias', 'MINWIDTH', '50mil'), minDrill: len('HoleSize', 'MINLIMIT', '1mil'),
    holeToHole: len('HoleToHoleClearance', 'GAP', '10mil'), copperEdge: len('BoardOutlineClearance', 'GAP', '0mil'), classes,
    nets: doc.nets.map((n) => kicadNetName(n) ?? netNames?.get(n.name) ?? n.name),
  };
}

/* ── the board ── */

export interface PcbExportOptions {
  /** The file's (and project's) name. */
  name: string;
  board: PcbDocument;
  /** The footprints' library nickname. */
  footprintLib: string;
  /** The parts' KiCad paths by their unique ID path (from the schematics). */
  paths?: Map<string, string>;
  /** Models the board links to, found (by model ID); embedded ones are read from the board. */
  models?: ModelFiles;
  /** Project libraries' footprints for the footprint library too. */
  libraries?: PcbLibDocument[];
  title?: string;
  /** KiCad's names for nets Konium named otherwise (by Konium's name), from the schematics. */
  netNames?: Map<string, string>;
}
export interface PcbExport {
  text: string;
  footprints: { name: string; text: string }[];
  /** 3D models (paths under the project's folder). */
  models: { path: string; bytes: Uint8Array }[];
  settings: KicadBoardSettings;
  warnings: string[];
}

const MODEL_DIR = '3dmodels';

export function exportBoard(o: PcbExportOptions): PcbExport {
  const doc = o.board;
  const tally = new Tally();
  const copper = doc.board.copperStack;
  const cuName = (l: LayerId): string | null => { const i = copper.indexOf(l); return i < 0 ? null : i === 0 ? 'F.Cu' : i === copper.length - 1 ? 'B.Cu' : `In${i}.Cu`; };
  const userLayers = new Map<number, string>();
  const usedUser = new Set<number>();
  // A board read from KiCad: its layers back as the import mapped them (Edge.Cuts on Mechanical 1, Dwgs.User on 2, User.n on 20 + n)
  const fromKicad = !!doc.board.bag?.bool('KICADLAYERS');
  const FIXED: Record<number, string> = fromKicad
    ? { 1: 'Edge.Cuts', 2: 'Dwgs.User', 3: 'Cmts.User', 4: 'Eco1.User', 5: 'Eco2.User', 6: 'Margin', 9: 'F.Adhes', 10: 'B.Adhes', 13: 'F.Fab', 14: 'B.Fab', 15: 'F.CrtYd', 16: 'B.CrtYd',
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [21 + i, `User.${i + 1}`])) }
    : { 1: 'Dwgs.User', 3: 'Cmts.User', 4: 'Eco1.User', 5: 'Eco2.User', 6: 'Margin', 9: 'F.Adhes', 10: 'B.Adhes', 13: 'F.Fab', 14: 'B.Fab', 15: 'F.CrtYd', 16: 'B.CrtYd' };
  // A board from the desktop software: its mechanical layers by their types where KiCad has the layer (an assembly layer as Fab, a courtyard as CrtYd),
  // the numbered defaults only for layers with no type and a KiCad layer no typed one took
  const KIND_LAYER: Record<string, string> = { AssemblyTop: 'F.Fab', AssemblyBottom: 'B.Fab', CourtyardTop: 'F.CrtYd', CourtyardBottom: 'B.CrtYd', GluePointsTop: 'F.Adhes', GluePointsBottom: 'B.Adhes' };
  const kinds = fromKicad ? new Map<LayerId, string>() : mechKinds(doc);
  const byKind = new Map<number, string>();
  for (const [l, k] of kinds) if (KIND_LAYER[k]) byKind.set(mechNumber(l), KIND_LAYER[k]!);
  // (a component outline layer as Fab where no assembly layer is on that side)
  for (const [l, k] of kinds) {
    const side = k === 'ComponentOutlineTop' ? 'F.Fab' : k === 'ComponentOutlineBottom' ? 'B.Fab' : null;
    if (side && ![...byKind.values()].includes(side)) byKind.set(mechNumber(l), side);
  }
  const claimed = new Set(byKind.values());
  const SIDE: Record<number, string> = { [LY.TOP_OVERLAY]: 'F.SilkS', [LY.BOTTOM_OVERLAY]: 'B.SilkS', [LY.TOP_PASTE]: 'F.Paste', [LY.BOTTOM_PASTE]: 'B.Paste', [LY.TOP_SOLDER]: 'F.Mask', [LY.BOTTOM_SOLDER]: 'B.Mask' };
  const layerName = (l: LayerId): string | null => {
    if (isCopper(l)) return cuName(l);
    if (SIDE[l]) return SIDE[l]!;
    if (isMech(l)) {
      const n = mechNumber(l);
      if (byKind.has(n)) return byKind.get(n)!;
      if (FIXED[n] && (fromKicad || (!kinds.get(l) && !claimed.has(FIXED[n]!)))) { const um = /^User\.(\d+)$/.exec(FIXED[n]!); if (um) usedUser.add(Number(um[1])); return FIXED[n]!; }
      if (fromKicad) return 'Cmts.User';
      let u = userLayers.get(n);
      if (!u) { u = userLayers.size < 9 ? `User.${userLayers.size + 1}` : 'Cmts.User'; if (userLayers.size >= 9) tally.add('More mechanical layers than KiCad has user layers: the rest on Cmts.User'); userLayers.set(n, u); }
      return u;
    }
    return null;
  };
  // Nets by their KiCad names (a net read from KiCad and left as it was keeps its own)
  const netName = doc.nets.map((n) => kicadNetName(n) ?? o.netNames?.get(n.name) ?? n.name);
  const netOf = (n: number) => (n === NO_NET || n < 0 || !doc.nets[n] ? null : L('net', n + 1, netName[n]!));

  // Where the board sits on KiCad's page: centred, AD's origin on whole millimetres
  const shape = doc.board.outline.length >= 3 ? doc.board.outline : doc.prims.flatMap((p) => ('at' in p ? [p.at] : 'a' in p ? [p.a, p.b] : []));
  const xs = shape.map((p) => p.x), ys = shape.map((p) => p.y);
  const bx0 = xs.length ? Math.min(...xs) : 0, bx1 = xs.length ? Math.max(...xs) : 0, by0 = ys.length ? Math.min(...ys) : 0, by1 = ys.length ? Math.max(...ys) : 0;
  const bw = (bx1 - bx0) * UMM, bh = (by1 - by0) * UMM;
  const papers: [string, number, number][] = [['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841]];
  const fit = papers.find(([, w, h]) => w >= bw + 40 && h >= bh + 40);
  const [paperName, pw, ph] = fit ?? ['User', Math.ceil(bw + 40), Math.ceil(bh + 40)];
  const org = doc.board.origin;
  const ox = Math.round(pw / 2 - ((bx0 + bx1) / 2 - org.x) * UMM), oy = Math.round(ph / 2 + ((by0 + by1) / 2 - org.y) * UMM);
  const K = (p: Vec2): P2 => [r5(ox + (p.x - org.x) * UMM), r5(oy - (p.y - org.y) * UMM)];
  // A place in KiCad's millimetres as the import read them, in Konium's (a board read from KiCad)
  const kOrig = (doc.board.bag?.get('KICADORIGIN') ?? '').split(',').map(Number);
  const fromK = kOrig.length === 2 && kOrig.every(Number.isFinite) ? (x: number, y: number): Vec2 => ({ x: kOrig[0]! + x / UMM, y: kOrig[1]! - y / UMM }) : null;
  const boardFrame: Frame = { pt: K, ang: (a) => norm(a), lay: (l) => l, mir: (m) => m };

  /* ── items, in a frame ── */

  const textContent = (s: string) => s.replace(/^\.Designator$/i, '${REFERENCE}').replace(/^\.Comment$/i, '${VALUE}').replace(/^\.Layer_Name$/i, '${LAYER}').replace(/^\.([A-Za-z_]\w*)$/, (_, n: string) => `\${${n.toUpperCase()}}`);
  const arcEnds = (a: PcbArc): { s: Vec2; m: Vec2; e: Vec2; full: boolean } => {
    const sweep = ((a.end - a.start) % 360 + 360) % 360;
    const p = (d: number) => ({ x: a.c.x + a.r * Math.cos((d * Math.PI) / 180), y: a.c.y + a.r * Math.sin((d * Math.PI) / 180) });
    const full = sweep < 1e-6 || sweep > 359.999;
    return { s: p(a.start), m: p(a.start + (full ? 180 : sweep / 2)), e: p(a.start + (full ? 360 : sweep)), full };
  };
  const fillCorners = (f: PcbFill): Vec2[] => {
    const c = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }, hw = Math.abs(f.b.x - f.a.x) / 2, hh = Math.abs(f.b.y - f.a.y) / 2;
    const r = (f.rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: c.x + x! * cs - y! * sn, y: c.y + x! * sn + y! * cs }));
  };
  const strokeW = (w: number) => L('stroke', L('width', mm(w)), L('type', bare('solid')));
  const textEffects = (t: PcbText, f: Frame) => L('effects', L('font', t.fontType === 1 && t.fontName ? L('face', t.fontName) : null, L('size', mm(t.height), mm(t.height)), L('thickness', mm(Math.max(t.strokeWidth, 1))),
    t.bold && bare('bold'), t.italic && bare('italic')), L('justify', bare('left'), bare('bottom'), f.mir(t.mirrored) && bare('mirror')));

  /** A graphic, track or region as a footprint's (fp_) or the board's (gr_) item; null when its layer has no KiCad layer. */
  function graphic(p: PcbPrim, f: Frame, prefix: 'fp' | 'gr', uid: string): WNode[] {
    const lname = 'layer' in p ? layerName(f.lay(p.layer)) : null;
    if (!lname) return [];
    const onCu = /\.Cu$/.test(lname);
    const net = prefix === 'gr' && onCu && 'net' in p ? netOf(p.net) : null;
    const tail = (n?: number) => [L('layer', lname), net, L('uuid', kuuid(`${uid}:${n ?? 0}`))];
    switch (p.kind) {
      case 'track': return [L(`${prefix}_line`, L('start', ...f.pt(p.a)), L('end', ...f.pt(p.b)), strokeW(p.width), ...tail())];
      case 'arc': {
        const e = arcEnds(p);
        if (e.full) return [L(`${prefix}_circle`, L('center', ...f.pt(p.c)), L('end', ...f.pt(e.s)), strokeW(p.width), L('fill', bare('none')), ...tail())];
        return [L(`${prefix}_arc`, L('start', ...f.pt(e.s)), L('mid', ...f.pt(e.m)), L('end', ...f.pt(e.e)), strokeW(p.width), ...tail())];
      }
      case 'fill': return [L(`${prefix}_poly`, pts(fillCorners(p).map(f.pt)), L('stroke', L('width', 0), L('type', bare('solid'))), L('fill', bare('solid')), ...tail())];
      case 'region': {
        const ring = p.holes.length ? fracture(p.outline, p.holes) : p.outline;
        if (ring.length < 3) return [];
        return [L(`${prefix}_poly`, pts(ring.map(f.pt)), L('stroke', L('width', 0), L('type', bare('solid'))), L('fill', bare('solid')), ...tail())];
      }
      case 'text': {
        if (p.barcode) { tally.add('Barcode texts left out'); return []; }
        if (!p.text.trim()) return [];
        const body = [L('at', ...f.pt(p.at), f.ang(p.rotation)), L('layer', lname), L('uuid', kuuid(uid)), textEffects(p, f)];
        return prefix === 'fp' ? [L('fp_text', bare('user'), textContent(p.text), ...body)] : [L('gr_text', textContent(p.text), ...body)];
      }
      default: return [];
    }
  }

  /** The doc's primitives by key (a polygon pad's shape regions are listed by key). */
  const byKey = new Map<string, PcbPrim>(doc.prims.map((q) => [`${q.src.storage}:${q.src.index}`, q]));
  /** A component's pads KiCad had as edge connector pads (KICADCONNECT), on the outer copper only (KICADFBCU) or on none (KICADNOCU). */
  const marks = new Map<string, Set<string>>();
  /** Which of its component's pads of its name each pad is (#0 the first), as the marks name them. */
  const ordinal = new Map<PcbPad, number>();
  {
    const count = new Map<string, number>();
    for (const q of doc.prims) if (q.kind === 'pad' && q.component !== NO_NET) { const k = `${q.component}:${q.name}`; const n = count.get(k) ?? 0; ordinal.set(q, n); count.set(k, n + 1); }
  }
  const marked = (key: 'KICADCONNECT' | 'KICADFBCU' | 'KICADNOCU', p: PcbPad) => {
    if (p.component === NO_NET || !doc.components[p.component]) return false;
    let set = marks.get(`${key}:${p.component}`);
    if (!set) { set = new Set(readJson<string[]>(doc.components[p.component]!.bag.get(key)) ?? []); marks.set(`${key}:${p.component}`, set); }
    return set.has(`${p.name}#${ordinal.get(p) ?? 0}`);
  };
  // A board pad's uuid kept from KiCad (KICADPADU), by the same key
  const padUs = new Map<number, Map<string, string>>();
  const padUuid = (p: PcbPad): string | undefined => {
    if (p.component === NO_NET || !doc.components[p.component]) return undefined;
    let m = padUs.get(p.component);
    if (!m) { m = new Map(Object.entries(readJson<Record<string, string>>(doc.components[p.component]!.bag.get('KICADPADU')) ?? {})); padUs.set(p.component, m); }
    const id = m.get(`${p.name}#${ordinal.get(p) ?? 0}`);
    if (id) m.delete(`${p.name}#${ordinal.get(p) ?? 0}`);
    return id;
  };
  // A board pad's settings kept from KiCad (KICADPADX), by the same key
  const padXs = new Map<number, Record<string, SList[]>>();
  const padExtras = (p: PcbPad): SList[] | null => {
    if (p.component === NO_NET || !doc.components[p.component]) return null;
    let m = padXs.get(p.component);
    if (!m) { m = readJson<Record<string, SList[]>>(doc.components[p.component]!.bag.get('KICADPADX')) ?? {}; padXs.set(p.component, m); }
    return m[`${p.name}#${ordinal.get(p) ?? 0}`] ?? null;
  };

  /**
   * A polygon pad's shape as a custom pad's primitives: each copper region of it on the pad's
   * layer, as the KiCad primitive it was read from while it is still what that drew (and the frame
   * isn't mirrored), else as a polygon about the pad.
   */
  function customPrims(p: PcbPad, f: Frame): { prims: WNode[]; clearance: string } | null {
    const layer = p.layer === LY.MULTI ? LY.TOP : p.layer;
    const regions = (p.shapeKeys ?? []).map((k) => byKey.get(k)).filter((r): r is PcbRegion => r?.kind === 'region' && r.layer === layer);
    if (!regions.length) return null;
    const exact = !f.mir(false);
    // About the pad, its own turn taken off (the inverse of padToBoard); a mirrored footprint's mirrored
    const a = (p.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const local = (q: Vec2): [number, number] => { const u = mm(q.x - p.at.x), v = -mm(q.y - p.at.y); const y = u * sin + v * cos; return [r6(u * cos - v * sin), r6(exact ? y : -y)]; };
    const to = padToBoard(p.at, p.rotation);
    const prims: WNode[] = [];
    let clearance = 'outline';
    for (const r of regions) {
      const kept = r.kicadPrim ? readJson<Prim>(r.kicadPrim.prim) : null;
      if (r.kicadPrim) clearance = r.kicadPrim.clearance || clearance;
      const drawn = kept ? primShapes(kept, to) : [];
      if (kept && exact && drawn.length === 1 && sameShape(drawn[0]!.outline, r.outline) && drawn[0]!.holes.length === r.holes.length) { prims.push(primNode(kept)); continue; }
      const ring = r.holes.length ? fracture(r.outline, r.holes) : r.outline;
      if (ring.length >= 3) prims.push(primNode({ k: 'poly', pts: ring.map(local), w: 0, fill: true }));
    }
    // One primitive drawn as several regions (a stroke): written once
    const seen = new Set<string>();
    return { prims: prims.filter((n) => { const k = writeSexpr(n); if (seen.has(k)) return false; seen.add(k); return true; }), clearance };
  }

  /**
   * A component's own KiCad graphics and texts kept whole (kept.ts: keepFootprint), while its own
   * things are where they were in it (not mirrored into a library): the items, and the primitives
   * they stand for.
   */
  const fpNodes_ = new Map<string, SList[] | null>();
  function keptFootprint(ci: number, prims: PcbPrim[], f: Frame): { nodes: SList[]; prims: Set<PcbPrim> } | null {
    const c = doc.components[ci];
    const key = c?.bag.get('KICADFPKEY');
    if (!c || !key || f.mir(false)) return null;
    if (c.bag.get('KICADFPSIG') !== footprintSig(doc, prims).items) return null;
    // One reading of each footprint's items for all its alike
    if (!fpNodes_.has(key)) fpNodes_.set(key, readJson<SList[]>(footprintStore(doc).get(key)));
    const nodes = fpNodes_.get(key);
    return nodes ? { nodes, prims: new Set(ownItems(prims)) } : null;
  }

  /** A pad (in a frame), with its net on the board. */
  function pad(p: PcbPad, f: Frame, uid: string, withNet: boolean): WNode {
    const st = p.top;
    const thru = p.hole > 0;
    const type = !thru ? (marked('KICADCONNECT', p) ? 'connect' : 'smd') : p.plated ? 'thru_hole' : 'np_thru_hole';
    // An unplated hole's pad at least the hole (KiCad's own boards: as they had it, smaller too)
    const fromKicad = !!doc.board.bag?.get('KICADLAYERS');
    const w = Math.max(st.w, thru && !p.plated && !fromKicad ? p.hole : 1), h = Math.max(st.h, thru && !p.plated && !fromKicad ? p.hole : 1);
    const custom = customPrims(p, f);
    const shape = custom ? 'custom' : st.shape === 'round' ? (w === h ? 'circle' : 'oval') : st.shape === 'rect' ? 'rect' : 'roundrect';
    const side = f.lay(p.layer);
    // Openings as the pad has them: mask unless tented, an SMD pad's paste unless taken away
    const maskF = solderMask(doc, p, true) !== null, maskB = solderMask(doc, p, false) !== null;
    const paste = pasteMask(doc, p) > -Math.min(st.w, st.h) / 2;
    const layers = p.layer === LY.MULTI ? [...(marked('KICADNOCU', p) ? [] : [marked('KICADFBCU', p) ? 'F&B.Cu' : '*.Cu']), ...(maskF && maskB ? ['*.Mask'] : maskF ? ['F.Mask'] : maskB ? ['B.Mask'] : [])]
      : side === LY.BOTTOM ? ['B.Cu', ...(paste ? ['B.Paste'] : []), ...(maskB ? ['B.Mask'] : [])]
      : side === LY.TOP ? ['F.Cu', ...(paste ? ['F.Paste'] : []), ...(maskF ? ['F.Mask'] : [])] : [cuName(side) ?? 'F.Cu'];
    let drill: WNode | null = null;
    if (thru) {
      if (p.slot && p.slot.length > p.hole) {
        const along = Math.round(((p.slot.rotation % 180) + 180) % 180 / 90) % 2 === 0;
        drill = along ? L('drill', bare('oval'), mm(p.slot.length), mm(p.hole)) : L('drill', bare('oval'), mm(p.hole), mm(p.slot.length));
      } else drill = L('drill', mm(p.hole));
    }
    const extra: WNode[] = [];
    if (st.shape === 'roundrect' && !custom) extra.push(L('roundrect_rratio', r6(Math.min(0.5, Math.max(0, st.cornerPct / 200)))));
    if (st.shape === 'octagon' && !custom) extra.push(L('roundrect_rratio', 0), L('chamfer_ratio', 0.1464), L('chamfer', bare('top_left'), bare('top_right'), bare('bottom_left'), bare('bottom_right')));
    if (p.layer === LY.MULTI && (p.mid.w !== st.w || p.mid.h !== st.h || p.bot.w !== st.w || p.bot.h !== st.h || p.bot.shape !== st.shape)) tally.add('Pads with other shapes on other layers: their top shape on every layer (KiCad 8 has one)');
    // On the board, the settings KiCad had that Konium makes nothing of (its pin's name and type, teardrops, …); the
    // drill with its offset while the hole is the same size, the exact corner ratio while Konium's per cent is that ratio
    const kept = withNet ? padExtras(p) : null;
    const keptDrill = kept?.find((x) => x.k === 'drill'), keptRatio = kept?.find((x) => x.k === 'roundrect_rratio');
    if (keptDrill && drill && sameNumbers(keptDrill, drill)) drill = toWNode(keptDrill);
    if (keptRatio && st.shape === 'roundrect' && !custom && Math.round(Number(keptRatio.items[0]) * 200) === Math.round(st.cornerPct)) extra[0] = L('roundrect_rratio', Number(keptRatio.items[0]));
    const node = L('pad', p.name, bare(type), bare(shape), L('at', ...f.pt(p.at), f.ang(p.rotation)), L('size', mm(w), mm(h)), drill, L('layers', ...layers), ...extra,
      p.layer === LY.MULTI && type === 'thru_hole' ? L('remove_unused_layers', bare('no')) : null, withNet ? netOf(p.net) : null,
      custom ? L('options', L('clearance', bare(custom.clearance)), L('anchor', bare(st.shape === 'round' ? 'circle' : 'rect'))) : null,
      custom ? L('primitives', ...custom.prims) : null, L('uuid', withNet ? idFor(padUuid(p), uid) : kuuid(uid)));
    return withExtras(node, kept?.filter((x) => x.k !== 'drill' && x.k !== 'roundrect_rratio'));
  }
  /** A kept list and a written one with the same numbers (to a micron), the kept one's lists aside. */
  function sameNumbers(a: SList, b: WNode): boolean {
    const x = a.items.filter((v): v is number => typeof v === 'number'), y = b.items.filter((v): v is number => typeof v === 'number');
    return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]!) < 0.0015);
  }

  /** A KiCad pad on no copper, kept whole by the import (its openings regions in Konium), in a footprint turned by `rot`. */
  function aperturePad(kept: ApertureKept, f: Frame, rot: number, uid: string): WNode {
    const mirrored = f.mir(false);
    const at: [number, number] = mirrored ? [kept.at[0], r6(-kept.at[1])] : kept.at;
    const angle = norm(mirrored ? -kept.angle : kept.angle + rot);
    return withExtras(L('pad', kept.name, bare(kept.type), bare(kept.shape), L('at', ...at, angle), L('size', ...kept.size), L('layers', ...kept.layers),
      kept.rratio !== undefined ? L('roundrect_rratio', kept.rratio) : null,
      kept.anchor ? L('options', L('clearance', bare(kept.clearance ?? 'outline')), L('anchor', bare(kept.anchor))) : null,
      kept.prims?.length ? L('primitives', ...kept.prims.map(primNode)) : null, L('uuid', idFor(kept.id, uid))), kept.x);
  }

  /** A component's 3D model (a STEP body's), in KiCad's terms, its file among the exported models. */
  const modelFiles: ModelFiles = new Map([...embeddedModels(doc.cfb.root), ...(o.models ?? [])]);
  const written = new Map<string, string>();   // model ID → its path
  const exported: { path: string; bytes: Uint8Array }[] = [];
  function model(b: PcbBody, compAt: Vec2, compRot: number, bottom: boolean, f: Frame, libForm: boolean): WNode | null {
    if (b.modelType !== 1) { if (!libForm) tally.add('Extruded 3D bodies left out (KiCad links model files)'); return null; }
    const bag = bodyBag(doc, b);
    if (!bag) return null;
    const pl = placementOf(bag);
    const id = bag.get('MODELID') ?? b.identifier;
    const file = modelFiles.get(id);
    const name = kicadName((file?.name ?? bag.get('MODEL.NAME') ?? b.modelName ?? '').split(/[\\/]/).pop() || `${id}.step`);
    if (file && !written.has(id)) {
      let path = `${MODEL_DIR}/${name}`;
      for (let n = 2; exported.some((e) => e.path.toLowerCase() === path.toLowerCase()); n++) path = `${MODEL_DIR}/${name.replace(/(\.[^.]+)?$/, `_${n}$1`)}`;
      exported.push({ path, bytes: file.data });
      written.set(id, path);
    }
    if (!file && !libForm) tally.add('3D models the board links to but Konium Designer couldn\'t find: referenced by name in 3dmodels');
    const path = written.get(id) ?? `${MODEL_DIR}/${name}`;
    const lk = f.pt(pl.at);
    const top = libForm || !bottom;
    const off: [number, number, number] = [lk[0], r6(top ? -lk[1] : lk[1]), r6(pl.dz)];
    const m = bottom ? pl.rot[2] + compRot : pl.rot[2] - compRot;   // the model's own turn (AD's ROTZ holds the part's too)
    return L('model', `\${KIPRJMOD}/${path}`, L('offset', L('xyz', ...off)), L('scale', L('xyz', 1, 1, 1)), L('rotate', L('xyz', r6(-pl.rot[0]), r6(-pl.rot[1]), norm(-m))));
    void compAt;
  }

  /**
   * KiCad's rule areas read from it: one each again, its layers and what it kept out (on the layers
   * its keep-outs are on now where a part turned over took them to others).
   */
  function areaNodes(areas: PcbRegion[]): WNode[] {
    const byArea = new Map<string, PcbRegion[]>();
    for (const a of areas) byArea.set(a.kicadZone!.id, [...(byArea.get(a.kicadZone!.id) ?? []), a]);
    const out: WNode[] = [];
    for (const [id, parts] of byArea) {
      const a = parts[0]!, first = parts.filter((x) => x.layer === a.layer);
      const rules = a.kicadZone!.keepout.split(',').map((x) => x.split('=')).filter((x) => x.length === 2 && x[0]);
      // (KiCad's other settings for it, kept: its name, placement rules, hatching …; one layer as one)
      const kx = a.kicadZone!.x ? readJson<SList[]>(a.kicadZone!.x) : null;
      let ls = a.kicadZone!.layers.split(' ').filter(Boolean);
      const now = [...new Set(parts.map((x) => layerName(x.layer)).filter((n): n is string => !!n))];
      const all = copper.map(cuName).filter((n): n is string => !!n);
      const was = new Set(ls.flatMap((n) => (n === '*.Cu' ? all : n === 'F&B.Cu' ? ['F.Cu', 'B.Cu'] : [n])));
      if (now.length && (now.length !== was.size || now.some((n) => !was.has(n)))) ls = now;
      out.push(kx ? L('zone', L('net', 0), L('net_name', ''), ls.length === 1 ? L('layer', ls[0]!) : L('layers', ...ls), L('uuid', idFor(uuidLike(id), `area:${id}`)),
        ...kx.filter((x) => x.k !== '').map((x) => toWNode(x)), L('keepout', ...rules.map(([k, v]) => L(k!, bare(v!)))), ...first.map((x) => L('polygon', pts(x.outline.map(K)))))
        : L('zone', L('net', 0), L('net_name', ''), L('layers', ...ls), L('uuid', idFor(uuidLike(id), `area:${id}`)),
        L('hatch', bare('edge'), 0.5), L('connect_pads', L('clearance', 0)), L('min_thickness', 0.25), L('filled_areas_thickness', bare('no')),
        L('keepout', ...rules.map(([k, v]) => L(k!, bare(v!)))), L('fill', L('thermal_gap', 0.5), L('thermal_bridge_width', 0.5)),
        ...first.map((x) => L('polygon', pts(x.outline.map(K))))));
    }
    return out;
  }

  /** A pad on a layer other than copper (a drawing made of pads): its shape as a filled polygon there. */
  function padShape(p: PcbPad, f: Frame, prefix: 'fp' | 'gr', uid: string): WNode[] {
    const lname = layerName(f.lay(p.layer));
    if (!lname) return [];
    return [L(`${prefix}_poly`, pts(padOutline(p.at, p.top, p.rotation).map(f.pt)), L('stroke', L('width', 0), L('type', bare('solid'))), L('fill', bare('solid')), L('layer', lname), L('uuid', kuuid(uid)))];
  }
  const onCopper = (p: PcbPad) => p.layer === LY.MULTI || isCopper(p.layer);

  /** A footprint's own items (texts but its designator and comment, graphics, pads, model). */
  function footprintItems(prims: PcbPrim[], f: Frame, seed: string, withNet: boolean, comp?: { at: Vec2; rot: number; bottom: boolean; libForm: boolean }): WNode[] {
    const out: WNode[] = [];
    const apertures = new Set<string>();
    // The part's own KiCad graphics and texts kept whole (kept.ts), while they are where they were in it
    const ci = prims.find((p) => 'component' in p && p.component !== NO_NET && doc.components[p.component]) as { component: number } | undefined;
    const whole = ci ? keptFootprint(ci.component, prims, f) : null;
    const ownIds = new Set<string>();
    // (each with its uuid, kept apart from the items alike footprints share)
    const fpIds = whole && ci ? (doc.components[ci.component]!.bag.get('KICADFPIDS') ?? '').split(',') : [];
    whole?.nodes.forEach((n, k) => { const id = idFor(fpIds[k] || n.id || undefined, `${seed}:kept:${k}`); ownIds.add(id); out.push(toWNode(n, id)); });
    const fpAreas: PcbRegion[] = [];
    prims.forEach((p, i) => {
      const uid = `${seed}:${i}`;
      if (whole?.prims.has(p)) return;
      // A polygon pad's shape goes with its pad (a custom pad's primitives)
      if (p.kind === 'region' && p.padShape !== undefined && p.shapeOf && byKey.has(p.shapeOf)) return;
      if (p.kind === 'region' && p.kicadAperture) {
        if (apertures.has(p.kicadAperture.id)) return;
        apertures.add(p.kicadAperture.id);
        const kept = readJson<ApertureKept>(p.kicadAperture.pad);
        if (kept) { out.push(aperturePad(kept, f, comp && !comp.libForm ? comp.rot : 0, uid)); return; }
      }
      if (p.kind === 'pad') out.push(...(onCopper(p) ? [pad(p, f, uid, withNet)] : padShape(p, f, 'fp', uid)));
      else if (p.kind === 'via') out.push(pad({ kind: 'pad', src: p.src, name: '', layer: LY.MULTI, at: p.at, rotation: 0, top: { w: p.diameter, h: p.diameter, shape: 'round', cornerPct: 0 },
        mid: { w: p.diameter, h: p.diameter, shape: 'round', cornerPct: 0 }, bot: { w: p.diameter, h: p.diameter, shape: 'round', cornerPct: 0 }, hole: p.hole, plated: true, net: p.net, component: NO_NET, locked: false }, f, uid, withNet));
      else if (p.kind === 'body') { if (comp) { const m = model(p, comp.at, comp.rot, comp.bottom, f, comp.libForm); if (m) out.push(m); } }
      else if (p.kind === 'text' && (p.isDesignator || p.isComment)) { /* the footprint's fields */ }
      else if ('keepout' in p && p.keepout) { if (p.kind === 'region' && p.kicadZone && comp && !comp.libForm) fpAreas.push(p); /* the rest: board-level rule areas */ }
      else if (p.kind === 'region' && (p.regionKind !== 0 || p.boardCutout)) { /* cut-outs and outlines: board level */ }
      else out.push(...graphic(p, f, 'fp', uid));
    });
    // KiCad's rule areas of the footprint, in it again; its dimensions, groups and other zones as they were, moved with the part
    out.push(...areaNodes(fpAreas));
    if (ci && comp && !comp.libForm) out.push(...placedWithPart(ci.component, ownIds, seed));
    // Models last (KiCad's order)
    return [...out.filter((n) => n.k !== 'model'), ...out.filter((n) => n.k === 'model')];
  }

  /**
   * A footprint's dimensions, groups and zones other than rule areas, which KiCad keeps in the board's
   * places (kept as they were with the part, and where it was: KICADFPABS, KICADFPAT): moved and turned
   * as the part has been since; a group with those of its members written. A part turned over: left out.
   */
  function placedWithPart(ci: number, ownIds: Set<string>, seed: string): WNode[] {
    const c = doc.components[ci]!;
    const abs = readJson<SList[]>(c.bag.get('KICADFPABS'));
    const at = (c.bag.get('KICADFPAT') ?? '').split(' '), was = at.slice(0, 3).map(Number);
    if (!abs?.length || !fromK || was.length !== 3 || !was.every(Number.isFinite)) return [];
    const o = fromK(was[0]!, was[1]!);
    if (at[3] !== (c.layer === LY.BOTTOM ? 'B' : 'F')) { tally.add('Dimensions, groups and zones of footprints turned over to the other side: left out', abs.length); return []; }
    const d = (((c.rotation - was[2]!) % 360) + 360) % 360;
    const r = (d * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const moved = (x: number, y: number): [number, number] => {
      const m = fromK(x, y), dx = m.x - o.x, dy = m.y - o.y;
      return K({ x: c.at.x + dx * cos - dy * sin, y: c.at.y + dx * sin + dy * cos });
    };
    const turn = (n: SList): SList => ({ ...n, items: n.items.map((x, i) => (isList(x) ? turn(x) : n.k === 'at' && i === 2 && typeof x === 'number' && d ? norm(x + d) : x)) });
    const out: WNode[] = [];
    const ids = new Set(ownIds);
    abs.forEach((n, k) => {
      if (n.k === 'group') return;
      if (n.id) ids.add(n.id);
      out.push(toWNode(turn(n), n.k === 'zone' || n.k === 'dimension' ? idFor(n.id ?? undefined, `${seed}:abs:${k}`) : n.id, moved));
    });
    for (const g of abs.filter((n) => n.k === 'group')) {
      const members = (kids(g, 'members')[0]?.items ?? []).map(String).filter((id) => ids.has(id));
      if (!members.length) continue;
      const w = toWNode({ ...g, items: g.items.filter((x) => !isList(x) || (x.k !== 'members' && x.k !== 'id')) }, g.id);
      w.items.push(L('members', ...members));
      out.push(w);
    }
    return out;
  }

  /** A part's Reference or Value as KiCad had it (kept whole), its value as the part's now, while its text is where it was and shown as it was. */
  const keptField = (name: string, t: PcbText | undefined, f: Frame, value: string, hide: boolean, seed: string, ci: number): WNode | null => {
    if (f.mir(false)) return null;
    const c = doc.components[ci];
    const src = c ? readJson<Record<string, SList>>(c.bag.get('KICADFIELDS'))?.[name] : undefined;
    // Its text where it was in the part; or, empty in KiCad (no text made of it), empty still
    const sig = c?.bag.get(name === 'Reference' ? 'KICADREFSIG' : 'KICADVALSIG');
    if (!src || src.k !== 'property' || (t ? sig !== localSig(doc, t) : sig !== '' || value !== '' || src.items[1] !== '')) return null;
    // Shown as the import left it: on (NAMEON, COMMENTON) when not hidden and on a silkscreen
    const hidden = src.items.some((x) => x === 'hide') || kids(src, 'hide').some((h) => String(h.items[0] ?? 'yes') !== 'no') || kids(kid(src, 'effects'), 'hide').length > 0 || (kid(src, 'effects')?.items.includes('hide') ?? false);
    const wasOn = !hidden && /SilkS/.test(String(kid(src, 'layer')?.items[0] ?? ''));
    if (wasOn === hide) return null;
    const n = toWNode(src, idFor(src.id, seed));
    n.items[1] = value;
    return n;
  };
  const fieldNode = (name: string, value: string, t: PcbText | undefined, f: Frame, hide: boolean, seed: string, fallback: { layer: string; y: number }, ci = -1): WNode => {
    const kept = keptField(name, t, f, value, hide, seed, ci);
    if (kept) return kept;
    const lname = t ? layerName(f.lay(t.layer)) : null;
    if (!t || !lname) return L('property', name, value, L('at', 0, fallback.y, 0), L('layer', fallback.layer), hide && bare('hide'), L('uuid', kuuid(seed)), L('effects', L('font', L('size', 1, 1), L('thickness', 0.15))));
    return L('property', name, value, L('at', ...f.pt(t.at), f.ang(t.rotation)), L('layer', lname), hide && bare('hide'), L('uuid', kuuid(seed)), textEffects(t, f));
  };
  const hiddenField = (name: string, value: string, seed: string, fab: string, id?: string) => L('property', name, value, L('at', 0, 0, 0), L('unlocked', bare('yes')), L('layer', fab), bare('hide'), L('uuid', id ? idFor(id, seed) : kuuid(seed)), L('effects', L('font', L('size', 1, 1), L('thickness', 0.15))));
  const attrOf = (prims: PcbPrim[], kind: number) => {
    const thru = prims.some((p) => p.kind === 'pad' && p.hole > 0 && p.plated), smd = prims.some((p) => p.kind === 'pad' && !p.hole);
    const flags = [thru ? 'through_hole' : smd ? 'smd' : '', kind === 2 ? 'board_only' : '', kind === 2 ? 'exclude_from_pos_files' : '', [2, 4, 5].includes(kind) ? 'exclude_from_bom' : ''].filter(Boolean);
    return flags.length ? L('attr', ...flags.map(bare)) : null;
  };

  // KiCad's uuids kept for what its groups and generated objects name: each written once (a copy made in Konium takes a new one)
  const idsOut = new Set<string>(), changed = new Set<string>();
  const idFor = (kept: string | undefined, seed: string): string => {
    if (kept && !idsOut.has(kept)) { idsOut.add(kept); return kept; }
    return kuuid(seed);
  };
  /** A zone's ID kept from KiCad: its uuid when a group named it. */
  const uuidLike = (id: string | undefined) => (id && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id : undefined);

  /* ── footprints ── */

  const byComp = new Map<number, PcbPrim[]>();
  const free: PcbPrim[] = [];
  for (const p of doc.prims) {
    const c = 'component' in p ? p.component : NO_NET;
    if (c !== NO_NET && c >= 0 && doc.components[c]) { const l = byComp.get(c); if (l) l.push(p); else byComp.set(c, [p]); }
    else free.push(p);
  }
  // (each written as it is made: a big board's footprints as lists took over a gigabyte)
  const fpNodes: Written[] = [];
  const libFootprints = new Map<string, { name: string; text: string }>();
  const fpName = (pattern: string, designator: string) => kicadName(pattern || `FP_${designator}`);
  doc.components.forEach((c, ci) => {
    const prims = byComp.get(ci) ?? [];
    const bottom = c.layer === LY.BOTTOM;
    const f = placedFrame(c.at, c.rotation);
    const name = fpName(c.pattern, c.designator);
    const desig = prims.find((p): p is PcbText => p.kind === 'text' && p.isDesignator);
    const comm = prims.find((p): p is PcbText => p.kind === 'text' && p.isComment);
    const comment = comm && !/^\.comment$/i.test(comm.text) ? comm.text : c.bag.get('COMMENT') ?? c.bag.get('SOURCELIBREFERENCE') ?? '';
    const kind = c.bag.int('COMPONENTKIND');
    const uid = (c.bag.get('SOURCEUNIQUEID') ?? '').replace(/^\\/, '');
    const path = uid ? o.paths?.get(uid.toUpperCase()) ?? `/${uid.split('\\').map((s, i, a) => kuuid(`${i < a.length - 1 ? 'S' : 'C'}:${s}`)).join('/')}` : null;
    const seed = `fp:${ci}:${c.designator}`;
    const side = bottom ? 'B' : 'F';
    // A footprint read from KiCad keeps its library's name while it is the footprint it was
    const fpId = kicadLibId(c.bag.get('KICADFOOTPRINT'), name) ?? `${o.footprintLib}:${name}`;
    fpNodes.push(writtenAt(fpSettings(c, prims, kind, seed, L('footprint', fpId, c.bag.get('LOCKED') === 'TRUE' ? bare('locked') : null, L('layer', bottom ? 'B.Cu' : 'F.Cu'), L('uuid', idFor(c.bag.get('KICADUUID'), seed)), L('at', ...K(c.at), norm(c.rotation)),
      c.bag.get('FOOTPRINTDESCRIPTION') ? L('descr', c.bag.get('FOOTPRINTDESCRIPTION')!) : null,
      fieldNode('Reference', c.designator, desig, f, !c.nameOn, `${seed}:ref`, { layer: `${side}.SilkS`, y: -2 }, ci),
      fieldNode('Value', comment, comm, f, !c.commentOn, `${seed}:val`, { layer: `${side}.Fab`, y: 2 }, ci),
      hiddenField('Footprint', fpId, `${seed}:fp`, `${side}.Fab`, c.bag.get('KICADFPFU')), hiddenField('Datasheet', '', `${seed}:ds`, `${side}.Fab`),
      hiddenField('Description', c.bag.get('SOURCEDESCRIPTION') ?? '', `${seed}:de`, `${side}.Fab`),
      path ? L('path', path) : null, attrOf(prims, kind),
      ...footprintItems(prims, f, seed, true, { at: c.at, rot: c.rotation, bottom, libForm: false }))), 1));
    // Its library footprint (the first component of each)
    if (!libFootprints.has(name.toLowerCase())) {
      const lf = libraryFrame(c.at, c.rotation, bottom);
      libFootprints.set(name.toLowerCase(), { name, text: footprintFile(name, c.bag.get('FOOTPRINTDESCRIPTION') ?? '', attrOf(prims, kind), footprintItems(prims, lf, `lib:${name}`, false, { at: c.at, rot: c.rotation, bottom, libForm: true })) });
    }
  });
  /**
   * A footprint's settings kept from KiCad (KICADFPX): its datasheet, its description and its
   * attributes as KiCad wrote them while Konium's say the same; its 3D models as KiCad names them
   * while the part has bodies of those models; the rest (tags, its sheet, margins …) as they were.
   */
  function fpSettings(c: PcbComponent, prims: PcbPrim[], kind: number, seed: string, node: WNode): WNode {
    const kept = readJson<SList[]>(c.bag.get('KICADFPX'));
    if (!kept) return node;
    const at = (key: string) => node.items.findIndex((x) => typeof x === 'object' && 'k' in x && (key.startsWith('property ') ? x.k === 'property' && x.items[0] === key.slice(9) : x.k === key));
    const swap = (key: string, by: SList) => { const i = at(key); if (i >= 0) node.items[i] = toWNode(by, key.startsWith('property ') ? idFor(by.id, `${seed}:${key}`) : undefined); };
    const prop = (n: string) => kept.find((x) => x.k === 'property' && x.items[0] === n);
    const ds = prop('Datasheet'), de = prop('Description');
    if (ds) swap('property Datasheet', ds);
    if (de && String(de.items[1] ?? '') === (c.bag.get('SOURCEDESCRIPTION') ?? '')) swap('property Description', de);
    const attr = kept.find((x) => x.k === 'attr');
    if (attr) {
      const a = attr.items.map(String);
      if ((a.includes('board_only') ? (a.includes('exclude_from_bom') ? 2 : 1) : a.includes('exclude_from_bom') ? 5 : 0) === kind) {
        // (KiCad's footprint with no attributes at all: none written)
        if (!attr.items.length) { const i = at('attr'); if (i >= 0) node.items.splice(i, 1); }
        else if (at('attr') >= 0) swap('attr', attr);
        else {
          // (KiCad's attributes where Konium's kind writes none: after the path, or the fields)
          const i = Math.max(at('path'), node.items.reduce<number>((m, x, k) => (typeof x === 'object' && 'k' in x && x.k === 'property' ? k : m), -1));
          node.items.splice(i + 1, 0, toWNode(attr));
        }
      }
    }
    // 3D models: KiCad's while the part's bodies are of those models (by their file's name, KiCad's VRML read as STEP)
    const models = kept.filter((x) => x.k === 'model');
    const stem = (f: string) => (f.split(/[\\/]/).pop() ?? '').replace(/\.(wrl|wings|stp|step|igs|iges)$/i, '').toLowerCase();
    const shown = models.filter((m) => !m.items.some((y) => y === 'hide' || (isList(y) && y.k === 'hide' && y.items[0] !== 'no'))).map((m) => stem(String(m.items[0] ?? ''))).sort();
    const bodies = prims.filter((p): p is PcbBody => p.kind === 'body' && p.modelType === 1).map((b) => stem(bodyBag(doc, b)?.get('MODEL.NAME') ?? '')).sort();
    let items = node.items;
    if (models.length && shown.join('|') === bodies.join('|')) items = [...items.filter((x) => !(typeof x === 'object' && 'k' in x && x.k === 'model')), ...models.map((m) => toWNode(m))];
    return withExtras({ k: node.k, items }, kept.filter((x) => x.k !== 'model' && x.k !== 'attr' && x.k !== 'property'));
  }

  // Free pads: each a footprint of its own (KiCad keeps pads in footprints)
  let freePads = 0;
  for (const p of free) {
    if (p.kind !== 'pad') continue;
    if (!onCopper(p)) continue;   // a drawing: with the board's graphics
    const name = `PAD${++freePads}`, seed = `freepad:${p.src.storage}:${p.src.index}`;
    const f = placedFrame(p.at, 0);
    fpNodes.push(writtenAt(L('footprint', `${o.footprintLib}:FreePad`, L('layer', 'F.Cu'), L('uuid', kuuid(seed)), L('at', ...K(p.at), 0),
      L('property', 'Reference', name, L('at', 0, -1.5, 0), L('layer', 'F.Fab'), bare('hide'), L('uuid', kuuid(`${seed}:r`)), L('effects', L('font', L('size', 1, 1), L('thickness', 0.15)))),
      L('property', 'Value', 'FreePad', L('at', 0, 1.5, 0), L('layer', 'F.Fab'), bare('hide'), L('uuid', kuuid(`${seed}:v`)), L('effects', L('font', L('size', 1, 1), L('thickness', 0.15)))),
      L('attr', bare('board_only'), bare('exclude_from_pos_files'), bare('exclude_from_bom')), pad(p, f, `${seed}:p`, true)), 1));
  }
  if (freePads) tally.add(`Free pads as footprints of their own (FreePad, PAD1 …)`, freePads);
  // The project libraries' footprints the board doesn't use
  for (const lib of o.libraries ?? []) {
    for (const e of lib.footprints) {
      const name = kicadName(e.name);
      if (libFootprints.has(name.toLowerCase())) continue;
      try {
        // A footprint read from KiCad and left as it was: KiCad's (under the name it goes by now)
        const params = e.original?.params;
        const prims = e.loaded === false && e.original ? e.original.prims : e.doc.prims;
        const src = params?.has('KICADSRC') && params.get('KICADSIG') === libFootprintSig(prims) ? readJson<SList>(params.getRaw('KICADSRC')) : null;
        if (src) { libFootprints.set(name.toLowerCase(), { name, text: `${writeSexpr(toWNode({ ...src, items: [name, ...src.items.slice(1)] }))}\n` }); continue; }
        const fd = e.doc;
        libFootprints.set(name.toLowerCase(), { name, text: footprintFile(name, e.description ?? '', attrOf(fd.prims, 0), footprintItems(fd.prims, libDocFrame, `lib:${name}`, false)) });
      } catch { tally.add(`${e.name}: footprint not read, left out`); }
    }
  }

  /* ── free copper and graphics ── */

  const items: WNode[] = [];
  const keepouts: { layer: string; outline: Vec2[]; pourOnly: boolean }[] = [];
  const keepoutLines: (PcbTrack | PcbArc)[] = [];
  const teardrops: PcbRegion[] = [], areas: PcbRegion[] = [];
  let nTracks = 0, nVias = 0;
  // KiCad's own board graphics and texts, kept whole by the import: written again as they were
  // while everything each made is still there and unchanged (kept.ts)
  const groups = new Map<string, { n: number; prims: PcbPrim[]; src?: SList; same: boolean }>();
  for (const p of free) {
    const k = keptOf(doc, p);
    if (!k) continue;
    const g = groups.get(k.group) ?? { n: k.n, prims: [], same: true };
    g.prims.push(p); if (k.src) g.src = k.src; if (!k.same) g.same = false;
    groups.set(k.group, g);
  }
  const asKept = new Set<PcbPrim>();
  const kOrigin = (doc.board.bag?.get('KICADORIGIN') ?? '').split(',').map(Number);
  // What the import made nothing of (the title block, dimensions, hidden and empty texts), back as it was
  const passed = readJson<SList[]>(doc.board.bag?.get('KICADPASS')) ?? [];
  let titleBlock: WNode | null = null;
  // KiCad's millimetres as the import placed them, then as this export places the board
  const move = kOrigin.length === 2 && kOrigin.every(Number.isFinite) ? (x: number, y: number): [number, number] => K({ x: kOrigin[0]! + x / UMM, y: kOrigin[1]! - y / UMM }) : undefined;
  if (move) {
    passed.forEach((n, k) => {
      if (n.k === 'title_block') titleBlock = toWNode(n);
      else items.push(toWNode(n, idFor(n.id, `pass:${k}`), move));
    });
    for (const [id, g] of groups) {
      if (!g.same || !g.src || g.prims.length !== g.n) continue;
      g.prims.forEach((p) => asKept.add(p));
      items.push(toWNode(g.src, idFor(g.src.id, `kept:${id}`), move));
    }
  }
  free.forEach((p, i) => {
    let uid = `free:${p.src.storage}:${p.src.index}:${i}`;
    if (asKept.has(p)) return;
    // A track, arc or via a group or tuning pattern names: its uuid kept (kuuid of a uuid is that uuid)
    const kid_ = p.kind === 'track' || p.kind === 'arc' || p.kind === 'via' ? keptId(doc, p) : null;
    if (kid_) { uid = idFor(kid_.id, uid); if (!kid_.same) changed.add(kid_.id); }
    if (p.kind === 'pad') { if (!onCopper(p)) items.push(...padShape(p, boardFrame, 'gr', uid)); return; }
    if ('polygon' in p && p.polygon !== NO_NET && p.polygon >= 0 && doc.polygons.some((x) => x.index === p.polygon)) return;   // a pour's copper: its zone
    if (p.kind === 'via') { items.push(withExtras(viaNode(p, uid), kid_?.extras)); nVias++; return; }
    if (p.kind === 'body') return;
    const keep = ('keepout' in p && p.keepout) || ('layer' in p && p.layer === LY.KEEPOUT);
    if (keep && p.kind === 'region' && p.kicadZone) { areas.push(p); return; }   // back as KiCad's rule area, its layers together
    if (keep) {
      const layer = p.layer === LY.KEEPOUT ? '*.Cu' : layerName(p.layer);
      if (!layer) return;
      if (p.kind === 'region') keepouts.push({ layer, outline: p.outline, pourOnly: false });
      else if (p.kind === 'fill') keepouts.push({ layer, outline: fillCorners(p), pourOnly: false });
      else if (p.kind === 'track' || p.kind === 'arc') keepoutLines.push(p);
      return;
    }
    if (p.kind === 'region' && p.kicadTeardrop && p.regionKind === 0 && cuName(p.layer)) { teardrops.push(p); return; }   // back as KiCad's teardrop zone
    if (p.kind === 'region' && p.boardCutout) return;   // Edge.Cuts
    if (p.kind === 'region' && p.regionKind === 1) { const l = layerName(p.layer); if (l) keepouts.push({ layer: l, outline: p.outline, pourOnly: true }); return; }
    if (p.kind === 'region' && p.regionKind !== 0) return;
    if ((p.kind === 'track' || p.kind === 'arc') && isCopper(p.layer)) {
      const l = cuName(p.layer);
      if (!l) return;
      nTracks++;
      if (p.kind === 'track') items.push(withExtras(L('segment', L('start', ...K(p.a)), L('end', ...K(p.b)), L('width', mm(p.width)), L('layer', l), netOf(p.net), L('uuid', kuuid(uid))), kid_?.extras));
      else {
        const e = arcEnds(p);
        if (e.full) {
          // KiCad's arcs turn less than a full circle: two halves
          const q = { x: p.c.x - (e.s.x - p.c.x), y: p.c.y - (e.s.y - p.c.y) };
          const m1 = { x: p.c.x - (p.c.y - e.s.y), y: p.c.y + (e.s.x - p.c.x) }, m2 = { x: 2 * p.c.x - m1.x, y: 2 * p.c.y - m1.y };
          items.push(L('arc', L('start', ...K(e.s)), L('mid', ...K(m1)), L('end', ...K(q)), L('width', mm(p.width)), L('layer', l), netOf(p.net), L('uuid', kuuid(`${uid}:a`))),
            L('arc', L('start', ...K(q)), L('mid', ...K(m2)), L('end', ...K(e.s)), L('width', mm(p.width)), L('layer', l), netOf(p.net), L('uuid', kuuid(`${uid}:b`))));
        } else items.push(withExtras(L('arc', L('start', ...K(e.s)), L('mid', ...K(e.m)), L('end', ...K(e.e)), L('width', mm(p.width)), L('layer', l), netOf(p.net), L('uuid', kuuid(uid))), kid_?.extras));
      }
      return;
    }
    items.push(...graphic(p, boardFrame, 'gr', uid));
  });
  // Components' keep-outs and cut-outs: board-level rule areas too
  for (const [, prims] of byComp) for (const p of prims) {
    if (p.kind === 'region' && p.kicadZone && p.keepout) continue;   // a footprint's KiCad rule area: in it (footprintItems)
    const keep = ('keepout' in p && p.keepout) || ('layer' in p && p.layer === LY.KEEPOUT);
    if (!keep && !(p.kind === 'region' && p.regionKind === 1)) continue;
    const layer = 'layer' in p ? (p.layer === LY.KEEPOUT ? '*.Cu' : layerName(p.layer)) : null;
    if (!layer) continue;
    if (p.kind === 'region') keepouts.push({ layer, outline: p.outline, pourOnly: !keep });
    else if (p.kind === 'fill') keepouts.push({ layer, outline: fillCorners(p), pourOnly: false });
    else if (p.kind === 'track' || p.kind === 'arc') keepoutLines.push(p);
  }
  function viaNode(v: PcbVia, uid: string): WNode {
    const a = cuName(v.layerStart) ?? 'F.Cu', b = cuName(v.layerEnd) ?? 'B.Cu';
    const through = a === 'F.Cu' && b === 'B.Cu' || a === 'B.Cu' && b === 'F.Cu';
    return L('via', !through && bare('blind'), L('at', ...K(v.at)), L('size', mm(v.diameter)), L('drill', mm(v.hole)), L('layers', a, b), netOf(v.net), L('uuid', kuuid(uid)));
  }

  // Keep-out lines: closed loops as rule areas
  for (const loop of chain(keepoutLines)) keepouts.push({ layer: keepoutLines.find((x) => x === loop.first)!.layer === LY.KEEPOUT ? '*.Cu' : layerName(loop.first.layer) ?? '*.Cu', outline: loop.pts, pourOnly: false });
  const open = keepoutLines.length - chainCount(keepoutLines);
  if (open > 0) tally.add('Keep-out lines that don\'t close a loop left out (KiCad\'s keep-outs are areas)', open);

  /* ── the board shape ── */

  const edge: WNode[] = [];
  // (a board from KiCad has its Edge.Cuts drawing on Mechanical 1, written with the rest: no shape drawn again)
  const edgeDrawn = fromKicad && doc.prims.some((p) => 'layer' in p && p.layer === LY.MECH1 && p.kind !== 'text');
  const verts = edgeDrawn ? [] : doc.board.vertices;
  verts.forEach((v, i) => {
    const n = verts[(i + 1) % verts.length]!;
    const uid = kuuid(`edge:${i}`);
    if (v.arc) {
      const { c, r, sa, ea } = v.arc;
      const sweep = ((ea - sa) % 360 + 360) % 360;
      const m = sa + sweep / 2;
      const mid = { x: c.x + r * Math.cos((m * Math.PI) / 180), y: c.y + r * Math.sin((m * Math.PI) / 180) };
      edge.push(L('gr_arc', L('start', ...K(v.p)), L('mid', ...K(mid)), L('end', ...K(n.p)), L('stroke', L('width', 0.05), L('type', bare('default'))), L('layer', 'Edge.Cuts'), L('uuid', uid)));
    } else edge.push(L('gr_line', L('start', ...K(v.p)), L('end', ...K(n.p)), L('stroke', L('width', 0.05), L('type', bare('default'))), L('layer', 'Edge.Cuts'), L('uuid', uid)));
  });
  doc.prims.forEach((p, i) => {
    if (edgeDrawn || p.kind !== 'region' || !p.boardCutout || p.outline.length < 3) return;
    edge.push(L('gr_poly', pts(p.outline.map(K)), L('stroke', L('width', 0.05), L('type', bare('default'))), L('fill', bare('none')), L('layer', 'Edge.Cuts'), L('uuid', kuuid(`cut:${i}`))));
  });

  /* ── zones ── */

  const zones: WNode[] = [];
  const pc = generalRule(doc, 'PolygonConnect');
  const thermal = (r: PcbRule | undefined, gapKey: string, styleKey: string) => {
    // KiCad's zones connect pads (vias always solid): the rule's through-hole pad settings
    const style = ((r && connectValue(r, styleKey)) ?? 'Relief').toLowerCase();
    const gap = mm(r ? connectLength(r, gapKey, '10mil') : mil(10)), bridge = mm(r ? connectLength(r, 'RELIEFCONDUCTORWIDTH', '10mil') : mil(10));
    return { pads: style === 'direct' ? 'yes' : style.startsWith('no') ? 'no' : '', gap, bridge };
  };
  const clear = generalRule(doc, 'Clearance');
  const gapMm = mm(clear ? ruleLength(clear, 'GAP', '10mil') : mil(10));
  const zone = (z: { net: number; layer: string; name?: string; priority: number; outline: Vec2[]; clearance: number; th: { pads: string; gap: number; bridge: number }; hatch?: { w: number; gap: number; deg: number }; minWidth: number; islands: boolean; filled: Vec2[][]; seed: string; /** Its uuid kept from KiCad. */ kept?: string;
    /** KiCad's settings for it, kept while the pour's own are as read (its name, priority, connection, fill …). */ settings?: SList[];
    /** A zone on several layers (KiCad's own, read from it): its layers, outlines, and fills by layer. */ layers?: string[]; outlines?: Vec2[][]; filledOn?: { layer: string; poly: Vec2[] }[];
    /** Its outline as KiCad wrote it (of arcs), while the pour's is as read. */ polygons?: WNode[] }) => {
    const n = z.net !== NO_NET && doc.nets[z.net] ? z.net + 1 : 0;
    if (z.settings) {
      return L('zone', L('net', n), L('net_name', n ? netName[z.net]! : ''), z.layers ? L('layers', ...z.layers) : L('layer', z.layer), L('uuid', idFor(z.kept, z.seed)),
        ...z.settings.filter((x) => x.k !== '').map((x) => toWNode(x)),
        ...(z.polygons ?? (z.outlines ?? [z.outline]).map((o) => L('polygon', pts(o.map(K))))),
        ...(z.filledOn ?? z.filled.map((poly) => ({ layer: z.layer, poly }))).map((f) => L('filled_polygon', L('layer', f.layer), pts(f.poly.map(K)))));
    }
    return L('zone', L('net', n), L('net_name', n ? netName[z.net]! : ''), z.layers ? L('layers', ...z.layers) : L('layer', z.layer), L('uuid', idFor(z.kept, z.seed)), z.name ? L('name', z.name) : null, L('hatch', bare('edge'), 0.5),
      z.priority ? L('priority', z.priority) : null, L('connect_pads', z.th.pads ? bare(z.th.pads) : null, L('clearance', z.clearance)), L('min_thickness', z.minWidth), L('filled_areas_thickness', bare('no')),
      L('fill', z.filled.length ? bare('yes') : null, z.hatch ? L('mode', bare('hatch')) : null, L('thermal_gap', z.th.gap), L('thermal_bridge_width', z.th.bridge),
        z.hatch ? L('hatch_thickness', z.hatch.w) : null, z.hatch ? L('hatch_gap', z.hatch.gap) : null, z.hatch ? L('hatch_orientation', z.hatch.deg) : null,
        z.islands ? null : L('island_removal_mode', 1)),
      ...(z.polygons ?? (z.outlines ?? [z.outline]).map((o) => L('polygon', pts(o.map(K))))),
      ...(z.filledOn ?? z.filled.map((poly) => ({ layer: z.layer, poly }))).map((f) => L('filled_polygon', L('layer', f.layer), pts(f.poly.map(K)))));
  };
  // Polygon pours (pour order: first poured, highest priority)
  const order = [...doc.polygons].sort((a, b) => a.bag.int('POURINDEX', a.index) - b.bag.int('POURINDEX', b.index));
  const pours = doc.polygons.filter((p) => !/split|cut/i.test(p.type));
  order.forEach((pg) => {
    const layer = cuName(pg.layer);
    if (!layer || pg.outline.length < 3) { if (!layer && isCopper(pg.layer) === false) tally.add('Polygon pours off copper left out'); return; }
    if (/cut/i.test(pg.type)) { keepouts.push({ layer, outline: pg.outline, pourOnly: true }); return; }
    if (/split/i.test(pg.type)) return;   // with its plane
    // KiCad's zone on several layers (a pour per layer here): back as that one zone
    const kz = pg.bag.get('KICADZONE');
    const group = kz ? order.filter((q) => q.bag.get('KICADZONE') === kz && cuName(q.layer) && q.outline.length >= 3) : [pg];
    if (kz && group[0] !== pg) return;
    const hatchStyle = (pg.hatch || 'Solid').toLowerCase();
    const tw = mm(pg.bag.get('TRACKWIDTH') ? ruleLength({ prefix: new Uint8Array(), bag: pg.bag } as PcbRule, 'TRACKWIDTH', '8mil') : mil(8));
    const grid = mm(pg.bag.get('GRIDSIZE') ? ruleLength({ prefix: new Uint8Array(), bag: pg.bag } as PcbRule, 'GRIDSIZE', '20mil') : mil(20));
    const hatch = hatchStyle === 'solid' || hatchStyle === 'none' ? undefined : { w: tw, gap: r6(Math.max(0.01, grid - tw)), deg: /45/.test(hatchStyle) ? 45 : 0 };
    // (its copper as regions: a hatched pour's too where it has them, KiCad's hatched fill read as one; the desktop software's hatching is tracks)
    const fillOf = (q: typeof pg) => doc.prims.filter((p): p is PcbRegion => p.kind === 'region' && p.polygon === q.index && p.layer === q.layer && p.regionKind === 0)
      .map((r) => (r.holes.length ? fracture(r.outline, r.holes) : r.outline)).filter((r) => r.length >= 3);
    const filled = fillOf(pg);
    const rank = pours.length - pours.indexOf(pg);
    const multi = kz ? { layers: pg.bag.get('KICADZONELAYERS')!.split(' ').filter(Boolean), outlines: group.filter((q) => q.layer === pg.layer).map((q) => q.outline),
      filledOn: group.flatMap((q) => fillOf(q).map((poly) => ({ layer: cuName(q.layer)!, poly }))) } : {};
    zones.push(zone({ net: pg.net, layer, name: pg.name, priority: Math.max(0, rank - 1), outline: pg.outline, clearance: gapMm, th: thermal(pc, 'AIRGAPWIDTH', 'CONNECTSTYLE'),
      hatch, minWidth: hatch ? tw : 0.1524, islands: pg.bag.get('REMOVEDEAD') !== 'FALSE', filled, seed: `zone:${pg.index}`, kept: pg.bag.get('KICADUUID'), ...multi,
      ...(move && pg.bag.has('KICADZONEPOLY') && pg.bag.get('KICADZONEPSIG') === vertexSig(pg.bag) ? { polygons: (readJson<SList[]>(pg.bag.get('KICADZONEPOLY')) ?? []).map((n) => toWNode(n, undefined, move)) } : {}),
      ...(pg.bag.has('KICADZONEX') && pg.bag.get('KICADZONESIG') === zoneSig(pg.bag) ? { settings: readJson<SList[]>(pg.bag.get('KICADZONEX')) ?? undefined } : {}) }));
    if (hatchStyle === 'none') tally.add('Outline-only polygon pours as solid zones');
  });
  // Planes: the layer's net over the board (pulled back from its edge), split planes over it
  const rows = doc.board.bag ? readStack(doc.board.bag, copper) : [];
  const planeConnect = generalRule(doc, 'PlaneConnect'), planeClear = generalRule(doc, 'PlaneClearance');
  for (const pl of copper.filter((l) => l >= LY.PLANE1 && l <= LY.PLANE16)) {
    const layer = cuName(pl)!;
    const netName = doc.board.bag?.get(`PLANE${pl - LY.PLANE1 + 1}NETNAME`) ?? '';
    const net = doc.nets.findIndex((n) => n.name === netName);
    const pullback = rows.find((r) => r.layer === pl)?.pullback ?? mil(20);
    const pulled = doc.board.outline.length >= 3 ? resizePolygon({ outline: doc.board.outline } as never, -pullback)[0] ?? doc.board.outline : [];
    const th = thermal(planeConnect, 'RELIEFAIRGAP', 'PLANECONNECTSTYLE');
    const cl = mm(planeClear ? ruleLength(planeClear, 'CLEARANCE', '20mil') : mil(20));
    // The plane's copper as AD makes it, as the zones' fill
    const areas = planeCopper(doc, pl);
    const fillOf = (i: number) => (areas[i]?.regions ?? []).map((r) => (r.holes.length ? fracture(r.outline, r.holes) : r.outline)).filter((r) => r.length >= 3);
    const splits = doc.polygons.filter((p) => p.layer === pl && /split/i.test(p.type) && p.outline.length >= 3);
    // (none of the layer's own when a split covers the board, as AD keeps a plane's net)
    if (pulled.length >= 3 && (fillOf(0).length || !splits.length)) zones.push(zone({ net: net >= 0 ? net : NO_NET, layer, name: `${layer} plane`, priority: 0, outline: pulled, clearance: cl, th, minWidth: 0.1524, islands: true, filled: fillOf(0), seed: `plane:${pl}` }));
    splits.forEach((sp, k) => {
      zones.push(zone({ net: sp.net, layer, name: sp.name, priority: 1, outline: sp.outline, clearance: cl, th, minWidth: 0.1524, islands: true, filled: fillOf(k + 1), seed: `split:${sp.index}` }));
    });
  }
  // Teardrops read from KiCad: its zones again (outline, type, priority; the regions their fill), one per zone and layer
  const tdZones = new Map<string, PcbRegion[]>();
  for (const t of teardrops) { const k = `${t.kicadTeardrop!.zone}|${t.layer}`; tdZones.set(k, [...(tdZones.get(k) ?? []), t]); }
  for (const [key, parts] of tdZones) {
    const t = parts[0]!, td = t.kicadTeardrop!, layer = cuName(t.layer)!;
    const kept = td.outline.split(';').map((q) => q.split(' ').map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)).map(([x, y]) => ({ x: x!, y: y! }));
    const n = t.net !== NO_NET && doc.nets[t.net] ? t.net + 1 : 0;
    zones.push(L('zone', L('net', n), L('net_name', n ? netName[t.net]! : ''), L('layer', layer), L('uuid', idFor(uuidLike(td.zone), `teardrop:${key}`)), L('name', `$teardrop_${td.type}$`), L('hatch', bare('full'), 0.1),
      L('priority', td.priority), L('attr', L('teardrop', L('type', bare(td.type)))), L('connect_pads', bare('yes'), L('clearance', 0)), L('min_thickness', 0.0254), L('filled_areas_thickness', bare('no')),
      L('fill', bare('yes'), L('thermal_gap', 0.5), L('thermal_bridge_width', 0.5), L('island_removal_mode', 1), L('island_area_min', 10)),
      // (its outline as KiCad had it: none where it had none, KiCad's own oddity)
      L('polygon', pts((kept.length >= 3 ? kept : td.outline === '' ? [] : t.outline).map(K))),
      ...parts.map((r) => L('filled_polygon', L('layer', layer), pts(r.outline.map(K))))));
  }
  // KiCad's rule areas read from it: one each again, its layers and what it kept out
  zones.push(...areaNodes(areas));
  // Rule areas
  keepouts.forEach((k, i) => {
    if (k.outline.length < 3) return;
    const na = (b: boolean) => bare(b ? 'allowed' : 'not_allowed');
    zones.push(L('zone', L('net', 0), L('net_name', ''), k.layer === '*.Cu' ? L('layers', '*.Cu') : L('layer', k.layer), L('uuid', kuuid(`keepout:${i}`)), L('name', k.pourOnly ? 'Polygon cut-out' : 'Keep-out'),
      L('hatch', bare('edge'), 0.5), L('connect_pads', L('clearance', 0)), L('min_thickness', 0.25), L('filled_areas_thickness', bare('no')),
      L('keepout', L('tracks', na(k.pourOnly)), L('vias', na(k.pourOnly)), L('pads', na(k.pourOnly)), L('copperpour', na(false)), L('footprints', na(true))),
      L('fill', L('thermal_gap', 0.5), L('thermal_bridge_width', 0.5)), L('polygon', pts(k.outline.map(K)))));
  });
  if (doc.dimensions.length) tally.add('Dimensions left out', doc.dimensions.length);

  // KiCad's tuning patterns: again while every track they made is written unchanged (else the tracks alone);
  // its groups: again with the members written (a group of none left out), groups of groups too
  const grouped: WNode[] = [];
  const kept = move ? readJson<SList[]>(doc.board.bag?.get('KICADGROUPS')) ?? [] : [];
  const membersOf = (n: SList) => (kids(n, 'members')[0]?.items ?? []).map(String);
  let tuning = 0;
  for (const g of kept.filter((n) => n.k === 'generated' && n.id)) {
    const m = membersOf(g);
    if (!m.length || !m.every((id) => idsOut.has(id) && !changed.has(id))) { tuning++; continue; }
    idsOut.add(g.id!);
    grouped.push(toWNode(g, g.id, move));
  }
  if (tuning) tally.add('Tuning patterns whose tracks changed or went: their tracks alone', tuning);
  const groupsIn = kept.filter((n) => n.k === 'group' && n.id);
  for (let more = true; more;) {
    more = false;
    for (const g of groupsIn) if (!idsOut.has(g.id!) && membersOf(g).some((id) => idsOut.has(id))) { idsOut.add(g.id!); more = true; }
  }
  // A newer KiCad's geometric constraints: again while every object they tie is written unchanged
  let dropped = 0;
  for (const c of move ? readJson<SList[]>(doc.board.bag?.get('KICADCONSTRAINTS')) ?? [] : []) {
    const m = (kids(c, 'members')[0]?.items ?? []).filter(isList).map((x) => String(x.items[0] ?? ''));
    if (!m.length || !m.every((id) => idsOut.has(id) && !changed.has(id))) { dropped++; continue; }
    grouped.push(toWNode(c, c.id));
  }
  if (dropped) tally.add('Geometric constraints whose objects changed or went: left out', dropped);
  for (const g of groupsIn) {
    if (!idsOut.has(g.id!)) continue;
    const n = { ...g, items: g.items.filter((x) => !isList(x) || (x.k !== 'members' && x.k !== 'id')) };
    const w = toWNode(n, g.id);
    w.items.push(L('members', ...membersOf(g).filter((id) => idsOut.has(id))));
    grouped.push(w);
  }

  /* ── the file ── */

  const settings = boardSettings(doc, o.netNames);
  const layerDefs: WNode[] = copper.map((l, i) => {
    const n = i === 0 ? 0 : i === copper.length - 1 ? 31 : i;
    const user = doc.board.layerNames.get(l);
    return L(String(n), cuName(l)!, bare(l >= LY.PLANE1 && l <= LY.PLANE16 ? 'power' : 'signal'), user ? user : null);
  });
  const fixed: [number, string, string?][] = [[32, 'B.Adhes', 'B.Adhesive'], [33, 'F.Adhes', 'F.Adhesive'], [34, 'B.Paste'], [35, 'F.Paste'], [36, 'B.SilkS', 'B.Silkscreen'], [37, 'F.SilkS', 'F.Silkscreen'],
    [38, 'B.Mask'], [39, 'F.Mask'], [40, 'Dwgs.User', 'User.Drawings'], [41, 'Cmts.User', 'User.Comments'], [42, 'Eco1.User', 'User.Eco1'], [43, 'Eco2.User', 'User.Eco2'], [44, 'Edge.Cuts'], [45, 'Margin'],
    [46, 'B.CrtYd', 'B.Courtyard'], [47, 'F.CrtYd', 'F.Courtyard'], [48, 'B.Fab'], [49, 'F.Fab']];
  for (const [n, name, user] of fixed) layerDefs.push(L(String(n), name, bare('user'), user ?? null));
  for (let u = 1; u <= 9; u++) if (u <= userLayers.size || usedUser.has(u)) layerDefs.push(L(String(49 + u), `User.${u}`, bare('user')));

  // Stack-up
  const stack: WNode[] = [L('layer', 'F.SilkS', L('type', 'Top Silk Screen')), L('layer', 'F.Paste', L('type', 'Top Solder Paste')), L('layer', 'F.Mask', L('type', 'Top Solder Mask'), L('thickness', 0.01))];
  let dn = 0;
  for (const r of rows) {
    if ((r.kind === 'signal' || r.kind === 'plane') && r.layer !== null && cuName(r.layer)) stack.push(L('layer', cuName(r.layer)!, L('type', 'copper'), L('thickness', mm(r.copper) || 0.035)));
    else if (r.kind === 'dielectric') stack.push(L('layer', `dielectric ${++dn}`, L('type', r.dielType === 2 ? 'prepreg' : 'core'), L('thickness', mm(r.height) || 0.1), L('material', r.dielMaterial || 'FR4'), L('epsilon_r', r6(r.dielConst || 4.5)), L('loss_tangent', 0.02)));
  }
  stack.push(L('layer', 'B.Mask', L('type', 'Bottom Solder Mask'), L('thickness', 0.01)), L('layer', 'B.Paste', L('type', 'Bottom Solder Paste')), L('layer', 'B.SilkS', L('type', 'Bottom Silk Screen')),
    L('copper_finish', 'None'), L('dielectric_constraints', bare('no')));
  const mask = generalRule(doc, 'SolderMaskExpansion'), paste = generalRule(doc, 'PasteMaskExpansion');

  const tree = L('kicad_pcb', L('version', PCB_VERSION), L('generator', GENERATOR), L('generator_version', generatorVersion()),
    L('general', L('thickness', r6(boardThickness(doc))), L('legacy_teardrops', bare('no'))),
    paperName === 'User' ? L('paper', 'User', pw, ph) : L('paper', paperName),
    // A board from KiCad with no title block goes back with none
    titleBlock ?? (kOrigin.length === 2 && kOrigin.every(Number.isFinite) ? null : L('title_block', L('title', o.title ?? o.name))),
    L('layers', ...layerDefs),
    L('setup', rows.length ? L('stackup', ...stack) : null, L('pad_to_mask_clearance', mask ? mm(ruleLength(mask, 'EXPANSION', '4mil')) : 0.1016),
      paste ? L('pad_to_paste_clearance', mm(ruleLength(paste, 'EXPANSION', '0mil'))) : null, L('allow_soldermask_bridges_in_footprints', bare('no')),
      L('aux_axis_origin', ox, oy), L('grid_origin', ox, oy)),
    L('net', 0, ''), ...doc.nets.map((_, i) => L('net', i + 1, netName[i]!)),
    ...fpNodes, ...edge, ...items, ...zones, ...grouped);
  void nTracks; void nVias;
  return { text: `${writeSexpr(tree)}\n`, footprints: [...libFootprints.values()], models: exported, settings, warnings: tally.lines() };
}

/** A .kicad_mod's text: the footprint with its fields and items. */
function footprintFile(name: string, descr: string, attr: WNode | null, items: WNode[]): string {
  const f = (k: string, v: string, y: number, layer: string, hide = false) => L('property', k, v, L('at', 0, y, 0), hide && L('unlocked', bare('yes')), L('layer', layer), hide && bare('hide'),
    L('uuid', kuuid(`${name}:${k}`)), L('effects', L('font', L('size', 1, 1), L('thickness', 0.15))));
  const tree = L('footprint', name, L('version', PCB_VERSION), L('generator', GENERATOR), L('generator_version', generatorVersion()), L('layer', 'F.Cu'), descr ? L('descr', descr) : null,
    f('Reference', 'REF**', -2, 'F.SilkS'), f('Value', name, 2, 'F.Fab'), f('Footprint', '', 0, 'F.Fab', true), f('Datasheet', '', 0, 'F.Fab', true), f('Description', descr, 0, 'F.Fab', true),
    attr, ...items);
  return `${writeSexpr(tree)}\n`;
}

/* ── keep-out lines into loops ── */

interface Loop { first: PcbTrack | PcbArc; pts: Vec2[] }
function ends(p: PcbTrack | PcbArc): [Vec2, Vec2] {
  if (p.kind === 'track') return [p.a, p.b];
  const q = (d: number) => ({ x: p.c.x + p.r * Math.cos((d * Math.PI) / 180), y: p.c.y + p.r * Math.sin((d * Math.PI) / 180) });
  return [q(p.start), q(p.end)];
}
function along(p: PcbTrack | PcbArc, fromStart: boolean): Vec2[] {
  if (p.kind === 'track') return fromStart ? [p.a, p.b] : [p.b, p.a];
  const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360, n = Math.max(2, Math.ceil(sweep / 10));
  const list = Array.from({ length: n + 1 }, (_, i) => { const d = p.start + (sweep * i) / n; return { x: p.c.x + p.r * Math.cos((d * Math.PI) / 180), y: p.c.y + p.r * Math.sin((d * Math.PI) / 180) }; });
  return fromStart ? list : list.reverse();
}
const loopCache = new WeakMap<object, Loop[]>();
function chain(lines: (PcbTrack | PcbArc)[]): Loop[] {
  const hit = loopCache.get(lines);
  if (hit) return hit;
  const TOL = mil(0.5);
  const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) <= TOL && Math.abs(a.y - b.y) <= TOL;
  const used = new Set<number>();
  const out: Loop[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const start = ends(lines[i]!)[0];
    let cur = i, from = start;
    const ptsOut: Vec2[] = [];
    const mine = new Set([i]);
    let closed = false;
    for (let guard = 0; guard <= lines.length; guard++) {
      const [a, b] = ends(lines[cur]!);
      const fwd = near(a, from);
      const seg = along(lines[cur]!, fwd);
      ptsOut.push(...seg.slice(0, -1));
      const to = fwd ? b : a;
      if (near(to, start)) { closed = true; break; }
      const next = lines.findIndex((l, k) => !mine.has(k) && !used.has(k) && l.layer === lines[i]!.layer && (near(ends(l)[0], to) || near(ends(l)[1], to)));
      if (next < 0) break;
      mine.add(next); cur = next; from = to;
    }
    if (closed && ptsOut.length >= 3) { for (const k of mine) used.add(k); out.push({ first: lines[i]!, pts: ptsOut }); }
  }
  loopCache.set(lines, out);
  return out;
}
function chainCount(lines: (PcbTrack | PcbArc)[]): number {
  const loops = chain(lines);
  let n = 0;
  for (const l of loops) { const pts = new Set(l.pts.map((p) => `${p.x},${p.y}`)); n += lines.filter((x) => { const [a, b] = ends(x); return pts.has(`${a.x},${a.y}`) || pts.has(`${b.x},${b.y}`); }).length; }
  return Math.min(lines.length, n);
}
export type { PolyVertex };
