import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readPcbAscii, writePcbAscii } from '../src/formats/altium/pcbAscii';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoPcbDoc, demoPcbLib, demoSchDoc } from '../src/formats/synthetic/demo';
import { CHECKED_KINDS, connections, runDrc, type DrcViolation } from '../src/model/drc';
import { moveComponent, removeComponents, removePrims } from '../src/model/pcbEdit';
import { mechEnabled } from '../src/model/pcbBoard';
import { pcbProps } from '../src/model/pcbProps';
import { pcbBomItems, wireLinkBomItems, buildBom } from '../src/model/bom';
import { compileProject } from '../src/model/compile';
import { planPcbUpdate, type FootprintFinder } from '../src/model/pcbEco';
import {
  NO_WIRE_LAYER, WIRE_LINK_LAYER, copperAt, isWireLinkComponent, nextWireDesignator, placeWireLink, wireEnd, wireLinkLayer, wireLinkPads, wireLinks, wireStart, type CopperHit,
} from '../src/model/wireLink';
import { buildBoardModel } from '../src/render/gl3d/boardModel';
import { WIRE_COLOURS } from '../src/render/gl3d/wireMesh';
import { newRule, ruleKind } from '../src/formats/altium/rules';
import { UndoStack } from '../src/core/undo';
import { UNITS_PER_MM, mm } from '../src/core/units';
import { settings } from '../src/core/settings';
import { L, isMech, mechLayer } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbText, type PcbTrack } from '../src/model/pcb';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PlaceWireLinkTool } from '../src/editors/pcb/PlaceWireLinkTool';
import type { ToolPointer } from '../src/core/tools';
import { commands } from '../src/core/commands';
import { MENUS } from '../src/app/commands';
import { TOOLBARS } from '../src/app/menus/ad17.gen';
import { iconFor } from '../src/app/Toolbar';
import { PAGES } from '../src/app/settingsSchema';

/**
 * Place › Wire Link (26.148): an insulated wire between two pieces of one net on an outer layer,
 * made as a Jumper component whose two pads share a Jumper ID, its path on a mechanical layer.
 */

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });

/** The demo's +3V3 on Top, U1's side and C2's side: the track between them (y = 44 mm) taken out. */
const A = { x: 19448819, y: 17322835 }, B = { x: 22618110, y: 17322835 };
const BEND = { x: 21033464, y: 18000000 };
const isCut = (p: PcbPrim) => p.kind === 'track' && p.layer === L.TOP && p.a.x === A.x && p.a.y === A.y && p.b.x === B.x && p.b.y === B.y;
function cutBoard(): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  removePrims(doc, doc.prims.filter(isCut)).apply();
  return doc;
}
/** A wire link from a to b through the bends, as the tool makes it (one undo step). */
function link(doc: PcbDocument, a = A, b = B, bends = [BEND], undo = new UndoStack()) {
  const s = wireStart(copperAt(doc, a), L.TOP);
  if ('error' in s) throw new Error(s.error);
  const e = wireEnd(doc, s.hit, copperAt(doc, b));
  if (!e || 'error' in e) throw new Error(e ? e.error : 'no end');
  let out: ReturnType<typeof placeWireLink> | null = null;
  undo.transact('Place Wire Link', (tx) => { out = placeWireLink(doc, { path: [s.hit.at, ...bends, e.end.at], layer: s.hit.layer, net: s.hit.net }); tx.add(out.change); });
  return { ...out!, undo };
}
const owned = (doc: PcbDocument, c: number) => doc.prims.filter((p) => 'component' in p && p.component === c);
const all = new Set(CHECKED_KINDS);
const keyOf = (v: DrcViolation) => `${v.kind}|${v.message}`;

describe('the component a wire link is', () => {
  it('W1: a free Jumper component (WIRE-LINK), Comment "Wire link", Description "Insulated wire, <length> mm", on Top', () => {
    const doc = cutBoard();
    const n = doc.components.length;
    const w = link(doc);
    expect(w.designator).toBe('W1');
    const c = doc.components[n]!;
    expect([c.designator, c.pattern, c.layer, c.bag.int('COMPONENTKIND'), c.bag.get('SOURCEFOOTPRINTLIBRARY'), c.bag.get('SOURCEUNIQUEID')]).toEqual(['W1', 'WIRE-LINK', L.TOP, 6, '', '']);
    expect(isWireLinkComponent(c)).toBe(true);
    // Path along both legs, plus 1 mm down to each pad, to 0.1 mm
    const len = Math.hypot(BEND.x - A.x, BEND.y - A.y) + Math.hypot(B.x - BEND.x, B.y - BEND.y) + 2 * mm(1);
    expect(c.bag.get('SOURCEDESCRIPTION')).toBe(`Insulated wire, ${(Math.round((len / UNITS_PER_MM) * 10) / 10).toFixed(1)} mm`);
    expect(c.bag.get('SOURCEDESCRIPTION')).toBe('Insulated wire, 10.8 mm');
    const texts = owned(doc, n).filter((p): p is PcbText => p.kind === 'text');
    expect(texts.find((t) => t.isComment)?.text).toBe('Wire link');
    expect(texts.find((t) => t.isComment)?.hidden).toBe(true);
    expect(texts.find((t) => t.isDesignator)?.text).toBe('W1');
    // No silk: its strings are on its mechanical layer
    expect(texts.every((t) => isMech(t.layer))).toBe(true);
    // The Properties panel: Type Jumper, designator, comment, description
    const props = new Map(pcbProps({ id: `cmp:${n}`, keys: [], kind: 'Component', component: n }, { doc, units: 'mm', origin: doc.board.origin }).map((p) => [p.name, p.value]));
    expect([props.get('Component Type'), props.get('Designator'), props.get('Comment'), props.get('Description')]).toEqual(['Jumper', 'W1', 'Wire link', 'Insulated wire, 10.8 mm']);
  });

  it('two round 1 mm SMD pads of the net, 1 at the start and 2 at the end, with Jumper ID 1; the path 0.6 mm tracks on "Wire Links"', () => {
    const doc = cutBoard();
    const n = doc.components.length;
    link(doc);
    const pads = owned(doc, n).filter((p): p is PcbPad => p.kind === 'pad');
    const net = doc.nets.findIndex((x) => x.name === '+3V3');
    expect(pads.map((p) => [p.name, p.layer, p.at, p.hole, p.top.shape, p.top.w, p.top.h, p.net, p.jumper])).toEqual([
      ['1', L.TOP, A, 0, 'round', mm(1), mm(1), net, 1], ['2', L.TOP, B, 0, 'round', mm(1), mm(1), net, 1]]);
    const tracks = owned(doc, n).filter((p): p is PcbTrack => p.kind === 'track');
    expect(tracks.map((t) => [t.a, t.b])).toEqual([[A, BEND], [BEND, B]]);
    const ml = tracks[0]!.layer;
    expect(isMech(ml) && tracks.every((t) => t.layer === ml && t.width === mm(0.6) && t.net === NO_NET)).toBe(true);
    // The first mechanical layer the board doesn't use (the demo enables 1 and 13), named and enabled
    expect(ml).toBe(mechLayer(2));
    expect(doc.board.layerNames.get(ml)).toBe(WIRE_LINK_LAYER);
    expect(doc.board.bag!.get(`LAYER${ml}NAME`)).toBe(WIRE_LINK_LAYER);
    expect(mechEnabled(doc)?.has(ml)).toBe(true);
    expect(wireLinkPads(doc)).toEqual(new Set(pads.map((p) => doc.prims.indexOf(p))));
  });

  it('the next is W2 on the same layer; the preferences set pad and wire; one undo step takes it all back, layer name too', () => {
    const doc = cutBoard();
    const undo = new UndoStack();
    link(doc, A, B, [BEND], undo);
    settings.pcbWireLinkPad = 1.5; settings.pcbWireLinkWidth = 0.4;
    const before = { comps: doc.components.length, prims: doc.prims.length, names: new Map(doc.board.layerNames) };
    const w2 = link(doc, A, B, [{ x: BEND.x, y: BEND.y - mm(1) }], undo);
    expect(w2.designator).toBe('W2');
    const two = wireLinks(doc);
    expect(two.map((x) => doc.components[x.comp]!.designator)).toEqual(['W1', 'W2']);
    expect(two[1]!.width).toBe(mm(0.4));
    expect((doc.prims[two[1]!.pads[0]!] as PcbPad).top.w).toBe(mm(1.5));
    const layers = new Set(doc.prims.filter((p) => p.kind === 'track' && isMech(p.layer) && p.component !== NO_NET).map((p) => (p as PcbTrack).layer));
    expect(layers.size).toBe(1);
    expect(undo.undoLabel).toBe('Place Wire Link');
    undo.undo();
    expect([doc.components.length, doc.prims.length]).toEqual([before.comps, before.prims]);
    undo.undo();
    expect(wireLinks(doc)).toEqual([]);
    expect(doc.board.layerNames.get(mechLayer(2))).toBe('Mechanical 2');
    expect(mechEnabled(doc)?.has(mechLayer(2))).toBe(false);
    undo.redo();
    expect(wireLinks(doc).length).toBe(1);
    expect(doc.board.layerNames.get(mechLayer(2))).toBe(WIRE_LINK_LAYER);
    expect(nextWireDesignator(doc)).toBe('W2');
  });

  it('no mechanical layer free: refused, saying why', () => {
    const doc = cutBoard();
    for (let n = 1; n <= 16; n++) doc.board.layerNames.set(mechLayer(n), `Used ${n}`);
    expect(wireLinkLayer(doc)).toBeNull();
    expect(() => placeWireLink(doc, { path: [A, B], layer: L.TOP, net: 2 })).toThrow(NO_WIRE_LAYER);
    // One named Wire Links is taken whatever else is
    doc.board.layerNames.set(mechLayer(9), 'wire links');
    expect(wireLinkLayer(doc)).toEqual({ layer: mechLayer(9), fresh: false });
  });

  it('moving it moves the whole link; deleting it takes the whole link away', () => {
    const doc = cutBoard();
    const n = doc.components.length, k = doc.prims.length;
    link(doc);
    const d = { x: mm(1), y: mm(-2) };
    moveComponent(doc, n, d, 0).apply();
    const w = wireLinks(doc)[0]!;
    expect(w.ends).toEqual([{ x: A.x + d.x, y: A.y + d.y }, { x: B.x + d.x, y: B.y + d.y }]);
    expect(w.segs[0]![1]).toEqual({ x: BEND.x + d.x, y: BEND.y + d.y });
    removeComponents(doc, [n]).apply();
    expect([doc.components.length, doc.prims.length]).toEqual([n, k]);
  });
});

describe('placing it: start, bends and end', () => {
  it('snaps to a track\'s centre line, a pad\'s or via\'s centre; prefers the side asked where the copper is on both', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // Beside the centre line of the VIN track (y = 40.34 mm, 0.6 mm wide)
    const t = doc.prims.find((p) => p.kind === 'track' && p.layer === L.TOP && p.a.y === 15905512 && p.b.y === 15905512 && p.a.x === 12452756) as PcbTrack;
    const on = copperAt(doc, { x: 13000000, y: 15905512 + mm(0.2) });
    expect(on.find((h) => h.layer === L.TOP)).toMatchObject({ at: { x: 13000000, y: 15905512 }, net: t.net });
    // J1's through-hole pad: on both sides, its centre
    const j = doc.prims.find((p) => p.kind === 'pad' && p.layer === L.MULTI) as PcbPad;
    const hits = copperAt(doc, { x: j.at.x + mm(0.3), y: j.at.y });
    expect(hits.map((h) => h.layer).sort((a, b) => a - b)).toEqual([L.TOP, L.BOTTOM]);
    expect(hits.every((h) => h.at.x === j.at.x && h.at.y === j.at.y)).toBe(true);
    const s = wireStart(hits, L.BOTTOM);
    expect('hit' in s && s.hit.layer).toBe(L.BOTTOM);
  });

  it('refuses a start off copper or on copper of no net, an end on another net or the other side; nothing there is a bend', () => {
    const doc = cutBoard();
    expect(wireStart(copperAt(doc, { x: 11000000, y: 19000000 }), L.TOP)).toEqual({ error: 'A wire link starts on copper of a net (a track, pad, via or area) on the top or bottom layer' });
    const noNet: CopperHit = { at: A, layer: L.TOP, net: NO_NET, prim: 0, kind: 'track' };
    expect(wireStart([noNet], L.TOP)).toEqual({ error: 'This copper has no net: a wire link starts on copper of a net' });
    const s = wireStart(copperAt(doc, A), L.TOP);
    if ('error' in s) throw new Error(s.error);
    // A VIN track on Top
    expect(wireEnd(doc, s.hit, copperAt(doc, { x: 13000000, y: 15905512 }))).toEqual({ error: 'A wire link joins copper of one net: this is VIN, the start is +3V3' });
    // From C1's GND pad on Top to a GND track on the bottom
    const g = wireStart(copperAt(doc, { x: 15885827, y: 15905512 }), L.TOP);
    if ('error' in g) throw new Error(g.error);
    expect(wireEnd(doc, g.hit, copperAt(doc, { x: 16535433, y: 13000000 }))).toEqual(
      { error: 'A wire link ends on the side of the board it starts on: this copper is on Bottom Layer, the start on Top Layer' });
    // Nothing there, or only another net's pour on the other side (the demo's bottom GND): a bend
    expect(wireEnd(doc, s.hit, [])).toBeNull();
    expect(copperAt(doc, BEND).map((h) => [h.layer, h.kind])).toEqual([[L.BOTTOM, 'region']]);
    expect(wireEnd(doc, s.hit, copperAt(doc, BEND))).toBeNull();
    expect(wireEnd(doc, s.hit, copperAt(doc, B))).toMatchObject({ end: { at: B, layer: L.TOP } });
  });

  it('the tool: click the start, click bends, click the end; Backspace takes a point back; right-click drops the link, then ends the tool', () => {
    const doc = cutBoard();
    const ed = new PcbEditor(doc);
    const tool = new PlaceWireLinkTool(ed);
    ed.setTool(tool);
    const at = (p: { x: number; y: number }, ctrl = false): ToolPointer => ({ world: p, raw: p, button: 0, shift: false, ctrl, alt: false });
    const n = doc.components.length;
    tool.pointerDown(at({ x: 11000000, y: 19000000 }));
    expect(tool.hint()).toMatch(/^Wire link: click copper of a net/);
    tool.pointerDown(at(A));
    expect(tool.hint()).toMatch(/^Wire link on Top Layer \(\+3V3\)/);
    tool.pointerDown(at({ x: 20000000, y: 18200000 }));
    tool.pointerDown(at(BEND));
    expect(tool.key('Backspace')).toBe(true);
    // Ctrl+click: a bend even over copper (here the start's own track)
    tool.pointerDown(at({ x: A.x, y: A.y - 100000 }, true));
    tool.key('Backspace');
    tool.pointerDown(at(BEND));
    tool.pointerMove(at(BEND));
    expect(tool.overlay()?.segments?.length).toBe(2);
    tool.pointerDown(at(B));
    expect(doc.components.length).toBe(n + 1);
    expect(ed.undo.undoLabel).toBe('Place Wire Link');
    const P1 = { x: 20000000, y: 18200000 };
    expect(wireLinks(doc)[0]!.segs).toEqual([[A, P1], [P1, BEND], [BEND, B]]);
    // Under way, right-click drops it and the tool stays; with nothing under way it ends
    tool.pointerDown(at(A));
    expect(tool.cancel()).toBe(true);
    expect(tool.cancel()).toBe(false);
    expect(doc.components.length).toBe(n + 1);
  });

  it('in the menus as Place › Wire Link (P, I) and on the PCB Wiring toolbar, with a picture of its own', () => {
    expect(commands.get('place.wireLink')?.label).toBe('Wire Link');
    const place = MENUS.find((m) => m.inMenuBar && m.key === 'P' && m.scopes.includes('pcb'))!;
    const item = place.children!.find((c) => c.command === 'place.wireLink')!;
    expect([item.label, item.key]).toEqual(['Wire Link', 'I']);
    expect(place.children!.filter((c) => c.key === 'I').length).toBe(1);
    expect(TOOLBARS['pcb.wiring']![2].some((s) => Array.isArray(s) && s[1] === 'place.wireLink')).toBe(true);
    expect(iconFor('place.wireLink', 'pcb')).toBe('wireLink');
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(['pcbWireLinkPad', 'pcbWireLinkWidth']));
  });
});

describe('connectivity and the design rule check', () => {
  it('the link joins the pieces: the connection line goes', () => {
    const doc = cutBoard();
    const net = doc.nets.findIndex((x) => x.name === '+3V3');
    expect(connections(doc).filter((c) => c.net === net).length).toBe(1);
    link(doc);
    expect(connections(doc).filter((c) => c.net === net)).toEqual([]);
  });

  it('on the demo board: the Un-Routed Net between the pieces goes and nothing new appears, every rule checked', () => {
    const doc = cutBoard();
    // Rules for what a link might trip as well as the board's own
    const have = new Set(doc.rules.map(ruleKind));
    for (const k of ['ComponentClearance', 'NetAntennae', 'SMDNeckDown', 'SMDToCorner', 'SMDEntry', 'ViasUnderSMD', 'AcuteAngle', 'SilkToBoardRegionClearance', 'UnConnectedPin', 'BoardOutlineClearance', 'MinimumSolderMaskSliver', 'SilkToSolderMaskClearance', 'Height'])
      if (!have.has(k)) doc.rules = [...doc.rules, newRule(k, k, 1)];
    const before = runDrc(doc, all).violations;
    // The cut: the net in two pieces, joined between their nearest tracks (26.151: as the suite words it)
    expect(before.filter((v) => v.kind === 'UnRoutedNet').map((v) => v.message)).toEqual([
      'Un-Routed Net Constraint: Net +3V3 Between Track (1261.811mil,732.284mil)(1261.811mil,590.551mil) on Top Layer And Track (944.882mil,614.173mil)(944.882mil,732.284mil) on Top Layer',
    ]);
    link(doc);
    const after = runDrc(doc, all).violations;
    // Joined through the link (the suite, given the demo with its sample region still on +3V3, reported only that region's join)
    expect(after.filter((v) => v.kind === 'UnRoutedNet')).toEqual([]);
    const was = new Set(before.map(keyOf));
    expect(after.filter((v) => v.kind !== 'UnRoutedNet').map(keyOf).filter((k) => !was.has(k))).toEqual([]);
    // Nothing about the link's own objects (W1-1 is only the end nearest the free region)
    const mine = new Set(owned(doc, wireLinks(doc)[0]!.comp).map((p) => doc.prims.indexOf(p)));
    expect(after.filter((v) => v.kind !== 'UnRoutedNet' && v.prims.some((i) => mine.has(i)))).toEqual([]);
  });

  it('a link ending on a via, or on the bottom side, is no Vias Under SMD, SMD or clearance matter', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.rules = [...doc.rules, newRule('ViasUnderSMD', 'ViasUnderSMD', 1), newRule('SMDNeckDown', 'SMDNeckDown', 1)];
    const before = new Set(runDrc(doc, all).violations.map(keyOf));
    // GND: the via at (16535433, 15905512) to the via at (24015748, 15905512), on the bottom
    const v1 = { x: 16535433, y: 15905512 }, v2 = { x: 24015748, y: 15905512 };
    const s = wireStart(copperAt(doc, v1), L.BOTTOM);
    if ('error' in s) throw new Error(s.error);
    expect(s.hit.layer).toBe(L.BOTTOM);
    const e = wireEnd(doc, s.hit, copperAt(doc, v2));
    if (!e || 'error' in e) throw new Error('no end');
    const w = placeWireLink(doc, { path: [s.hit.at, { x: v1.x, y: 18800000 }, { x: v2.x, y: 18800000 }, e.end.at], layer: L.BOTTOM, net: s.hit.net });
    w.change.apply();
    const c = doc.components.at(-1)!;
    expect(c.layer).toBe(L.BOTTOM);
    expect(owned(doc, c.index).filter((p): p is PcbPad => p.kind === 'pad').every((p) => p.layer === L.BOTTOM && p.jumper === 1)).toBe(true);
    expect(owned(doc, c.index).filter((p): p is PcbText => p.kind === 'text').every((t) => t.mirrored)).toBe(true);
    expect(runDrc(doc, all).violations.map(keyOf).filter((k) => !before.has(k))).toEqual([]);
  });
});

describe('saved and opened again', () => {
  const check = (doc: PcbDocument) => {
    const w = wireLinks(doc);
    expect(w.length).toBe(1);
    const c = doc.components[w[0]!.comp]!;
    expect([c.designator, c.pattern, c.bag.int('COMPONENTKIND'), c.bag.get('SOURCEDESCRIPTION')]).toEqual(['W1', 'WIRE-LINK', 6, 'Insulated wire, 10.8 mm']);
    expect(w[0]!.pads.map((i) => (doc.prims[i] as PcbPad).jumper)).toEqual([1, 1]);
    expect(w[0]!.segs).toEqual([[A, BEND], [BEND, B]]);
    expect(doc.board.layerNames.get(mechLayer(2))).toBe(WIRE_LINK_LAYER);
    // Still joined
    const net = doc.nets.findIndex((x) => x.name === '+3V3');
    expect(connections(doc).filter((x) => x.net === net)).toEqual([]);
  };
  it('as a binary PcbDoc', () => {
    const doc = cutBoard();
    link(doc);
    check(readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc'));
  });
  it('as an ASCII PcbDoc', () => {
    const doc = cutBoard();
    link(doc);
    const { bytes } = writePcbAscii(doc);
    expect(new TextDecoder('latin1').decode(bytes)).toMatch(/PADJUMPERID=1/);
    check(readPcbAscii(bytes, 'Demo.PcbDoc'));
  });
});

describe('on screen, in 3D and in the BOM', () => {
  const arcs = (ed: PcbEditor) => {
    ed.invalidate();
    const g = ed.scene().groups.get('connections')!;
    let n = 0;
    for (let i = 0; i < g.prims.count; i++) if (g.prims.f32[i * 10 + 8] === 1) n++;
    return n;
  };
  it('no jumper arc for a wire link (its path shows); a plain jumper keeps its arc', () => {
    const doc = cutBoard();
    link(doc);
    const ed = new PcbEditor(doc);
    expect(arcs(ed)).toBe(0);
    // The same pads without the path: a jumper as any other
    const w = wireLinks(doc)[0]!;
    removePrims(doc, owned(doc, w.comp).filter((p) => p.kind === 'track')).apply();
    expect(arcs(ed)).toBe(1);
  });

  it('in 3D: a dark red wire 1 mm over the top with rounded bends, down to silver solder on its pads', () => {
    const doc = cutBoard();
    link(doc);
    const m = buildBoardModel(doc);
    expect(m.wires?.map((x) => x.colour)).toEqual([WIRE_COLOURS.insulation, WIRE_COLOURS.solder]);
    const z = (k: number) => { const p = m.wires![k]!.pos; let lo = Infinity, hi = -Infinity; for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!); } return [lo, hi]; };
    const [lo, hi] = z(0);
    expect(hi).toBeCloseTo(m.thickness + 1 + 0.3, 3);
    expect(lo).toBeGreaterThan(m.thickness - 1e-3);
    expect(lo).toBeLessThan(m.thickness + 0.4);
    const [slo] = z(1);
    expect(slo).toBeLessThan(m.thickness);
    // The wire's middle over the bend
    const at = { x: (BEND.x - m.centre.x) / UNITS_PER_MM, y: (BEND.y - m.centre.y) / UNITS_PER_MM };
    const p = m.wires![0]!.pos;
    let near = Infinity;
    for (let i = 0; i < p.length; i += 3) near = Math.min(near, Math.hypot(p[i]! - at.x, p[i + 1]! - at.y, p[i + 2]! - (m.thickness + 1)));
    expect(near).toBeCloseTo(0.3, 2);
    // On the bottom: under the board
    const doc2 = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const v1 = { x: 16535433, y: 15905512 }, v2 = { x: 24015748, y: 15905512 };
    placeWireLink(doc2, { path: [v1, { x: v1.x, y: 18800000 }, v2], layer: L.BOTTOM, net: 0 }).change.apply();
    const pos2 = buildBoardModel(doc2).wires![0]!.pos;
    let lo2 = Infinity;
    for (let i = 2; i < pos2.length; i += 3) lo2 = Math.min(lo2, pos2[i]!);
    expect(lo2).toBeCloseTo(-1.3, 3);
  });

  it('the BOM: "Wire link" with its description, from the board alone and added to a project\'s', () => {
    const doc = cutBoard();
    link(doc);
    const own = pcbBomItems(doc).find((x) => x.Designator === 'W1');
    expect(own).toMatchObject({ Comment: 'Wire link', Description: 'Insulated wire, 10.8 mm', Footprint: 'WIRE-LINK' });
    expect(wireLinkBomItems(doc)).toEqual([own]);
    const rows = buildBom(pcbBomItems(doc), { group: ['Comment', 'Footprint'], columns: ['Comment', 'Description', 'Designator', 'Quantity'] });
    expect(rows).toContainEqual(['Wire link', 'Insulated wire, 10.8 mm', 'W1', '1']);
  });

  it('Design › Update PCB leaves it on the board (no schematic part is it)', () => {
    const doc = cutBoard();
    link(doc);
    const lib = readPcbLib(demoPcbLib(), 'Demo.PcbLib');
    const find: FootprintFinder = (p) => { const f = lib.footprints.find((x) => x.name.toLowerCase() === p.toLowerCase()); return f ? { library: lib.name, footprint: f } : undefined; };
    const plan = planPcbUpdate(compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') }]), doc, find);
    expect(plan.filter((p) => p.object.includes('W1'))).toEqual([]);
  });
});

