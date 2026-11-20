import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PAD } from '../src/formats/altium/pcbLayouts';
import { jumperGroups } from '../src/model/drc';
import { replaceRecords, setComponentProps } from '../src/model/pcbEdit';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { FEATURES, FEATURE_COMMANDS, STAGE } from '../src/core/release';
import { LIVE_PARTS, LIVE_SPEEDS, nextDesignator, si, voltColour } from '../src/app/liveSim';
import { simPartSymbols, simSourceSymbols } from '../src/formats/synthetic/simLib';
import { SIM_DEMO, simDemoFiles } from '../src/formats/synthetic/simDemo';
import { readSchDoc } from '../src/formats/altium/schdoc';
import ICONS from '../src/app/icons.tsx?raw';
import GUIDE from '../src/help/guide/tools.ts?raw';

describe('26.181: an arc between two pads of a part that is no jumper', () => {
  /** The jumper arcs on screen (the connections group's arcs). */
  const arcs = (ed: PcbEditor) => {
    ed.invalidate();
    const g = ed.scene().groups.get('connections');
    let n = 0;
    if (g) for (let i = 0; i < g.prims.count; i++) if (g.prims.f32[i * 10 + 8] === 1) n++;
    return n;
  };
  it('pads that share a Jumper ID in a Standard component: no arc, nothing joined; in a Jumper component: the arc, joined', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const pads = doc.prims.filter((p) => p.kind === 'pad' && p.component === 2 && p.net === 2);
    replaceRecords(doc, pads.map((p) => {
      const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
      const subs = rec.subs.map((s) => s.slice());
      new DataView(subs[4]!.buffer, subs[4]!.byteOffset).setUint16(PAD.jumperId.off, 7, true);
      return { storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } };
    })).apply();
    expect(doc.prims.filter((p) => p.kind === 'pad' && p.jumper === 7).length).toBe(2);
    expect(doc.components[2]!.bag.int('COMPONENTKIND')).not.toBe(6);
    expect(jumperGroups(doc)).toEqual([]);
    expect(arcs(ed)).toBe(0);
    setComponentProps(doc, 2, { COMPONENTKIND: '6' }).apply();
    expect(jumperGroups(doc).map((g) => [g.comp, g.pads.length])).toEqual([[2, 2]]);
    expect(arcs(ed)).toBe(1);
  });
});

describe('26.181: the New and Open icons', () => {
  it('Open is a folder standing open with a document in it; New a page with its plus as a badge', () => {
    const open = /\n  open: (.*)\n/.exec(ICONS)![1]!, neu = /\n  newDoc: (.*)\n/.exec(ICONS)![1]!;
    expect(open).toMatch(/fill="#f0c75a"/);      // the folder's back
    expect(open).toMatch(/fill="#f7da84"/);      // its front, tilted open
    expect(open).toMatch(/fill=\{paper\}/);      // the document in it
    expect(open).not.toMatch(/M5 8h6M5 10h6/);   // no longer a page of text
    expect(neu).toMatch(/<circle [^>]*fill=\{green\}/);
    // No two commands' icons are one drawing
    const openProject = /\n  openProject: (.*)\n/.exec(ICONS)![1]!, folderOpen = /\n  folderOpen: (.*)\n/.exec(ICONS)![1]!;
    expect(new Set([open, neu, openProject, folderOpen]).size).toBe(4);
  });
});

describe('Live Simulation (R18): what the panel and the sheet are made of', () => {
  it('is a feature of stage 18 (switched on from 26.182), its commands with it, its guide section too', () => {
    expect(FEATURES.live).toEqual({ stage: 18, name: 'Live simulation' });
    expect(STAGE).toBeGreaterThanOrEqual(FEATURES.live.stage);
    for (const c of ['live.panel', 'live.start', 'live.stop', 'live.hold', 'live.again', 'live.faster', 'live.slower', 'live.scope']) expect(FEATURE_COMMANDS[c], c).toBe('live');
    expect(GUIDE).toMatch(/id: 'sch-live',\n\s+title: 'Live simulation',\n\s+feature: 'live',/);
  });

  it('the parts for a sketch are all in the built-in simulation libraries, each with a model', () => {
    const parts = simPartSymbols(), sources = simSourceSymbols();
    expect(LIVE_PARTS.length).toBe(77);
    expect(new Set(LIVE_PARTS.map((p) => p.id)).size).toBe(77);
    for (const p of LIVE_PARTS) {
      const sym = (p.lib === 'parts' ? parts : sources).find((s) => s.libRef === p.libRef);
      expect(sym, p.label).toBeDefined();
      expect(sym!.bags.some((b) => /SIM/i.test(b.get('MODELTYPE') ?? '') || b.has('MODELDATAFILEKIND0') || /@DESIGNATOR/.test(b.get('TEXT') ?? '') || [...b.keys()].some((k) => /NETLIST|SIM/i.test(k))), p.label).toBe(true);
    }
  });

  it('a new part takes the next designator of its kind on the sheet', () => {
    const f = simDemoFiles().find((x) => x.name === SIM_DEMO.sheet)!;
    const doc = readSchDoc(f.bytes, f.name);
    expect([nextDesignator(doc, 'R'), nextDesignator(doc, 'C'), nextDesignator(doc, 'Q'), nextDesignator(doc, 'V'), nextDesignator(doc, 'L'), nextDesignator(doc, 'LED')]).toEqual(['R6', 'C4', 'Q2', 'V3', 'L1', 'LED1']);
  });

  it('values read as an engineer writes them; the speeds are 1, 2, 5 through the decades; the colours run blue, grey, red', () => {
    expect([si(3.3, 'V'), si(0.0125, 'A'), si(-4.7e-4, 's'), si(2.2e-9, 's'), si(15300, 'V'), si(0, 'A'), si(999.96e-6, 'A')]).toEqual(['3.30 V', '12.5 mA', '-470 µs', '2.20 ns', '15.3 kV', '0 A', '1.00 mA']);
    expect(LIVE_SPEEDS[0]).toBe(1e-9);
    expect(LIVE_SPEEDS.at(-1)).toBe(10);
    expect(LIVE_SPEEDS.length).toBe(31);
    for (let i = 1; i < LIVE_SPEEDS.length; i++) expect(LIVE_SPEEDS[i]! / LIVE_SPEEDS[i - 1]!).toBeGreaterThan(1.9);
    const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    const [r0, g0, b0] = rgb(voltColour(0, 5)), [rp, , bp] = rgb(voltColour(5, 5)), [rn, , bn] = rgb(voltColour(-5, 5));
    expect(Math.max(r0!, g0!, b0!) - Math.min(r0!, g0!, b0!)).toBeLessThan(20);   // grey at 0 V
    expect(rp! - bp!).toBeGreaterThan(150);    // red at the top
    expect(bn! - rn!).toBeGreaterThan(150);    // blue at the bottom
    expect(voltColour(50, 5)).toBe(voltColour(5, 5));   // no further than full
    expect(voltColour(1, 0)).toBe(voltColour(0, 5));    // nothing to scale by: grey
  });
});
