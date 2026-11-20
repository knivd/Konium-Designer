import { describe, expect, it } from 'vitest';
import { blankReq, isReq, normaliseRequirements, type Requirement, type Requirements } from '../src/model/requirements';
import { EXPORT_HEADER, draftRows, exportRows, guessColumns, importRows, readMethod, readPriority, readState, readStatus, readType, toCsv } from '../src/model/reqIO';
import { reportCounts, reportHtml } from '../src/model/reqReport';
import { evalCheck, newCheck } from '../src/model/reqChecks';
import { parseCsv } from '../src/formats/table';
import { JOBS, REQS, MAX_SPEC } from '../src/ai/jobs';
import { docxText, specText } from '../src/ai/specText';
import { zip } from '../src/formats/zip';
import { xlsx } from '../src/formats/xlsx';
import { readXlsx } from '../src/formats/xlsxRead';

const req = (id: string, p: Partial<Requirement> = {}): Requirement => ({ ...blankReq(id), ...p });

describe('Requirements (R6): in and out of tables', () => {
  it('columns matched by their headings, other names too; a table with one unnamed column has it as the requirement', () => {
    const c = guessColumns(['Req ID', 'Chapter', 'Name', 'Description', 'Class', 'MoSCoW', 'State', 'Derived from', 'Spec clause', 'Verification method', 'Compliance', 'Remarks', 'Owner']);
    expect(c).toEqual({ id: 0, section: 1, title: 2, text: 3, type: 4, priority: 5, status: 6, parent: 7, source: 8, method: 9, state: 10, note: 11 });
    expect(guessColumns(['Whatever'])).toMatchObject({ text: 0, title: -1, id: -1 });
  });

  it('words read loosely', () => {
    expect([readPriority('Shall'), readPriority('M'), readPriority('Should'), readPriority('low'), readPriority('Optional'), readPriority('')]).toEqual(['must', 'must', 'should', 'could', 'could', undefined]);
    expect([readType('Electrical'), readType('Thermal'), readType('EMC'), readType('Mech.'), readType('nonsense')]).toEqual(['electrical', 'environmental', 'compliance', 'mechanical', undefined]);
    expect([readStatus('Accepted'), readStatus('Proposed'), readStatus('Withdrawn')]).toEqual(['approved', 'draft', 'obsolete']);
    expect([readMethod('T'), readMethod('Inspect'), readMethod('Simulation'), readMethod('Demonstration')]).toEqual(['test', 'inspection', 'analysis', 'test']);
    expect([readState('Pass'), readState('FAIL'), readState('N/A'), readState('Not verified'), readState('Verified'), readState('Not done yet'), readState('No')]).toEqual(['verified', 'failed', 'waived', 'open', 'verified', 'open', 'failed']);
    expect(readPriority('Medium')).toBe('should');
  });

  it('rows become requirements under sections: identifiers kept unless taken, priority from "shall" when no column, parents kept only when they exist', () => {
    const header = ['ID', 'Section', 'Title', 'Requirement', 'Priority', 'Parent', 'Verification'];
    const rows = [
      ['', 'Power', '', '', '', '', ''],
      ['SYS-001', 'Power', 'Input range', 'The board shall run from 9 V to 36 V.', '', '', 'Pass'],
      ['REQ-002', 'Power', 'Reverse polarity', 'It should survive -36 V.', '', 'SYS-001', ''],
      ['', 'Mechanical', '', 'The board may be 1.0 mm thick. And more.', 'Could', 'NOPE-9', ''],
      ['', '', '', '', '', '', ''],
    ];
    const r = importRows(rows, guessColumns(header), 'REQ', [req('REQ-001'), req('REQ-002')]);
    expect(r.count).toBe(3);
    expect(r.renamed).toBe(1);
    expect(r.rows.map((x) => (isReq(x) ? x.id : `§${x.title}`))).toEqual(['§Power', 'SYS-001', 'REQ-003', '§Mechanical', 'REQ-004']);
    const [a, b, c] = r.rows.filter(isReq);
    expect([a!.priority, a!.verify.state, b!.priority, b!.parent, c!.priority, c!.parent]).toEqual(['must', 'verified', 'should', 'SYS-001', 'could', undefined]);
    expect(c!.title).toBe('The board may be 1.0 mm thick.');
  });

  it('exported and read back: the same requirements, all but links and checks (CSV quoted where it must be, with a byte order mark for Excel)', () => {
    const R: Requirements = normaliseRequirements({ prefix: 'REQ', rows: [
      { kind: 'section', title: 'Power, input' },
      { kind: 'req', id: 'REQ-001', title: 'Input "range"', text: 'Line one\nline two', type: 'electrical', priority: 'must', status: 'approved', source: 'Spec B 3.1', verify: { method: 'test', state: 'verified', note: 'Bench, 2026' }, links: [{ kind: 'part', ref: 'U1' }] },
      { kind: 'req', id: 'REQ-002', title: 'Layers', parent: 'REQ-001', check: newCheck('layers'), verify: { method: 'inspection', state: 'open', note: '' } },
    ] } as never);
    const facts = { board: { name: 'x.PcbDoc', layers: 4, w: 50, h: 30, thickness: 1.6, top: 3, bottom: 0 } };
    const rows = exportRows(R.rows, (r) => r.verify.state, facts);
    expect(rows[0]!.slice(0, 4)).toEqual(['REQ-001', 'Power, input', 'Input "range"', 'Line one\nline two']);
    expect(rows[0]![EXPORT_HEADER.indexOf('Linked to')]).toBe('Part U1');
    expect(rows[1]![EXPORT_HEADER.indexOf('Check result')]).toMatch(/^(Passes|Fails): 4/);
    const csv = toCsv(EXPORT_HEADER, rows);
    expect(csv.startsWith('﻿ID,Section,')).toBe(true);
    expect(csv).toContain('"Input ""range"""');
    const back = parseCsv(csv);
    expect(back[1]![3]).toBe('Line one\nline two');
    const again = importRows(back.slice(1), guessColumns(back[0]!), 'REQ', []);
    const [a, b] = again.rows.filter(isReq);
    expect(again.rows[0]).toEqual({ kind: 'section', title: 'Power, input' });
    expect([a!.id, a!.title, a!.type, a!.status, a!.source, a!.verify.method, a!.verify.state, a!.verify.note]).toEqual(['REQ-001', 'Input "range"', 'electrical', 'approved', 'Spec B 3.1', 'test', 'verified', 'Bench, 2026']);
    expect([b!.id, b!.parent, b!.verify.method]).toEqual(['REQ-002', 'REQ-001', 'inspection']);
  });

  it('an Excel workbook written and read back the same way', async () => {
    const book = xlsx('Requirements', ['ID', 'Title', 'Requirement'], [['A-1', 'One', 'The first'], ['A-2', 'Two', 'The second']]);
    const t = await readXlsx(book);
    expect(t.sheets).toEqual(['Requirements']);
    const r = importRows(t.rows.slice(1), guessColumns(t.rows[0]!), 'REQ', []);
    expect(r.rows.filter(isReq).map((x) => `${x.id} ${x.title}`)).toEqual(['A-1 One', 'A-2 Two']);
  });

  it('drafts (the AI\'s) added under their sections with the next identifiers and their source', () => {
    const R: Requirements = { prefix: 'PWR', rows: [{ kind: 'section', title: 'General' }, req('PWR-004')] };
    const rows = draftRows([
      { section: 'Power', title: 'A', text: 'a', type: 'electrical', priority: 'must', method: 'test', source: 'Spec 1.1' },
      { section: 'Power', title: 'B', text: 'b', type: 'electrical', priority: 'should', method: 'analysis' },
      { section: '', title: 'C', text: 'c', type: 'other', priority: 'could', method: 'review' },
    ], R, [req('PWR-007')]);
    expect(rows.map((x) => (isReq(x) ? `${x.id}:${x.title}:${x.source ?? ''}` : `§${x.title}`))).toEqual(['§Power', 'PWR-008:A:Spec 1.1', 'PWR-009:B:', 'PWR-010:C:']);
  });
});

describe('Requirements (R6): the compliance report', () => {
  const R = normaliseRequirements({ prefix: 'REQ', rows: [
    { kind: 'section', title: 'Empty' },
    { kind: 'section', title: 'Power <main>' },
    { kind: 'req', id: 'REQ-001', title: 'Runs', priority: 'must', verify: { method: 'test', state: 'verified', note: '' } },
    { kind: 'req', id: 'REQ-002', title: 'Layers', priority: 'must', check: { ...newCheck('layers'), a: 2, op: '<=', follow: true }, verify: { method: 'inspection', state: 'open', note: '' } },
    { kind: 'req', id: 'REQ-003', title: 'Nice', priority: 'could', verify: { method: 'review', state: 'waived', note: 'Agreed' } },
    { kind: 'req', id: 'REQ-004', title: 'Must, open', priority: 'must', source: 'Spec 2.1' },
    { kind: 'req', id: 'REQ-005', title: 'Gone', status: 'obsolete', verify: { method: 'test', state: 'failed', note: '' } },
  ] } as never);
  const facts = { board: { name: 'b.PcbDoc', layers: 4, w: 10, h: 10, thickness: 1.6, top: 1, bottom: 0 } };
  const state = (r: Requirement) => (r.check?.follow ? (evalCheck(r.check, facts).status === 'fail' ? 'failed' : 'verified') : r.verify.state);

  it('counts by state and priority, the obsolete left out', () => {
    const c = reportCounts(R.rows.filter(isReq), state);
    expect(c.total).toEqual({ all: 4, verified: 1, waived: 1, failed: 1, open: 1 });
    expect(c.by.must).toEqual({ all: 3, verified: 1, waived: 0, failed: 1, open: 1 });
  });

  it('one HTML page: the headline, what needs attention, each requirement with its evidence, everything escaped', () => {
    const html = reportHtml({ project: 'Demo & Co', docs: [{ name: 'Product.ReqDoc', reqs: R }], state, result: (r) => (r.check ? evalCheck(r.check, facts) : null), when: new Date('2026-11-07T10:00:00Z'), version: '26.137' });
    expect(html).toContain('<title>Requirements compliance: Demo &amp; Co</title>');
    expect(html).toContain('<span class="big">50%</span>');
    expect(html).toContain('2 of 4 requirements; Must: 1 of 3');
    expect(html).toMatch(/Needs attention <span class="muted">2<\/span>/);
    expect(html).toContain('Power &lt;main&gt;');
    expect(html).toContain('<b>fails</b>');
    expect(html).toContain('Source: Spec 2.1');
    expect(html).toContain('<tr class="obs">');
    expect(html).toContain('2026-11-07');
    expect(html).not.toMatch(/<main>[^]*<main>/);
    expect(html).not.toContain('<h3>Empty</h3>');
    expect(html.match(/<table>/g)).toHaveLength(1);
  });
});

describe('Requirements (R6): a specification split with AI', () => {
  it('the job: run by the service, the text sent as it is (cut at its limit), the answer cleaned', () => {
    expect(JOBS.reqs).toBe(REQS);
    const m = REQS.messages({ text: 'The board shall run from 9 V to 36 V.', title: 'Spec B' });
    expect(m[0]!.content).toMatch(/never round, convert or invent a figure/);
    expect(m[1]!.content).toBe('The specification "Spec B":\n\nThe board shall run from 9 V to 36 V.');
    expect((REQS.messages({ text: 'x'.repeat(MAX_SPEC + 50), title: '' })[1]!.content as string).length).toBe(MAX_SPEC + 'The specification:\n\n'.length);
    expect(() => REQS.messages({ text: '  ', title: '' })).toThrow();
    const a = REQS.check({ requirements: [
      { section: 'Power', ref: '3.1', title: 'Input range', text: 'The board shall run from 9 V to 36 V.', type: 'Electrical', priority: 'MUST', method: 'test' },
      { section: 'Power', ref: '3.1', title: 'Input range', text: 'The board shall run from 9 V to 36 V.', type: 'electrical', priority: 'must', method: 'test' },
      { title: '', text: 'It may glow.', type: 'sparkly', priority: 'may', method: 'look' },
      { title: '', text: '' }, 'nonsense',
    ] }, REQS.blank);
    expect(a.requirements).toEqual([
      { section: 'Power', ref: '3.1', title: 'Input range', text: 'The board shall run from 9 V to 36 V.', type: 'electrical', priority: 'must', method: 'test', pictures: [] },
      { section: '', ref: '', title: 'It may glow.', text: 'It may glow.', type: 'other', priority: 'could', method: 'test', pictures: [] },
    ]);
    expect(() => REQS.check({ nothing: true }, REQS.blank)).toThrow();
  });

  it('a Word document\'s text: headings marked, list items, tables row by row, tabs and breaks kept', async () => {
    const p = (t: string, style = '', list = false) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${p('Product spec', 'Title')}${p('Power', 'Heading2')}${p('The board shall run from 9 V &amp; up.')}${p('Low ripple', 'ListParagraph', true)}`
      + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p><w:p/>'
      + `<w:tbl><w:tr><w:tc>${p('Item')}</w:tc><w:tc>${p('Limit')}</w:tc></w:tr><w:tr><w:tc>${p('Ripple')}</w:tc><w:tc>${p('&lt; 50 mV')}${p('p-p')}</w:tc></w:tr></w:tbl>`
      + '<w:sectPr/></w:body></w:document>';
    const doc = zip([{ name: '[Content_Types].xml', bytes: new TextEncoder().encode('<Types/>') }, { name: 'word/document.xml', bytes: new TextEncoder().encode(xml) }]);
    expect(await docxText(doc)).toBe('# Product spec\n\n## Power\n\nThe board shall run from 9 V & up.\n\n- Low ripple\n\nA\tB\nC\n\n| Item | Limit |\n| Ripple | < 50 mV p-p |');
    expect(await specText('spec.docx', doc)).toContain('## Power');
    await expect(docxText(zip([{ name: 'a.txt', bytes: new Uint8Array([65]) }]))).rejects.toThrow(/Word/);
  });

  it('text and Markdown as they are; old Word files refused with what to do', async () => {
    expect(await specText('a.md', new TextEncoder().encode('﻿# Spec\r\nLine'))).toBe('# Spec\nLine');
    await expect(specText('a.doc', new Uint8Array([0xd0, 0xcf]))).rejects.toThrow(/save it as \.docx/);
  });
});
