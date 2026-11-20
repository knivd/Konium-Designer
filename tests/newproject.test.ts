import { describe, expect, it } from 'vitest';
import { newPcbDocBytes, newBoardRules } from '../src/formats/altium/newBoard';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { newPrjPcb, readPrjPcb, writePrjPcb, addDocument } from '../src/formats/altium/prjpcb';
import { mil } from '../src/core/units';
import { ruleName } from '../src/formats/altium/rules';

describe('File › New › PCB', () => {
  const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
  it("AD17's new board: 6000 × 4000 mil from (1000, 1000), origin at 0, two copper layers", () => {
    const xs = doc.board.vertices.map((v) => v.p.x), ys = doc.board.vertices.map((v) => v.p.y);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([mil(1000), mil(1000), mil(7000), mil(5000)]);
    expect(doc.board.vertices).toHaveLength(4);
    expect(doc.board.origin).toEqual({ x: 0, y: 0 });
    expect(doc.board.copperStack).toHaveLength(2);
    expect(doc.board.bag?.get('SHEETWIDTH')).toBe('10000mil');
    expect(doc.board.bag?.get('SHEETHEIGHT')).toBe('8000mil');
    expect(doc.components).toHaveLength(0);
    expect(doc.prims).toHaveLength(0);
  });
  it("its 35 default rules in AD17's order and its 14 built-in classes", () => {
    expect(doc.rulesInFile).toBe(true);
    expect(doc.rules.map(ruleName)).toEqual(newBoardRules().map(ruleName));
    expect(doc.rules).toHaveLength(35);
    expect(doc.rules.map(ruleName).slice(0, 3)).toEqual(['UnpouredPolygon', 'NetAntennae', 'SilkToBoardRegionClearance']);
    expect(doc.rules.at(-1) && ruleName(doc.rules.at(-1)!)).toBe('ShortCircuit');
    const fanout = doc.rules.find((r) => ruleName(r) === 'Fanout_SOIC')!;
    expect(fanout.bag.get('COMMENT')).toBe('Fanout_SOIC (Default Rule)');
    expect(fanout.bag.get('PRIORITY')).toBe('3');
    const clearance = doc.rules.find((r) => ruleName(r) === 'Clearance')!;
    expect(clearance.bag.get('NETSCOPE')).toBe('DifferentNets');
    expect(doc.classes.map((c) => c.name)).toContain('All Nets');
    expect(doc.classes).toHaveLength(14);
  });
  it('saves and reads back unchanged', () => {
    const again = readPcbDoc(writePcbDoc(doc), 'PCB1.PcbDoc');
    expect(again.rules.map(ruleName)).toEqual(doc.rules.map(ruleName));
    expect(again.board.vertices).toEqual(doc.board.vertices);
  });
});

describe('File › New › Project', () => {
  it('an empty AD17 project that takes documents', () => {
    const p = newPrjPcb('PCB_Project.PrjPcb');
    expect(p.documents).toEqual([]);
    addDocument(p, 'Sheet1.SchDoc');
    addDocument(p, 'PCB1.PcbDoc');
    const back = readPrjPcb(writePrjPcb(p), 'PCB_Project.PrjPcb');
    expect(back.documents).toEqual(['Sheet1.SchDoc', 'PCB1.PcbDoc']);
    expect(new TextDecoder().decode(writePrjPcb(back))).toContain('OutputPath=Project Outputs for PCB_Project');
  });
});
