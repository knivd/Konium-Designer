import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PcbMoveTool } from '../src/editors/pcb/PcbMoveTool';
import { bodyComponent, moveComponent } from '../src/model/pcbEdit';
import { editRegionProps, transformRecord, placement } from '../src/formats/altium/pcbTransform';
import { footprintsFromBoard } from '../src/model/pcbLib';
import { PropertyBag } from '../src/formats/altium/props';
import { PCB_TAG } from '../src/formats/altium/framing';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import type { ToolPointer } from '../src/core/tools';
import type { PcbDocument } from '../src/model/pcb';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const at = (x: number, y: number): ToolPointer => ({ world: P(x, y), raw: P(x, y), button: 0, shift: false, ctrl: false, alt: false });
const C1 = 1;

function setup() {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const ed = new PcbEditor(doc);
  ed.scene();
  return { doc, ed };
}
const owned = (doc: PcbDocument, c: number) => doc.prims.filter((p) => 'component' in p && p.component === c);
const padsOf = (doc: PcbDocument, c: number) => owned(doc, c).filter((p) => p.kind === 'pad') as Extract<PcbDocument['prims'][number], { kind: 'pad' }>[];

/** A ComponentBodies6 record: 18-byte header (component at 7), property block, f64 outline. */
function bodyRecord(component: number, x: number, y: number) {
  const props = PropertyBag.from({ V7_LAYER: 'MECHANICAL13', BODYPROJECTION: 0, STANDOFFHEIGHT: '0mil', OVERALLHEIGHT: '40mil', 'MODEL.2D.X': `${x / 10_000}mil`, 'MODEL.2D.Y': `${y / 10_000}mil`,
    'MODEL.2D.ROTATION': '0.000', 'MODEL.3D.ROTY': '0.000', 'MODEL.MODELTYPE': 0 }).toBytes();
  const pts = [[x - mm(1), y - mm(0.6)], [x + mm(1), y - mm(0.6)], [x + mm(1), y + mm(0.6)], [x - mm(1), y + mm(0.6)]];
  const s = new Uint8Array(18 + 4 + props.length + 4 + pts.length * 16);
  const dv = new DataView(s.buffer);
  s[0] = L.MECH1 + 12; dv.setUint16(7, component, true);
  dv.setUint32(18, props.length, true); s.set(props, 22);
  let o = 22 + props.length;
  dv.setUint32(o, pts.length, true); o += 4;
  for (const [px, py] of pts) { dv.setFloat64(o, px!, true); dv.setFloat64(o + 8, py!, true); o += 16; }
  return { tag: PCB_TAG.MODEL, subs: [s] };
}
const bodyProps = (rec: { subs: Uint8Array[] }) => { let bag: PropertyBag | null = null; editRegionProps(rec.subs[0]!, (b) => { bag = b; }); return bag! as PropertyBag; };

describe('flipping and mirroring on the board', () => {
  it('L while moving a component puts it on the bottom: pads, silk and text change side, mirrored left–right', () => {
    const { doc, ed } = setup();
    const before = padsOf(doc, C1).map((p) => ({ name: p.name, at: p.at }));
    const pivot = doc.components[C1]!.at;
    const tool = new PcbMoveTool(ed, { components: [C1], polygons: [], prims: [] }, pivot, false);
    ed.setTool(tool);
    expect(tool.key('L')).toBe(true);
    tool.pointerMove!({ ...at(0, 0), world: pivot, raw: pivot });
    tool.pointerDown!({ ...at(0, 0), world: pivot, raw: pivot });
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    const c = again.components[C1]!;
    expect(c.layer).toBe(L.BOTTOM);
    expect(c.rotation).toBe(180);
    for (const p of padsOf(again, C1)) {
      const b = before.find((q) => q.name === p.name)!;
      expect(p.layer).toBe(L.BOTTOM);
      // reflected about the reference, which then lands on the grid
      expect(p.at).toEqual({ x: c.at.x + (pivot.x - b.at.x), y: c.at.y + (b.at.y - pivot.y) });
    }
    const texts = owned(again, C1).filter((p) => p.kind === 'text') as Extract<PcbDocument['prims'][number], { kind: 'text' }>[];
    expect(texts.every((t) => t.layer === L.BOTTOM_OVERLAY && t.mirrored)).toBe(true);
    expect(owned(again, C1).filter((p) => p.kind === 'track').every((t) => 'layer' in t && t.layer === L.BOTTOM_OVERLAY)).toBe(true);
    // and one undo puts it back on top
    ed.undo.undo();
    expect(doc.components[C1]!.layer).toBe(L.TOP);
    expect(padsOf(doc, C1).map((p) => ({ name: p.name, at: p.at }))).toEqual(before);
  });

  it('flipping twice gives back the records', () => {
    const { doc } = setup();
    const recs = () => owned(doc, C1).map((p) => doc.streams.get(p.src.storage)!.records[p.src.index]!.subs.map((s) => [...s].join(',')).join('|'));
    const was = recs();
    moveComponent(doc, C1, { x: 0, y: 0 }, 0, { mirror: true, flip: true }).apply();
    expect(recs()).not.toEqual(was);
    moveComponent(doc, C1, { x: 0, y: 0 }, 0, { mirror: true, flip: true }).apply();
    expect(recs()).toEqual(was);
    expect([doc.components[C1]!.layer, doc.components[C1]!.rotation]).toEqual([L.TOP, 0]);
  });

  it('X mirrors a free object; a component asks first and stays on its side', () => {
    const { doc, ed } = setup();
    let asked = 0;
    ed.confirm = (_m, yes) => { asked++; yes(); };
    const pivot = doc.components[C1]!.at;
    const tool = new PcbMoveTool(ed, { components: [C1], polygons: [], prims: [] }, pivot, false);
    ed.setTool(tool);
    tool.key('X');
    tool.pointerDown!({ ...at(0, 0), world: pivot, raw: pivot });
    expect(asked).toBe(1);
    expect(doc.components[C1]!.layer).toBe(L.TOP);
    expect(padsOf(doc, C1).every((p) => p.layer === L.TOP)).toBe(true);
    const p1 = padsOf(doc, C1).find((p) => p.name === '1')!;
    expect(p1.at.x).toBeGreaterThan(pivot.x); // pad 1 was left of the reference
  });

  it('moving a component takes its 3D bodies along; flipping turns them to the other side', () => {
    const { doc } = setup();
    const c = doc.components[C1]!;
    doc.streams.set('ComponentBodies6', { storage: 'ComponentBodies6', records: [bodyRecord(C1, c.at.x, c.at.y), bodyRecord(2, 0, 0)] });
    moveComponent(doc, C1, { x: mm(5), y: mm(1) }, 90).apply();
    const recs = doc.streams.get('ComponentBodies6')!.records;
    expect(recs.map(bodyComponent)).toEqual([C1, 2]);
    const b = bodyProps(recs[0]!);
    // AD turns the model by MODEL.3D.ROTZ and leaves MODEL.2D.ROTATION at 0
    expect([b.get('MODEL.2D.X'), b.get('MODEL.2D.Y'), b.get('MODEL.3D.ROTZ'), b.get('MODEL.2D.ROTATION')]).toEqual([`${(c.at.x + mm(5)) / 10_000}mil`, `${(c.at.y + mm(1)) / 10_000}mil`, '90.000', '0.000']);
    expect(bodyProps(recs[1]!).get('MODEL.2D.X')).toBe('0mil');
    moveComponent(doc, C1, { x: 0, y: 0 }, 0, { mirror: true, flip: true }).apply();
    expect(bodyProps(recs[0]!).get('BODYPROJECTION')).toBe('1');
    // Turned over: half a turn more about Z, ROTY as it was (90 → 270)
    expect([bodyProps(recs[0]!).get('MODEL.3D.ROTY'), bodyProps(recs[0]!).get('MODEL.3D.ROTZ')]).toEqual(['0.000', '270.000']);
    // Underneath, a quarter turn of the board turns the model the other way
    moveComponent(doc, C1, { x: 0, y: 0 }, 90).apply();
    expect(bodyProps(recs[0]!).get('MODEL.3D.ROTZ')).toBe('180.000');
    // the file still reads, with the body storage written
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    expect(again.streams.get('ComponentBodies6')!.records.length).toBe(2);
  });

  it('a shape-based region keeps its integer vertices when it moves', () => {
    const { doc } = setup();
    const rec = doc.streams.get('ShapeBasedRegions6')!.records[0]!;
    const region = doc.prims.find((p) => p.src.storage === 'ShapeBasedRegions6')!;
    const moved = transformRecord(rec, placement({ x: 0, y: 0 }, 0, { x: mm(1), y: 0 }), 0, { storage: 'ShapeBasedRegions6' });
    doc.streams.get('ShapeBasedRegions6')!.records[0] = moved;
    doc.dirty.add('ShapeBasedRegions6');
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    const r2 = again.prims.find((p) => p.src.storage === 'ShapeBasedRegions6')!;
    expect(r2.kind === 'region' && region.kind === 'region' && r2.outline.map((v, i) => v.x - region.outline[i]!.x)).toEqual(region.kind === 'region' ? region.outline.map(() => mm(1)) : []);
  });

  it('Make PCB Library takes a bottom-side part back to the top', () => {
    const { doc } = setup();
    const top = footprintsFromBoard(doc).find((f) => f.name === '0805')!;
    // flip C1 (the first 0805) and turn it, then extract again
    moveComponent(doc, C1, { x: 0, y: 0 }, 90, { mirror: true, flip: true }).apply();
    const fromBottom = footprintsFromBoard(doc).find((f) => f.name === '0805')!;
    const key = (f: typeof top) => f.records.map((r) => r.tag).join(',');
    expect(key(fromBottom)).toBe(key(top));
    const pads = (f: typeof top) => f.records.filter((r) => r.tag === PCB_TAG.PAD).map((r) => [...r.subs[4]!.subarray(0, 25)].join(','));
    expect(pads(fromBottom)).toEqual(pads(top));
  });
});
