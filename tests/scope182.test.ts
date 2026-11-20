/**
 * Live Simulation, its second build (26.182): the record a scope reads, what it measures, a
 * spectrum, the switch and push button whose picture is their state, a part's values found and
 * written, and numbers as a netlist takes them.
 */
import { describe, expect, it } from 'vitest';
import { LiveRecord, fft, measure, niceAxis, spectrum } from '../src/sim/liveRecord';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { simPartSymbols, simSourceSymbols } from '../src/formats/synthetic/simLib';
import { partRecords } from '../src/model/schPlace';
import { simModelOf, simParamHolder } from '../src/model/simModels';
import { setSimParam } from '../src/model/simModels';
import { LIVE_GROUPS, LIVE_PARTS, MAX_KEPT, MAX_SCOPES, addScope, clearProbes, dropProbe, keepProbe, livePartSymbol, removeScope, scope, setCurrentScope, setScopeView, spiceText, type Probe } from '../src/app/liveSim';
import { builtinModel } from '../src/sim/library';
import { FEATURE_COMMANDS } from '../src/core/release';
import '../src/app/menus/index';
import { CONTEXT } from '../src/app/menus/ad17.gen';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SIM_PARTS_LIB, type SimSymbolBuilder } from '../src/formats/synthetic/simLib';
import { SR, bagOf, isShown, type SchDocument, type SchObject } from '../src/model/sch';
import { setProps } from '../src/model/schEdit';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { binToBytes } from '../src/formats/text';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';

describe('Live Simulation (26.182): the scope and what is turned by hand', () => {
  it('the record keeps every step, forgets the oldest, and reads a trace as a sum of its signals', () => {
    const r = new LiveRecord(['a', 'b'], 8);
    for (let k = 0; k < 12; k++) r.push(k, (i) => (i === 0 ? k : 10 * k));
    expect(r.count).toBe(8);
    expect([r.oldest, r.latest]).toEqual([4, 11]);
    const d = r.series({ label: 'a-b', unit: 'V', terms: [['A', 1], ['b', -1], ['0', 5]] })!;
    expect([...d.t]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect([...d.y]).toEqual([-36, -45, -54, -63, -72, -81, -90, -99]);
    // From a time on; a signal it doesn't hold is no trace at all; the reference alone reads 0
    expect([...r.series({ label: 'a', unit: 'V', terms: [['a', 1]] }, 9.5)!.t]).toEqual([10, 11]);
    expect(r.series({ label: 'x', unit: 'V', terms: [['nope', 1]] })).toBeNull();
    expect([...r.series({ label: 'gnd', unit: 'V', terms: [] }, 10)!.y]).toEqual([0, 0]);
    // Steps closer than the spacing are passed over, one half as far again or more is kept (26.184: the gaps are uneven between the two); a time before the last starts it again
    r.spacing = 1;
    r.push(11.5, () => 1);
    expect(r.latest).toBe(11);
    r.push(12.5, () => 1);
    expect(r.latest).toBe(12.5);
    r.push(3, () => 7);
    expect([r.count, r.latest]).toEqual([1, 3]);
    expect(r.same(['a', 'b'])).toBe(true);
    expect(r.same(['a', 'c'])).toBe(false);
  });

  it('a sine is measured: its least, most, mean and how often it repeats', () => {
    const n = 2000, t = new Float64Array(n), y = new Float64Array(n);
    for (let k = 0; k < n; k++) { t[k] = k * 5e-6; y[k] = 1 + 2 * Math.sin(2 * Math.PI * 1000 * t[k]!); }
    const m = measure(t, y)!;
    expect(m.min).toBeCloseTo(-1, 2);
    expect(m.max).toBeCloseTo(3, 2);
    expect(m.mean).toBeCloseTo(1, 1);
    expect(m.freq).toBeGreaterThan(995);
    expect(m.freq).toBeLessThan(1005);
    // A steady value repeats at nothing
    expect(measure(Float64Array.from([0, 1, 2]), Float64Array.from([5, 5, 5]))!.freq).toBe(0);
    expect(measure(new Float64Array(0), new Float64Array(0))).toBeNull();
  });

  it('the spectrum of two sines has its two lines at their sizes', () => {
    const n = 6000, t = new Float64Array(n), y = new Float64Array(n);
    // Uneven steps, as a simulator takes them
    let at = 0;
    for (let k = 0; k < n; k++) { at += (k % 3 ? 4e-6 : 7e-6); t[k] = at; y[k] = 0.5 + Math.sin(2 * Math.PI * 1000 * at) + 0.1 * Math.sin(2 * Math.PI * 5000 * at); }
    const s = spectrum(t, y)!;
    const peak = (lo: number, hi: number) => { let k = -1; s.f.forEach((f, i) => { if (f >= lo && f <= hi && (k < 0 || s.a[i]! > s.a[k]!)) k = i; }); return [s.f[k]!, s.a[k]!]; };
    const [f1, a1] = peak(500, 2000), [f5, a5] = peak(4000, 6000);
    expect(Math.abs(f1 - 1000)).toBeLessThan(s.f[0]! * 1.01);
    expect(a1).toBeGreaterThan(0.85); expect(a1).toBeLessThan(1.05);
    expect(Math.abs(f5 - 5000)).toBeLessThan(s.f[0]! * 1.01);
    expect(a5).toBeGreaterThan(0.08); expect(a5).toBeLessThan(0.11);
    // The transform itself: a single cycle of a cosine is one line
    const re = Float64Array.from({ length: 8 }, (_, k) => Math.cos(2 * Math.PI * k / 8)), im = new Float64Array(8);
    fft(re, im);
    expect(re[1]).toBeCloseTo(4, 9); expect(re[7]).toBeCloseTo(4, 9); expect(Math.abs(re[2]!)).toBeLessThan(1e-9);
  });

  it('an axis is marked in round numbers', () => {
    expect(niceAxis(0, 11.7)).toEqual({ lo: 0, hi: 15, step: 5 });
    expect(niceAxis(-0.0031, 0.0018)).toEqual({ lo: -0.004, hi: 0.002, step: 0.002 });
    const flat = niceAxis(5, 5);
    expect(flat.lo).toBeLessThan(5); expect(flat.hi).toBeGreaterThan(5);
  });

  it('every accepted step is told, and an unknown is read by where it is kept', () => {
    const sim = new Simulator(readNetlist('*\nV1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 100n\n.END\n'));
    sim.liveStart();
    const at = sim.unknownAt('out')!, times: number[] = [], vals: number[] = [];
    sim.liveAdvance(2e-3, 2e-5, Infinity, (t) => { times.push(t); vals.push(sim.valueAt(at)); });
    expect(times.length).toBeGreaterThan(90);
    expect(times.every((t, i) => !i || t > times[i - 1]!)).toBe(true);
    expect(times[times.length - 1]).toBe(sim.liveTime);
    expect(vals[vals.length - 1]).toBe(sim.valueOf('out'));
    expect(sim.unknownAt('0')).toBe(-1);
    expect(sim.valueAt(-1)).toBe(0);
    expect(sim.unknownAt('nope')).toBeUndefined();
    expect(sim.unknownAt('V1#branch')).toBeGreaterThanOrEqual(0);
  });

  it('a switch and a push button: two pictures, open and closed, each with its contacts and pins; the model a resistance', () => {
    const parts = simPartSymbols();
    for (const ref of ['SWITCH', 'PUSHBUTTON']) {
      const s = parts.find((p) => p.libRef === ref)!;
      expect(s.bags[0]!.int('DISPLAYMODECOUNT')).toBe(2);
      const pins = s.bags.filter((b) => b.int('RECORD', -1) === 2);
      expect(pins.map((b) => [b.get('DESIGNATOR'), b.int('OWNERPARTDISPLAYMODE', 0)])).toEqual([['1', 0], ['2', 0], ['1', 1], ['2', 1]]);
      // What is drawn: as much in the one mode as in the other; the text and the model in neither
      const drawn = s.bags.filter((b) => [6, 8, 13].includes(b.int('RECORD', -1)));
      expect(drawn.filter((b) => b.int('OWNERPARTDISPLAYMODE', 0) === 0).length).toBe(drawn.filter((b) => b.int('OWNERPARTDISPLAYMODE', 0) === 1).length);
      expect(s.bags.filter((b) => b.int('OWNERPARTID', 0) === -1 && b.has('OWNERPARTDISPLAYMODE'))).toEqual([]);
      const items = partRecords({ libRef: ref, bags: s.bags }, 'Simulation Parts.SchLib', 1);
      expect(items.length).toBeGreaterThan(10);
    }
    // Every other part and source is of one picture, as before
    expect([...parts, ...simSourceSymbols()].filter((p) => p.bags[0]!.int('DISPLAYMODECOUNT') !== 1).map((p) => p.libRef)).toEqual(['SWITCH', 'PUSHBUTTON', 'SWITCH_SPDT', 'LOGIC_IN']);
  });

  it('numbers as a netlist takes them, to three figures', () => {
    expect([4700, 1e-7, 2.2e6, 0.0471, 1, 999.6, 12345, 0, -3.3e-3].map(spiceText)).toEqual(['4.7k', '100n', '2.2Meg', '47.1m', '1', '1k', '12.3k', '0', '-3.3m']);
  });

});

/** A 5 V source through a switch (or a push button) into 1 kΩ. */
function switchSheet(libRef = 'SWITCH'): Uint8Array {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0, AREACOLOR: 0xffffff, SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
  const put = (list: SimSymbolBuilder[], lib: string, ref: string, des: string, at: [number, number], values: Record<string, string> = {}) => {
    const items = partRecords({ libRef: ref, bags: list.find((s) => s.libRef === ref)!.bags }, lib, 1);
    for (const [k, v] of Object.entries(values)) setSimParam(items, k, v);
    b.placePart(items, at, { designator: des });
  };
  put(simSourceSymbols(), 'Simulation Sources.IntLib', 'VSRC', 'V1', [100, 400], { Value: '5' });
  put(simPartSymbols(), SIM_PARTS_LIB, libRef, 'SW1', [200, 400]);
  put(simPartSymbols(), SIM_PARTS_LIB, 'RES', 'R1', [200, 340], { Value: '1k' });
  b.wire([100, 420], [100, 440], [200, 440], [200, 420]);
  b.wire([200, 380], [200, 360]);
  b.wire([200, 320], [200, 300]);
  b.wire([100, 380], [100, 360]);
  for (const at of [{ x: 200, y: 300 }, { x: 100, y: 360 }]) b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 4, ORIENTATION: 3, TEXT: 'GND', SHOWNETNAME: true, COLOR: 128 }, { LOCATION: at });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

describe('Live Simulation (26.182): a switch on a sheet, and a value written to a part', () => {
  const run = (doc: SchDocument) => {
    const sheets = [{ name: 'Switch.SchDoc', doc }], compiled = compileProject(sheets);
    const map: LiveMap = { nets: new Map(), pins: new Map() };
    const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
    const sim = new Simulator(readNetlist(net.text));
    sim.liveStart();
    const top = compiled.nets.find((n) => n.pins.some((p) => p.designator === 'R1' && p.pin === '1'))!;
    return { net, map, sim, v: sim.valueOf(map.nets.get(top.name)!)!, i: sim.valueOf(`${map.pins.get('R1|1')!.meter}#branch`)! };
  };
  const comp = (doc: SchDocument, des: string) => doc.objects.find((o) => o.kind === 'component' && o.designator === des)! as SchObject & { kind: 'component' };

  it('open, the load sees nothing; closed (its second picture), all of the supply', () => {
    const doc = readSchDoc(switchSheet(), 'Switch.SchDoc');
    const sw = comp(doc, 'SW1');
    expect([sw.displayMode, simModelOf(doc, sw.index)!.subKind]).toEqual([0, 'Switch']);
    // The pins and drawings of the picture not shown are there, hidden
    const kids = doc.objects.filter((o) => o.owner === sw.index && ([SR.PIN, SR.LINE, SR.ELLIPSE] as number[]).includes(o.record));
    expect(kids.filter((o) => isShown(doc, o)).length).toBe(kids.length / 2);
    const open = run(doc);
    expect(open.net.messages.filter((m) => m.level !== 'info')).toEqual([]);
    expect(open.net.text).toMatch(/^RSW1 \S+ \S+ 1G$/m);
    expect(open.v).toBeLessThan(1e-4);
    setProps(doc, sw.index, { DISPLAYMODE: '1' }).apply();
    expect(comp(doc, 'SW1').displayMode).toBe(1);
    const closed = run(doc);
    expect(closed.net.text).toMatch(/^RSW1 \S+ \S+ 1m$/m);
    expect(closed.v).toBeCloseTo(5, 4);
    expect(closed.i).toBeCloseTo(5e-3, 6);
    // The same pins by the same names in either picture: a record of the run carries on over a throw
    expect([...closed.map.pins.keys()].sort()).toEqual([...open.map.pins.keys()].sort());
    // Its own resistances, where the part gives them
    setProps(doc, simParamHolder(doc, comp(doc, 'SW1').index, 'On Resistance')!, { TEXT: '1k' }).apply();
    expect(run(doc).v).toBeCloseTo(2.5, 4);
  });

  it('a push button is closed for as long as its picture is the pressed one; the file is not touched', () => {
    const doc = readSchDoc(switchSheet('PUSHBUTTON'), 'Switch.SchDoc');
    const pb = comp(doc, 'SW1');
    expect(simModelOf(doc, pb.index)!.subKind).toBe('Push Button');
    expect(run(doc).v).toBeLessThan(1e-4);
    pb.displayMode = 1;
    expect(run(doc).v).toBeCloseTo(5, 4);
    pb.displayMode = 0;
    expect(run(doc).v).toBeLessThan(1e-4);
    expect(bagOf(doc, pb)!.int('DISPLAYMODE', 0)).toBe(0);
  });

  it('a part\'s value is found where it is kept and written there', () => {
    const doc = readSchDoc(switchSheet(), 'Switch.SchDoc');
    setProps(doc, comp(doc, 'SW1').index, { DISPLAYMODE: '1' }).apply();
    const r1 = comp(doc, 'R1'), holder = simParamHolder(doc, r1.index, 'Value')!;
    // The model leaves the value to the part ('*'): the part's own parameter holds it
    expect(doc.objects[holder]!.owner).toBe(r1.index);
    expect(bagOf(doc, doc.objects[holder]!)!.get('TEXT')).toBe('1k');
    setProps(doc, holder, { TEXT: '4k' }).apply();
    expect(run(doc).i).toBeCloseTo(1.25e-3, 6);
    // A source's value likewise; a name the model doesn't have: nothing
    const v1 = comp(doc, 'V1');
    expect(bagOf(doc, doc.objects[simParamHolder(doc, v1.index, 'Value')!]!)!.get('TEXT')).toBe('5');
    expect(simParamHolder(doc, r1.index, 'Frequency')).toBeNull();
    expect(simParamHolder(doc, doc.objects.findIndex((o) => o.kind === 'wire'), 'Value')).toBeNull();
  });
});

describe('Live Simulation (26.182): the palette, the monitors and the scopes', () => {
  it('the palette is 77 parts in seven kinds, each with its symbol and a model; the models they use are built in', () => {
    expect(LIVE_PARTS.length).toBe(77);
    expect([...new Set(LIVE_PARTS.map((p) => p.group))]).toEqual([...LIVE_GROUPS]);
    expect(LIVE_GROUPS.map((g) => LIVE_PARTS.filter((p) => p.group === g).length)).toEqual([13, 7, 7, 8, 21, 15, 6]);
    // No two parts on one key; every field of every part is a parameter its symbol has
    const keys = LIVE_PARTS.filter((p) => p.key).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of LIVE_PARTS) for (const f of p.fields) {
      const names = livePartSymbol(p)!.bags.filter((b) => b.int('RECORD', -1) === 41).map((b) => (b.get('NAME') ?? '').toUpperCase());
      expect(names, `${p.id}: ${f.param}`).toContain(f.param.toUpperCase());
    }
    for (const p of LIVE_PARTS) {
      const sym = livePartSymbol(p)!;
      expect(sym, p.id).toBeTruthy();
      expect(sym.bags.some((b) => (b.get('MODELTYPE') ?? '') === 'SIM'), p.id).toBe(true);
      expect(p.hint.length, p.id).toBeGreaterThan(5);
      // Something to draw in its tile: lines, shapes or pins
      expect(sym.bags.filter((b) => [2, 6, 7, 8, 12, 13, 14].includes(b.int('RECORD', -1))).length, p.id).toBeGreaterThanOrEqual(2);
    }
    for (const m of ['1N5819', '1N4733A', '2N5457', 'OPAMP_IDEAL', 'DIODE_VF', 'NPN_BETA', 'PNP_BETA', 'NMOS_VT', 'PMOS_VT', 'NJFET', 'PJFET', 'POT', 'TRANSFORMER', 'RELAY', 'XTAL', 'COMPARATOR', 'CCVS', 'CCCS']) expect(builtinModel(m), m).not.toBeNull();
  });

  it('the new parts simulate: an op-amp with no supplies follows and clips at 15 V, a Zener holds 5.1 V, a Schottky drops less than a signal diode, a JFET conducts', () => {
    const lib = (...names: string[]) => names.map((n) => builtinModel(n)!.text).join('\n');
    const op = (text: string, node: string) => { const s = new Simulator(readNetlist(`*\n${text}\n.END\n`)); s.liveStart(); return s.valueOf(node)!; };
    // A follower: out is the input; an amplifier of 11 asked for 22 V stops at 15 V
    expect(op(`V1 in 0 5\nX1 in out out OPAMP_IDEAL\nR1 out 0 10k\n${lib('OPAMP_IDEAL')}`, 'out')).toBeCloseTo(5, 3);
    const clip = op(`V1 in 0 2\nX1 in fb out OPAMP_IDEAL\nR1 out fb 10k\nR2 fb 0 1k\n${lib('OPAMP_IDEAL')}`, 'out');
    expect(clip).toBeGreaterThan(14.9); expect(clip).toBeLessThanOrEqual(15.001);
    expect(op(`V1 in 0 3\nX1 in fb out OPAMP_IDEAL\nR1 out fb 10k\nR2 fb 0 10k\n${lib('OPAMP_IDEAL')}`, 'out')).toBeCloseTo(6, 3);
    // A Zener fed backwards through 1 kΩ from 12 V
    const vz = op(`V1 in 0 12\nR1 in k 1k\nD1 0 k 1N4733A\n${lib('1N4733A')}`, 'k');
    expect(vz).toBeGreaterThan(4.9); expect(vz).toBeLessThan(5.4);
    const drop = (m: string) => op(`V1 in 0 5\nR1 in a 1k\nD1 a 0 ${m}\n${lib(m)}`, 'a');
    expect(drop('1N5819')).toBeLessThan(0.35);
    expect(drop('1N4148')).toBeGreaterThan(0.55);
    // A JFET with its gate at its source: its saturation current through 1 kΩ from 10 V
    const vd = op(`V1 vdd 0 10\nR1 vdd d 1k\nJ1 d 0 0 2N5457\n${lib('2N5457')}`, 'd');
    expect(vd).toBeLessThan(9.5); expect(vd).toBeGreaterThan(5);
  });

  it('scopes side by side: another is picked for the next probe and keeps the last where it was; closing one takes its probes with it', () => {
    const probe = (id: number, label: string, on: number): Probe => ({ id, label, colour: 0x2e86ab, from: { at: { x: 0, y: 0 } }, v: { label, unit: 'V', terms: [[label, 1]] }, i: null, at: { x: 0, y: 0 }, along: null, gone: false, scope: on });
    scope.value = { probe: probe(1, 'a', 1), kept: [], scopes: [{ id: 1, view: 'time' }], current: 1 };
    const second = addScope();
    expect(second).toBe(2);
    expect([scope.value.current, scope.value.probe, scope.value.kept.map((p) => [p.label, p.scope])]).toEqual([2, null, [['a', 1]]]);
    setScopeView(2, 'spectrum');
    expect(scope.value.scopes).toEqual([{ id: 1, view: 'time' }, { id: 2, view: 'spectrum' }]);
    // A probe on the second, kept; back to the first with another in hand, which is kept on the way
    scope.value = { ...scope.value, probe: probe(2, 'b', 2) };
    keepProbe();
    scope.value = { ...scope.value, probe: probe(3, 'c', 2) };
    setCurrentScope(1);
    expect([scope.value.current, scope.value.probe, scope.value.kept.map((p) => [p.label, p.scope])]).toEqual([1, null, [['a', 1], ['b', 2], ['c', 2]]]);
    dropProbe(3);
    expect(scope.value.kept.map((p) => p.label)).toEqual(['a', 'b']);
    // A monitor on the sheet only (scope 0) outlives the scopes' own clearing
    scope.value = { ...scope.value, kept: [...scope.value.kept, probe(4, 'm', 0)] };
    removeScope(2);
    expect([scope.value.scopes.map((s) => s.id), scope.value.current, scope.value.kept.map((p) => p.label)]).toEqual([[1], 1, ['a', 'm']]);
    removeScope(1);   // the last one stays
    expect(scope.value.scopes.length).toBe(1);
    clearProbes(1);
    expect(scope.value.kept.map((p) => p.label)).toEqual(['m']);
    clearProbes();
    expect(scope.value.kept).toEqual([]);
    // No more scopes than there may be
    for (let k = 0; k < MAX_SCOPES + 2; k++) addScope();
    expect(scope.value.scopes.length).toBe(MAX_SCOPES);
    expect(MAX_KEPT).toBe(24);
    scope.value = { probe: null, kept: [], scopes: [{ id: 1, view: 'time' }], current: 1 };
  });

  it('the right-click menu of a sheet begins with what a running sheet offers, each a command of the feature', () => {
    const items = (CONTEXT.sch as [string, unknown[]])[1].slice(0, 5);
    expect(items).toEqual([['&Monitor Here', 'live.monitorWithContext'], ['Add to the &Scope', 'live.scopeWithContext'], ['View in a &New Scope', 'live.newScopeWithContext'], ['St&op Monitoring Here', 'live.unmonitorWithContext'], 0]);
    for (const c of ['live.monitorWithContext', 'live.scopeWithContext', 'live.newScopeWithContext', 'live.unmonitorWithContext', 'live.scope']) expect(FEATURE_COMMANDS[c], c).toBe('live');
  });
});

