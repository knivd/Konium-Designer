import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prefsSrc from '../src/app/Preferences.tsx?raw';
import rulesSrc from '../src/app/dialogs/Rules.tsx?raw';
import primSrc from '../src/app/dialogs/PrimDialogs.tsx?raw';
import { padExtrasOf, setPadExtras } from '../src/formats/altium/primInfo';
import { drawLayer, solderMask } from '../src/formats/gerber/gerber';
import type { PcbVia } from '../src/model/pcb';
import { bagDefaults, changedBagDefaults, hasBagDefaults, reloadBagDefaults, resetBagDefaults, setBagDefaults } from '../src/model/bagDefaults';
import { newPolygonProps } from '../src/formats/altium/polygonProps';
import { newDimension } from '../src/model/dimensions';
import { componentBag } from '../src/model/pcbEco';
import { exportDefaults, importDefaults } from '../src/model/pcbDefaults';
import { coordinateMarker } from '../src/model/boardTables';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  reloadBagDefaults();
});
afterEach(() => { vi.unstubAllGlobals(); reloadBagDefaults(); });

describe('Preferences › PCB Editor › Defaults for Component, Coordinate, Dimension and Polygon (26.112)', () => {
  it('every kind on the page can be edited; Design › Rules opens the Rule Wizard', () => {
    expect(prefsSrc).not.toMatch(/defaults aren't in Konium yet/);
    expect(rulesSrc).toMatch(/showDialog\(RuleWizardDialog, \{ ed, draft/);
    expect(rulesSrc).not.toMatch(/disabled title="Not available yet">Rule Wizard/);
  });

  it('AD17\'s values to start with; a change is kept and only it differs', () => {
    expect(bagDefaults('Polygon')).toMatchObject({ HATCHSTYLE: 'Solid', GRIDSIZE: '20mil', TRACKWIDTH: '8mil', REMOVEDEAD: 'TRUE' });
    expect(hasBagDefaults('Polygon')).toBe(false);
    setBagDefaults('Polygon', { ...bagDefaults('Polygon'), HATCHSTYLE: '45Degree', GRIDSIZE: '10mil' });
    expect(changedBagDefaults('Polygon')).toEqual({ HATCHSTYLE: '45Degree', GRIDSIZE: '10mil' });
    reloadBagDefaults();
    expect(bagDefaults('Polygon').HATCHSTYLE).toBe('45Degree');
    resetBagDefaults('Polygon');
    expect(hasBagDefaults('Polygon')).toBe(false);
  });

  it('a new polygon, dimension, component and coordinate start from them', () => {
    setBagDefaults('Polygon', { ...bagDefaults('Polygon'), HATCHSTYLE: '90Degree', TRACKWIDTH: '12mil' });
    const pb = newPolygonProps('TOP', 0, 'P', 0, true);
    expect(pb.get('HATCHSTYLE')).toBe('90Degree');
    expect(pb.get('TRACKWIDTH')).toBe('12mil');
    setBagDefaults('Dimension', { ...bagDefaults('Dimension'), TEXTHEIGHT: '40mil', TEXTWIDTH: '5mil', ARROWSIZE: '30mil' });
    const d = newDimension({ kind: 1, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mil(500), y: 0 }], at: { x: 0, y: mil(100) }, angle: 0, metric: false }, 0, undefined, true);
    expect(d.bag.get('TEXTHEIGHT')).toBe('40mil');
    expect(d.bag.get('TEXTLINEWIDTH')).toBe('5mil');
    expect(d.bag.get('ARROWSIZE')).toBe('30mil');
    // One read from another tool's file, or the demo board, keeps AD17's values
    expect(newPolygonProps('TOP', 0, 'P', 0).get('HATCHSTYLE')).toBe('Solid');
    expect(newDimension({ kind: 1, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mil(500), y: 0 }], at: { x: 0, y: mil(100) }, angle: 0, metric: false }, 0).bag.get('ARROWSIZE')).not.toBe('30mil');
    setBagDefaults('Component', { ...bagDefaults('Component'), COMMENTON: 'TRUE' });
    const cb = componentBag({ x: 0, y: 0 }, { library: 'L', footprint: { name: 'F', storage: '', description: '', height: '0mil', records: [], prims: [] } }, { designator: 'R1' });
    expect(cb.get('COMMENTON')).toBe('TRUE');
    // A coordinate: its size apart from its text
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const m = coordinateMarker(doc, { x: 0, y: 0 }, 'mil', mil(40), mil(100));
    expect(Math.abs(m.lines[0]!.b.x - m.lines[0]!.a.x)).toBe(mil(100));
  });

  it('Save As / Load carry them with the record defaults', () => {
    setBagDefaults('Coordinate', { ...bagDefaults('Coordinate'), UNITSTYLE: 'Millimeters' });
    const file = exportDefaults();
    resetBagDefaults();
    expect(bagDefaults('Coordinate').UNITSTYLE).toBe('Board');
    expect(importDefaults(file)).toBeGreaterThan(0);
    expect(bagDefaults('Coordinate').UNITSTYLE).toBe('Millimeters');
  });

  it('a via: Solder Mask From The Hole Edge and the assembly testpoints', () => {
    expect(primSrc).not.toMatch(/Not read from the file yet/);
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const v = doc.prims.find((q): q is PcbVia => q.kind === 'via')!;
    const rec = doc.streams.get(v.src.storage)!.records[v.src.index]!;
    setPadExtras(rec, { fromHoleEdge: true }, 'Via');
    expect(padExtrasOf(rec)).toEqual({ fromHoleEdge: true });
    const e = solderMask(doc, v, true);
    const sizes: number[] = [];
    const sink = new Proxy({}, { get: (_t, k) => (k === 'dot' ? (at: { x: number; y: number }, d: number) => { if (at.x === v.at.x && at.y === v.at.y) sizes.push(d); } : () => {}) });
    drawLayer(sink as never, doc, L.TOP_SOLDER, { outlineOnMech1: false, notes: new Set() });
    expect(e).not.toBeNull();
    expect(sizes).toContain(v.hole + 2 * e!);
  });
});
