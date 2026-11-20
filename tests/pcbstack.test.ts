import { describe, expect, it } from 'vitest';
import { PropertyBag } from '../src/formats/altium/props';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addStackLayer, deleteStackLayer, moveStackLayer, readStack, setStack, settleIds, stackCopper, stackThickness, styleType, writeStack } from '../src/model/pcbStack';
import { L, fromV7 } from '../src/model/layers';
import { toV7 } from '../src/formats/altium/pcbdoc';
import { mil } from '../src/core/units';
import { UndoStack } from '../src/core/undo';

/** A two-layer Board6 as AD17 writes it: legacy keys and the LAYER_V8_i entries (abridged). */
function ad17Board(): PropertyBag {
  const G = '{5C0C3223-D866-4955-BCD2-EB2E768135EA}';
  const e = (i: number, kv: Record<string, string>) => ({ [`LAYER_V8_${i}_${G}CONTEXT`]: '0', [`LAYER_V8_${i}_${G}USEDBYPRIMS`]: 'FALSE', ...Object.fromEntries(Object.entries(kv).map(([k, v]) => [`LAYER_V8_${i}${k}`, v])) });
  return PropertyBag.from({
    RECORD: 'Board',
    ...e(0, { ID: '{A}', NAME: 'Top Paste', LAYERID: '16973832', USEDBYPRIMS: 'TRUE' }),
    ...e(1, { ID: '{B}', NAME: 'Top Overlay', LAYERID: '16973830', USEDBYPRIMS: 'TRUE' }),
    ...e(2, { ID: '{C}', NAME: 'Top Solder', LAYERID: '16973834', USEDBYPRIMS: 'FALSE', DIELTYPE: '3', DIELCONST: '3.500', DIELHEIGHT: '0.4mil', DIELMATERIAL: 'Solder Resist' }),
    ...e(3, { ID: '{D}', NAME: 'Top Layer', LAYERID: '16777217', USEDBYPRIMS: 'TRUE', COPTHICK: '1.4mil', COMPONENTPLACEMENT: '1' }),
    ...e(4, { ID: '{E}', NAME: 'Dielectric 1', LAYERID: '17039361', USEDBYPRIMS: 'FALSE', DIELTYPE: '1', DIELCONST: '4.200', DIELHEIGHT: '10mil', DIELMATERIAL: 'FR-4' }),
    ...e(5, { ID: '{F}', NAME: 'Bottom Layer', LAYERID: '16842751', USEDBYPRIMS: 'TRUE', COPTHICK: '1.4mil', COMPONENTPLACEMENT: '2' }),
    ...e(6, { ID: '{G}', NAME: 'Bottom Solder', LAYERID: '16973835', USEDBYPRIMS: 'FALSE', DIELTYPE: '3', DIELCONST: '3.500', DIELHEIGHT: '0.4mil', DIELMATERIAL: 'Solder Resist' }),
    ...e(7, { ID: '{H}', NAME: 'Bottom Overlay', LAYERID: '16973831', USEDBYPRIMS: 'TRUE' }),
    ...e(8, { ID: '{I}', NAME: 'Bottom Paste', LAYERID: '16973833', USEDBYPRIMS: 'FALSE' }),
    ...e(9, { ID: '{J}', NAME: 'Mechanical 1', LAYERID: '16908289', USEDBYPRIMS: 'FALSE', MECHENABLED: 'TRUE' }),
    TOPTYPE: '3', TOPCONST: '3.500', TOPHEIGHT: '0.4mil', TOPMATERIAL: 'Solder Resist', BOTTOMTYPE: '3', BOTTOMCONST: '3.500', BOTTOMHEIGHT: '0.4mil', BOTTOMMATERIAL: 'Solder Resist',
    LAYER1NAME: 'Top Layer', LAYER1PREV: '0', LAYER1NEXT: '32', LAYER1COPTHICK: '1.4mil', LAYER1DIELTYPE: '1', LAYER1DIELCONST: '4.200', LAYER1DIELHEIGHT: '10mil', LAYER1DIELMATERIAL: 'FR-4',
    LAYER2NAME: 'Mid-Layer 1', LAYER2PREV: '0', LAYER2NEXT: '0',
    LAYER32NAME: 'Bottom Layer', LAYER32PREV: '1', LAYER32NEXT: '0', LAYER32COPTHICK: '1.4mil',
    LAYER39NAME: 'Internal Plane 1', LAYER39PREV: '0', LAYER39NEXT: '0',
  });
}

describe('layer stack', () => {
  it('reads the V8 entries in order and writes them back unchanged', () => {
    const b = ad17Board();
    const rows = readStack(b);
    expect(rows.map((r) => r.kind)).toEqual(['paste', 'overlay', 'solder', 'signal', 'dielectric', 'signal', 'solder', 'overlay', 'paste']);
    expect(rows[4]).toMatchObject({ name: 'Dielectric 1', dielType: 1, dielMaterial: 'FR-4', dielConst: 4.2, height: mil(10) });
    expect(stackThickness(rows)).toBe(mil(1.4 * 2 + 10 + 0.4 * 2));
    expect(writeStack(b, rows).rawEntries()).toEqual(b.rawEntries());
  });
  it('a legacy-only board reads from the copper chain and the dielectric under each layer', () => {
    const b = PropertyBag.from({ LAYER1NAME: 'Top Layer', LAYER1NEXT: 32, LAYER1PREV: 0, LAYER32NAME: 'Bottom Layer', LAYER32NEXT: 0, LAYER32PREV: 1 });
    const rows = readStack(b);
    expect(rows.map((r) => r.name)).toEqual(['Top Overlay', 'Top Solder', 'Top Layer', 'Dielectric 1', 'Bottom Layer', 'Bottom Solder', 'Bottom Overlay']);
    // the demo board carries AD17's V9 entries
    const d = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(readStack(d.board.bag!).map((r) => r.name)).toEqual(['Top Paste', 'Top Overlay', 'Top Solder', 'Top Layer', 'Dielectric 1', 'Bottom Layer', 'Bottom Solder', 'Bottom Overlay', 'Bottom Paste']);
  });
  it('Add Layer as AD17 does it: names, 1.417 mil copper, Layer Pairs re-typing the dielectrics, new ids in stack order', () => {
    // The user's AD17 run: a new board, Top Layer selected, Add Layer twice, OK
    const b = ad17Board();
    let rows = readStack(b);
    const top = () => rows.findIndex((r) => r.layer === L.TOP);
    rows = addStackLayer(rows, top(), false, 0)!.rows;
    expect(rows.filter((r) => r.kind === 'signal' || r.kind === 'dielectric').map((r) => `${r.name}:${r.dielType}:${r.height / mil(1)}`)).toEqual([
      'Top Layer:0:0', 'Dielectric 1:1:10', 'Signal Layer 1:0:0', 'Dielectric 2:2:5', 'Bottom Layer:0:0']);
    rows = addStackLayer(rows, top(), false, 0)!.rows;
    const desc = (rs: typeof rows) => rs.filter((r) => r.kind === 'signal' || r.kind === 'dielectric').map((r) => `${r.name}:${r.dielType}:${r.height / mil(1)}`);
    // Top-Core-L2-Prepreg-L3-Core-Bottom: the earlier prepreg is now a 10 mil core, as in AD17's file
    expect(desc(rows)).toEqual(['Top Layer:0:0', 'Dielectric 1:1:10', 'Signal Layer 2:0:0', 'Dielectric 3:2:5', 'Signal Layer 1:0:0', 'Dielectric 2:1:10', 'Bottom Layer:0:0']);
    expect(rows.find((r) => r.name === 'Signal Layer 2')).toMatchObject({ copper: mil(1.417), placement: 0 });
    expect(rows.find((r) => r.name === 'Dielectric 3')).toMatchObject({ dielMaterial: '', dielConst: 4.2 });
    const settled = settleIds(rows);
    // As AD17 saved it: Signal Layer 2 is Mid-Layer 1 (16777218), Signal Layer 1 Mid-Layer 2; Dielectric 3 17039362, Dielectric 2 17039363
    expect(settled.filter((r) => r.name.startsWith('Signal') || /Dielectric [23]/.test(r.name)).map((r) => `${r.name}=${r.v7}`))
      .toEqual(['Signal Layer 2=16777218', 'Dielectric 3=17039362', 'Signal Layer 1=16777219', 'Dielectric 2=17039363']);
    const w = writeStack(b, settled);
    expect(['LAYER1NEXT', 'LAYER2PREV', 'LAYER2NEXT', 'LAYER3NEXT', 'LAYER32PREV', 'LAYER2NAME', 'LAYER3NAME', 'LAYER2COPTHICK', 'LAYER2DIELTYPE', 'LAYER2DIELHEIGHT', 'LAYER3DIELTYPE', 'LAYER3DIELHEIGHT', 'LAYER3DIELMATERIAL']
      .map((k) => w.get(k))).toEqual(['2', '1', '3', '32', '3', 'Signal Layer 2', 'Signal Layer 1', '1.417mil', '2', '5mil', '1', '10mil', '']);
    // V8 entries: renumbered in stack order, new ones with the substack keys, the rest after
    expect(readStack(w).map((r) => r.name)).toEqual(settled.map((r) => r.name));
    expect(fromV7(Number(w.get('LAYER_V8_5LAYERID')))).toBe(2);
    expect(w.has('LAYER_V8_5_{5C0C3223-D866-4955-BCD2-EB2E768135EA}CONTEXT')).toBe(true);
    expect(w.get('LAYER_V8_13NAME')).toBe('Mechanical 1');
    // Add Internal Plane above the bottom layer when that is selected
    const p = addStackLayer(settled, settled.findIndex((r) => r.layer === L.BOTTOM), true, 0)!;
    expect(stackCopper(p.rows)).toEqual([L.TOP, 2, 3, L.PLANE1, L.BOTTOM]);
    expect(p.rows[p.index]!.name).toBe('Internal Plane 1');
    // Move a mid layer up, delete one with its dielectric; top and bottom stay
    const mid = settled.findIndex((r) => r.layer === 3);
    const m = moveStackLayer(settled, mid, -1);
    expect(typeof m === 'string' ? m : stackCopper(m.rows)).toEqual([L.TOP, 3, 2, L.BOTTOM]);
    expect(moveStackLayer(settled, top(), 1)).toMatch(/inner/);
    const del = deleteStackLayer(settled, mid, 0);
    expect(typeof del === 'string' ? del : stackCopper(del)).toEqual([L.TOP, 2, L.BOTTOM]);
    expect(deleteStackLayer(settled, settled.findIndex((r) => r.layer === L.BOTTOM))).toMatch(/stay/);
    expect(toV7(L.PLANE1)).toBe(0x01010001);
    expect(styleType(0, 0, 3)).toBe(1);
  });
  it('OK on the board: one undo step, the copper stack and names follow', () => {
    const d = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const rows = readStack(d.board.bag!, d.board.copperStack);
    const a = addStackLayer(rows, rows.findIndex((r) => r.layer === L.TOP), false)!;
    a.rows[a.index] = { ...a.rows[a.index]!, name: 'GND' };
    const undo = new UndoStack();
    undo.transact('Layer Stack Manager', (tx) => tx.add(setStack(d, a.rows)));
    expect(d.board.copperStack).toEqual([L.TOP, 2, L.BOTTOM]);
    expect(d.board.layerNames.get(2)).toBe('GND');
    expect(d.board.bag!.get('LAYER2COPTHICK')).toBe('1.417mil');
    expect(d.dirty.has('Board6')).toBe(true);
    undo.undo();
    expect(d.board.copperStack).toEqual([L.TOP, L.BOTTOM]);
    expect(d.board.bag!.get('LAYER1NEXT')).toBe('32');
  });
});
