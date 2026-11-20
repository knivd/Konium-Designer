import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR } from '../src/model/sch';
import { compileProject } from '../src/model/compile';
import { planAnnotation, planReset, resetDesignator, resetPastedDesignators } from '../src/model/annotate';
import { PropertyBag } from '../src/formats/altium/props';

/** A sheet with resistors R? (two pins, left/right) wired as described. */
function sheet(build: (b: SchBuilder, part: (des: string, x: number, y: number, opts?: { lib?: string; parts?: number; partId?: number }) => void) => void): ReturnType<typeof readSchDoc> {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  const part = (des: string, x: number, y: number, opts: { lib?: string; parts?: number; partId?: number } = {}) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: opts.lib ?? 'Res', PARTCOUNT: (opts.parts ?? 1) + 1, CURRENTPARTID: opts.partId ?? 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1 }, { LOCATION: { x, y } });
    // pin 1 points left from x, pin 2 points right from x+40
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: opts.partId ?? 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: opts.partId ?? 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
    b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: '10k' }, { LOCATION: { x, y: y - 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return readSchDoc(writeCfb(root), 'Test.SchDoc');
}

describe('compile', () => {
  it('demo: Altium names, power nets, floating label, multiple names', () => {
    const r = compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') }]);
    const net = (n: string) => r.nets.find((x) => x.name === n);
    expect(net('GND')?.pins.map((p) => `${p.designator}-${p.pin}`)).toEqual(['C1-2', 'C2-2', 'D1-K', 'J1-2', 'U1-1']);
    expect(net('+3V3')?.pins.map((p) => `${p.designator}-${p.pin}`)).toEqual(['C2-1', 'R1-1', 'U1-2', 'U1-4']);
    expect(net('VIN')?.pins.map((p) => `${p.designator}-${p.pin}`)).toEqual(['C1-1', 'J1-1', 'U1-3']);
    // R1 to the LED: no label, so the net is named after its first pin, as Altium does
    expect(net('NetD1_A')?.auto).toBe(true);
    expect(r.messages.some((m) => /has multiple names/.test(m.message))).toBe(true);
    expect(r.components.map((c) => c.designator)).toEqual(['C1', 'C2', 'D1', 'J1', 'R1', 'U1']);
    expect(r.components.find((c) => c.designator === 'U1')?.footprint).toBe('SOT-223');
  });

  it('a net label off the wire is floating and names nothing', () => {
    const doc = sheet((b, part) => {
      part('R1', 100, 100); part('R2', 300, 100);
      b.wire([150, 100], [290, 100]);
      b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'SIG' }, { LOCATION: { x: 200, y: 102 } });
    });
    const r = compileProject([{ name: 'Test.SchDoc', doc }]);
    expect(r.messages.map((m) => m.message)).toContain('Floating Net Label SIG');
    expect(r.nets.find((n) => n.pins.length === 2)?.name).toBe('NetR1_2');
  });

  it('T-junction joins, a crossing does not, a lone pin is not a net', () => {
    const doc = sheet((b, part) => {
      part('R1', 100, 100); part('R2', 300, 100); part('R3', 200, 300);
      b.wire([150, 100], [290, 100]);           // R1-2 to R2-1
      b.wire([200, 100], [200, 50]);            // T stub up from the middle of that wire
      b.wire([190, 300], [190, 80]);            // crosses the R1-R2 wire at (190,100) without ending there
    });
    const r = compileProject([{ name: 'Test.SchDoc', doc }]);
    const pins = r.nets.map((n) => n.pins.map((p) => `${p.designator}-${p.pin}`).join(' '));
    expect(pins).toContain('R1-2 R2-1');
    expect(pins).toContain('R3-1');             // the crossing wire reaches R3-1 only
    expect(r.nets.some((n) => n.pins.some((p) => p.designator === 'R3' && p.pin === '2'))).toBe(false);
  });

  it('net labels join nets on one sheet; duplicates are errors', () => {
    const doc = sheet((b, part) => {
      part('R1', 100, 100); part('R2', 300, 100); part('R2', 500, 100);
      b.wire([150, 100], [200, 100]);
      b.wire([290, 100], [250, 100]);
      b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'SIG' }, { LOCATION: { x: 180, y: 100 } });
      b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'SIG' }, { LOCATION: { x: 260, y: 100 } });
    });
    const r = compileProject([{ name: 'Test.SchDoc', doc }]);
    expect(r.nets.find((n) => n.name === 'SIG')?.pins.length).toBe(2);
    expect(r.messages.some((m) => m.level === 'error' && m.message === 'Duplicate Component Designators R2')).toBe(true);
  });
});

describe('annotate', () => {
  it('numbers by prefix across then down, skipping designators in use', () => {
    const doc = sheet((_b, part) => {
      part('R?', 100, 500); part('R?', 300, 500); part('R2', 100, 300); part('C?', 300, 300); part('R?', 100, 100);
    });
    const rows = planAnnotation([{ name: 'Test.SchDoc', doc }], 'acrossThenDown');
    expect(rows.map((r) => r.proposed)).toEqual(['R1', 'R3', 'C1', 'R4']);
  });
  it('fills multi-part packages before starting a new one', () => {
    const doc = sheet((_b, part) => {
      part('U?', 100, 500, { lib: 'Opamp', parts: 2, partId: 1 });
      part('U?', 300, 500, { lib: 'Opamp', parts: 2, partId: 2 });
      part('U?', 500, 500, { lib: 'Opamp', parts: 2, partId: 1 });
    });
    const rows = planAnnotation([{ name: 'Test.SchDoc', doc }]);
    expect(rows.map((r) => r.proposed)).toEqual(['U1', 'U1', 'U2']);
  });
  it('reset designators: prefix and ?, duplicates keep the first', () => {
    expect(resetDesignator('R12')).toBe('R?');
    expect(resetDesignator('LED3')).toBe('LED?');
    expect(resetDesignator('12')).toBe('U?');
    const doc = sheet((_b, part) => { part('R1', 100, 500); part('R1', 300, 500); part('C4', 100, 300); part('R?', 300, 300); });
    expect(planReset([{ name: 'Test.SchDoc', doc }]).map((r) => `${r.current}>${r.proposed}`)).toEqual(['R1>R?', 'R1>R?', 'C4>C?']);
    expect(planReset([{ name: 'Test.SchDoc', doc }], true).map((r) => `${r.current}>${r.proposed}`)).toEqual(['R1>R?']);
  });
  it('pasted parts get reset designators; free text keeps its own', () => {
    const bag = (o: Record<string, string>) => { const b = new PropertyBag(); for (const [k, v] of Object.entries(o)) b.set(k, v); return b; };
    const items = [
      { bag: bag({ RECORD: '1', LIBREFERENCE: 'Res' }), owner: -1 },
      { bag: bag({ RECORD: '34', NAME: 'Designator', TEXT: 'R7' }), owner: 0 },
      { bag: bag({ RECORD: '34', NAME: 'Designator', TEXT: 'R8' }), owner: -1 },
    ];
    const out = items.map((i) => i.bag.clone());
    resetPastedDesignators(items, out);
    expect(out.map((b) => b.get('TEXT'))).toEqual([undefined, 'R?', 'R8']);
  });
});
