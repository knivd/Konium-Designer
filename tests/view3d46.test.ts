import { describe, expect, it } from 'vitest';
import { VIEW3D_DEFAULT, VIEW3D_PRESETS, baseOpacity, hexRgb, sideLook, view3dFrom, view3dName, workspaceEnds } from '../src/core/view3d';
import { TRANSPARENCY_STANDARD, sanitise, transparencyFrom } from '../src/core/settings';
import { L, transparencyKey } from '../src/model/layers';
import { cfbPut, newEntry } from '../src/formats/cfb/cfb';
import { linkedModels } from '../src/render/gl3d/stepBodies';
import { modelFileName } from '../src/platform/modelFolders';

const near = (a: string, b: string, tol: number) => hexRgb(a).every((v, i) => Math.abs(v - hexRgb(b)[i]!) <= tol);

describe('3D view configuration', () => {
  it('the default paints as earlier builds did (dark green mask, lighter over copper)', () => {
    const t = sideLook(VIEW3D_DEFAULT, 'top');
    expect(near(t.laminate, '#0d4f2c', 6)).toBe(true);
    expect(near(t.copper, '#2f7a3a', 14)).toBe(true);
    expect(t.finish).toBe('#d6ae4f');
    expect(t.silk).toBe('#f2f2ec');
    expect(baseOpacity(VIEW3D_DEFAULT, 'top')).toBe(1);
  });

  it('a hidden mask shows the core; a see-through core and no mask let light through', () => {
    const v = { ...VIEW3D_DEFAULT, maskTopShow: false, coreOpacity: 40 };
    expect(sideLook(v, 'top').laminate).toBe(v.core);
    expect(baseOpacity(v, 'top')).toBeCloseTo(0.4);
    expect(baseOpacity(v, 'bottom')).toBeCloseTo(1 - 0.6 * 0.08);
    expect(sideLook({ ...v, silkTopShow: false }, 'top').silk).toBeNull();
  });

  it('by layer: the layers\' own colours', () => {
    const l = sideLook({ ...VIEW3D_DEFAULT, colouring: 'layers' }, 'bottom', { copper: '#0000ff', mask: '#ff00ff', silk: '#ffff00', board: '#123456' });
    expect(l).toMatchObject({ laminate: '#ff00ff', copper: '#0000ff', finish: '#0000ff', silk: '#ffff00' });
  });

  it('settings from a file or an earlier build are filled in and kept in range', () => {
    const v = view3dFrom({ maskTop: 'red', coreOpacity: 250, zScale: 0, projection: 'fish-eye', simpleBodies: 'maybe', gradient: -400, axes: true, extra: 1 });
    expect(v.maskTop).toBe(VIEW3D_DEFAULT.maskTop);
    expect(v.coreOpacity).toBe(100);
    expect(v.zScale).toBe(1);
    expect(v.projection).toBe('perspective');
    expect(v.simpleBodies).toBe('system');
    expect(v.gradient).toBe(-100);
    expect(v.axes).toBe(true);
    expect('extra' in v).toBe(false);
    const s = sanitise({ pcb3d: { maskTop: '#8c1010' }, pcbTransparency: { signal: 40, nope: 3, plane: 500 } });
    expect(s.pcb3d.maskTop).toBe('#8c1010');
    expect(s.pcb3d.silkTop).toBe(VIEW3D_DEFAULT.silkTop);
    expect(s.pcbTransparency).toEqual({ ...TRANSPARENCY_STANDARD, signal: 40, plane: 90 });
    expect(transparencyFrom(null).bodies).toBe(55);
  });

  it('the configurations by name; a changed one says so', () => {
    expect(VIEW3D_PRESETS.map((p) => p.config)).toEqual(['3D Black', '3D Blue', '3D Brown', '3D Dk Green', '3D Lt Grey', '3D White']);
    expect(view3dName(VIEW3D_DEFAULT)).toBe('3D Dk Green');
    expect(view3dName({ ...VIEW3D_DEFAULT, axes: true })).toBe('3D Dk Green (changed)');
    expect(view3dName({ ...VIEW3D_DEFAULT, config: '' })).toBe('Custom');
    const [top, bottom] = workspaceEnds({ ...VIEW3D_DEFAULT, gradient: 50 });
    expect(top[0]).toBeGreaterThan(bottom[0]);
  });

  it('each layer has its transparency slider', () => {
    expect([L.TOP, L.MID1 + 3, L.PLANE1, L.MECH1 + 4, L.TOP_OVERLAY, L.BOTTOM_PASTE, L.TOP_SOLDER, L.DRILL_GUIDE, L.KEEPOUT, L.DRILL_DRAWING, L.MULTI].map(transparencyKey))
      .toEqual(['signal', 'signal', 'plane', 'mech', 'overlay', 'paste', 'solder', 'drillGuide', 'keepout', 'drillDrawing', 'multi']);
  });
});

describe('linked STEP models', () => {
  const rec = (text: string) => { const b = new TextEncoder().encode(`${text}\0`); const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length, true); o.set(b, 4); return o; };
  it('ModelsNoEmbed lists them by id with their paths', () => {
    const root = newEntry('Root Entry', 'root');
    const a = rec('|EMBED=FALSE|MODELSOURCE=FromFile|ID={ab-12}|NAME=C:\\Models\\Conn.STEP|CHECKSUM=1|'), b = rec('|ID={CD-34}|NAME=part.stp|');
    const data = new Uint8Array(a.length + b.length); data.set(a); data.set(b, a.length);
    cfbPut(root, 'ModelsNoEmbed/Data', data);
    const m = linkedModels(root);
    expect([...m]).toEqual([['{AB-12}', 'C:\\Models\\Conn.STEP'], ['{CD-34}', 'part.stp']]);
    expect(linkedModels(newEntry('Root Entry', 'root')).size).toBe(0);
  });
  it('a linked model is looked for by its file name', () => {
    expect(modelFileName('C:\\Models\\Conn.STEP')).toBe('conn.step');
    expect(modelFileName('/home/me/models/Part.stp ')).toBe('part.stp');
    expect(modelFileName('Box.step')).toBe('box.step');
  });
});

describe('generic STEP bodies', async () => {
  const { readPcbDoc, writePcbDoc } = await import('../src/formats/altium/pcbdoc');
  const { newPcbDocBytes } = await import('../src/formats/altium/newBoard');
  const { addPrimRecords } = await import('../src/model/pcbEdit');
  const { defaultBody } = await import('../src/model/bodies');
  const { genericBodyRecord, modelEntry, modelFootprint, compressModel, turn } = await import('../src/model/genericBody');
  const { embeddedModels, stepBodies } = await import('../src/render/gl3d/stepBodies');
  const { UNITS_PER_MM } = await import('../src/core/units');
  const step = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
  const model = { meshes: [{ pos: new Float32Array([-1, -2, 0, 3, -2, 0, 3, 2, 1.5, -1, 2, 1.5]), nrm: new Float32Array(12), idx: new Uint32Array([0, 1, 2, 0, 2, 3]), colour: [1, 1, 1, 1] as [number, number, number, number] }], min: [-1, -2, 0], max: [3, 2, 1.5], faces: 1, failed: 0 } as never;

  it('turns as AD places a model (X, then Y, then Z)', () => {
    const v = turn([1, 0, 0], [0, 0, 90]);
    expect(v[0]).toBeCloseTo(0); expect(v[1]).toBeCloseTo(1);
    const w = turn([0, 1, 0], [90, 0, 0]);
    expect(w[2]).toBeCloseTo(1);
  });

  it('an embedded model goes into Models with its listing; the body names it; saved and read back', async () => {
    const doc = readPcbDoc(newPcbDocBytes('B.PcbDoc'), 'B.PcbDoc');
    const spec = { ...defaultBody(), type: 'generic' as const, rot: [0, 0, 90] as [number, number, number], standoff: Math.round(0.5 * UNITS_PER_MM), model: { name: 'Box.step', bytes: step, link: false } };
    const fp = modelFootprint(model, spec.rot);
    expect(fp.minZ).toBeCloseTo(0); expect(fp.maxZ).toBeCloseTo(1.5);
    const entry = modelEntry(doc.cfb.root, '', spec.model, spec.rot, spec.standoff, await compressModel(step));
    const rec = genericBodyRecord(spec, spec.model, { x: 10_000_000, y: 20_000_000 }, fp, entry.id);
    entry.change!.apply();
    addPrimRecords(doc, [{ storage: 'ComponentBodies6', rec }]).apply();
    const back = readPcbDoc(writePcbDoc(doc), 'B.PcbDoc');
    const files = embeddedModels(back.cfb.root);
    expect(files.get(entry.id.toUpperCase())?.name).toBe('Box.step');
    const b = stepBodies(back)[0]!;
    expect(b.name).toBe('Box.step');
    expect(b.modelId).toBe(entry.id.toUpperCase());
    expect(b.rot).toEqual([0, 0, 90]);
    expect(b.dz).toBeCloseTo(0.5, 3);
    expect(b.overall).toBeCloseTo(2, 2);
    // Used again for a second body of the same model
    expect(modelEntry(doc.cfb.root, '', spec.model, spec.rot, 0).change).toBeNull();
    // Undone: the listing and the file go
    entry.change!.revert();
    expect(embeddedModels(doc.cfb.root).size).toBe(0);
  });

  it('a linked model is listed in ModelsNoEmbed, not carried', () => {
    const doc = readPcbDoc(newPcbDocBytes('B.PcbDoc'), 'B.PcbDoc');
    const e = modelEntry(doc.cfb.root, '', { name: 'Conn.STEP', bytes: step, link: true }, [0, 0, 0], 0);
    e.change!.apply();
    expect(linkedModels(doc.cfb.root).get(e.id.toUpperCase())).toBe('Conn.STEP');
    expect(embeddedModels(doc.cfb.root).size).toBe(0);
  });
});
