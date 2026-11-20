/**
 * The showcase board: the design's parts placed on a six-layer board (Top, GND plane, Mid 1,
 * Mid 2, +3V3 plane, Bottom), the plane nets fanned out to vias, the rest routed by Konium's
 * autorouter, GND poured top and bottom, a 1V2 pour under the FPGA, stitching and teardrops.
 */
import { altiumFloat } from '../../../src/formats/altium/pcbTransform';
import { newPolygonProps } from '../../../src/formats/altium/polygonProps';
import { newBoardRecord } from '../../../src/formats/altium/board6';
import { BinWriter } from '../../../src/formats/bin';
import { cfbPut, newEntry, writeCfb } from '../../../src/formats/cfb/cfb';
import { countHeader, joinBinaryRecords, joinTextRecords, type PcbRawRecord } from '../../../src/formats/altium/framing';
import { PropertyBag } from '../../../src/formats/altium/props';
import { encodeArc, encodeBody, encodePad, encodeText, encodeTrack, layerToName, readPcbDoc, writePcbDoc, writeVertices } from '../../../src/formats/altium/pcbdoc';
import { addPolygon, addPrimRecords, addTracks, addVias, freshRecord, repour } from '../../../src/model/pcbEdit';
import { binToBytes } from '../../../src/formats/text';
import { L, type LayerId } from '../../../src/model/layers';
import { formatAltiumLength, mil, mm } from '../../../src/core/units';
import type { Vec2 } from '../../../src/core/geom';
import { defaultRules, joinRuleRecords, newRule } from '../../../src/formats/altium/rules';
import { addStackLayer, readStack, setStack } from '../../../src/model/pcbStack';
import { autoroute, fanout, smdPads } from '../../../src/model/autoroute';
import { connections } from '../../../src/model/drc';
import { planStitching } from '../../../src/model/viaStitch';
import { planTeardrops } from '../../../src/model/teardrops';
import { NO_NET, type PcbDocument, type PcbPad, type PolyVertex } from '../../../src/model/pcb';
import { BOARD, design, type Part } from './design';

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number): Vec2 => ({ x: O.x + mm(x), y: O.y + mm(y) });
const len = (v: number) => formatAltiumLength(v);
const MECH_BODY = L.MECH1 + 12;
const MID2 = (L.MID1 + 1) as LayerId, PLANE2 = (L.PLANE1 + 1) as LayerId;

/** A part's local point on the board (mm). */
function place(part: Part, x: number, y: number): [number, number] {
  const a = (part.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [part.x + x * c - y * s, part.y + x * s + y * c];
}
const circle = (cx: number, cy: number, r: number, n = 28): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);

export interface Built { doc: PcbDocument; nets: string[]; log: string[] }

export interface BoardSpec { parts: Part[]; fileName: string; size: { w: number; h: number }; outline?: PolyVertex[]; legends?: (legend: (text: string, x: number, y: number, hgt: number, layer: LayerId, mirrored?: boolean) => void) => void; classes?: [string, string[]][] }

export function buildBoard(spec?: BoardSpec): PcbDocument {
  const parts = spec?.parts ?? design.parts;
  // Nets, in first-use order
  const nets: string[] = [];
  for (const p of parts) for (const n of Object.values(p.nets)) if (!nets.includes(n)) nets.push(n);
  const net = (n: string | undefined) => (n ? nets.indexOf(n) : -1);

  const { w, h } = spec?.size ?? BOARD, r = BOARD.corner;
  const outline: PolyVertex[] = spec?.outline ?? [
    { p: P(r, 0) }, { p: P(w - r, 0), arc: { c: P(w - r, r), r: mm(r), sa: 270, ea: 360 } },
    { p: P(w, r) }, { p: P(w, h - r), arc: { c: P(w - r, h - r), r: mm(r), sa: 0, ea: 90 } },
    { p: P(w - r, h) }, { p: P(r, h), arc: { c: P(r, h - r), r: mm(r), sa: 90, ea: 180 } },
    { p: P(0, h - r) }, { p: P(0, r), arc: { c: P(r, r), r: mm(r), sa: 180, ea: 270 } },
  ];
  const board = newBoardRecord({ fileName: spec?.fileName ?? 'Showcase.PcbDoc', origin: O, outline, sheet: { x: 0, y: 0, width: mil(8000), height: mil(6000) }, mechanical: [1, 13] });

  const comps: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], texts: PcbRawRecord[] = [], bodies: PcbRawRecord[] = [];
  // Keep-clear boxes for the designators: every pad, then each placed designator
  const boxes: [number, number, number, number][] = [];
  const bboxOf = (pts: [number, number][]): [number, number, number, number] => [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  parts.forEach((part) => {
    for (const pd of part.fp.pads) {
      const [x, y] = place(part, pd.x, pd.y);
      const q = part.rot % 180 === 0 ? [pd.w, pd.h] : [pd.h, pd.w];
      boxes.push([x - q[0]! / 2 - 0.1, y - q[1]! / 2 - 0.1, x + q[0]! / 2 + 0.1, y + q[1]! / 2 + 0.1]);
    }
  });
  const hits = (b: [number, number, number, number]) => b[0] < 0.3 || b[1] < 0.3 || b[2] > w - 0.3 || b[3] > h - 0.3 || boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

  parts.forEach((part, ci) => {
    comps.push(PropertyBag.from({
      LAYER: 'TOP', PATTERN: part.fp.name, SOURCEDESIGNATOR: part.ref, SOURCEFOOTPRINTLIBRARY: 'Showcase.PcbLib', FOOTPRINTDESCRIPTION: part.description,
      SOURCELIBREFERENCE: part.comment, X: len(P(part.x, part.y).x), Y: len(P(part.x, part.y).y), ROTATION: altiumFloat(part.rot), HEIGHT: len(mm(part.fp.height)),
      NAMEON: 'TRUE', COMMENTON: 'FALSE', SOURCEDESCRIPTION: part.description,
    }));
    for (const pd of part.fp.pads) {
      const [x, y] = place(part, pd.x, pd.y);
      const n = net(part.nets[pd.name]);
      pads.push(encodePad({ name: pd.name, layer: pd.hole ? L.MULTI : L.TOP, at: P(x, y), w: mm(pd.w), h: mm(pd.h), shape: pd.shape, hole: pd.hole ? mm(pd.hole) : undefined, rotation: part.rot, net: n < 0 ? undefined : n, component: ci }));
    }
    for (const [x0, y0, x1, y1] of part.fp.silk) {
      tracks.push(encodeTrack({ layer: L.TOP_OVERLAY, a: P(...place(part, x0, y0)), b: P(...place(part, x1, y1)), width: mm(0.15), component: ci }));
    }
    for (const [x, y, rr] of part.fp.dots) arcs.push(encodeArc({ layer: L.TOP_OVERLAY, c: P(...place(part, x, y)), r: mm(rr * 0.5), start: 0, end: 360, width: mm(rr), component: ci }));
    // Assembly outline on Mechanical 13 is the bodies; the courtyard is left out
    for (const b of part.fp.bodies) {
      const pts = b.box ? [[b.box[0], b.box[1]], [b.box[2], b.box[1]], [b.box[2], b.box[3]], [b.box[0], b.box[3]]] as [number, number][] : circle(...b.circle!);
      bodies.push(encodeBody({ component: ci, outline: pts.map(([x, y]) => P(...place(part, x, y))), standoff: mm(b.z0), overall: mm(b.z1), colour: b.colour, layer: MECH_BODY }));
    }
    // The designator: above the part if clear, else below, right or left; smaller for small parts
    const court = part.fp.court;
    const cb = bboxOf([[court[0], court[1]], [court[2], court[1]], [court[2], court[3]], [court[0], court[3]]].map(([x, y]) => place(part, x!, y!)));
    const small = part.fp.pads.length <= 4 && (court[2] - court[0]) < 5;
    const th = small ? 0.7 : 1.0, tw = th * 0.78 * part.ref.length;
    const cx = (cb[0] + cb[2]) / 2, cy = (cb[1] + cb[3]) / 2;
    const tries: [number, number][] = [[cx - tw / 2, cb[3] + 0.15], [cx - tw / 2, cb[1] - th - 0.15], [cb[2] + 0.2, cy - th / 2], [cb[0] - tw - 0.2, cy - th / 2],
      [cb[0], cb[3] + 0.15], [cb[2] - tw, cb[3] + 0.15], [cb[0], cb[1] - th - 0.15], [cb[2] - tw, cb[1] - th - 0.15]];
    let at = tries.find(([x, y]) => !hits([x, y, x + tw, y + th]));
    if (!at && part.ref.startsWith('MH')) at = undefined;
    else at ??= tries[0];
    if (at) {
      boxes.push([at[0], at[1], at[0] + tw, at[1] + th]);
      texts.push(encodeText({ layer: L.TOP_OVERLAY, at: P(at[0], at[1]), height: mm(th), strokeWidth: mm(th * 0.14), text: part.ref, component: ci, isDesignator: true }));
    }
    texts.push(encodeText({ layer: L.TOP_OVERLAY, at: P(part.x, part.y), height: mm(0.8), text: part.comment, component: ci, isComment: true }));
  });
  // Board legends, letter by letter (proportional: the stroke font's narrow letters keep a full cell)
  const legend = (text: string, x: number, y: number, hgt: number, layer: LayerId, mirrored = false) => {
    let pen = 0;
    for (const ch of text) {
      const adv = ch === ' ' ? hgt * 0.62 : ch === 'I' || ch === '1' ? hgt * 0.42 : ch === '.' ? hgt * 0.4 : /[MW]/.test(ch) ? hgt * 1.02 : hgt * 0.9;
      if (ch !== ' ') texts.push(encodeText({ layer, at: P(x + (mirrored ? -pen : pen), y), height: mm(hgt), strokeWidth: mm(hgt * 0.14), text: ch, mirrored }));
      pen += adv;
    }
  };
  if (spec?.legends) spec.legends(legend);
  else {
    legend('KONIUM SHOWCASE', 48.2, 73.6, 1.4, L.TOP_OVERLAY);
    legend('CONTROLLER  REV A', 48.2, 71.4, 1.0, L.TOP_OVERLAY);
    legend('KONIUM DESIGNER', 28.6, 31.2, 1.7, L.BOTTOM_OVERLAY, true);
    legend('6 LAYERS  1.6 MM  ENIG', 28.6, 28.6, 1.0, L.BOTTOM_OVERLAY, true);
  }

  const root = newEntry('Root Entry', 'root');
  const wide = 'PCB 5.0 Bi';
  const fh = new BinWriter(32).u32(19);
  for (const ch of wide) fh.u8(ch.charCodeAt(0)).u8(0);
  cfbPut(root, 'FileHeader', fh.finish());
  const six = binToBytes('PCB 6.0 Binary File');
  cfbPut(root, 'FileHeaderSix', new BinWriter(32).u32(six.length).u8(six.length).bytes(six).f64(5.01).finish());
  const putText = (s: string, bags: PropertyBag[]) => { cfbPut(root, `${s}/Header`, countHeader(bags.length)); cfbPut(root, `${s}/Data`, joinTextRecords(bags)); };
  const putBin = (s: string, recs: PcbRawRecord[]) => { cfbPut(root, `${s}/Header`, countHeader(recs.length)); cfbPut(root, `${s}/Data`, joinBinaryRecords(recs)); };
  putText('Board6', [board]);
  putText('Nets6', nets.map((n) => PropertyBag.from({ NAME: n, VISIBLE: 'TRUE' })));
  putText('Components6', comps);
  putBin('Pads6', pads); putBin('Tracks6', tracks); putBin('Vias6', []); putBin('Fills6', []); putBin('Arcs6', arcs); putBin('Texts6', texts);
  putBin('Regions6', []); putBin('ShapeBasedRegions6', []); putBin('ComponentBodies6', bodies);
  for (const st of ['Connections6', 'Coordinates6', 'DifferentialPairs6', 'Dimensions6', 'EmbeddedBoards6', 'EmbeddedFonts6', 'Embeddeds6', 'FromTos6',
    'Models', 'ModelsNoEmbed', 'PadViaLibraryLinks', 'PinPairsSection', 'PrimitiveParameters', 'ShapeBasedComponentBodies6', 'SmartUnions', 'Textures',
    'WaivedViolations', 'WideStrings6', 'ExtendedPrimitiveInformation', 'UniqueIDPrimitiveInformation']) putBin(st, []);
  // Rules: 0.15 mm tracks and clearance, 0.45 / 0.2 mm vias; supplies 0.3 mm, power 0.5 mm
  const rules = defaultRules();
  const rule = (k: string) => rules.find((x) => x.bag.get('RULEKIND') === k)!;
  const width = rule('Width');
  width.bag.set('MINLIMIT', '0.127mm'); width.bag.set('PREFEREDWIDTH', '0.15mm'); width.bag.set('MAXLIMIT', '2mm'); width.bag.set('PRIORITY', '3');
  const wide1 = newRule('Width', 'Width_Power', 1);
  wide1.bag.set('SCOPE1EXPRESSION', "InNetClass('Power')"); wide1.bag.set('MINLIMIT', '0.127mm'); wide1.bag.set('PREFEREDWIDTH', '0.5mm'); wide1.bag.set('MAXLIMIT', '2mm');
  const wide2 = newRule('Width', 'Width_Supply', 2);
  wide2.bag.set('SCOPE1EXPRESSION', "InNetClass('Supply')"); wide2.bag.set('MINLIMIT', '0.127mm'); wide2.bag.set('PREFEREDWIDTH', '0.3mm'); wide2.bag.set('MAXLIMIT', '2mm');
  rules.push(wide1, wide2);
  rule('Clearance').bag.set('GAP', '0.15mm');
  const via = rule('RoutingVias');
  for (const [k, v] of [['MINWIDTH', '0.45mm'], ['WIDTH', '0.45mm'], ['MAXWIDTH', '0.6mm'], ['MINHOLEWIDTH', '0.2mm'], ['HOLEWIDTH', '0.2mm'], ['MAXHOLEWIDTH', '0.3mm']]) via.bag.set(k!, v!);
  rule('HoleToHoleClearance').bag.set('GAP', '0.2mm');
  rule('HoleSize').bag.set('MAXLIMIT', '3.5mm');
  rule('MinimumSolderMaskSliver')?.bag.set('MINSOLDERMASKWIDTH', '0.05mm');
  cfbPut(root, 'Rules6/Header', countHeader(rules.length));
  cfbPut(root, 'Rules6/Data', joinRuleRecords(rules));
  const cls = (name: string, id: string, members: string[]) => PropertyBag.from({ NAME: name, KIND: 0, SUPERCLASS: 'FALSE', ...Object.fromEntries(members.map((m, i) => [`M${i}`, m])), UNIQUEID: id });
  putText('Classes6', (spec?.classes ?? [['Power', ['VBUS', 'VBUS_F', '+5V', 'SW']], ['Supply', ['GND', '+3V3', '+3V3A']]]).map(([n, m], i) => cls(n, `SHOWCLS${i}`, m)));
  return readPcbDoc(writeCfb(root), spec?.fileName ?? 'Showcase.PcbDoc');
}

/** Six layers: Top, GND plane, Mid-Layer 1, Mid-Layer 2, +3V3 plane, Bottom (1.6 mm). */
export function sixLayers(doc: PcbDocument): void {
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const at = (l: LayerId) => rows.findIndex((x) => x.layer === l);
  const step = (layer: number, plane: boolean) => { const r = addStackLayer(rows, layer, plane)!; rows = r.rows; return r.index; };
  const p1 = step(at(L.TOP), true);
  const m1 = step(p1, false);
  const m2 = step(m1, false);
  step(m2, true);
  setStack(doc, rows).apply();
  rows = readStack(doc.board.bag!, doc.board.copperStack);
  const diel = [0.2, 0.36, 0.3, 0.36, 0.2];
  let k = 0;
  rows = rows.map((x) => (x.kind === 'dielectric' ? { ...x, height: mm(diel[k++] ?? 0.2), dielType: k % 2 ? 2 : 1, dielMaterial: k % 2 ? 'PP-006' : 'FR-4' } : x.kind === 'signal' || x.kind === 'plane' ? { ...x, copper: mil(1.4) } : x));
  setStack(doc, rows).apply();
  const names = new Map<LayerId, string>([[L.PLANE1, 'GND'], [PLANE2, '+3V3'], [L.MID1, 'Mid-Layer 1'], [MID2, 'Mid-Layer 2']]);
  rows = readStack(doc.board.bag!, doc.board.copperStack).map((x) => (x.layer !== null && names.has(x.layer) ? { ...x, name: names.get(x.layer)! } : x));
  setStack(doc, rows).apply();
  doc.board.bag!.set('PLANE1NETNAME', 'GND');
  doc.board.bag!.set('PLANE2NETNAME', '+3V3');
  doc.dirty.add('Board6');
}

const netNo = (doc: PcbDocument, name: string) => doc.nets.findIndex((n) => n.name === name);

function pour(doc: PcbDocument, layer: LayerId, netName: string, name: string, pts: [number, number][]): number {
  const index = doc.polygons.length;
  const bag = newPolygonProps(layerToName(layer), netNo(doc, netName), name, index);
  writeVertices(bag, pts.map(([x, y]) => ({ p: P(x, y) })));
  addPolygon(doc, bag).apply();
  return index;
}
const repourAll = (doc: PcbDocument) => { for (const p of doc.polygons) repour(doc, p.index).apply(); };

export async function routeBoard(doc: PcbDocument, log: (s: string) => void, first: Set<string> = new Set()): Promise<string[]> {
  const planeNets = new Set(['GND', '+3V3'].map((n) => netNo(doc, n)));
  // Plane nets: each SMD pad to a via (fanout); 1V2 to the pour on Mid-Layer 2
  const supply = new Set([...planeNets, netNo(doc, '1V2')]);
  // Thermal vias in the QFNs' exposed pads
  const thermal = (ref: string, pad: string, n: number, pitch: number) => {
    const ci = doc.components.findIndex((c) => c.designator === ref);
    const ep = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.component === ci && p.name === pad)!;
    const vias = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) vias.push({ at: { x: ep.at.x + mm((i - (n - 1) / 2) * pitch), y: ep.at.y + mm((j - (n - 1) / 2) * pitch) }, diameter: mm(0.45), hole: mm(0.2), net: ep.net, layerStart: L.TOP, layerEnd: L.BOTTOM });
    addVias(doc, vias).apply();
  };
  thermal('U8', '33', 3, 1.0);
  thermal('U9', '17', 2, 0.8);
  const fo = fanout(doc, smdPads(doc, (p) => supply.has(p.net)));
  addTracks(doc, fo.tracks).apply(); addVias(doc, fo.vias).apply();
  log(`fanout: ${fo.done} pads, ${fo.failed.length} failed ${fo.failed.map((p) => `${doc.components[p.component]?.designator}-${p.name}`).join(' ')}`);
  // The FPGA's signal balls: dog-bone vias so the inner rings escape on the inner layers; their
  // connections then start at the via (the router needn't put another beside it)
  const u2 = doc.components.findIndex((c) => c.designator === 'U2');
  const inner = smdPads(doc, (p) => p.component === u2 && !supply.has(p.net) && Math.max(Math.abs(p.at.x - P(design.FPGA.x, 0).x), Math.abs(p.at.y - P(0, design.FPGA.y).y)) < mm(4.0));
  const fb = fanout(doc, inner);
  addTracks(doc, fb.tracks).apply(); addVias(doc, fb.vias).apply();
  log(`bga fanout: ${fb.done} balls, ${fb.failed.length} failed`);
  const dog = new Map<string, Vec2>();
  for (const t of fb.tracks) { const v = fb.vias.find((x) => Math.hypot(x.at.x - t.b.x, x.at.y - t.b.y) < 10); if (v) dog.set(`${t.a.x},${t.a.y}`, v.at); }
  const viaEnd = (q: Vec2) => dog.get(`${q.x},${q.y}`) ?? q;
  pour(doc, MID2, '1V2', '1V2_MID2', [[62, 21.6], [74, 21.6], [74, 33.2], [89.6, 33.2], [89.6, 48.6], [74.6, 48.6], [74.6, 35.4], [62, 35.4]]);
  repourAll(doc);
  // Everything left: signals, and the plane nets' pads that couldn't fan out (to their neighbours).
  // The nets in `first` (the ones a previous attempt couldn't finish) are routed on their own first.
  const all = connections(doc);
  const early = all.filter((c) => first.has(doc.nets[c.net]!.name)).map((c) => ({ ...c, a: viaEnd(c.a), b: viaEnd(c.b) }));
  const failed: string[] = [];
  for (const [label, conns] of [['first', early], ['rest', null]] as const) {
    const list = (conns ?? connections(doc)).map((c) => ({ ...c, a: viaEnd(c.a), b: viaEnd(c.b) }));
    if (!list.length) continue;
    const r = await autoroute(doc, list, { ripUp: true });
    addTracks(doc, r.tracks).apply(); addVias(doc, r.vias).apply();
    log(`${label}: ${list.length} connections, ${r.routed} routed, ${r.failed.length} failed, ${r.ripped} ripped, ${(r.ms / 1000).toFixed(1)} s`);
    for (const f of r.failed) { failed.push(doc.nets[f.net]!.name); log(`  failed ${doc.nets[f.net]?.name}`); }
  }
  return failed;
}

export async function finishBoard(doc: PcbDocument, log: (s: string) => void): Promise<void> {
  const inset = 0.5, c = BOARD.corner;
  const ring: [number, number][] = [[c, inset], [BOARD.w - c, inset], [BOARD.w - inset, c], [BOARD.w - inset, BOARD.h - c], [BOARD.w - c, BOARD.h - inset], [c, BOARD.h - inset], [inset, BOARD.h - c], [inset, c]];
  pour(doc, L.BOTTOM, 'GND', 'GND_BOTTOM', ring);
  // Top: GND round the radio and under the power stage
  pour(doc, L.TOP, 'GND', 'GND_RF', [[91, 46], [114.5, 46], [114.5, 70.5], [91, 70.5]]);
  repourAll(doc);
  // What the repoured 1V2 pour no longer joins (the routes cut it), routed
  const left = connections(doc);
  if (left.length) {
    const r = await autoroute(doc, left, { ripUp: true });
    addTracks(doc, r.tracks).apply(); addVias(doc, r.vias).apply();
    log(`after pouring: ${left.length} connections, ${r.routed} routed, ${r.failed.length} failed`);
    repourAll(doc);
  }
  const gnd = netNo(doc, 'GND');
  const st: ReturnType<typeof planStitching> = [];
  const B = (x0: number, y0: number, x1: number, y1: number) => ({ minX: P(x0, y0).x, minY: P(x0, y0).y, maxX: P(x1, y1).x, maxY: P(x1, y1).y });
  const fence = (area: ReturnType<typeof B>, grid: number) => { const v = planStitching(doc, { net: gnd, grid: mm(grid), diameter: mm(0.45), hole: mm(0.2), area }); addVias(doc, v).apply(); st.push(...v); };
  fence(B(91.5, 46.5, 114, 70), 2.0);
  // A fence along the board's edge (on the 2.5 mm grid from the origin)
  fence(B(2.4, 2.3, 112.6, 2.7), 2.5); fence(B(2.4, 74.8, 112.6, 75.2), 2.5); fence(B(2.3, 2.4, 2.7, 75.1), 2.5); fence(B(112.3, 2.4, 112.7, 75.1), 2.5);
  log(`stitching: ${st.length} vias`);
  const td = planTeardrops(doc, { pads: true, vias: true, selectedOnly: false, force: false, style: 'track' });
  if (td.tracks.length) addTracks(doc, td.tracks.map((t) => ({ ...t, net: t.net === NO_NET ? undefined : t.net }))).apply();
  if (td.arcs.length) addPrimRecords(doc, td.arcs.map((a) => ({ storage: 'Arcs6', rec: freshRecord(doc, 'Arcs6', (t) => encodeArc({ ...a, net: a.net === NO_NET ? undefined : a.net }, t)) }))).apply();
  log(`teardrops: ${td.joints} joints, ${td.skipped} skipped`);
  repourAll(doc);
  doc.dirty.add('Texts6');
}

export { P, pour, repourAll, netNo };
export const writeBoard = (doc: PcbDocument) => writePcbDoc(doc);
