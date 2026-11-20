import { afterEach, describe, expect, it } from 'vitest';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { netObjects } from '../src/app/panels/Navigator';
import { connectionGraph } from '../src/app/project';
import { kindShown, layout, setLayout } from '../src/app/dock/store';
import { openPanel, isOpen } from '../src/app/dock/layout';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });

describe('System Preferences once greyed (26.105)', () => {
  it('each is on its page with AD\'s default; nothing on View, Transparency or Navigation is greyed', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['reopenWorkspace', 'clipboardAppOnly', 'documentPath', 'restoreOpenDocs', 'layoutPerKind', 'groupTabs', 'autoHideTabs', 'multilineTabs', 'dynTransparency', 'dynHigh', 'dynLow', 'dynDistance',
      'navDim', 'navGraph', 'navShowPins', 'navShowNetLabels', 'navShowPorts', 'navShowEntries', 'navShowConnectors', 'navShowLines', 'crossSelectBehaviour']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ reopenWorkspace: true, clipboardAppOnly: true, restoreOpenDocs: false, layoutPerKind: true, groupTabs: true, autoHideTabs: false, multilineTabs: false,
      dynTransparency: false, dynHigh: 50, dynLow: 10, dynDistance: 100, navDim: false, navGraph: false, navShowLines: false, crossSelectBehaviour: 'Select' });
    for (const id of ['sys-view', 'sys-transparency', 'sys-nav']) expect(PAGES.find((p) => p.id === id)!.sections.flatMap((s) => s.fields).filter((f) => !f.key && f.type.kind !== 'action').map((f) => f.label), id).toEqual([]);
  });

  it('the Navigator lists a net\'s objects as Objects To Display says; the connection graph joins them', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const sheets = [{ name: 'Demo.SchDoc', doc }];
    const res = compileProject(sheets);
    const net = res.nets.find((n) => n.pins.length >= 2 && n.refs.length > n.pins.length)!;
    expect(net).toBeDefined();
    const all = netObjects(net, sheets);
    expect(all.filter((r) => r.what === 'Pin').length).toBe(net.pins.length);
    settings.navShowPins = false;
    expect(netObjects(net, sheets).some((r) => r.what === 'Pin')).toBe(false);
    settings.navShowLines = true;
    expect(netObjects(net, sheets).some((r) => r.what === 'Wire')).toBe(true);
    const g = connectionGraph(doc, net.refs.map((r) => r.index));
    expect(g.length).toBeGreaterThanOrEqual(1);
  });

  it('each kind of document keeps its own panel layout', () => {
    kindShown('sch');
    setLayout(openPanel(layout.value, 'navigator', { side: 'left', group: 'g1' }, 'sch', false));
    expect(isOpen(layout.value, 'navigator')).toBe(true);
    kindShown('pcb');
    setLayout(structuredClone({ ...layout.value, zones: { ...layout.value.zones, left: { ...layout.value.zones.left, groups: layout.value.zones.left.groups.map((g) => ({ ...g, panels: g.panels.filter((p) => p !== 'navigator'), active: g.active === 'navigator' ? g.panels[0]! : g.active })) } } }));
    expect(isOpen(layout.value, 'navigator')).toBe(false);
    kindShown('sch');
    expect(isOpen(layout.value, 'navigator')).toBe(true);
    kindShown('pcb');
    expect(isOpen(layout.value, 'navigator')).toBe(false);
    settings.layoutPerKind = false;
    kindShown('sch');
    expect(isOpen(layout.value, 'navigator')).toBe(false);
  });
});
