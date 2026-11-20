import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeFill } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addNet, addPrimRecords, addTracks, addVias } from '../src/model/pcbEdit';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';
import { DEFAULT_EMC, EMC_KINDS, emcCheck, emcReport, supplyName, type EmcSetup } from '../src/analysis/emc';
import { defaultEmcForm, formEmc } from '../src/app/emcRun';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const PLANE2 = (L.PLANE1 + 1) as LayerId;
const NAME: Record<number, string> = { [L.TOP]: 'Top Layer', [L.BOTTOM]: 'Bottom Layer', [L.PLANE1]: 'Plane 1', [PLANE2]: 'Plane 2', [L.MID1]: 'Mid 1' };
const name = (l: LayerId) => NAME[l] ?? `layer ${l}`;

/** A board with nets GND, +3V3, SIG, CLK and DATA; `stack` its copper layers, `planes` the nets of its plane layers. */
function board(stack: LayerId[], planes: Record<string, string> = {}): { doc: PcbDocument; net: Record<string, number> } {
  const doc = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
  const net: Record<string, number> = {};
  for (const n of ['GND', '+3V3', 'SIG', 'CLK', 'DATA']) { addNet(doc, n).apply(); net[n] = doc.nets.length - 1; }
  doc.board.copperStack = stack;
  for (const [k, v] of Object.entries(planes)) doc.board.bag!.set(k, v);
  return { doc, net };
}
const only = (o: Partial<EmcSetup>): EmcSetup => ({ ...DEFAULT_EMC, gaps: false, edge: false, layerChange: false, decoupling: false, stitching: false, ...o });
const check = (doc: PcbDocument, o: Partial<EmcSetup>) => emcCheck(doc, only(o), name);

describe('the EMC check (26.174)', () => {
  it('a track over a slot in its plane is found by the slot\'s length, however narrow; a short slot and a track clear of it are not', () => {
    const { doc, net } = board([L.TOP, L.PLANE1, PLANE2, L.BOTTOM], { PLANE1NETNAME: 'GND', PLANE2NETNAME: '+3V3' });
    addTracks(doc, [
      // A slot cut in the plane: 30 mm long, 0.4 mm wide; and a short one, 1.5 mm
      { layer: L.PLANE1, a: P(20, 5), b: P(20, 35), width: mm(0.4) },
      { layer: L.PLANE1, a: P(80, 19.25), b: P(80, 20.75), width: mm(0.4) },
      { layer: L.TOP, a: P(10, 20), b: P(30, 20), width: mm(0.2), net: net.SIG },
      { layer: L.TOP, a: P(40, 20), b: P(60, 20), width: mm(0.2), net: net.CLK },
      { layer: L.TOP, a: P(70, 20), b: P(90, 20), width: mm(0.2), net: net.DATA },
    ]).apply();
    const r = check(doc, { gaps: true });
    expect(r.findings.map((f) => f.kind)).toEqual(['gap']);
    const f = r.findings[0]!;
    expect(f.net).toBe(net.SIG);
    expect(f.layer).toBe(L.TOP);
    expect(f.message).toMatch(/^SIG on Top Layer runs 0\.\d mm over a gap 3\d mm long in the copper under it$/);
    expect(doc.prims[f.prims![0]!]!.kind).toBe('track');
    expect(f.box!.minX).toBeLessThan(P(20, 20).x); expect(f.box!.maxX).toBeGreaterThan(P(20, 20).x);
    expect([r.nets, r.tracks]).toEqual([3, 3]);
    // Asked for gaps from 1 mm: the short slot counts too
    expect(check(doc, { gaps: true, minGap: mm(1) }).findings.map((x) => x.net).sort()).toEqual([net.SIG, net.DATA].sort());
    // Only the nets asked for are looked at
    expect(check(doc, { gaps: true, nets: ['CL*'] }).findings).toEqual([]);
    expect(check(doc, { gaps: true, nets: ['sig', 'CLK'] }).findings.length).toBe(1);
  });

  it('a gap that several nets cross is listed once, with the nets', () => {
    const { doc, net } = board([L.TOP, L.PLANE1, PLANE2, L.BOTTOM], { PLANE1NETNAME: 'GND', PLANE2NETNAME: '+3V3' });
    addTracks(doc, [
      { layer: L.PLANE1, a: P(20, 5), b: P(20, 35), width: mm(0.4) },
      { layer: L.TOP, a: P(10, 15), b: P(30, 15), width: mm(0.2), net: net.SIG },
      { layer: L.TOP, a: P(10, 20), b: P(30, 20), width: mm(0.2), net: net.CLK },
      { layer: L.TOP, a: P(10, 25), b: P(30, 25), width: mm(0.2), net: net.DATA },
    ]).apply();
    const r = check(doc, { gaps: true });
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.message).toMatch(/^3 nets on Top Layer \(SIG, CLK, DATA\) cross a gap 3\d mm long in the copper under them$/);
    expect(r.findings[0]!.prims!.length).toBe(3);
  });

  it('the panel\'s form: lengths in millimetres, the frequency in megahertz, the nets as typed', () => {
    const s = formEmc({ ...defaultEmcForm(), nets: 'CLK*, usb_d? ;DATA', frequency: '350', minGap: '1,5', returnVia: 'x', stitching: false });
    expect(s.nets).toEqual(['CLK*', 'usb_d?', 'DATA']);
    expect([s.frequency, s.minGap, s.returnVia, s.stitching, s.gaps]).toEqual([350e6, mm(1.5), mm(3), false, true]);
    expect(formEmc(defaultEmcForm())).toMatchObject({ nets: [], minGap: mm(2.5), minEdgeRun: mm(5), capDistance: mm(5), decouplingDistance: mm(5), edgeFactor: 3, frequency: 1e9 });
  });

  it('a track that leaves its plane for the open board is over the longest gap of all', () => {
    const { doc, net } = board([L.TOP, L.MID1, L.BOTTOM]);
    // Copper under half the board only, on the middle layer
    addPrimRecords(doc, [{ storage: 'Fills6', rec: encodeFill({ layer: L.MID1, a: P(5, 5), b: P(60, 60), net: net.GND }) }]).apply();
    addTracks(doc, [{ layer: L.TOP, a: P(30, 30), b: P(80, 30), width: mm(0.2), net: net.SIG }]).apply();
    const r = check(doc, { gaps: true });
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.message).toMatch(/^SIG on Top Layer runs (19|20|21)(\.\d)? mm over the open edge in the copper under it$/);
  });

  it('a track from over one net\'s copper to over another\'s crosses a split', () => {
    const { doc, net } = board([L.TOP, L.MID1, L.BOTTOM]);
    addPrimRecords(doc, [
      { storage: 'Fills6', rec: encodeFill({ layer: L.MID1, a: P(5, 5), b: P(50, 60), net: net.GND }) },
      { storage: 'Fills6', rec: encodeFill({ layer: L.MID1, a: P(50.05, 5), b: P(100, 60), net: net['+3V3'] }) },
    ]).apply();
    addTracks(doc, [{ layer: L.TOP, a: P(30, 30), b: P(70, 30), width: mm(0.2), net: net.SIG }, { layer: L.TOP, a: P(10, 40), b: P(40, 40), width: mm(0.2), net: net.CLK }]).apply();
    const r = check(doc, { gaps: true });
    expect(r.findings.map((f) => f.kind)).toEqual(['split']);
    expect(r.findings[0]!.message).toBe('SIG on Top Layer crosses from over GND to over +3V3');
  });

  it('a track along the very edge of the copper under it, and one well inside', () => {
    const { doc, net } = board([L.TOP, L.MID1, L.BOTTOM]);
    addPrimRecords(doc, [{ storage: 'Fills6', rec: encodeFill({ layer: L.MID1, a: P(5, 5), b: P(100, 60), net: net.GND }) }]).apply();
    addTracks(doc, [{ layer: L.TOP, a: P(20, 5.5), b: P(60, 5.5), width: mm(0.2), net: net.SIG }, { layer: L.TOP, a: P(20, 30), b: P(60, 30), width: mm(0.2), net: net.CLK }]).apply();
    const r = check(doc, { edge: true });
    expect(r.findings.map((f) => [f.kind, f.net])).toEqual([['edge', net.SIG]]);
    expect(r.findings[0]!.message).toMatch(/^SIG on Top Layer runs (39|40|41)(\.\d)? mm within \d\.\d mm of the edge of the copper under it$/);
    // A short stretch is let be
    expect(check(doc, { edge: true, minEdgeRun: mm(60) }).findings).toEqual([]);
  });

  it('a layer change between two planes of one net wants a via of that net close by', () => {
    const { doc, net } = board([L.TOP, L.PLANE1, PLANE2, L.BOTTOM], { PLANE1NETNAME: 'GND', PLANE2NETNAME: 'GND' });
    addTracks(doc, [{ layer: L.TOP, a: P(30, 50), b: P(50, 50), width: mm(0.2), net: net.SIG }, { layer: L.BOTTOM, a: P(50, 50), b: P(70, 50), width: mm(0.2), net: net.SIG }]).apply();
    addVias(doc, [{ at: P(50, 50), diameter: mm(0.6), hole: mm(0.3), net: net.SIG }]).apply();
    let r = check(doc, { layerChange: true });
    expect(r.findings.map((f) => f.kind)).toEqual(['layerChange']);
    expect(r.findings[0]!.message).toBe('SIG goes from Top Layer to Bottom Layer, its return passing between two layers of GND: GND has no via (within 3.0 mm is wanted)');
    expect(doc.prims[r.findings[0]!.prims![0]!]!.kind).toBe('via');
    expect(r.vias).toBe(1);
    // A ground via 10 mm off is too far and is named; one 1.5 mm off will do
    addVias(doc, [{ at: P(60, 50), diameter: mm(0.6), hole: mm(0.3), net: net.GND }]).apply();
    r = check(doc, { layerChange: true });
    expect(r.findings[0]!.message).toMatch(/the nearest via of GND is 10 mm away/);
    addVias(doc, [{ at: P(51.5, 50), diameter: mm(0.6), hole: mm(0.3), net: net.GND }]).apply();
    expect(check(doc, { layerChange: true }).findings).toEqual([]);
  });

  it('a layer change from over ground to over a supply wants a capacitor between them; a via that stays over one plane wants nothing', () => {
    const { doc, net } = board([L.TOP, L.PLANE1, PLANE2, L.BOTTOM], { PLANE1NETNAME: 'GND', PLANE2NETNAME: '+3V3' });
    addTracks(doc, [{ layer: L.TOP, a: P(30, 50), b: P(50, 50), width: mm(0.2), net: net.SIG }, { layer: L.BOTTOM, a: P(50, 50), b: P(70, 50), width: mm(0.2), net: net.SIG }]).apply();
    addVias(doc, [{ at: P(50, 50), diameter: mm(0.6), hole: mm(0.3), net: net.SIG }]).apply();
    const r = check(doc, { layerChange: true });
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.message).toBe('SIG goes from Top Layer to Bottom Layer, its return passing from GND to +3V3: there is no capacitor between them (within 5.1 mm is wanted)');
    // Three layers, the plane between the two signal layers: both are over the same copper
    const three = board([L.TOP, L.PLANE1, L.BOTTOM], { PLANE1NETNAME: 'GND' });
    addTracks(three.doc, [{ layer: L.TOP, a: P(30, 50), b: P(50, 50), width: mm(0.2), net: three.net.SIG }, { layer: L.BOTTOM, a: P(50, 50), b: P(70, 50), width: mm(0.2), net: three.net.SIG }]).apply();
    addVias(three.doc, [{ at: P(50, 50), diameter: mm(0.6), hole: mm(0.3), net: three.net.SIG }]).apply();
    expect(check(three.doc, { layerChange: true }).findings).toEqual([]);
  });

  it('ground copper on two layers far from any via between them; stitched, nothing', () => {
    const { doc, net } = board([L.TOP, L.BOTTOM]);
    doc.board.outline = [P(0, 0), P(40, 0), P(40, 30), P(0, 30)];
    addPrimRecords(doc, [L.TOP, L.BOTTOM].map((layer) => ({ storage: 'Fills6', rec: encodeFill({ layer, a: P(1, 1), b: P(39, 29), net: net.GND }) }))).apply();
    addVias(doc, [{ at: P(3, 3), diameter: mm(0.6), hole: mm(0.3), net: net.GND }]).apply();
    const r = check(doc, { stitching: true, frequency: 1e9 });
    // A twentieth of a wavelength at 1 GHz in the board: about 7 mm
    expect(r.lambda20 / mm(1)).toBeGreaterThan(6); expect(r.lambda20 / mm(1)).toBeLessThan(7.6);
    expect(r.findings.map((f) => [f.kind, f.layer])).toEqual([['stitching', L.TOP], ['stitching', L.BOTTOM]]);
    expect(r.findings[0]!.message).toMatch(/^GND copper on Top Layer reaches 4\d mm from its nearest via: a twentieth of a wavelength at 1 GHz is \d\.\d mm$/);
    // At 100 MHz the whole board is within reach of the one via
    expect(check(doc, { stitching: true, frequency: 100e6 }).findings).toEqual([]);
    // Vias every 5 mm
    const grid = [];
    for (let x = 3; x < 39; x += 5) for (let y = 3; y < 29; y += 5) grid.push({ at: P(x, y), diameter: mm(0.6), hole: mm(0.3), net: net.GND });
    addVias(doc, grid).apply();
    expect(check(doc, { stitching: true, frequency: 1e9 }).findings).toEqual([]);
  });

  it('a layer with nothing under most of its tracks is said once, its gaps not listed', () => {
    const { doc, net } = board([L.TOP, L.BOTTOM]);
    addTracks(doc, [{ layer: L.TOP, a: P(10, 20), b: P(60, 20), width: mm(0.2), net: net.SIG }, { layer: L.TOP, a: P(10, 30), b: P(60, 30), width: mm(0.2), net: net.CLK }]).apply();
    const r = check(doc, { gaps: true, edge: true });
    expect(r.findings.map((f) => f.kind)).toEqual(['noReference']);
    expect(r.findings[0]!.message).toBe('Top Layer: 100 % of the checked tracks\' length has no copper under it on the next layer; its gaps are not listed');
  });

  it('the demo board: its regulator\'s supply pins against the capacitors beside them', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(emcCheck(doc, only({ decoupling: true, decouplingDistance: mm(30) }), name).findings).toEqual([]);
    const r = emcCheck(doc, only({ decoupling: true, decouplingDistance: mm(0.2) }), name);
    expect(r.ics).toBe(1);
    expect(r.findings.map((f) => f.kind)).toEqual(['decoupling']);
    expect(r.findings[0]!.message).toMatch(/^U1: \d supply pins \(.*(VIN|\+3V3).*\) have no capacitor to ground within 0\.2 mm: the nearest to pin \w+, C[12], is \d+(\.\d)? mm away$/);
    expect(r.findings[0]!.prims!.every((i) => doc.prims[i]!.kind === 'pad')).toBe(true);
    // The whole check with what it is set to at first runs, and its report reads
    const all = emcCheck(doc, DEFAULT_EMC, name), text = emcReport(all, DEFAULT_EMC, 'Demo.PcbDoc');
    expect(text.split('\n')[0]).toBe('EMC Check: Demo.PcbDoc');
    expect(text).toMatch(/Frequency {7}1 GHz: a twentieth of a wavelength in the board \(dielectric constant \d(\.\d+)?\) is \d\.\d mm/);
    expect(text).not.toMatch(/NaN|undefined/);
    expect(EMC_KINDS.map((k) => k.kind)).toContain('decoupling');
  });

  it('supplies told by their names', () => {
    expect(['+3V3', '3V3', '+5V', '12V', 'VCC', 'VDD_IO', 'AVDD', 'VBAT', 'VIN', 'VBUS', '-12V', '1V8'].every(supplyName)).toBe(true);
    expect(['SDA', 'CLK', 'VSYNC', 'RESET', 'D3', 'GND'].some(supplyName)).toBe(false);
  });
});
