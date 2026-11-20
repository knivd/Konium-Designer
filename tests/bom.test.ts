import { describe, expect, it } from 'vitest';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc, demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { bomColumns, bomCsv, bomItems, buildBom, defaultBomSetup, pcbBomItems, simpleBom } from '../src/model/bom';
import { xlsx } from '../src/formats/xlsx';

const items: Record<string, string>[] = [
  { Designator: 'R10', Comment: '1k', Footprint: '0805', Description: 'Res', LibRef: 'Res', Tolerance: '1%' },
  { Designator: 'R2', Comment: '1k', Footprint: '0805', Description: 'Res', LibRef: 'Res', Tolerance: '5%' },
  { Designator: 'C1', Comment: '100nF, X7R', Footprint: '0603', Description: 'Cap "MLCC"', LibRef: 'Cap' },
];

describe('Bill of Materials', () => {
  it('groups by Comment and Footprint, lists designators in natural order and counts them', () => {
    const s = defaultBomSetup();
    const rows = buildBom(items, s);
    expect(rows.map((r) => [r[s.columns.indexOf('Designator')], r[s.columns.indexOf('Quantity')]])).toEqual([['C1', '1'], ['R2, R10', '2']]);
    expect(bomColumns(items)).toEqual(['Comment', 'Description', 'Designator', 'Footprint', 'LibRef', 'Quantity', 'Tolerance']);
    // differing values in an ungrouped column are listed
    const t = buildBom(items, { ...s, columns: ['Designator', 'Tolerance'] });
    expect(t[1]).toEqual(['R2, R10', '5%, 1%']);
    // no grouping: a line per part
    expect(buildBom(items, { ...s, group: [] })).toHaveLength(3);
  });

  it('writes CSV with quoting and the Simple BOM text files', () => {
    const csv = bomCsv(['Comment', 'Description'], [['100nF, X7R', 'Cap "MLCC"']]);
    expect(csv).toBe('Comment,Description\r\n"100nF, X7R","Cap ""MLCC"""\r\n');
    const sb = simpleBom('Demo.PrjPcb', items, new Date(2026, 0, 1));
    expect(sb.bom).toContain('Bill of Material for Demo.PrjPcb');
    expect(sb.csv.split('\r\n')[0]).toBe('Comment,Pattern,Quantity,Components');
  });

  it('makes a workbook with the sheet, content types and the rows', () => {
    const z = xlsx('Bill of Materials', ['Comment', 'Quantity'], [['1k', '2']]);
    const text = new TextDecoder('latin1').decode(z);
    expect(text.startsWith('PK')).toBe(true);
    for (const f of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) expect(text).toContain(f);
    expect(text).toContain('<v>2</v>');
  });

  it('takes the parts from the compiled demo, or from the board alone', () => {
    const sch = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const it1 = bomItems(compileProject([{ name: 'Demo.SchDoc', doc: sch }]).components);
    expect(it1.map((i) => i.Designator).sort()).toEqual(['C1', 'C2', 'D1', 'J1', 'R1', 'U1']);
    const pcb = pcbBomItems(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
    expect(pcb.map((i) => `${i.Designator}:${i.Footprint}`)).toEqual(['J1:HDR1X2', 'C1:0805', 'U1:SOT-223', 'C2:0805']);
  });
});
