import { describe, expect, it } from 'vitest';
import outputsSrc from '../src/app/dialogs/Outputs.tsx?raw';
import libToolsSrc from '../src/app/dialogs/LibTools.tsx?raw';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultDrillSetup, drillFiles, edgeRoutPaths, ROUT_TOOL } from '../src/formats/gerber/drill';
import { apertureListHeader, defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { readDrill, readGerber } from '../src/formats/gerber/gerberRead';
import { drillFromConfig, drillToConfig, gerberFromConfig, gerberToConfig } from '../src/formats/altium/outjobConfig';
import { pcbLibRuleCheck, PCB_CHECK_ALL } from '../src/model/libCheck';
import { mil } from '../src/core/units';
import type { PcbPrim } from '../src/model/pcb';

const board = () => readPcbDoc(demoPcbDoc(), 'B.PcbDoc');

describe('Gerber, NC Drill and Component Rule Check options once greyed (26.113)', () => {
  it('no option in them is fixed or marked as not built', () => {
    expect(outputsSrc).not.toMatch(/checked disabled \/>|<input type="checkbox" disabled \/>/);
    expect(libToolsSrc).not.toMatch(/Not checked yet/);
  });

  it('Optimise change location commands: an unchanged X or Y left out, the holes the same', () => {
    const doc = board();
    const v = doc.prims.find((p) => p.kind === 'via')!;
    doc.prims.push({ ...v, at: { x: v.at.x + mil(100), y: v.at.y } } as PcbPrim);
    const on = drillFiles(doc, defaultDrillSetup())[0]!.text, off = drillFiles(doc, { ...defaultDrillSetup(), optimise: false })[0]!.text;
    expect(on).toMatch(/\r\nX\d+\r\n/);
    expect(off.split('\r\n').filter((l) => /^[XY]/.test(l)).every((l) => /^X-?\d+Y-?\d+$/.test(l))).toBe(true);
    const at = (t: string) => readDrill(t).hits.map((h) => `${Math.round(h.at.x)},${Math.round(h.at.y)}`);
    expect(at(on)).toEqual(at(off));
  });

  it('Generate Board Edge Rout Paths: the board shape routed outside by the tool\'s radius', () => {
    const doc = board();
    expect(drillFiles(doc, defaultDrillSetup()).some((f) => /RoutPath/.test(f.name))).toBe(false);
    const files = drillFiles(doc, { ...defaultDrillSetup(), edgeRout: true });
    const rout = files.find((f) => f.name === 'B-RoutPath.TXT')!;
    expect(rout.text).toMatch(/^M48/);
    const d = readDrill(rout.text);
    expect(d.routes.length).toBe(edgeRoutPaths(doc, ROUT_TOOL).paths.length);
    expect(d.routes[0]!.path.length).toBeGreaterThanOrEqual(doc.board.outline.length);
    // The route lies outside the board: its box bigger by the tool's diameter
    const xs = doc.board.outline.map((p) => p.x), rx = edgeRoutPaths(doc, ROUT_TOOL).paths[0]!.map((p) => p.x);
    expect(Math.max(...rx) - Math.min(...rx)).toBeCloseTo(Math.max(...xs) - Math.min(...xs) + ROUT_TOOL, -3);
    expect(files.find((f) => f.name.endsWith('.DRR'))!.text).toContain('ASCII Rout File : B-RoutPath.TXT');
  });

  it('Embedded apertures off: RS-274-D files with one aperture list (.APR) that reads back', () => {
    const doc = board();
    const s = defaultGerberSetup(doc);
    const x = gerberFiles(doc, s), d = gerberFiles(doc, { ...s, embedded: false });
    const apr = d.files.find((f) => f.name === 'B.APR')!;
    expect(apr).toBeDefined();
    expect(x.files.some((f) => f.name.endsWith('.APR'))).toBe(false);
    const gtl = d.files.find((f) => f.name === 'B.GTL')!.text, gtlX = x.files.find((f) => f.name === 'B.GTL')!.text;
    expect(gtl).not.toMatch(/%ADD|%FS|%MO/);
    const used = new Set(d.files.filter((f) => /^G04/.test(f.text)).flatMap((f) => [...f.text.matchAll(/^D(\d+)\*$/gm)].map((m) => Number(m[1]))));
    const listed = new Set(d.apertures!.defs.map((a) => a.d));
    for (const n of used) expect(listed.has(n)).toBe(true);
    const head = apertureListHeader(apr.text)!;
    expect(readGerber([...head, gtl].join('\n')).objects.length).toBe(readGerber(gtlX).objects.length);
    expect(d.files.find((f) => f.name === 'B.REP')!.text).toContain('RS-274-D');
  });

  it('outjobs carry the options', () => {
    const doc = board();
    const g = gerberFromConfig(doc, gerberToConfig({ ...defaultGerberSetup(doc), embedded: false, unconnectedMidPads: true }));
    expect(g.embedded).toBe(false);
    expect(g.unconnectedMidPads).toBe(true);
    const dr = drillFromConfig(drillToConfig({ ...defaultDrillSetup(), optimise: false, g85: true, edgeRout: true, routTool: mil(100) }));
    expect(dr).toMatchObject({ optimise: false, g85: true, edgeRout: true, routTool: mil(100) });
    expect(drillFromConfig(drillToConfig(defaultDrillSetup()))).toMatchObject({ optimise: true, g85: false, edgeRout: false });
  });

  it('Component Rule Check: Shorted Copper and Unconnected Copper', () => {
    const doc = board();
    const pads = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    const a = pads[0]!, b = pads.find((p) => p.name !== a.name && (p.layer === a.layer || p.layer === 74 || a.layer === 74))!;
    const t = doc.prims.find((p): p is Extract<PcbPrim, { kind: 'track' }> => p.kind === 'track' && p.layer === 1)!;
    const layer = 1;
    const link = { ...t, layer, a: a.at, b: b.at } as PcbPrim;
    const far = { ...t, layer, a: { x: a.at.x + mil(5000), y: a.at.y + mil(5000) }, b: { x: a.at.x + mil(5200), y: a.at.y + mil(5000) } } as PcbPrim;
    const fp = { name: 'X', prims: [{ ...a, at: { ...a.at } }, { ...b, at: { ...b.at } }, link, far] as PcbPrim[] };
    const errs = pcbLibRuleCheck([fp], PCB_CHECK_ALL)[0]!.errors;
    expect(errs).toContain(`Shorted Copper : ${[a.name, b.name].sort((p, q) => p.localeCompare(q, undefined, { numeric: true })).join(' ')}`);
    expect(errs).toContain('Unconnected Copper : 1');
    expect(pcbLibRuleCheck([fp], { ...PCB_CHECK_ALL, shortedCopper: false, unconnectedCopper: false })).toEqual([]);
  });
});
