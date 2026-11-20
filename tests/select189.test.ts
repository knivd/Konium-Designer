/**
 * Selecting on a board (26.189): a component's pad and its component are both offered where a
 * click could take either, what was chosen stays the one a press on it takes, a component with
 * Lock Primitives off gives its primitives first and itself by its area, and the Selection Filter
 * says which kinds a click or a selection box takes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { SELECTION_KINDS, selectAllKinds, selectionOff, selects, setSelects } from '../src/editors/pcb/selectionFilter';
import { settings, DEFAULTS } from '../src/core/settings';
import type { ToolPointer } from '../src/core/tools';
import type { PcbPad } from '../src/model/pcb';

const editor = () => { const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc')); ed.scene(); return ed; };
const at = (raw: { x: number; y: number }, shift = false): ToolPointer => ({ world: raw, raw, button: 0, shift, ctrl: false, alt: false });
const key = (p: { src: { storage: string; index: number } }) => `${p.src.storage}:${p.src.index}`;
/** C1's first pad: a track of VIN ends on it. */
const c1 = (ed: PcbEditor) => {
  const comp = ed.doc.components.find((c) => c.designator === 'C1')!;
  const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.component === comp.index && p.name === '1')!;
  return { comp, pad };
};
afterEach(() => { selectAllKinds(true); Object.assign(settings, DEFAULTS); });

describe('what a click could take (26.189)', () => {
  it('a pad of a component: the component first, then the pad itself, then what else is there; tracks told apart by their lengths', () => {
    const ed = editor(), { comp, pad } = c1(ed);
    const units = ed.unitsAt(pad.at);
    expect(units.map((u) => u.label.replace(/, [\d.]+mil long$/, ', N long'))).toEqual(['Component C1', 'Pad C1-1 (VIN) on Top Layer', 'Track (VIN) on Top Layer, N long', 'Track (VIN) on Top Layer, N long']);
    expect(new Set(units.map((u) => u.label)).size).toBe(4);
    expect(units[0]!.keys.sort()).toEqual(ed.componentKeys(comp.index).sort());
    expect(units[1]!.keys).toEqual([key(pad)]);
  });

  it('with Lock Primitives off the primitive is first and the component after it', () => {
    const ed = editor(), { comp, pad } = c1(ed);
    expect(ed.primsLocked(comp.index)).toBe(true);
    comp.bag.set('PRIMITIVELOCK', 'FALSE');
    expect(ed.primsLocked(comp.index)).toBe(false);
    expect(ed.unitsAt(pad.at).slice(0, 2).map((u) => u.label)).toEqual(['Pad C1-1 (VIN) on Top Layer', 'Component C1']);
  });

  it('a press takes the first; what is selected already stays the one, where the press is on it', () => {
    const ed = editor(), { comp, pad } = c1(ed);
    ed.pointerDown(at(pad.at)); ed.pointerUp(at(pad.at), false); ed.cancelChoice();
    expect([...ed.selection].sort()).toEqual(ed.componentKeys(comp.index).sort());
    // The pad chosen (as from the popup): a press on it keeps it, and so does the next
    ed.select([key(pad)]);
    ed.pointerDown(at(pad.at)); ed.pointerUp(at(pad.at), false); ed.cancelChoice();
    expect([...ed.selection]).toEqual([key(pad)]);
    // A track chosen there likewise
    const track = ed.unitsAt(pad.at)[2]!;
    ed.select(track.keys);
    ed.pointerDown(at(pad.at)); ed.pointerUp(at(pad.at), false); ed.cancelChoice();
    expect([...ed.selection]).toEqual(track.keys);
    // Shift takes the first in or out as before
    ed.select([]);
    ed.pointerDown(at(pad.at, true));
    expect([...ed.selection].sort()).toEqual(ed.componentKeys(comp.index).sort());
  });

  it('a double-click opens what the click took: the pad chosen on its own, else the component', () => {
    const ed = editor(), { pad } = c1(ed);
    const opened: string[] = [];
    ed.editObject = (k) => { opened.push(k); };
    ed.select([key(pad)]);
    ed.doubleClick(at(pad.at));
    expect(opened).toEqual([key(pad)]);
  });

  it('a click in a component\'s area where none of its primitives is takes the component', () => {
    const ed = editor();
    // A place inside some component's area with nothing of it (nor anything else but a pour) under it
    let found: { c: number; spot: { x: number; y: number } } | null = null;
    for (const comp of ed.doc.components) {
      const ps = ed.doc.prims.filter((p) => 'component' in p && p.component === comp.index && p.kind === 'pad') as PcbPad[];
      if (ps.length < 2 || found) continue;
      const x0 = Math.min(...ps.map((p) => p.at.x)), x1 = Math.max(...ps.map((p) => p.at.x)), y0 = Math.min(...ps.map((p) => p.at.y)), y1 = Math.max(...ps.map((p) => p.at.y));
      for (let i = 1; i < 12 && !found; i++) for (let j = 0; j <= 12 && !found; j++) {
        const spot = { x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * j) / 12 - (y1 === y0 ? 150_000 - j * 25_000 : 0) };
        if (!ed.hits(spot).some((h) => !h.key.startsWith('poly:')) && ed.componentAround(spot) === comp.index) found = { c: comp.index, spot };
      }
    }
    expect(found).not.toBeNull();
    const { c, spot } = found!;
    expect(ed.unitsAt(spot).map((u) => u.label)).toEqual([`Component ${ed.doc.components[c]!.designator}`]);
    expect(ed.componentAround({ x: -50_000_000, y: -50_000_000 })).toBe(-1);
    ed.pointerDown(at(spot));
    expect([...ed.selection].sort()).toEqual(ed.componentKeys(c).sort());
    // With Components off it is the pour under it or nothing, as anywhere else
    setSelects('Components', false);
    expect(ed.unitsAt(spot).every((u) => u.keys[0]!.startsWith('poly:'))).toBe(true);
  });

  it('what wants Shift, alone under a plain click, is not taken (it was, through the plain select tool)', () => {
    const ed = editor(), { pad } = c1(ed);
    settings.pcbShiftClickSelect = true; settings.pcbShiftClickKinds = ['Component', 'Pad', 'Track', 'Polygon'];
    ed.select([]);
    ed.pointerDown(at(pad.at));
    expect(ed.selection.size).toBe(0);
    ed.pointerDown(at(pad.at, true));
    expect(ed.selection.size).toBeGreaterThan(0);
  });
});

describe('the Selection Filter (26.189)', () => {
  it('every kind is on to begin with; All turns them all off or on', () => {
    expect(SELECTION_KINDS).toEqual(['Components', '3D Bodies', 'Keepouts', 'Tracks', 'Arcs', 'Pads', 'Vias', 'Regions', 'Polygons', 'Fills', 'Texts', 'Rooms', 'Other']);
    expect(SELECTION_KINDS.every(selects)).toBe(true);
    selectAllKinds(false);
    expect(SELECTION_KINDS.some(selects)).toBe(false);
    setSelects('Pads', true);
    expect([...SELECTION_KINDS].filter(selects)).toEqual(['Pads']);
    selectAllKinds(true);
    expect(selectionOff.value.size).toBe(0);
  });

  it('a kind that is off is passed over by a click: with Components off a pad is itself, with Pads off too the track under it', () => {
    const ed = editor(), { pad } = c1(ed);
    setSelects('Components', false);
    expect(ed.unitsAt(pad.at).map((u) => u.label.replace(/, .*$/, ''))).toEqual(['Pad C1-1 (VIN) on Top Layer', 'Track (VIN) on Top Layer', 'Track (VIN) on Top Layer']);
    ed.pointerDown(at(pad.at));
    expect([...ed.selection]).toEqual([key(pad)]);
    setSelects('Pads', false);
    expect(ed.unitsAt(pad.at).map((u) => u.label.replace(/, .*$/, ''))).toEqual(['Track (VIN) on Top Layer', 'Track (VIN) on Top Layer']);
    setSelects('Tracks', false); setSelects('Polygons', false);
    expect(ed.unitsAt(pad.at)).toEqual([]);
    // Nothing is taken, and the status line says why
    const said: string[] = [];
    ed.status = (m) => said.push(m);
    ed.select([]);
    ed.pointerDown(at(pad.at));
    expect(ed.selection.size).toBe(0);
    expect(said.join(' ')).toMatch(/^(Components|Pads|Tracks|Polygons)(, (Components|Pads|Tracks|Polygons))* are off in the Selection Filter \(the Inspector, with nothing selected\)$/);
  });

  it('a selection box leaves the kinds that are off out; with Components off, pads come one by one', () => {
    const ed = editor(), { comp } = c1(ed);
    const everything = ed.allKeys();
    const kinds = (keys: string[]) => [...new Set(keys.map((k) => ed.filterKind(k)))].sort();
    expect(kinds(ed.normaliseSelection(everything, true))).toContain('Tracks');
    setSelects('Tracks', false); setSelects('Polygons', false);
    const noTracks = ed.normaliseSelection(everything, true);
    // (a component's own outline tracks come with it)
    expect(noTracks.filter((k) => { const p = ed.primByKey(k); return p?.kind === 'track' && p.component === 0xffff; })).toEqual([]);
    expect(noTracks.some((k) => k.startsWith('poly:'))).toBe(false);
    expect(ed.componentKeys(comp.index).every((k) => noTracks.includes(k))).toBe(true);
    selectAllKinds(true); setSelects('Components', false);
    const pads = ed.normaliseSelection(everything, true).filter((k) => { const p = ed.primByKey(k); return !!p && 'component' in p && p.component === comp.index; });
    expect(pads.map((k) => ed.primByKey(k)!.kind).sort()).toEqual(['pad', 'pad', 'text'].slice(0, pads.length).sort());
    expect(pads.filter((k) => ed.primByKey(k)!.kind === 'pad')).toHaveLength(2);
  });
});

describe('primitives of a component selected on their own (26.189)', () => {
  it('move with their component while it locks them; on their own with Lock Primitives off; the whole selected is the component either way', () => {
    const ed = editor(), { comp, pad } = c1(ed);
    expect(ed.moveSet([key(pad)])).toMatchObject({ components: [comp.index], prims: [] });
    comp.bag.set('PRIMITIVELOCK', 'FALSE');
    const alone = ed.moveSet([key(pad)]);
    expect(alone.components).toEqual([]);
    expect(alone.prims.map(key)).toEqual([key(pad)]);
    expect(ed.moveSet(ed.componentKeys(comp.index))).toMatchObject({ components: [comp.index], prims: [] });
  });
});
