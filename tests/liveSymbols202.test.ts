/**
 * 26.202: Live Simulation's parts in the European and the American drawing (the resistor and the
 * potentiometer, the capacitors, the inductor), a sheet redrawn from one to the other, and the
 * electrolytic capacitor flagged when it is the wrong way round.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile, type LiveExample } from '../src/app/liveExamples';
import { STYLED_PARTS, drawingOf, livePartSymbol, restyleSheet, LIVE_PARTS } from '../src/app/liveSim';
import { SIM_PARTS_LIB, simPartSymbols, simSourceSymbols, type SymbolStyle } from '../src/formats/synthetic/simLib';
import { UPDATE_ALL, applyPartUpdates, updatedPart } from '../src/model/schUpdate';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { bagOf, ownedBy, type SchDocument } from '../src/model/sch';
import { projectNetlist } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { REVERSE_LIMIT, Stress } from '../src/sim/liveStress';
import { SchEditor } from '../src/editors/sch/SchEditor';

const sheetOf = (ex: LiveExample, style: SymbolStyle) => readSchDoc(liveExampleBytes(ex, style), liveExampleFile(ex));
/** A sheet's netlist, its lines in order (a part redrawn joins the end of its sheet's records, and its line the end of the netlist: the circuit is the same). */
const netlistOf = (doc: SchDocument, name: string) => { const sheets = [{ name, doc }]; return projectNetlist(compileProject(sheets), sheets, defaultSettings(), () => null, 'Live Simulation').text.split('\n').filter((l) => !l.startsWith('*SPICE Netlist generated')).sort().join('\n'); };   // (without the line that says when)
/** Each part of a sheet: its designator, its library name and what its drawing is made of. */
const partsOf = (doc: SchDocument) => {
  const kids = ownedBy(doc);
  return doc.objects.filter((o) => o.kind === 'component').map((o) => ({ designator: o.kind === 'component' ? o.designator : '', libRef: o.kind === 'component' ? o.libRef.toUpperCase() : '', drawn: drawingOf((kids.get(o.index) ?? []).flatMap((k) => bagOf(doc, k) ?? [])) }))
    .sort((a, b) => a.designator.localeCompare(b.designator));
};

describe('European and American symbols (26.202)', () => {
  it('the two sets are the same parts; five are drawn differently, and only those', () => {
    const eu = simPartSymbols('european'), us = simPartSymbols('american');
    expect(us.map((s) => s.libRef)).toEqual(eu.map((s) => s.libRef));
    expect(simPartSymbols().map((s) => drawingOf(s.bags))).toEqual(eu.map((s) => drawingOf(s.bags)));   // (European unless asked)
    const differ = eu.filter((s, i) => drawingOf(s.bags) !== drawingOf(us[i]!.bags)).map((s) => s.libRef);
    expect([...differ].sort()).toEqual([...STYLED_PARTS].sort());
    // What each is made of: a box or a zigzag; two plates or a plate and a curve; a hollow and a solid plate; half circles or loops
    const drawn = (set: typeof eu, libRef: string) => drawingOf(set.find((s) => s.libRef === libRef)!.bags);
    expect(drawn(eu, 'RES')).not.toBe(drawn(us, 'RES'));
    expect(drawn(eu, 'IND').split(' ').every((k) => k.endsWith(':180'))).toBe(true);
    expect(drawn(us, 'IND').split(' ').every((k) => k.endsWith(':0'))).toBe(true);
    expect(drawn(us, 'CAP').split(' ')).toHaveLength(2);
    expect(drawn(us, 'CAP_POL').split(' ')).toHaveLength(4);
    expect(drawn(eu, 'CAP_POL').split(' ')).toHaveLength(4);
    // The palette draws its tiles from the set chosen
    const res = LIVE_PARTS.find((p) => p.id === 'res')!;
    expect(drawingOf(livePartSymbol(res, 'american')!.bags)).toBe(drawn(us, 'RES'));
    expect(drawingOf(livePartSymbol(res, 'european')!.bags)).toBe(drawn(eu, 'RES'));
    expect(simSourceSymbols().length).toBeGreaterThan(10);
  });

  it('the electrolytic capacitor is named as one, in the palette and in the library', () => {
    const cap = LIVE_PARTS.find((p) => p.libRef === 'CAP_POL')!;
    expect([cap.label, cap.caption]).toEqual(['Electrolytic capacitor', 'Electrolytic']);
    expect(cap.hint).toMatch(/positive side is marked \+/);
    for (const style of ['european', 'american'] as const) expect(simPartSymbols(style).find((s) => s.libRef === 'CAP_POL')!.description).toMatch(/^Electrolytic capacitor \(polarised: pin 1 is its positive side\)/);
  });

  it('every example is the same circuit in either drawing: the pins end where the wires are', () => {
    let styled = 0;
    for (const ex of LIVE_EXAMPLES) {
      const name = liveExampleFile(ex), eu = sheetOf(ex, 'european'), us = sheetOf(ex, 'american');
      expect(netlistOf(us, name), ex.id).toBe(netlistOf(eu, name));
      const a = partsOf(eu), b = partsOf(us);
      expect(b.map((p) => [p.designator, p.libRef])).toEqual(a.map((p) => [p.designator, p.libRef]));
      for (const [i, p] of a.entries()) { expect(p.drawn !== b[i]!.drawn, `${ex.id} ${p.designator}`).toBe(STYLED_PARTS.includes(p.libRef)); if (STYLED_PARTS.includes(p.libRef)) styled++; }
    }
    expect(styled).toBeGreaterThan(100);
  });

  it('a sheet is redrawn in the other drawing in one step: places, designators, values and wires kept; Undo takes it back', () => {
    for (const id of ['lrc', 'pot', 'smoothing']) {
      const ex = LIVE_EXAMPLES.find((e) => e.id === id)!, name = liveExampleFile(ex);
      const ed = new SchEditor(sheetOf(ex, 'european'));
      const before = partsOf(ed.doc), net = netlistOf(ed.doc, name), want = partsOf(sheetOf(ex, 'american'));
      const texts = () => ed.doc.objects.flatMap((o) => { const b = bagOf(ed.doc, o), k = b?.int('RECORD', -1); return b && (k === 34 || k === 41) ? [b.get('TEXT') ?? ''] : []; }).sort();   // (designators and parameters)
      const said = texts();
      const n = restyleSheet(ed, 'american');
      expect(n, id).toBe(before.filter((p) => STYLED_PARTS.includes(p.libRef)).length);
      expect(n).toBeGreaterThan(0);
      expect(partsOf(ed.doc)).toEqual(want);
      expect(netlistOf(ed.doc, name)).toBe(net);
      expect(texts()).toEqual(said);
      // (again: nothing left to redraw, and nothing for Undo to hold)
      expect(restyleSheet(ed, 'american')).toBe(0);
      ed.undo.undo();
      expect(partsOf(ed.doc)).toEqual(before);
      expect(netlistOf(ed.doc, name)).toBe(net);
      ed.undo.redo();
      expect(partsOf(ed.doc)).toEqual(want);
      expect(restyleSheet(ed, 'european')).toBe(n);
      expect(partsOf(ed.doc)).toEqual(before);
    }
  });

  it('a part turned or mirrored is known for what it is, and a part of another library is left alone', () => {
    const ex = LIVE_EXAMPLES.find((e) => e.id === 'lrc')!;
    const ed = new SchEditor(sheetOf(ex, 'american'));
    // (the examples place parts turned: none of them is taken for the other drawing)
    expect(restyleSheet(ed, 'american')).toBe(0);
    // A resistor of somebody's own library, though named RES, is theirs
    const r = ed.doc.objects.find((o) => o.kind === 'component' && o.libRef === 'RES')!;
    bagOf(ed.doc, r)!.set('SOURCELIBRARYNAME', 'My Parts.SchLib');
    const all = partsOf(ed.doc).filter((p) => STYLED_PARTS.includes(p.libRef)).length;
    expect(restyleSheet(ed, 'european')).toBe(all - 1);
  });
});

describe('Update From Libraries and a part\'s simulation model (26.202)', () => {
  it('a part updated from its library, with its models or without, keeps a model that netlists (its parameters stay under it)', () => {
    const ex = LIVE_EXAMPLES.find((e) => e.id === 'pot')!, name = liveExampleFile(ex);
    // (the part's own values kept each time: the library's would be another circuit)
    for (const opts of [{ ...UPDATE_ALL, parameters: 'keep' } as const, { graphics: true, parameters: 'keep', models: false } as const, { graphics: false, parameters: 'keep', models: true } as const]) {
      const ed = new SchEditor(sheetOf(ex, 'european')), net = netlistOf(ed.doc, name), set = simPartSymbols();
      const results = ed.doc.objects.flatMap((o) => {
        const sym = o.kind === 'component' ? set.find((s) => s.libRef === o.libRef) : undefined;
        const u = sym && updatedPart(ed.doc, o.index, sym, SIM_PARTS_LIB, opts);
        return u ? [u] : [];
      });
      expect(results.length).toBeGreaterThan(1);
      ed.undo.transact('Update', (tx) => tx.add(applyPartUpdates(ed.doc, results)));
      // (a model taken from the library comes with the library's own figures: here the wiper's position, set on the model)
      const same = (t: string) => (opts.models ? t.replace(/POS=\d+/g, 'POS=#') : t);
      expect(same(netlistOf(ed.doc, name)), JSON.stringify(opts)).toBe(same(net));
      // (and no model parameter has become one of the part's own)
      const kids = ownedBy(ed.doc);
      for (const o of ed.doc.objects) if (o.kind === 'component') expect((kids.get(o.index) ?? []).filter((k) => bagOf(ed.doc, k)?.int('RECORD', -1) === 41).length, o.designator).toBeLessThanOrEqual(3);
    }
  });
});

describe('an electrolytic capacitor the wrong way round (26.202)', () => {
  it('is flagged past about a volt backwards, and not for any voltage the right way', () => {
    // Pin 1 (its positive side) at node 0, pin 2 at node 1
    let plus = 0, minus = 0;
    const valueAt = (k: number) => (k === 0 ? plus : k === 1 ? minus : 0);
    const back = new Stress('C1', { kind: 'voltage', value: REVERSE_LIMIT, reverse: true }, [[0, 2], [1, 3]]);
    let t = 0;
    const frames = (n: number, p: number, m: number) => { for (let f = 0; f < n; f++) { for (let k = 0; k < 10; k++) { t += 1e-3; plus = p; minus = m; back.step(t, valueAt); } back.frame(1 / 60); } };
    frames(60, 12, 0);
    expect([back.over, back.shown]).toEqual([false, 0]);
    frames(60, 0, 0.6);
    expect(back.over).toBe(false);
    frames(5, 0, 5);
    expect(back.over).toBe(true);
    expect(back.shown).toBeCloseTo(5, 6);
    // The right way round again: the flag goes as the reading falls away
    frames(600, 12, 0);
    expect(back.over).toBe(false);
  });
});
