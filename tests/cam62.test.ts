import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { gerberX2Files } from '../src/formats/gerber/gerberX2';
import { defaultDrillSetup, drillFiles, holes } from '../src/formats/gerber/drill';
import { UNITS_PER_MM, readDrill, readGerber, sniffCamFile } from '../src/formats/gerber/gerberRead';
import { camExtent, camLayerFrom, isCamText, newCamDocument, readCam, writeCam } from '../src/formats/cam/camDoc';
import { writeCamLayer } from '../src/formats/cam/camWrite';
import { CamEditor, flashShapes } from '../src/editors/cam/CamEditor';
import { load, save } from '../src/formats/registry';
import { mil } from '../src/core/units';

const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const g = gerberFiles(doc, defaultGerberSetup(doc)).files;
const file = (n: string) => g.find((f) => f.name.endsWith(n))!;
const near = (a: number, b: number, tol = 100) => Math.abs(a - b) <= tol; // board units (1/10000 mil); format 2:5 rounds to 0.01 mil

describe('Gerber and Excellon read back', () => {
  it('Konium\'s own Gerbers: layer types by extension, apertures, draws, flashes, regions; X2 by .FileFunction', () => {
    const types = g.map((f) => camLayerFrom(f.name, f.text)?.type ?? null);
    expect(types.filter(Boolean)).toEqual(['Top', 'Bottom', 'Top Silk', 'Bottom Silk', 'Top Paste', 'Bottom Paste', 'Top Mask', 'Bottom Mask', 'Mechanical']);
    const top = readGerber(file('.GTL').text);
    expect([top.units, top.apertures.get(10)!.shape, top.objects.filter((o) => o.kind === 'flash').length]).toEqual(['in', 'C', 13]);
    // Every top pad flashed where the board has it (relative to the board origin)
    const o = doc.board.origin;
    const pads = doc.prims.filter((p) => p.kind === 'pad' && (p.layer === 1 || p.layer === 74));
    const flashes = top.objects.filter((x) => x.kind === 'flash');
    for (const p of pads) expect(flashes.some((f) => f.kind === 'flash' && near(f.at.x, (p as { at: { x: number } }).at.x - o.x) && near(f.at.y, (p as { at: { y: number } }).at.y - o.y)), `pad at ${JSON.stringify((p as { at: unknown }).at)}`).toBe(true);
    expect(top.objects.some((x) => x.kind === 'region')).toBe(true);
    expect(top.objects.some((x) => x.kind === 'arc')).toBe(true);
    const x2 = gerberX2Files(doc, defaultGerberSetup(doc)).files;
    expect(x2.map((f) => camLayerFrom(f.name, f.text)?.type).filter(Boolean).slice(0, 3)).toEqual(['Top', 'Bottom', 'Top Silk']);
  });

  it('the drill file: tools and every hole', () => {
    const d = readDrill(drillFiles(doc, defaultDrillSetup())[0]!.text);
    const o = doc.board.origin;
    expect(d.hits.length).toBe(holes(doc).length);
    for (const h of holes(doc)) expect(d.hits.some((x) => near(x.at.x, h.at.x - o.x) && near(x.at.y, h.at.y - o.y) && near(d.tools.get(x.tool)!, h.size, 200))).toBe(true);
  });

  it('RS-274X\'s other features: macros (thermal, outline, polygon), clear polarity, step and repeat, single-quadrant arcs, trailing zeros', () => {
    const text = `%FSTAX24Y24*%%MOMM*%
%AMTHERM*7,0,0,1.0,0.6,0.2,45*%
%AMOUT*4,1,3,0,0,1,0,1,1,0,0,0*%
%AMPOLY*5,1,6,0,0,$1,0*%
%ADD10C,0.2*%%ADD11THERM*%%ADD12OUT*%%ADD13POLY,2.0*%%ADD14R,1X0.5*%
%SRX3Y2I5.0J4.0*%
D10*X0Y0D02*X1Y0D01*
%SR*%
%LPC*%D11*X2Y2D03*%LPD*%
D12*X3Y3D03*D13*X4Y4D03*D14*X5Y5D03*
G74*G02X01Y01I005J005D01*
M02*`;
    expect(sniffCamFile(text)).toBe('gerber');
    const l = readGerber(text);
    expect(l.units).toBe('mm');
    expect(l.objects.filter((o) => o.kind === 'draw').length).toBe(6); // 3 × 2 copies
    const draws = l.objects.filter((o) => o.kind === 'draw') as { a: { x: number; y: number } }[];
    expect(draws.map((d) => Math.round(d.a.x / UNITS_PER_MM)).sort((a, b) => a - b)).toEqual([0, 0, 5, 5, 10, 10]);
    const clear = l.objects.find((o) => o.kind === 'flash' && !o.dark)!;
    expect(clear.kind === 'flash' && clear.at.x / UNITS_PER_MM).toBe(20); // trailing zeros left out: X2 is 20.0000
    const therm = l.apertures.get(11)!;
    expect(therm.shapes!.filter((s) => !s.dark).length).toBe(3); // the inner hole and two gaps
    expect(l.apertures.get(12)!.shapes![0]!.poly.length).toBe(3);
    expect(l.apertures.get(13)!.shapes![0]!.poly.length).toBe(6);
    expect(Math.round(l.apertures.get(13)!.w / UNITS_PER_MM * 100) / 100).toBe(2);
    // trailing zeros left out (FST): X1 is 10.0000 mm in format 2.4
    const first = l.objects.find((o) => o.kind === 'draw')!;
    expect(first.kind === 'draw' && first.b.x / UNITS_PER_MM).toBe(10);
    const arc = l.objects.find((o) => o.kind === 'arc')!;
    expect(arc.kind === 'arc' && Math.round(Math.hypot(arc.a.x - arc.c.x, arc.a.y - arc.c.y) / UNITS_PER_MM * 1000)).toBe(707);
    expect(flashShapes(l.apertures.get(14)!, { x: 0, y: 0 }, 90)[0]!.poly.map((p) => [Math.round(p.x / UNITS_PER_MM * 100), Math.round(p.y / UNITS_PER_MM * 100)])).toEqual([[25, -50], [25, 50], [-25, 50], [-25, -50]]);
  });

  it('Excellon variants: KiCad\'s METRIC with decimals, INCH,TZ, G85 slots, routed paths', () => {
    const kicad = 'M48\n; DRILL file {KiCad 8}\nFMAT,2\nMETRIC\nT1C0.300\nT2C1.000\n%\nG90\nG05\nT1\nX10.5Y-20.25\nX11.0Y-20.25\nT2\nX0.0Y0.0G85X2.0Y0.0\nM30\n';
    const d = readDrill(kicad);
    expect([d.units, d.hits.length, d.hits[0]!.at.x / UNITS_PER_MM, d.hits[2]!.slot!.x / UNITS_PER_MM, d.tools.get(2)! / UNITS_PER_MM]).toEqual(['mm', 3, 10.5, 2, 1]);
    const tz = readDrill('M48\nINCH,TZ\nT01C0.035\n%\nT01\nX150Y250\nG00X0Y0\nM15\nG01X10000Y0\nM16\nM30\n');
    expect(tz.hits[0]!.at.x).toBe(mil(15));
    expect(tz.routes.length).toBe(1);
  });
});

describe('The CAM document', () => {
  it('.Cam (Konium\'s own JSON) keeps layers, types, colours, shown and erased objects; opens through the registry', () => {
    const layers = [...g.slice(0, 3), drillFiles(doc, defaultDrillSetup())[0]!].map((f) => camLayerFrom(f.name, f.text)!);
    const d = newCamDocument('CAM1.Cam', layers);
    d.layers[1]!.visible = false; d.layers[0]!.colour = '#123456'; d.layers[0]!.erased = [2];
    const text = writeCam(d);
    expect(isCamText(text)).toBe(true);
    const back = readCam(text, 'CAM1.Cam');
    expect(back.layers.map((l) => [l.name, l.type, l.visible, l.colour === '#123456'])).toEqual(d.layers.map((l) => [l.name, l.type, l.visible, l.colour === '#123456']));
    // Erased objects are left out of the layer's file when the document is saved
    const n0 = d.layers[0]!.data.kind === 'gerber' ? d.layers[0]!.data.objects.length : 0;
    expect(back.layers[0]!.data.kind === 'gerber' && back.layers[0]!.data.objects.length).toBe(n0 - 1);
    expect(back.layers[0]!.erased).toBeUndefined();
    const via = load(new TextEncoder().encode(text), 'CAM1.Cam');
    expect(via.kind).toBe('CamDoc');
    expect(new TextDecoder().decode(save(via))).toBe(text);
    expect(camExtent(d)).not.toBeNull();
  });

  it('the editor: every object an item to pick, Erase as one undo, Export writes what is left (and the file unchanged when nothing is erased)', () => {
    const top = camLayerFrom('Demo.GTL', file('.GTL').text)!;
    const d = newCamDocument('C.Cam', [top]);
    const ed = new CamEditor(d);
    ed.scene();
    const n = top.data.kind === 'gerber' ? top.data.objects.length : 0;
    const flash = top.data.kind === 'gerber' ? top.data.objects.findIndex((o) => o.kind === 'flash') : -1;
    expect(writeCamLayer(d.layers[0]!)).toBe(top.text);
    const at = top.data.kind === 'gerber' && top.data.objects[flash]!.kind === 'flash' ? top.data.objects[flash].at : { x: 0, y: 0 };
    const hit = ed.hits(at)[0]!;
    expect(hit.key).toBe(ed.keyOf(top, flash));
    ed.selection = new Set([hit.key]);
    expect(ed.properties()[0]!.rows.some((r) => r.label === 'D-Code')).toBe(true);
    ed.deleteSelection();
    expect(d.layers[0]!.erased!.length).toBe(1);
    const again = readGerber(writeCamLayer(d.layers[0]!));
    expect(again.objects.length).toBe(n - 1);
    ed.undo.undo();
    expect(d.layers[0]!.erased).toBeUndefined();
  });
});
