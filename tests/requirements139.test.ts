import { describe, expect, it } from 'vitest';
import { fileRefs, fromBase64, htmlToText, isRich, normaliseFiles, sanitiseHtml, snapshot, textToHtml, toBase64, unsnapshot, sizeOf } from '../src/model/richText';
import { blankReq, isReq, normaliseRequirements, type Requirement, type Requirements } from '../src/model/requirements';
import { EXPORT_HEADER, draftRows, exportRows, guessColumns, importRows } from '../src/model/reqIO';
import { reportHtml } from '../src/model/reqReport';
import { REQS } from '../src/ai/jobs';
import { docxDoc } from '../src/ai/specText';
import { zip } from '../src/formats/zip';
import { readReqDoc, writeReqDoc } from '../src/formats/reqDoc';

const PNG = toBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]));

describe('Requirements (R6): rich text kept safe', () => {
  it('what is pasted from Word or a web page cut down to the subset kept', () => {
    const h = sanitiseHtml(`<html><head><style>p{}</style><title>t</title></head><body><!--[if gte mso 9]><xml>x</xml><![endif]--><p class=MsoNormal style="x"><strong><span style='font-size:11pt'>Power</span></strong><o:p></o:p></p>`
      + `<p onclick="x()">Runs from 9&nbsp;V<script>alert(1)</script> to 36 V.</p><iframe src="https://x"></iframe><ul><li>One<li>Two<ul><li>Two a</ul><li>Three</ul>`
      + `<table border=1><tr><td>Item<td colspan=2 style="x">Limit<tr><th>Ripple<td>&lt; 30 mV</table><p><a href="javascript:alert(1)">bad</a> <a href="https://x.org/?a=1&b=2" target=_blank onclick="x">good</a></p>`
      + `<img src="file:///C:/clip.png" alt="Figure 1"><img src="kfile:f1" onerror="alert(1)" width="300"><img src="data:image/svg+xml;base64,PHN2Zz4=">loose text<div>Line<div>nested</div></div><h1>Big</h1></body></html>`);
    expect(h).toBe('<p><b>Power</b></p><p>Runs from 9\u00a0V to 36 V.</p><ul><li>One</li><li>Two<ul><li>Two a</li></ul></li><li>Three</li></ul>'
      + '<table><tr><td>Item</td><td colspan="2">Limit</td></tr><tr><th>Ripple</th><td>&lt; 30 mV</td></tr></table><p>bad <a href="https://x.org/?a=1&amp;b=2">good</a></p>'
      + '<p>[Figure 1]<img src="kfile:f1" width="300">loose text</p><p>Line</p><p>nested</p><h3>Big</h3>');
    expect(sanitiseHtml('<p><br></p><p>a</p><p>&nbsp;</p><p></p><p>b</p><p><br></p>')).toBe('<p>a</p><p></p><p>b</p>');
    expect(sanitiseHtml('<p>x <img src="data:image/png;base64,iVBORw0KGgo="></p>')).toBe('<p>x <img src="data:image/png;base64,iVBORw0KGgo="></p>');
  });

  it('plain text and HTML into each other: paragraphs, line breaks, lists, tables (headings kept), pictures', () => {
    const t = 'Para one\nline two\n\n- a\n- b\n\n| Item | Limit |\n| --- | --- |\n| Ripple | 30 mV |\n\n1. first\n2. second';
    const h = textToHtml(t);
    expect(h).toBe('<p>Para one<br>line two</p><ul><li>a</li><li>b</li></ul><table><tr><th>Item</th><th>Limit</th></tr><tr><td>Ripple</td><td>30 mV</td></tr></table><ol><li>first</li><li>second</li></ol>');
    expect(htmlToText(h)).toBe(t);
    expect(htmlToText('<p>See <img src="kfile:f1" alt="Drawing A">.</p><p>9&nbsp;V &amp; up</p>')).toBe('See [Picture: Drawing A].\n\n9 V & up');
    expect([isRich('<p>a<br>b</p><p>c</p>'), isRich('<p><b>a</b></p>'), isRich(h)]).toEqual([false, true, true]);
    expect(fileRefs('<p><img src="kfile:f1"><img src="kfile:f2"></p>')).toEqual(['f1', 'f2']);
  });

  it('a requirement as read: its HTML kept only when formatted, its text from it, pictures no longer in it dropped, attachments kept', () => {
    const R = normaliseRequirements({ prefix: 'REQ', rows: [
      { kind: 'req', id: 'REQ-001', title: 'A', text: 'stale', html: '<p>Mount on <b>four</b> holes:</p><p><img src="kfile:f1"></p>', files: [
        { id: 'f1', name: 'drawing.png', type: 'image/png', data: PNG, inline: true },
        { id: 'f2', name: 'old.png', type: 'image/png', data: PNG, inline: true },
        { id: 'f3', name: 'spec.pdf', type: 'application/pdf', data: PNG },
        { id: 'f3', name: 'dup.pdf', type: 'application/pdf', data: PNG },
        { id: 'bad id', name: 'x', type: '', data: PNG }, { id: 'f4', name: 'x', type: '', data: 'not base64!' },
      ] },
      { kind: 'req', id: 'REQ-002', title: 'B', html: '<p>Just text</p><p>two</p>' },
    ] } as never);
    const [a, b] = R.rows.filter(isReq);
    expect(a!.text).toBe('Mount on four holes:\n\n[Picture]');
    expect(a!.html).toBe('<p>Mount on <b>four</b> holes:</p><p><img src="kfile:f1"></p>');
    expect(a!.files!.map((f) => `${f.id}:${f.name}:${!!f.inline}`)).toEqual(['f1:drawing.png:true', 'f3:spec.pdf:false']);
    expect([b!.text, b!.html, b!.files]).toEqual(['Just text\n\ntwo', undefined, undefined]);
    expect(sizeOf(a!.files![1]!)).toBe(16);
    expect(normaliseFiles([{ id: 'f9', name: '', type: 'x', data: PNG, inline: true }], undefined)).toEqual([]);
  });

  it('saved and read back with its pictures and files', async () => {
    const R = normaliseRequirements({ prefix: 'REQ', rows: [{ kind: 'req', id: 'REQ-001', title: 'A', html: '<p><img src="kfile:f1"></p>', files: [{ id: 'f1', name: 'p.png', type: 'image/png', data: PNG, inline: true }, { id: 'f2', name: 'a.pdf', type: 'application/pdf', data: PNG }] }] } as never);
    const back = readReqDoc(writeReqDoc({ kind: 'ReqDoc', name: 'X.ReqDoc', reqs: R, dirty: false }), 'X.ReqDoc');
    const q = back.reqs.rows.find(isReq)!;
    expect([q.html, q.files?.length, fromBase64(q.files![1]!.data)[0]]).toEqual(['<p><img src="kfile:f1"></p>', 2, 137]);
  });

  it('undo snapshots keep each file once, and give them back whole', () => {
    const big = 'A'.repeat(100_000);
    const R = { rows: [{ ...blankReq('REQ-001'), files: [{ id: 'f1', name: 'x', type: 'image/png', data: big }] }] };
    const s1 = snapshot(R), s2 = snapshot(R);
    expect(s1.length).toBeLessThan(1000);
    expect(s2).toBe(s1);
    expect(unsnapshot<typeof R>(s1).rows[0]!.files[0]!.data).toBe(big);
  });
});

describe('Requirements (R6): rich text in tables, the report and the AI split', () => {
  const rich = (): Requirement => ({ ...blankReq('REQ-001'), title: 'Mounting', html: '<p>Four <b>M3</b> holes:</p><p><img src="kfile:f1" alt="Drawing"></p>', text: 'Four M3 holes:\n\n[Picture: Drawing]',
    files: [{ id: 'f1', name: 'drawing.png', type: 'image/png', data: PNG, inline: true }, { id: 'f2', name: 'Holes.pdf', type: 'application/pdf', data: PNG }] });

  it('exported as plain text with the attachments named; a Markdown table imported formatted', () => {
    const rows = exportRows([rich()], (r) => r.verify.state, null);
    expect(rows[0]![EXPORT_HEADER.indexOf('Requirement')]).toBe('Four M3 holes:\n\n[Picture: Drawing]');
    expect(rows[0]![EXPORT_HEADER.indexOf('Attachments')]).toBe('Holes.pdf');
    const r = importRows([['Ripple', 'Ripple shall be at most:\n| Rail | Limit |\n|---|---|\n| 3V3 | 30 mV |']], guessColumns(['Title', 'Requirement']), 'REQ', []);
    const q = r.rows.find(isReq)!;
    expect(q.html).toBe('<p>Ripple shall be at most:</p><table><tr><th>Rail</th><th>Limit</th></tr><tr><td>3V3</td><td>30 mV</td></tr></table>');
  });

  it('the report shows the formatting and pictures and names the attached files', () => {
    const R: Requirements = { prefix: 'REQ', rows: [rich()] };
    const html = reportHtml({ project: 'P', docs: [{ name: 'A.ReqDoc', reqs: R }], state: () => 'open', result: () => null, when: new Date('2026-11-07T00:00:00Z'), version: '26.139' });
    expect(html).toContain(`<div class="rich"><p>Four <b>M3</b> holes:</p><p><img src="data:image/png;base64,${PNG}" data-kfile="f1" alt="Drawing"></p></div>`);
    expect(html).toContain('Attached: Holes.pdf (16 B)');
  });

  it('drafts added with their formatting and pictures', () => {
    const R: Requirements = { prefix: 'REQ', rows: [] };
    const rows = draftRows([{ section: 'Mech', title: 'Holes', text: 'x', type: 'mechanical', priority: 'must', method: 'inspection', html: '<p>As drawn:</p><p><img src="kfile:f1"></p>', files: [{ id: 'f1', name: 'a.png', type: 'image/png', data: PNG, inline: true }] }], R, []);
    const q = rows.find(isReq)!;
    expect([q.text, q.files?.length]).toEqual(['As drawn:\n\n[Picture]', 1]);
  });

  it('the job (version 2): picture numbers kept, a table\'s lines kept, told about pictures and tables', () => {
    expect(REQS.version).toBe(2);
    expect(REQS.messages({ text: 'x', title: '' })[0]!.content).toMatch(/\[Picture N\] marker/);
    const a = REQS.check({ requirements: [{ title: 'Ripple', text: 'Ripple shall be at most:\n| Rail | Limit |\n|---|---|\n|  3V3   | 30 mV |', type: 'electrical', priority: 'must', method: 'test', pictures: [2, '3', 2, 0, -1, 1.5, 'x'] }] }, REQS.blank);
    expect(a.requirements[0]!.text).toBe('Ripple shall be at most:\n| Rail | Limit |\n|---|---|\n| 3V3 | 30 mV |');
    expect(a.requirements[0]!.pictures).toEqual([2, 3]);
  });

  it('a Word document\'s pictures numbered in the text and taken out with it (a drawing\'s fallback once; EMF marked, not numbered)', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const drawing = (rid: string) => `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const xml = `<w:document><w:body><w:p><w:r><w:t>Mount as in Figure 1:</w:t></w:r></w:p><w:p><mc:AlternateContent><mc:Choice>${drawing('rId5')}</mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rId5"/></w:pict></mc:Fallback></mc:AlternateContent></w:p>`
      + `<w:p>${drawing('rId6')}</w:p><w:p><w:r><w:t>Again:</w:t></w:r>${drawing('rId5')}</w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Logo</w:t></w:r></w:p></w:tc><w:tc><w:p>${drawing('rId7')}</w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const rels = '<Relationships><Relationship Id="rId5" Type="image" Target="media/image1.png"/><Relationship Id="rId6" Type="image" Target="media/image2.emf"/><Relationship Id="rId7" Type="image" Target="media/image3.jpeg"/><Relationship Id="rId9" Type="hyperlink" Target="https://x" TargetMode="External"/></Relationships>';
    const doc = zip([{ name: 'word/document.xml', bytes: enc(xml) }, { name: 'word/_rels/document.xml.rels', bytes: enc(rels) }, { name: 'word/media/image1.png', bytes: fromBase64(PNG) }, { name: 'word/media/image2.emf', bytes: enc('emf') }, { name: 'word/media/image3.jpeg', bytes: enc('jpg') }]);
    const d = await docxDoc(doc);
    expect(d.text).toBe('Mount as in Figure 1:\n\n[Picture 1]\n\n[Drawing]\n\nAgain:[Picture 1]\n\n| Logo | [Picture 2] |');
    expect(d.pictures.map((p) => [p.n, p.name, p.type, p.bytes.length])).toEqual([[1, 'image1.png', 'image/png', 16], [2, 'image3.jpeg', 'image/jpeg', 3]]);
  });
});
