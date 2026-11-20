/**
 * A project as EAGLE's XML files (EAGLE 9's, which Fusion Electronics opens too): the schematic
 * (.sch), the board (.brd) of the same name beside it — so EAGLE pairs them, their parts,
 * elements, nets and signals by the same names — and a library (.lbr) of what they use.
 *
 *  - Library: each library reference (and pin layout) a device set, its parts its gates (A, B …),
 *    each footprint it is placed with a device of the package, every pin connected to the pads
 *    of its designator (a pad name the footprint has more than once: each, as one pin on several
 *    pads); hidden power pins a power gate EAGLE adds on request (EAGLE joins its pins to the nets
 *    of their names); power ports supply symbols named by their nets.
 *  - Schematic: each sheet (each channel of a multi-channel sheet, with its designators and nets) a
 *    sheet; parts placed as AD places them, their designators and comments where AD shows them
 *    (smashed); every net by the name the project compiles it to (EAGLE joins nets by name), each
 *    piece of it drawn apart a segment of its wires, junctions, labels and pins; ports, sheet
 *    entries and off-sheet connectors cross-reference labels; buses buses; the sheet's border a
 *    frame; drawings and text as drawn.
 *  - Board: the copper layers (EAGLE's 1–16: top, the inner ones in order, bottom), the board shape
 *    and cut-outs on Dimension, components as elements (bottom ones mirrored), their footprints as
 *    packages (pads, SMDs with their roundness, slots as Milling, holes), tracks, arcs and vias by
 *    signal, polygon pours as polygons (EAGLE pours them), copper regions as polygons, keep-outs on
 *    the restrict layers, text; mechanical layers as user layers named after them; the design
 *    rules (clearances, widths, drills, mask and paste) with pads and vias kept at their sizes.
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM } from '../../core/units';
import { compileProject, type CompiledNet, type SheetInput } from '../../model/compile';
import { DIR_VECTORS, bagOf, deriveObject, isShown, ownedBy, partLetter, type SchDocument, type SchFont, type SchObject } from '../../model/sch';
import { symbolOf } from '../../model/makeLib';
import { autoJunctions } from '../../model/schConnect';
import { specialResolver } from '../../model/schSpecial';
import { bezierPts } from '../../editors/sch/powerPort';
import { L as LY, isCopper, isMech, mechNumber, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PolyVertex } from '../../model/pcb';
import { footprintDoc, footprintsFromBoard } from '../../model/pcbLib';
import { readStack } from '../../model/pcbStack';
import { boardSettings } from '../kicad/exportPcb';
import { keptBrd, keptSch } from './kept';
import { eagleSplice } from './splice';
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';

type Attrs = Record<string, string | number | boolean | undefined | null>;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
/** An element: its attributes (none left out but undefined, null and false), its children or text. */
function x(name: string, attrs: Attrs = {}, kids?: string[] | string): string {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v === true ? 'yes' : String(v))}"`).join('');
  if (kids === undefined || (Array.isArray(kids) && !kids.length)) return `<${name}${a}/>`;
  if (typeof kids === 'string') return `<${name}${a}>${esc(kids)}</${name}>`;
  return `<${name}${a}>\n${kids.join('\n')}\n</${name}>`;
}
/** AD's units as millimetres. */
const MM = (c: number) => c / UNITS_PER_MM;
const norm = (a: number) => ((a % 360) + 360) % 360;
const rot = (a: number, mirror = false, spin = false) => `${spin ? 'S' : ''}${mirror ? 'M' : ''}R${num(norm(Math.round(a * 1000) / 1000))}`;

/** A name EAGLE takes: upper case, no blanks, no commas or brackets (its bus syntax), AD's overbar (a backslash after each character) as EAGLE's (!…!). */
export function eagleName(s: string, fallback = '_'): string {
  let out = '', on = false;
  const t = s.trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!, bar = t[i + 1] === '\\';
    if (c === '\\') continue;
    if (bar !== on) { out += '!'; on = bar; }
    out += c;
  }
  if (on) out += '!';
  return out.replace(/\s+/g, '_').replace(/,/g, '_').toUpperCase() || fallback;
}
const textOf = (s: string) => s.replace(/\r\n?/g, '\n');

/* ── layers ── */

const LAYER_TABLE: [number, string, number, number][] = [
  [1, 'Top', 4, 1], ...Array.from({ length: 14 }, (_, i): [number, string, number, number] => [i + 2, `Route${i + 2}`, i % 2 ? 4 : 1, 3]), [16, 'Bottom', 1, 1], [17, 'Pads', 2, 1], [18, 'Vias', 2, 1],
  [19, 'Unrouted', 6, 1], [20, 'Dimension', 15, 1], [21, 'tPlace', 7, 1], [22, 'bPlace', 7, 1], [23, 'tOrigins', 15, 1], [24, 'bOrigins', 15, 1], [25, 'tNames', 7, 1],
  [26, 'bNames', 7, 1], [27, 'tValues', 7, 1], [28, 'bValues', 7, 1], [29, 'tStop', 7, 3], [30, 'bStop', 7, 6], [31, 'tCream', 7, 4], [32, 'bCream', 7, 5],
  [33, 'tFinish', 6, 3], [34, 'bFinish', 6, 6], [35, 'tGlue', 7, 4], [36, 'bGlue', 7, 5], [37, 'tTest', 7, 1], [38, 'bTest', 7, 1], [39, 'tKeepout', 4, 11],
  [40, 'bKeepout', 1, 11], [41, 'tRestrict', 4, 10], [42, 'bRestrict', 1, 10], [43, 'vRestrict', 2, 10], [44, 'Drills', 7, 1], [45, 'Holes', 7, 1], [46, 'Milling', 3, 1],
  [47, 'Measures', 7, 1], [48, 'Document', 7, 1], [49, 'Reference', 7, 1], [51, 'tDocu', 7, 1], [52, 'bDocu', 7, 1],
  [90, 'Modules', 5, 1], [91, 'Nets', 2, 1], [92, 'Busses', 1, 1], [93, 'Pins', 2, 1], [94, 'Symbols', 4, 1], [95, 'Names', 7, 1], [96, 'Values', 7, 1], [97, 'Info', 7, 1], [98, 'Guide', 6, 1],
];
function layersXml(copper: Set<number>, user: Map<number, string>): string {
  const rows = LAYER_TABLE.map(([n, name, color, fill]) => x('layer', { number: n, name, color, fill, visible: n <= 16 ? (copper.has(n) ? 'yes' : 'no') : 'yes', active: n <= 16 ? (copper.has(n) ? 'yes' : 'no') : 'yes' }));
  for (const [n, name] of [...user].sort((a, b) => a[0] - b[0])) rows.push(x('layer', { number: n, name, color: 7, fill: 1, visible: 'yes', active: 'yes' }));
  return x('layers', {}, rows);
}
const HEAD = (inner: string[]) => ['<?xml version="1.0" encoding="utf-8"?>', '<!DOCTYPE eagle SYSTEM "eagle.dtd">', x('eagle', { version: '9.6.2' }, [x('drawing', {}, inner)])].join('\n') + '\n';
const SETTINGS = x('settings', {}, [x('setting', { alwaysvectorfont: 'no' }), x('setting', { verticaltext: 'up' })]);

/* ── the library being made ── */

interface Gate { name: string; symbol: string; addlevel?: string }
interface Device { name: string; pkg?: string; connects: { gate: string; pin: string; pads: string[] }[] }
interface DeviceSet { name: string; prefix: string; description: string; gates: Gate[]; devices: Device[]; uservalue: boolean }
class Library {
  symbols = new Map<string, string[]>();
  packages = new Map<string, string[]>();
  sets = new Map<string, DeviceSet>();
  /** Each package's pads by AD's pad name: EAGLE's names (a name AD repeats: each, apart). */
  pads = new Map<string, Map<string, string[]>>();
  private taken = new Set<string>();
  unique(base: string): string { let n = base; for (let k = 2; this.taken.has(n); k++) n = `${base}_${k}`; this.taken.add(n); return n; }
  xml(name: string, withSchematic: boolean): string {
    const kids = [x('description', {}, `Made by Konium Designer from ${name}`), x('packages', {}, [...this.packages].map(([n, k]) => x('package', { name: n }, k)))];
    if (withSchematic) {
      kids.push(x('symbols', {}, [...this.symbols].map(([n, k]) => x('symbol', { name: n }, k))));
      kids.push(x('devicesets', {}, [...this.sets.values()].map((d) => x('deviceset', { name: d.name, prefix: d.prefix || undefined, uservalue: d.uservalue ? 'yes' : undefined }, [
        ...(d.description ? [x('description', {}, d.description)] : []),
        x('gates', {}, d.gates.map((g) => x('gate', { name: g.name, symbol: g.symbol, x: 0, y: 0, addlevel: g.addlevel }))),
        x('devices', {}, d.devices.map((v) => x('device', { name: v.name, package: v.pkg }, [
          ...(v.connects.length ? [x('connects', {}, v.connects.map((c) => x('connect', { gate: c.gate, pin: c.pin, pad: c.pads.join(' ') })))] : []),
          x('technologies', {}, [x('technology', { name: '' })]),
        ]))),
      ]))));
    }
    return x('library', { name }, kids);
  }
}

/* ── packages from footprints ── */

/** EAGLE's layer for an AD layer of a footprint or the board (null: none). */
interface LayerMap { of(l: LayerId): number | null; user: Map<number, string>; copper: Map<LayerId, number> }
function layerMap(doc: PcbDocument | undefined): LayerMap {
  const stack = doc ? doc.board.copperStack : [LY.TOP, LY.BOTTOM];
  const copper = new Map<LayerId, number>();
  stack.forEach((l, i) => copper.set(l, i === 0 ? 1 : i === stack.length - 1 ? 16 : Math.min(15, i + 1)));
  const user = new Map<number, string>();
  const names = doc?.board.layerNames ?? new Map<LayerId, string>();
  return {
    copper, user,
    of(l) {
      const c = copper.get(l);
      if (c !== undefined) return c;
      switch (l) {
        case LY.TOP_OVERLAY: return 21;
        case LY.BOTTOM_OVERLAY: return 22;
        case LY.TOP_SOLDER: return 29;
        case LY.BOTTOM_SOLDER: return 30;
        case LY.TOP_PASTE: return 31;
        case LY.BOTTOM_PASTE: return 32;
        case LY.KEEPOUT: return 41;
        default:
      }
      if (isMech(l)) {
        const n = 100 + mechNumber(l);
        if (!user.has(n)) user.set(n, eagleName(names.get(l) ?? `Mechanical${mechNumber(l)}`).replace(/[^A-Z0-9_]/g, '_').slice(0, 20) || `MECH${mechNumber(l)}`);
        return n;
      }
      return null;
    },
  };
}

const arcPoint = (c: Vec2, r: number, a: number): Vec2 => ({ x: c.x + r * Math.cos((a * Math.PI) / 180), y: c.y + r * Math.sin((a * Math.PI) / 180) });
/** A primitive's EAGLE elements (a footprint's in its own frame, or the board's), pads by `padName`. */
function pcbItems(p: PcbPrim, lm: LayerMap, warn: (w: string) => void, padName?: (p: PcbPad) => string): string[] {
  const w = (a: Vec2, b: Vec2, width: number, layer: number, curve?: number) => x('wire', { x1: MM(a.x), y1: MM(a.y), x2: MM(b.x), y2: MM(b.y), width: MM(width), layer, curve: curve || undefined });
  const layers = (l: LayerId): number[] => { if (l === LY.KEEPOUT) return [41, 42, 43]; const n = lm.of(l); return n === null ? [] : [n]; };
  switch (p.kind) {
    case 'track': return layers(p.layer).map((n) => w(p.a, p.b, p.width, n));
    case 'arc': {
      const sweep = norm(p.end - p.start) || 360;
      if (sweep >= 359.999) return layers(p.layer).map((n) => x('circle', { x: MM(p.c.x), y: MM(p.c.y), radius: MM(p.r), width: MM(p.width), layer: n }));
      return layers(p.layer).map((n) => w(arcPoint(p.c, p.r, p.start), arcPoint(p.c, p.r, p.start + sweep), p.width, n, sweep));
    }
    case 'fill': {
      const cx = (p.a.x + p.b.x) / 2, cy = (p.a.y + p.b.y) / 2, hw = Math.abs(p.b.x - p.a.x) / 2, hh = Math.abs(p.b.y - p.a.y) / 2;
      return layers(p.layer).map((n) => x('rectangle', { x1: MM(cx - hw), y1: MM(cy - hh), x2: MM(cx + hw), y2: MM(cy + hh), layer: n, rot: p.rotation ? rot(p.rotation) : undefined }));
    }
    case 'region': {
      if (p.regionKind === 1 || p.outline.length < 3) return [];
      if (p.holes.length) warn('Regions with holes written without their holes');
      return layers(p.layer).map((n) => x('polygon', { width: 0.0254, layer: n }, p.outline.map((v) => x('vertex', { x: MM(v.x), y: MM(v.y) }))));
    }
    case 'text': {
      const n = lm.of(p.layer);
      if (n === null || !p.text.trim()) return [];
      const size = MM(p.height + p.strokeWidth);
      // AD's text turns with its angle, never kept upright: spun
      return [x('text', { x: MM(p.at.x), y: MM(p.at.y), size, layer: n, font: 'vector', ratio: Math.max(1, Math.min(31, Math.round((p.strokeWidth / Math.max(1, p.height + p.strokeWidth)) * 100))), rot: rot(p.mirrored ? -p.rotation : p.rotation, p.mirrored, true) }, textOf(p.text))];
    }
    case 'pad': return padItems(p, lm, warn, padName?.(p) ?? p.name);
    default: return [];
  }
}
function padItems(p: PcbPad, lm: LayerMap, warn: (w: string) => void, name: string): string[] {
  const out: string[] = [];
  const t = p.top;
  if (p.hole > 0 && p.layer === LY.MULTI) {
    if (!p.plated) { out.push(x('hole', { x: MM(p.at.x), y: MM(p.at.y), drill: MM(p.hole) })); return out; }
    const sq = t.shape === 'rect' || t.shape === 'roundrect';
    const oval = !sq && t.shape !== 'octagon' && Math.abs(t.w - t.h) > 1;
    let shape = sq ? 'square' : t.shape === 'octagon' ? 'octagon' : oval ? 'long' : 'round';
    let dia = Math.min(t.w, t.h), r = p.rotation;
    if (oval) { if (t.h > t.w) r += 90; if (Math.abs(Math.max(t.w, t.h) / Math.min(t.w, t.h) - 2) > 0.05) warn('Oval through-hole pads made EAGLE\'s long pads (twice as long as wide)'); }
    if (sq && Math.abs(t.w - t.h) > 1) {
      // A rectangle: EAGLE's square pad, the rest of it copper round it on the outer layers
      shape = 'square';
      for (const l of [1, 16]) out.push(x('rectangle', { x1: MM(p.at.x - t.w / 2), y1: MM(p.at.y - t.h / 2), x2: MM(p.at.x + t.w / 2), y2: MM(p.at.y + t.h / 2), layer: l, rot: p.rotation ? rot(p.rotation) : undefined }));
      warn('Rectangular through-hole pads made EAGLE\'s square pads with copper rectangles round them');
    }
    let drill = p.hole;
    if (p.slot && p.slot.length > p.hole) {
      // A slot: the pad's drill its width, its length on Milling
      const a = ((p.rotation + p.slot.rotation) * Math.PI) / 180, h = (p.slot.length - p.hole) / 2;
      const d = { x: Math.cos(a) * h, y: Math.sin(a) * h };
      out.push(x('wire', { x1: MM(p.at.x - d.x), y1: MM(p.at.y - d.y), x2: MM(p.at.x + d.x), y2: MM(p.at.y + d.y), width: MM(p.hole), layer: 46 }));
      drill = p.hole;
      dia = Math.max(dia, drill);
    }
    out.unshift(x('pad', { name, x: MM(p.at.x), y: MM(p.at.y), drill: MM(drill), diameter: MM(Math.max(dia, drill)), shape: shape === 'round' ? undefined : shape, rot: norm(r) ? rot(r) : undefined }));
    return out;
  }
  const layer = lm.of(p.layer);
  if (layer !== 1 && layer !== 16) { warn('Pads off the outer copper layers left out'); return out; }
  const roundness = t.shape === 'round' ? 100 : t.shape === 'roundrect' ? Math.round(t.cornerPct) : 0;
  out.push(x('smd', { name, x: MM(p.at.x), y: MM(p.at.y), dx: MM(t.w), dy: MM(t.h), layer, roundness: roundness || undefined, rot: norm(p.rotation) ? rot(p.rotation) : undefined }));
  return out;
}

/** A footprint (its primitives in its own frame) as a package; its pads' EAGLE names by AD's. */
function packageOf(prims: PcbPrim[], lm: LayerMap, warn: (w: string) => void): { kids: string[]; pads: Map<string, string[]>; order: string[] } {
  const pads = new Map<string, string[]>();
  const order: string[] = [];
  const taken = new Set<string>();
  let anon = 0;
  const nameOf = (p: PcbPad): string => {
    const base = p.name.trim() ? eagleName(p.name) : `P$${++anon}`;
    let n = base;
    for (let k = 2; taken.has(n); k++) n = `${base}_${k}`;
    taken.add(n);
    if (p.name.trim()) pads.set(p.name.trim().toUpperCase(), [...(pads.get(p.name.trim().toUpperCase()) ?? []), n]);
    order.push(n);
    return n;
  };
  const kids: string[] = [];
  for (const p of prims) {
    if (p.kind === 'pad') { kids.push(...pcbItems(p, lm, warn, nameOf)); continue; }
    if (p.kind === 'text' && (p.isDesignator || p.isComment)) continue;
    if (p.kind === 'body') continue;
    kids.push(...pcbItems(p, lm, warn));
  }
  // The name and value where EAGLE's packages keep them
  kids.push(x('text', { x: 0, y: 1.27, size: 1.27, layer: 25 }, '>NAME'), x('text', { x: 0, y: -2.54, size: 1.27, layer: 27 }, '>VALUE'));
  return { kids, pads, order };
}

/* ── the export ── */

export function exportEagle(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const libName = eagleName(name).replace(/[^A-Z0-9_\-+.]/g, '_') || 'KONIUM';
  const files: ExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const warned = new Set<string>();
  const warn = (w: string) => { if (!warned.has(w)) { warned.add(w); messages.push({ level: 'warn', source: name, message: w }); } };
  const lib = new Library();
  const lm = layerMap(p.board);

  /* Packages: the board's footprints as placed, else the project's PCB libraries' */
  const pkgName = new Map<string, string>();   // footprint (upper case) → package
  const addPackage = (fp: string, prims: PcbPrim[]) => {
    const key = fp.toUpperCase();
    if (pkgName.has(key)) return;
    const nm = lib.unique(eagleName(fp, 'PACKAGE').replace(/[^A-Z0-9_\-+.$!@#]/g, '_'));
    const r = packageOf(prims, lm, warn);
    lib.packages.set(nm, r.kids);
    lib.pads.set(nm, r.pads);
    pkgName.set(key, nm);
  };
  if (p.board) for (const fp of footprintsFromBoard(p.board)) addPackage(fp.name, footprintDoc(fp.name, fp.records).prims);
  for (const pl of p.pcbLibs) for (const f of pl.footprints) if (f.loaded !== false) addPackage(f.name, f.doc.prims);

  const sch = p.sheets.length ? writeSchematic(p, lib, pkgName, warn) : null;
  const brd = p.board ? writeBoard(p.board, pkgName, lm, warn, sch?.parts, sch?.values, sch?.autoNames) : null;
  // A schematic or board read from EAGLE: unchanged, the file EAGLE wrote; a board changed only by parts moved and
  // nets rerouted, EAGLE's file with those spliced in (kept.ts, splice.ts); both under the file's name, so EAGLE pairs them
  const keptS = p.sheets.length ? keptSch(p.sheets.map((s) => s.doc)) : null;
  const keptB = p.board ? keptBrd(p.board) : null;
  const spliced = p.board && !keptB ? eagleSplice(p.board) : null;
  const srcName = keptS?.file ?? keptB?.file ?? (spliced ? p.board?.board.bag?.get('EAGLEFILE') : undefined) ?? p.board?.board.bag?.get('EAGLEFILE');
  const base = srcName ? srcName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || name : name;
  if (keptS) files.push({ path: `${name}/${base}.sch`, bytes: keptS.bytes });
  else if (sch) {
    files.push({ path: `${name}/${base}.sch`, bytes: enc.encode(HEAD([SETTINGS, x('grid', { distance: 0.1, unitdist: 'inch', unit: 'inch', style: 'lines', multiple: 1, display: 'no', altdistance: 0.01, altunitdist: 'inch', altunit: 'inch' }),
      layersXml(new Set(lm.copper.values()), lm.user), sch.xml(lib.xml(libName, true))])) });
  }
  if (keptB) files.push({ path: `${name}/${base}.brd`, bytes: keptB.bytes });
  else if (spliced) files.push({ path: `${name}/${base}.brd`, bytes: spliced.bytes });
  else if (brd) files.push({ path: `${name}/${base}.brd`, bytes: enc.encode(brd(lib.xml(libName, false), layersXml(new Set(lm.copper.values()), lm.user))) });
  files.push({ path: `${name}/${libName.toLowerCase()}.lbr`, bytes: enc.encode(HEAD([SETTINGS, x('grid', { distance: 0.1, unitdist: 'inch', unit: 'inch', style: 'lines', multiple: 1, display: 'no', altdistance: 0.01, altunitdist: 'inch', altunit: 'inch' }),
    layersXml(new Set(lm.copper.values()), lm.user), lib.xml(libName, true).replace(/^<library name="[^"]*">/, '<library>')])) });
  if (!p.sheets.length && !p.board) messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or board' });
  else {
    messages.unshift({ level: 'info', source: name, message: `${p.sheets.length ? `${sch!.stats.sheets} sheet${sch!.stats.sheets === 1 ? '' : 's'}, ${sch!.stats.parts} parts, ${sch!.stats.nets} nets` : 'no schematic'}${p.board ? `; the board: ${lm.copper.size} copper layers` : ''}; library ${libName}: ${lib.sets.size} devices, ${lib.packages.size} packages` });
    if (keptS || keptB) messages.push({ level: 'info', source: name, message: `${[keptS && 'The schematic', keptB && 'the board'].filter(Boolean).join(' and ')} unchanged since EAGLE's file was read: written as EAGLE wrote ${keptS && keptB ? 'them' : 'it'}` });
    if (spliced) messages.push({ level: 'info', source: name, message: `The board as EAGLE wrote it but for what changed: ${spliced.moved} part${spliced.moved === 1 ? '' : 's'} moved, ${spliced.rerouted} signal${spliced.rerouted === 1 ? '' : 's'} rerouted` });
    messages.push({ level: 'info', source: name, message: 'EAGLE 9 and Fusion Electronics open the .sch and the .brd (one name, one folder: EAGLE pairs them); the .lbr holds the devices and packages' });
  }
  return { files, messages };
}
const enc = new TextEncoder();

/* ── the schematic ── */

interface SchWritten { xml: (library: string) => string; parts: Map<string, string>; values: Map<string, string>; autoNames: Map<string, string>; stats: { sheets: number; parts: number; nets: number } }

function writeSchematic(p: ExportProject, lib: Library, pkgName: Map<string, string>, warn: (w: string) => void): SchWritten {
  const sheets = p.sheets;
  const c = compileProject(sheets, { scope: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, checkBounds: false });
  // Net names as compiled, as EAGLE takes them, each its own
  const used = new Set<string>();
  const nameOf = new Map<CompiledNet, string>();
  // A net no label, power port or port names (AD's NetR1_2): EAGLE's own automatic name (N$1 …), on the board as well
  const autoNames = new Map<string, string>();
  for (const n of c.nets) if (!n.auto) used.add(eagleName(n.name, 'N$1'));
  // A board read from EAGLE: its signals' names for the nets it has (kept.ts), so schematic and board pair
  const boardSignal = new Map((p.board?.nets ?? []).filter((n) => n.bag.get('EAGLESIGNAL')).map((n) => [n.name, n.bag.get('EAGLESIGNAL')!]));
  for (const s of boardSignal.values()) used.add(s);
  let autoK = 0;
  for (const n of c.nets) {
    let nm: string;
    if (n.auto && boardSignal.has(n.name) && ![...nameOf.values()].includes(boardSignal.get(n.name)!)) { nm = boardSignal.get(n.name)!; autoNames.set(eagleName(n.name), nm); }
    else if (n.auto) {
      do nm = `N$${++autoK}`; while (used.has(nm));
      autoNames.set(eagleName(n.name), nm);
    } else {
      nm = eagleName(n.name, 'N$1');
      if ([...nameOf.values()].includes(nm)) for (let k = 2; used.has(nm) || [...nameOf.values()].includes(nm); k++) nm = `${eagleName(n.name)}_${k}`;
    }
    used.add(nm);
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
  const compAt = new Map<string, (typeof c.components)[number]>();
  for (const comp of c.components) comp.refs.forEach((r, i) => { const inst = comp.refInsts?.[i] || comp.inst; sawInst(r.sheet, inst); const k = key2(inst, r); if (!compAt.has(k)) compAt.set(k, comp); });
  const pages: { s: SheetInput; inst: string }[] = [];
  for (const s of sheets) {
    const list = pagesOf.get(s.name) ?? [s.name];
    for (const inst of list) pages.push({ s, inst });
    if (list.length > 1) warn(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} sheets with each channel's designators and nets`);
  }
  const vars = new Map(p.variables.map((v) => [v.name.toUpperCase(), v.value]));

  /* Device sets: by library reference and pins */
  const setBySig = new Map<string, { set: DeviceSet; pinNames: Map<string, string>; hiddenGate?: string }>();
  const parts = new Map<string, { xml: string; set: string; device: string; value: string; attrs: [string, string][]; pkg?: string }>();
  const partPads = new Map<string, string>();   // "PART.PAD" (EAGLE's names) → net
  const supplySets = new Map<string, string>();
  let supplyN = 0;
  const fontSize = (fonts: SchFont[], id: number) => Math.max(0.5, ((fonts[id - 1]?.size ?? 10) * 0.127));
  /** AD's text as EAGLE's: shown at 0° or 90° (AD's 180° and 270° upright from the other end), aligned as AD aligns it. */
  const textLook = (orient: number, justify: number) => {
    let o = orient & 3, h = justify % 3;
    const v = Math.floor(justify / 3) % 3;
    if (o >= 2) { o -= 2; h = 2 - h; }
    const align = `${['bottom', 'center', 'top'][v]}-${['left', 'center', 'right'][h]}`;
    return { rot: o ? 'R90' : undefined, align: align === 'bottom-left' ? undefined : align === 'center-center' ? 'center' : align };
  };
  const wid = (w: number) => Math.max(0.1524, MM(w));

  /** A symbol's (or a sheet's) drawing as EAGLE's, points by `k` (AD → mm). */
  const drawing = (o: SchObject, fonts: SchFont[], layer: number, k: (p: Vec2) => Vec2, text?: (o: SchObject & { kind: 'text' }) => string | null): string[] => {
    const wire = (a: Vec2, b: Vec2, w: number, curve?: number) => x('wire', { x1: num(k(a).x), y1: num(k(a).y), x2: num(k(b).x), y2: num(k(b).y), width: wid(w), layer, curve: curve || undefined });
    const chain = (pts: Vec2[], w: number, closed = false) => { const l = closed ? [...pts, pts[0]!] : pts; return l.slice(1).map((q, i) => wire(l[i]!, q, w)); };
    switch (o.kind) {
      case 'polyline': case 'busentry': return o.kind === 'busentry' ? [wire(o.a, o.b, o.width)] : chain(o.pts, o.width);
      case 'bezier': {
        const out: Vec2[] = [];
        for (let i = 0; i + 3 < o.pts.length; i += 3) out.push(...bezierPts([[o.pts[i]!.x, o.pts[i]!.y], [o.pts[i + 1]!.x, o.pts[i + 1]!.y], [o.pts[i + 2]!.x, o.pts[i + 2]!.y], [o.pts[i + 3]!.x, o.pts[i + 3]!.y]]).slice(i ? 1 : 0).map(([px, py]) => ({ x: px, y: py })));
        return chain(out, o.width);
      }
      case 'polygon':
        if (o.solid && !o.transparent && o.fill === o.color && o.pts.length >= 3) return [x('polygon', { width: wid(o.width), layer }, o.pts.map((q) => x('vertex', { x: num(k(q).x), y: num(k(q).y) })))];
        return chain(o.pts, o.width, true);
      case 'rect': {
        if (o.solid && !o.transparent && o.fill === o.color) { const a = k(o.a), b = k(o.b); return [x('rectangle', { x1: num(Math.min(a.x, b.x)), y1: num(Math.min(a.y, b.y)), x2: num(Math.max(a.x, b.x)), y2: num(Math.max(a.y, b.y)), layer })]; }
        return chain([o.a, { x: o.b.x, y: o.a.y }, o.b, { x: o.a.x, y: o.b.y }], o.width, true);
      }
      case 'ellipse': {
        if (Math.abs(o.rx - o.ry) < 2) { const cc = k(o.c); return [x('circle', { x: num(cc.x), y: num(cc.y), radius: num(MM(o.rx)), width: o.solid && !o.transparent && o.fill === o.color ? 0 : wid(o.width), layer })]; }
        return chain(Array.from({ length: 48 }, (_, i) => ({ x: o.c.x + o.rx * Math.cos((i * Math.PI) / 24), y: o.c.y + o.ry * Math.sin((i * Math.PI) / 24) })), o.width, true);
      }
      case 'arc': {
        const sweep = norm(o.end - o.start) || 360;
        if (Math.abs(o.rx - o.ry) < 2) {
          if (sweep >= 359.99) { const cc = k(o.c); return [x('circle', { x: num(cc.x), y: num(cc.y), radius: num(MM(o.rx)), width: wid(o.width), layer })]; }
          // The way round as `k` turns it (a mirroring frame reverses it)
          const a = arcPoint(o.c, o.rx, o.start), b = arcPoint(o.c, o.rx, o.start + sweep);
          const ka = k(a), kb = k(b), kc = k(o.c);
          const cross = (ka.x - kc.x) * (kb.y - kc.y) - (ka.y - kc.y) * (kb.x - kc.x);
          const mid = k(arcPoint(o.c, o.rx, o.start + sweep / 2));
          const crossM = (ka.x - kc.x) * (mid.y - kc.y) - (ka.y - kc.y) * (mid.x - kc.x);
          const ccw = sweep > 180 ? !(cross > 0) === !(crossM > 0) ? crossM > 0 : crossM > 0 : cross > 0;
          return [wire(a, b, o.width, ccw ? sweep : -sweep)];
        }
        return chain(Array.from({ length: 33 }, (_, i) => ({ x: o.c.x + o.rx * Math.cos(((o.start + (sweep * i) / 32) * Math.PI) / 180), y: o.c.y + o.ry * Math.sin(((o.start + (sweep * i) / 32) * Math.PI) / 180) })), o.width);
      }
      case 'piechart': return chain([o.c, ...Array.from({ length: 17 }, (_, i) => arcPoint(o.c, o.r, o.start + ((norm(o.end - o.start) || 360) * i) / 16))], o.width, true);
      case 'text': {
        const t = text ? text(o) : o.text;
        if (t === null || !t.trim()) return [];
        const at = k(o.at), look = textLook(o.orient, o.justify);
        return [x('text', { x: num(at.x), y: num(at.y), size: num(fontSize(fonts, o.font)), layer: o.role === 'label' ? layer === 94 ? 94 : 97 : layer, ...look }, textOf(t))];
      }
      default: return [];
    }
  };
  const mmK = (q: Vec2): Vec2 => ({ x: MM(q.x), y: MM(q.y) });
  const PIN_DIR = ['in', 'io', 'out', 'oc', 'pas', 'hiz', 'oc', 'pwr'];

  /** A placed part's device set (made the first time its library reference and pins are met). */
  const deviceSetOf = (doc: SchDocument, o: SchObject & { kind: 'component' }, footprint: string) => {
    const made = symbolOf(doc, o.index);
    const objs = made.bags.map((b, i) => (i > 0 ? deriveObject(b, i) : null)).filter((q): q is SchObject => !!q);
    const pins = objs.filter((q): q is SchObject & { kind: 'pin' } => q.kind === 'pin' && q.ownerDisplayMode === 0);
    const sig = `${o.libRef}\u0000${pins.map((q) => `${q.designator}@${q.ownerPartId}:${q.at.x},${q.at.y},${q.orient},${q.length},${q.hidden ? 1 : 0}`).sort().join('|')}`;
    let entry = setBySig.get(sig);
    const gates = Math.max(1, o.partCount - 1);
    if (!entry) {
      const base = eagleName(o.libRef || 'PART').replace(/[^A-Z0-9_\-+.$!]/g, '_');
      const dsName = lib.unique(base);
      const set: DeviceSet = { name: dsName, prefix: (o.designator.replace(/[\d?].*$/, '') || 'U').toUpperCase(), description: made.description ? esc(made.description) : '', gates: [], devices: [], uservalue: true };
      const pinNames = new Map<string, string>();   // "part\0designator" → EAGLE pin name
      for (let g = 1; g <= gates; g++) {
        const gname = gates > 1 ? partLetter(g) : 'G$1';
        const sname = lib.unique(gates > 1 ? `${dsName}_${gname}` : dsName);
        const mine = objs.filter((q) => (q.ownerPartId <= 0 || q.ownerPartId === g) && q.ownerDisplayMode === 0 && !(q.kind === 'pin' && q.hidden));
        const kids: string[] = [];
        const taken = new Set<string>();
        for (const q of mine) {
          if (q.kind === 'pin') {
            const d = DIR_VECTORS[q.orient & 3]!;
            const hot = { x: q.at.x + d.x * q.length, y: q.at.y + d.y * q.length };
            const L = MM(q.length);
            const len = [7.62, 5.08, 2.54, 0].find((v) => v <= L + 1e-6) ?? 0;
            const lname = ['long', 'middle', 'short', 'point'][[7.62, 5.08, 2.54, 0].indexOf(len)]!;
            let pn = eagleName(q.name.trim() || q.designator, 'P');
            if (taken.has(pn)) { let k = 2; while (taken.has(`${pn}@${k}`)) k++; pn = `${pn}@${k}`; }
            taken.add(pn);
            pinNames.set(`${g}\u0000${q.designator}`, pn);
            const h = mmK(hot);
            const towards = norm((q.orient & 3) * 90 + 180);
            const vis = q.showName && q.showDesignator ? undefined : q.showName ? 'pin' : q.showDesignator ? 'pad' : 'off';
            const fn = q.symbols.outerEdge === 1 && q.symbols.innerEdge === 3 ? 'dotclk' : q.symbols.outerEdge === 1 ? 'dot' : q.symbols.innerEdge === 3 ? 'clk' : undefined;
            kids.push(x('pin', { name: pn, x: num(h.x), y: num(h.y), visible: vis, length: lname === 'long' ? undefined : lname, direction: PIN_DIR[q.electrical] === 'io' ? undefined : PIN_DIR[q.electrical] ?? 'pas', function: fn, rot: towards ? `R${towards}` : undefined }));
            // AD's longer pin: the rest of it a line to the body
            if (L - len > 0.01) {
              const a = { x: h.x - d.x * len, y: h.y - d.y * len }, b = { x: h.x - d.x * L, y: h.y - d.y * L };
              kids.push(x('wire', { x1: num(a.x), y1: num(a.y), x2: num(b.x), y2: num(b.y), width: 0.1524, layer: 94 }));
            }
            continue;
          }
          kids.push(...drawing(q, doc.sheet.fonts, 94, mmK, (t) => {
            if (t.role === 'designator') return '>NAME';
            if (t.role === 'parameter') { const nm = made.bags[t.index]?.get('NAME') ?? ''; return t.hidden ? null : /^comment$/i.test(nm) ? '>VALUE' : nm ? `>${eagleName(nm)}` : null; }
            return t.text;
          }));
        }
        lib.symbols.set(sname, kids);
        set.gates.push({ name: gname, symbol: sname, addlevel: gates > 1 ? 'next' : undefined });
      }
      // Hidden power pins: a gate EAGLE adds on request, its pins joined to the nets of their names
      const hidden = pins.filter((q) => q.hidden && made.bags[q.index]?.get('HIDDENNETNAME')?.trim());
      let hiddenGate: string | undefined;
      if (hidden.length) {
        hiddenGate = 'PWR';
        const sname = lib.unique(`${dsName}_PWR`);
        const kids: string[] = [];
        const taken = new Set<string>();
        hidden.forEach((q, i) => {
          let pn = eagleName(made.bags[q.index]!.get('HIDDENNETNAME')!);
          if (taken.has(pn)) { let k = 2; while (taken.has(`${pn}@${k}`)) k++; pn = `${pn}@${k}`; }
          taken.add(pn);
          pinNames.set(`P\u0000${q.designator}`, pn);
          kids.push(x('pin', { name: pn, x: 0, y: num(-2.54 * i), visible: 'pad', length: 'middle', direction: 'pwr' }));
        });
        lib.symbols.set(sname, kids);
        set.gates.push({ name: hiddenGate, symbol: sname, addlevel: 'request' });
      }
      entry = { set, pinNames, hiddenGate };
      setBySig.set(sig, entry);
      lib.sets.set(dsName, set);
      void pins;
    }
    // Its device for this footprint
    const pkg = footprint ? pkgName.get(footprint.toUpperCase()) : undefined;
    if (footprint && !pkg) warn(`Footprints not on the board nor in the project's PCB libraries: parts with them have no package (${footprint})`);
    let dev = entry.set.devices.find((d) => (d.pkg ?? '') === (pkg ?? ''));
    if (!dev) {
      dev = { name: entry.set.devices.length ? `_${(pkg ?? 'NONE').replace(/[^A-Z0-9_\-+.]/g, '_')}` : '', pkg, connects: [] };
      if (pkg) {
        const pads = lib.pads.get(pkg)!;
        const usedPads = new Set<string>();
        for (const [k, pn] of entry.pinNames) {
          const [g, des] = k.split('\u0000') as [string, string];
          const list = (pads.get(des.trim().toUpperCase()) ?? []).filter((x2) => !usedPads.has(x2));
          if (!list.length) { warn('Pins with no pad of their designator in the footprint left unconnected in the device'); continue; }
          for (const q of list) usedPads.add(q);
          dev.connects.push({ gate: g === 'P' ? entry.hiddenGate! : Number(g) && entry.set.gates.length > 1 ? partLetter(Number(g)) : 'G$1', pin: pn, pads: list });
        }
      }
      entry.set.devices.push(dev);
    }
    return { set: entry.set, device: dev, pinNames: entry.pinNames };
  };

  /* ── the sheets ── */
  const sheetXml: string[] = [];
  const supplyParts: { name: string; set: string; value: string }[] = [];
  pages.forEach(({ s, inst: page }, si) => {
    const doc = s.doc, objs = doc.objects, fonts = doc.sheet.fonts;
    const owned = ownedBy(doc);
    const ref = (o: SchObject) => key2(page, { sheet: s.name, index: o.index });
    const resolve = specialResolver(doc, { docName: s.name, projectName: p.name, projectParams: vars }, false);
    const special = (t: string, owner = -1) => {
      const k = t.trim().toUpperCase();
      if (k === '=SHEETNUMBER') return String(si + 1);
      if (k === '=SHEETTOTAL') return String(pages.length);
      return resolve(t, owner);
    };
    const plain: string[] = [], instances: string[] = [];
    // The sheet's border as EAGLE's frame
    if (doc.sheet.border) plain.push(x('frame', { x1: 0, y1: 0, x2: num(MM(doc.sheet.width)), y2: num(MM(doc.sheet.height)), columns: Math.max(1, doc.sheet.zonesX || 4), rows: Math.max(1, doc.sheet.zonesY || 4), layer: 94 }));

    /* Drawings and free text */
    for (const o of objs) {
      if (o.owner >= 0 && (objs[o.owner]?.kind === 'component' || objs[o.owner]?.kind === 'sheetsymbol')) continue;
      if (!isShown(doc, o)) continue;
      switch (o.kind) {
        case 'text': if (o.role === 'label' && o.owner < 0) plain.push(...drawing(o, fonts, 97, mmK, (t) => special(t.text))); break;
        case 'polyline': case 'bezier': case 'polygon': case 'rect': case 'ellipse': case 'arc': case 'piechart': case 'busentry': plain.push(...drawing(o, fonts, 94, mmK)); break;
        case 'textframe': {
          plain.push(...drawing({ ...o, kind: 'rect', a: o.a, b: o.b, solid: false, transparent: true, fill: o.fill, r: 0 } as unknown as SchObject, fonts, 94, mmK).filter(() => o.border));
          const top = MM(Math.max(o.a.y, o.b.y)) - fontSize(fonts, o.font) * 1.2, left = MM(Math.min(o.a.x, o.b.x) + o.margin);
          o.text.split(/~1|\r?\n/).forEach((line, i) => { if (line.trim()) plain.push(x('text', { x: num(left), y: num(top - i * fontSize(fonts, o.font) * 1.5), size: num(fontSize(fonts, o.font)), layer: 97 }, line)); });
          break;
        }
        case 'sheetsymbol': {
          const a = mmK(o.at), b = { x: a.x + MM(o.w), y: a.y - MM(o.h) };
          for (const [p1, p2] of [[a, { x: b.x, y: a.y }], [{ x: b.x, y: a.y }, b], [b, { x: a.x, y: b.y }], [{ x: a.x, y: b.y }, a]] as [Vec2, Vec2][]) plain.push(x('wire', { x1: num(p1.x), y1: num(p1.y), x2: num(p2.x), y2: num(p2.y), width: 0.254, layer: 94 }));
          for (const kd of owned.get(o.index) ?? []) if (kd.kind === 'text' && !kd.hidden) plain.push(...drawing(kd, fonts, 97, mmK));
          warn('Sheet symbols drawn (EAGLE\'s sheets are flat: nets join by name)');
          break;
        }
        case 'image': warn('Images left out'); break;
        case 'harness': case 'harnessentry': case 'signalharness': warn('Harnesses left out (their nets are kept)'); break;
        case 'ieee': warn('IEEE symbols left out'); break;
        default:
      }
    }

    /* Parts */
    const pinPoint = new Map<number, Vec2>();   // pin object → its hot spot (mm)
    const pinRef = new Map<number, string>();   // pin object → its pinref
    for (const o of objs) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const comp = compAt.get(ref(o));
      const des = eagleName(comp?.designator || o.designator || 'U?');
      const footprint = comp?.kind === 2 ? '' : comp?.footprint ?? '';
      const { set, device, pinNames } = deviceSetOf(doc, o, footprint);
      const gates = set.gates.filter((g) => g.addlevel !== 'request');
      const gate = gates.length > 1 ? partLetter(Math.max(1, o.partId)) : 'G$1';
      if (!parts.has(des)) {
        const params = (owned.get(o.index) ?? []).filter((q) => q.kind === 'text' && q.role === 'parameter').map((q) => [bagOf(doc, q)?.get('NAME') ?? '', (q as { text: string }).text] as [string, string])
          .filter(([n, v]) => n && v && !/^(comment|designator)$/i.test(n) && !v.startsWith('='));
        const value = comp?.comment ?? '';
        parts.set(des, { xml: '', set: set.name, device: device.name, value, attrs: params, pkg: device.pkg });
      }
      // Placed as AD places it: AD mirrors, then turns (EAGLE's M·R(−a))
      const angle = o.mirrored ? norm(-(o.orient & 3) * 90) : (o.orient & 3) * 90;
      const at = mmK(o.at);
      const kids = (owned.get(o.index) ?? []).filter((q) => isShown(doc, q) || q.kind === 'text');
      const attr = (role: 'designator' | 'comment'): string | null => {
        const t = kids.find((q): q is SchObject & { kind: 'text' } => q.kind === 'text' && (role === 'designator' ? q.role === 'designator' : q.role === 'parameter' && /^comment$/i.test(bagOf(doc, q)?.get('NAME') ?? '')));
        if (!t) return null;
        const look = textLook(t.orient, t.justify), pt = mmK(t.at);
        return x('attribute', { name: role === 'designator' ? 'NAME' : 'VALUE', x: num(pt.x), y: num(pt.y), size: num(fontSize(fonts, t.font)), layer: role === 'designator' ? 95 : 96, ...look, display: t.hidden || !isShown(doc, t) ? 'off' : undefined });
      };
      instances.push(x('instance', { part: des, gate, x: num(at.x), y: num(at.y), smashed: 'yes', rot: angle || o.mirrored ? rot(angle, o.mirrored) : undefined }, [attr('designator'), attr('comment')].filter((q): q is string => !!q)));
      for (const q of kids) {
        if (q.kind !== 'pin' || q.hidden) continue;
        const d = DIR_VECTORS[q.orient & 3]!;
        pinPoint.set(q.index, mmK({ x: q.at.x + d.x * q.length, y: q.at.y + d.y * q.length }));
        const pn = pinNames.get(`${gates.length > 1 ? Math.max(1, o.partId) : 1}\u0000${q.designator}`);
        if (pn) pinRef.set(q.index, x('pinref', { part: des, gate, pin: pn }));
        // Its pads' nets (the board's signals should agree)
        const n = netAt.get(ref(q));
        if (n && device.pkg) for (const pad of lib.pads.get(device.pkg)?.get(q.designator.trim().toUpperCase()) ?? []) partPads.set(`${des}.${pad}`, nameOf.get(n)!);
      }
    }

    /* Power pins on no net: a net of their own (EAGLE would join them to the net of their name) */
    const loose: string[] = [];
    for (const o of objs) {
      if (o.kind !== 'pin' || o.hidden || o.electrical !== 7 || !isShown(doc, o) || netAt.has(ref(o))) continue;
      const pr = pinRef.get(o.index);
      if (!pr) continue;
      const owner = objs[o.owner];
      let nm = eagleName(`NC_${owner?.kind === 'component' ? compAt.get(ref(owner))?.designator ?? owner.designator : 'U'}_${o.designator}`);
      for (let k = 2; used.has(nm); k++) nm = `${nm}_${k}`;
      used.add(nm);
      loose.push(x('net', { name: nm, class: 0 }, [x('segment', {}, [pr])]));
    }

    /* Nets: each piece a segment */
    const byNet = new Map<CompiledNet, SchObject[]>();
    for (const o of objs) {
      if (!isShown(doc, o)) continue;
      if (!['wire', 'text', 'power', 'port', 'pin', 'sheetentry'].includes(o.kind)) continue;
      if (o.kind === 'text' && o.role !== 'netlabel') continue;
      const n = netAt.get(ref(o));
      if (!n) continue;
      const l = byNet.get(n) ?? [];
      l.push(o);
      byNet.set(n, l);
    }
    const junctions = [...objs.filter((o): o is SchObject & { kind: 'junction' } => o.kind === 'junction' && isShown(doc, o)).map((o) => o.at), ...autoJunctions(doc).map((j) => j.at)].map(mmK);
    const netsXml: string[] = [];
    const onSeg = (q: Vec2, a: Vec2, b: Vec2) => { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0; return Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y) < 1e-4; };
    for (const [n, list] of byNet) {
      const nm = nameOf.get(n)!;
      const wires = list.filter((o): o is SchObject & { kind: 'wire' } => o.kind === 'wire').map((w) => ({ o: w, pts: w.pts.map(mmK) }));
      // Pieces: wires that touch
      const parent = wires.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
      for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
        const a = wires[i]!.pts, b = wires[j]!.pts;
        const touch = [a[0]!, a.at(-1)!].some((q) => b.some((_, k) => k > 0 && onSeg(q, b[k - 1]!, b[k]!))) || [b[0]!, b.at(-1)!].some((q) => a.some((_, k) => k > 0 && onSeg(q, a[k - 1]!, a[k]!)));
        if (touch) parent[find(i)] = find(j);
      }
      const segs = new Map<number | string, { wires: typeof wires; items: string[]; at?: Vec2 }>();
      wires.forEach((w, i) => { const r = find(i); const sg = segs.get(r) ?? { wires: [], items: [] }; sg.wires.push(w); segs.set(r, sg); });
      const segAt = (q: Vec2): { wires: typeof wires; items: string[]; at?: Vec2 } => {
        for (const sg of segs.values()) if (sg.wires.some((w) => w.pts.some((_, k) => k > 0 && onSeg(q, w.pts[k - 1]!, w.pts[k]!)))) return sg;
        const k = `${num(q.x)},${num(q.y)}`;
        const sg = segs.get(k) ?? { wires: [], items: [], at: q };
        segs.set(k, sg);
        return sg;
      };
      for (const o of list) {
        switch (o.kind) {
          case 'pin': { const at = pinPoint.get(o.index); const pr = pinRef.get(o.index); if (at && pr) segAt(at).items.push(pr); break; }
          case 'text': { const at = mmK(o.at); segAt(at).items.push(x('label', { x: num(at.x), y: num(at.y), size: num(fontSize(fonts, o.font)), layer: 95, rot: o.orient & 3 ? rot((o.orient & 3) * 90) : undefined })); break; }
          case 'port': {
            const ends = [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }].map(mmK);
            const at = ends.find((q) => [...segs.values()].some((sg) => sg.wires.some((w) => w.pts.some((_, k) => k > 0 && onSeg(q, w.pts[k - 1]!, w.pts[k]!))))) ?? ends[0]!;
            segAt(at).items.push(x('label', { x: num(at.x), y: num(at.y), size: 1.778, layer: 95, xref: 'yes', rot: o.style >= 4 ? 'R90' : undefined }));
            break;
          }
          case 'power': {
            const at = mmK(o.at);
            if (o.crossSheet) { segAt(at).items.push(x('label', { x: num(at.x), y: num(at.y), size: 1.778, layer: 95, xref: 'yes' })); break; }
            // A supply symbol of the net (EAGLE's supply pin names its net)
            const style = o.style;
            const sk = `${nm}\u0000${style}`;
            let setName = supplySets.get(sk);
            if (!setName) {
              setName = lib.unique(`PWR_${nm.replace(/[^A-Z0-9_\-+.]/g, '_')}`.slice(0, 40));
              lib.symbols.set(setName, supplySymbol(nm, style));
              lib.sets.set(setName, { name: setName, prefix: 'PWR', description: '', uservalue: true, gates: [{ name: 'G$1', symbol: setName }], devices: [{ name: '', connects: [] }] });
              supplySets.set(sk, setName);
            }
            const part = `PWR$${++supplyN}`;
            supplyParts.push({ name: part, set: setName, value: nm });
            const orientRot = norm(((o.orient & 3) - 1) * 90);
            instances.push(x('instance', { part, gate: 'G$1', x: num(at.x), y: num(at.y), smashed: 'yes', rot: orientRot ? `R${orientRot}` : undefined },
              o.showText ? [x('attribute', { name: 'VALUE', x: num(at.x + [2.54, -1.27, -2.54, -1.27][o.orient & 3]!), y: num(at.y + [0, 3.3, 0, -4.3][o.orient & 3]!), size: 1.778, layer: 96 })] : [x('attribute', { name: 'VALUE', x: num(at.x), y: num(at.y), size: 1.778, layer: 96, display: 'off' })]));
            segAt(at).items.push(x('pinref', { part, gate: 'G$1', pin: nm }));
            break;
          }
          case 'sheetentry': {
            const at = mmK(entryAt(doc, o));
            segAt(at).items.push(x('label', { x: num(at.x), y: num(at.y), size: 1.778, layer: 95, xref: 'yes' }));
            break;
          }
          default:
        }
      }
      const out: string[] = [];
      for (const sg of segs.values()) {
        const k: string[] = [];
        for (const w of sg.wires) for (let i = 1; i < w.pts.length; i++) k.push(x('wire', { x1: num(w.pts[i - 1]!.x), y1: num(w.pts[i - 1]!.y), x2: num(w.pts[i]!.x), y2: num(w.pts[i]!.y), width: 0.1524, layer: 91 }));
        for (const j of junctions) if (sg.wires.some((w) => w.pts.some((_, i) => i > 0 && onSeg(j, w.pts[i - 1]!, w.pts[i]!)))) k.push(x('junction', { x: num(j.x), y: num(j.y) }));
        k.push(...sg.items);
        if (k.length) out.push(x('segment', {}, k));
      }
      if (out.length) netsXml.push(x('net', { name: nm, class: 0 }, out));
    }
    // Buses: named by their labels
    const busXml: string[] = [];
    const buses = objs.filter((o): o is SchObject & { kind: 'bus' } => o.kind === 'bus' && isShown(doc, o));
    if (buses.length) {
      const busLabels = objs.filter((o): o is SchObject & { kind: 'text' } => o.kind === 'text' && o.role === 'netlabel' && isShown(doc, o) && buses.some((b) => b.pts.some((_, i) => i > 0 && onSeg(o.at, b.pts[i - 1]!, b.pts[i]!))));
      buses.forEach((b, i) => {
        const lab = busLabels.find((t) => b.pts.some((_, k) => k > 0 && onSeg(t.at, b.pts[k - 1]!, b.pts[k]!)));
        const pts = b.pts.map(mmK);
        const kids = pts.slice(1).map((q, k) => x('wire', { x1: num(pts[k]!.x), y1: num(pts[k]!.y), x2: num(q.x), y2: num(q.y), width: 0.762, layer: 92 }));
        if (lab) { const at = mmK(lab.at); kids.push(x('label', { x: num(at.x), y: num(at.y), size: num(fontSize(fonts, lab.font)), layer: 95 })); }
        busXml.push(x('bus', { name: lab ? lab.text.replace(/\s+/g, '').toUpperCase() : `B$${si + 1}_${i + 1}` }, [x('segment', {}, kids)]));
      });
    }
    sheetXml.push(x('sheet', {}, [x('plain', {}, plain), x('instances', {}, instances), x('busses', {}, busXml), x('nets', {}, [...netsXml, ...loose])]));
  });

  return {
    parts: partPads,
    values: new Map([...parts].map(([d, pt]) => [d, pt.value])),
    autoNames,
    stats: { sheets: pages.length, parts: parts.size, nets: c.nets.length },
    xml: (library) => x('schematic', { xreflabel: '%F%N/%S.%C%R', xrefpart: '/%S.%C%R' }, [
      x('libraries', {}, [library]),
      x('attributes', {}, [...vars].map(([k, v]) => x('attribute', { name: eagleName(k), value: v }))),
      x('variantdefs', {}), x('classes', {}, [x('class', { number: 0, name: 'default', width: 0, drill: 0 })]),
      x('parts', {}, [
        ...[...parts].map(([des, pt]) => x('part', { name: des, library: '§LIB§', deviceset: pt.set, device: pt.device, value: pt.value || undefined },
          pt.attrs.map(([k, v]) => x('attribute', { name: eagleName(k), value: v })))),
        ...supplyParts.map((sp) => x('part', { name: sp.name, library: '§LIB§', deviceset: sp.set, device: '', value: sp.value })),
      ]),
      x('sheets', {}, sheetXml),
    ]).replace(/library="§LIB§"/g, `library="${esc(library.match(/^<library name="([^"]*)"/)?.[1] ?? 'KONIUM')}"`),
  };
}

/** A sheet entry's point on its sheet symbol's edge. */
function entryAt(doc: SchDocument, e: SchObject & { kind: 'sheetentry' }): Vec2 {
  const sym = doc.objects[e.owner] as (SchObject & { kind: 'sheetsymbol' }) | undefined;
  if (!sym || sym.kind !== 'sheetsymbol') return { x: 0, y: 0 };
  const { at, w, h } = sym;
  // Side 0 left, 1 right, 2 top, 3 bottom; distance from the top (left, right) or the left (top, bottom)
  return e.side === 0 ? { x: at.x, y: at.y - e.distance } : e.side === 1 ? { x: at.x + w, y: at.y - e.distance } : e.side === 2 ? { x: at.x + e.distance, y: at.y } : { x: at.x + e.distance, y: at.y - h };
}

/** A supply symbol: its pin (named by the net) at its origin, its drawing above it in AD's style. */
function supplySymbol(net: string, style: number): string[] {
  const w = (x1: number, y1: number, x2: number, y2: number) => x('wire', { x1, y1, x2, y2, width: 0.254, layer: 94 });
  const ground = style === 4 || style === 5 || style === 6 || style === 8 || style === 9;
  const body = ground
    ? style === 5 ? [w(0, 0, 0, 1.27), w(-1.905, 1.27, 1.905, 1.27), w(1.905, 1.27, 0, 3.175), w(0, 3.175, -1.905, 1.27)]
      : style === 6 || style === 9 ? [w(0, 0, 0, 1.27), w(-1.905, 1.27, 1.905, 1.27), w(-1.905, 1.27, -2.54, 2.54), w(0, 1.27, -0.635, 2.54), w(1.905, 1.27, 1.27, 2.54)]
        : [w(0, 0, 0, 1.27), w(-1.905, 1.27, 1.905, 1.27), w(-1.27, 1.905, 1.27, 1.905), w(-0.635, 2.54, 0.635, 2.54)]
    : style === 0 ? [w(0, 0, 0, 1.27), x('circle', { x: 0, y: 1.905, radius: 0.635, width: 0.254, layer: 94 })]
      : style === 1 || style === 7 ? [w(0, 0, 0, 2.54), w(-1.27, 1.27, 0, 2.54), w(0, 2.54, 1.27, 1.27)]
        : style === 3 ? [w(0, 0, 0, 1.27), w(-1.905, 1.27, -0.635, 1.905), w(-0.635, 1.905, 0.635, 0.635), w(0.635, 0.635, 1.905, 1.27)]
          : [w(0, 0, 0, 1.27), w(-1.905, 1.27, 1.905, 1.27)];
  // AD draws a ground below its point: EAGLE's symbol drawn upward, turned with the port
  return [...body, x('text', { x: -1.905, y: 3.175, size: 1.778, layer: 96 }, '>VALUE'), x('pin', { name: net, x: 0, y: 0, visible: 'off', length: 'point', direction: 'sup', rot: 'R90' })];
}

/* ── the board ── */

function writeBoard(doc: PcbDocument, pkgName: Map<string, string>, lm: LayerMap, warn: (w: string) => void, schPads?: Map<string, string>, values?: Map<string, string>, autoNames?: Map<string, string>): (library: string, layers: string) => string {
  const st = boardSettings(doc);
  const plain: string[] = [], elements: string[] = [], signals = new Map<number, string[]>();
  const sig = (n: number) => { let l = signals.get(n); if (!l) { l = []; signals.set(n, l); } return l; };
  const usedNets = new Set<string>();
  const netName = new Map<number, string>();
  for (const n of doc.nets) {
    // The schematic's automatic nets by EAGLE's automatic names (N$1 …), as the schematic has them
    // A board read from EAGLE: its signals' own names (kept.ts)
    let nm = n.bag.get('EAGLESIGNAL') ?? autoNames?.get(eagleName(n.name)) ?? eagleName(n.name, `N$${n.index + 1}`);
    for (let k = 2; usedNets.has(nm); k++) nm = `${eagleName(n.name)}_${k}`;
    usedNets.add(nm);
    netName.set(n.index, nm);
  }
  const copperN = lm.copper;
  if (doc.board.copperStack.length > 16) warn('More than 16 copper layers: EAGLE has 16, the rest left out');

  /* Board shape and cut-outs on Dimension */
  const verts: PolyVertex[] = doc.board.vertices.length ? doc.board.vertices : doc.board.outline.map((q) => ({ p: q }));
  verts.forEach((v, i) => {
    const nx = verts[(i + 1) % verts.length]!;
    if (v.arc) {
      const sweep = norm(v.arc.ea - v.arc.sa) || 360;
      const atS = arcPoint(v.arc.c, v.arc.r, v.arc.sa);
      const fwd = Math.hypot(atS.x - v.p.x, atS.y - v.p.y) < Math.max(1000, v.arc.r * 0.01);
      plain.push(x('wire', { x1: MM(v.p.x), y1: MM(v.p.y), x2: MM(nx.p.x), y2: MM(nx.p.y), width: 0, layer: 20, curve: fwd ? sweep : -sweep }));
    } else plain.push(x('wire', { x1: MM(v.p.x), y1: MM(v.p.y), x2: MM(nx.p.x), y2: MM(nx.p.y), width: 0, layer: 20 }));
  });

  /* Components: elements of their packages */
  const elemName = new Map<number, string>();
  const padNameOf = new Map<PcbPad, string>();
  for (const c of doc.components) {
    const des = eagleName(c.designator || `U$${c.index + 1}`);
    elemName.set(c.index, des);
    const pkg = pkgName.get(c.pattern.toUpperCase());
    if (!pkg) { warn('Components of no footprint left out'); continue; }
    // Its pads' EAGLE names, as the package names them (AD's order)
    const order = [...doc.prims].filter((q): q is PcbPad => q.kind === 'pad' && q.component === c.index);
    const counts = new Map<string, number>();
    let anon = 0;
    for (const q of order) {
      const base = q.name.trim() ? eagleName(q.name) : `P$${++anon}`;
      const k = (counts.get(base) ?? 0) + 1;
      counts.set(base, k);
      padNameOf.set(q, k > 1 ? `${base}_${k}` : base);
    }
    const bottom = c.layer === LY.BOTTOM;
    // AD's bottom part is its footprint reflected top to bottom, then turned: EAGLE's MR(180 − a)
    const a = bottom ? norm(180 - c.rotation) : norm(c.rotation);
    const texts = doc.prims.filter((q): q is PcbPrim & { kind: 'text' } => q.kind === 'text' && q.component === c.index && (q.isDesignator || q.isComment));
    const attrs = texts.map((t) => {
      const n = lm.of(t.layer);
      const layer = t.isDesignator ? (n === 22 ? 26 : n === 21 || n === null ? 25 : n) : (n === 22 ? 28 : n === 21 || n === null ? 27 : n);
      return x('attribute', { name: t.isDesignator ? 'NAME' : 'VALUE', x: MM(t.at.x), y: MM(t.at.y), size: MM(t.height + t.strokeWidth), layer, font: 'vector',
        rot: rot(t.mirrored ? -t.rotation : t.rotation, t.mirrored, true), display: t.hidden || (t.isDesignator ? !c.nameOn : !c.commentOn) ? 'off' : undefined });
    });
    // Its value: the schematic's (EAGLE keeps the two the same), else the comment the board shows
    const comment = values?.get(des) ?? texts.find((t) => t.isComment)?.text ?? '';
    elements.push(x('element', { name: des, library: '§LIB§', package: pkg, value: comment, x: MM(c.at.x), y: MM(c.at.y), smashed: 'yes', rot: a || bottom ? rot(a, bottom) : undefined }, attrs));
    for (const q of order) if (q.net !== NO_NET) sig(q.net).push(x('contactref', { element: des, pad: padNameOf.get(q)! }));
  }

  /* The board's own primitives: by signal, or plain */
  const polyCount = doc.polygons.length;
  for (const q of doc.prims) {
    if ('component' in q && q.component !== undefined && q.component !== NO_NET && q.component >= 0) continue;
    switch (q.kind) {
      case 'track': case 'arc': {
        if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon < polyCount) break;   // a pour's copper: EAGLE pours its own
        if (isCopper(q.layer) && q.net !== NO_NET && !q.keepout) { const n = copperN.get(q.layer); if (n !== undefined) sig(q.net).push(...pcbItems(q, lm, warn)); break; }
        if (q.keepout && isCopper(q.layer)) { const n = copperN.get(q.layer); if (n === 1 || n === 16) plain.push(...pcbItems({ ...q, layer: LY.KEEPOUT }, { ...lm, of: () => (n === 1 ? 41 : 42) }, warn)); else warn('Keep-outs on inner layers left out'); break; }
        plain.push(...pcbItems(q, lm, warn));
        break;
      }
      case 'via': {
        const s = copperN.get(q.layerStart) ?? 1, e = copperN.get(q.layerEnd) ?? 16;
        if (s !== 1 || e !== 16) warn('Blind and buried vias written with their layers: EAGLE wants a layer setup that has them (Design Rules › Layers)');
        const v = x('via', { x: MM(q.at.x), y: MM(q.at.y), extent: `${Math.min(s, e)}-${Math.max(s, e)}`, drill: MM(q.hole), diameter: MM(q.diameter) });
        if (q.net !== NO_NET) sig(q.net).push(v);
        else { sig(-1).push(v); warn('Vias of no net written to a signal of their own'); }
        break;
      }
      case 'region': {
        if (q.boardCutout) { q.outline.forEach((v, i) => { const nx = q.outline[(i + 1) % q.outline.length]!; plain.push(x('wire', { x1: MM(v.x), y1: MM(v.y), x2: MM(nx.x), y2: MM(nx.y), width: 0, layer: 20 })); }); break; }
        if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon < polyCount) break;
        if (q.regionKind === 1) {
          const n = lm.of(q.layer);
          if (n !== null) plain.push(x('polygon', { width: 0.0254, layer: n, pour: 'cutout' }, q.outline.map((v) => x('vertex', { x: MM(v.x), y: MM(v.y) }))));
          break;
        }
        if (q.keepout || q.layer === LY.KEEPOUT) {
          const ls = q.layer === LY.KEEPOUT ? [41, 42, 43] : copperN.get(q.layer) === 1 ? [41] : copperN.get(q.layer) === 16 ? [42] : [];
          for (const l of ls) plain.push(x('polygon', { width: 0.0254, layer: l }, q.outline.map((v) => x('vertex', { x: MM(v.x), y: MM(v.y) }))));
          break;
        }
        if (isCopper(q.layer) && q.net !== NO_NET) { sig(q.net).push(x('polygon', { width: 0.0254, layer: copperN.get(q.layer)!, rank: 1, thermals: 'no' }, q.outline.map((v) => x('vertex', { x: MM(v.x), y: MM(v.y) })))); warn('Copper regions of a net made polygons EAGLE pours'); break; }
        plain.push(...pcbItems(q, lm, warn));
        break;
      }
      case 'pad': {
        if (q.hole > 0 && !q.plated) { plain.push(x('hole', { x: MM(q.at.x), y: MM(q.at.y), drill: MM(q.hole) })); break; }
        if (q.hole > 0 && q.net !== NO_NET) { sig(q.net).push(x('via', { x: MM(q.at.x), y: MM(q.at.y), extent: '1-16', drill: MM(q.hole), diameter: MM(Math.max(q.top.w, q.top.h)) })); warn('Free plated pads made vias of their nets'); break; }
        warn('Free pads (of no component) left out');
        break;
      }
      case 'text': case 'fill': plain.push(...pcbItems(q, lm, warn)); break;
      default:
    }
  }
  /* Polygon pours: EAGLE's polygons of their nets */
  for (const poly of doc.polygons) {
    if (!/^polygon$/i.test(poly.type || 'Polygon')) continue;
    const n = copperN.get(poly.layer);
    if (n === undefined || poly.outline.length < 3) continue;
    const hatched = poly.hatch && !/^solid$/i.test(poly.hatch) && !/^none$/i.test(poly.hatch);
    const width = Math.max(0.1016, MM(parseLen(poly.bag.get('TRACKWIDTH') ?? '8mil')));
    const item = x('polygon', { width: num(width), layer: n, pour: hatched ? 'hatch' : undefined, spacing: hatched ? num(Math.max(width * 2, MM(parseLen(poly.bag.get('GRIDSIZE') ?? '20mil')))) : undefined,
      orphans: poly.bag.get('REMOVEDEAD') === 'FALSE' ? 'yes' : undefined, rank: Math.max(1, Math.min(6, Number(poly.bag.get('POURINDEX') ?? '0') + 1)) },
    poly.outline.map((v) => x('vertex', { x: MM(v.x), y: MM(v.y) })));
    if (poly.net !== NO_NET && poly.net >= 0) sig(poly.net).push(item); else plain.push(item);
  }

  /* Classes and rules */
  const classes: string[] = [x('class', { number: 0, name: 'default', width: 0, drill: 0 }, [x('clearance', { class: 0, value: num(st.clearance) })])];
  const classOfNet = new Map<string, number>();
  st.classes.slice(0, 7).forEach((cl, i) => {
    classes.push(x('class', { number: i + 1, name: eagleName(cl.name).replace(/[^A-Z0-9_]/g, '_'), width: num(cl.trackWidth ?? 0), drill: num(cl.viaDrill ?? 0) }, cl.clearance !== undefined ? [x('clearance', { class: i + 1, value: num(cl.clearance) })] : []));
    for (const m of cl.nets) if (!classOfNet.has(m.toUpperCase())) classOfNet.set(m.toUpperCase(), i + 1);
  });
  if (st.classes.length > 7) warn('More than 7 net classes: EAGLE has 8 (the default and 7), the rest left out');
  const copperList = [...new Set(copperN.values())].sort((a, b) => a - b);
  const setup = copperList.length <= 2 ? '(1*16)' : `(${copperList.map((l, i) => (i ? (i % 2 ? '+' : '*') : '') + l).join('')})`;
  const stack = readStack(doc.board.bag!, doc.board.copperStack);
  const cuThick = (l: number) => { const ad = [...copperN].find(([, n]) => n === l)?.[0]; const row = stack.find((r) => r.layer === ad); return row?.copper ? `${num(MM(row.copper))}mm` : '0.035mm'; };
  const diel = stack.filter((r) => r.kind === 'dielectric' && r.height).map((r) => `${num(MM(r.height))}mm`);
  const mil = (v: number) => `${num(v / 0.0254)}mil`;
  const params: [string, string][] = [
    ['layerSetup', setup], ['mtCopper', Array.from({ length: 16 }, (_, i) => cuThick(i + 1)).join(' ')], ['mtIsolate', (diel.length ? diel : ['1.5mm']).concat(Array(15).fill('0.15mm')).slice(0, 15).join(' ')],
    ...['mdWireWire', 'mdWirePad', 'mdWireVia', 'mdPadPad', 'mdPadVia', 'mdViaVia', 'mdSmdPad', 'mdSmdVia', 'mdSmdSmd', 'mdViaViaSameLayer'].map((k): [string, string] => [k, mil(st.clearance)]),
    ['mnLayersViaInSmd', '2'], ['mdCopperDimension', mil(st.copperEdge || 0.254)], ['mdDrill', mil(st.holeToHole)], ['mdSmdStop', '0mil'],
    ['msWidth', mil(st.minTrack)], ['msDrill', mil(st.minDrill)], ['msMicroVia', '9.99mm'], ['msBlindViaRatio', '0.5'],
    // Pads and vias at the sizes they have: no restring of the rules' own
    ...['rvPadTop', 'rvPadInner', 'rvPadBottom', 'rvViaOuter', 'rvViaInner', 'rvMicroViaOuter', 'rvMicroViaInner'].map((k): [string, string] => [k, '0']),
    ...['rlMinPadTop', 'rlMaxPadTop', 'rlMinPadInner', 'rlMaxPadInner', 'rlMinPadBottom', 'rlMaxPadBottom', 'rlMinViaOuter', 'rlMaxViaOuter', 'rlMinViaInner', 'rlMaxViaInner', 'rlMinMicroViaOuter', 'rlMaxMicroViaOuter', 'rlMinMicroViaInner', 'rlMaxMicroViaInner'].map((k): [string, string] => [k, '0mil']),
    ['psTop', '-1'], ['psBottom', '-1'], ['psFirst', '-1'], ['psElongationLong', '100'], ['psElongationOffset', '100'],
    ['mvStopFrame', '1'], ['mvCreamFrame', '0'], ['mlMinStopFrame', mil(maskOf(doc))], ['mlMaxStopFrame', mil(maskOf(doc))], ['mlMinCreamFrame', mil(Math.max(0, -pasteOf(doc)))], ['mlMaxCreamFrame', mil(Math.max(0, -pasteOf(doc)))],
    ['mlViaStopLimit', '0mil'], ['srRoundness', '0'], ['srMinRoundness', '0mil'], ['srMaxRoundness', '0mil'], ['slThermalIsolate', mil(thermalOf(doc))], ['slThermalsForVias', '0'],
    ['checkAngle', '0'], ['checkFont', '1'], ['checkRestrict', '1'], ['useDiameter', '15'], ['maxErrors', '50'],
  ];
  if (schPads) {
    // The board against the schematic, as EAGLE will check them
    let bad = 0;
    for (const [n, list] of signals) for (const it of list) {
      const m = /^<contactref element="([^"]*)" pad="([^"]*)"/.exec(it);
      if (m && schPads.get(`${unesc(m[1]!)}.${unesc(m[2]!)}`) !== netName.get(n)) bad++;
    }
    if (bad) warn(`${bad} pad${bad === 1 ? '' : 's'} on other nets than the schematic's (or on none there): EAGLE will find the schematic and board inconsistent until they're synchronised (Design › Update PCB first)`);
  }
  return (library, layers) => {
    const libName = library.match(/^<library name="([^"]*)"/)?.[1] ?? 'KONIUM';
    const sigXml = [...signals].map(([n, list]) => x('signal', { name: n < 0 ? 'N$VIAS' : netName.get(n)!, class: n >= 0 && classOfNet.has((doc.nets[n]?.name ?? '').toUpperCase()) ? classOfNet.get((doc.nets[n]?.name ?? '').toUpperCase()) : undefined }, list));
    return HEAD([SETTINGS, x('grid', { distance: 0.05, unitdist: 'inch', unit: 'inch', style: 'lines', multiple: 1, display: 'no', altdistance: 0.01, altunitdist: 'inch', altunit: 'inch' }), layers,
      x('board', {}, [x('plain', {}, plain), x('libraries', {}, [library]), x('attributes', {}), x('variantdefs', {}), x('classes', {}, classes),
        x('designrules', { name: 'Konium Designer' }, [x('description', { language: 'en' }, 'Design rules from Konium Designer'), ...params.map(([k, v]) => x('param', { name: k, value: v }))]),
        x('elements', {}, elements.map((e) => e.replace('library="§LIB§"', `library="${libName}"`))), x('signals', {}, sigXml)])]);
  };
}
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
/** The board's solder mask expansion, paste expansion and thermal gap (mm) by its rules. */
function maskOf(doc: PcbDocument): number { const r = doc.rules.find((q) => q.bag.get('RULEKIND') === 'SolderMaskExpansion'); return r ? MM(parseLen(r.bag.get('EXPANSION') ?? '4mil')) : 0.1016; }
function pasteOf(doc: PcbDocument): number { const r = doc.rules.find((q) => q.bag.get('RULEKIND') === 'PasteMaskExpansion'); return r ? MM(parseLen(r.bag.get('EXPANSION') ?? '0mil')) : 0; }
function thermalOf(doc: PcbDocument): number { const r = doc.rules.find((q) => q.bag.get('RULEKIND') === 'PolygonConnect'); return r ? MM(parseLen(r.bag.get('AIRGAPWIDTH') ?? '10mil')) : 0.254; }
function parseLen(s: string): number { const m = /^\s*(-?[0-9.]+)\s*(mil|mm)?/i.exec(s); if (!m) return 0; const v = Number(m[1]); return (m[2] ?? 'mil').toLowerCase() === 'mm' ? v * UNITS_PER_MM : v * 10000; }
