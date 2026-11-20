import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { readDrill } from '../src/formats/gerber/gerberRead';
import { camLayerFrom, newCamDocument } from '../src/formats/cam/camDoc';
import { writeDrillLayer } from '../src/formats/cam/camWrite';
import { CamEditor } from '../src/editors/cam/CamEditor';

const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const g = gerberFiles(doc, defaultGerberSetup(doc)).files;
const layer = (ext: string) => camLayerFrom(`Demo${ext}`, g.find((f) => f.name.endsWith(ext))!.text)!;

describe('26.067: the CAM review fixes', () => {
  it('a selection follows its layer when the stack is reordered or a layer goes', () => {
    const top = layer('.GTL'), bottom = layer('.GBL');
    const d = newCamDocument('C.Cam', [top, bottom]);
    const ed = new CamEditor(d);
    ed.scene();
    ed.selection = new Set([ed.keyOf(bottom, 0)]);
    const at = d.layers.indexOf(bottom);
    expect(ed.selectedObjects().map((s) => [s.layer.name, s.li, s.i])).toEqual([['Demo.GBL', at, 0]]);
    d.layers.reverse();
    expect(ed.selectedObjects().map((s) => [s.layer.name, s.li, s.i])).toEqual([['Demo.GBL', 1 - at, 0]]);
    expect(ed.properties()[0]!.rows[0]!.value).toContain('Demo.GBL');
    d.layers = [top];
    expect(ed.selectedObjects()).toEqual([]);
    expect(ed.properties()).toEqual([]);
    // an index past the layer's objects (a key from before a reload) is left out, not a crash
    d.layers = [top, bottom];
    ed.selection = new Set([ed.keyOf(top, 1e6)]);
    expect(ed.selectedObjects()).toEqual([]);
  });

  it('Erase, the stack reordered, Undo: each layer gets back its own erased objects', () => {
    const top = layer('.GTL'), bottom = layer('.GBL');
    const d = newCamDocument('C.Cam', [top, bottom]);
    const ed = new CamEditor(d);
    ed.scene();
    top.erased = [5];
    ed.selection = new Set([ed.keyOf(bottom, 1), ed.keyOf(bottom, 2)]);
    ed.deleteSelection();
    expect([top.erased, bottom.erased]).toEqual([[5], [1, 2]]);
    d.layers.reverse();
    ed.undo.undo();
    expect([top.erased, bottom.erased]).toEqual([[5], undefined]);
    ed.undo.redo();
    expect([top.erased, bottom.erased]).toEqual([[5], [1, 2]]);
  });

  it('a drill layer written after an Erase keeps its routed paths (M15 / M16)', () => {
    const text = 'M48\nMETRIC,LZ,000.000\nT01C0.800\nT02C2.000\n%\nG90\nG05\nT01\nX1.000Y1.000\nX2.000Y1.000\nX3.000Y1.000\n'
      + 'T02\nG00X0.000Y0.000\nM15\nG01X10.000Y0.000\nG01X10.000Y5.000\nM16\nG05\nM30\n';
    const l = camLayerFrom('Demo.TXT', text)!;
    expect(l.data.kind).toBe('drill');
    if (l.data.kind !== 'drill') return;
    expect(l.data.routes).toHaveLength(1);
    l.erased = [1];
    const back = readDrill(writeDrillLayer(l));
    expect(back.hits.map((h) => h.at.x / 1e4)).toEqual([l.data.hits[0]!.at.x / 1e4, l.data.hits[2]!.at.x / 1e4]);
    expect(back.routes.map((r) => [r.tool, r.path.length])).toEqual([[2, 3]]);
    expect(back.routes[0]!.path.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual(l.data.routes[0]!.path.map((p) => [Math.round(p.x), Math.round(p.y)]));
    expect(back.tools.get(2)).toBe(l.data.tools.get(2));
  });
});
