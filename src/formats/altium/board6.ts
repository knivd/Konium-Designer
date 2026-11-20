/**
 * Board6 as AD17 writes it for a new board, and a PCB library's header (Library/Data's property
 * block), which holds the same layer system. Checked against a board saved by AD17 (two layers added to a new one)
 * and AD17+ libraries:
 * - AD17 builds its layer list from these keys: a board with only a few legacy keys crashed it
 *   ("Access violation … whilst loading section Board6"), and a library with them showed one layer
 *   tab and its multi-layer pads without copper or holes (no Multi-Layer, no Pad Holes layer).
 * - The layer stack in three forms (see model/pcbStack): V9 master stack, substack, stack and cache
 *   entries; V8 master stack, substack and entries; legacy LAYER1–82 and LAYERV7_0–15 (Mechanical
 *   17–32). Ids: copper 0x01000000 + n (bottom 0x0100FFFF), planes 0x01010000 + n, mechanical
 *   0x01020000 + n, others 0x01030000 + n, dielectrics 0x01040000 + n.
 * - The board outline as a polygon (vertices with the closing copy), the sheet, plane nets, drill
 *   pair, TOGGLELAYERS (one digit per legacy layer), layer sets, grids and snap options.
 * Left out: the 2D / 3D view configuration strings and the impedance formulas (AD uses its own
 * defaults [est]).
 */
import { PropertyBag } from './props';
import { toV7, writeVertices } from './pcbdoc';
import { formatAltiumLength, mil } from '../../core/units';
import { L, layerName, type LayerId } from '../../model/layers';
import type { PolyVertex } from '../../model/pcb';
import type { BBox } from '../../core/geom';
import type { StackLayer } from '../../model/pcbStack';

type KV = [string, string][];
const TF = (b: boolean) => (b ? 'TRUE' : 'FALSE');
const len = (v: number) => formatAltiumLength(Math.round(v));
const units = (v: number) => v.toFixed(6);

/** A random (version 4) GUID in braces, upper case, as AD writes them. */
export const newGuid = (): string => {
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('');
  return `{${h(8)}-${h(4)}-4${h(3)}-${'89AB'[Math.floor(Math.random() * 4)]}${h(3)}-${h(12)}}`;
};
export const newUniqueId = (): string => Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

const SYS = 0x01030000, DIEL = 0x01040000;
/** Layers AD lists beside the stack: name, 32-bit id, legacy number (0: none). */
const SYSTEM: [string, number, number][] = [
  ['Multi-Layer', SYS + 15, 74], ['Connections', SYS + 16, 75], ['Background', SYS + 17, 76], ['DRC Error Markers', SYS + 18, 77],
  ['DRC Detail Markers', SYS + 26, 0], ['Selections', SYS + 19, 78], ['Visible Grid 1', SYS + 20, 79], ['Visible Grid 2', SYS + 21, 80],
  ['Pad Holes', SYS + 22, 81], ['Via Holes', SYS + 23, 82], ['Top Pad Master', SYS + 24, 0], ['Bottom Pad Master', SYS + 25, 0],
];
const sys = (name: string) => SYSTEM.find(([n]) => n === name)!;
/** The two system layers a new AD17 board marks as used by primitives. */
const USED = new Set([SYS + 15, SYS + 18]);

const LEGACY_EXTRA: Record<number, string> = Object.fromEntries(SYSTEM.filter(([, , n]) => n).map(([name, , n]) => [n, name]));
/** Legacy layer n's name (1–82). */
export const legacyName = (n: number): string => LEGACY_EXTRA[n] ?? layerName(n);

const blank = (kind: StackLayer['kind'], layer: LayerId | null, v7: number, name: string): StackLayer =>
  ({ kind, layer, v7, name, copper: mil(1.4), placement: 0, pullback: mil(20), dielType: 0, dielMaterial: '', dielConst: 4.8, height: 0, coverlay: 0 });
const mask = (l: LayerId): StackLayer => ({ ...blank('solder', l, toV7(l), layerName(l)), dielType: 3, dielConst: 3.5, height: mil(0.4), dielMaterial: 'Solder Resist' });

/** A new AD17 board's stack: pastes, overlays, solder masks, Top Layer, a 10 mil FR-4 core (Dk 4.2), Bottom Layer. */
export function defaultStack(): StackLayer[] {
  const named = (kind: StackLayer['kind'], l: LayerId) => blank(kind, l, toV7(l), layerName(l));
  return [
    named('paste', L.TOP_PASTE), named('overlay', L.TOP_OVERLAY), mask(L.TOP_SOLDER),
    { ...named('signal', L.TOP), placement: 1 },
    { ...blank('dielectric', null, DIEL + 1, 'Dielectric 1'), dielType: 1, dielConst: 4.2, height: mil(10), dielMaterial: 'FR-4' },
    { ...named('signal', L.BOTTOM), placement: 2 },
    mask(L.BOTTOM_SOLDER), named('overlay', L.BOTTOM_OVERLAY), named('paste', L.BOTTOM_PASTE),
  ];
}

/** A stack row's own keys after ID / NAME / LAYERID / USEDBYPRIMS, as AD17 writes them. */
export function stackRowKeys(r: StackLayer): KV {
  if (r.kind === 'signal') return [['COPTHICK', len(r.copper)], ['COMPONENTPLACEMENT', String(r.placement)]];
  if (r.kind === 'plane') return [['COPTHICK', len(r.copper)], ['PULLBACKDISTANCE', len(r.pullback)]];
  const diel: KV = [['DIELTYPE', String(r.dielType)], ['DIELCONST', r.dielConst.toFixed(3)], ['DIELHEIGHT', len(r.height)], ['DIELMATERIAL', r.dielMaterial]];
  if (r.kind === 'dielectric') return diel;
  if (r.kind === 'solder') return [...diel, ['COVERLAY_EXPANSION', len(r.coverlay)]];
  return [];
}

interface Ids { master: string; substack: string }

/** One entry's keys (without its prefix): the substack's CONTEXT / USEDBYPRIMS for stack layers, then ID, NAME, LAYERID, USEDBYPRIMS, the rest. */
const entry = (name: string, v7: number, rest: KV, substack?: string): KV => [
  ...(substack ? [[`${substack}CONTEXT`, '0'], [`${substack}USEDBYPRIMS`, 'FALSE']] as KV : []),
  ['ID', newGuid()], ['NAME', name], ['LAYERID', String(v7)], ['USEDBYPRIMS', TF(USED.has(v7))], ...rest,
];
const mechEntry = (n: number, on: boolean) => entry(`Mechanical ${n}`, 0x01020000 + n, [['MECHENABLED', TF(on)]]);

function stackEntries(rows: StackLayer[], ids: Ids): KV[] {
  return rows.map((r) => entry(r.name, r.v7, stackRowKeys(r), ids.substack));
}

/** V9_CACHE_LAYER entries: system layers, the stack, unused mid-layers and planes, drill guide, keep-out, mechanical 1–16, drill drawing, mechanical 17–32. */
function cacheEntries(rows: StackLayer[], ids: Ids, mechOn: (n: number) => boolean): KV[] {
  const inStack = new Set(rows.map((r) => r.v7));
  const out: KV[] = SYSTEM.map(([n, id]) => entry(n, id, []));
  out.push(...stackEntries(rows, ids));
  for (let n = 1; n <= 30; n++) if (!inStack.has(0x01000001 + n)) out.push(entry(`Mid-Layer ${n}`, 0x01000001 + n, [['COPTHICK', '1.4mil'], ['COMPONENTPLACEMENT', '0']]));
  for (let n = 1; n <= 16; n++) if (!inStack.has(0x01010000 + n)) out.push(entry(`Internal Plane ${n}`, 0x01010000 + n, [['COPTHICK', '1.4mil'], ['PULLBACKDISTANCE', '20mil']]));
  out.push(entry('Drill Guide', SYS + 12, []), entry('Keep-Out Layer', SYS + 13, []));
  for (let n = 1; n <= 16; n++) out.push(mechEntry(n, mechOn(n)));
  out.push(entry('Drill Drawing', SYS + 14, []));
  for (let n = 17; n <= 32; n++) out.push(mechEntry(n, mechOn(n)));
  return out;
}

/** LAYER_V8 entries: the stack, drill guide, keep-out, mechanical 1–16, drill drawing, the system layers, mechanical 17–32. */
function v8Entries(rows: StackLayer[], ids: Ids, mechOn: (n: number) => boolean): KV[] {
  const out: KV[] = stackEntries(rows, ids);
  out.push(entry('Drill Guide', SYS + 12, []), entry('Keep-Out Layer', SYS + 13, []));
  for (let n = 1; n <= 16; n++) out.push(mechEntry(n, mechOn(n)));
  out.push(entry('Drill Drawing', SYS + 14, []));
  for (const name of ['Multi-Layer', 'Connections', 'Background', 'DRC Error Markers', 'Selections', 'Visible Grid 1', 'Visible Grid 2', 'Pad Holes', 'Via Holes', 'Top Pad Master', 'Bottom Pad Master', 'DRC Detail Markers']) {
    const [n, id] = sys(name);
    out.push(entry(n, id, []));
  }
  for (let n = 17; n <= 32; n++) out.push(mechEntry(n, mechOn(n)));
  return out;
}

/** The layer system: V9 and V8 stacks, solder masks, stack style, legacy LAYER1–82 and LAYERV7_0–15. */
function layerSystem(rows: StackLayer[], mechOn: (n: number) => boolean, ids: Ids): KV {
  const kv: KV = [];
  const stackHead = (p: string, sub: string) => {
    kv.push([`${p}STYLE`, '0'], [`${p}ID`, ids.master], [`${p}NAME`, 'Master layer stack'], [`${p}SHOWTOPDIELECTRIC`, 'FALSE'], [`${p}SHOWBOTTOMDIELECTRIC`, 'FALSE'], [`${p}ISFLEX`, 'FALSE']);
    kv.push([`${sub}ID`, ids.substack], [`${sub}NAME`, 'Board Layer Stack'], [`${sub}SHOWTOPDIELECTRIC`, 'FALSE'], [`${sub}SHOWBOTTOMDIELECTRIC`, 'FALSE'],
      [`${sub}ISFLEX`, 'FALSE'], [`${sub}SERVICE`, 'FALSE'], [`${sub}USEDBYPRIMS`, 'TRUE'], [`${sub}TYPE`, '1']);
  };
  stackHead('V9_MASTERSTACK_', 'V9_SUBSTACK0_');
  stackEntries(rows, ids).forEach((e, i) => kv.push(...e.map(([k, v]) => [`V9_STACK_LAYER${i}_${k}`, v] as [string, string])));
  cacheEntries(rows, ids, mechOn).forEach((e, i) => kv.push(...e.map(([k, v]) => [`V9_CACHE_LAYER${i}_${k}`, v] as [string, string])));
  stackHead('LAYERMASTERSTACK_V8', 'LAYERSUBSTACK_V8_0');
  v8Entries(rows, ids, mechOn).forEach((e, i) => kv.push(...e.map(([k, v]) => [`LAYER_V8_${i}${k.startsWith('{') ? '_' : ''}${k}`, v] as [string, string])));
  for (const [p, l] of [['TOP', L.TOP_SOLDER], ['BOTTOM', L.BOTTOM_SOLDER]] as [string, LayerId][]) {
    const m = rows.find((r) => r.layer === l) ?? mask(l);
    kv.push([`${p}TYPE`, String(m.dielType)], [`${p}CONST`, m.dielConst.toFixed(3)], [`${p}HEIGHT`, len(m.height)], [`${p}MATERIAL`, m.dielMaterial]);
  }
  kv.push(['LAYERSTACKSTYLE', '0'], ['SHOWTOPDIELECTRIC', 'FALSE'], ['SHOWBOTTOMDIELECTRIC', 'FALSE']);
  // Legacy: each layer's name, the copper chain, and the dielectric under each copper layer (a record separator every five layers, as AD writes them)
  const copper = rows.filter((r) => r.kind === 'signal' || r.kind === 'plane');
  for (let n = 1; n <= 82; n++) {
    if (n > 1 && n % 5 === 1) kv.push(['RECORD', 'Board']);
    const i = copper.findIndex((r) => r.layer === n), r = copper[i];
    const d = r ? rows[rows.indexOf(r) + 1] : undefined;
    const diel = d?.kind === 'dielectric' ? d : undefined;
    const mech = n >= L.MECH1 && n <= L.MECH16 ? mechOn(n - L.MECH1 + 1) : false;
    // (top overlay, paste and solder point down to the top layer, the bottom ones up to the bottom layer)
    const side = n === L.TOP_OVERLAY || n === L.TOP_PASTE || n === L.TOP_SOLDER ? 1 : n === L.BOTTOM_OVERLAY || n === L.BOTTOM_PASTE || n === L.BOTTOM_SOLDER ? -1 : 0;
    kv.push([`LAYER${n}NAME`, r?.name ?? legacyName(n)], [`LAYER${n}PREV`, String(r ? copper[i - 1]?.layer ?? 0 : side < 0 ? L.BOTTOM : 0)],
      [`LAYER${n}NEXT`, String(r ? copper[i + 1]?.layer ?? 0 : side > 0 ? L.TOP : 0)],
      [`LAYER${n}MECHENABLED`, TF(mech)], [`LAYER${n}COPTHICK`, len(r?.copper ?? mil(1.4))],
      [`LAYER${n}DIELTYPE`, String(diel?.dielType ?? 0)], [`LAYER${n}DIELCONST`, (diel?.dielConst ?? 4.8).toFixed(3)],
      [`LAYER${n}DIELHEIGHT`, len(diel?.height ?? mil(12.6))], [`LAYER${n}DIELMATERIAL`, diel ? diel.dielMaterial : 'FR-4']);
  }
  for (let i = 0; i < 16; i++) {
    kv.push([`LAYERV7_${i}LAYERID`, String(0x01020011 + i)], [`LAYERV7_${i}NAME`, `Mechanical ${17 + i}`], [`LAYERV7_${i}PREV`, String(SYS)], [`LAYERV7_${i}NEXT`, String(SYS)],
      [`LAYERV7_${i}MECHENABLED`, TF(mechOn(17 + i))], [`LAYERV7_${i}COPTHICK`, '1.4mil'], [`LAYERV7_${i}DIELTYPE`, '0'], [`LAYERV7_${i}DIELCONST`, '4.800'],
      [`LAYERV7_${i}DIELHEIGHT`, '12.6mil'], [`LAYERV7_${i}DIELMATERIAL`, 'FR-4']);
  }
  return kv;
}

/** The legacy short names layer sets use: TopLayer, MidLayer1, InternalPlane1, Mechanical1 … */
const shortName = (l: LayerId): string => {
  if (l === L.TOP) return 'TopLayer';
  if (l === L.BOTTOM) return 'BottomLayer';
  if (l > L.TOP && l < L.BOTTOM) return `MidLayer${l - 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `InternalPlane${l - L.PLANE1 + 1}`;
  return `Mechanical${l - L.MECH1 + 1}`;
};

/** The stack's mid-layers and planes as layer sets name them (MidLayer1 …, InternalPlane1 …), in stack order. */
export function stackSetNames(rows: StackLayer[]): { mids: string[]; planes: string[] } {
  return {
    mids: rows.filter((r) => r.kind === 'signal' && r.layer !== L.TOP && r.layer !== L.BOTTOM).map((r) => shortName(r.layer!)),
    planes: rows.filter((r) => r.kind === 'plane').map((r) => shortName(r.layer!)),
  };
}

/** View › layer sets as AD17 writes them: All, Signal, Plane, NonSignal and Mechanical layers. */
function layerSets(rows: StackLayer[], mechs: number[]): KV {
  const { mids, planes } = stackSetNames(rows);
  const mech = mechs.map((n) => `Mechanical${n}`);
  const nonSignal = ['MultiLayer', 'TopPaste', 'TopOverlay', 'TopSolder', 'BottomSolder', 'BottomOverlay', 'BottomPaste', 'DrillGuide', 'KeepOutLayer', 'DrillDrawing'];
  const sets: [string, string[], string][] = [
    ['&All Layers', ['MultiLayer', 'TopPaste', 'TopOverlay', 'TopSolder', 'TopLayer', 'BottomLayer', 'BottomSolder', 'BottomOverlay', 'BottomPaste', 'DrillGuide', 'KeepOutLayer', ...mech, 'DrillDrawing', ...mids, ...planes], 'TOP'],
    ['&Signal Layers', ['MultiLayer', 'TopLayer', 'BottomLayer', ...mids], 'TOP'],
    ['&Plane Layers', planes, planes.length ? 'PLANE1' : 'UNKNOWN'],
    ['&NonSignal Layers', nonSignal, 'MULTILAYER'],
    ['&Mechanical Layers', mech, mech.length ? `MECHANICAL${mechs[0]}` : 'UNKNOWN'],
  ];
  const kv: KV = [['SHOWDEFAULTSETS', 'TRUE'], ['LAYERSETSCOUNT', String(sets.length)]];
  sets.forEach(([name, layers, active], i) => kv.push([`LAYERSET${i + 1}NAME`, name], [`LAYERSET${i + 1}LAYERS`, layers.join(',')], [`LAYERSET${i + 1}ACTIVELAYER.7`, active],
    [`LAYERSET${i + 1}ISCURRENT`, 'FALSE'], [`LAYERSET${i + 1}ISLOCKED`, 'TRUE'], [`LAYERSET${i + 1}FLIPBOARD`, 'FALSE']));
  return kv;
}

const snapOptions = (): KV => [
  ['EGRANGE', '8mil'], ['EGMULT', '0.000000'], ['EGENABLED', 'TRUE'], ['EGSNAPTOBOARDOUTLINE', 'FALSE'], ['EGSNAPTOARCCENTERS', 'FALSE'], ['EGUSEALLLAYERS', 'FALSE'],
  ['OGSNAPENABLED', 'FALSE'], ['MGSNAPENABLED', 'FALSE'], ['POINTGUIDEENABLED', 'FALSE'], ['GRIDSNAPENABLED', 'TRUE'], ['NEAROBJECTSENABLED', 'TRUE'], ['FAROBJECTSENABLED', 'TRUE'],
  ['NEAROBJECTSET', '011111100011100000000000001'], ['FAROBJECTSET', '001100000000000000000000000'], ['NEARDISTANCE', '1000mil'],
];
/** The view: 2D, the viewport (when known), the 3D camera at rest. */
const view = (vp?: BBox): KV => [
  ['RECORD', 'Board'], ['CURRENT2D3DVIEWSTATE', '2D'],
  ...(vp ? [['RECORD', 'Board'], ['VP.LX', String(Math.round(vp.minX))], ['VP.HX', String(Math.round(vp.maxX))], ['VP.LY', String(Math.round(vp.minY))], ['VP.HY', String(Math.round(vp.maxY))]] as KV : []),
  ['RECORD', 'Board'], ['LOOKAT.X', '0.000000'], ['LOOKAT.Y', '0.000000'], ['LOOKAT.Z', '0.000000'], ['EYEROTATION.X', '0.000000'], ['EYEROTATION.Y', '0.000000'], ['EYEROTATION.Z', '0.000000'], ['ZOOMMULT', '0.000001'],
];
const two = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date): KV => [['DATE', `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`], ['TIME', `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`]];
const primitiveHead = (layer: string, locked: boolean): KV => [['SELECTION', 'FALSE'], ['LAYER', layer], ['LOCKED', TF(locked)], ['POLYGONOUTLINE', 'FALSE'], ['USERROUTED', 'TRUE'], ['KEEPOUT', 'FALSE'], ['UNIONINDEX', '0']];

export interface NewBoardOptions {
  fileName: string;
  origin: { x: number; y: number };
  /** The board shape (closed: the closing copy is added). */
  outline: PolyVertex[];
  sheet?: { x: number; y: number; width: number; height: number };
  stack?: StackLayer[];
  /** Enabled mechanical layers (default: Mechanical 1). */
  mechanical?: number[];
  date?: Date;
}

/** Entries to a record. AD ends the value before each RECORD=Board separator with a CR; so does this. */
function record(kv: KV): PropertyBag {
  const out: KV = kv.map(([k, v], i) => [k, kv[i + 1]?.[0] === 'RECORD' && i > 0 ? `${v}\r` : v]);
  return PropertyBag.fromEntries(out);
}

/** A Board6 record as AD17 writes it for a new board (see the module comment). */
export function newBoardRecord(o: NewBoardOptions): PropertyBag {
  const rows = o.stack ?? defaultStack();
  const mechs = o.mechanical ?? [1];
  const mechOn = (n: number) => mechs.includes(n);
  const sheet = o.sheet ?? { x: mil(1000), y: mil(1000), width: mil(10000), height: mil(8000) };
  const ids: Ids = { master: newGuid(), substack: newGuid() };
  const kv: KV = [
    ...primitiveHead('UNKNOWN', false),
    ['FILENAME', o.fileName], ['KIND', 'Protel_Advanced_PCB'], ['VERSION', '5.01'], ...stamp(o.date ?? new Date()),
    ['ORIGINX', len(o.origin.x)], ['ORIGINY', len(o.origin.y)], ['BIGVISIBLEGRIDSIZE', '0.000'], ['VISIBLEGRIDSIZE', '0.000'],
    ['ELECTRICALGRIDRANGE', '8mil'], ['ELECTRICALGRIDENABLED', 'TRUE'],
    ['SNAPGRIDSIZE', units(mil(5))], ['SNAPGRIDSIZEX', units(mil(5))], ['SNAPGRIDSIZEY', units(mil(5))], ['TRACKGRIDSIZE', units(mil(20))], ['VIAGRIDSIZE', units(mil(20))],
    ['COMPONENTGRIDSIZE', units(mil(5))], ['COMPONENTGRIDSIZEX', units(mil(5))], ['COMPONENTGRIDSIZEY', units(mil(5))],
    ['DOTGRID', 'FALSE'], ['DISPLAYUNIT', '1'], ['DESIGNATORDISPLAYMODE', '0'],
    // The board shape, kept as a polygon
    ...primitiveHead('TOP', true),
    ['PRIMITIVELOCK', 'TRUE'], ['POLYGONTYPE', 'Polygon'], ['POUROVER', 'FALSE'], ['REMOVEDEAD', 'FALSE'], ['GRIDSIZE', '10mil'], ['TRACKWIDTH', '10mil'],
    ['HATCHSTYLE', 'None'], ['USEOCTAGONS', 'FALSE'], ['MINPRIMLENGTH', '3mil'], ['KIND0', '0'],
    ['SHELVED', 'FALSE'], ['RESTORELAYER', 'UNKNOWN'], ['RESTORENET', ''], ['REMOVEISLANDSBYAREA', 'TRUE'], ['REMOVENECKS', 'TRUE'],
    ['AREATHRESHOLD', '250000000000.000000'], ['ARCRESOLUTION', '0.5mil'], ['NECKWIDTHTHRESHOLD', '5mil'], ['POUROVERSTYLE', '2'], ['NAME', ''], ['POURINDEX', '-1'],
    ['IGNOREVIOLATIONS', 'FALSE'], ['SPLITLINECOUNT', '0'],
    ['SHEETX', len(sheet.x)], ['SHEETY', len(sheet.y)], ['SHEETWIDTH', len(sheet.width)], ['SHEETHEIGHT', len(sheet.height)], ['SHOWSHEET', 'FALSE'], ['LOCKSHEET', 'TRUE'],
    ...Array.from({ length: 16 }, (_, i) => [`PLANE${i + 1}NETNAME`, '(No Net)'] as [string, string]),
    ['RECORD', 'Board'],
    ...layerSystem(rows, mechOn, ids),
  ];
  // The drill pair top to bottom, in the board's substack
  kv.push(['LAYERPAIR0LOW', 'TOP'], ['LAYERPAIR0HIGH', 'BOTTOM'], ['LAYERPAIR0DRILLGUIDE', 'FALSE'], ['LAYERPAIR0DRILLDRAWING', 'FALSE'],
    ['LAYERPAIR0SUBSTACK_0', ids.substack], ['RECORD', 'Board'], ['TOGGLELAYERS', '1'.repeat(82)]);
  for (let i = 1; i <= 10; i++) kv.push([`PLACEMARKERX${i}`, '-0.0001mil'], [`PLACEMARKERY${i}`, '-0.0001mil']);
  for (let i = 1; i <= 8; i++) kv.push([`SELECTIONMEMORYLOCK${i}`, 'FALSE']);
  kv.push(['ELECTRICALGRIDSNAPTOBO', 'FALSE'], ['ELECTRICALGRIDUSEALLLAYERS', 'FALSE'], ['ROUTINGDIRECTIONTOP LAYER', 'Automatic']);
  for (let i = 1; i <= 30; i++) kv.push([`ROUTINGDIRECTIONMID LAYER ${i}`, 'Automatic']);
  kv.push(['ROUTINGDIRECTIONBOTTOM LAYER', 'Automatic'], ['TOPLAYER_MRLASTWIDTH', '10mil']);
  for (let i = 1; i <= 30; i++) kv.push([`MIDLAYER${i}_MRLASTWIDTH`, '10mil']);
  kv.push(['BOTTOMLAYER_MRLASTWIDTH', '10mil'], ['MRLASTVIASIZE', '50mil'], ['MRLASTVIAHOLE', '28mil'], ['LASTTARGETLENGTH', '99999mil'],
    ...layerSets(rows, mechs), ['BOARDINSIGHTVIEWCONFIGURATIONNAME', ''], ['RECORD', 'Board'],
    ['VISIBLEGRIDMULTFACTOR', '1.000'], ['BIGVISIBLEGRIDMULTFACTOR', '5.000'], ['ELECTRICALGRIDMULTFACT', '0.000'], ['OUTLINEMODELCRC', '0'], ['OUTLINEMODELNAME', '']);
  // The viewport: the board with a tenth to spare all round [est: AD fits the board on opening]
  const box = bboxOf(o.outline), m = box ? Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.1 : 0;
  kv.push(...view(box ? { minX: box.minX - m, minY: box.minY - m, maxX: box.maxX + m, maxY: box.maxY + m } : undefined),
    ['GR0_TYPE', 'CartesianGrid'], ['GR0_NAME', 'Global Board Snap Grid'], ['GR0_COLOR', '6049101'], ['GR0_COLORLGE', '9473425'], ['GR0_PRIO', '50'], ['GR0_OX', '0mil'], ['GR0_OY', '0mil'],
    ['GR0_DRAWMODE', '0'], ['GR0_DRAWMODELARGE', '0'], ['GR0_ENABLED', 'TRUE'], ['GR0_MULT', '1'], ['GR0_MULTLARGE', '5'], ['GR0_DISPLAYUNIT', '1'], ['GR0_COMP', 'TRUE'],
    ['GR0_GSX', units(mil(5))], ['GR0_GSY', units(mil(5))], ['GR0_QSX', '99999mil'], ['GR0_QSY', '99999mil'], ['GR0_ROT', '0.000000'], ['GR0_FLAGS', '15'],
    ...snapOptions(), ['DRILLSYMBOLASENUM', '0'], ['DRILLSYMBOLSIZE', '200000'], ['VIEWPORTSAREVISIBLE', 'TRUE'], ['UNIQUEID', newUniqueId()], ['PINPAIRCOUNT', '0'], ['SPLITLINECOUNT', '0']);
  const bag = record(kv);
  writeVertices(bag, o.outline);
  return bag;
}

function bboxOf(vs: PolyVertex[]): BBox | null {
  if (!vs.length) return null;
  const xs = vs.map((v) => v.p.x), ys = vs.map((v) => v.p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** A PCB library's header (Library/Data's property block) as AD writes one: the board's layer system, grids, layer sets. */
export function newLibraryRecord(fileName = 'PcbLib1.PcbLib', date = new Date()): PropertyBag {
  const rows = defaultStack();
  const kv: KV = [
    ['FILENAME', fileName], ['KIND', 'Protel_Advanced_PCB_Library'], ['VERSION', '3.00'], ...stamp(date),
    ...layerSystem(rows, (n) => n === 1, { master: newGuid(), substack: newGuid() }),
    ['RECORD', 'Board'], ['BIGVISIBLEGRIDSIZE', '0.000'], ['VISIBLEGRIDSIZE', '0.000'],
    ['SNAPGRIDSIZE', units(mil(5))], ['SNAPGRIDSIZEX', units(mil(5))], ['SNAPGRIDSIZEY', units(mil(5))],
    ['ELECTRICALGRIDRANGE', '8mil'], ['ELECTRICALGRIDENABLED', 'TRUE'], ['DOTGRID', 'FALSE'], ['DOTGRIDLARGE', 'FALSE'], ['DISPLAYUNIT', '1'],
    ['TOGGLELAYERS', '1'.repeat(82)], ...layerSets(rows, [1]), ['BOARDINSIGHTVIEWCONFIGURATIONNAME', ''],
    ['VISIBLEGRIDMULTFACTOR', '1.000'], ['BIGVISIBLEGRIDMULTFACTOR', '5.000'], ...view(), ...snapOptions(),
    ['BOARDVERSION', '5.01'], ['VAULTGUID', ''], ['FOLDERGUID', ''], ['LIFECYCLEDEFINITIONGUID', ''], ['REVISIONNAMINGSCHEMEGUID', ''],
  ];
  return record(kv);
}

/** A header or Board6 too thin for AD17 (an earlier Konium's): no TOGGLELAYERS, no V8 layers. */
export const isThinRecord = (b: PropertyBag): boolean => !b.has('TOGGLELAYERS') && !b.has('LAYER_V8_0NAME');
