/**
 * A project's schematics as EDIF 2 0 0 (schematic views, as the tools that read EDIF schematics
 * take them [est: OrCAD Capture, PADS Designer, Concept and others]): one file of libraries and a
 * design.
 *
 *  - SYMBOLS: a cell for each symbol placed (each part of a multi-part one, each display mode used;
 *    a library reference placed with different drawings a cell for each), its pins ports with
 *    their numbers (designator) and directions, its drawing the symbol: body figures, pins as port
 *    implementations with their connect locations, where the designator, the comment (VALUE) and
 *    the parameters shown go, and its texts. Hidden pins are ports with no drawing.
 *  - POWER: a cell for each power port style placed, its one port at the stem's end.
 *  - Each of the project's schematic libraries a library of its own, a cell for each symbol part.
 *  - DESIGNS: the design cell, a page for each sheet (each channel of a multi-channel sheet, with
 *    its designators and nets): parts as instances turned and mirrored as placed (R0 … MYR90),
 *    their designators, comments, footprints (PCB_FOOTPRINT) and parameters; every net by the name
 *    the project compiles it to — EDIF joins a page's nets of one name across the pages, so the
 *    connections are the project's whatever its Net Identifier Scope — with its pins joined, its
 *    wires and junctions drawn, its name shown where a net label is, power ports as power symbol
 *    instances in it; ports and off-sheet connectors off-page connectors of the net; buses as
 *    their own nets drawn as buses; sheet symbols and their entries, bus entries, drawings and
 *    texts comment graphics. Distances in mil.
 */
import type { Vec2 } from '../../core/geom';
import { roundRectPoints } from '../../core/geom';
import { UNITS_PER_MIL } from '../../core/units';
import { compileProject, type CompiledNet, type SheetInput } from '../../model/compile';
import { DIR_VECTORS, bagOf, deriveObject, isShown, ownedBy, partLetter, type SchDocument, type SchObject } from '../../model/sch';
import { symbolOf } from '../../model/makeLib';
import { autoJunctions } from '../../model/schConnect';
import { specialResolver } from '../../model/schSpecial';
import { entryPoint } from '../../model/schHierarchy';
import { bezierPts, powerGlyph } from '../../editors/sch/powerPort';
import { portOutline, sheetEntryOutline } from '../../editors/sch/symbols';
import type { PropertyBag } from '../altium/props';
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';

/* ── S-expressions ── */

type Sx = string | Sx[];
const flat = (x: Sx): string => (typeof x === 'string' ? x : `(${x.map(flat).join(' ')})`);
/** Laid out: a list short enough on one line, else its head and then each item on a line of its own. */
function pretty(x: Sx, ind: string): string {
  if (typeof x === 'string') return x;
  const f = flat(x);
  if (f.length + ind.length <= 110 || x.every((y) => typeof y === 'string')) return f;
  let i = 0;
  const head: string[] = [];
  while (i < x.length && typeof x[i] === 'string') head.push(x[i++] as string);
  // The name (a rename) stays with the keyword
  if (head.length === 1 && i < x.length && flat(x[i]!).length < 70 && /^\((rename|name|array) /.test(flat(x[i]!))) head.push(flat(x[i++]!));
  const inner = `${ind} `;
  return [`(${head.join(' ')}`, ...x.slice(i).map((y) => `${inner}${pretty(y, inner)}`)].join('\n') + ')';
}
/** An EDIF string: % and " (and anything not printable ASCII) as %code%. */
export function edifString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c === 34 || c === 37 || c < 32 || c > 126 ? `%${c}%` : ch;
  }
  return `"${out}"`;
}
const ident = (s: string): string => { const id = s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 250); return /^[A-Za-z]/.test(id) ? id : `&${id || '_'}`; };

/** Identifiers made unique within a scope; each keeps its text (a rename when they differ). */
class Names {
  private used = new Set<string>();
  private byText = new Map<string, string>();
  constructor(private shared = false) {}
  /** A new identifier for a text (`shared`: the same text the same identifier). */
  id(text: string): string {
    if (this.shared) { const had = this.byText.get(text); if (had) return had; }
    const base = ident(text);
    let id = base;
    for (let k = 2; this.used.has(id.toLowerCase()); k++) id = `${base}_${k}`;
    this.used.add(id.toLowerCase());
    if (this.shared) this.byText.set(text, id);
    return id;
  }
}
/** An identifier, renamed to its text when they differ; `extra`: displays of the text. */
const nm = (id: string, text: string, extra: Sx[] = []): Sx => (extra.length ? ['rename', id, ['stringDisplay', edifString(text), ...extra]] : id.replace(/^&/, '') === text ? id : ['rename', id, edifString(text)]);

/* ── geometry ── */

const MIL = UNITS_PER_MIL;
const u = (c: number) => String(Math.round(c / MIL));
const pt = (p: Vec2): Sx => ['pt', u(p.x), u(p.y)];
const pts = (l: Vec2[]): Sx => ['pointList', ...l.map(pt)];
/** EDIF's orientations as matrices [a b c d] (x' = a·x + b·y, y' = c·x + d·y). */
const ORIENT: [string, [number, number, number, number]][] = [
  ['R0', [1, 0, 0, 1]], ['R90', [0, -1, 1, 0]], ['R180', [-1, 0, 0, -1]], ['R270', [0, 1, -1, 0]],
  ['MX', [1, 0, 0, -1]], ['MY', [-1, 0, 0, 1]], ['MXR90', [0, 1, 1, 0]], ['MYR90', [0, -1, -1, 0]],
];
/** AD's placement (mirrored left-right, then turned) as a matrix and its EDIF name. */
function placement(orient: number, mirrored: boolean): { m: [number, number, number, number]; name: string } {
  const k = orient & 3, c = [1, 0, -1, 0][k]!, s = [0, 1, 0, -1][k]!, f = mirrored ? -1 : 1;
  const m: [number, number, number, number] = [c * f, -s, s * f, c];
  return { m, name: ORIENT.find(([, q]) => q.every((v, i) => v === m[i]))![0] };
}
const JUSTIFY = [['LOWERLEFT', 'LOWERCENTER', 'LOWERRIGHT'], ['CENTERLEFT', 'CENTERCENTER', 'CENTERRIGHT'], ['UPPERLEFT', 'UPPERCENTER', 'UPPERRIGHT']];
/** A display of text at a point, turned (AD's quarter turns) and justified (AD's 0–8). */
const display = (at: Vec2, orient = 0, justify = 0, group = 'TEXT'): Sx => {
  const items: Sx[] = ['display', group];
  const j = JUSTIFY[Math.floor(justify / 3) % 3]![justify % 3]!;
  if (j !== 'LOWERLEFT') items.push(['justify', j]);
  if (orient & 3) items.push(['orientation', ['R0', 'R90', 'R180', 'R270'][orient & 3]!]);
  items.push(['origin', pt(at)]);
  return items;
};
const norm = (a: number) => ((a % 360) + 360) % 360;
const arcPt = (c: Vec2, rx: number, ry: number, a: number): Vec2 => ({ x: c.x + rx * Math.cos((a * Math.PI) / 180), y: c.y + ry * Math.sin((a * Math.PI) / 180) });

/** A drawing (of a symbol or a page) as EDIF figures and texts; null for what isn't one. */
function figureOf(o: SchObject, solidGroup: string, lineGroup: string, wideGroup: string): Sx | null {
  const line = (w: number) => (w > 15 * MIL ? wideGroup : lineGroup);
  switch (o.kind) {
    case 'polyline': case 'signalharness': return o.pts.length >= 2 ? ['figure', line(o.width), ['path', pts(o.pts)]] : null;
    case 'busentry': return ['figure', line(o.width), ['path', pts([o.a, o.b])]];
    case 'bezier': {
      const out: Vec2[] = [];
      for (let i = 0; i + 3 < o.pts.length; i += 3) out.push(...bezierPts([[o.pts[i]!.x, o.pts[i]!.y], [o.pts[i + 1]!.x, o.pts[i + 1]!.y], [o.pts[i + 2]!.x, o.pts[i + 2]!.y], [o.pts[i + 3]!.x, o.pts[i + 3]!.y]]).slice(i ? 1 : 0).map(([x, y]) => ({ x, y })));
      return out.length >= 2 ? ['figure', line(o.width), ['path', pts(out)]] : null;
    }
    case 'polygon': return o.pts.length >= 3 ? ['figure', o.solid && !o.transparent && o.fill === o.color ? solidGroup : line(o.width), ['polygon', pts(o.pts)]] : null;
    case 'rect': {
      const g = o.solid && !o.transparent && o.fill === o.color ? solidGroup : line(o.width);
      if (o.r > 0 || o.ry > 0) return ['figure', g, ['polygon', pts(roundRectPoints(o.a, o.b, o.r, o.ry))]];
      return ['figure', g, ['rectangle', pt(o.a), pt(o.b)]];
    }
    case 'ellipse': {
      const g = o.solid && !o.transparent && o.fill === o.color ? solidGroup : line(o.width);
      if (Math.abs(o.rx - o.ry) < MIL) return ['figure', g, ['circle', pt({ x: o.c.x - o.rx, y: o.c.y }), pt({ x: o.c.x + o.rx, y: o.c.y })]];
      return ['figure', g, ['polygon', pts(Array.from({ length: 48 }, (_, i) => arcPt(o.c, o.rx, o.ry, i * 7.5)))]];
    }
    case 'arc': {
      const sweep = norm(o.end - o.start) || 360;
      if (Math.abs(o.rx - o.ry) < MIL) {
        if (sweep >= 359.99) return ['figure', line(o.width), ['circle', pt({ x: o.c.x - o.rx, y: o.c.y }), pt({ x: o.c.x + o.rx, y: o.c.y })]];
        return ['figure', line(o.width), ['openShape', ['curve', ['arc', pt(arcPt(o.c, o.rx, o.rx, o.start)), pt(arcPt(o.c, o.rx, o.rx, o.start + sweep / 2)), pt(arcPt(o.c, o.rx, o.rx, o.start + sweep))]]]];
      }
      return ['figure', line(o.width), ['path', pts(Array.from({ length: 33 }, (_, i) => arcPt(o.c, o.rx, o.ry, o.start + (sweep * i) / 32)))]];
    }
    case 'piechart': {
      const sweep = norm(o.end - o.start) || 360;
      return ['figure', o.solid && o.fill === o.color ? solidGroup : line(o.width), ['polygon', pts([o.c, ...Array.from({ length: 17 }, (_, i) => arcPt(o.c, o.r, o.r, o.start + (sweep * i) / 16))])]];
    }
    default: return null;
  }
}
const annotate = (text: string, d: Sx): Sx => ['annotate', ['stringDisplay', edifString(text), d]];

/* ── the export ── */

export interface EdifSchematic { text: string; stats: { pages: number; parts: number; nets: number; symbols: number }; warnings: string[] }

export function exportEdif(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const messages: ImportMessage[] = [];
  if (!p.sheets.length && !p.schLibs.some((l) => l.symbols.length)) {
    messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or schematic libraries' });
    return { files: [], messages };
  }
  const r = edifSchematic(p);
  messages.push({ level: 'info', source: name, message: `${r.stats.pages} page${r.stats.pages === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} nets, ${r.stats.symbols} symbol cells` });
  for (const w of r.warnings) messages.push({ level: 'warn', source: name, message: w });
  if (p.board) messages.push({ level: 'info', source: name, message: 'The board isn\'t part of an EDIF schematic (EDIF for PCB netlists carry its connections: Design › Netlist For Project)' });
  return { files: [{ path: `${name}/${name}.edf`, bytes: new TextEncoder().encode(r.text) }], messages };
}

export function edifSchematic(p: ExportProject, when = new Date()): EdifSchematic {
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const sheets = p.sheets;
  const c = sheets.length ? compileProject(sheets, { scope: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, checkBounds: false }) : null;

  /* Net names as compiled, one each */
  const netNames = new Names();
  const netId = new Map<CompiledNet, string>();
  const netText = new Map<CompiledNet, string>();
  const taken = new Set<string>();
  for (const n of c?.nets ?? []) {
    let t = n.name || 'N';
    for (let k = 2; taken.has(t.toUpperCase()); k++) t = `${n.name}_${k}`;
    taken.add(t.toUpperCase());
    netText.set(n, t);
    netId.set(n, netNames.id(t));
  }
  /* Where each object is: its page (sheet instance), its net, its part */
  const key2 = (inst: string | undefined, r: { sheet: string; index: number }) => `${inst ?? r.sheet}|${r.sheet}:${r.index}`;
  const pagesOf = new Map<string, string[]>();
  const sawInst = (sheet: string, inst: string | undefined) => { const l = pagesOf.get(sheet) ?? []; const k = inst ?? sheet; if (!l.includes(k)) l.push(k); pagesOf.set(sheet, l); };
  const netAt = new Map<string, CompiledNet>();
  for (const n of c?.nets ?? []) {
    for (const ir of n.instRefs ?? n.refs.map((ref) => ({ ref, inst: ref.sheet }))) { sawInst(ir.ref.sheet, ir.inst); const k = key2(ir.inst, ir.ref); if (!netAt.has(k)) netAt.set(k, n); }
    for (const pin of n.pins) { sawInst(pin.ref.sheet, pin.inst); const k = key2(pin.inst, pin.ref); if (!netAt.has(k)) netAt.set(k, n); }
  }
  const compAt = new Map<string, NonNullable<typeof c>['components'][number]>();
  for (const comp of c?.components ?? []) comp.refs.forEach((r, i) => { const inst = comp.refInsts?.[i] || comp.inst; sawInst(r.sheet, inst); const k = key2(inst, r); if (!compAt.has(k)) compAt.set(k, comp); });
  const pages: { s: SheetInput; inst: string }[] = [];
  for (const s of sheets) {
    const list = pagesOf.get(s.name) ?? [s.name];
    for (const inst of list) pages.push({ s, inst });
    if (list.length > 1) warn(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} pages with each channel's designators and nets`);
  }
  const vars = new Map(p.variables.map((v) => [v.name.toUpperCase(), v.value]));

  /* ── symbol cells ── */
  interface CellOut { id: string; sx: Sx; ports: Map<string, string> }
  const libCells = new Map<string, { names: Names; cells: CellOut[]; sig: Map<string, CellOut> }>();
  const libOf = (lib: string) => { let l = libCells.get(lib); if (!l) { l = { names: new Names(), cells: [], sig: new Map() }; libCells.set(lib, l); } return l; };
  /**
   * A symbol (one part, one display mode) as a cell: `objs` its records in the library's frame,
   * `paramName` a parameter text's name. Cells of one drawing are shared.
   */
  const symbolCell = (lib: string, base: string, objs: SchObject[], paramName: (o: SchObject) => string, description: string): CellOut => {
    const L = libOf(lib);
    const ports: Sx[] = [], impls: Sx[] = [], figs: Sx[] = [], shows: Sx[] = [];
    const portIds = new Names();
    const portOf = new Map<string, string>();
    for (const o of objs) {
      if (o.kind === 'pin') {
        const text = o.name.trim() || o.designator || 'P';
        if (portOf.has(o.designator)) warn('Pins of one number twice in a symbol: the second a port of its own');
        const id = portIds.id(text);
        if (!portOf.has(o.designator)) portOf.set(o.designator, id);
        // AD's input, I/O, output, open collector, passive, HiZ, emitter, power: EDIF's three directions (passive and power none)
        const dir = ['INPUT', 'INOUT', 'OUTPUT', 'OUTPUT', '', 'OUTPUT', 'OUTPUT', ''][o.electrical] ?? '';
        ports.push(['port', nm(id, text), ...(dir ? [['direction', dir]] : []), ['designator', edifString(o.designator)]]);
        if (o.hidden) { warn('Hidden pins written as ports with no drawing (on the nets they join)'); continue; }
        const d = DIR_VECTORS[o.orient & 3]!;
        const hot = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
        const inward = { x: o.at.x - d.x * 5 * MIL, y: o.at.y - d.y * 5 * MIL };
        const mid = { x: (o.at.x + hot.x) / 2, y: (o.at.y + hot.y) / 2 };
        const vertical = (o.orient & 1) === 1;
        // The name inside the body, the number over the pin [est: AD's spacing]
        const nameJust = [5, 1, 3, 7][o.orient & 3]!;
        const impl: Sx[] = ['portImplementation', o.showName && text !== o.designator ? ['name', id, display(inward, vertical ? 1 : 0, vertical ? [3, 3, 5, 5][o.orient & 3]! : nameJust)] : id,
          ['figure', 'PIN', ['path', pts([hot, o.at])]], ['connectLocation', ['figure', 'DOT', ['dot', pt(hot)]]]];
        if (o.showDesignator) impl.push(['keywordDisplay', 'designator', display({ x: mid.x - (vertical ? 10 * MIL : 0), y: mid.y + (vertical ? 0 : 10 * MIL) }, vertical ? 1 : 0, 1)]);
        impls.push(impl);
        continue;
      }
      if (o.kind === 'text') {
        if (o.role === 'designator') shows.push(['keywordDisplay', 'designator', display(o.at, o.orient, o.justify)]);
        else if (o.role === 'parameter') {
          if (o.hidden) continue;
          const n = paramName(o);
          if (/^comment$/i.test(n)) shows.push(['propertyDisplay', 'VALUE', display(o.at, o.orient, o.justify)]);
          else if (n) shows.push(['propertyDisplay', ident(n), display(o.at, o.orient, o.justify)]);
        } else if (o.role === 'label' && o.text.trim()) figs.push(annotate(o.text, display(o.at, o.orient, o.justify)));
        continue;
      }
      if (o.kind === 'ieee') { warn('IEEE symbols left out of the symbols'); continue; }
      const f = figureOf(o, 'SOLID', 'BODY', 'BODY_WIDE');
      if (f) figs.push(f);
    }
    const iface: Sx[] = ['interface', ...ports, ['symbol', ...impls, ...figs, ...shows]];
    const sig = `${base}\u0000${flat(iface)}`;
    const had = L.sig.get(sig);
    if (had) return had;
    const id = L.names.id(base);
    const view: Sx[] = ['view', 'SYMBOL', ['viewType', 'SCHEMATIC'], iface];
    if (description) view.push(['property', 'DESCRIPTION', ['string', edifString(description)]]);
    const cell: CellOut = { id, sx: ['cell', nm(id, base), ['cellType', 'GENERIC'], view], ports: portOf };
    L.sig.set(sig, cell);
    L.cells.push(cell);
    return cell;
  };
  /** A library symbol's parts (and display mode) from its records. */
  const partsOf = (bags: PropertyBag[]) => {
    const objs = bags.map((b, i) => (i > 0 ? deriveObject(b, i) : null)).filter((q): q is SchObject => !!q);
    return { objs, parts: Math.max(1, (bags[0]?.int('PARTCOUNT', 2) ?? 2) - 1) };
  };
  const ofPart = (objs: SchObject[], part: number, mode: number) => objs.filter((q) => (q.ownerPartId <= 0 || q.ownerPartId === part) && (q.ownerDisplayMode === mode || (q.ownerPartId < 0 && !q.ownerDisplayMode)));

  /* ── power symbols ── */
  const POWER_NAMES = ['POWER_CIRCLE', 'POWER_ARROW', 'POWER_BAR', 'POWER_WAVE', 'GROUND_POWER', 'GROUND_SIGNAL', 'EARTH', 'POWER_GOST_ARROW', 'GROUND_GOST_POWER', 'EARTH_GOST', 'POWER_GOST_BAR'];
  const powerCells = new Map<number, string>();
  const powerCell = (style: number): string => {
    let id = powerCells.get(style);
    if (id) return id;
    const L = libOf('POWER');
    id = L.names.id(POWER_NAMES[style] ?? `POWER_${style}`);
    const g = powerGlyph(style);
    const q = ([a, b]: [number, number]): Vec2 => ({ x: a * MIL, y: b * MIL });
    const figs: Sx[] = [
      ...g.lines.map((l): Sx => ['figure', 'BODY', ['path', pts(l.map(q))]]),
      ...(g.circles ?? []).map((cc): Sx => ['figure', 'BODY', ['circle', pt(q([cc.c[0] - cc.r, cc.c[1]])), pt(q([cc.c[0] + cc.r, cc.c[1]]))]]),
      ...(g.beziers ?? []).map((bz): Sx => ['figure', 'BODY', ['path', pts(bezierPts(bz).map(q))]]),
    ];
    const cell: CellOut = { id, ports: new Map([['P', 'P']]), sx: ['cell', id, ['cellType', 'GENERIC'], ['view', 'SYMBOL', ['viewType', 'SCHEMATIC'], ['interface', ['port', 'P', ['direction', 'INOUT']],
      ['symbol', ['portImplementation', 'P', ['connectLocation', ['figure', 'DOT', ['dot', pt({ x: 0, y: 0 })]]]], ...figs, ['keywordDisplay', 'instance', display(q([g.labelAt, 0]), 0, 3)]]]]] };
    L.cells.push(cell);
    powerCells.set(style, id);
    return id;
  };

  /* ── the pages ── */
  const instNames = new Names();
  const pageNames = new Names();
  /** Off-page connectors (ports and off-sheet connectors), one of each name for the design. */
  const offIds = new Map<string, string>();
  const offNames = new Names();
  const offPage = (text: string) => { let id = offIds.get(text); if (!id) { id = offNames.id(text); offIds.set(text, id); } return id; };
  const busIds = new Map<string, string>();
  const parts = new Set<string>();
  const pageSx: Sx[] = [];
  let busK = 0, looseK = 0;
  pages.forEach(({ s, inst: page }, si) => {
    const doc = s.doc, objs = doc.objects;
    const owned = ownedBy(doc);
    const ref = (o: SchObject) => key2(page, { sheet: s.name, index: o.index });
    const resolve = specialResolver(doc, { docName: s.name, projectName: p.name, projectParams: vars }, false);
    const special = (t: string, owner = -1) => {
      const k = t.trim().toUpperCase();
      if (k === '=SHEETNUMBER') return String(si + 1);
      if (k === '=SHEETTOTAL') return String(pages.length);
      return resolve(t, owner);
    };
    const instances: Sx[] = [], comments: Sx[] = [], portImpls: Sx[] = [];
    /** The page's nets: their joins, figures, labels, power symbols. */
    const nets = new Map<string, { text: string; joined: Sx[]; figs: Sx[]; labels: Sx[]; insts: Sx[] }>();
    const netOn = (n: CompiledNet | undefined, fallback: () => string) => {
      const id = n ? netId.get(n)! : fallback();
      let e = nets.get(id);
      if (!e) { e = { text: n ? netText.get(n)! : id, joined: [], figs: [], labels: [], insts: [] }; nets.set(id, e); }
      return Object.assign(e, { id });
    };
    // Wires and ports on no net the project compiles: nets of their own, named as EDIF tools name such nets
    const looseNet = () => { let t: string; do t = `N$${++looseK}`; while (taken.has(t.toUpperCase())); taken.add(t.toUpperCase()); return netNames.id(t); };

    /* Parts */
    for (const o of objs) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const comp = compAt.get(ref(o));
      const made = symbolOf(doc, o.index);
      const { objs: lib } = partsOf(made.bags);
      const multi = o.partCount > 2;
      const base = `${o.libRef || 'PART'}${multi ? `_${partLetter(Math.max(1, o.partId))}` : ''}${o.displayMode > 0 ? `_MODE${o.displayMode}` : ''}`;
      const cell = symbolCell('SYMBOLS', base, ofPart(lib, Math.max(1, o.partId), o.displayMode), (t) => made.bags[t.index]?.get('NAME') ?? '', made.description);
      const des = (comp?.designator || o.designator || 'U?') + (multi && comp?.designator && !/[A-Z]$/.test(comp.designator) ? partLetter(Math.max(1, o.partId)) : '');
      parts.add(comp?.designator || des);
      const id = instNames.id(`I_${des}`);
      const pl = placement(o.orient, o.mirrored);
      // The sheet's texts of the part in its own frame (the placement undone)
      const local = (q: Vec2): Vec2 => { const dx = q.x - o.at.x, dy = q.y - o.at.y; return { x: pl.m[0] * dx + pl.m[2] * dy, y: pl.m[1] * dx + pl.m[3] * dy }; };
      const localTurn = (orient: number) => {
        const d = DIR_VECTORS[orient & 3]!, x = pl.m[0] * d.x + pl.m[2] * d.y, y = pl.m[1] * d.x + pl.m[3] * d.y;
        return Math.round((Math.atan2(y, x) * 2) / Math.PI + 4) % 4;
      };
      const kids = owned.get(o.index) ?? [];
      const textOf = (role: 'designator' | 'comment') => kids.find((q): q is SchObject & { kind: 'text' } => q.kind === 'text' && (role === 'designator' ? q.role === 'designator' : q.role === 'parameter' && /^comment$/i.test(bagOf(doc, q)?.get('NAME') ?? '')));
      const shown = (t: (SchObject & { kind: 'text' }) | undefined): Sx[] => (t && isShown(doc, t) ? [display(local(t.at), localTurn(t.orient), t.justify)] : []);
      const dt = textOf('designator'), ct = textOf('comment');
      const item: Sx[] = ['instance', nm(id, des), ['viewRef', 'SYMBOL', ['cellRef', cell.id, ['libraryRef', 'SYMBOLS']]],
        ['transform', ...(pl.name !== 'R0' ? [['orientation', pl.name]] : []), ['origin', pt(o.at)]]];
      const ds = shown(dt);
      item.push(['designator', ds.length ? ['stringDisplay', edifString(des), ...ds] : edifString(des)]);
      const comment = comp?.comment ?? (ct ? special(ct.text, o.index) : '');
      const cs = shown(ct);
      if (comment) item.push(['property', 'VALUE', ['string', cs.length ? ['stringDisplay', edifString(comment), ...cs] : edifString(comment)]]);
      if (comp?.footprint && comp.kind !== 2) item.push(['property', 'PCB_FOOTPRINT', ['string', edifString(comp.footprint)]]);
      for (const q of kids) {
        if (q.kind !== 'text' || q.role !== 'parameter') continue;
        const n = bagOf(doc, q)?.get('NAME') ?? '';
        if (!n || /^(comment|designator)$/i.test(n)) continue;
        const v = special(q.text, o.index);
        if (!v || v.startsWith('=')) continue;
        const sh = shown(q);
        item.push(['property', nm(ident(n), n), ['string', sh.length ? ['stringDisplay', edifString(v), ...sh] : edifString(v)]]);
      }
      instances.push(item);
      // Its pins on their nets (hidden ones too: AD joins them by their net names)
      for (const q of kids) {
        if (q.kind !== 'pin' || (q.ownerPartId > 0 && q.ownerPartId !== o.partId) || (q.ownerDisplayMode !== o.displayMode)) continue;
        const port = cell.ports.get(q.designator);
        const n = netAt.get(ref(q));
        if (!port || !n) continue;
        netOn(n, looseNet).joined.push(['portRef', port, ['instanceRef', id]]);
      }
    }

    /* Wires, labels, power ports, ports, junctions */
    const wires: { pts: Vec2[]; net: string }[] = [];
    for (const o of objs) {
      if (!isShown(doc, o)) continue;
      switch (o.kind) {
        case 'wire': {
          const n = netAt.get(ref(o));
          const e = netOn(n, looseNet);
          e.figs.push(['figure', 'WIRE', ['path', pts(o.pts)]]);
          wires.push({ pts: o.pts, net: e.id });
          break;
        }
        case 'text':
          if (o.role === 'netlabel') {
            const n = netAt.get(ref(o));
            if (n) netOn(n, looseNet).labels.push(display(o.at, o.orient, o.justify));
            else if (!buses(doc).some((b) => onWire(o.at, b.pts))) comments.push(annotate(o.text, display(o.at, o.orient, o.justify)));
          } else if (o.role === 'label' && o.owner < 0 && o.text.trim()) {
            for (const [li, line] of special(o.text).split(/\r?\n/).entries()) comments.push(annotate(line, display({ x: o.at.x, y: o.at.y - li * 100 * MIL }, o.orient, o.justify)));
          }
          break;
        case 'power': {
          const n = netAt.get(ref(o));
          const e = netOn(n, looseNet);
          if (o.crossSheet) {
            const id = offPage(e.text);
            const d = DIR_VECTORS[o.orient & 3]!;
            portImpls.push(['portImplementation', id, ['figure', 'PORT', ['path', pts([o.at, { x: o.at.x + d.x * 50 * MIL, y: o.at.y + d.y * 50 * MIL }])]], ['connectLocation', ['figure', 'DOT', ['dot', pt(o.at)]]]]);
            e.joined.push(['portRef', id]);
            break;
          }
          const cell = powerCell(o.style);
          e.insts.push(['instance', nm(instNames.id(`PWR_${e.text}`), e.text), ['viewRef', 'SYMBOL', ['cellRef', cell, ['libraryRef', 'POWER']]],
            ['transform', ...((o.orient & 3) ? [['orientation', ['R0', 'R90', 'R180', 'R270'][o.orient & 3]!]] : []), ['origin', pt(o.at)]]]);
          break;
        }
        case 'port': {
          const n = netAt.get(ref(o));
          const e = netOn(n, looseNet);
          const id = offPage(o.name);
          const vertical = o.style >= 4;
          const outline = portOutline(o.style, o.width, o.height).map(([a, b]): Vec2 => (vertical ? { x: o.at.x - b, y: o.at.y + a } : { x: o.at.x + a, y: o.at.y + b }));
          // It joins at whichever end a wire meets (else its location)
          const far = vertical ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y };
          const at = wiresOf(doc).some((w) => onWire(far, w.pts)) && !wiresOf(doc).some((w) => onWire(o.at, w.pts)) ? far : o.at;
          portImpls.push(['portImplementation', ['name', id, display(vertical ? { x: o.at.x, y: o.at.y + o.width / 2 } : { x: o.at.x + o.width / 2, y: o.at.y }, vertical ? 1 : 0, 4)],
            ['figure', 'PORT', ['polygon', pts(outline)]], ['connectLocation', ['figure', 'DOT', ['dot', pt(at)]]]]);
          e.joined.push(['portRef', id]);
          break;
        }
        case 'bus': {
          const label = objs.find((t): t is SchObject & { kind: 'text' } => t.kind === 'text' && t.role === 'netlabel' && isShown(doc, t) && onWire(t.at, o.pts));
          const text = label ? label.text.replace(/\s+/g, '') : `N$${10000 + ++busK}`;
          let id = busIds.get(text);
          if (!id) { id = netNames.id(`BUS_${text}`); busIds.set(text, id); }
          let e = nets.get(id);
          if (!e) { e = { text, joined: [], figs: [], labels: [], insts: [] }; nets.set(id, e); }
          e.figs.push(['figure', 'BUS', ['path', pts(o.pts)]]);
          if (label) e.labels.push(display(label.at, label.orient, label.justify));
          break;
        }
        case 'busentry': comments.push(figureOf(o, 'GRAPHIC_SOLID', 'WIRE', 'WIRE')!); break;
        case 'sheetsymbol': {
          comments.push(['figure', 'GRAPHIC', ['rectangle', pt(o.at), pt({ x: o.at.x + o.w, y: o.at.y - o.h })]]);
          for (const k of owned.get(o.index) ?? []) {
            if (k.kind === 'text' && isShown(doc, k)) comments.push(annotate(k.text, display(k.at, k.orient, k.justify)));
            if (k.kind === 'sheetentry') {
              const at = entryPoint(doc, k);
              if (!at) continue;
              // The entry's outline, measured in from the edge it is on
              const inward = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }][k.side & 3]!;
              const across = { x: -inward.y, y: inward.x };
              const shape = sheetEntryOutline(k.io).map(([a, b]): Vec2 => ({ x: at.x + (inward.x * a + across.x * b) * MIL, y: at.y + (inward.y * a + across.y * b) * MIL }));
              comments.push(['figure', 'GRAPHIC', ['polygon', pts(shape)]]);
              comments.push(annotate(k.name, display({ x: at.x + inward.x * 200 * MIL, y: at.y + inward.y * 200 * MIL }, inward.y ? 1 : 0, inward.x < 0 || inward.y < 0 ? 5 : 3)));
              warn('Sheet symbols and their entries drawn as graphics (the nets they join keep their names across the pages)');
            }
          }
          break;
        }
        case 'textframe': {
          if (o.border) comments.push(['figure', 'GRAPHIC', ['rectangle', pt(o.a), pt(o.b)]]);
          const top = Math.max(o.a.y, o.b.y) - 100 * MIL, left = Math.min(o.a.x, o.b.x) + o.margin;
          o.text.split(/\r?\n/).forEach((line, i) => { if (line.trim()) comments.push(annotate(line, display({ x: left, y: top - i * 120 * MIL }))); });
          break;
        }
        case 'noerc': break;
        case 'image': warn('Images left out'); break;
        case 'ieee': warn('IEEE symbols left out'); break;
        case 'harness': case 'harnessentry': warn('Harness connectors drawn as nothing (their nets are kept)'); break;
        case 'directive': case 'compilemask': case 'blanket': warn('Directives, compile masks and blankets left out'); break;
        default: {
          if (o.owner >= 0 && (objs[o.owner]?.kind === 'component' || objs[o.owner]?.kind === 'sheetsymbol')) break;
          const f = figureOf(o, 'GRAPHIC_SOLID', 'GRAPHIC', 'GRAPHIC_WIDE');
          if (f) comments.push(f);
        }
      }
    }
    // Junctions: the sheet's own and where AD puts them
    const junctions = [...objs.filter((o): o is SchObject & { kind: 'junction' } => o.kind === 'junction' && isShown(doc, o)).map((o) => o.at), ...autoJunctions(doc).map((j) => j.at)];
    for (const j of junctions) {
      const w = wires.find((x) => onWire(j, x.pts));
      if (w) nets.get(w.net)!.figs.push(['figure', 'DOT', ['dot', pt(j)]]);
    }

    const netSx: Sx[] = [];
    for (const [id, e] of nets) {
      const item: Sx[] = ['net', nm(id, e.text, e.labels), ['joined', ...e.joined], ...e.figs, ...e.insts];
      if (e.joined.length || e.figs.length || e.insts.length) netSx.push(item);
    }
    const pageName = page === s.name ? s.name.replace(/\.schdoc$/i, '') : page.replace(/\.schdoc$/i, '');
    pageSx.push(['page', nm(pageNames.id(pageName), pageName), ...instances, ...netSx, ...portImpls,
      ...(comments.length ? [['commentGraphics', ...comments]] : []), ['pageSize', ['rectangle', pt({ x: 0, y: 0 }), pt({ x: doc.sheet.width, y: doc.sheet.height })]]]);
  });

  /* The project's schematic libraries: a library each */
  const extraLibs: { id: string; text: string }[] = [];
  const libNames = new Names();
  for (const n of ['SYMBOLS', 'POWER', 'DESIGNS']) libNames.id(n);
  for (const l of p.schLibs) {
    if (!l.symbols.length) continue;
    const text = l.name.replace(/\.schlib$/i, '');
    const id = libNames.id(text);
    extraLibs.push({ id, text });
    for (const sym of l.symbols) {
      if (!sym.bags.length) continue;
      const { objs, parts: n } = partsOf(sym.bags);
      for (let part = 1; part <= n; part++) symbolCell(id, `${sym.libRef}${n > 1 ? `_${partLetter(part)}` : ''}`, ofPart(objs, part, 0), (t) => sym.bags[t.index]?.get('NAME') ?? '', sym.bags[0]?.get('COMPONENTDESCRIPTION') ?? '');
    }
  }

  /* ── the file ── */
  const ts: Sx = ['timeStamp', ...[when.getFullYear(), when.getMonth() + 1, when.getDate(), when.getHours(), when.getMinutes(), when.getSeconds()].map(String)];
  const design = p.name.replace(/\.prj\w*$/i, '') || 'Design';
  const designId = ident(design);
  const technology: Sx = ['technology', ['numberDefinition', ['scale', '1', ['e', '254', '-7'], ['unit', 'DISTANCE']]],
    ...[['BODY', 10], ['BODY_WIDE', 30], ['PIN', 10], ['WIRE', 10], ['BUS', 30], ['PORT', 10], ['GRAPHIC', 10], ['GRAPHIC_WIDE', 30]].map(([g, w]): Sx => ['figureGroup', String(g), ['pathWidth', String(w)]]),
    ...['SOLID', 'GRAPHIC_SOLID', 'DOT'].map((g): Sx => ['figureGroup', g, ['pathWidth', '10'], ['fillPattern', '1', '1', ['boolean', ['true']]]]),
    ['figureGroup', 'TEXT', ['textHeight', '60']]];
  const library = (id: string, text: string, cells: Sx[]): Sx => ['library', nm(id, text), ['edifLevel', '0'], technology, ...cells];
  const libs: Sx[] = [];
  for (const [lib, L] of libCells) {
    if (lib === 'SYMBOLS' || lib === 'POWER') libs.push(library(lib, lib, L.cells.map((x) => x.sx)));
    else { const e = extraLibs.find((x) => x.id === lib)!; libs.push(library(e.id, e.text, L.cells.map((x) => x.sx))); }
  }
  // Libraries before what uses them: the placed symbols' and the power symbols' first
  libs.sort((a, b) => order(a) - order(b));
  function order(x: Sx) { const f = flat(x); return f.startsWith('(library SYMBOLS') ? 0 : f.startsWith('(library POWER') ? 1 : 2; }
  const top: Sx[] = ['edif', nm(designId, design), ['edifVersion', '2', '0', '0'], ['edifLevel', '0'], ['keywordMap', ['keywordLevel', '0']],
    ['status', ['written', ts, ['program', edifString('Konium Designer')], ['comment', edifString('EDIF schematic')]]], ...libs];
  if (pageSx.length) {
    top.push(['library', 'DESIGNS', ['edifLevel', '0'], technology,
      ['cell', nm(designId, design), ['cellType', 'GENERIC'], ['view', 'SCHEMATIC', ['viewType', 'SCHEMATIC'], ['interface'], ['contents', ...[...offIds].map(([text, id]): Sx => ['offPageConnector', nm(id, text)]), ...pageSx]]]]);
    top.push(['design', nm(designId, design), ['cellRef', designId, ['libraryRef', 'DESIGNS']]]);
  }
  const symbols = [...libCells.values()].reduce((a, l) => a + l.cells.length, 0);
  return { text: `${pretty(top, '')}\n`, stats: { pages: pageSx.length, parts: parts.size, nets: c?.nets.length ?? 0, symbols }, warnings };
}

const wireCache = new WeakMap<SchDocument, (SchObject & { kind: 'wire' | 'bus' })[]>();
function wiresOf(doc: SchDocument) { let w = wireCache.get(doc); if (!w) { w = doc.objects.filter((o): o is SchObject & { kind: 'wire' } => o.kind === 'wire' && isShown(doc, o)); wireCache.set(doc, w); } return w; }
function buses(doc: SchDocument) { return doc.objects.filter((o): o is SchObject & { kind: 'bus' } => o.kind === 'bus' && isShown(doc, o)); }
function onWire(q: Vec2, l: Vec2[]): boolean {
  for (let k = 1; k < l.length; k++) {
    const a = l[k - 1]!, b = l[k]!, dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
    if (Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y) < 0.5 * MIL) return true;
  }
  return false;
}
