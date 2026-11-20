/**
 * A rigid-flex companion board for the pictures: a sensor head (IMU, temperature sensor, RGB LEDs)
 * on a flex tail to a connector board, four layers rigid and a single-layer flex (Top on
 * polyimide), the tail bent 90° about a bending line.
 */
import * as P from './parts';
import type { Fp } from './parts';
import type { Part } from './design';
import { buildBoard, P as at, pour, repourAll } from './pcb';
import { encodeRegion } from '../../../src/formats/altium/pcbdoc';
import { addPrimRecords, addTracks, addVias, removePrims } from '../../../src/model/pcbEdit';
import { addStackLayer, readStack, setStack } from '../../../src/model/pcbStack';
import { addSplit, boardRegions, readSubstacks, setRigidFlex, withRegion, type SubStack } from '../../../src/model/rigidFlex';
import { autoroute } from '../../../src/model/autoroute';
import { connections } from '../../../src/model/drc';
import { planTeardrops } from '../../../src/model/teardrops';
import { pointInPoly } from '../../../src/core/geom';
import { L, type LayerId } from '../../../src/model/layers';
import { mm } from '../../../src/core/units';
import { NO_NET, type PcbDocument } from '../../../src/model/pcb';

const parts: Part[] = [];
const add = (ref: string, fp: Fp, x: number, y: number, rot: number, comment: string, nets: Record<string, string>, sym = 'IC') =>
  parts.push({ ref, fp, x, y, rot, comment, sym, nets, sheet: 'IO', description: fp.description });
const r0402 = P.chip('1005', 'R'), c0402 = P.chip('1005', 'C'), c0603 = P.chip('1608', 'C');
const mh2: Fp = { ...P.mountHole(), name: 'MH-M2', description: 'Mounting hole, M2, plated', pads: [{ name: '1', x: 0, y: 0, w: 4.2, h: 4.2, shape: 'round', hole: 2.2 }], court: [-2.2, -2.2, 2.2, 2.2] };

// Sensor head (rigid, 0..30 × 0..24)
add('U1', P.qfn16(), 11, 12, 0, 'LSM6DSO', { 1: 'GND', 4: 'SCL', 5: 'GND', 6: 'SDA', 7: 'GND', 8: '+3V3', 9: 'INT1', 10: 'INT2', 12: 'GND', 13: 'GND', 14: '+3V3', 15: '+3V3', 17: 'GND' });
add('C1', c0402, 11, 15.6, 0, '100nF', { 1: '+3V3', 2: 'GND' }, 'C');
add('C2', c0402, 14.8, 12, 90, '100nF', { 1: '+3V3', 2: 'GND' }, 'C');
add('U2', P.sot23(5), 21, 6.5, 0, 'TMP112', { 1: 'SDA', 2: 'GND', 3: 'ALERT', 4: 'SCL', 5: '+3V3' });
add('C3', c0402, 21, 9.8, 0, '100nF', { 1: '+3V3', 2: 'GND' }, 'C');
add('R1', r0402, 6.2, 18.5, 0, '4k7', { 1: 'SCL', 2: '+3V3' }, 'R');
add('R2', r0402, 6.2, 20.3, 0, '4k7', { 1: 'SDA', 2: '+3V3' }, 'R');
[['R', P.COL.ledRed], ['G', P.COL.ledGreen], ['B', P.COL.ledBlue]].forEach(([c, col], i) => {
  const x = 19 + i * 2.6;
  add(`R${3 + i}`, r0402, x, 14.6, 90, '1k', { 1: `LED_${c}`, 2: `LED_${c}_A` }, 'R');
  add(`D${1 + i}`, { ...P.chip('1608', 'LED', col as number), name: 'LEDC1608X55N' }, x, 18.6, 90, String(c), { 1: `LED_${c}_A`, 2: 'GND' }, 'LED');
});
add('MH1', mh2, 3.4, 3.4, 0, 'M2', { 1: 'GND' }, 'MH');
add('MH2', mh2, 26.6, 3.4, 0, 'M2', { 1: 'GND' }, 'MH');
// Connector board (rigid, 66..96 × 0..24)
add('J1', P.header(5, 2, true), 88, 12, 90, 'CONN', { 1: '+5V', 2: 'SDA', 3: 'GND', 4: 'SCL', 5: 'INT1', 6: 'INT2', 7: 'LED_R', 8: 'LED_G', 9: 'LED_B', 10: 'ALERT' });
add('U3', P.sot23(5), 75, 6, 0, 'TLV75533', { 1: '+5V', 2: 'GND', 3: '+5V', 5: '+3V3' });
add('C4', c0603, 71.4, 6, 90, '1µF', { 1: '+5V', 2: 'GND' }, 'C');
add('C5', c0603, 78.6, 6, 90, '4.7µF', { 1: '+3V3', 2: 'GND' }, 'C');
add('U4', P.sot23(6), 76, 17, 0, 'TPD4E05', { 1: 'SDA', 2: 'GND', 3: 'SCL', 4: 'INT1', 5: '+3V3', 6: 'INT2' });
add('C6', c0402, 76, 20.4, 0, '100nF', { 1: '+3V3', 2: 'GND' }, 'C');
add('MH3', mh2, 92.6, 3.4, 0, 'M2', { 1: 'GND' }, 'MH');
add('MH4', mh2, 92.6, 20.6, 0, 'M2', { 1: 'GND' }, 'MH');

const W = 96, H = 24, FX0 = 30, FX1 = 66, FY0 = 6, FY1 = 18;
const outline = [[0, 0], [FX0, 0], [FX0, FY0], [FX1, FY0], [FX1, 0], [W, 0], [W, H], [FX1, H], [FX1, FY1], [FX0, FY1], [FX0, H], [0, H]].map(([x, y]) => ({ p: at(x!, y!) }));

export async function flexBoard(log: (s: string) => void): Promise<PcbDocument> {
  const doc = buildBoard({ parts, fileName: 'SensorFlex.PcbDoc', size: { w: W, h: H }, outline, classes: [['Power', ['+5V']], ['Supply', ['+3V3', 'GND']]],
    legends: (legend) => { legend('IMU HEAD', 9.0, 1.4, 1.2, L.TOP_OVERLAY); legend('SENSOR LINK', 69.0, 21.4, 1.0, L.TOP_OVERLAY); } });
  // Four layers: Top on thin polyimide (the flex keeps only that), then Mid 1 and 2 and Bottom across an FR-4 core
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const step = (i: number) => { const r = addStackLayer(rows, i, false)!; rows = r.rows; return r.index; };
  step(step(rows.findIndex((x) => x.layer === L.TOP)));
  setStack(doc, rows).apply();
  rows = readStack(doc.board.bag!, doc.board.copperStack);
  const diel = [[0.1, 'Polyimide', 3.4], [1.1, 'FR-4', 4.2], [0.2, 'PP-006', 4.1]] as const;
  let k = 0;
  rows = rows.map((x) => (x.kind === 'dielectric' ? { ...x, height: mm(diel[k]![0]), dielMaterial: diel[k]![1], dielConst: diel[k++]![2] } : x));
  const main = readSubstacks(doc.board.bag)[0]!;
  const flex: SubStack = { id: '{6A1F3C2E-0B7D-4E59-9C1A-5D2E8F7B4C31}', name: 'Flex', isFlex: true, showTop: false, showBottom: false, service: false, usedByPrims: false, type: 1 };
  const inFlex = (x: (typeof rows)[number]) => x.layer === L.TOP || (x.kind === 'dielectric' && x.name === 'Dielectric 1');
  rows = rows.map((x) => ({ ...x, subs: { ...(x.subs ?? {}), [flex.id]: inFlex(x) } }));
  rows = rows.map((x) => (x.layer === L.MID1 ? { ...x, name: 'Mid-Layer 1' } : x.layer === L.MID1 + 1 ? { ...x, name: 'Mid-Layer 2' } : x));
  setStack(doc, rows, undefined, [main, flex]).apply();
  // Regions: head | tail | connector board; the tail on the flex stack with a 90° bend in its middle
  for (const [x, alt] of [[FX0, FX0 + 0.3], [FX1, FX1 - 0.3]] as const) { const f = addSplit(doc, at(x, FY0), at(x, FY1)) ?? addSplit(doc, at(alt, FY0), at(alt, FY1)); if (f) setRigidFlex(doc, f).apply(); }
  const regs = boardRegions(doc);
  const tail = regs.findIndex((r) => pointInPoly(at((FX0 + FX1) / 2, (FY0 + FY1) / 2), r.outline));
  const head = regs.findIndex((r) => pointInPoly(at(10, 12), r.outline));
  setRigidFlex(doc, withRegion(doc, tail, { stackId: flex.id, name: 'Flex Tail', bends: [{ a: at(48, FY0), b: at(48, FY1), angle: 90, radius: mm(2.5), foldIndex: 1 }] })).apply();
  setRigidFlex(doc, withRegion(doc, head, { locked3d: true, name: 'Sensor Head' })).apply();
  log(`flex: ${boardRegions(doc).length} regions, stacks ${readSubstacks(doc.board.bag).map((s) => s.name).join(', ')}`);
  // Route: keep-outs over the tail on the layers it hasn't, so its tracks run on Top; then the keep-outs go
  const box = [at(FX0 - 0.2, FY0 - 1), at(FX1 + 0.2, FY0 - 1), at(FX1 + 0.2, FY1 + 1), at(FX0 - 0.2, FY1 + 1)];
  const keep = [L.MID1, (L.MID1 + 1) as LayerId, L.BOTTOM].map((layer) => { const rec = encodeRegion({ layer, outline: box }); rec.subs[0]![2] = 2; return { storage: 'Regions6', rec }; });
  addPrimRecords(doc, keep).apply();
  const conns = connections(doc);
  const r = await autoroute(doc, conns, { ripUp: true });
  addTracks(doc, r.tracks).apply(); addVias(doc, r.vias).apply();
  log(`flex route: ${conns.length} connections, ${r.routed} routed, ${r.failed.length} failed ${r.failed.map((f) => doc.nets[f.net]?.name).join(' ')}`);
  removePrims(doc, doc.prims.filter((p) => p.kind === 'region' && p.keepout)).apply();
  // GND pours on both faces of the rigid parts
  for (const layer of [L.TOP, L.BOTTOM]) {
    pour(doc, layer, 'GND', `GND_HEAD_${layer}`, [[0.5, 0.5], [FX0 - 0.3, 0.5], [FX0 - 0.3, H - 0.5], [0.5, H - 0.5]]);
    pour(doc, layer, 'GND', `GND_CONN_${layer}`, [[FX1 + 0.3, 0.5], [W - 0.5, 0.5], [W - 0.5, H - 0.5], [FX1 + 0.3, H - 0.5]]);
  }
  repourAll(doc);
  const left = connections(doc);
  if (left.length) { const q = await autoroute(doc, left, { ripUp: true }); addTracks(doc, q.tracks).apply(); addVias(doc, q.vias).apply(); repourAll(doc); log(`flex after pours: ${left.length} → ${q.failed.length} failed ${q.failed.map((f) => doc.nets[f.net]?.name).join(' ')}`); }
  const td = planTeardrops(doc, { pads: true, vias: true, selectedOnly: false, force: false, style: 'track' });
  if (td.tracks.length) addTracks(doc, td.tracks.map((t) => ({ ...t, net: t.net === NO_NET ? undefined : t.net }))).apply();
  repourAll(doc);
  doc.dirty.add('Texts6');
  return doc;
}
