/**
 * The board's objects and their properties, as AD17's PCB Inspector, PCB List and PCB Filter
 * name them: Object Kind, Layer, Net, Component, the geometry (X1, Y1 … in the current unit,
 * from the origin), sizes, Locked, Keepout and the rest. A property with `set` can be changed
 * (a Change for one undo step); the others are shown only.
 */
import type { Vec2 } from '../core/geom';
import type { Change } from '../core/undo';
import { formatCoord, parseLength } from '../core/units';
import { ARC, FILL, PAD, TEXT, TRACK, VIA, get, put, setViaDiameter, type Field } from '../formats/altium/pcbLayouts';
import { toV7 } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';
import { replaceRecords, setComponentProps, setPolygon } from './pcbEdit';
import { L, layerName, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim } from './pcb';

export type PcbCat = 'Kind' | 'Graphical' | 'Object Specific';
export type PcbPropType = 'text' | 'bool' | 'enum' | 'coord' | 'coordX' | 'coordY' | 'angle' | 'number';
export interface PcbProp { cat: PcbCat; name: string; type: PcbPropType; value: string; options?: string[]; set?: (v: string) => Change | null }

/** One object of the board: a primitive, a component, a pour, a dimension. `keys` select it. */
export interface PcbObj { id: string; keys: string[]; kind: string; prim?: PcbPrim; component?: number; polygon?: number; dimension?: number }

export interface PcbPropCtx { doc: PcbDocument; units: 'mil' | 'mm'; origin: Vec2; layerLabel?: (l: LayerId) => string }

const KIND_NAME: Record<PcbPrim['kind'], string> = { track: 'Track', arc: 'Arc', via: 'Via', pad: 'Pad', fill: 'Fill', region: 'Region', text: 'Text', body: 'Component Body' };
export const PCB_OBJECT_KINDS = ['Arc', 'Component', 'Component Body', 'Dimension', 'Fill', 'Pad', 'Polygon', 'Region', 'Text', 'Track', 'Via'];
const keyOf = (p: PcbPrim) => ('polygon' in p && p.polygon !== NO_NET ? `poly:${p.polygon}` : `${p.src.storage}:${p.src.index}`);

/** Every object on the board (pour copper is its pour; a component's primitives are listed with it as their Component). */
export function pcbObjects(doc: PcbDocument): PcbObj[] {
  const out: PcbObj[] = [];
  doc.components.forEach((_c, i) => out.push({ id: `cmp:${i}`, kind: 'Component', component: i,
    keys: doc.prims.filter((q) => 'component' in q && q.component === i).map(keyOf) }));
  doc.polygons.forEach((_p, i) => out.push({ id: `poly:${i}`, keys: [`poly:${i}`], kind: 'Polygon', polygon: i }));
  doc.dimensions.forEach((_d, i) => out.push({ id: `dim:${i}`, keys: [`dim:${i}`], kind: 'Dimension', dimension: i }));
  for (const p of doc.prims) {
    if ('polygon' in p && p.polygon !== NO_NET) continue;
    const k = keyOf(p);
    out.push({ id: k, keys: [k], kind: KIND_NAME[p.kind], prim: p });
  }
  return out;
}

const tf = (v: boolean) => (v ? 'True' : 'False');
const isTrue = (v: string) => /^(true|t|1|yes)$/i.test(v.trim());

/** The properties of one object, grouped as the Inspector groups them. */
export function pcbProps(o: PcbObj, x: PcbPropCtx): PcbProp[] {
  const { doc } = x, u = x.units;
  const f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
  const len = (v: string) => { const t = v.trim(); return parseLength(/^-?[0-9]*\.?[0-9]+$/.test(t) ? `${t}${u}` : t); };
  const lname = (l: LayerId) => x.layerLabel?.(l) ?? doc.board.layerNames.get(l) ?? layerName(l);
  const layerOptions = [...new Set([...doc.board.copperStack, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.KEEPOUT, L.MECH1, L.MECH1 + 12, L.MECH1 + 14, L.DRILL_GUIDE, L.DRILL_DRAWING] as LayerId[])];
  const layerFrom = (v: string) => layerOptions.find((l) => lname(l).toLowerCase() === v.trim().toLowerCase());
  const netNames = ['No Net', ...doc.nets.map((n) => n.name)];
  const netFrom = (v: string) => (/^no net$/i.test(v.trim()) ? NO_NET : doc.nets.findIndex((n) => n.name.toLowerCase() === v.trim().toLowerCase()));
  const out: PcbProp[] = [{ cat: 'Kind', name: 'Object Kind', type: 'text', value: o.kind }];
  const add = (p: PcbProp) => out.push(p);

  if (o.component !== undefined) {
    const c = doc.components[o.component]!, b = c.bag, i = o.component;
    const bag = (name: string, key: string, cat: PcbCat = 'Object Specific') => add({ cat, name, type: 'text', value: b.get(key) ?? '' });
    const flag = (name: string, key: string, def = false) => add({ cat: 'Object Specific', name, type: 'bool', value: tf(b.has(key) ? b.bool(key) : def), set: (v) => setComponentProps(doc, i, { [key]: isTrue(v) ? 'TRUE' : 'FALSE' }) });
    add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(c.layer) });
    add({ cat: 'Graphical', name: 'X', type: 'coordX', value: f(c.at.x - x.origin.x) });
    add({ cat: 'Graphical', name: 'Y', type: 'coordY', value: f(c.at.y - x.origin.y) });
    add({ cat: 'Graphical', name: 'Rotation', type: 'angle', value: String(+c.rotation.toFixed(3)) });
    add({ cat: 'Graphical', name: 'Locked', type: 'bool', value: tf(b.bool('LOCKED')), set: (v) => setComponentProps(doc, i, { LOCKED: isTrue(v) ? 'TRUE' : 'FALSE' }) });
    add({ cat: 'Object Specific', name: 'Designator', type: 'text', value: c.designator });
    add({ cat: 'Object Specific', name: 'Comment', type: 'text', value: doc.prims.find((q) => q.kind === 'text' && q.component === i && q.isComment)?.['text' as never] ?? '' });
    add({ cat: 'Object Specific', name: 'Footprint', type: 'text', value: c.pattern });
    bag('Footprint Description', 'FOOTPRINTDESCRIPTION'); bag('Source Library', 'SOURCEFOOTPRINTLIBRARY'); bag('Description', 'SOURCEDESCRIPTION');
    bag('Unique ID', 'SOURCEUNIQUEID'); bag('Library Reference', 'SOURCELIBREFERENCE');
    add({ cat: 'Object Specific', name: 'Height', type: 'coord', value: f(parseLength(b.get('HEIGHT')) ?? 0) });
    flag('Show Name', 'NAMEON', true); flag('Show Comment', 'COMMENTON'); flag('Lock Primitives', 'PRIMITIVELOCK', true); flag('Lock Strings', 'LOCKSTRINGS');
    add({ cat: 'Object Specific', name: 'Component Type', type: 'enum', options: ['Standard', 'Mechanical', 'Graphical', 'Net Tie (In BOM)', 'Net Tie', 'Standard (No BOM)', 'Jumper'],
      value: ['Standard', 'Mechanical', 'Graphical', 'Net Tie (In BOM)', 'Net Tie', 'Standard (No BOM)', 'Jumper'][b.int('COMPONENTKIND')] ?? 'Standard',
      set: (v) => { const k = ['standard', 'mechanical', 'graphical', 'net tie (in bom)', 'net tie', 'standard (no bom)', 'jumper'].indexOf(v.trim().toLowerCase()); return k < 0 ? null : setComponentProps(doc, i, { COMPONENTKIND: String(k) }); } });
    return out;
  }
  if (o.polygon !== undefined) {
    const p = doc.polygons[o.polygon]!, b = p.bag, i = o.polygon;
    const setB = (kv: Record<string, string>) => { const nb = b.clone(); for (const [k, v] of Object.entries(kv)) nb.set(k, v); return setPolygon(doc, i, nb); };
    add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(p.layer) });
    add({ cat: 'Graphical', name: 'Locked', type: 'bool', value: tf(b.bool('LOCKED')), set: (v) => setB({ LOCKED: isTrue(v) ? 'TRUE' : 'FALSE' }) });
    add({ cat: 'Object Specific', name: 'Name', type: 'text', value: p.name });
    add({ cat: 'Object Specific', name: 'Net', type: 'enum', options: netNames, value: p.net === NO_NET ? 'No Net' : doc.nets[p.net]?.name ?? '' });
    add({ cat: 'Object Specific', name: 'Fill Mode', type: 'text', value: p.hatch === 'Solid' ? 'Solid' : p.hatch === 'None' ? 'None' : 'Hatched' });
    add({ cat: 'Object Specific', name: 'Remove Dead Copper', type: 'bool', value: tf(b.has('REMOVEDEAD') ? b.bool('REMOVEDEAD') : true), set: (v) => setB({ REMOVEDEAD: isTrue(v) ? 'TRUE' : 'FALSE' }) });
    add({ cat: 'Object Specific', name: 'Pour Over Same Net', type: 'text', value: b.get('POUROVER') ?? '' });
    add({ cat: 'Object Specific', name: 'Ignore On-Line Violations', type: 'bool', value: tf(b.bool('IGNOREVIOLATIONS')), set: (v) => setB({ IGNOREVIOLATIONS: isTrue(v) ? 'TRUE' : 'FALSE' }) });
    add({ cat: 'Object Specific', name: 'Vertices', type: 'number', value: String(p.vertices.length) });
    return out;
  }
  if (o.dimension !== undefined) {
    const d = doc.dimensions[o.dimension]!;
    add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(d.layer) });
    return out;
  }
  const p = o.prim!;
  const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
  /** A record field set to a new value: one Change. */
  const field = (sub: number, fl: Field, conv: (v: string) => number | undefined, extra?: (s: Uint8Array, n: number) => void) => (v: string): Change | null => {
    const n = conv(v);
    if (n === undefined || !rec) return null;
    const subs = rec.subs.map((s) => s.slice());
    put(subs[sub]!, fl, n);
    extra?.(subs[sub]!, n);
    const after: PcbRawRecord = { tag: rec.tag, subs };
    return replaceRecords(doc, [{ storage: p.src.storage, index: p.src.index, after }]);
  };
  const free = !('component' in p) || p.component === NO_NET;
  const coordX = (name: string, c: number, sub: number, fl: Field) => add({ cat: 'Graphical', name, type: 'coordX', value: f(c - x.origin.x), set: free ? field(sub, fl, (v) => { const n = len(v); return n === undefined ? undefined : Math.round(n + x.origin.x); }) : undefined });
  const coordY = (name: string, c: number, sub: number, fl: Field) => add({ cat: 'Graphical', name, type: 'coordY', value: f(c - x.origin.y), set: free ? field(sub, fl, (v) => { const n = len(v); return n === undefined ? undefined : Math.round(n + x.origin.y); }) : undefined });
  const size = (name: string, c: number, sub: number, fl: Field, cat: PcbCat = 'Graphical') => add({ cat, name, type: 'coord', value: f(c), set: field(sub, fl, (v) => { const n = len(v); return n && n > 0 ? Math.round(n) : undefined; }) });
  const angle = (name: string, a: number, sub: number, fl: Field) => add({ cat: 'Graphical', name, type: 'angle', value: String(+a.toFixed(3)), set: free ? field(sub, fl, (v) => { const n = Number(v.replace(/°/g, '')); return Number.isFinite(n) ? n : undefined; }) : undefined });
  const layerProp = (fl: Field | undefined, sub = 0, extra?: (s: Uint8Array, l: number) => void) => add({ cat: 'Graphical', name: 'Layer', type: 'enum', options: layerOptions.map(lname), value: lname('layer' in p ? p.layer : L.MULTI),
    set: fl && free ? field(sub, fl, (v) => layerFrom(v), extra) : undefined });
  const netProp = (fl: Field | undefined, sub = 0) => add({ cat: 'Object Specific', name: 'Net', type: 'enum', options: netNames, value: 'net' in p ? (p.net === NO_NET ? 'No Net' : doc.nets[p.net]?.name ?? '') : '',
    set: fl ? field(sub, fl, (v) => { const n = netFrom(v); return n < 0 ? undefined : n; }) : undefined });
  const comp = 'component' in p && p.component !== NO_NET ? doc.components[p.component]?.designator ?? '' : '';
  switch (p.kind) {
    case 'track':
      layerProp(TRACK.layer, 0, (s, l) => { if (s.length >= TRACK.layerV7.off + 4) put(s, TRACK.layerV7, toV7(l)); });
      coordX('X1', p.a.x, 0, TRACK.x1); coordY('Y1', p.a.y, 0, TRACK.y1); coordX('X2', p.b.x, 0, TRACK.x2); coordY('Y2', p.b.y, 0, TRACK.y2);
      size('Width', p.width, 0, TRACK.width);
      add({ cat: 'Graphical', name: 'Length', type: 'coord', value: f(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)) });
      netProp(TRACK.net); break;
    case 'arc':
      layerProp(ARC.layer, 0, (s, l) => { if (s.length >= ARC.layerV7.off + 4) put(s, ARC.layerV7, toV7(l)); });
      coordX('X Centre', p.c.x, 0, ARC.cx); coordY('Y Centre', p.c.y, 0, ARC.cy);
      size('Radius', p.r, 0, ARC.radius); size('Width', p.width, 0, ARC.width);
      angle('Start Angle', p.start, 0, ARC.start); angle('End Angle', p.end, 0, ARC.end);
      netProp(ARC.net); break;
    case 'via':
      coordX('X', p.at.x, 0, VIA.x); coordY('Y', p.at.y, 0, VIA.y);
      add({ cat: 'Object Specific', name: 'Diameter', type: 'coord', value: f(p.diameter), set: (v) => {
        const n = len(v); if (!n || n <= p.hole || !rec) return null;
        const subs = rec.subs.map((s) => s.slice()); setViaDiameter(subs[0]!, Math.round(n));
        return replaceRecords(doc, [{ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } }]);
      } });
      size('Hole Size', p.hole, 0, VIA.hole, 'Object Specific');
      add({ cat: 'Object Specific', name: 'Start Layer', type: 'text', value: lname(p.layerStart) });
      add({ cat: 'Object Specific', name: 'Stop Layer', type: 'text', value: lname(p.layerEnd) });
      netProp(VIA.net); break;
    case 'pad':
      add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(p.layer) });
      coordX('X', p.at.x, 4, PAD.x); coordY('Y', p.at.y, 4, PAD.y); angle('Rotation', p.rotation, 4, PAD.rotation);
      add({ cat: 'Object Specific', name: 'Designator', type: 'text', value: p.name });
      add({ cat: 'Object Specific', name: 'Shape', type: 'text', value: { round: 'Round', rect: 'Rectangular', octagon: 'Octagonal', roundrect: 'Rounded Rectangle' }[p.top.shape] });
      {
        // A Simple stack is one size on every layer: middle and bottom follow the top
        const padSize = (name: string, c: number, top: Field, mid: Field, bot: Field) => add({ cat: 'Object Specific', name, type: 'coord', value: f(c),
          set: field(4, top, (v) => { const n = len(v); return n && n > 0 ? Math.round(n) : undefined; }, (s, n) => { if ((get(s, PAD.padMode) ?? 0) === 0) { put(s, mid, n); put(s, bot, n); } }) });
        padSize('X Size', p.top.w, PAD.topX, PAD.midX, PAD.botX); padSize('Y Size', p.top.h, PAD.topY, PAD.midY, PAD.botY);
      }
      add({ cat: 'Object Specific', name: 'Hole Size', type: 'coord', value: f(p.hole) });
      add({ cat: 'Object Specific', name: 'Plated', type: 'bool', value: tf(p.plated) });
      if ((rec?.subs[4]?.length ?? 0) >= PAD.jumperId.off + 2) add({ cat: 'Object Specific', name: 'Jumper ID', type: 'number', value: String(p.jumper ?? 0),
        set: field(4, PAD.jumperId, (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 32767 ? n : undefined; }) });
      netProp(PAD.net, 4); break;
    case 'fill':
      layerProp(FILL.layer, 0, (s, l) => { if (s.length >= FILL.layerV7.off + 4) put(s, FILL.layerV7, toV7(l)); });
      coordX('X1', p.a.x, 0, FILL.x1); coordY('Y1', p.a.y, 0, FILL.y1); coordX('X2', p.b.x, 0, FILL.x2); coordY('Y2', p.b.y, 0, FILL.y2);
      angle('Rotation', p.rotation, 0, FILL.rotation);
      netProp(FILL.net); break;
    case 'text':
      layerProp(TEXT.layer, 0, (s, l) => { if (s.length >= TEXT.barcodeLen) put(s, TEXT.layerV7, toV7(l)); });
      coordX('X', p.at.x, 0, TEXT.x); coordY('Y', p.at.y, 0, TEXT.y); angle('Rotation', p.rotation, 0, TEXT.rotation);
      size('Text Height', p.height, 0, TEXT.height); size('Text Width', p.strokeWidth, 0, TEXT.strokeWidth);
      add({ cat: 'Object Specific', name: 'String', type: 'text', value: p.text });
      add({ cat: 'Object Specific', name: 'Mirror', type: 'bool', value: tf(p.mirrored), set: field(0, TEXT.mirrored, (v) => (isTrue(v) ? 1 : 0)) });
      add({ cat: 'Object Specific', name: 'Font Type', type: 'text', value: ['Stroke', 'TrueType', 'BarCode'][p.fontType] ?? 'Stroke' });
      if (p.fontType === 1) add({ cat: 'Object Specific', name: 'Font Name', type: 'text', value: p.fontName });
      add({ cat: 'Object Specific', name: 'Designator String', type: 'bool', value: tf(p.isDesignator) });
      add({ cat: 'Object Specific', name: 'Comment String', type: 'bool', value: tf(p.isComment) });
      break;
    case 'region':
      add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(p.layer) });
      add({ cat: 'Object Specific', name: 'Kind', type: 'text', value: p.boardCutout ? 'Board Cutout' : ['Copper', 'Polygon Cutout', 'Dashed Outline', 'Kind 3', 'Cavity Definition'][p.regionKind] ?? 'Copper' });
      add({ cat: 'Object Specific', name: 'Vertices', type: 'number', value: String(p.outline.length) });
      add({ cat: 'Object Specific', name: 'Holes', type: 'number', value: String(p.holes.length) });
      netProp(undefined); break;
    case 'body':
      add({ cat: 'Graphical', name: 'Layer', type: 'text', value: lname(p.layer) });
      add({ cat: 'Object Specific', name: 'Identifier', type: 'text', value: p.identifier });
      add({ cat: 'Object Specific', name: 'Overall Height', type: 'coord', value: f(p.overall) });
      add({ cat: 'Object Specific', name: 'Standoff Height', type: 'coord', value: f(p.standoff) });
      add({ cat: 'Object Specific', name: 'Body Side', type: 'text', value: p.bottom ? 'Bottom Side' : 'Top Side' });
      break;
  }
  if ('component' in p) add({ cat: 'Object Specific', name: 'Component', type: 'text', value: comp });
  if ('locked' in p) add({ cat: 'Graphical', name: 'Locked', type: 'bool', value: tf(p.locked), set: free && rec ? (v) => {
    const sub = p.kind === 'pad' ? 4 : 0, subs = rec.subs.map((s) => s.slice());
    const b = subs[sub]!; b[1] = isTrue(v) ? b[1]! & ~0x04 : b[1]! | 0x04;
    return replaceRecords(doc, [{ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } }]);
  } : undefined });
  if ('keepout' in p) add({ cat: 'Object Specific', name: 'Keepout', type: 'bool', value: tf(p.keepout) });
  return out;
}
