import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberExtension, gerberFiles } from '../src/formats/gerber/gerber';
import { defaultDrillSetup, drillFiles } from '../src/formats/gerber/drill';
import { defaultPnpSetup, pnpFile } from '../src/formats/gerber/pnp';
import { strokeText } from '../src/formats/gerber/stroke';
import { crc32, zip } from '../src/formats/zip';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';

const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

describe('Gerber', () => {
  it("uses Altium's extensions", () => {
    expect([L.TOP, L.BOTTOM, L.TOP_OVERLAY, L.BOTTOM_SOLDER, L.TOP_PASTE, L.KEEPOUT, L.MECH1, L.MID1 + 1].map(gerberExtension))
      .toEqual(['GTL', 'GBL', 'GTO', 'GBS', 'GTP', 'GKO', 'GM1', 'G2']);
  });
  it('writes RS-274X per layer plus the extension report', () => {
    const { files } = gerberFiles(doc, defaultGerberSetup(doc));
    expect(files.map((f) => f.name)).toEqual(['Demo.GTL', 'Demo.GBL', 'Demo.GTO', 'Demo.GBO', 'Demo.GTP', 'Demo.GBP', 'Demo.GTS', 'Demo.GBS', 'Demo.GM1', 'Demo.RUL', 'Demo.EXTREP', 'Demo.REP']);
    expect(files.find((f) => f.name === 'Demo.RUL')!.text.split('\r\n').slice(0, 2)).toEqual(['DRC Rules Export File for PCB: Demo.PcbDoc', 'RuleKind=Clearance|RuleName=Clearance|Scope=Board|Minimum=10.00']);
    const gtl = files[0]!.text;
    expect(gtl).toContain('%FSLAX25Y25*%');
    expect(gtl).toContain('%MOIN*%');
    expect(gtl).toContain('G04 Layer_Physical_Order=1*');
    expect(gtl.trim().endsWith('M02*')).toBe(true);
    // 8 SMD pads + 2 through pads flashed on top copper
    expect((gtl.match(/D03\*/g) ?? []).length).toBe(8 + 2 + 3);
    // Relative origin: J1 pad 1 at (5, 13.77) mm from the origin → X19685Y54213
    expect(gtl).toContain('X19685Y54213D03*');
    // the bottom pour with its hole: pieces without holes, no clear polarity (it would erase what lies under the hole)
    expect(files[1]!.text).not.toContain('%LPC*%');
    expect((files[1]!.text.match(/G36\*/g) ?? []).length).toBeGreaterThan(1);
    // mask openings grow by the 4 mil default expansion: 1 mm pad → 0.04737 in
    expect(files.find((f) => f.name === 'Demo.GTS')!.text).toContain('R,0.04737X0.05721');
  });
  it('millimetres 4:4', () => {
    const s = { ...defaultGerberSetup(doc), units: 'mm' as const, intDigits: 4, decDigits: 4 };
    const gtl = gerberFiles(doc, s).files[0]!.text;
    expect(gtl).toContain('%FSLAX44Y44*%');
    expect(gtl).toContain('X50000Y137700D03*');
  });
  it('stroke text: cap height as given, anchored bottom-left', () => {
    const pl = strokeText('H', { x: 0, y: 0 }, mm(1));
    const ys = pl.flat().map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(0, 0);
    expect(Math.max(...ys)).toBeCloseTo(mm(1), -2);
  });
});

describe('NC Drill and Pick and Place', () => {
  it('Excellon with tools by size', () => {
    const files = drillFiles(doc, defaultDrillSetup());
    expect(files.map((f) => f.name)).toEqual(['Demo.TXT', 'Demo.DRR']);
    const t = files[0]!.text;
    expect(t.startsWith('M48\r\n;Layer_Color=9474304\r\n;FILE_FORMAT=2:5\r\nINCH,TZ\r\n;TYPE=PLATED')).toBe(true);
    expect(t).toContain('T1F00S00C0.01575');
    expect(t).toContain('T2F00S00C0.03937');
    // Optimise change location commands (on, as AD): the X the last hit's left out
    expect(drillFiles(doc, { ...defaultDrillSetup(), optimise: false })[0]!.text).toContain('\r\nX19685Y54213\r\n');
    expect(t).toMatch(/\r\n(Y54213|X19685)\r\n/);
    expect(t.trim().endsWith('M30')).toBe(true);
    const sep = drillFiles(doc, { ...defaultDrillSetup(), separatePlated: true });
    expect(sep.map((f) => f.name)).toEqual(['Demo-Plated.TXT', 'Demo.DRR']);
  });
  it('pick and place CSV', () => {
    const f = pnpFile(doc, defaultPnpSetup(), '', new Date(2026, 9, 24, 9, 30));
    expect(f.name).toBe('Pick Place for Demo.csv');
    expect(f.text).toContain('"Designator","Comment","Layer","Footprint","Center-X(mm)","Center-Y(mm)","Rotation","Description"');
    expect(f.text).toContain('"U1","LDO 3V3","TopLayer","SOT-223","24.0000","12.5000","0",""');
  });
  it('zip', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = zip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }]);
    expect(new DataView(z.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(z.buffer).getUint32(z.length - 22, true)).toBe(0x06054b50);
  });
});
