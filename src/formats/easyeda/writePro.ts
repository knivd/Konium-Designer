/**
 * R14, a project as an EasyEDA Pro project (.epro: EasyEDA Pro's project zip, project.json and a
 * file per document, one JSON array a line), what EasyEDA Pro opens as a project of its own.
 *
 *  - Schematic: a page per sheet (each channel of a multi-channel sheet a page, with that channel's
 *    designators and nets); a symbol for each library reference and pin layout, its parts EasyEDA's
 *    parts (pins with their length, the way they point, dot, clock, name and number and whether
 *    shown, electrical type; drawings and text), a device for each symbol and footprint; parts
 *    placed, turned and mirrored as AD places them, with their designator, comment (Name) and
 *    parameters where they are shown, a Unique ID the board's part shares; wires each with its net's
 *    name as the project compiles it (EasyEDA joins a name's wires across the pages), net labels as
 *    the names shown on them; power ports as net flags in their style, ports, sheet entries and
 *    off-sheet connectors as net ports of their nets; no-ERC marks on pins as EasyEDA's no-connects;
 *    text, lines, polygons, rectangles, circles, arcs, curves, text frames, sheet symbols as drawn.
 *  - Board: the copper stack (top, the inner layers in order, bottom, the dielectrics between),
 *    silkscreens, masks, pastes, the board outline (its arcs kept) and cut-outs, the assembly,
 *    document and other mechanical layers (by name, else custom layers of their names); each
 *    footprint once, its pads (rectangles, rounded, round, oval, octagons; holes and slots, plating,
 *    mask and paste expansions) and drawings in its own frame; parts placed on it (bottom ones
 *    reflected as AD reflects them) with their pads' nets, designator and comment; tracks and arcs by
 *    net, vias, free pads, fills and regions, keep-outs as keep-out regions, polygon pours with their
 *    poured copper, internal planes as pours on inner layers, text, dimensions as drawn; the design
 *    rules' clearance, track width, via, mask and paste expansions.
 *
 * EasyEDA's schematic unit is AD's (0.01 inch), its board's the mil; both Y up as AD has it.
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { compileProject, type CompiledComponent, type CompiledNet } from '../../model/compile';
import { DIR_VECTORS, bagOf, componentKind, deriveObject, isShown, ownedBy, type SchDocument, type SchObject } from '../../model/sch';
import { symbolOf } from '../../model/makeLib';
import { entryPoint } from '../../model/schHierarchy';
import { specialResolver } from '../../model/schSpecial';
import { bezierPts, powerGlyph } from '../../editors/sch/powerPort';
import { L, isMech, isPlane, mechNumber, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbText, type PolyVertex } from '../../model/pcb';
import { footprintDoc, footprintsFromBoard } from '../../model/pcbLib';
import { planeCopper } from '../../model/planes';
import { dimensionEdges, dimensionGeometry } from '../../model/dimensions';
import { readStack } from '../../model/pcbStack';
import { PAD, get } from '../altium/pcbLayouts';
import { ruleEnabled, ruleKind, ruleLength, ruleScope1, ruleScope2 } from '../altium/rules';
import { zip } from '../zip';
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';
import { easyedaLibId } from './writeStdPcb';

type Rec = unknown[];
type Pt = Vec2;

/** AD's schematic unit (0.01 inch) in its coordinates. */
const U = 100_000;
const r4 = (v: number) => { const r = Math.round(v * 1e4) / 1e4; return Object.is(r, -0) ? 0 : r; };
const norm = (a: number) => ((a % 360) + 360) % 360;
const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
/** A 32-hex id (as EasyEDA's uuids look) a key gives, the same every time. */
const uuidOf = (key: string) => easyedaLibId(`a:${key}`).slice(3) + easyedaLibId(`b:${key}`).slice(3);
const lines = (recs: Rec[]) => new TextEncoder().encode(recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TAGS = { parent_tag: [] as string[], child_tag: [] as string[] };
const btoa64 = (s: string) => { const b = new TextEncoder().encode(s); let t = ''; for (const c of b) t += String.fromCharCode(c); return btoa(t); };

/** Styles of a schematic or symbol document (EasyEDA names them, each before it's used). */
class Styles {
  recs: Rec[] = [];
  private keys = new Map<string, string>();
  font(size: number | null, h: number | null, v: number | null, color: string | null = null, bold = false, italic = false): string {
    const k = JSON.stringify(['f', size, h, v, color, bold, italic]);
    let id = this.keys.get(k);
    if (!id) { id = `st${this.keys.size + 1}`; this.keys.set(k, id); this.recs.push(['FONTSTYLE', id, color, null, null, size, italic ? 1 : 0, bold ? 1 : 0, 0, 0, v, h]); }
    return id;
  }
  line(color: string | null, dash: number, fill: string | null, width: number | null): string {
    const k = JSON.stringify(['l', color, dash, fill, width]);
    let id = this.keys.get(k);
    if (!id) { id = `st${this.keys.size + 1}`; this.keys.set(k, id); this.recs.push(['LINESTYLE', id, color, dash, fill, width]); }
    return id;
  }
}
class Ids { n = 0; next = () => `e${++this.n}`; }

/** AD's text justification (0–8: across, then bottom to top) as EasyEDA's alignment (h 0 left …; v 0 top …). */
const align = (j: number) => ({ h: j % 3, v: 2 - Math.floor(j / 3) % 3 });
/** AD's font size (points) as EasyEDA's (its unit): as the import reads it back. */
const fontSize = (pt: number) => Math.max(3, Math.round((pt / 1.24) * 10) / 10);
const lineW = (w: number) => r4(Math.max(0.5, w / U));

interface SymMade { uuid: string; title: string; type: number; parts: string[]; /** Each part's pins: its designator (and which of that name) → the pin's id. */ pins: Map<string, string>[]; description: string }

export function exportEasyedaPro(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const messages: ImportMessage[] = [];
  const warned = new Map<string, number>();
  const note = (w: string) => warned.set(w, (warned.get(w) ?? 0) + 1);
  const info = (message: string) => messages.push({ level: 'info', source: name, message });
  const files: { name: string; bytes: Uint8Array }[] = [];
  const project = {
    schematics: {} as Record<string, unknown>, pcbs: {} as Record<string, string>, panels: {},
    symbols: {} as Record<string, unknown>, footprints: {} as Record<string, unknown>, devices: {} as Record<string, unknown>,
    boards: {} as Record<string, { schematic: string; pcb: string }>, config: { title: name, cbbProject: false, defaultSheet: '' },
  };
  const schUuid = uuidOf(`sch:${name}`), pcbUuid = uuidOf(`pcb:${name}`);

  /* Each part's Unique ID (gge<n>), by its designator: the schematic's part and the board's share it */
  const uids = new Map<string, string>();
  const uidOf = (des: string) => { const k = des.toUpperCase(); let v = uids.get(k); if (!v) { v = `gge${uids.size + 1}`; uids.set(k, v); } return v; };

  /* Footprints: each once, in its own frame */
  const fps = new Map<string, { uuid: string; prims: PcbPrim[]; doc: PcbDocument }>();
  if (p.board) for (const def of footprintsFromBoard(p.board)) {
    const d = footprintDoc(def.name, def.records);
    fps.set(def.name.toLowerCase(), { uuid: uuidOf(`fp:${def.name}`), prims: d.prims, doc: d });
  }
  const libFootprint = (nm: string) => {
    const k = nm.toLowerCase();
    if (!nm || fps.has(k)) return fps.get(k);
    for (const pl of p.pcbLibs) for (const f of pl.footprints) if (f.loaded !== false && f.name.toLowerCase() === k) { fps.set(k, { uuid: uuidOf(`fp:${f.name}`), prims: f.doc.prims, doc: f.doc }); return fps.get(k); }
    return undefined;
  };

  /* Devices: a symbol and a footprint */
  const devices = new Map<string, string>();
  const deviceOf = (title: string, sym: string, fp: string, attrs: Record<string, string>) => {
    const k = `${sym}\u0000${fp}\u0000${attrs['Convert to PCB'] ?? ''}`;
    let id = devices.get(k);
    if (!id) {
      id = uuidOf(`dev:${k}:${title}`);
      devices.set(k, id);
      project.devices[id] = { title, attributes: { Symbol: sym, Footprint: fp, 'Add into BOM': 'yes', 'Convert to PCB': 'yes', ...attrs }, description: '', tags: TAGS, images: [], source: '', version: '' };
    }
    return id;
  };

  /* ── the schematic ── */
  let schStats = { pages: 0, parts: 0, nets: 0 };
  const pcbDevice = new Map<string, string>();   // designator → device
  if (p.sheets.length) schStats = writeSchematic();

  function writeSchematic() {
    const sheets = p.sheets;
    const c = compileProject(sheets, { scope: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, checkBounds: false });
    const used = new Set<string>();
    const nameOf = new Map<CompiledNet, string>();
    for (const n of c.nets) {
      const base = n.name.trim() || 'N';
      let nm = base;
      for (let k = 2; used.has(nm.toUpperCase()); k++) nm = `${base}_${k}`;
      used.add(nm.toUpperCase());
      nameOf.set(n, nm);
    }
    const key2 = (inst: string | undefined, r: { sheet: string; index: number }) => `${inst ?? r.sheet}|${r.sheet}:${r.index}`;
    const pagesOf = new Map<string, string[]>();
    const sawInst = (sheet: string, inst: string | undefined) => { const l = pagesOf.get(sheet) ?? []; const k = inst ?? sheet; if (!l.includes(k)) l.push(k); pagesOf.set(sheet, l); };
    const netAt = new Map<string, CompiledNet>();
    for (const n of c.nets) {
      for (const ir of n.instRefs ?? n.refs.map((ref) => ({ ref, inst: ref.sheet }))) { sawInst(ir.ref.sheet, ir.inst); const k = key2(ir.inst, ir.ref); if (!netAt.has(k)) netAt.set(k, n); }
      for (const pin of n.pins) { sawInst(pin.ref.sheet, pin.inst); const k = key2(pin.inst, pin.ref); if (!netAt.has(k)) netAt.set(k, n); }
    }
    const compAt = new Map<string, CompiledComponent>();
    const roomOf = new Map<string, string>();
    for (const comp of c.components) comp.refs.forEach((r, i) => {
      const inst = comp.refInsts?.[i] || comp.inst;
      sawInst(r.sheet, inst);
      const k = key2(inst, r);
      if (!compAt.has(k)) compAt.set(k, comp);
      if (comp.channel && inst) roomOf.set(inst, comp.channel);
    });
    const pages: { s: (typeof sheets)[number]; inst: string; title: string }[] = [];
    for (const s of sheets) {
      const list = pagesOf.get(s.name) ?? [s.name];
      const stem = s.name.replace(/\.schdoc$/i, '');
      list.forEach((inst, k) => pages.push({ s, inst, title: list.length > 1 ? `${stem}_${roomOf.get(inst) ?? k + 1}` : stem }));
      if (list.length > 1) note(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} pages with each channel's designators and nets`);
    }
    const vars = new Map((p.variables ?? []).map((v) => [v.name.toUpperCase(), v.value]));

    /* Symbols: one for each library reference and pin layout */
    const syms = new Map<string, SymMade>();
    const titles = new Set<string>();
    const titleFor = (base: string) => { let t = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Part'; const b0 = t; for (let k = 2; titles.has(t.toLowerCase()); k++) t = `${b0}_${k}`; titles.add(t.toLowerCase()); return t; };
    const symbolFor = (doc: SchDocument, o: SchObject & { kind: 'component' }): SymMade => {
      const made = symbolOf(doc, o.index);
      const objs = made.bags.map((b, i) => (i > 0 ? deriveObject(b, i) : null)).filter((q): q is SchObject => !!q && q.ownerDisplayMode === 0);
      const sections = Math.max(1, o.partCount - 1);
      const sig = `${o.libRef}\u0000${objs.filter((q) => q.kind === 'pin').map((q) => { const pn = q as SchObject & { kind: 'pin' }; return `${pn.designator}@${pn.ownerPartId}:${pn.at.x},${pn.at.y},${pn.orient},${pn.length},${pn.hidden ? 1 : 0}`; }).sort().join('|')}`;
      const had = syms.get(sig);
      if (had) return had;
      const title = titleFor(o.libRef || 'Part');
      const st = new Styles(), ids = new Ids();
      const body: Rec[] = [];
      const parts: string[] = [];
      const pinMaps: Map<string, string>[] = [];
      for (let sct = 1; sct <= sections; sct++) {
        const mine = objs.filter((q) => q.ownerPartId <= 0 || q.ownerPartId === sct);
        const pid = `${title}.${sct}`;
        parts.push(pid);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const see = (q: Pt) => { x0 = Math.min(x0, q.x / U); x1 = Math.max(x1, q.x / U); y0 = Math.min(y0, q.y / U); y1 = Math.max(y1, q.y / U); };
        const recs: Rec[] = [];
        if (sct === 1) {
          recs.push(['ATTR', ids.next(), '', 'Symbol', title, 0, 0, null, null, 0, st.font(null, null, null), 0]);
          recs.push(['ATTR', ids.next(), '', 'Designator', `${(o.designator.replace(/[\d?].*$/, '') || 'U')}?`, 0, 0, null, null, 0, st.font(null, null, null), 0]);
        }
        const pins = new Map<string, string>();
        for (const q of mine) {
          if (q.kind === 'pin') {
            const d = DIR_VECTORS[q.orient & 3]!;
            const hot = { x: q.at.x + d.x * q.length, y: q.at.y + d.y * q.length };
            see(hot); see(q.at);
            const id = ids.next();
            let k = q.designator, n = 2;
            while (pins.has(k)) k = `${q.designator}#${n++}`;
            pins.set(k, id);
            const rot = norm((q.orient & 3) * 90 + 180);
            const elec = [1, 3, 2, 0, 0, 0, 0, 0][q.electrical] ?? 0;
            const type = ['IN', 'BI', 'OUT', '', '', '', '', ''][q.electrical] ?? '';
            // (a hidden pin shown: EasyEDA joins a pin to its net by its wires alone)
            recs.push(['PIN', id, 1, elec, r4(hot.x / U), r4(hot.y / U), r4(q.length / U), rot, null, (q.symbols.outerEdge === 1 ? 2 : 0) | (q.symbols.innerEdge === 3 ? 1 : 0), 0, 1]);
            // Its name inside the body, its number on the pin by the body (as EasyEDA's own symbols place them)
            const into = { x: -d.x, y: -d.y }, vert = d.x === 0;
            const bx = q.at.x / U, by = q.at.y / U;
            const nameAt = vert ? { x: bx + 5.9, y: by + 3.7 * into.y } : { x: bx + 3.7 * into.x, y: by - 5.9 };
            const numAt = vert ? { x: bx + 0.9, y: by - 0.5 * into.y } : { x: bx - 0.5 * into.x, y: by - 0.9 };
            const nameH = (vert ? into.y > 0 : into.x > 0) ? 0 : 2;
            recs.push(['ATTR', ids.next(), id, 'NAME', q.name, 0, q.showName ? 1 : 0, r4(nameAt.x), r4(nameAt.y), vert ? 90 : 0, st.font(null, nameH, 2), 0]);
            recs.push(['ATTR', ids.next(), id, 'NUMBER', q.designator, 0, q.showDesignator ? 1 : 0, r4(numAt.x), r4(numAt.y), vert ? 90 : 0, st.font(null, 2 - nameH, 2), 0]);
            recs.push(['ATTR', ids.next(), id, 'Pin Type', type, 0, 0, null, null, 0, st.font(null, null, null), 0]);
            continue;
          }
          if (q.kind === 'text') {
            if (q.role !== 'label' || !q.text.trim()) continue;
            const f = doc.sheet.fonts[q.font - 1];
            const a = align(q.justify);
            see(q.at);
            recs.push(['TEXT', ids.next(), r4(q.at.x / U), r4(q.at.y / U), (q.orient & 3) * 90, esc(q.text), st.font(fontSize(f?.size ?? 10), a.h, a.v, hex(q.color), f?.bold, f?.italic), 0]);
            continue;
          }
          for (const g of drawing(q, st, ids, see)) recs.push(g);
        }
        if (!Number.isFinite(x0)) { x0 = y0 = -5; x1 = y1 = 5; }
        body.push(['PART', pid, { BBOX: [r4(x0), r4(y0), r4(x1), r4(y1)] }], ...recs);
        pinMaps.push(pins);
      }
      const uuid = uuidOf(`sym:${sig}`);
      files.push({ name: `SYMBOL/${uuid}.esym`, bytes: lines([['DOCTYPE', 'SYMBOL', '1.1'], ['HEAD', { symbolType: 2, originX: 0, originY: 0, maxId: ids.n }], ...st.recs, ...body]) });
      project.symbols[uuid] = { source: '', desc: made.description, tags: TAGS, title, version: '', type: 2 };
      const out: SymMade = { uuid, title, type: 2, parts, pins: pinMaps, description: made.description };
      syms.set(sig, out);
      return out;
    };
    /** A flag's (18) or a net port's (19) symbol, made once. */
    const special = new Map<string, SymMade>();
    const flagSymbol = (style: number): SymMade => {
      const key = `flag:${style}`;
      const had = special.get(key);
      if (had) return had;
      const ground = [4, 5, 6, 8, 9].includes(style);
      const nm = ['Circle', 'Arrow', 'Bar', 'Wave', 'Power Ground', 'Signal Ground', 'Earth', 'GOST Arrow', 'GOST Power Ground', 'GOST Earth', 'GOST Bar'][style] ?? 'Bar';
      const title = titleFor(`${ground ? 'Ground' : 'Power'} ${nm}`);
      const st = new Styles(), ids = new Ids();
      // Drawn from its pin up (a supply), down (a ground): glyph (along, across) in mil
      const s = ground ? -1 : 1;
      const at = ([a, b]: [number, number]) => [r4((-b * s) / 10), r4((a * s) / 10)];
      const g = powerGlyph(style);
      const ls = st.line(null, 0, null, 1);
      const recs: Rec[] = [];
      for (const l of g.lines) recs.push(['POLY', ids.next(), l.flatMap((q) => at(q as [number, number])), false, ls, 0]);
      for (const cc of g.circles ?? []) { const [x, y] = at(cc.c as [number, number]); recs.push(['CIRCLE', ids.next(), x, y, r4(cc.r / 10), ls, 0]); }
      for (const bz of g.beziers ?? []) recs.push(['POLY', ids.next(), bezierPts(bz).flatMap((q) => at(q as [number, number])), false, ls, 0]);
      const pin = ids.next();
      const tip = r4((g.labelAt / 10) * s);
      const body: Rec[] = [
        ['PART', '', { BBOX: [-10, Math.min(0, tip), 10, Math.max(0, tip)] }],
        ['ATTR', ids.next(), '', 'Symbol', title, 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['ATTR', ids.next(), '', 'Global Net Name', '', 0, 1, 0, tip, 0, st.font(null, 1, ground ? 0 : 2), 0],
        ['PIN', pin, 1, 0, 0, 0, 0, ground ? 270 : 90, null, 0, 0, 1],
        ['ATTR', ids.next(), pin, 'NAME', '1', 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['ATTR', ids.next(), pin, 'NUMBER', '1', 0, 0, null, null, 0, st.font(null, null, null), 0],
        ...recs,
      ];
      const uuid = uuidOf(`sym:${key}`);
      files.push({ name: `SYMBOL/${uuid}.esym`, bytes: lines([['DOCTYPE', 'SYMBOL', '1.1'], ['HEAD', { symbolType: 18, originX: 0, originY: 0, maxId: ids.n }], ...st.recs, ...body]) });
      project.symbols[uuid] = { source: '', desc: '', tags: TAGS, title, version: '', type: 18 };
      const out: SymMade = { uuid, title, type: 18, parts: [''], pins: [new Map([['1', pin]])], description: '' };
      special.set(key, out);
      return out;
    };
    const portSymbol = (io: number): SymMade => {
      const key = `port:${io}`;
      const had = special.get(key);
      if (had) return had;
      const type = io === 2 ? 'IN' : io === 1 ? 'OUT' : io === 3 ? 'BI' : '';
      const title = titleFor(io === 2 ? 'Input Port' : io === 1 ? 'Output Port' : io === 3 ? 'Bidirectional Port' : 'Port');
      const st = new Styles(), ids = new Ids();
      const pin = ids.next();
      const body: Rec[] = [
        ['PART', '', { BBOX: [0, -5, 40, 5] }],
        ['ATTR', ids.next(), '', 'Symbol', title, 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['ATTR', ids.next(), '', 'Name', '', 0, 1, 45, 0, 0, st.font(null, 0, 1), 0],
        ['PIN', pin, 1, ({ IN: 1, OUT: 2, BI: 3 } as Record<string, number>)[type] ?? 0, 0, 0, 10, 0, null, 0, 0, 1],
        ['ATTR', ids.next(), pin, 'NAME', type || '1', 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['ATTR', ids.next(), pin, 'NUMBER', '1', 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['ATTR', ids.next(), pin, 'Pin Type', type, 0, 0, null, null, 0, st.font(null, null, null), 0],
        ['POLY', ids.next(), io === 2 ? [10, 0, 15, 5, 40, 5, 40, -5, 15, -5, 10, 0] : io === 1 ? [10, 5, 35, 5, 40, 0, 35, -5, 10, -5, 10, 5] : io === 3 ? [10, 0, 15, 5, 35, 5, 40, 0, 35, -5, 15, -5, 10, 0] : [10, 5, 40, 5, 40, -5, 10, -5, 10, 5], true, st.line(null, 0, null, 1), 0],
      ];
      const uuid = uuidOf(`sym:${key}`);
      files.push({ name: `SYMBOL/${uuid}.esym`, bytes: lines([['DOCTYPE', 'SYMBOL', '1.1'], ['HEAD', { symbolType: 19, originX: 0, originY: 0, maxId: ids.n }], ...st.recs, ...body]) });
      project.symbols[uuid] = { source: '', desc: '', tags: TAGS, title, version: '', type: 19 };
      const out: SymMade = { uuid, title, type: 19, parts: [''], pins: [new Map([['1', pin]])], description: '' };
      special.set(key, out);
      return out;
    };

    let nParts = 0;
    const placed = new Set<string>();
    const pageList: { name: string; id: number; uuid: string }[] = [];
    pages.forEach(({ s, inst, title }, si) => {
      const doc = s.doc, fonts = doc.sheet.fonts;
      const owned = ownedBy(doc);
      const ref = (o: SchObject) => key2(inst, { sheet: s.name, index: o.index });
      const resolve = specialResolver(doc, { docName: s.name, projectName: p.name, projectParams: vars }, true);
      const value = (t: string, owner = -1) => {
        const k = t.trim().toUpperCase();
        if (k === '=SHEETNUMBER') return String(si + 1);
        if (k === '=SHEETTOTAL') return String(pages.length);
        return resolve(t, owner);
      };
      const st = new Styles(), ids = new Ids();
      const recs: Rec[] = [];
      const X = (q: Pt) => [r4(q.x / U), r4(q.y / U)] as const;
      const netOf = (o: SchObject) => { const n = netAt.get(ref(o)); return n ? nameOf.get(n)! : undefined; };
      const textFont = (font: number, j: number, color: number) => { const f = fonts[font - 1]; const a = align(j); return st.font(fontSize(f?.size ?? 10), a.h, a.v, hex(color), f?.bold, f?.italic); };
      /** An instance's attribute: shown where its text is, else unplaced. */
      const attr = (parent: string, key: string, v: string, t?: SchObject & { kind: 'text' }, shown = !!t) => {
        const at = t ? X(t.at) : [null, null];
        recs.push(['ATTR', ids.next(), parent, key, v, 0, shown ? 1 : 0, at[0], at[1], t ? (t.orient & 3) * 90 : 0, t ? textFont(t.font, t.justify, t.color) : st.font(null, null, null), 0]);
      };
      const wires: { id: string; segs: [Pt, Pt][]; net: Rec; labelled: boolean }[] = [];
      /** A wire with its net (a stub, zero long, where a name or a hidden pin wants one where no wire is). */
      const wire = (pts: Pt[], net: string, colour?: number): (typeof wires)[number] => {
        const id = ids.next();
        recs.push(['WIRE', id, [pts.flatMap((q) => X(q))], st.line(colour !== undefined ? hex(colour) : null, 0, null, null), 0]);
        const nr: Rec = ['ATTR', ids.next(), id, 'NET', net, 0, 0, X(pts[0]!)[0], X(pts[0]!)[1], 0, st.font(null, 0, 2), 0];
        recs.push(nr);
        const w = { id, segs: pts.slice(1).map((b, i) => [pts[i]!, b] as [Pt, Pt]), net: nr, labelled: false };
        wires.push(w);
        return w;
      };
      const onSeg = (q: Pt, [a, b]: [Pt, Pt], tol = U / 2) => {
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        const u = L2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
        return Math.hypot(a.x + u * dx - q.x, a.y + u * dy - q.y) <= tol;
      };

      /* Wires first (labels find them) */
      for (const o of doc.objects) {
        if (!isShown(doc, o) || o.kind !== 'wire' || o.pts.length < 2) continue;
        wire(o.pts, netOf(o) ?? '', o.color);
      }
      /* Parts */
      const noErcs = doc.objects.filter((o): o is SchObject & { kind: 'noerc' } => o.kind === 'noerc' && isShown(doc, o));
      const usedNoErc = new Set<SchObject>();
      for (const o of doc.objects) {
        if (o.kind !== 'component' || !isShown(doc, o)) continue;
        const bag = bagOf(doc, o);
        const comp = compAt.get(ref(o));
        const des = comp?.designator || o.designator || 'U?';
        const kind = comp?.kind ?? (bag ? componentKind(bag) : 0);
        const sym = symbolFor(doc, o);
        const sct = Math.max(1, Math.min(o.partId, sym.parts.length));
        const footprint = kind === 2 ? '' : comp?.footprint ?? '';
        const fp = footprint ? libFootprint(footprint) : undefined;
        if (footprint && !fp) note(`Footprints not on the board nor in the project's PCB libraries: parts with them have none (${footprint})`);
        const dev = deviceOf(o.libRef || sym.title, sym.uuid, fp?.uuid ?? '', {
          Designator: `${(des.replace(/[\d?].*$/, '') || 'U')}?`, Name: o.libRef || sym.title,
          ...(kind === 2 ? { 'Convert to PCB': 'no', 'Add into BOM': 'no' } : [1, 3, 4, 5].includes(kind) ? { 'Add into BOM': 'no' } : {}),
        });
        pcbDevice.set(des.toUpperCase(), dev);
        const id = ids.next();
        // EasyEDA turns, then mirrors: AD's mirror-then-turn the other way round when mirrored
        const q = o.mirrored ? (4 - (o.orient & 3)) % 4 : o.orient & 3;
        recs.push(['COMPONENT', id, sym.parts[sct - 1], ...X(o.at), q * 90, o.mirrored ? 1 : 0, {}, 0]);
        const kids = owned.get(o.index) ?? [];
        const texts = kids.filter((k): k is SchObject & { kind: 'text' } => k.kind === 'text');
        const desT = texts.find((t) => t.role === 'designator');
        const comT = texts.find((t) => t.role === 'parameter' && /^comment$/i.test(bagOf(doc, t)?.get('NAME') ?? ''));
        attr(id, 'Symbol', sym.uuid);
        attr(id, 'Device', dev);
        attr(id, 'Designator', des, desT, !!desT && !desT.hidden);
        attr(id, 'Name', comp?.comment ?? (comT ? value(comT.text, o.index) : ''), comT, !!comT && !comT.hidden);
        attr(id, 'Unique ID', uidOf(des));
        for (const t of texts) {
          if (t.role !== 'parameter' || t === comT) continue;
          const nm = bagOf(doc, t)?.get('NAME') ?? '';
          if (!nm || /^(Symbol|Device|Footprint|Designator|Unique ID|Name|NET|Global Net Name|Reuse Block|Group ID|Channel ID|Add into BOM|Convert to PCB|NO_CONNECT)$/i.test(nm)) continue;
          const v = value(t.text, o.index);
          if (!v) continue;
          attr(id, nm, v, t, !t.hidden);
        }
        // Pins with a no-ERC mark on them: EasyEDA's no-connects
        const pinMap = sym.pins[sct - 1] ?? new Map<string, string>();
        const seen = new Map<string, number>();
        for (const k of kids) {
          if (k.kind !== 'pin' || (k.ownerPartId > 0 && k.ownerPartId !== o.partId)) continue;
          const n = seen.get(k.designator) ?? 0;
          seen.set(k.designator, n + 1);
          const pinId = pinMap.get(n ? `${k.designator}#${n + 1}` : k.designator);
          if (!pinId) continue;
          const d = DIR_VECTORS[k.orient & 3]!;
          const hot = { x: k.at.x + d.x * k.length, y: k.at.y + d.y * k.length };
          const nc = noErcs.find((m) => Math.hypot(m.at.x - hot.x, m.at.y - hot.y) < U / 2);
          if (nc) { usedNoErc.add(nc); recs.push(['ATTR', ids.next(), `${id}${pinId}`, 'NO_CONNECT', 'yes', 0, 0, ...X(hot), 0, st.font(null, null, null), 0]); }
          // A hidden pin's net: a stub of its name at its end (EasyEDA joins no pin by a hidden name)
          if (k.hidden) {
            const n2 = netAt.get(ref(k));
            if (n2) { wire([hot, hot], nameOf.get(n2)!); note('Hidden pins written shown, each joined to its net by a wire stub of the net\'s name (EasyEDA joins no pin by a hidden name)'); }
          }
        }
        if (!placed.has(des.toUpperCase())) { placed.add(des.toUpperCase()); nParts++; }
      }
      /* Net labels: the name shown on the wire under it (a stub where no wire, or the wire shows one already) */
      for (const o of doc.objects) {
        if (!isShown(doc, o) || o.kind !== 'text' || o.role !== 'netlabel') continue;
        const nm = netOf(o) ?? o.text;
        let w = wires.find((x) => !x.labelled && x.net[4] === nm && x.segs.some((sg) => onSeg(o.at, sg)));
        if (!w) w = wire([o.at, o.at], nm);
        w.labelled = true;
        const f = fonts[o.font - 1];
        Object.assign(w.net, { 6: 1, 7: X(o.at)[0], 8: X(o.at)[1], 9: (o.orient & 3) * 90, 10: st.font(fontSize(f?.size ?? 10), 0, 2, hex(o.color), f?.bold, f?.italic) });
      }
      /* Power ports, ports, sheet entries, off-sheet connectors: flags and net ports */
      const ends: Pt[] = [];
      for (const o of doc.objects) if (o.kind === 'wire' && isShown(doc, o) && o.pts.length) ends.push(o.pts[0]!, o.pts[o.pts.length - 1]!);
      for (const o of doc.objects) if (o.kind === 'pin' && isShown(doc, o)) { const d = DIR_VECTORS[o.orient & 3]!; ends.push({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length }); }
      const touches = (q: Pt) => ends.some((e) => Math.hypot(e.x - q.x, e.y - q.y) < U / 50);
      const netPort = (at: Pt, orient: number, io: number, net: string) => {
        const sym = portSymbol(io);
        const dev = deviceOf(sym.title, sym.uuid, '', { 'Add into BOM': 'no', 'Convert to PCB': 'no' });
        const id = ids.next();
        recs.push(['COMPONENT', id, '', ...X(at), (orient & 3) * 90, 0, {}, 0]);
        attr(id, 'Symbol', sym.uuid);
        attr(id, 'Device', dev);
        const d = DIR_VECTORS[orient & 3]!;
        recs.push(['ATTR', ids.next(), id, 'Name', net, 0, 1, r4(at.x / U + d.x * 45), r4(at.y / U + d.y * 45), d.x === 0 ? 90 : 0, st.font(null, d.x < 0 || d.y < 0 ? 2 : 0, 1), 0]);
      };
      for (const o of doc.objects) {
        if (!isShown(doc, o)) continue;
        if (o.kind === 'power') {
          const net = netOf(o) ?? o.text;
          if (o.crossSheet) { netPort(o.at, o.orient, 0, net); continue; }
          const sym = flagSymbol(o.style);
          const dev = deviceOf(sym.title, sym.uuid, '', { 'Add into BOM': 'no', 'Convert to PCB': 'no' });
          const ground = [4, 5, 6, 8, 9].includes(o.style);
          const id = ids.next();
          recs.push(['COMPONENT', id, '', ...X(o.at), norm((o.orient & 3) * 90 - (ground ? 270 : 90)), 0, {}, 0]);
          attr(id, 'Symbol', sym.uuid);
          attr(id, 'Device', dev);
          const d = DIR_VECTORS[o.orient & 3]!, g = powerGlyph(o.style).labelAt / 10 + 1;
          recs.push(['ATTR', ids.next(), id, 'Global Net Name', net, 0, o.showText ? 1 : 0, r4(o.at.x / U + d.x * g), r4(o.at.y / U + d.y * g), 0,
            st.font(null, d.x > 0 ? 0 : d.x < 0 ? 2 : 1, d.y > 0 ? 2 : d.y < 0 ? 0 : 1), 0]);
          recs.push(['ATTR', ids.next(), id, 'Name', net, 0, 0, null, null, 0, st.font(null, null, null), 0]);
          continue;
        }
        if (o.kind === 'port') {
          const net = netOf(o);
          const vertical = o.style >= 4;
          const far = vertical ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y };
          if (!net) { for (const g of drawing({ ...o, kind: 'rect', a: o.at, b: vertical ? { x: o.at.x + o.height, y: far.y } : { x: far.x, y: o.at.y + o.height }, width: U, color: o.color, fill: o.fill, solid: false, r: 0, ry: 0, transparent: true } as SchObject, st, ids)) recs.push(g); note('Ports on no net (harness ports) drawn only'); continue; }
          const atFar = touches(far) && !touches(o.at);
          netPort(atFar ? far : o.at, vertical ? (atFar ? 3 : 1) : (atFar ? 2 : 0), o.io, net);
          continue;
        }
        if (o.kind === 'sheetentry') {
          const at = entryPoint(doc, o), net = netOf(o);
          if (!at || !net) continue;
          // Pointing out of its sheet symbol
          const out = o.side === 1 ? 0 : o.side === 2 ? 1 : o.side === 3 ? 3 : 2;
          netPort(at, out, o.io, net);
          note('Sheet symbols drawn, their entries as net ports with their nets\' names (EasyEDA\'s nets are the whole schematic\'s)');
          continue;
        }
      }
      /* Buses, text, drawings */
      for (const o of doc.objects) {
        if (!isShown(doc, o)) continue;
        if (o.owner >= 0 && doc.objects[o.owner]?.kind === 'component') continue;
        switch (o.kind) {
          case 'bus': {
            if (o.pts.length < 2) break;
            const id = ids.next();
            recs.push(['BUS', id, [o.pts.flatMap((q) => X(q))], st.line(hex(o.color), 0, null, null), 0]);
            const lbl = doc.objects.find((t) => t.kind === 'text' && t.role === 'netlabel' && isShown(doc, t) && o.pts.slice(1).some((b, i) => onSeg((t as { at: Pt }).at, [o.pts[i]!, b])));
            recs.push(['ATTR', ids.next(), id, 'NET', lbl && lbl.kind === 'text' ? lbl.text : '', 0, 0, ...X(o.pts[0]!), 0, st.font(null, 0, 2), 0]);
            break;
          }
          case 'busentry': for (const g of drawing({ ...o, kind: 'polyline', pts: [o.a, o.b], style: 0 } as SchObject, st, ids)) recs.push(g); break;
          case 'text':
            if ((o.role === 'label' && o.owner < 0) || ((o.role === 'sheetname' || o.role === 'filename') && o.text.trim())) {
              const t = o.role === 'label' ? value(o.text) : o.text;
              if (t.trim()) recs.push(['TEXT', ids.next(), ...X(o.at), (o.orient & 3) * 90, esc(t), textFont(o.font, o.justify, o.color), 0]);
            }
            break;
          case 'sheetsymbol': for (const g of drawing({ ...o, kind: 'rect', a: o.at, b: { x: o.at.x + o.w, y: o.at.y - o.h }, solid: false, r: 0, ry: 0, transparent: true } as SchObject, st, ids)) recs.push(g); break;
          case 'textframe': {
            const a = { x: Math.min(o.a.x, o.b.x), y: Math.max(o.a.y, o.b.y) };
            if (o.border || o.solid) for (const g of drawing({ kind: 'rect', a: o.a, b: o.b, width: o.width, color: o.color, fill: o.fill, solid: o.solid, r: 0, ry: 0, transparent: !o.solid } as SchObject, st, ids)) recs.push(g);
            const em = ((fonts[o.font - 1]?.size ?? 10) * 5 / 0.716) * 10_000;
            o.text.split(/~1|\r?\n/).forEach((ln, i) => { if (ln.trim()) recs.push(['TEXT', ids.next(), ...X({ x: a.x + o.margin, y: a.y - o.margin - em * (i + 0.85) }), 0, esc(value(ln)), textFont(o.font, 0, o.textColor), 0]); });
            break;
          }
          case 'noerc': if (!usedNoErc.has(o)) note('No-ERC marks off pins left out (EasyEDA marks pins)'); break;
          case 'image': note('Images left out'); break;
          case 'harness': case 'harnessentry': case 'signalharness': note('Harnesses left out (their nets are kept by their names)'); break;
          case 'directive': case 'compilemask': case 'blanket': note('Directives left out'); break;
          case 'ieee': note('IEEE symbols left out'); break;
          case 'polyline': case 'polygon': case 'rect': case 'ellipse': case 'arc': case 'bezier': case 'piechart':
            for (const g of drawing(o, st, ids)) recs.push(g);
            break;
          default:
        }
      }
      const pageNo = si + 1;
      const uuid = uuidOf(`page:${title}:${si}`);
      files.push({ name: `SHEET/${schUuid}/${pageNo}.esch`, bytes: lines([['DOCTYPE', 'SCH', '1.1'], ['HEAD', { originX: 0, originY: 0, maxId: ids.n }], ...st.recs, ...recs]) });
      pageList.push({ name: title, id: pageNo, uuid });
    });
    project.schematics[schUuid] = { name, sheets: pageList };
    return { pages: pages.length, parts: nParts, nets: c.nets.length };
  }

  /* ── the board ── */
  let pcbStats = { layers: 0, components: 0, nets: 0 };
  if (p.board) pcbStats = writeBoard(p.board);

  function writeBoard(doc: PcbDocument) {
    const o = doc.board.origin;
    // (a footprint's points are in its own frame: no origin to take off)
    let org = o;
    const X = (q: Pt) => r4((q.x - org.x) / 10000), Y = (q: Pt) => r4((q.y - org.y) / 10000);
    const XY = (q: Pt) => [X(q), Y(q)];
    const len = (v: number) => r4(v / 10000);
    const netName = (i: number) => (i === NO_NET || i < 0 ? '' : doc.nets[i]?.name ?? '');

    /* Layers: the copper stack, then the rest by kind and name */
    const stack = doc.board.copperStack.length >= 2 ? doc.board.copperStack : [L.TOP, L.BOTTOM];
    const inner = new Map<LayerId, number>();
    stack.slice(1, -1).forEach((l, i) => { if (i < 32) inner.set(l, 15 + i); else note('Copper layers past EasyEDA\'s 32 inner layers left out'); });
    const copperIds = new Set<number>([1, 2, ...inner.values()]);
    const custom = new Map<LayerId, number>();
    const NAMED: Record<string, number> = { document: 13, mechanical: 14, 'component shape': 48, 'component marking': 49, 'pin soldering': 50, 'pin floating': 51, 'component model': 52, 'top stiffener': 58, 'bottom stiffener': 59, 'top assembly': 9, 'bottom assembly': 10 };
    const mechTo = (l: LayerId): number | null => {
      const nm = (doc.board.layerNames.get(l) ?? '').trim();
      if (/^board outline$/i.test(nm)) return -1;
      const named = NAMED[nm.toLowerCase()];
      if (named) return named;
      if (/assembly|assy/i.test(nm)) return /bot/i.test(nm) ? 10 : 9;
      if (/courtyard/i.test(nm) && !/bot/i.test(nm)) return 48;
      let c = custom.get(l);
      if (!c) { if (custom.size >= 30) { note('Mechanical layers past EasyEDA\'s 30 custom layers left out'); return null; } c = 71 + custom.size; custom.set(l, c); }
      return c;
    };
    const layerOf = (l: LayerId): number | null => {
      if (l === L.TOP || l === stack[0]) return 1;
      if (l === L.BOTTOM || l === stack.at(-1)) return 2;
      const i = inner.get(l);
      if (i) return i;
      switch (l) {
        case L.TOP_OVERLAY: return 3; case L.BOTTOM_OVERLAY: return 4; case L.TOP_SOLDER: return 5; case L.BOTTOM_SOLDER: return 6;
        case L.TOP_PASTE: return 7; case L.BOTTOM_PASTE: return 8; case L.MULTI: return 12; case L.DRILL_DRAWING: return 56;
        default: return isMech(l) ? mechTo(l) : null;
      }
    };
    /** A primitive's layer, or null (noted) when EasyEDA has none of it; -1 the board outline's mechanical layer (the board's shape is written from the board). */
    const layerFor = (l: LayerId, what: string): number | null => {
      const id = layerOf(l);
      if (id === null) note(`${what} on layers EasyEDA has none of left out`);
      return id;
    };

    /* Paths: a ring of points, the board's vertices (arcs kept) */
    const ringPath = (pts: Pt[]) => { const out: (number | string)[] = [...XY(pts[0]!), 'L']; for (const q of [...pts.slice(1), pts[0]!]) out.push(...XY(q)); return out; };
    const vertexPath = (vs: PolyVertex[]) => {
      const out: (number | string)[] = [...XY(vs[0]!.p)];
      let lastL = false;
      vs.forEach((v, i) => {
        const nx = vs[(i + 1) % vs.length]!;
        if (v.arc) {
          const a0 = (Math.atan2(v.p.y - v.arc.c.y, v.p.x - v.arc.c.x) * 180) / Math.PI;
          const a1 = (Math.atan2(nx.p.y - v.arc.c.y, nx.p.x - v.arc.c.x) * 180) / Math.PI;
          const ccw = Math.abs(norm(a0) - norm(v.arc.sa)) < 0.5;
          const sw = ccw ? norm(a1 - a0) || 360 : -(norm(a0 - a1) || 360);
          out.push('ARC', r4(sw), ...XY(nx.p));
          lastL = false;
        } else { if (!lastL) out.push('L'); out.push(...XY(nx.p)); lastL = true; }
      });
      return out;
    };
    const arcPath = (c: Pt, r: number, start: number, end: number) => {
      const span = norm(end - start) || 360;
      if (span >= 359.999) return ['CIRCLE', X(c), Y(c), len(r)];
      const at = (a: number) => ({ x: c.x + r * Math.cos((a * Math.PI) / 180), y: c.y + r * Math.sin((a * Math.PI) / 180) });
      return [...XY(at(start)), 'ARC', r4(span), ...XY(at(start + span))];
    };
    const fillRect = (q: Extract<PcbPrim, { kind: 'fill' }>): Pt[] => {
      const c = { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 }, hw = Math.abs(q.b.x - q.a.x) / 2, hh = Math.abs(q.b.y - q.a.y) / 2;
      const r = (q.rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({ x: c.x + dx! * cs - dy! * sn, y: c.y + dx! * sn + dy! * cs }));
    };

    /* The design rules' defaults (EasyEDA keeps them in mil) */
    const general = (kind: string) => doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r) && /^\s*All\s*$/i.test(ruleScope1(r)) && /^\s*All\s*$/i.test(ruleScope2(r) || 'All'))[0];
    const clr = general('Clearance'), wid = general('Width'), via = general('RoutingVias'), smask = general('SolderMaskExpansion'), pmask = general('PasteMaskExpansion');
    const gap = len(clr ? ruleLength(clr, 'GAP', '10mil') : mil(10));
    const tw = wid ? [ruleLength(wid, 'MINLIMIT', '10mil'), ruleLength(wid, 'PREFEREDWIDTH', '10mil'), ruleLength(wid, 'MAXLIMIT', '10mil')].map(len) : [6, 10, 100];
    const vd = via ? [ruleLength(via, 'MINWIDTH', '50mil'), ruleLength(via, 'WIDTH', '50mil'), ruleLength(via, 'MAXWIDTH', '50mil'), ruleLength(via, 'MINHOLEWIDTH', '28mil'), ruleLength(via, 'HOLEWIDTH', '28mil'), ruleLength(via, 'MAXHOLEWIDTH', '28mil')].map(len) : [12, 24, 100, 6, 12, 60];
    const maskX = len(smask ? ruleLength(smask, 'EXPANSION', '4mil') : mil(4)), pasteX = len(pmask ? ruleLength(pmask, 'EXPANSION', '0mil') : 0);

    /* Pads: their shape, hole, mask and paste */
    const padRec = (q: PcbPad, id: string, net: string, at: Pt, rot: number): Rec | null => {
      const multi = q.layer === L.MULTI;
      const layer = multi ? 12 : q.layer === L.TOP ? 1 : q.layer === L.BOTTOM ? 2 : null;
      if (layer === null) { note('Pads on inner layers left out'); return null; }
      if (q.jumper) note('Jumpers (pads joined by a Jumper ID) have no EasyEDA counterpart: their pads are left unjoined');
      const sh = multi ? q.top : q.layer === L.BOTTOM && q.bot.w ? q.bot : q.top;
      if (multi && (q.mid.w !== q.top.w || q.mid.h !== q.top.h || q.bot.w !== q.top.w || q.bot.h !== q.top.h || q.bot.shape !== q.top.shape)) note('Pads with other sizes on their inner or bottom layers: written with their top size');
      let w = sh.w, h = sh.h;
      const bare = q.hole > 0 && w <= q.hole && h <= q.hole && !q.plated;
      if (bare) w = h = 0;
      let shape: Rec;
      if (sh.shape === 'rect') shape = ['RECT', len(w), len(h), 0];
      else if (sh.shape === 'roundrect') shape = ['RECT', len(w), len(h), r4(sh.cornerPct)];
      else if (sh.shape === 'octagon' && Math.abs(w - h) < 2) shape = ['NGON', len(w), 8];
      else if (sh.shape === 'octagon') {
        const cut = Math.min(w, h) / 4, hw = w / 2, hh = h / 2;
        const r = (rot * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
        const ring = [[hw - cut, hh], [-hw + cut, hh], [-hw, hh - cut], [-hw, -hh + cut], [-hw + cut, -hh], [hw - cut, -hh], [hw, -hh + cut], [hw, hh - cut]].map(([dx, dy]) => ({ x: at.x + dx! * cs - dy! * sn, y: at.y + dx! * sn + dy! * cs }));
        shape = ['POLY', ringPath(ring)];
      } else shape = Math.abs(w - h) < 2 ? ['ELLIPSE', len(w), len(h)] : ['OVAL', len(w), len(h)];
      const slot = q.slot && q.slot.length > q.hole + 1 ? q.slot : undefined;
      const hole: Rec | null = q.hole > 0 ? (slot ? ['SLOT', len(slot.length), len(q.hole)] : ['ROUND', len(q.hole), len(q.hole)]) : null;
      const raw = (fpDoc ?? doc).streams.get(q.src.storage)?.records[q.src.index]?.subs[4];
      const maskMode = raw ? get(raw, PAD.solderMode) : 0, pasteMode = raw ? get(raw, PAD.pasteMode) : 0;
      const mask = raw && maskMode === 2 ? len(get(raw, PAD.solderManual) ?? 0) : null;
      const paste = !multi && raw && pasteMode === 2 ? len(get(raw, PAD.pasteManual) ?? 0) : null;
      return ['PAD', id, 0, net, layer, q.name, ...XY(at), r4(norm(rot)), hole, shape, [], 0, 0, slot ? r4(norm(slot.rotation)) : 0, q.hole > 0 ? (q.plated ? 1 : 0) : 1, 0, mask, mask, paste, paste, q.locked ? 1 : 0];
    };
    let fpDoc: PcbDocument | undefined;

    /** A primitive as EasyEDA's records: a footprint's (in its frame, no nets) or the board's. */
    const primRecs = (q: PcbPrim, ids: Ids, inFp: boolean): Rec[] => {
      const lk = 'locked' in q && q.locked ? 1 : 0;
      switch (q.kind) {
        case 'track': case 'arc': {
          if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) return [];
          if (isPlane(q.layer)) { note('Split lines on internal planes left out (the planes are written as pours of their copper)'); return []; }
          if (q.layer === L.KEEPOUT || q.keepout) { note('Keep-out lines left out (EasyEDA keeps out by regions)'); return []; }
          const layer = layerFor(q.layer, 'Lines');
          if (layer === null || layer < 0) return [];
          const copper = copperIds.has(layer) && !inFp;
          if (q.kind === 'track') return copper ? [['LINE', ids.next(), 0, netName(q.net), layer, ...XY(q.a), ...XY(q.b), len(q.width), lk]] : [['POLY', ids.next(), 0, '', layer, len(q.width), [...XY(q.a), 'L', ...XY(q.b)], lk]];
          const span = norm(q.end - q.start) || 360;
          if (!copper) return [['POLY', ids.next(), 0, '', layer, len(q.width), arcPath(q.c, q.r, q.start, q.end), lk]];
          const at = (a: number) => ({ x: q.c.x + q.r * Math.cos((a * Math.PI) / 180), y: q.c.y + q.r * Math.sin((a * Math.PI) / 180) });
          // A whole circle: two halves (an arc ends where it starts)
          const parts = span >= 359.999 ? [[q.start, 180], [q.start + 180, 180]] : [[q.start, span]];
          return parts.map(([a, s]) => ['ARC', ids.next(), 0, netName(q.net), layer, ...XY(at(a!)), ...XY(at(a! + s!)), r4(s!), len(q.width), lk]);
        }
        case 'via': {
          if ((q.layerStart !== L.TOP && q.layerStart !== stack[0]) || (q.layerEnd !== L.BOTTOM && q.layerEnd !== stack.at(-1))) note('Blind and buried vias written as through vias');
          return [['VIA', ids.next(), 0, inFp ? '' : netName(q.net), '', ...XY(q.at), len(q.hole), len(q.diameter), 0, null, null, lk]];
        }
        case 'pad': { const r = padRec(q, ids.next(), inFp ? '' : netName(q.net), q.at, q.rotation); return r ? [r] : []; }
        case 'fill': {
          if (isPlane(q.layer)) { note('Shapes on internal planes left out (the planes are written as pours of their copper)'); return []; }
          const pts = fillRect(q);
          if (q.layer === L.KEEPOUT || q.keepout) return keepout(pts, q.layer, ids);
          const layer = layerFor(q.layer, 'Fills');
          if (layer === null || layer < 0) return [];
          return [['FILL', ids.next(), 0, copperIds.has(layer) && !inFp ? netName(q.net) : '', layer, 0, 0, [ringPath(pts)], lk]];
        }
        case 'region': {
          if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) return [];
          if (q.padShape) return [];
          if (q.boardCutout) return [['FILL', ids.next(), 0, '', 12, 0, 0, [ringPath(q.outline)], lk]];
          if (q.layer === L.KEEPOUT || q.keepout) return keepout(q.outline, q.layer, ids);
          if (isPlane(q.layer)) { note('Shapes on internal planes left out (the planes are written as pours of their copper)'); return []; }
          const layer = layerFor(q.layer, 'Regions');
          if (layer === null || layer < 0) return [];
          if (q.regionKind === 1) return copperIds.has(layer) ? [['REGION', ids.next(), 0, layer, 0, [7], [ringPath(q.outline)], 0]] : [];
          if (q.regionKind !== 0) return [];
          return [['FILL', ids.next(), 0, copperIds.has(layer) && !inFp ? netName(q.net) : '', layer, 0, 0, [ringPath(q.outline), ...q.holes.filter((h) => h.length >= 3).map(ringPath)], lk]];
        }
        case 'text': {
          if (q.isDesignator || q.isComment) return [];
          return textRecs(q, ids);
        }
        default: return [];
      }
    };
    function textRecs(t: PcbText, ids: Ids): Rec[] {
      const layer = layerFor(t.layer, 'Text');
      if (layer === null || layer < 0 || layer === 12) { if (layer === 12) note('Text on the Multi-Layer left out'); return []; }
      if (t.fontType === 2) note('Barcode text written as plain text');
      const tt = t.fontType === 1;
      return [['STRING', ids.next(), 0, layer, ...XY(t.at), t.text, tt ? t.fontName : 'default', len(tt ? t.height : t.height / 0.7), len(Math.max(t.strokeWidth, mil(1))), t.bold ? 1 : 0, t.italic ? 1 : 0, 3, r4(norm(t.rotation)), 0, 0, t.mirrored ? 1 : 0, 0]];
    }
    /** A keep-out: a region keeping copper (tracks, vias, fills, pours) out of the copper it's on, or all of it. */
    function keepout(pts: Pt[], layer: LayerId, ids: Ids): Rec[] {
      const on = layer === L.KEEPOUT ? 12 : layerOf(layer);
      if (on === null || (on !== 12 && !copperIds.has(on))) return [];
      note('Keep-outs written as keep-out regions');
      return [['REGION', ids.next(), 0, on, 0, [5, 3, 6, 7], [ringPath(pts)], 0]];
    }

    /* ── footprints ── */
    const fpPads = new Map<string, Map<string, string>>();   // footprint → its pads (name#n) → ids
    const fpLayerRows = (): Rec[] => [[1, 'TOP', 'Top Layer'], [2, 'BOTTOM', 'Bottom Layer'], [3, 'TOP_SILK', 'Top Silkscreen Layer'], [4, 'BOT_SILK', 'Bottom Silkscreen Layer'],
      [5, 'TOP_SOLDER_MASK', 'Top Solder Mask Layer'], [6, 'BOT_SOLDER_MASK', 'Bottom Solder Mask Layer'], [7, 'TOP_PASTE_MASK', 'Top Paste Mask Layer'], [8, 'BOT_PASTE_MASK', 'Bottom Paste Mask Layer'],
      [9, 'TOP_ASSEMBLY', 'Top Assembly Layer'], [10, 'BOT_ASSEMBLY', 'Bottom Assembly Layer'], [11, 'OUTLINE', 'Board Outline Layer'], [12, 'MULTI', 'Multi-Layer'],
      [13, 'DOCUMENT', 'Document Layer'], [14, 'MECHANICAL', 'Mechanical Layer'], [48, 'COMPONENT_SHAPE', 'Component Shape Layer'], [49, 'COMPONENT_MARKING', 'Component Marking Layer'],
      [50, 'PIN_SOLDERING', 'Pin Soldering Layer'], [51, 'PIN_FLOATING', 'Pin Floating Layer'], [56, 'DRILL_DRAWING', 'Drill Drawing Layer']].map(([id, t, n]) => ['LAYER', id, t, n, 3, COLOURS[id as number] ?? '#999999', 1, COLOURS[id as number] ?? '#999999', 0.5]);
    for (const [, f] of fps) {
      const ids = new Ids();
      const recs: Rec[] = [];
      const pads = new Map<string, string>();
      fpDoc = f.doc;
      org = { x: 0, y: 0 };
      const seen = new Map<string, number>();
      for (const q of f.prims) {
        if (q.kind === 'body') continue;
        const r = primRecs(q, ids, true);
        if (q.kind === 'pad' && r.length) {
          const n = seen.get(q.name) ?? 0;
          seen.set(q.name, n + 1);
          pads.set(`${q.name}#${n}`, String(r[0]![1]));
        }
        recs.push(...r);
      }
      fpDoc = undefined;
      org = o;
      fpPads.set(f.uuid, pads);
      const title = f.doc.name;
      recs.push(['ATTR', ids.next(), 0, '', 3, null, null, 'Footprint', title, 0, 0, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0]);
      recs.push(['ATTR', ids.next(), 0, '', 3, null, null, 'Designator', 'U?', 0, 0, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0]);
      files.push({ name: `FOOTPRINT/${f.uuid}.efoo`, bytes: lines([['DOCTYPE', 'FOOTPRINT', '1.8'], ['CANVAS', 0, 0, 'mil', 5, 5], ...fpLayerRows(), ...recs]) });
      project.footprints[f.uuid] = { title, source: '', version: '', type: 4, desc: '', tags: TAGS };
    }

    /* ── the board's records ── */
    const ids = new Ids();
    const body: Rec[] = [];
    // The board shape: its edges on Board Outline
    const vs = doc.board.vertices.length ? doc.board.vertices : doc.board.outline.map((q): PolyVertex => ({ p: q }));
    if (vs.length >= 2) body.push(['POLY', ids.next(), 0, '', 11, 10, vertexPath(vs), 0]);
    // The parts: placed footprints, their pads' nets, designator and comment
    const byComp = new Map<number, PcbPrim[]>();
    for (const q of doc.prims) if ('component' in q && q.component !== NO_NET && q.component >= 0 && q.component !== 0xffff) byComp.set(q.component, [...(byComp.get(q.component) ?? []), q]);
    let nComps = 0;
    for (const c of doc.components) {
      const f = fps.get(c.pattern.toLowerCase());
      if (!f) { note('Components of no footprint left out'); continue; }
      const id = ids.next();
      const bottom = c.layer === L.BOTTOM;
      const prims = byComp.get(c.index) ?? [];
      const des = prims.find((q): q is PcbText => q.kind === 'text' && q.isDesignator);
      const com = prims.find((q): q is PcbText => q.kind === 'text' && q.isComment);
      const comment = com?.text ?? c.bag.get('SOURCEDESCRIPTION') ?? '';
      body.push(['COMPONENT', id, 0, bottom ? 2 : 1, ...XY(c.at), r4(norm(c.rotation)), { Name: comment, 'Unique ID': uidOf(c.designator) }, c.bag.get('LOCKED') === 'TRUE' ? 1 : 0]);
      const dev = pcbDevice.get(c.designator.toUpperCase()) ?? deviceOf(c.bag.get('SOURCELIBREFERENCE') || c.pattern, '', f.uuid, { Designator: `${c.designator.replace(/[\d?].*$/, '') || 'U'}?`, Name: c.pattern });
      const attr = (key: string, v: string, t: PcbText | undefined, shown: boolean) => {
        const layer = t ? layerOf(t.layer) ?? (bottom ? 4 : 3) : bottom ? 4 : 3;
        body.push(['ATTR', ids.next(), 0, id, layer < 0 ? (bottom ? 4 : 3) : layer, t ? X(t.at) : null, t ? Y(t.at) : null, key, v, 0, shown ? 1 : 0, t?.fontType === 1 ? t.fontName : 'default',
          t ? len(t.fontType === 1 ? t.height : t.height / 0.7) : 45, t ? len(Math.max(t.strokeWidth, mil(1))) : 6, t?.bold ? 1 : 0, t?.italic ? 1 : 0, 3, t ? r4(norm(t.rotation)) : 0, 0, 0, t?.mirrored ? 1 : 0, 0]);
      };
      attr('Footprint', f.uuid, undefined, false);
      attr('Device', dev, undefined, false);
      attr('Designator', c.designator, des, c.nameOn && !!des && !des.hidden);
      attr('Name', comment, com, c.commentOn && !!com && !com.hidden);
      // Its pads' nets (by pad, as the footprint numbers them)
      const pads = fpPads.get(f.uuid)!;
      const seen = new Map<string, number>();
      for (const q of prims) {
        if (q.kind !== 'pad') continue;
        const n = seen.get(q.name) ?? 0;
        seen.set(q.name, n + 1);
        const pid = pads.get(`${q.name}#${n}`);
        if (pid) body.push(['PAD_NET', id, q.name, netName(q.net), pid]);
      }
      nComps++;
    }
    // The board's own primitives
    for (const q of doc.prims) {
      if ('component' in q && q.component !== NO_NET && q.component >= 0 && q.component !== 0xffff) continue;
      if (q.kind === 'body') continue;
      body.push(...primRecs(q, ids, false));
    }
    // Dimensions: their lines, arcs and value
    const edgeOf = dimensionEdges(doc.prims);
    for (const d of doc.dimensions) {
      const layer = layerOf(d.layer);
      if (layer === null || layer < 0) continue;
      const g = dimensionGeometry(d, false, edgeOf);
      for (const l of g.lines) body.push(['POLY', ids.next(), 0, '', layer, len(l.w), [...XY(l.a), 'L', ...XY(l.b)], 0]);
      for (const a of g.arcs) body.push(['POLY', ids.next(), 0, '', layer, len(a.w), arcPath(a.c, a.r, a.start, a.end), 0]);
      for (const t of g.texts) body.push(['STRING', ids.next(), 0, layer, ...XY(t.at), t.text, 'default', len(t.height / 0.7), len(t.w), 0, 0, 3, r4(norm(t.rotation)), 0, 0, t.mirrored ? 1 : 0, 0]);
    }
    if (doc.dimensions.length) note('Dimensions written as their lines and text');
    // Polygon pours, with their poured copper (EasyEDA's at a tenth of the board's scale)
    const poured: Rec[] = [];
    const ten = (q: Pt) => [r4((q.x - o.x) / 100000), r4((q.y - o.y) / 100000)];
    const tenRing = (pts: Pt[]) => { const out: (number | string)[] = [...ten(pts[0]!), 'L']; for (const q of [...pts.slice(1), pts[0]!]) out.push(...ten(q)); return out; };
    const pourCopper = new Map<number, PcbPrim[]>();
    for (const q of doc.prims) if ((q.kind === 'region' || q.kind === 'track' || q.kind === 'arc') && q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) pourCopper.set(q.polygon, [...(pourCopper.get(q.polygon) ?? []), q]);
    let order = 0;
    const pour = (layer: number, net: string, outline: Pt[], width: number, nm: string, keepIslands: boolean, hatch: boolean, copper: PcbPrim[]) => {
      const id = ids.next();
      body.push(['POUR', id, 0, net, layer, len(width), nm, order++, [ringPath(outline)], hatch ? ['LINE', 0, 45, len(width), 20] : ['SOLID', 0], keepIslands ? 1 : 0, 0]);
      for (const q of copper) {
        if (q.kind === 'region') poured.push(['POURED', ids.next(), id, 0, true, [tenRing(q.outline), ...q.holes.filter((h) => h.length >= 3).map(tenRing)]]);
        else if (q.kind === 'track') poured.push(['POURED', ids.next(), id, r4(q.width / 100000), false, [[...ten(q.a), 'L', ...ten(q.b)]]]);
      }
    };
    for (const pg of [...doc.polygons].sort((a, b) => a.bag.int('POURINDEX', a.index) - b.bag.int('POURINDEX', b.index))) {
      if (pg.type && !/^polygon$/i.test(pg.type)) continue;
      const layer = layerOf(pg.layer);
      if (layer === null || layer < 0 || !copperIds.has(layer) || pg.outline.length < 3) continue;
      const removeDead = (pg.bag.get('REMOVEDEAD') ?? 'TRUE').toUpperCase() !== 'FALSE';
      const hatch = !!pg.hatch && !/^solid$/i.test(pg.hatch);
      pour(layer, netName(pg.net), pg.outline, Number.parseFloat(pg.bag.get('TRACKWIDTH') ?? '8') * 10000 || mil(8), pg.name || `Pour${order + 1}`, !removeDead, hatch, pourCopper.get(pg.index) ?? []);
    }
    // Internal planes: pours of their copper on inner layers
    for (const l of stack.filter(isPlane)) {
      const layer = inner.get(l);
      if (!layer) continue;
      const areas = planeCopper(doc, l);
      for (const a of areas) for (const r of a.regions) {
        pour(layer, netName(a.net), r.outline, mil(8), `${doc.board.layerNames.get(l) ?? 'Plane'} ${netName(a.net)}`.trim(), true, false,
          [{ kind: 'region', src: { storage: '', index: -1 }, layer: l, outline: r.outline, holes: r.holes, regionKind: 0, boardCutout: false, net: a.net, polygon: -1, component: -1, locked: false, keepout: false }]);
      }
      if (areas.length) note('Internal planes written as pours of their copper on inner signal layers');
    }

    /* The layers, the stack, the nets, the rules */
    const rows = doc.board.bag ? readStack(doc.board.bag, stack) : [];
    const copperRows = rows.filter((r) => r.kind === 'signal' || r.kind === 'plane');
    const dielRows = rows.filter((r) => r.kind === 'dielectric');
    const head: Rec[] = [['DOCTYPE', 'PCB', '1.7'], ['CANVAS', 0, 0, 'mil', 5, 5, 5, 5, 5, 5, 2]];
    for (const [id, t, n] of [[1, 'TOP', 'Top Layer'], [2, 'BOTTOM', 'Bottom Layer'], [3, 'TOP_SILK', 'Top Silkscreen Layer'], [4, 'BOT_SILK', 'Bottom Silkscreen Layer'],
      [5, 'TOP_SOLDER_MASK', 'Top Solder Mask Layer'], [6, 'BOT_SOLDER_MASK', 'Bottom Solder Mask Layer'], [7, 'TOP_PASTE_MASK', 'Top Paste Mask Layer'], [8, 'BOT_PASTE_MASK', 'Bottom Paste Mask Layer'],
      [9, 'TOP_ASSEMBLY', 'Top Assembly Layer'], [10, 'BOT_ASSEMBLY', 'Bottom Assembly Layer'], [11, 'OUTLINE', 'Board Outline Layer'], [12, 'MULTI', 'Multi-Layer'],
      [13, 'DOCUMENT', 'Document Layer'], [14, 'MECHANICAL', 'Mechanical Layer']] as [number, string, string][]) {
      head.push(['LAYER', id, t, id === 1 || id === 2 ? doc.board.layerNames.get(id === 1 ? stack[0]! : stack.at(-1)!) ?? n : n, 3, COLOURS[id] ?? '#999999', 1, COLOURS[id] ?? '#999999', 0.5]);
    }
    for (let i = 0; i < 32; i++) {
      const l = [...inner].find(([, v]) => v === 15 + i)?.[0];
      head.push(['LAYER', 15 + i, 'SIGNAL', l !== undefined ? doc.board.layerNames.get(l) ?? `Inner${i + 1}` : `Inner${i + 1}`, l !== undefined ? 3 : 0, INNER[i % INNER.length]!, 1, INNER[i % INNER.length]!, 0.5]);
    }
    for (const [id, t, n] of [[47, 'HOLE', 'Hole Layer'], [48, 'COMPONENT_SHAPE', 'Component Shape Layer'], [49, 'COMPONENT_MARKING', 'Component Marking Layer'], [50, 'PIN_SOLDERING', 'Pin Soldering Layer'],
      [51, 'PIN_FLOATING', 'Pin Floating Layer'], [52, 'COMPONENT_MODEL', 'Component Model Layer'], [56, 'DRILL_DRAWING', 'Drill Drawing Layer'], [57, 'OTHER', 'Ratline Layer'],
      [58, 'TOP_STIFFENER', 'Top Stiffener Layer'], [59, 'BOTTOM_STIFFENER', 'Bottom Stiffener Layer']] as [number, string, string][]) head.push(['LAYER', id, t, n, id === 57 ? 7 : 3, COLOURS[id] ?? '#999999', 1, COLOURS[id] ?? '#999999', 0.5]);
    for (const [l, id] of custom) head.push(['LAYER', id, 'CUSTOM', doc.board.layerNames.get(l) ?? `Mechanical ${mechNumber(l)}`, 3, INNER[(id - 71) % INNER.length]!, 1, INNER[(id - 71) % INNER.length]!, 0.5]);
    const nDiel = stack.length - 1;
    for (let i = 0; i < nDiel; i++) head.push(['LAYER', 101 + i, 'SUBSTRATE', `Dielectric${i + 1}`, 0, '#000000', 0, '#000000', 0]);
    // The stack top to bottom: each copper layer's thickness, the dielectric under it (mil)
    stack.forEach((l, i) => {
      const cid = i === 0 ? 1 : i === stack.length - 1 ? 2 : inner.get(l);
      if (cid === undefined) return;
      const cr = copperRows.find((r) => r.layer === l);
      head.push(['LAYER_PHYS', cid, null, r4((cr?.copper ?? mil(1.378)) / 10000), null, null, 1]);
      if (i < nDiel) { const d = dielRows[i]; head.push(['LAYER_PHYS', 101 + i, d?.dielMaterial || 'FR4', r4((d?.height ?? (stack.length === 2 ? mil(59.449) : mil(10))) / 10000), r4(d?.dielConst ?? 4.5), 0, 1]); }
    });
    for (const n of doc.nets) head.push(['NET', n.name, null, null, 1, null, 0, null]);
    head.push(['RULE', '1', 'safeClearance', 1, ['mil', Array.from({ length: 13 }, (_, i) => Array.from({ length: i + 1 }, () => gap))]]);
    head.push(['RULE', '3', 'trackWidth', 1, ['mil', ...tw]]);
    head.push(['RULE', '5', 'viaSize', 1, ['mil', ...vd]]);
    head.push(['RULE', '8', 'pasteMaskExpansion', 1, ['mil', pasteX, pasteX]]);
    head.push(['RULE', '9', 'solderMaskExpansion', 1, ['mil', maskX, maskX]]);
    files.push({ name: `PCB/${pcbUuid}.epcb`, bytes: lines([...head, ...body]) });
    if (poured.length) files.push({ name: `POUR/${btoa64(`${pcbUuid}_0`)}.ecop`, bytes: lines([['DOCTYPE', 'POURED', '1.1'], ...poured]) });
    project.pcbs[pcbUuid] = name;
    if (doc.board.layerNames.size && [...doc.board.layerNames.values()].some((v) => /^board outline$/i.test(v))) {
      const l = [...doc.board.layerNames].find(([, v]) => /^board outline$/i.test(v))?.[0];
      if (l !== undefined && doc.prims.some((q) => 'layer' in q && q.layer === l)) note('The Board Outline mechanical layer left out: the board\'s shape is on EasyEDA\'s Board Outline layer');
    }
    return { layers: stack.length, components: nComps, nets: doc.nets.length };
  }

  if (p.sheets.length || p.board) project.boards[name] = { schematic: p.sheets.length ? schUuid : '', pcb: p.board ? pcbUuid : '' };
  if (!p.sheets.length && !p.board) return { files: [], messages: [{ level: 'error', source: name, message: 'Nothing to export: no schematics or board' }] };
  files.unshift({ name: 'project.json', bytes: new TextEncoder().encode(JSON.stringify(project)) });
  if (p.sheets.length) info(`Schematic: ${schStats.pages} page${schStats.pages === 1 ? '' : 's'}, ${schStats.parts} parts, ${schStats.nets} nets; ${Object.keys(project.symbols).length} symbols, ${Object.keys(project.devices).length} devices`);
  if (p.board) info(`PCB: ${pcbStats.layers} copper layers, ${pcbStats.components} components, ${pcbStats.nets} nets; ${Object.keys(project.footprints).length} footprints`);
  if (p.schLibs.length || p.pcbLibs.length) info('Libraries aren\'t written on their own: the symbols, footprints and devices the design uses are in the project');
  for (const [k, c] of warned) messages.push({ level: 'warn', source: name, message: c > 1 ? `${k} (${c})` : k });
  return { files: [{ path: `${name}/${name}.epro`, bytes: zip(files) }], messages };
}

/** EasyEDA's layer colours (its defaults for the fixed layers; inner and custom layers cycled). */
const COLOURS: Record<number, string> = {
  1: '#ff0000', 2: '#0000ff', 3: '#ffcc00', 4: '#66cc33', 5: '#800080', 6: '#aa00ff', 7: '#808080', 8: '#800000', 9: '#33cc99', 10: '#5555ff', 11: '#ff00ff', 12: '#c0c0c0',
  13: '#ffffff', 14: '#f022f0', 47: '#222222', 48: '#00cccc', 49: '#66ffcc', 50: '#cc9999', 51: '#ff99ff', 52: '#ffffff', 56: '#99ffff', 57: '#6464ff', 58: '#eee666', 59: '#ccff00',
};
const INNER = ['#999966', '#008000', '#00ff00', '#bc8e00', '#70dbfa', '#00cc66', '#9966ff', '#800080'];

/** A drawing (a symbol's or a page's) as EasyEDA's records: points as they are (AD's unit is EasyEDA's). */
function drawing(o: SchObject, st: Styles, ids: Ids, see: (q: Pt) => void = () => undefined): Rec[] {
  const XY = (q: Pt) => { see(q); return [r4(q.x / U), r4(q.y / U)]; };
  const flat = (pts: Pt[]) => pts.flatMap(XY);
  switch (o.kind) {
    case 'polyline': return o.pts.length >= 2 ? [['POLY', ids.next(), flat(o.pts), false, st.line(hex(o.color), Math.min(3, o.style ?? 0), null, lineW(o.width)), 0]] : [];
    case 'polygon': return o.pts.length >= 3 ? [['POLY', ids.next(), flat([...o.pts, o.pts[0]!]), true, st.line(hex(o.color), 0, o.solid && !o.transparent ? hex(o.fill) : null, lineW(o.width)), 0]] : [];
    case 'rect': {
      const a = { x: Math.min(o.a.x, o.b.x), y: Math.min(o.a.y, o.b.y) }, b = { x: Math.max(o.a.x, o.b.x), y: Math.max(o.a.y, o.b.y) };
      return [['RECT', ids.next(), ...XY(a), ...XY(b), r4(o.r / U), r4(o.ry / U), 0, st.line(hex(o.color), 0, o.solid && !o.transparent ? hex(o.fill) : null, lineW(o.width)), 0]];
    }
    case 'ellipse': {
      const ls = st.line(hex(o.color), 0, o.solid && !o.transparent ? hex(o.fill) : null, lineW(o.width));
      if (Math.abs(o.rx - o.ry) < 2) { see({ x: o.c.x - o.rx, y: o.c.y - o.rx }); see({ x: o.c.x + o.rx, y: o.c.y + o.rx }); return [['CIRCLE', ids.next(), ...XY(o.c), r4(o.rx / U), ls, 0]]; }
      const ring = Array.from({ length: 49 }, (_, i) => ({ x: o.c.x + o.rx * Math.cos((i * Math.PI) / 24), y: o.c.y + o.ry * Math.sin((i * Math.PI) / 24) }));
      return [['POLY', ids.next(), flat(ring), true, ls, 0]];
    }
    case 'arc': {
      const span = norm(o.end - o.start) || 360;
      const ls = st.line(hex(o.color), 0, null, lineW(o.width));
      if (Math.abs(o.rx - o.ry) < 2 && span >= 359.99) return [['CIRCLE', ids.next(), ...XY(o.c), r4(o.rx / U), ls, 0]];
      const at = (a: number) => ({ x: o.c.x + o.rx * Math.cos((a * Math.PI) / 180), y: o.c.y + o.ry * Math.sin((a * Math.PI) / 180) });
      if (Math.abs(o.rx - o.ry) < 2) return [['ARC', ids.next(), ...XY(at(o.start)), ...XY(at(o.start + span / 2)), ...XY(at(o.start + span)), ls, 0]];
      return [['POLY', ids.next(), flat(Array.from({ length: 33 }, (_, i) => at(o.start + (span * i) / 32))), false, ls, 0]];
    }
    case 'bezier': {
      if (o.pts.length < 4) return [];
      const ls = st.line(hex(o.color), 0, null, lineW(o.width));
      const out: Rec[] = [];
      for (let i = 0; i + 3 < o.pts.length; i += 3) out.push(['BEZIER', ids.next(), flat(o.pts.slice(i, i + 4)), ls, 0]);
      return out;
    }
    case 'piechart': {
      const span = norm(o.end - o.start) || 360;
      const ring: Pt[] = [o.c];
      for (let i = 0; i <= 24; i++) { const a = ((o.start + (span * i) / 24) * Math.PI) / 180; ring.push({ x: o.c.x + o.r * Math.cos(a), y: o.c.y + o.r * Math.sin(a) }); }
      return [['POLY', ids.next(), flat([...ring, o.c]), true, st.line(hex(o.color), 0, o.solid ? hex(o.fill) : null, lineW(o.width)), 0]];
    }
    default: return [];
  }
}
