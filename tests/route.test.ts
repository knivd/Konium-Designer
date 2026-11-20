import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { settings, updateSettings } from '../src/core/settings';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import { addVias, replaceRules } from '../src/model/pcbEdit';
import { checkCopper, connections, runDrc } from '../src/model/drc';
import { cloneRule, newRule, ruleKind, ruleName } from '../src/formats/altium/rules';
import { reportHtml } from '../src/app/dialogs/Drc';
import type { ToolPointer } from '../src/core/tools';
import type { PcbTrack } from '../src/model/pcb';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const at = (x: number, y: number, button = 0): ToolPointer => ({ world: P(x, y), raw: P(x, y), button, shift: false, ctrl: false, alt: false });
const GND = 0;

function setup() {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const ed = new PcbEditor(doc);
  const rt = new RouteTool(ed);
  ed.setTool(rt);
  return { doc, ed, rt };
}
const tracks = (ed: PcbEditor) => ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track');

// These routes take their width from the Width rule (Track Width Mode: Rule Preferred; the default is User Choice)
beforeEach(() => updateSettings({ pcbTrackWidthMode: 'pref' }));
afterEach(() => updateSettings({ pcbRoutingMode: 'stop', pcbAutoTerminate: true, pcbGlossRouted: 'weak', pcbRemoveLoops: true, pcbTrackWidthMode: 'user' }));

describe('interactive routing', () => {
  it('shows the connection still to make, from the end of the route to the nearest pad it has to reach', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // The +3V3 run from U1 to C2 taken out: a connection to make
    doc.prims = doc.prims.filter((p) => !(p.kind === 'track' && p.net === 2 && p.polygon === 0xffff));
    const ed = new PcbEditor(doc), rt = new RouteTool(ed);
    ed.setTool(rt);
    const c = connections(doc)[0]!;
    expect(c).toBeTruthy();
    rt.pointerDown({ world: c.a, raw: c.a, button: 0, shift: false, ctrl: false, alt: false });
    expect(rt.active).toBe(true);
    const mid = { x: (c.a.x + c.b.x) / 2, y: c.a.y };
    rt.pointerMove({ world: mid, raw: mid, button: 0, shift: false, ctrl: false, alt: false });
    const line = rt.overlay()!.segments!.find((s) => s.width === 0);
    expect(line).toBeTruthy();
    expect(line!.b).toEqual(c.b);
    void ed;
  });

  it('takes net, layer and width from the start pad and its Width rule', () => {
    const { ed, rt } = setup();
    rt.pointerDown(at(21.7, 9.4));            // U1-1, GND, top
    expect(rt.active).toBe(true);
    expect(rt.netLabel).toBe('GND');
    expect(ed.currentLayer).toBe(L.TOP);
    expect(ed.trackWidth).toBe(mil(20));      // demo Width rule: preferred 20 mil
  });

  it('Stop At First Obstacle ends the look-ahead short of another net', () => {
    const { ed, rt } = setup();
    const before = tracks(ed).length;
    rt.pointerDown(at(21.7, 9.4));
    rt.pointerMove(at(21.7, 5));              // straight through the VIN track at y = 7.2
    rt.pointerDown(at(21.7, 5));
    rt.cancel();                              // right-click: finish the route
    const added = tracks(ed).slice(before);
    expect(added).toHaveLength(1);
    const t = added[0]!;
    expect(t.net).toBe(GND);
    // VIN is in the Power class: edge at 7.2 + 0.3 mm, Clearance_Power 12 mil, half of 20 mil → 8.059 mm
    const endY = (t.b.y - O) / mm(1);
    expect(endY).toBeGreaterThan(8.05);
    expect(endY).toBeLessThan(8.07);
  });

  it('Ignore Obstacles places through and reports the violation', () => {
    updateSettings({ pcbRoutingMode: 'ignore' });
    const { rt } = setup();
    rt.pointerDown(at(21.7, 9.4));
    rt.pointerMove(at(21.7, 5));
    const ov = rt.overlay()!;
    expect(ov.circles!.length).toBeGreaterThan(0); // violation marker on the look-ahead
    expect(settings.pcbRoutingMode).toBe('ignore');
  });

  it('reaching a pad or via of the net terminates the route; * adds a via', () => {
    const { ed, rt } = setup();
    const t0 = tracks(ed).length, v0 = ed.doc.prims.filter((p) => p.kind === 'via').length;
    rt.pointerDown(at(14.95, 15));            // C1-2, GND
    rt.pointerMove(at(14.95, 16.5));
    rt.pointerDown(at(14.95, 16.5));
    rt.key('*');                              // via, bottom layer
    expect(ed.currentLayer).toBe(L.BOTTOM);
    rt.pointerMove(at(16.6, 16.5));
    rt.pointerDown(at(16.6, 16.5));
    rt.pointerMove(at(16.6, 15));             // the GND via at (16.6, 15)
    rt.pointerDown(at(16.6, 15));
    expect(rt.active).toBe(false);
    expect(tracks(ed).length).toBe(t0 + 3);
    expect(ed.doc.prims.filter((p) => p.kind === 'via').length).toBe(v0 + 1);
    // one undo step for the whole route
    ed.undo.undo();
    expect(tracks(ed).length).toBe(t0);
    // and it round-trips through the file
    ed.undo.redo();
    const again = readPcbDoc(writePcbDoc(ed.doc), 'Demo.PcbDoc');
    expect(again.prims.filter((p) => p.kind === 'track').length).toBe(t0 + 3);
  });
});

describe('routing conflict modes', () => {
  const clearanceCount = (ed: PcbEditor) => runDrc(ed.doc, new Set(['Clearance', 'ShortCircuit'])).violations.length;
  it('Walkaround Obstacles goes round a via of another net, clear, to the cursor', () => {
    updateSettings({ pcbRoutingMode: 'walkaround' });
    const { ed, rt } = setup();
    ed.undo.transact('via', (tx) => tx.add(addVias(ed.doc, [{ at: P(19.5, 14), diameter: mil(24), hole: mil(12), net: 1 }])));
    const before = clearanceCount(ed), t0 = tracks(ed).length;
    rt.pointerDown(at(14.95, 15));           // C1-2, GND
    rt.pointerMove(at(20.5, 13));
    const look = (rt as unknown as { look: { segs: { a: { x: number; y: number }; b: { x: number; y: number }; width: number; layer: number }[]; blocked: boolean } }).look;
    expect(look.blocked).toBe(false);
    expect(look.segs.at(-1)!.b).toEqual(P(20.5, 13));
    // Not the straight-then-45° way, which runs through the via
    expect(look.segs[0]!.b).not.toEqual(P(18.55, 15));
    rt.key('1');                             // look-ahead off: commit it all
    rt.pointerDown(at(20.5, 13));
    rt.cancel();
    expect(tracks(ed).length).toBeGreaterThanOrEqual(t0 + 2);
    expect(clearanceCount(ed)).toBe(before);
  });
  it('Walkaround Obstacles stops as near as it gets when the way is shut', () => {
    updateSettings({ pcbRoutingMode: 'walkaround' });
    const { ed, rt } = setup();
    rt.pointerDown(at(21.7, 9.4));
    rt.pointerMove(at(21.7, 5));             // behind the VIN track, which runs pad to pad
    const look = (rt as unknown as { look: { segs: { a: { x: number; y: number }; b: { x: number; y: number }; width: number; layer: number; net?: number }[] } }).look;
    expect(look.segs.length).toBeGreaterThan(0);
    expect(checkCopper(ed.doc, look.segs.map((t) => ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net ?? 0xffff, component: 0xffff, polygon: 0xffff, locked: false, keepout: false })), { ignorePours: true, clearanceOnly: true })).toEqual([]);
  });
  it('Push Obstacles moves the free +3V3 track aside; one undo step takes it all back', () => {
    updateSettings({ pcbRoutingMode: 'push' });
    const { ed, rt } = setup();
    const before = clearanceCount(ed), t0 = tracks(ed).length, links = connections(ed.doc).length;
    rt.pointerDown(at(35.6, 15));            // the GND via right of C2
    rt.key('1');
    rt.pointerMove(at(35.6, 19.3)); rt.pointerDown(at(35.6, 19.3));
    rt.pointerMove(at(26, 19.3)); rt.pointerDown(at(26, 19.3));
    rt.cancel();
    // The +3V3 run along y = 18.6 now bends down out of the way, still pad to pad
    const v33 = tracks(ed).filter((t) => t.net === 2);
    expect(v33.length).toBeGreaterThan(4);
    expect(v33.some((t) => Math.min(t.a.y, t.b.y) < P(0, 18.6).y - mil(2))).toBe(true);
    expect(connections(ed.doc).length).toBe(links);
    expect(clearanceCount(ed)).toBe(before);
    ed.undo.undo();
    expect(tracks(ed).length).toBe(t0);
  });
  it('Automatically Remove Loops: a re-route between the same two pads takes the old track out', () => {
    updateSettings({ pcbRoutingMode: 'walkaround' });
    const { ed, rt } = setup();
    const gndAt = (y: number) => tracks(ed).filter((t) => t.net === GND && t.layer === L.TOP && t.a.x === P(21.7, 0).x && t.b.x === P(21.7, 0).x && Math.min(t.a.y, t.b.y) <= P(0, y).y && Math.max(t.a.y, t.b.y) >= P(0, y).y);
    expect(gndAt(10.5)).toHaveLength(1);    // U1-1 down to the GND via at (21.7, 11.5)
    rt.key('1');
    rt.pointerDown(at(21.7, 9.4));
    rt.pointerMove(at(20.2, 10.5)); rt.pointerDown(at(20.2, 10.5));
    rt.pointerMove(at(21.7, 11.5)); rt.pointerDown(at(21.7, 11.5));   // the via: the route ends
    expect(rt.active).toBe(false);
    expect(gndAt(10.5)).toHaveLength(0);
    ed.undo.undo();
    expect(gndAt(10.5)).toHaveLength(1);
  });
  it('Shift+R cycles the modes ticked in Preferences', () => {
    updateSettings({ pcbRoutingMode: 'walkaround', pcbModeStop: true, pcbModeHug: false });
    const { rt } = setup();
    rt.key('Shift+R'); expect(settings.pcbRoutingMode).toBe('stop');
    rt.key('Shift+R'); expect(settings.pcbRoutingMode).toBe('autoroute');
    rt.key('Shift+R'); expect(settings.pcbRoutingMode).toBe('autorouteMulti');
    rt.key('Shift+R'); expect(settings.pcbRoutingMode).toBe('ignore');
    updateSettings({ pcbModeHug: true });
  });
});

describe('online DRC', () => {
  it('marks violations of edited objects only, and keeps batch results until reset', () => {
    updateSettings({ pcbRoutingMode: 'ignore' });
    const { ed, rt } = setup();
    ed.onlineDrc();
    expect(ed.violations).toEqual([]);
    rt.pointerDown(at(21.7, 9.4));
    rt.pointerMove(at(21.7, 5));
    rt.pointerDown(at(21.7, 5));
    rt.cancel();
    ed.onlineDrc();
    expect(ed.violations.map((v) => v.kind)).toContain('ShortCircuit');
    ed.undo.undo();
    ed.onlineDrc();
    expect(ed.violations).toEqual([]);
    const r = ed.runBatchDrc(new Set(['Clearance', 'UnRoutedNet']));
    // Only the demo's own free +3V3 region and arc (pieces of the net, 26.151)
    expect(r.violations.filter((v) => !/Pad U1-4\(|Arc \(1181\.102mil/.test(v.message))).toEqual([]);
    ed.resetErrorMarkers();
    expect(ed.violations).toEqual([]);
  });
});

describe('rules editing', () => {
  it('replacing rules is undoable and saved', () => {
    const { doc, ed } = setup();
    const next = doc.rules.map(cloneRule);
    const r = newRule('Clearance', 'Clearance_1', 1);
    r.bag.set('SCOPE1EXPRESSION', "InNet('GND')");
    r.bag.set('GAP', '20mil');
    next.push(r);
    ed.undo.transact('Edit Design Rules', (tx) => tx.add(replaceRules(doc, next)));
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(again.rules.map(ruleName)).toContain('Clearance_1');
    ed.undo.undo();
    expect(doc.rules.map(ruleName)).not.toContain('Clearance_1');
    expect(doc.dirty.has('Rules6')).toBe(false);
  });

  it('writes the DRC report with rule descriptions and counts', () => {
    const { doc } = setup();
    const html = reportHtml('Demo.PcbDoc', doc.rules, new Set(['Clearance']), {
      violations: [{ kind: 'Clearance', rule: 'Clearance', message: 'Clearance Constraint: (Collision < 10mil) Between A And B', prims: [], at: { x: 0, y: 0 }, error: true }],
      notes: [], stats: { shapes: 0, pairs: 0, rules: 0, ms: 3 },
    }, 3, new Date(2026, 9, 24, 10, 0, 0));
    expect(html).toContain('Design Rule Verification Report');
    expect(html).toContain('Clearance Constraint (Gap=10mil) (All),(All)');
    expect(html).toContain('<td class="n">1</td>');
    expect(doc.rules.some((x) => ruleKind(x) === 'Clearance')).toBe(true);
  });
});
