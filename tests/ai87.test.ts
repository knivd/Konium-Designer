import { describe, expect, it } from 'vitest';
import { BOARD } from '../src/ai/jobs';
import { boardDigest, isGroundNet, isSupplyNet } from '../src/ai/boardAdvise';
import { demoFiles } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';

const f = demoFiles().find((x) => x.name === 'Demo.PcbDoc')!;
const doc = readPcbDoc(f.bytes, f.name);

describe('AI adviser on the board (26.087)', () => {
  it('writes the board as text, with its measurements worked out: size, layers, rules, components, decoupling distances, nets\' routing', () => {
    const d = boardDigest(doc);
    const lines = d.text.split('\n');
    expect(lines[0]).toBe('Board "Demo.PcbDoc": 40 × 25 mm, 2 copper layers (Top Layer, Bottom Layer), 4 components (0 on the bottom), 3 nets, 18 tracks and arcs, 3 vias. Positions in mm from the board\'s origin.');
    expect(lines).toContain('Clearance (Clearance; All / All): gap 10mil');
    expect(lines).toContain('Clearance_Power (Clearance; InNetClass(\'Power\') / All): gap 12mil');
    expect(lines).toContain('U1: SOT-223; LDO 3V3; top; (24, 12.5); 0°');
    expect(lines).toContain('U1-2 (+3V3): C2 9.8 mm');
    expect(lines).toContain('U1-3 (VIN): C1 14.4 mm');
    expect(lines).toContain('GND: 4 pads; 74.7 mm of track, 0.5–0.8 mm wide, on Top Layer and Bottom Layer; 3 vias; pour on Bottom Layer');
    expect(lines).toContain('+3V3: 3 pads; 20.9 mm of track, 0.8 mm wide, on Top Layer');   // 26.151: the demo's sample arc has no net now
    expect(d).toMatchObject({ parts: 4, nets: 3 });
    expect(d.compIndex.has('U1') && d.netIndex.has('+3V3')).toBe(true);
    // A power pin by the schematic on a net not named as a supply counts too
    const typed = boardDigest(doc, { pinTypes: new Map([['U1-1', 7]]) });
    expect(typed.text).not.toContain('U1-1 (GND)');
  });
  it('tells supplies and grounds by their names', () => {
    for (const n of ['+3V3', 'VCC', 'VDD_IO', '3V3', '5V', 'VBAT', 'AVDD', '+12V', 'VIN']) expect([n, isSupplyNet(n)]).toEqual([n, true]);
    for (const n of ['GND', 'AGND', 'NetU1_2', 'SDA', 'RESET', 'VSS']) expect([n, isSupplyNet(n)]).toEqual([n, false]);
    for (const n of ['GND', 'AGND', 'PGND', 'VSS', '0V', 'GND_ISO']) expect([n, isGroundNet(n)]).toEqual([n, true]);
  });
  it('asks with the board, its schematic and what the datasheets say; answers as a review', () => {
    const m = BOARD.messages({ board: 'Board "X"', design: 'Design "X"', facts: 'U1: output capacitor within 2 mm', focus: 'the LDO', dismissed: ['Silkscreen'] });
    expect(BOARD).toMatchObject({ kind: 'board', role: 'text', effort: 'medium' });
    expect(m[0]!.content).toContain('decoupling capacitors too far');
    expect(m[1]!.content).toBe('Look especially at: the LDO\n\nThe designer dismissed these before (not problems, or known): don\'t report them again.\n- Silkscreen\n\nBoard "X"\n\nIts schematic:\nDesign "X"\n\nWhat the parts\' datasheets say:\nU1: output capacitor within 2 mm');
    expect(BOARD.check({ summary: 'Fine.', findings: [{ severity: 'warn', title: 'C2 far', parts: ['C2'] }] }, BOARD.blank)).toEqual({ summary: 'Fine.', findings: [{ severity: 'warning', title: 'C2 far', detail: '', fix: '', parts: ['C2'], nets: [] }] });
  });
});
