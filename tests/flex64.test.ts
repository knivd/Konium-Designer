import { describe, expect, it } from 'vitest';
import {
  addRegion, addSplit, boardRegions, isAdvanced, moveRegionVertex, polyArea, readSubstacks, removeRegion, setAdvancedMode, setRigidFlex,
  setRigidFlexMode, sliceRegion, splitLines, withRegion,
} from '../src/model/rigidFlex';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { setBoardShape } from '../src/model/pcbBoard';
import { COVERLAY0, addCoverlay, deleteStackLayer, readStack, setStack, type StackLayer } from '../src/model/pcbStack';
import { coverlayAreas, coverlayLayers, customCoverlayShapes, underCoverlay } from '../src/model/coverlay';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { gerberX2Files } from '../src/formats/gerber/gerberX2';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import type { Vec2 } from '../src/core/geom';
import type { PcbDocument, PcbPrim } from '../src/model/pcb';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const area = (p: Vec2[]) => Math.abs(polyArea(p));
const FLEX = '{11111111-2222-4333-8444-666666666666}';

/** A 3000 × 1000 mil board, cut in three at 1000 and 2000 mil; the middle on a flex stack with a top coverlay (expansion 20 mil). */
function flexBoard(expansion = mil(20)): { doc: PcbDocument; middle: number } {
  const doc = readPcbDoc(newPcbDocBytes('F.PcbDoc'), 'F.PcbDoc');
  setBoardShape(doc, rect(0, 0, mil(3000), mil(1000)).map((p) => ({ p }))).apply();
  const subs = readSubstacks(doc.board.bag);
  const flex = { ...subs[0]!, id: FLEX, name: 'Flex', isFlex: true, usedByPrims: false };
  const rows0 = readStack(doc.board.bag!, doc.board.copperStack).map((r) => ({ ...r, subs: { ...r.subs, [FLEX]: r.kind === 'dielectric' || r.name === 'Top Layer' || r.name === 'Bottom Layer' } }));
  const top = rows0.findIndex((r) => r.name === 'Top Layer');
  const { rows } = addCoverlay(rows0, top, true, [subs[0]!, flex]);
  const at = rows.findIndex((r) => r.kind === 'coverlay');
  rows[at] = { ...rows[at]!, coverlay: expansion };
  setStack(doc, rows, undefined, [subs[0]!, flex]).apply();
  setRigidFlex(doc, addSplit(doc, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(1000) })!).apply();
  setRigidFlex(doc, addSplit(doc, { x: mil(2000), y: 0 }, { x: mil(2000), y: mil(1000) })!).apply();
  const middle = boardRegions(doc).findIndex((r) => r.outline.every((p) => p.x >= mil(1000) - 1 && p.x <= mil(2000) + 1));
  setRigidFlex(doc, withRegion(doc, middle, { stackId: FLEX })).apply();
  return { doc, middle };
}

let vn = 0;
const via = (at: Vec2): PcbPrim => ({ kind: 'via', src: { storage: 'Vias6', index: vn++ }, at, diameter: mil(24), hole: mil(12), layerStart: L.TOP, layerEnd: L.BOTTOM, net: -1, locked: false }) as PcbPrim;

describe('rigid-flex: coverlay layers', () => {
  it('Insert Coverlay: a polyimide layer named for its face, in the flex stacks only; saved and read back with its expansion; deleted again', () => {
    const { doc } = flexBoard();
    const rows = readStack(doc.board.bag!, doc.board.copperStack);
    const c = rows.find((r) => r.kind === 'coverlay')!;
    expect(c).toBeTruthy();
    expect(c.name).toBe('Top Coverlay');
    expect(c.v7).toBe(COVERLAY0 + 1);
    expect(c.layer).toBeNull();
    expect(c.dielMaterial).toBe('Polyimide');
    expect(c.height).toBe(mil(1));
    expect(c.coverlay).toBe(mil(20));
    expect(c.subs?.[FLEX]).toBe(true);
    expect(c.subs?.[readSubstacks(doc.board.bag)[0]!.id]).toBe(false);
    // Through the file
    const back = readPcbDoc(writePcbDoc(doc), 'F.PcbDoc');
    const c2 = readStack(back.board.bag!, back.board.copperStack).find((r) => r.kind === 'coverlay')!;
    expect(c2).toMatchObject({ name: 'Top Coverlay', v7: COVERLAY0 + 1, coverlay: mil(20), dielMaterial: 'Polyimide' });
    expect(c2.subs?.[FLEX]).toBe(true);
    expect(coverlayLayers(back).map((x) => [x.row.name, x.side, x.n])).toEqual([['Top Coverlay', 'top', 1]]);
    // A second one under the bottom copper: the bottom's
    const bot = rows.findIndex((r) => r.name === 'Bottom Layer');
    const two = addCoverlay(rows, bot, false, readSubstacks(doc.board.bag).map((s) => ({ id: s.id, isFlex: s.isFlex }))).rows;
    expect(two.filter((r) => r.kind === 'coverlay').map((r) => r.name)).toEqual(['Top Coverlay', 'Bottom Coverlay']);
    const gone = deleteStackLayer(two, two.findIndex((r) => r.name === 'Top Coverlay')) as StackLayer[];
    expect(gone.filter((r) => r.kind === 'coverlay').map((r) => r.name)).toEqual(['Bottom Coverlay']);
  });

  it('automatic coverlay: the flex region grown by its expansion, within the board; rigid regions none', () => {
    const { doc } = flexBoard();
    const [c] = coverlayLayers(doc);
    const areas = coverlayAreas(doc, c!);
    expect(areas.length).toBe(1);
    expect(areas[0]!.outlines.length).toBe(1);
    // 1000 + 2·20 mil long, the board's 1000 mil high (the growth past its edges cut off)
    expect(area(areas[0]!.outlines[0]!) / mil(1) ** 2).toBeCloseTo(1040 * 1000, -2);
    expect(underCoverlay(areas, { x: mil(1500), y: mil(500) })).toBe(true);
    expect(underCoverlay(areas, { x: mil(1010), y: mil(500) })).toBe(true);
    expect(underCoverlay(areas, { x: mil(900), y: mil(500) })).toBe(false);
  });

  it('Custom Coverlays: the shapes start as the automatic ones; a cutout leaves a hole; saved in the region record', () => {
    const { doc, middle } = flexBoard(0);
    const r = boardRegions(doc)[middle]!;
    const [c] = coverlayLayers(doc);
    const shapes = customCoverlayShapes(doc, r);
    expect(shapes.length).toBe(1);
    expect(shapes[0]!.layer).toBe(c!.row.v7);
    const cut = { layer: c!.row.v7, outline: rect(mil(1400), mil(400), mil(1600), mil(600)), cutout: true };
    setRigidFlex(doc, withRegion(doc, middle, { customCoverlay: true, coverlays: [...shapes, cut] })).apply();
    const areas = coverlayAreas(doc, c!);
    expect(areas[0]!.cutouts.length).toBe(1);
    expect(underCoverlay(areas, { x: mil(1500), y: mil(500) })).toBe(false);
    expect(underCoverlay(areas, { x: mil(1200), y: mil(500) })).toBe(true);
    const back = readPcbDoc(writePcbDoc(doc), 'F.PcbDoc');
    const r2 = boardRegions(back).find((x) => x.stackId === FLEX)!;
    expect(r2.customCoverlay).toBe(true);
    expect(r2.coverlays?.length).toBe(2);
    expect(r2.coverlays?.filter((s) => s.cutout).length).toBe(1);
    expect(area(r2.coverlays!.find((s) => s.cutout)!.outline)).toBeCloseTo(mil(200) ** 2, -4);
    expect(underCoverlay(coverlayAreas(back, coverlayLayers(back)[0]!), { x: mil(1500), y: mil(500) })).toBe(false);
  });

  it('Gerber: a GCL file per coverlay (its outline, the openings for vias under it at the mask expansion); X2 the same with its file function', () => {
    const { doc } = flexBoard(0);
    doc.prims.push(via({ x: mil(1500), y: mil(500) }), via({ x: mil(500), y: mil(500) }));
    const { files } = gerberFiles(doc, defaultGerberSetup(doc));
    const gcl = files.find((f) => /\.GCL1$/.test(f.name))!;
    expect(gcl).toBeTruthy();
    expect(gcl.text).toMatch(/Top Coverlay \(coverlay, top\)/);
    // One flash: the via under it (the rigid region's not)
    expect((gcl.text.match(/D03\*/g) ?? []).length).toBe(1);
    expect(gcl.text).toMatch(/D02\*/);
    expect(files.find((f) => /EXTREP|\.EXTREP$/i.test(f.name))?.text ?? '').toMatch(/GCL1/);
    const x2 = gerberX2Files(doc, defaultGerberSetup(doc)).files.find((f) => /Coverlay_Top\.gbr$/.test(f.name))!;
    expect(x2).toBeTruthy();
    expect(x2.text).toMatch(/%TF\.FileFunction,Other,Coverlay Top\*%/);
    // A board with no coverlay: none
    const plain = readPcbDoc(newPcbDocBytes('P.PcbDoc'), 'P.PcbDoc');
    expect(gerberFiles(plain, defaultGerberSetup(plain)).files.some((f) => /\.GCL\d+$/.test(f.name))).toBe(false);
  });
});

describe('rigid-flex: Advanced mode', () => {
  it('to Advanced and back: the regions kept, split lines gone and found again; the mode in Board6 and read back', () => {
    const { doc } = flexBoard();
    const before = boardRegions(doc).map((r) => [r.name, r.stackId, Math.round(area(r.outline) / 1e8)]);
    const adv = setAdvancedMode(doc, true);
    expect(typeof adv).toBe('object');
    setRigidFlexMode(doc, adv as Exclude<typeof adv, string>).apply();
    expect(isAdvanced(doc)).toBe(true);
    expect(splitLines(doc).length).toBe(2);   // (worked out from the regions still)
    expect(doc.flex!.splits).toEqual([]);
    expect(doc.board.bag!.get('RIGIDFLEXMODE')).toBe('ADVANCED');
    const back = readPcbDoc(writePcbDoc(doc), 'F.PcbDoc');
    expect(isAdvanced(back)).toBe(true);
    expect(boardRegions(back).map((r) => [r.name, r.stackId, Math.round(area(r.outline) / 1e8)]).sort()).toEqual([...before].sort());
    const std = setAdvancedMode(back, false);
    expect(typeof std).toBe('object');
    setRigidFlexMode(back, std as Exclude<typeof std, string>).apply();
    expect(isAdvanced(back)).toBe(false);
    expect(back.board.bag!.has('RIGIDFLEXMODE')).toBe(false);
    expect(back.flex!.splits.length).toBe(2);
    expect(boardRegions(back).map((r) => [r.name, r.stackId, Math.round(area(r.outline) / 1e8)]).sort()).toEqual([...before].sort());
  });

  it('Place Board Region, Slice, vertex moves, Delete; overlapping regions can\'t go back to Standard; 3D by priority', async () => {
    const { doc } = flexBoard();
    setRigidFlexMode(doc, setAdvancedMode(doc, true) as never).apply();
    // A region over the others, above them in priority
    setRigidFlex(doc, addRegion(doc, rect(mil(1800), mil(200), mil(2200), mil(800)))).apply();
    let regs = boardRegions(doc);
    expect(regs.length).toBe(4);
    expect(regs[3]!.priority).toBe(1);
    expect(regs[3]!.name).toBe('Layer Stack Region 4');
    expect(setAdvancedMode(doc, false)).toMatch(/overlap/);
    // Sliced across its middle: two regions, the stack kept
    const first = regs.findIndex((r) => r.outline.every((p) => p.x <= mil(1000) + 1));
    setRigidFlex(doc, sliceRegion(doc, first, { x: mil(400), y: 0 }, { x: mil(400), y: mil(1000) })!).apply();
    regs = boardRegions(doc);
    expect(regs.length).toBe(5);
    expect(regs[first]!.stackId).toBe(regs[4]!.stackId);
    expect(Math.round(area(regs[first]!.outline) / mil(1) ** 2)).toBe(600 * 1000);
    expect(Math.round(area(regs[4]!.outline) / mil(1) ** 2)).toBe(400 * 1000);
    expect(sliceRegion(doc, first, { x: mil(-100), y: mil(-100) }, { x: mil(-50), y: mil(-100) })).toBeNull();
    // A vertex dragged
    const v = regs[3]!.outline.findIndex((p) => p.x === mil(2200) && p.y === mil(800));
    setRigidFlex(doc, moveRegionVertex(doc, 3, v, { x: mil(2400), y: mil(800) })!).apply();
    expect(boardRegions(doc)[3]!.outline[v]).toEqual({ x: mil(2400), y: mil(800) });
    // Deleted; the last one stays
    setRigidFlex(doc, removeRegion(doc, 3) as never).apply();
    expect(boardRegions(doc).length).toBe(4);
    const one = { ...doc, flex: { regions: [boardRegions(doc)[0]!], splits: [], fixed: [rect(0, 0, mil(3000), mil(1000))], advanced: true } } as PcbDocument;
    expect(removeRegion(one, 0)).toMatch(/at least one/);
    // 3D: a rigid region of higher priority over the flex one hides the bare flex beneath it
    const { bareRegions } = await import('../src/render/gl3d/boardTexture');
    const { outlineArea } = await import('../src/model/outlineOps');
    const flexIdx = boardRegions(doc).findIndex((r) => r.stackId === FLEX);
    const bare0 = bareRegions(doc, 'top').find((x) => x.index === flexIdx)!;
    expect(bare0.shape).toBeUndefined();
    setRigidFlex(doc, addRegion(doc, rect(mil(1200), mil(-100), mil(1400), mil(1100)))).apply();
    const bare1 = bareRegions(doc, 'top').find((x) => x.index === flexIdx)!;
    expect(bare1.shape!.reduce((t, o) => t + outlineArea(o), 0) / mil(1) ** 2).toBeCloseTo(800 * 1000, -3);
    setRigidFlex(doc, removeRegion(doc, boardRegions(doc).length - 1) as never).apply();
    // …and one wholly inside it: a hole in the bare flex (filled even-odd)
    setRigidFlex(doc, addRegion(doc, rect(mil(1200), mil(300), mil(1400), mil(500)))).apply();
    const bare2 = bareRegions(doc, 'top').find((x) => x.index === flexIdx)!;
    expect(bare2.shape!.length).toBe(2);
    expect((outlineArea(bare2.shape![0]!) - outlineArea(bare2.shape![1]!)) / mil(1) ** 2).toBeCloseTo(1000 * 1000 - 200 * 200, -3);
    setRigidFlex(doc, removeRegion(doc, boardRegions(doc).length - 1) as never).apply();
    // Saved and read back with the priority
    setRigidFlex(doc, addRegion(doc, rect(mil(100), mil(100), mil(300), mil(300)))).apply();
    const back = readPcbDoc(writePcbDoc(doc), 'F.PcbDoc');
    expect(boardRegions(back).length).toBe(5);
    expect(boardRegions(back).at(-1)!.priority).toBe(1);
  });
});
