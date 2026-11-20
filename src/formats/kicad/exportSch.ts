/**
 * A project's schematics as KiCad's (.kicad_sch, KiCad 8's format): one file per SchDoc — a
 * sheet used by several symbols is one file with an instance for each, its parts' designators
 * per instance as AD's channels name them — the top sheet the project's root (several tops get
 * a root of their own holding them). Parts become symbols (one library symbol per library
 * reference, a variant where a placed part's pins differ), power ports power symbols, ports
 * hierarchical labels (global labels where the design's ports are global), net labels labels,
 * sheet symbols sheets with their pins; wires are broken where things join them (KiCad joins
 * at ends) and AD's automatic junctions are written as junctions. AD's sheet is centred on
 * KiCad's page of the same name, on its 100 mil grid.
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import type { PropertyBag } from '../altium/props';
import { DIR_VECTORS, SCH_DEFAULTS, SR, bagOf, componentKind, deriveObject, isShown, ownedBy, type SchDocument, type SchFont, type SchObject, type SchSheet } from '../../model/sch';
import type { SheetInput } from '../../model/compile';
import { entryPoint, resolveSheet, sheetHierarchy, symbolNames, type SymbolRef } from '../../model/schHierarchy';
import { REPEAT, channelDesignator, sheetInstances, type SheetInstance } from '../../model/channels';
import { autoJunctions } from '../../model/schConnect';
import { parametersOf } from '../../model/schSpecial';
import { symbolOf } from '../../model/makeLib';
import { bezierPts, powerGlyph } from '../../editors/sch/powerPort';
import { adOrientation, fieldFrame, lookSig, plainText, pngInfo, symbolTransform } from './schematic';
import { schStorage, storedBytes, storedFile, type StoredFile } from '../altium/schdoc';
import { readJson } from './padPrims';
import { L, bare, kid as kidOf, writeSexpr, type SList, type WNode } from './sexpr';
import { bagsSig, partSymbolSig, preferKept, symbolStore, toWNode, withExtras } from './kept';
import { kicadLibId } from './netName';
import { GENERATOR, SCH_VERSION, SYM_VERSION, Tally, UMM, generatorVersion, kicadMarkup, kicadName, kicadNet, kuuid, r4, yes } from './write';

type Tf = [number, number, number, number];
type K = (p: Vec2) => [number, number];

const mm = (c: number) => r4(c * UMM);
/** AD font size (points) as KiCad's text size: 5 mil of capital height a point. */
const textMm = (pts: number) => r4(pts * 0.127);
const fontOf = (fonts: SchFont[], id: number): SchFont => fonts[id - 1] ?? fonts[0] ?? { size: 10, name: 'Arial', rotation: 0, bold: false, italic: false };
/** A font's capital height in AD units. */
const capU = (f: SchFont) => f.size * mil(5);

const xy = (k: [number, number]) => L('xy', k[0], k[1]);
// (no spread: a long outline can have more points than a call takes arguments)
const pts = (list: [number, number][]): WNode => ({ k: 'pts', items: list.map(xy) });
const at = (k: [number, number], a?: number) => (a === undefined ? L('at', k[0], k[1]) : L('at', k[0], k[1], a));
const H = ['left', '', 'right'], V = ['bottom', '', 'top'];
function effects(size: number, o: { h?: number; v?: number; hide?: boolean; bold?: boolean; italic?: boolean; mirror?: boolean } = {}): WNode {
  const j = [H[o.h ?? 1]!, V[o.v ?? 1]!, o.mirror ? 'mirror' : ''].filter(Boolean).map(bare);
  return L('effects', L('font', L('size', size, size), o.bold && bare('bold'), o.italic && bare('italic')), j.length ? L('justify', ...j) : null, o.hide && bare('hide'));
}
/**
 * A label's font as KiCad had it (schematic.ts: fontX), while Konium's is still the size the import
 * made of it (within half a point): its exact size, its settings Konium makes nothing of (its stroke's thickness …).
 */
function keptFontOf(node: WNode, kept: { size: number; h?: number; x: SList[] } | null): WNode {
  if (!kept) return node;
  const list = (n: WNode | undefined, k: string) => n?.items.find((y): y is WNode => typeof y === 'object' && 'k' in y && y.k === k);
  const f = list(list(node, 'effects'), 'font'), sz = list(f, 'size');
  if (!f || !sz || Math.abs(Number(sz.items[0]) - kept.size) > 0.0635) return node;
  sz.items = [kept.size, kept.h ?? kept.size];
  const add = (kept.x ?? []).filter((y) => !list(f, y.k)).map((y) => toWNode(y));
  f.items.splice(f.items.indexOf(sz) + 1, 0, ...add);
  return node;
}
const stroke = (w = 0, type = 'default') => L('stroke', L('width', w), L('type', bare(type)));
const LINE_TYPES = ['default', 'dash', 'dot', 'dash_dot'];
/** AD's line widths: Smallest and Small as KiCad's default, Medium and Large as they are. */
const widthMm = (w: number) => (w <= mil(10) ? 0 : mm(w));

/* ── text placement ── */

/**
 * A text AD draws at `p` (ORIENTATION, JUSTIFICATION, capital height `h`) as a KiCad field of a
 * symbol placed by `t`: centred across its line (so KiCad's box flips can't move it), along it
 * as AD justifies it, the way KiCad shows it.
 */
function fieldAt(p: Vec2, orient: number, justify: number, h: number, t: Tf): { p: Vec2; angle: number; h: number } {
  let o = orient & 3, hj = justify % 3, vj = Math.floor(justify / 3) % 3;
  if (o >= 2) { o -= 2; hj = 2 - hj; vj = 2 - vj; }
  const up = o === 1 ? { x: -1, y: 0 } : { x: 0, y: 1 };
  const k = ((1 - vj) * h) / 2;
  const angle = (o === 1) !== (t[1] !== 0) ? 90 : 0;
  const f = fieldFrame(t, angle);
  return { p: { x: p.x + up.x * k, y: p.y + up.y * k }, angle, h: hj === 1 ? 1 : f.hFlip ? 2 - hj : hj };
}
/** A free text (no symbol's turn): its angle (0 or 90) and justification. */
function textAt(orient: number, justify: number): { angle: number; h: number; v: number } {
  let o = orient & 3, hj = justify % 3, vj = Math.floor(justify / 3) % 3;
  if (o >= 2) { o -= 2; hj = 2 - hj; vj = 2 - vj; }
  return { angle: o === 1 ? 90 : 0, h: hj, v: vj };
}

/** AD's special strings in KiCad's text variables (=Title → ${TITLE}). */
const SPECIAL: Record<string, string> = {
  TITLE: 'TITLE', DATE: 'ISSUE_DATE', CURRENTDATE: 'CURRENT_DATE', REVISION: 'REVISION', COMPANYNAME: 'COMPANY', ORGANIZATION: 'COMPANY',
  SHEETNUMBER: '#', SHEETTOTAL: '##', DOCUMENTNAME: 'FILENAME', DOCUMENTFULLPATHANDNAME: 'FILEPATH', PROJECTNAME: 'PROJECTNAME',
};
function special(s: string): string {
  const m = /^=([A-Za-z_][\w.]*)$/.exec(s.trim());
  if (!m) return kicadMarkup(s);
  const k = m[1]!.toUpperCase();
  return `\${${SPECIAL[k] ?? k}}`;
}

/* ── shapes (a symbol's graphics, a sheet's drawing) ── */

function fillOf(solid: boolean, fill: number, line: number): WNode {
  if (!solid) return L('fill', L('type', bare('none')));
  if (fill === line) return L('fill', L('type', bare('outline')));
  if (fill === SCH_DEFAULTS.bodyFill || fill === 0xfff7c2 || fill === 0xffffb0) return L('fill', L('type', bare('background')));
  return L('fill', L('type', bare('color')), L('color', (fill >> 16) & 255, (fill >> 8) & 255, fill & 255, 1));
}
const arcPt = (c: Vec2, rx: number, ry: number, deg: number): Vec2 => ({ x: c.x + rx * Math.cos((deg * Math.PI) / 180), y: c.y + ry * Math.sin((deg * Math.PI) / 180) });
function ring(c: Vec2, rx: number, ry: number, a0: number, a1: number, n = 36): Vec2[] {
  const sweep = ((a1 - a0) % 360 + 360) % 360 || 360;
  const steps = Math.max(4, Math.ceil((n * sweep) / 360));
  return Array.from({ length: steps + 1 }, (_, i) => arcPt(c, rx, ry, a0 + (sweep * i) / steps));
}

/** A graphic (line, polygon, rectangle, ellipse, arc, Bézier) as KiCad's, its points by `k`. */
function shapeItems(o: SchObject, k: K): WNode[] {
  switch (o.kind) {
    case 'polyline': {
      if (o.pts.length < 2) return [];
      return [L('polyline', pts(o.pts.map(k)), stroke(widthMm(o.width), LINE_TYPES[o.style ?? 0] ?? 'default'), L('fill', L('type', bare('none'))))];
    }
    case 'polygon': {
      if (o.pts.length < 2) return [];
      const list = [...o.pts, o.pts[0]!].map(k);
      return [L('polyline', pts(list), stroke(widthMm(o.width)), fillOf(o.solid && !o.transparent, o.fill, o.color))];
    }
    case 'rect': {
      const a = k({ x: Math.min(o.a.x, o.b.x), y: Math.max(o.a.y, o.b.y) }), b = k({ x: Math.max(o.a.x, o.b.x), y: Math.min(o.a.y, o.b.y) });
      return [L('rectangle', L('start', ...a), L('end', ...b), stroke(widthMm(o.width)), fillOf(o.solid && !o.transparent, o.fill, o.color))];
    }
    case 'ellipse': {
      if (Math.abs(o.rx - o.ry) < 2) return [L('circle', L('center', ...k(o.c)), L('radius', mm(o.rx)), stroke(widthMm(o.width)), fillOf(o.solid && !o.transparent, o.fill, o.color))];
      return [L('polyline', pts(ring(o.c, o.rx, o.ry, 0, 360).map(k)), stroke(widthMm(o.width)), fillOf(o.solid && !o.transparent, o.fill, o.color))];
    }
    case 'arc': {
      const sweep = ((o.end - o.start) % 360 + 360) % 360;
      if (Math.abs(o.rx - o.ry) < 2) {
        if (sweep < 1e-6 || sweep > 359.9) return [L('circle', L('center', ...k(o.c)), L('radius', mm(o.rx)), stroke(widthMm(o.width)), L('fill', L('type', bare('none'))))];
        return [L('arc', L('start', ...k(arcPt(o.c, o.rx, o.rx, o.start))), L('mid', ...k(arcPt(o.c, o.rx, o.rx, o.start + sweep / 2))), L('end', ...k(arcPt(o.c, o.rx, o.rx, o.start + sweep))),
          stroke(widthMm(o.width)), L('fill', L('type', bare('none'))))];
      }
      return [L('polyline', pts(ring(o.c, o.rx, o.ry, o.start, o.end).map(k)), stroke(widthMm(o.width)), L('fill', L('type', bare('none'))))];
    }
    case 'piechart': {
      const list = [o.c, ...ring(o.c, o.r, o.r, o.start, o.end), o.c];
      return [L('polyline', pts(list.map(k)), stroke(widthMm(o.width)), fillOf(o.solid, o.fill, o.color))];
    }
    case 'bezier': {
      const out: WNode[] = [];
      for (let i = 0; i + 3 < o.pts.length; i += 3) out.push(L('bezier', pts(o.pts.slice(i, i + 4).map(k)), stroke(widthMm(o.width)), L('fill', L('type', bare('none')))));
      return out;
    }
    default: return [];
  }
}

/* ── library symbols ── */

const ELECTRICAL = ['input', 'bidirectional', 'output', 'open_collector', 'passive', 'tri_state', 'open_emitter', 'power_in'];
function pinShape(s: { inner: number; innerEdge: number; outerEdge: number; outer: number }): string {
  const clock = s.innerEdge === 3;
  if (clock) return s.outerEdge === 1 ? 'inverted_clock' : s.outerEdge === 4 ? 'clock_low' : 'clock';
  if (s.outerEdge === 1) return 'inverted';
  if (s.outerEdge === 4) return 'input_low';
  if (s.outerEdge === 5) return 'output_low';
  if (s.outer === 1) return 'non_logic';
  return 'line';
}

export interface LibSymbolIn {
  /** The COMPONENT record first, then its children (as a SchLib or Make Schematic Library keeps them). */
  bags: PropertyBag[];
  fonts: SchFont[];
  systemFont: number;
  footprintLib: string;
  /** KiCad's library symbol a placed part was placed from, while the part's symbol is what the import made (kept.ts: partSymbolSig). */
  kicad?: SList | null;
}

/** A symbol's pins (number, part, place, direction, length) as one string: placed parts whose pins differ get their own library symbol. */
function pinSignature(bags: PropertyBag[]): string {
  return bags.map((b, i) => (i > 0 && b.int('RECORD', -1) === SR.PIN ? deriveObject(b, i) : null)).filter((o): o is SchObject & { kind: 'pin' } => o?.kind === 'pin')
    .map((o) => `${o.designator}@${o.ownerPartId}:${o.at.x},${o.at.y},${o.orient},${o.length},${o.hidden ? 1 : 0}`).sort().join('|');
}

/** One AD library symbol as KiCad's, named `name` ("Library:Name" inside a schematic, "Name" in a .kicad_sym). */
export function libSymbol(name: string, s: LibSymbolIn): WNode {
  const comp = s.bags[0]!;
  // A symbol read from KiCad and left as it was: KiCad's (under the name it goes by now)
  const kept = s.kicad ?? (comp.has('KICADSRC') && comp.get('KICADSIG') === bagsSig(s.bags) ? readJson<SList>(comp.getRaw('KICADSRC')) : null);
  if (kept) return keptSymbol(kept, name);
  const base = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  const k: K = (p) => [mm(p.x), mm(p.y)];
  const direct = (b: PropertyBag) => !b.has('OWNERINDEX') || b.int('OWNERINDEX') <= 0;
  const objs = s.bags.map((b, i) => (i > 0 ? { o: deriveObject(b, i), b } : null)).filter((x): x is { o: SchObject; b: PropertyBag } => !!x);
  const units = new Map<string, WNode[]>();
  const put = (o: SchObject, item: WNode) => {
    const mode = o.ownerDisplayMode;
    if (mode > 1) return;
    const key = `${o.ownerPartId > 0 ? o.ownerPartId : 0}_${mode + 1}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key)!.push(item);
  };
  const sys = fontOf(s.fonts, s.systemFont || 1);
  const pins = objs.filter((x): x is { o: SchObject & { kind: 'pin' }; b: PropertyBag } => x.o.kind === 'pin' && direct(x.b));
  const hideNames = pins.length > 0 && pins.every((p) => !p.o.showName);
  const hideNumbers = pins.length > 0 && pins.every((p) => !p.o.showDesignator);
  for (const { o, b } of objs) {
    if (!direct(b)) continue;
    if (o.kind === 'pin') {
      const d = DIR_VECTORS[o.orient & 3]!;
      const hot = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
      const hiddenNet = o.hidden ? b.get('HIDDENNETNAME') ?? '' : '';
      const type = hiddenNet ? 'power_in' : ELECTRICAL[o.electrical] ?? 'passive';
      const pinName = hiddenNet || kicadMarkup(o.name) || '~';
      put(o, L('pin', bare(type), bare(pinShape(o.symbols)), at(k(hot), ((o.orient + 2) % 4) * 90), L('length', mm(o.length)), o.hidden && bare('hide'),
        L('name', pinName, effects(textMm(sys.size))), L('number', o.designator || '~', effects(textMm(sys.size)))));
    } else if (o.kind === 'text' && o.role === 'label') {
      const f = fontOf(s.fonts, o.font), t = textAt(o.orient, o.justify);
      if (o.text.trim()) put(o, L('text', special(o.text), at(k(o.at), t.angle * 10), effects(textMm(f.size), { h: t.h, v: t.v, bold: f.bold, italic: f.italic })));
    } else for (const item of shapeItems(o, k)) put(o, item);
  }
  // Fields: the designator's prefix, the comment, the footprint, the parameters
  const field = (fname: string, value: string, o: SchObject | undefined, hide: boolean): WNode => {
    if (!o || o.kind !== 'text') return L('property', fname, value, at([0, 0], 0), effects(1.27, { hide: true }));
    const f = fontOf(s.fonts, o.font), fa = fieldAt(o.at, o.orient, o.justify, capU(f), [1, 0, 0, -1]);
    return L('property', fname, value, at(k(fa.p), fa.angle), effects(textMm(f.size), { h: fa.h, hide, bold: f.bold, italic: f.italic }));
  };
  const desig = objs.find((x) => x.o.kind === 'text' && x.o.role === 'designator' && direct(x.b));
  const params = objs.filter((x) => x.o.kind === 'text' && x.o.role === 'parameter' && direct(x.b) && x.b.get('NAME'));
  const comment = params.find((x) => x.b.get('NAME')!.toLowerCase() === 'comment');
  const prefix = ((desig?.o.kind === 'text' ? desig.o.text : '') || 'U').replace(/[\d?]+$/, '') || 'U';
  const impl = objs.filter((x) => x.o.record === SR.IMPLEMENTATION && x.b.get('MODELTYPE')?.toUpperCase() === 'PCBLIB');
  const fpName = (impl.find((x) => x.b.bool('ISCURRENT')) ?? impl[0])?.b.get('MODELNAME') ?? '';
  const paramText = (n: string) => params.find((x) => x.b.get('NAME')!.toLowerCase() === n.toLowerCase())?.b.get('TEXT') ?? '';
  const valueText = (() => { const c = comment?.b.get('TEXT') ?? ''; const m = /^=(.+)$/.exec(c); return m ? paramText(m[1]!) || base : c || base; })();
  const datasheet = paramText('Datasheet') || paramText('ComponentLink1URL') || paramText('HelpURL') || '~';
  const props: WNode[] = [
    field('Reference', prefix, desig?.o, !!desig?.o.hidden), field('Value', valueText, comment?.o, comment ? comment.o.hidden : true),
    L('property', 'Footprint', fpName ? `${s.footprintLib}:${kicadName(fpName)}` : '', at([0, 0], 0), effects(1.27, { hide: true })),
    L('property', 'Datasheet', datasheet, at([0, 0], 0), effects(1.27, { hide: true })),
    L('property', 'Description', comp.get('COMPONENTDESCRIPTION') ?? '', at([0, 0], 0), effects(1.27, { hide: true })),
  ];
  const taken = new Set(['reference', 'value', 'footprint', 'datasheet', 'description', 'comment']);
  for (const p of params) {
    const n = p.b.get('NAME')!;
    if (taken.has(n.toLowerCase())) continue;
    taken.add(n.toLowerCase());
    props.push(field(n, p.b.get('TEXT') ?? '', p.o, p.o.hidden));
  }
  const unitNodes = [...units].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([key, items]) => L('symbol', `${base}_${key}`, ...items));
  return L('symbol', name, hideNumbers && L('pin_numbers', bare('hide')), L('pin_names', L('offset', 0.508), hideNames && bare('hide')),
    L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')), ...props, ...unitNodes);
}

/** A KiCad symbol library (.kicad_sym) of these symbols. */
/** A symbol kept from KiCad, named `name` (its units named after it). */
function keptSymbol(src: SList, name: string): WNode {
  const was = String(src.items[0] ?? ''), base = (n: string) => (n.includes(':') ? n.slice(n.indexOf(':') + 1) : n);
  const unit = (u: SList): SList => (u.k === 'symbol' && typeof u.items[0] === 'string' && base(was) !== base(name) && u.items[0].startsWith(`${base(was)}_`)
    ? { ...u, items: [`${base(name)}${u.items[0].slice(base(was).length)}`, ...u.items.slice(1)] } : u);
  return toWNode({ ...src, items: [name, ...src.items.slice(1).map((x) => (typeof x === 'object' && 'k' in x ? unit(x) : x))] });
}

export function symbolLibraryText(symbols: WNode[]): string {
  return `${writeSexpr(L('kicad_symbol_lib', L('version', SYM_VERSION), L('generator', GENERATOR), L('generator_version', generatorVersion()), ...symbols))}\n`;
}

/* ── power symbols ── */

/** A power port's library symbol (its AD style drawn pointing up, its pin the net's name). */
function powerSymbol(name: string, net: string, style: number): WNode {
  const base = name.slice(name.indexOf(':') + 1);
  const g = powerGlyph(style);
  // Glyph frame: a along the stem (up), b across (to the left)
  const P = ([a, b]: [number, number]): [number, number] => [r4(-b * 0.0254), r4(a * 0.0254)];
  const items: WNode[] = [];
  for (const line of g.lines) items.push(L('polyline', pts(line.map(P)), stroke(0), L('fill', L('type', bare('none')))));
  for (const c of g.circles ?? []) items.push(L('circle', L('center', ...P(c.c)), L('radius', r4(c.r * 0.0254)), stroke(0), L('fill', L('type', bare('none')))));
  for (const bz of g.beziers ?? []) items.push(L('polyline', pts(bezierPts(bz).map(P)), stroke(0), L('fill', L('type', bare('none')))));
  return L('symbol', name, L('power'), L('pin_numbers', bare('hide')), L('pin_names', L('offset', 0), bare('hide')), L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')),
    L('property', 'Reference', '#PWR', at([0, -3.81], 0), effects(1.27, { hide: true })),
    L('property', 'Value', net, at([0, r4(g.labelAt * 0.0254 + 0.635)], 0), effects(1.27)),
    L('property', 'Footprint', '', at([0, 0], 0), effects(1.27, { hide: true })),
    L('property', 'Datasheet', '', at([0, 0], 0), effects(1.27, { hide: true })),
    L('property', 'Description', `Power symbol creates a global label with name "${net}"`, at([0, 0], 0), effects(1.27, { hide: true })),
    L('symbol', `${base}_0_1`, ...items),
    L('symbol', `${base}_1_1`, L('pin', bare('power_in'), bare('line'), at([0, 0], 90), L('length', 0), bare('hide'), L('name', net, effects(1.27)), L('number', '1', effects(1.27)))));
}

/** KiCad's power flag (power:PWR_FLAG): it tells ERC its net is driven, and is no net of its own. */
const PWR_FLAG_ID = 'power:PWR_FLAG';
function pwrFlagSymbol(): WNode {
  const hidden = (n: string, v: string, y = 0) => L('property', n, v, at([0, y], 0), effects(1.27, { hide: true }));
  return L('symbol', PWR_FLAG_ID, L('power'), L('pin_numbers', bare('hide')), L('pin_names', L('offset', 0), bare('hide')), L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')),
    hidden('Reference', '#FLG', 1.905), L('property', 'Value', 'PWR_FLAG', at([0, 3.81], 0), effects(1.27)), hidden('Footprint', ''), hidden('Datasheet', '~'),
    hidden('Description', 'Special symbol for telling ERC where power comes from'),
    L('symbol', 'PWR_FLAG_0_0', L('pin', bare('power_out'), bare('line'), at([0, 0], 90), L('length', 0), L('name', '~', effects(1.27)), L('number', '1', effects(1.27)))),
    L('symbol', 'PWR_FLAG_0_1', L('polyline', pts([[0, 0], [0, 1.27], [-1.016, 1.905], [0, 2.54], [1.016, 1.905], [0, 1.27]]), stroke(0), L('fill', L('type', bare('none'))))));
}

/* ── papers ── */

const PAPERS: Record<string, [number, number]> = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841], A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
};
const STYLE_PAPER = ['A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'USLetter', 'USLegal', 'USLedger', 'A', 'B', 'C', 'D', 'E'];
/** KiCad's page for an AD sheet, and where AD's sheet sits on it (centred, on the 100 mil grid). */
function pageFor(sheet: SchSheet, custom: boolean, kicadPaper = ''): { paper: WNode; k: K; w: number; h: number } {
  const w = sheet.width * UMM, h = sheet.height * UMM;
  // KiCad's own paper, while the sheet is still its size (to the 10 mil the import gave it): as it was, every place where it was
  const kp = /^(\S+) ([\d.]+) ([\d.]+)( portrait)?$/.exec(kicadPaper);
  if (kp && Math.abs(Number(kp[2]) - w) < 0.26 && Math.abs(Number(kp[3]) - h) < 0.26) {
    const W = Number(kp[2]), H = Number(kp[3]);
    const paper = kp[1] === 'User' ? L('paper', 'User', W, H) : L('paper', kp[1]!, kp[4] ? bare('portrait') : null);
    return { paper, k: (p) => [r4(p.x * UMM), r4(H - p.y * UMM)], w: W, h: H };
  }
  let name = custom ? '' : STYLE_PAPER[sheet.style] ?? '';
  let size = PAPERS[name];
  if (!size || size[0] + 0.01 < w || size[1] + 0.01 < h) { name = 'User'; size = [Math.ceil(w / 2.54) * 2.54, Math.ceil(h / 2.54) * 2.54]; }
  const ox = Math.round((size[0] - w) / 2 / 2.54) * 2.54, top = Math.round((size[1] - (size[1] - h) / 2) / 2.54) * 2.54;
  const k: K = (p) => [r4(ox + p.x * UMM), r4(top - p.y * UMM)];
  return { paper: name === 'User' ? L('paper', 'User', r4(size[0]), r4(size[1])) : L('paper', name), k, w: size[0], h: size[1] };
}

/* ── the project's sheets ── */

export interface SchExportOptions {
  project: string;
  sheets: SheetInput[];
  /** How the design's ports and net labels connect (the compile's scope). */
  scope: 'hierarchical' | 'flat' | 'global';
  /** The footprints' library nickname. */
  footprintLib: string;
  channelFormat?: string;
  channelSeparator?: string;
}
export interface SchExport {
  files: { path: string; text: string }[];
  /** Library symbols for the project's .kicad_sym (named without the library). */
  library: WNode[];
  /** A part's unique ID path (as the PCB's components carry it, upper case) → its KiCad footprint path. */
  paths: Map<string, string>;
  /** [uuid, name] of every sheet (the .kicad_pro's list). */
  sheetList: [string, string][];
  rootUuid: string;
  warnings: string[];
}

interface Inst { inst: SheetInstance; path: string; page: number }

export function exportSchematics(o: SchExportOptions): SchExport {
  const tally = new Tally();
  const lib = kicadName(o.project);
  const docs = new Map(o.sheets.map((s) => [s.name, s.doc]));
  const h = sheetHierarchy(o.sheets);
  const symUid = (s: SymbolRef) => docs.get(s.sheet)?.records[s.index + 1]?.bag?.get('UNIQUEID') || `${s.sheet}:${s.index}`;
  const sep = o.channelSeparator ?? '_';
  const all = sheetInstances(h, symUid, sep);
  const synthetic = h.roots.length !== 1;
  // KiCad's uuids where the import kept them (KICADUUID: a file's, a sheet symbol's, a symbol's …)
  const uuidLike = (v: string | undefined) => (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined);
  const headerOf = (d: SchDocument | undefined) => d?.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
  const rootUuid = (!synthetic && uuidLike(headerOf(docs.get(h.roots[0]?.sheet ?? ''))?.get('KICADUUID'))) || kuuid(`root:${o.project}`);
  const rootFile = `${o.project}.kicad_sch`;

  // Sheets the KiCad import made of one file used more than once (a sheet per use, for each use's
  // designators), still alike: written back as that one file, each use's designators in its symbols'
  // instances, as KiCad keeps them. A sheet with sheets of its own too, while each of its sheet
  // symbols leads to the same file as the first use's (its uses' sheets written as that one, first)
  const kicadFile = (d: SchDocument) => d.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag?.get('KICADFILE') ?? '';
  const partsOf = (d: SchDocument) => d.objects.filter((x): x is SchObject & { kind: 'component' } => x.kind === 'component');
  const sheetsOf = (d: SchDocument) => d.objects.filter((x): x is SchObject & { kind: 'sheetsymbol' } => x.kind === 'sheetsymbol');
  const shapeOf = (d: SchDocument) => JSON.stringify([d.objects.length, partsOf(d).map((c) => [c.libRef, c.at.x, c.at.y, c.orient, c.mirrored, c.partId]), sheetsOf(d).map((x) => [x.at.x, x.at.y, x.w, x.h])]);
  const alias = new Map<string, string>();                    // a use's sheet → the sheet written for every use
  const twin = new Map<string, Map<number, SchObject & { kind: 'component' }>>();   // a use's sheet → written part's index → its own part
  const sheetTwin = new Map<string, Map<number, number>>();   // a use's sheet → its sheet symbol's index → the written one's
  {
    const byFile = new Map<string, SheetInput[]>();
    for (const s of o.sheets) { const f = kicadFile(s.doc); if (f) byFile.set(f, [...(byFile.get(f) ?? []), s]); }
    const names = o.sheets.map((x) => x.name);
    const childOf = (d: SchDocument, sym: SchObject) => resolveSheet(names, symbolNames(d, sym.index).fileName);
    const written = (n: string | null | undefined) => (n ? alias.get(n) ?? n : null);
    // Leaves first: a sheet's uses alike once their sheets are
    for (let more = true, round = 0; more && round < 20; round++) {
      more = false;
      for (const [first, ...rest] of byFile.values()) {
        if (!first) continue;
        const shape = shapeOf(first.doc), a = partsOf(first.doc), sa = sheetsOf(first.doc);
        for (const s of rest) {
          if (alias.has(s.name) || shapeOf(s.doc) !== shape) continue;
          const sb = sheetsOf(s.doc);
          if (!sa.every((x, i) => { const p = childOf(first.doc, x), q = childOf(s.doc, sb[i]!); return !!p && written(p) === written(q); })) continue;
          const b = partsOf(s.doc);
          alias.set(s.name, first.name);
          twin.set(s.name, new Map(a.map((c, i) => [c.index, b[i]!])));
          sheetTwin.set(s.name, new Map(sb.map((x, i) => [x.index, sa[i]!.index])));
          more = true;
        }
      }
    }
  }

  // File names: the top sheet is the project's, the others by their SchDoc's name
  const fileOf = new Map<string, string>();
  const taken = new Set([rootFile.toLowerCase()]);
  if (!synthetic) fileOf.set(h.roots[0]!.sheet, rootFile);
  for (const s of o.sheets) {
    if (fileOf.has(s.name) || alias.has(s.name)) continue;
    // (a sheet read from KiCad goes back to its file, in its folder (sch/…), while that is free)
    const kf = kicadFile(s.doc);
    if (kf && /\.kicad_sch$/i.test(kf) && !kf.startsWith('../') && !taken.has(kf.toLowerCase())) { taken.add(kf.toLowerCase()); fileOf.set(s.name, kf); continue; }
    const stem = kicadName(s.name.replace(/\.schdoc$/i, ''));
    let f = `${stem}.kicad_sch`;
    for (let n = 2; taken.has(f.toLowerCase()); n++) f = `${stem}_${n}.kicad_sch`;
    taken.add(f.toLowerCase());
    fileOf.set(s.name, f);
  }
  for (const [use, written] of alias) fileOf.set(use, fileOf.get(written)!);

  // Instances: KiCad's sheet paths (a Repeat symbol's first channel only), pages in the tree's order
  // (a sheet symbol on a use written as the first: the first's)
  const asWritten = (via: SymbolRef): SymbolRef => { const t = sheetTwin.get(via.sheet)?.get(via.index); return t === undefined ? via : { ...via, sheet: alias.get(via.sheet)!, index: t }; };
  const sheetU = (via: SymbolRef) => { const w = asWritten(via); return uuidLike(docs.get(w.sheet)?.records[w.index + 1]?.bag?.get('KICADUUID')) ?? kuuid(`S:${symUid(w)}`); };
  const topU = (sheet: string) => kuuid(`top:${sheet}`);
  const insts: Inst[] = [];
  const byKey = new Map<string, Inst>();
  let page = 1;
  for (const i of all) {
    if (i.parent && !byKey.has(i.parent)) continue;
    if (i.via && REPEAT.test(i.via.designator.trim()) && i.index > 1) { tally.add(`${i.via.designator}: KiCad has no repeated sheets, channel 1 exported`); continue; }
    const path = !i.parent ? (synthetic ? `/${rootUuid}/${topU(i.sheet)}` : `/${rootUuid}`) : `${byKey.get(i.parent)!.path}/${sheetU(i.via!)}`;
    const it: Inst = { inst: i, path, page: !i.parent && !synthetic ? 1 : ++page };
    insts.push(it);
    byKey.set(i.key, it);
  }
  const instancesOf = (sheet: string) => insts.filter((x) => x.inst.sheet === sheet);

  // Library symbols: one per library reference and pin layout
  const library = new Map<string, { name: string; sig: string; node: WNode }[]>();
  const libCache = new Map<string, string>();
  const libSymbols: WNode[] = [];   // the project library's (named without the library)
  const usedIn = new Map<string, Map<string, WNode>>();   // file → lib_id → its node
  /**
   * A placed symbol's lib_id and, for a symbol read from KiCad whose copy there was changed from its
   * library's, its lib_name (KiCad names that copy Name_1 and points at it so).
   */
  const libNames = new Map<string, string>();   // doc#index → lib_name
  const libIdFor = (file: string, doc: SchDocument, ci: number): string => {
    const key = `${doc.name}#${ci}`;
    let id = libCache.get(key);
    if (!id) {
      const made = symbolOf(doc, ci);
      const sig = pinSignature(made.bags);
      let base = kicadName(made.libRef || 'Symbol');
      // A symbol read from KiCad keeps its library's name while it is the symbol it was
      const cb = doc.records[ci + 1]?.bag;
      // (and KiCad's library symbol itself, while the part's pins and drawing are what the import made)
      const kicad = cb?.has('KICADLIBKEY') && doc.cfb && cb.get('KICADLIBSIG') === partSymbolSig(made.bags) ? readJson<SList>(symbolStore(doc.cfb.root).get(cb.get('KICADLIBKEY')!)) : null;
      const keptName = cb?.get('KICADLIBNAME');
      const kept = keptName ? (keptName === made.libRef ? cb?.get('KICADLIBID') : undefined) : kicadLibId(cb?.get('KICADLIBID'), made.libRef);
      const nick = kept && kept.includes(':') ? kept.slice(0, kept.indexOf(':')) : lib;
      if (kept) base = kept.slice(kept.indexOf(':') + 1);
      if (kept && keptName) {
        // The changed copy: lib_id the library's, the schematic's copy by its own name
        id = kept;
        libNames.set(key, keptName);
        libCache.set(key, id);
        const cacheKey = `#name:${keptName}`;
        if (!usedIn.has(cacheKey)) usedIn.set(cacheKey, new Map([[keptName, libSymbol(keptName, { bags: made.bags, fonts: doc.sheet.fonts, systemFont: doc.sheet.systemFont, footprintLib: o.footprintLib, kicad })]]));
        if (!usedIn.has(file)) usedIn.set(file, new Map());
        usedIn.get(file)!.set(keptName, usedIn.get(cacheKey)!.get(keptName)!);
        return id;
      }
      const list = library.get(`${nick}:${base}`.toUpperCase()) ?? [];
      let hit = list.find((x) => x.sig === sig);
      if (!hit) {
        const name = list.length ? `${base}_${list.length + 1}` : base;
        const input: LibSymbolIn = { bags: made.bags, fonts: doc.sheet.fonts, systemFont: doc.sheet.systemFont, footprintLib: o.footprintLib, kicad };
        hit = { name, sig, node: libSymbol(`${nick}:${name}`, input) };
        list.push(hit);
        library.set(`${nick}:${base}`.toUpperCase(), list);
        // (the project's library holds the symbols that are its own; another library's are in that library)
        if (nick === lib) libSymbols.push(libSymbol(name, input));
        if (list.length > 1) tally.add(`${base}: placed with different pins, exported as more than one library symbol`);
      }
      id = `${nick}:${hit.name}`;
      libCache.set(key, id);
      if (!usedIn.has(`#${id}`)) usedIn.set(`#${id}`, new Map([[id, hit.node]]));
    }
    if (!usedIn.has(file)) usedIn.set(file, new Map());
    const ln = libNames.get(key);
    if (ln) usedIn.get(file)!.set(ln, usedIn.get(`#name:${ln}`)!.get(ln)!);
    else usedIn.get(file)!.set(id, usedIn.get(`#${id}`)!.get(id)!);
    return id;
  };
  const powerLib = new Map<string, WNode>();
  // (names of KiCad's power symbols kept: a power symbol Konium makes takes another)
  const keptPowerIds = new Set<string>();
  const powerNames = new Map<string, string>();
  const powerIdFor = (file: string, net: string, style: number): string => {
    const k = `${net}\u0000${style}`;
    let name = powerNames.get(k);
    if (!name) {
      const stem = kicadName(net) || 'PWR';
      const taken = (n: string) => [...powerNames.values()].includes(n) || keptPowerIds.has(n);
      name = taken(`power:${stem}`) ? `power:${stem}_${style}` : `power:${stem}`;
      powerNames.set(k, name);
      powerLib.set(name, powerSymbol(name, kicadNet(net), style));
    }
    if (!usedIn.has(file)) usedIn.set(file, new Map());
    usedIn.get(file)!.set(name, powerLib.get(name)!);
    return name;
  };
  let pwrN = 0, flagN = 0;

  const paths = new Map<string, string>();
  const files: { path: string; text: string }[] = [];
  const sheetList: [string, string][] = [];

  for (const s of o.sheets) {
    if (alias.has(s.name)) continue;   // (written with the sheet it is a use of)
    const file = fileOf.get(s.name)!;
    const mine = [...instancesOf(s.name), ...[...alias].filter(([, w]) => w === s.name).flatMap(([use]) => instancesOf(use))];
    if (!mine.length) { tally.add(`${s.name}: not in the hierarchy, left out`); continue; }
    const doc = s.doc;
    const isRoot = file === rootFile;
    const sheetBag = doc.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
    const pg = pageFor(doc.sheet, !!sheetBag?.bool('USECUSTOMSHEET'), sheetBag?.get('KICADPAPER') ?? '');
    const k = pg.k;
    const items: WNode[] = [];
    const u = (seed: string) => kuuid(`${file}|${seed}`);
    // An object's KiCad uuid where the import kept it (each once in a file: a wire split, its first part)
    const usedU = new Set<string>();
    // A power symbol or flag as KiCad placed it (schematic.ts: powerKept), while the port or mark is what the import made (`sig`)
    const keptPower = (x: SchObject & { at: Vec2 }, sig: string) => {
      const b = bagOf(doc, x);
      if (!b?.has('KICADLIBKEY') || b.get('KICADPWRSIG') !== sig || !doc.cfb) return null;
      const src = readJson<SList>(symbolStore(doc.cfb.root).get(b.get('KICADLIBKEY')!));
      const id = b.get('KICADLIBID'), ka = (b.get('KICADSYMAT') ?? '').split(' '), hot = (b.get('KICADHOT') ?? '').split(' ').map(Number);
      if (!src || !id || ka.length < 3 || hot.length !== 2) return null;
      // (moved as the pin's place has moved)
      const here = k(x.at), dx = here[0] - hot[0]!, dy = here[1] - hot[1]!;
      const moved = (p: SList) => toWNode(p, undefined, (px, py) => [r4(px + dx), r4(py + dy)]);
      keptPowerIds.add(id);
      return { id, node: keptSymbol(src, id), at: [r4(Number(ka[0]) + dx), r4(Number(ka[1]) + dy)] as [number, number], angle: Number(ka[2]), mirror: ka[3] || '',
        props: readJson<SList[]>(b.getRaw('KICADPROPS')) ?? [], moved, ref: b.get('KICADREF') ?? '' };
    };
    /** A kept power symbol's instance: its fields as KiCad had them, its reference KiCad's while the sheet is used once. */
    const keptPowerSymbol = (x: SchObject, pk: NonNullable<ReturnType<typeof keptPower>>, refs: string[], pinU: string) => {
      if (!usedIn.has(file)) usedIn.set(file, new Map());
      usedIn.get(file)!.set(pk.id, pk.node);
      const own = mine.length === 1 && pk.ref ? [pk.ref] : refs;
      const props = pk.props.map((p) => pk.moved(p.items[0] === 'Reference' ? { ...p, items: [p.items[0], own[0]!, ...p.items.slice(2)] } : p));
      return L('symbol', L('lib_id', pk.id), at(pk.at, pk.angle), pk.mirror ? L('mirror', bare(pk.mirror)) : null, L('unit', 1), L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')), L('dnp', bare('no')),
        L('uuid', ku(x, `p:${x.index}`)), ...props, L('pin', '1', L('uuid', pinU)),
        L('instances', L('project', o.project, ...mine.map((m, i) => L('path', m.path, L('reference', own[i] ?? refs[i]!), L('unit', 1))))));
    };
    const keptPinU = (x: SchObject) => { const v = uuidLike(bagOf(doc, x)?.get('KICADPINUUID')); if (v && !usedU.has(v)) { usedU.add(v); return v; } return undefined; };
    const ku = (x: SchObject, seed: string) => { const v = uuidLike(bagOf(doc, x)?.get('KICADUUID')); if (v && !usedU.has(v)) { usedU.add(v); return v; } return u(seed); };
    const fonts = doc.sheet.fonts;
    const owned = ownedBy(doc);
    const kids = (i: number) => owned.get(i) ?? [];
    const textOf = (i: number, rec: number) => kids(i).find((x) => x.record === rec);
    // The sheet's embedded pictures (read once)
    let files_: StoredFile[] | null = null;
    const stored = () => (files_ ??= schStorage(doc));
    // An object's settings kept from KiCad (KICADX), its fields (Intersheetrefs) moved as it was
    const keptX = (x: SchObject) => readJson<SList[]>(bagOf(doc, x)?.getRaw('KICADX'));
    const keptFont = (n: WNode, x: SchObject) => keptFontOf(n, readJson<{ size: number; h?: number; x: SList[] }>(bagOf(doc, x)?.getRaw('KICADFONT')));
    // A drawing's kept stroke and fill (and a text box's margins, effects, size), while its look in Konium is as the import made it
    const keptLook = (x: SchObject) => { const b = bagOf(doc, x); return b?.has('KICADLOOKSIG') && b.get('KICADLOOKSIG') === lookSig(b) ? readJson<SList[]>(b.getRaw('KICADX')) : null; };
    // A name as KiCad wrote it (its markup) while it is still that name here, else Konium's in KiCad's form
    const named = (x: SchObject, text: string) => { const raw = readJson<string>(bagOf(doc, x)?.get('KICADRAW')); return raw !== null && plainText(raw) === text ? raw : kicadNet(text); };

    /* Wires and buses, broken at whatever joins them */
    // (pins' ends and power ports written as power symbols; not ports, nor power ports written as global labels: KiCad's labels join a wire anywhere along it)
    const spots: Vec2[] = [];
    for (const x of doc.objects) {
      if (!isShown(doc, x)) continue;
      if (x.kind === 'pin') { const d = DIR_VECTORS[x.orient & 3]!; spots.push({ x: x.at.x + d.x * x.length, y: x.at.y + d.y * x.length }); }
      else if (x.kind === 'power' && x.text && !x.crossSheet && !bagOf(doc, x)?.get('KICADGLOBAL')) spots.push(x.at);
    }
    // (a wire at wires' corners and ends, a bus at buses': one doesn't break the other; nor a wire
    // lying along it, as KiCad has it: where a wire's corner or end is, the ways it goes from there)
    const busSpots: Vec2[] = [];
    const along = new Map<string, Vec2[]>();
    const lineAt = (pts: Vec2[], list: Vec2[]) => pts.forEach((p, i) => {
      list.push(p);
      const ways = [pts[i - 1], pts[i + 1]].filter((q): q is Vec2 => !!q).map((q) => ({ x: q.x - p.x, y: q.y - p.y }));
      const key = `${p.x},${p.y}`;
      along.set(key, [...(along.get(key) ?? []), ...ways]);
    });
    for (const x of doc.objects) {
      if (x.kind === 'wire') lineAt(x.pts, spots);
      else if (x.kind === 'bus') lineAt(x.pts, busSpots);
      else if (x.kind === 'junction') { spots.push(x.at); busSpots.push(x.at); }
      else if (x.kind === 'busentry') { spots.push(x.a, x.b); busSpots.push(x.a, x.b); }
      else if (x.kind === 'sheetentry') { const p = entryPoint(doc, x); if (p) { spots.push(p); busSpots.push(p); } }
    }
    const CELL = mil(200);
    const gridOf = (list: Vec2[]) => {
      const grid = new Map<string, Vec2[]>();
      for (const p of list) { const g = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`; const l = grid.get(g); if (l) l.push(p); else grid.set(g, [p]); }
      return grid;
    };
    const grids = { wire: gridOf(spots), bus: gridOf(busSpots) };
    // Only lines' corners and ends there, all running along this one: not a joint (a pin, a junction, a sheet pin is)
    const others = new Set<string>();
    for (const x of doc.objects) {
      if (x.kind === 'junction') others.add(`${x.at.x},${x.at.y}`);
      else if (x.kind === 'busentry') { others.add(`${x.a.x},${x.a.y}`); others.add(`${x.b.x},${x.b.y}`); }
      else if (x.kind === 'sheetentry') { const p = entryPoint(doc, x); if (p) others.add(`${p.x},${p.y}`); }
    }
    for (const p of spots) if (!along.has(`${p.x},${p.y}`)) others.add(`${p.x},${p.y}`);
    const onlyAlong = (p: Vec2, a: Vec2, b: Vec2) => {
      const key = `${p.x},${p.y}`;
      if (others.has(key)) return false;
      const ways = along.get(key);
      return !!ways && ways.every((w) => Math.abs(w.x * (b.y - a.y) - w.y * (b.x - a.x)) <= Math.hypot(w.x, w.y) * 50);
    };
    const splitAt = (a: Vec2, b: Vec2, grid: Map<string, Vec2[]>): Vec2[] => {
      const out: Vec2[] = [];
      const x0 = Math.floor(Math.min(a.x, b.x) / CELL), x1 = Math.floor(Math.max(a.x, b.x) / CELL), y0 = Math.floor(Math.min(a.y, b.y) / CELL), y1 = Math.floor(Math.max(a.y, b.y) / CELL);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1) return [];
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) for (const p of grid.get(`${gx},${gy}`) ?? []) {
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y)) continue;
        if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) continue;
        if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > len * 50) continue;
        if (onlyAlong(p, a, b)) continue;
        out.push(p);
      }
      const d = (p: Vec2) => Math.hypot(p.x - a.x, p.y - a.y);
      return [...new Map(out.map((p) => [`${p.x},${p.y}`, p])).values()].sort((p, q) => d(p) - d(q));
    };
    for (const x of doc.objects) {
      if ((x.kind !== 'wire' && x.kind !== 'bus') || x.owner >= 0) continue;
      let n = 0;
      for (let i = 1; i < x.pts.length; i++) {
        const a = x.pts[i - 1]!, b = x.pts[i]!;
        const chain = [a, ...splitAt(a, b, grids[x.kind]), b];
        for (let j = 1; j < chain.length; j++) items.push(L(x.kind, pts([k(chain[j - 1]!), k(chain[j]!)]), stroke(0), L('uuid', ku(x, `${x.index}:${n++}`))));
      }
    }
    const dots = new Map<string, Vec2>(), dotObj = new Map<string, SchObject>();
    for (const x of doc.objects) if (x.kind === 'junction') { dots.set(`${x.at.x},${x.at.y}`, x.at); dotObj.set(`${x.at.x},${x.at.y}`, x); }
    for (const j of [...kicadJunctions(doc), ...autoJunctions(doc, 'bus').map((x) => x.at)]) dots.set(`${j.x},${j.y}`, j);
    // (a junction KiCad had there: its uuid)
    for (const [key, p] of dots) { const jo = dotObj.get(key); items.push(L('junction', at(k(p)), L('diameter', 0), L('color', 0, 0, 0, 0), L('uuid', jo ? ku(jo, `j:${key}`) : u(`j:${key}`)))); }

    // Pins' ends (for No ERC markers on pins, and ports' connected ends)
    const pinEnds = new Set<string>();
    for (const x of doc.objects) if (x.kind === 'pin') { const d = DIR_VECTORS[x.orient & 3]!; pinEnds.add(`${x.at.x + d.x * x.length},${x.at.y + d.y * x.length}`); }
    const wireEnds = new Set<string>();
    for (const x of doc.objects) if (x.kind === 'wire' || x.kind === 'bus') for (const p of x.pts) wireEnds.add(`${p.x},${p.y}`);
    // (KiCad's no-connect flags sit on pins, and on wires' ends and sheet pins left open)
    const sheetPins = new Set<string>();
    for (const x of doc.objects) if (x.kind === 'sheetentry') { const p = entryPoint(doc, x); if (p) sheetPins.add(`${p.x},${p.y}`); }

    // KiCad's texts of several lines (a text a line here): whole again while all their lines are there with their words, in their places
    const multi = new Map<number, { text: string; dy: number; node: SList | null } | null>();
    {
      const groups = new Map<string, { x: SchObject & { kind: 'text' }; line: number; n: number; dy: number }[]>();
      for (const x of doc.objects) {
        if (x.kind !== 'text' || x.role !== 'label') continue;
        const m = /^(\d+):(\d+):(\d+):(-?[\d.]+(?:e-?\d+)?)$/.exec(bagOf(doc, x)?.get('KICADLINES') ?? '');
        if (m) groups.set(m[1]!, [...(groups.get(m[1]!) ?? []), { x, line: Number(m[2]), n: Number(m[3]), dy: Number(m[4]) }]);
      }
      for (const list of groups.values()) {
        list.sort((a, b) => a.line - b.line);
        const head = list.find((l) => bagOf(doc, l.x)?.get('KICADTEXT'));
        const text = head ? readJson<string>(bagOf(doc, head.x)!.get('KICADTEXT')) : null;
        const want = text === null ? [] : plainText(text).split('\n').filter((l) => l.trim());
        const a = list[0]!;
        const same = text !== null && list.length === a.n && want.length === a.n && list.every((l, i) => l.x.text === want[i] && l.x.at.x === a.x.at.x && Math.abs(l.x.at.y + l.dy - (a.x.at.y + a.dy)) <= 2
          && l.x.orient === a.x.orient && l.x.justify === a.x.justify && l.x.font === a.x.font);
        if (!same) continue;
        // (the whole text as KiCad wrote it, its font and all, while Konium's font for it is the one the import gave)
        const hb = bagOf(doc, head!.x)!;
        const node = hb.get('KICADTEXTF') === String(head!.x.font) ? readJson<SList>(hb.getRaw('KICADTEXTN')) : null;
        multi.set(a.x.index, { text: text!, dy: a.dy, node });
        for (const l of list.slice(1)) multi.set(l.x.index, null);
      }
    }

    for (const x of doc.objects) {
      // Owned by a part, a sheet symbol, a harness: written with it (a document's parameters are the title block's)
      if (x.owner >= 0 && doc.objects[x.owner]?.record !== SR.SHEET) continue;
      switch (x.kind) {
        case 'busentry': {
          const a = k(x.a), b = k(x.b);
          items.push(preferKept(L('bus_entry', at(a), L('size', r4(b[0] - a[0]), r4(b[1] - a[1])), stroke(0), L('uuid', ku(x, `be:${x.index}`))), keptLook(x), DRAW_LOOK));
          break;
        }
        case 'noerc': {
          const nb = bagOf(doc, x);
          const fk = nb?.bool('KICADPWRFLAG') ? keptPower(x, `flag:${nb.int('KICADANGLE')}`) : null;
          if (fk) { const refs = mine.map(() => `#FLG${String(++flagN).padStart(2, '0')}`); items.push(keptPowerSymbol(x, fk, refs, keptPinU(x) ?? u(`flp:${x.index}`))); break; }
          if (nb?.bool('KICADPWRFLAG')) {
            // KiCad's power flag the import made a No ERC mark of: back as the flag
            if (!usedIn.has(file)) usedIn.set(file, new Map());
            usedIn.get(file)!.set(PWR_FLAG_ID, pwrFlagSymbol());
            const refs = mine.map(() => `#FLG${String(++flagN).padStart(2, '0')}`);
            const angle = nb.int('KICADANGLE');
            items.push(L('symbol', L('lib_id', PWR_FLAG_ID), at(k(x.at), angle), L('unit', 1), L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')), L('dnp', bare('no')),
              L('uuid', ku(x, `fl:${x.index}`)),
              L('property', 'Reference', refs[0]!, at(k(x.at), 0), effects(1.27, { hide: true })),
              L('property', 'Value', 'PWR_FLAG', at(k(x.at), 0), effects(1.27)),
              L('property', 'Footprint', '', at(k(x.at), 0), effects(1.27, { hide: true })),
              L('property', 'Datasheet', '~', at(k(x.at), 0), effects(1.27, { hide: true })),
              L('pin', '1', L('uuid', keptPinU(x) ?? u(`flp:${x.index}`))),
              L('instances', L('project', o.project, ...mine.map((m, i) => L('path', m.path, L('reference', refs[i]!), L('unit', 1)))))));
            break;
          }
          const nk = `${x.at.x},${x.at.y}`;
          if (pinEnds.has(nk) || wireEnds.has(nk) || sheetPins.has(nk)) items.push(L('no_connect', at(k(x.at)), L('uuid', ku(x, `nc:${x.index}`))));
          else tally.add('No ERC markers off pins, wire ends and sheet pins left out (KiCad\'s no-connect flags are for those)');
          break;
        }
        case 'text': {
          const f = fontOf(fonts, x.font);
          if (x.role === 'netlabel' && bagOf(doc, x)?.bool('KICADJOIN')) {
            // The net label the KiCad import set beside a hierarchical label: KiCad joins them by name itself
          } else if (x.role === 'netlabel') {
            const a = (x.orient & 3) * 90;
            const global = o.scope === 'global';
            const j = a >= 180 ? 2 : 0;
            if (global) items.push(withExtras(keptFont(L('global_label', named(x, x.text), L('shape', bare('passive')), at(k(x.at), a), L('fields_autoplaced', bare('yes')), effects(textMm(f.size), { h: j }), L('uuid', ku(x, `gl:${x.index}`))), x), keptX(x)));
            else items.push(withExtras(keptFont(L('label', named(x, x.text), at(k(x.at), a), L('fields_autoplaced', bare('yes')), effects(textMm(f.size), { h: j, v: 0, bold: f.bold, italic: f.italic }), L('uuid', ku(x, `l:${x.index}`))), x), keptX(x)));
          } else if (x.role === 'label' && x.text.trim()) {
            const t = textAt(x.orient, x.justify);
            // A line of a KiCad text of several: the text whole, as KiCad had it, at the first of its lines there; the others with it
            const whole = multi.get(x.index);
            if (whole === null) break;
            const anchor = whole ? { x: x.at.x, y: x.at.y + whole.dy } : x.at;
            const ka = whole?.node ? kidOf(whole.node, 'at') : null;
            if (whole?.node && ka) {
              const [ax, ay] = k(anchor);
              items.push(toWNode(whole.node, ku(x, `t:${x.index}`), (px, py) => [r4(px + ax - Number(ka.items[0])), r4(py + ay - Number(ka.items[1]))]));
              break;
            }
            items.push(L('text', whole ? whole.text : special(x.text), L('exclude_from_sim', bare('no')), at(k(anchor), t.angle), effects(textMm(f.size), { h: t.h, v: t.v, bold: f.bold, italic: f.italic }), L('uuid', ku(x, `t:${x.index}`))));
          }
          break;
        }
        case 'textframe': {
          if (!x.text.trim()) break;
          const f = fontOf(fonts, x.font);
          const tl = k({ x: Math.min(x.a.x, x.b.x), y: Math.max(x.a.y, x.b.y) }), br = k({ x: Math.max(x.a.x, x.b.x), y: Math.min(x.a.y, x.b.y) });
          // KiCad's text box as it was (its words, margins, effects, exact size, stroke and fill) while Konium's frame is as the import made it
          const look = keptLook(x);
          const kt = look ? readJson<string>(bagOf(doc, x)?.get('KICADTEXT')) : null;
          if (look && kt !== null && plainText(kt).replace(/\n/g, '\n') === x.text) {
            const ks = look.find((y) => y.k === 'size');
            // (KiCad's exact size; one drawn from its other corner, a negative size, from that corner again)
            const sx = Number(ks?.items[0]), sy = Number(ks?.items[1]);
            const exact = !!ks && Math.abs(Math.abs(sx) - (br[0] - tl[0])) < 0.26 && Math.abs(Math.abs(sy) - (br[1] - tl[1])) < 0.26;
            const size = exact ? toWNode(ks!) : L('size', r4(br[0] - tl[0]), r4(br[1] - tl[1]));
            const from: [number, number] = exact ? [r4(sx < 0 ? tl[0] - sx : tl[0]), r4(sy < 0 ? tl[1] - sy : tl[1])] : tl;
            items.push(preferKept(L('text_box', kt, L('exclude_from_sim', bare('no')), at(from, 0), size, stroke(0), fillOf(x.solid, x.fill, -1), effects(textMm(f.size), { h: 0, v: 2 }), L('uuid', ku(x, `tb:${x.index}`))),
              look, TEXTBOX_LOOK));
            const m = look.find((y) => y.k === 'margins');
            if (m) items[items.length - 1]!.items.splice(4, 0, toWNode(m));
            break;
          }
          if (x.border || x.solid) {
            items.push(L('text_box', kicadMarkup(x.text), L('exclude_from_sim', bare('no')), at(tl, 0), L('size', r4(br[0] - tl[0]), r4(br[1] - tl[1])),
              stroke(0), fillOf(x.solid, x.fill, -1), effects(textMm(f.size), { h: x.align === 1 ? 1 : x.align === 2 ? 2 : 0, v: 2 }), L('uuid', ku(x, `tb:${x.index}`))));
          } else {
            const m = mm(x.margin || mil(20));
            items.push(L('text', kicadMarkup(x.text), L('exclude_from_sim', bare('no')), at([r4(tl[0] + m), r4(tl[1] + m)], 0), effects(textMm(f.size), { h: 0, v: 2 }), L('uuid', ku(x, `tf:${x.index}`))));
          }
          break;
        }
        case 'polyline': case 'polygon': case 'rect': case 'ellipse': case 'arc': case 'bezier': case 'piechart': {
          // (KiCad's stroke and fill kept while Konium's look for it is as the import made it)
          const look = keptLook(x);
          // (a rectangle KiCad had drawn from another corner: from that one again)
          const from = x.kind === 'rect' ? bagOf(doc, x)?.get('KICADFROM') ?? '' : '';
          const corner = (it: WNode): WNode => {
            if (!from || it.k !== 'rectangle') return it;
            const st = it.items.find((y): y is WNode => typeof y === 'object' && 'k' in y && y.k === 'start')!, en = it.items.find((y): y is WNode => typeof y === 'object' && 'k' in y && y.k === 'end')!;
            const [sx, sy] = st.items as number[], [ex, ey] = en.items as number[];
            st.items = [from.includes('x') ? ex! : sx!, from.includes('y') ? ey! : sy!]; en.items = [from.includes('x') ? sx! : ex!, from.includes('y') ? sy! : ey!];
            return it;
          };
          for (const it of shapeItems(x, k)) items.push(withUuid(corner(look ? preferKept(it, look, DRAW_LOOK) : it), ku(x, `g:${x.index}:${items.length}`)));
          break;
        }
        case 'power': {
          const f = fontOf(fonts, x.font || doc.sheet.systemFont);
          const gb = bagOf(doc, x);
          if (gb?.get('KICADGLOBAL') && x.text) {
            // KiCad's global label the import made a power port of: back as the label, its shape and angle
            const a = gb.int('KICADANGLE');
            items.push(withExtras(keptFont(L('global_label', named(x, x.text), L('shape', bare(gb.get('KICADGLOBAL')!)), at(k(x.at), a), L('fields_autoplaced', bare('yes')), effects(textMm(f.size), { h: a >= 180 ? 2 : 0 }), L('uuid', ku(x, `g:${x.index}`))), x), keptX(x)));
            break;
          }
          if (x.crossSheet || !x.text) {
            if (!x.text) break;
            const a = [180, 270, 0, 90][x.orient & 3]!;
            items.push(L('global_label', kicadNet(x.text), L('shape', bare('passive')), at(k(x.at), a), L('fields_autoplaced', bare('yes')), effects(textMm(f.size), { h: a >= 180 ? 2 : 0 }), L('uuid', ku(x, `cs:${x.index}`))));
            break;
          }
          const pk = keptPower(x, `${x.style}:${x.orient}:${x.text}`);
          if (pk) { const refs = mine.map(() => `#PWR${String(++pwrN).padStart(3, '0')}`); items.push(keptPowerSymbol(x, pk, refs, keptPinU(x) ?? u(`pp:${x.index}`))); break; }
          const id = powerIdFor(file, x.text, x.style);
          const angle = [270, 0, 90, 180][x.orient & 3]!;
          const t = symbolTransform(angle);
          const g = powerGlyph(x.style), d = DIR_VECTORS[x.orient & 3]!;
          const lp = { x: x.at.x + d.x * mil(g.labelAt), y: x.at.y + d.y * mil(g.labelAt) };
          const vertical = (x.orient & 1) === 1;
          const just = (vertical ? 1 : x.orient === 0 ? 0 : 2) + 3 * (vertical ? (x.orient === 1 ? 0 : 2) : 1);
          const fa = fieldAt(lp, 0, just, capU(f), t);
          const refs = mine.map(() => `#PWR${String(++pwrN).padStart(3, '0')}`);
          items.push(L('symbol', L('lib_id', id), at(k(x.at), angle), L('unit', 1), L('exclude_from_sim', bare('no')), L('in_bom', bare('yes')), L('on_board', bare('yes')), L('dnp', bare('no')),
            L('uuid', ku(x, `p:${x.index}`)),
            L('property', 'Reference', refs[0]!, at(k(x.at), 0), effects(1.27, { hide: true })),
            L('property', 'Value', kicadNet(x.text), at(k(fa.p), fa.angle), effects(textMm(f.size), { h: fa.h, hide: !x.showText, bold: f.bold, italic: f.italic })),
            L('property', 'Footprint', '', at(k(x.at), 0), effects(1.27, { hide: true })),
            L('property', 'Datasheet', '', at(k(x.at), 0), effects(1.27, { hide: true })),
            L('property', 'Description', '', at(k(x.at), 0), effects(1.27, { hide: true })),
            L('pin', '1', L('uuid', keptPinU(x) ?? u(`pp:${x.index}`))),
            L('instances', L('project', o.project, ...mine.map((m, i) => L('path', m.path, L('reference', refs[i]!), L('unit', 1)))))));
          break;
        }
        case 'port': {
          const f = fontOf(fonts, x.font || doc.sheet.systemFont);
          const vertical = x.style >= 4;
          const endB = vertical ? { x: x.at.x, y: x.at.y + x.width } : { x: x.at.x + x.width, y: x.at.y };
          const joined = (p: Vec2) => wireEnds.has(`${p.x},${p.y}`) || pinEnds.has(`${p.x},${p.y}`);
          // KiCad's label: the end its angle says (still lying the way it did); else the end that is joined
          const ka = bagOf(doc, x)?.get('KICADANGLE');
          const kept = ka !== undefined && (Number(ka) === 90 || Number(ka) === 270) === vertical ? Number(ka) : null;
          const useB = kept !== null ? kept >= 180 : joined(endB) && !joined(x.at);
          const p = useB ? endB : x.at;
          const a = vertical ? (useB ? 270 : 90) : (useB ? 180 : 0);
          // (KiCad's tri-state, bidirectional in Konium, while it still is)
          const shape = x.io === 3 && bagOf(doc, x)?.get('KICADSHAPE') === 'tri_state' ? 'tri_state' : ['passive', 'output', 'input', 'bidirectional'][x.io] ?? 'passive';
          const hier = o.scope === 'hierarchical';
          items.push(withExtras(keptFont(L(hier ? 'hierarchical_label' : 'global_label', named(x, x.name), L('shape', bare(shape)), at(k(p), a), !hier && L('fields_autoplaced', bare('yes')),
            effects(textMm(f.size), { h: a >= 180 ? 2 : 0 }), L('uuid', ku(x, `port:${x.index}`))), x), keptX(x)));
          break;
        }
        case 'component': writePart(x); break;
        case 'sheetsymbol': writeSheet(x); break;
        case 'image': {
          // An embedded PNG: KiCad's picture, as large as the frame (its scale from its pixels and resolution; KiCad's own scale while it comes to the same size)
          const f = x.embedded ? storedFile(stored(), x.file) : undefined;
          let bytes: Uint8Array | null = null;
          try { bytes = f ? storedBytes(f) : null; } catch { bytes = null; }
          const png = bytes ? pngInfo(bytes) : null;
          if (!bytes || !png) { tally.add('Pictures left out (KiCad embeds PNG: linked pictures and other kinds stay out)'); break; }
          const [x0, y0] = k(x.a), [x1, y1] = k(x.b);
          const natural = (png.w / png.ppi) * 25.4;
          const kept = Number(bagOf(doc, x)?.get('KICADSCALE') ?? NaN);
          const scale = Number.isFinite(kept) && Math.abs(natural * kept - Math.abs(x1 - x0)) < 0.3 ? kept : r4(Math.abs(x1 - x0) / natural);
          const b64 = base64Of(bytes);
          items.push(L('image', at([r4((x0 + x1) / 2), r4((y0 + y1) / 2)]), L('scale', scale), L('uuid', ku(x, `img:${x.index}`)),
            L('data', ...Array.from({ length: Math.ceil(b64.length / 76) }, (_, i) => b64.slice(i * 76, (i + 1) * 76)))));
          break;
        }
        case 'harness': case 'signalharness': tally.add('Harnesses left out (KiCad has none)'); break;
        case 'directive': {
          // KiCad's net class flag read from it: back as it was, moved with the directive
          const kn = readJson<SList>(bagOf(doc, x)?.getRaw('KICADNODE'));
          const ka = kn ? kidOf(kn, 'at') : undefined;
          if (kn && ka) {
            const [px, py] = k(x.at);
            items.push(toWNode(kn, ku(x, `nc:${x.index}`), (qx, qy) => [r4(qx + px - Number(ka.items[0])), r4(qy + py - Number(ka.items[1]))]));
            break;
          }
          // A Parameter Set naming a net class (a Netclass or ClassName parameter): KiCad's net class flag
          const cls = kids(x.index).find((p) => p.kind === 'text' && p.role === 'parameter' && /^(netclass|classname|net class)$/i.test(bagOf(doc, p)?.get('NAME') ?? ''));
          if (cls?.kind === 'text') {
            const [px, py] = k(x.at);
            items.push(L('netclass_flag', '', L('length', 2.54), L('shape', bare('round')), at([px, py], 0), L('fields_autoplaced', bare('yes')), effects(1.27, { h: 0, v: 2 }), L('uuid', ku(x, `nc:${x.index}`)),
              L('property', 'Netclass', cls.text, at([px, r4(py - 3.81)], 0), effects(1.27, { h: 0, v: 2 }))));
            break;
          }
          tally.add('Directives left out (but net class ones)');
          break;
        }
        case 'compilemask': case 'blanket': tally.add('Directives left out'); break;
        case 'ieee': tally.add('IEEE symbols left out'); break;
        default: break;
      }
    }

    function writePart(c: SchObject & { kind: 'component' }): void {
      const cb = bagOf(doc, c);
      const id = libIdFor(file, doc, c.index);
      const tf = kicadTransform(c.orient, c.mirrored);
      const t = symbolTransform(tf.angle, tf.mirror);
      const mineKids = kids(c.index);
      const uid = cb?.get('UNIQUEID') || `${s.name}:${c.index}`;
      const symU = uuidLike(cb?.get('KICADUUID')) ?? kuuid(`C:${uid}`);
      const kind = cb ? componentKind(cb) : 0;
      const inBom = ![2, 4, 5].includes(kind) || (kind === 2 && !!cb?.bool('KICADINBOM')), onBoard = kind !== 2;
      const field = (fname: string, value: string, tx: SchObject | undefined): WNode => {
        if (!tx || tx.kind !== 'text') return L('property', fname, value, at(k(c.at), 0), effects(1.27, { hide: true }));
        const f = fontOf(fonts, tx.font);
        const fa = fieldAt(tx.at, tx.orient, tx.justify, capU(f), t);
        return L('property', fname, value, at(k(fa.p), fa.angle), effects(textMm(f.size), { h: fa.h, hide: tx.hidden, bold: f.bold, italic: f.italic }));
      };
      const params = mineKids.filter((x) => x.kind === 'text' && x.role === 'parameter');
      const pname = (x: SchObject) => bagOf(doc, x)?.get('NAME') ?? '';
      const param = (n: string) => params.find((x) => pname(x).toLowerCase() === n.toLowerCase());
      const ptext = (n: string) => { const x = param(n); return x?.kind === 'text' ? x.text : ''; };
      const desig = mineKids.find((x) => x.kind === 'text' && x.role === 'designator');
      const comment = param('Comment');
      const commentText = (() => { const v = comment?.kind === 'text' ? comment.text : ''; const m = /^=(.+)$/.exec(v); return m ? ptext(m[1]!) || c.libRef : v || c.libRef; })();
      // The footprint: the current PCB model
      let fp = '';
      for (const list of mineKids.filter((x) => x.record === SR.IMPLEMENTATION_LIST)) for (const im of kids(list.index).filter((x) => x.record === SR.IMPLEMENTATION)) {
        const ib = bagOf(doc, im);
        if (ib?.get('MODELTYPE')?.toUpperCase() !== 'PCBLIB') continue;
        if (!fp || ib.bool('ISCURRENT')) fp = ib.get('MODELNAME') ?? fp;
      }
      const props: WNode[] = [
        field('Reference', c.designator || 'U?', desig), field('Value', kicadMarkup(commentText), comment),
        L('property', 'Footprint', fp ? kicadLibId(cb?.get('KICADFOOTPRINT'), kicadName(fp)) ?? `${o.footprintLib}:${kicadName(fp)}` : '', at(k(c.at), 0), effects(1.27, { hide: true })),
        L('property', 'Datasheet', ptext('Datasheet') || ptext('ComponentLink1URL') || ptext('HelpURL') || '~', at(k(c.at), 0), effects(1.27, { hide: true })),
        L('property', 'Description', cb?.get('COMPONENTDESCRIPTION') ?? '', at(k(c.at), 0), effects(1.27, { hide: true })),
      ];
      const seen = new Set(['reference', 'value', 'footprint', 'datasheet', 'description', 'comment']);
      for (const p of params) {
        const n = pname(p);
        if (!n || seen.has(n.toLowerCase()) || p.kind !== 'text') continue;
        seen.add(n.toLowerCase());
        props.push(field(n, special(p.text), p));
      }
      // (a use of this sheet that was a sheet of its own: its part's designator and unique ID)
      const partIn = (m: Inst) => twin.get(m.inst.sheet)?.get(c.index);
      const des = (m: Inst) => partIn(m)?.designator || (m.inst.rooms.length ? channelDesignator(o.channelFormat ?? '', c.designator, m.inst, sep) : c.designator) || 'U?';
      for (const m of mine) {
        const own = partIn(m);
        const ownUid = own ? docs.get(m.inst.sheet)?.records[own.index + 1]?.bag?.get('UNIQUEID') || uid : uid;
        const adPath = (m.inst.uids.length ? [...m.inst.uids, ownUid] : [ownUid]).join('\\').toUpperCase();
        if (!paths.has(adPath)) paths.set(adPath, `${m.path.slice(rootUuid.length + 1)}/${symU}`);
      }
      const libName = libNames.get(`${doc.name}#${c.index}`);
      // A symbol read from KiCad: turned and mirrored as KiCad wrote it (where it comes to the same), its fields as KiCad had them
      // (moved with it) while their values are still Konium's, the fields Konium has nothing of (empty ones, simulation's) too
      const ka = (cb?.get('KICADSYMAT') ?? '').split(' ');
      const kAt = ka.length >= 3 ? { x: Number(ka[0]), y: Number(ka[1]), a: Number(ka[2]), mirror: ka[3] ?? '' } : null;
      const here = k(c.at);
      const sameTurn = !!kAt && symbolTransform(kAt.a, kAt.mirror || undefined).every((v, i) => v === symbolTransform(tf.angle, tf.mirror || undefined)[i]);
      const angle = sameTurn ? kAt!.a : tf.angle, mirror = sameTurn ? kAt!.mirror : tf.mirror;
      const keptProps = sameTurn ? readJson<SList[]>(cb?.get('KICADPROPS')) ?? [] : [];
      const moved = (p: SList) => toWNode(p, undefined, (x, y) => [r4(x + here[0] - kAt!.x), r4(y + here[1] - kAt!.y)]);
      const blank = (v: string) => v.trim() === '' || v === '~';
      const alike = (a: string, b: string) => a === b || plainText(a) === plainText(b) || (blank(a) && blank(b));
      // (a sheet used more than once: KiCad's Reference field names one of its uses' designators)
      const uses = new Set(mine.map(des));
      const fields = props.map((p) => {
        const name = String(p.items[0] ?? ''), kp = keptProps.find((x) => x.items[0] === name);
        // (a parameter's words as Konium has them, too: KiCad's text is that text, its backslashes no overbars)
        const own = param(name);
        return kp && (alike(String(kp.items[1] ?? ''), String(p.items[1] ?? '')) || (own?.kind === 'text' && own.text === String(kp.items[1] ?? ''))
          || (name === 'Reference' && uses.size > 1 && uses.has(String(kp.items[1] ?? '')))) ? moved(kp) : p;
      });
      const written = new Set(fields.map((p) => String(p.items[0] ?? '')));
      for (const kp of keptProps) if (!written.has(String(kp.items[0] ?? ''))) { written.add(String(kp.items[0] ?? '')); fields.push(moved(kp)); }
      // (its pins as KiCad listed them, those it still has: their uuids, an alternate function chosen)
      const pinNums = new Set(mineKids.filter((x) => x.kind === 'pin').map((x) => (x.kind === 'pin' ? x.designator : '')));
      const keptPins = (readJson<SList[]>(cb?.getRaw('KICADPINS')) ?? []).filter((p) => pinNums.has(String(p.items[0] ?? ''))).map((p) => toWNode(p));
      // (KiCad's DNP and simulation settings kept: Konium has neither)
      const symX = readJson<SList[]>(cb?.get('KICADSYMX')) ?? [];
      const keptFlag = (n: string, dflt: string) => { const x = symX.find((y) => y.k === n); return x ? toWNode(x) : L(n, bare(dflt)); };
      items.push(withExtras(L('symbol', libName ? L('lib_name', libName) : null, L('lib_id', id), at(here, angle), mirror ? L('mirror', bare(mirror)) : null, L('unit', Math.max(1, c.partId)),
        keptFlag('exclude_from_sim', 'no'), L('in_bom', yes(inBom)), L('on_board', yes(onBoard)), keptFlag('dnp', 'no'), L('uuid', symU), ...fields, ...keptPins,
        L('instances', L('project', o.project, ...mine.map((m) => L('path', m.path, L('reference', des(m)), L('unit', Math.max(1, c.partId))))))), symX));
    }

    function writeSheet(sym: SchObject & { kind: 'sheetsymbol' }): void {
      const names = symbolNames(doc, sym.index);
      const via: SymbolRef = { sheet: s.name, index: sym.index, ...names };
      const child = resolveSheet(o.sheets.map((x) => x.name), names.fileName);
      // (as KiCad names it: from this sheet's folder)
      const childFile = child ? relFile(file, fileOf.get(child)!) : `${kicadName(names.fileName.replace(/\.schdoc$/i, '') || 'Sheet')}.kicad_sch`;
      if (!child) tally.add(`${names.fileName || names.designator}: the sheet isn't in the project, its sheet symbol points at a missing file`);
      const tl = k(sym.at), br = k({ x: sym.at.x + sym.w, y: sym.at.y - sym.h });
      const nameT = textOf(sym.index, SR.SHEET_NAME), fileT = textOf(sym.index, SR.FILE_NAME);
      const fprop = (fname: string, value: string, tx: SchObject | undefined, dy: number) => {
        if (!tx || tx.kind !== 'text') return L('property', fname, value, at([tl[0], r4(tl[1] + dy)], 0), effects(1.27, { h: 0, v: dy < 0 ? 0 : 2 }));
        const f = fontOf(fonts, tx.font), tt = textAt(tx.orient, tx.justify);
        return L('property', fname, value, at(k(tx.at), tt.angle), effects(textMm(f.size), { h: tt.h, v: tt.v, hide: tx.hidden }));
      };
      const pins: WNode[] = [];
      for (const e of kids(sym.index)) {
        if (e.kind !== 'sheetentry') continue;
        const p = entryPoint(doc, e);
        if (!p) continue;
        const f = fontOf(fonts, e.font || doc.sheet.systemFont);
        const a = [180, 0, 90, 270][e.side] ?? 180;
        const shape = e.io === 3 && bagOf(doc, e)?.get('KICADSHAPE') === 'tri_state' ? 'tri_state' : ['passive', 'output', 'input', 'bidirectional'][e.io] ?? 'passive';
        pins.push(L('pin', named(e, e.name), bare(shape), at(k(p), a), effects(textMm(f.size), { h: e.side === 1 || e.side === 2 ? 2 : 0 }), L('uuid', ku(e, `se:${e.index}`))));
      }
      // Each instance of this sheet places one instance of the child: its page
      const childPages = mine.map((m) => {
        const ci = insts.find((x) => { if (x.inst.parent !== m.inst.key || !x.inst.via) return false; const w = asWritten(x.inst.via); return w.sheet === via.sheet && w.index === via.index; });
        return { path: m.path, page: ci?.page };
      });
      const symU = sheetU(via);
      // A sheet symbol read from KiCad: its exact size while Konium's is still the one the import gave, its stroke, fill and flags,
      // its fields as placed (moved with it) while they say the same
      const sb = bagOf(doc, sym);
      const kx = readJson<SList[]>(sb?.getRaw('KICADX')) ?? [];
      const ks = (sb?.get('KICADSHEETAT') ?? '').split(' ').map(Number);
      const keptSize = ks.length === 4 && sb?.int('XSIZE') === ks[2] && sb?.int('YSIZE') === ks[3] ? kx.find((x) => x.k === 'size') : undefined;
      const shift = (x: number, y: number): [number, number] => (ks.length === 4 ? [r4(x + tl[0] - ks[0]!), r4(y + tl[1] - ks[1]!)] : [x, y]);
      const keptProp = (n: string, v: string) => { const kp = kx.find((x) => x.k === 'property' && x.items[0] === n); return kp && String(kp.items[1] ?? '') === v ? toWNode(kp, undefined, shift) : null; };
      items.push(withExtras(preferKept(L('sheet', at(tl), keptSize ? toWNode(keptSize) : L('size', r4(br[0] - tl[0]), r4(br[1] - tl[1])), L('fields_autoplaced', bare('yes')), stroke(0.1524, 'solid'), L('fill', L('color', 0, 0, 0, 0)), L('uuid', symU),
        keptProp('Sheetname', names.designator || 'Sheet') ?? fprop('Sheetname', names.designator || 'Sheet', nameT, -0.7112), keptProp('Sheetfile', childFile) ?? fprop('Sheetfile', childFile, fileT, 0.5842), ...pins,
        L('instances', L('project', o.project, ...childPages.map((cp) => L('path', cp.path, L('page', String(cp.page ?? 0))))))), kx, SHEET_LOOK),
        kx.filter((x) => x.k !== 'size' && !(x.k === 'property' && (x.items[0] === 'Sheetname' || x.items[0] === 'Sheetfile' || x.items[0] === 'Sheet name' || x.items[0] === 'Sheet file'))), shift));
      sheetList.push([symU, names.designator || 'Sheet']);
    }

    // Title block from the sheet's parameters
    const params = parametersOf(doc, 'document');
    const pv = (n: string) => { const v = params.get(n) ?? ''; return v === '*' ? '' : v; };
    const opt = (v: string, n: WNode) => (v ? n : null);
    const company = pv('COMPANYNAME') || pv('ORGANIZATION');
    const tb = L('title_block', opt(pv('TITLE'), L('title', pv('TITLE'))), opt(pv('DATE'), L('date', pv('DATE'))), opt(pv('REVISION'), L('rev', pv('REVISION'))),
      opt(company, L('company', company)), ...['DRAWNBY', 'CHECKEDBY', 'APPROVEDBY', 'DOCUMENTNUMBER'].map((n, i) => opt(pv(n), L('comment', i + 1, pv(n)))));
    const libs = [...(usedIn.get(file)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b)).map(([, n]) => n);
    const tree = L('kicad_sch', L('version', SCH_VERSION), L('generator', GENERATOR), L('generator_version', generatorVersion()),
      L('uuid', isRoot ? rootUuid : uuidLike(sheetBag?.get('KICADUUID')) ?? kuuid(`file:${file}`)), pg.paper, tb.items.length ? tb : null, L('lib_symbols', ...libs), ...items,
      isRoot && L('sheet_instances', L('path', '/', L('page', '1'))));
    files.push({ path: file, text: `${writeSexpr(tree)}\n` });
  }

  // Several top sheets: a root holding them
  if (synthetic && o.sheets.length) {
    const tops = h.roots.map((r) => r.sheet).filter((n) => insts.some((x) => x.inst.sheet === n));
    const cols = 4, w = 50.8, hh = 25.4, gapX = 63.5, gapY = 45.72;
    const rows = Math.ceil(tops.length / cols);
    const paper = rows <= 3 ? 'A4' : rows <= 5 ? 'A3' : 'A2';
    const items = tops.map((n, i) => {
      const x = 25.4 + (i % cols) * gapX, y = 25.4 + Math.floor(i / cols) * gapY;
      const inst = insts.find((m) => m.inst.sheet === n && !m.inst.parent)!;
      sheetList.push([topU(n), n.replace(/\.schdoc$/i, '')]);
      return L('sheet', at([r4(x), r4(y)]), L('size', w, hh), L('fields_autoplaced', bare('yes')), stroke(0.1524, 'solid'), L('fill', L('color', 0, 0, 0, 0)), L('uuid', topU(n)),
        L('property', 'Sheetname', n.replace(/\.schdoc$/i, ''), at([r4(x), r4(y - 0.7112)], 0), effects(1.27, { h: 0, v: 0 })),
        L('property', 'Sheetfile', fileOf.get(n)!, at([r4(x), r4(y + hh + 0.5842)], 0), effects(1.27, { h: 0, v: 2 })),
        L('instances', L('project', o.project, L('path', `/${rootUuid}`, L('page', String(inst.page))))));
    });
    const tree = L('kicad_sch', L('version', SCH_VERSION), L('generator', GENERATOR), L('generator_version', generatorVersion()), L('uuid', rootUuid), L('paper', paper),
      L('title_block', L('title', o.project)), L('lib_symbols'), ...items, L('sheet_instances', L('path', '/', L('page', '1'))));
    files.unshift({ path: rootFile, text: `${writeSexpr(tree)}\n` });
  }
  sheetList.unshift([rootUuid, 'Root']);
  return { files, library: libSymbols, paths, sheetList, rootUuid, warnings: tally.lines() };
}

/** A drawing's look KiCad's own takes the place of; a text box's. */
const DRAW_LOOK = new Set(['stroke', 'fill']);
const TEXTBOX_LOOK = new Set(['stroke', 'fill', 'effects']);
/** A sheet symbol's look KiCad's own takes the place of. */
const SHEET_LOOK = new Set(['stroke', 'fill', 'fields_autoplaced']);

/** A file's path from another's folder (sch/a.kicad_sch from sch/b.kicad_sch: a.kicad_sch; from the root: sch/a.kicad_sch). */
function relFile(from: string, to: string): string {
  const a = from.split('/').slice(0, -1), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Bytes as base64. */
function base64Of(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A UUID added to a drawn item. */
function withUuid(n: WNode, id: string): WNode { return { k: n.k, items: [...n.items, L('uuid', id)] }; }

/** KiCad's angle and mirror for AD's ORIENTATION and ISMIRRORED (the same placement). */
export function kicadTransform(orient: number, mirrored: boolean): { angle: number; mirror?: 'x' | 'y' } {
  for (const mirror of mirrored ? (['y', 'x'] as const) : ([undefined] as const)) {
    for (const angle of [0, 90, 180, 270]) {
      const ad = adOrientation(symbolTransform(angle, mirror));
      if (ad.orient === (orient & 3) && ad.mirrored === mirrored) return { angle, mirror };
    }
  }
  return { angle: 0 };
}

/**
 * Where KiCad has a junction on wires (as its IsExplicitJunctionNeeded has it): three or more ways
 * out of a point, each wire's direction from it one (a wire through it two, where something else
 * ends there), each part, power symbol or sheet joined there one (a part's pins stacked on one point
 * count once); labels (ports, power ports written as global labels) count none, and a bus entry there needs none. AD's automatic junctions count
 * each pin and port.
 */
export function kicadJunctions(doc: SchDocument): Vec2[] {
  const wires = doc.objects.filter((o): o is SchObject & { kind: 'wire'; pts: Vec2[] } => o.kind === 'wire' && isShown(doc, o) && o.pts.length >= 2);
  const key = (p: Vec2) => `${p.x},${p.y}`;
  const CELL = mil(200);
  const grid = new Map<string, [Vec2, Vec2][]>();
  for (const w of wires) for (let i = 1; i < w.pts.length; i++) {
    const a = w.pts[i - 1]!, b = w.pts[i]!;
    for (let gx = Math.floor(Math.min(a.x, b.x) / CELL); gx <= Math.floor(Math.max(a.x, b.x) / CELL); gx++)
      for (let gy = Math.floor(Math.min(a.y, b.y) / CELL); gy <= Math.floor(Math.max(a.y, b.y) / CELL); gy++) {
        const k = `${gx},${gy}`, l = grid.get(k);
        if (l) l.push([a, b]); else grid.set(k, [[a, b]]);
      }
  }
  // What joins wires at a point: parts (once each), power ports, sheets; bus entries
  const joined = new Map<string, Set<string>>(), entries = new Set<string>(), at = new Map<string, Vec2>();
  const join = (p: Vec2, who: string) => { const k = key(p); at.set(k, p); const s = joined.get(k); if (s) s.add(who); else joined.set(k, new Set([who])); };
  for (const o of doc.objects) {
    if (!isShown(doc, o)) continue;
    if (o.kind === 'pin') { const d = DIR_VECTORS[o.orient & 3]!; join({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length }, `c${o.owner}`); }
    else if (o.kind === 'power' && o.text && !o.crossSheet && !bagOf(doc, o)?.get('KICADGLOBAL')) join(o.at, `p${o.index}`);   // (as a power symbol, not a label)
    else if (o.kind === 'sheetentry') { const p = entryPoint(doc, o); if (p) join(p, `s${o.owner}`); }
    else if (o.kind === 'busentry') { entries.add(key(o.a)); entries.add(key(o.b)); }
  }
  for (const w of wires) for (const p of [w.pts[0]!, w.pts[w.pts.length - 1]!]) at.set(key(p), p);
  const out: Vec2[] = [];
  for (const [k, p] of at) {
    if (entries.has(k)) continue;
    const ways = new Set<string>();
    const mids: [Vec2, Vec2][] = [];
    let ends = false;
    const dir = (q: Vec2) => String(Math.round(Math.atan2(q.y - p.y, q.x - p.x) * 1000));
    for (const [a, b] of grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? []) {
      if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) continue;
      if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > Math.hypot(b.x - a.x, b.y - a.y) * 50) continue;
      if (key(a) === k) { ways.add(dir(b)); ends = true; } else if (key(b) === k) { ways.add(dir(a)); ends = true; } else mids.push([a, b]);
    }
    const parts = joined.get(k);
    for (const w of parts ?? []) ways.add(w);
    if (ends || parts) for (const [a, b] of mids) { ways.add(dir(a)); ways.add(dir(b)); }
    if (ways.size >= 3 && (ends || mids.length)) out.push(p);
  }
  return out;
}
