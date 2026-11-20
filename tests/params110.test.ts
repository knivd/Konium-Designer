import { describe, expect, it } from 'vitest';
import directiveSrc from '../src/app/dialogs/Directive.tsx?raw';
import componentSrc from '../src/app/dialogs/SchComponent.tsx?raw';
import differencesSrc from '../src/app/dialogs/Differences.tsx?raw';
import impedanceSrc from '../src/app/dialogs/Impedance.tsx?raw';
import placePartSrc from '../src/app/dialogs/PlacePart.tsx?raw';
import placeCompSrc from '../src/app/dialogs/PlaceComponent.tsx?raw';
import pcbModelSrc from '../src/app/dialogs/PcbModel.tsx?raw';
import drcSrc from '../src/app/dialogs/Drc.tsx?raw';
import outputsSrc from '../src/app/dialogs/Outputs.tsx?raw';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc, demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { SR, bagOf } from '../src/model/sch';
import { carriedRules, ruleFromParameter, ruleParameterValue, ruleSummary } from '../src/model/schRules';
import { itemChange, planPcbUpdate } from '../src/model/pcbEco';
import { compareProject, sheetDifferences } from '../src/model/comparator';
import { partSource } from '../src/model/schUpdate';
import { runDrc } from '../src/model/drc';
import { drawLayer } from '../src/formats/gerber/gerber';
import { removePrims } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { rulePriority, ruleKind } from '../src/formats/altium/rules';
import type { PcbTrack } from '../src/model/pcb';

const WIDTH = ruleParameterValue({ RULEKIND: 'Width', MINLIMIT: '8mil', PREFEREDWIDTH: '12mil', MAXLIMIT: '20mil' });

/** A sheet: a wire named N1 by a net label, a Parameter Set on it carrying a Width rule. */
function ruleSheet() {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  b.wire([100, 100], [300, 100]);
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'N1' }, { LOCATION: { x: 150, y: 100 } });
  const d = b.add({ RECORD: SR.PARAMETER_SET, OWNERPARTID: -1, NAME: 'Parameter Set' }, { LOCATION: { x: 200, y: 100 } });
  b.add({ RECORD: SR.PARAMETER, OWNERINDEX: d, OWNERPARTID: -1, NAME: 'Rule', TEXT: WIDTH, DESCRIPTION: ruleSummary(WIDTH) }, { LOCATION: { x: 200, y: 100 } });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name: 'Rules.SchDoc', doc: readSchDoc(writeCfb(root), 'Rules.SchDoc') };
}

describe('Dialogs once greyed: Add as Rule, library links, Find, 3D, Sub-Net Details, mid-layer pads (26.110)', () => {
  it('none of these dialogs has a control marked as not built', () => {
    for (const src of [directiveSrc, componentSrc, differencesSrc, impedanceSrc, placePartSrc, placeCompSrc, pcbModelSrc, drcSrc, outputsSrc]) {
      expect(src).not.toMatch(/not in Konium yet|isn't in Konium yet|aren't in Konium yet|comes later|isn't in this dialog yet/i);
    }
  });

  it('a rule as a parameter: its properties, its summary, back again', () => {
    expect(WIDTH).toBe('RULEKIND{}Width[]MINLIMIT{}8mil[]PREFEREDWIDTH{}12mil[]MAXLIMIT{}20mil');
    expect(ruleFromParameter(WIDTH).get('PREFEREDWIDTH')).toBe('12mil');
    expect(ruleSummary(WIDTH)).toMatch(/^Width Constraint \[.*Pref Width = 12mil/);
  });

  it('a Parameter Set\'s rule goes with its net; Update PCB Document adds it, scoped to the net, first of its kind', () => {
    const project = compileProject([ruleSheet()]);
    const n1 = project.nets.find((n) => n.name === 'N1')!;
    expect(n1.rules).toEqual([WIDTH]);
    expect(carriedRules(project).map((r) => r.scope)).toEqual(["InNet('N1')"]);
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const plan = planPcbUpdate(project, doc, () => undefined);
    const add = plan.find((p) => p.kind === 'addRule')!;
    expect(add).toMatchObject({ group: 'Add Rules', scope: "InNet('N1')" });
    itemChange(doc, add, () => undefined).apply();
    const r = doc.rules.find((x) => x.bag.get('SCOPE1EXPRESSION') === "InNet('N1')")!;
    expect(ruleKind(r)).toBe('Width');
    expect(rulePriority(r)).toBe(1);
    expect(r.bag.get('PREFEREDWIDTH')).toBe('12mil');
    // Once on the board, it isn't added again
    expect(planPcbUpdate(project, doc, () => undefined).some((p) => p.kind === 'addRule')).toBe(false);
  });

  it('Library Name unticked: the part is looked for in any library', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const c = doc.objects.find((o) => o.kind === 'component')!;
    bagOf(doc, c)!.set('SOURCELIBRARYNAME', 'Mine.SchLib');
    expect(partSource(doc, c.index)!.library).toBe('Mine.SchLib');
    bagOf(doc, c)!.set('USELIBRARYNAME', 'F');
    expect(partSource(doc, c.index)!.library).toBe('');
  });

  it('Advanced Mode: one schematic\'s differences with the board', () => {
    const sch = { name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') };
    const other = ruleSheet();
    const project = compileProject([sch, other]);
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const all = compareProject(project, doc, () => undefined);
    const mine = sheetDifferences(all, project, 'Rules.SchDoc');
    expect(mine.length).toBeLessThanOrEqual(all.length);
    expect(mine.every((d) => !d.toPcb || d.toPcb.kind === 'addNet' || d.toPcb.kind === 'addPin' || d.toPcb.kind === 'removePin')).toBe(true);
  });

  it('DRC: an un-routed net\'s violation lists its sub-nets', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const t = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net !== 0xffff)!;
    removePrims(doc, doc.prims.filter((p) => p.kind === 'track' && p.net === t.net)).apply();
    const v = runDrc(doc).violations.find((x) => x.kind === 'UnRoutedNet' && x.details);
    expect(v?.details?.[0]).toMatch(/^Sub-Net 1: \d+ pads? \(/);
  });

  it('Gerber: an inner layer\'s unconnected through pads left out unless asked for', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.board.copperStack = [L.TOP, L.MID1, L.BOTTOM];
    let pads = 0;
    const sink = new Proxy({}, { get: (_t, k) => (k === 'pad' || k === 'dot' ? () => { pads++; } : () => {}) });
    const count = (midPads: boolean) => { pads = 0; drawLayer(sink as never, doc, L.MID1, { outlineOnMech1: false, notes: new Set(), midPads }); return pads; };
    const withAll = count(true);
    expect(withAll).toBeGreaterThan(0);
    expect(count(false)).toBeLessThan(withAll);
  });
});
