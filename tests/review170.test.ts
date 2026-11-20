import { describe, expect, it } from 'vitest';
import { parseXml, unescapeXml } from '../src/formats/xml';
import { parseTree } from '../src/formats/xmlTree';
import { charOf } from '../src/formats/codePoint';
import { cells as cellsOf, readDrawio } from '../src/formats/drawio';
import { dataUrl, fileType, normaliseFiles, opensInTab, showPictures, type ReqFile } from '../src/model/richText';
import { readReqDoc } from '../src/formats/reqDoc';
import { readXlsx } from '../src/formats/xlsxRead';
import { reportHtml } from '../src/model/reqReport';
import { sanitise } from '../src/app/diagram/richtext';
import { svgPagesHtml } from '../src/app/print';
import { webLink } from '../src/core/webLink';
import { pushAll } from '../src/core/lists';
import { demoFiles } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { openPcbLib } from '../src/model/pcbLib';
import { openSchLib } from '../src/model/schLib';
import { addTracks } from '../src/model/pcbEdit';
import { selectionLinks } from '../src/app/requirementsLinks';
import { activeId, docs, type OpenDoc } from '../src/app/state';
import { PcbLibEditor } from '../src/editors/pcb/PcbLibEditor';
import { SchLibEditor } from '../src/editors/sch/SchLibEditor';
import page from '../index.html?raw';

/**
 * The review round's fixes in the app (26.170): what a file from someone else could do (script
 * run from a requirements document or a diagram's label), the library editors' Properties panel,
 * files cut short, and lists longer than a call takes arguments.
 */

/** Markup as a browser would take it: every tag it starts, with its attributes' names. */
const tags = (html: string) => [...html.matchAll(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map((m) => ({ tag: m[1]!.toLowerCase(), attrs: [...m[2]!.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([a-zA-Z_:][\w:.-]*)\s*=/g)].map((a) => a[1]!.toLowerCase()) }));
const handlers = (html: string) => tags(html).flatMap((t) => t.attrs.filter((a) => a.startsWith('on')).map((a) => `${t.tag} ${a}`));

describe('a requirements document from someone else (26.170)', () => {
  const evil = 'image/png" onerror="window.x=1//';
  const doc = (files: unknown[], html = '<p>Picture <img src="kfile:f1"> here</p>') => new TextEncoder().encode(JSON.stringify({
    koniumRequirements: 1, prefix: 'REQ', rows: [{ kind: 'section', title: 'General' }, { kind: 'req', id: 'REQ-001', title: 'One', text: 'x', html, files }],
  }));
  const first = (bytes: Uint8Array) => { const r = readReqDoc(bytes, 'A.ReqDoc').reqs.rows[1]!; if (r.kind !== 'req') throw new Error('not a requirement'); return r; };

  it("a file's type is a media type's two names or nothing: what else a document says there is dropped as it is read", () => {
    expect(fileType('image/png')).toBe('image/png');
    expect(fileType(' Text/Plain; charset=utf-8 ')).toBe('text/plain');
    expect(fileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    for (const bad of [evil, 'image/png"', 'image', '', 'a/b c', '<script>', 'image/svg+xml" x="', null, 7]) expect(fileType(bad), String(bad)).toBe('');
    const [f] = normaliseFiles([{ id: 'f1', name: 'p.png', type: evil, data: 'AAAA', inline: true }], '<p><img src="kfile:f1"></p>');
    expect(f).toEqual({ id: 'f1', name: 'p.png', type: '', data: 'AAAA', inline: true });
    expect(first(doc([{ id: 'f1', name: 'p.png', type: evil, data: 'AAAA', inline: true }])).files![0]!.type).toBe('');
  });

  it('its pictures go into the page as pictures only, their addresses as attributes are written: nothing a type says becomes an attribute', () => {
    // As read from a document
    const r = first(doc([{ id: 'f1', name: 'p.png', type: evil, data: 'AAAA', inline: true }]));
    expect(handlers(showPictures(r.html!, r.files))).toEqual([]);
    // …and for a file object made any other way, with the type still as it was
    const raw: ReqFile = { id: 'f1', name: 'p.png', type: evil, data: 'AAAA', inline: true };
    const shown = showPictures('<p><img src="kfile:f1"></p>', [raw]);
    expect(handlers(shown)).toEqual([]);
    expect(shown).toBe('<p><img src="data:," data-kfile="f1"></p>');
    expect(showPictures('<p><img src="kfile:gone"></p>', [])).toBe('<p><img src="data:," data-kfile="gone"></p>');
    expect(dataUrl(raw)).toBe('data:application/octet-stream;base64,AAAA');
    // A picture as before
    const png: ReqFile = { id: 'f1', name: 'p.png', type: 'image/png', data: 'AAAA', inline: true };
    expect(showPictures('<p><img src="kfile:f1"></p>', [png])).toBe('<p><img src="data:image/png;base64,AAAA" data-kfile="f1"></p>');
    // The compliance report (a page of its own) shows the same text
    const report = reportHtml({ project: 'T', docs: [{ name: 'A.ReqDoc', reqs: { prefix: 'REQ', rows: [{ kind: 'section', title: 'S' }, { ...r, files: [raw] }] } }], state: () => 'open', result: () => null, when: new Date(0), version: '26.170' });
    expect(report).toContain('<div class="rich">');
    expect(handlers(report)).toEqual([]);
  });

  it('an attached file opens in a tab only when a browser merely shows it: a web page or an SVG is saved instead', () => {
    const f = (type: string): ReqFile => ({ id: 'f2', name: 'n', type, data: 'AAAA' });
    for (const t of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'text/plain', 'Text/Plain; charset=utf-8']) expect(opensInTab(f(t)), t).toBe(true);
    for (const t of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'text/css', 'application/octet-stream', '', evil, 'text/html;text/plain']) expect(opensInTab(f(t)), t).toBe(false);
  });
});

describe("a diagram's label from someone else (26.170)", () => {
  const KEPT = /^(b|strong|i|em|u|s|strike|del|ins|sub|sup|br|div|p|span|font|a|ul|ol|li|h[1-6]|code|pre|blockquote|hr|table|tbody|tr|td|th|center)$/;
  const hostile = [
    '<<x>img src=x onerror="window.x=1">',
    '<<x>svg onload="window.x=1">',
    '<<!-- -->img src=x onerror="window.x=1">',
    '<img src=x onerror="window.x=1">plain',
    '<b onmouseover="window.x=1" style="color:red">bold</b><script>window.x=1</script>',
    '<<b>img src=x onerror=window.x=1>',
    '<i<x>mg src=x onerror=window.x=1>',
    '<scr<script>ipt>window.x=1</scr</script>ipt>',
    '<<script></script>img src=x onerror=window.x=1>',
    '<a href="javascript:window.x=1">link</a><a href=" javascript:window.x=1">link</a>',
    '<iframe src="javascript:window.x=1"></iframe><object data=x></object><embed src=x>',
    '<div style="background-image:url(https://example.com/x.png);color:red">text</div>',
    '<img src=x onerror=window.x=1',
    '<<<<x>>img src=x onerror=window.x=1>',
    '<p title="><img src=x onerror=window.x=1>">text</p>',
    '<math><mtext><img src=x onerror=window.x=1></mtext></math>',
    '<form action="https://example.com"><input name=a><button>go</button></form>',
  ];

  it('what the label editor is given holds only its formatting tags, none with an event, an address that runs script or a picture', () => {
    for (const h of hostile) {
      const out = sanitise(h);
      const ts = tags(out);
      expect(ts.filter((t) => !KEPT.test(t.tag)).map((t) => t.tag), `${h} → ${out}`).toEqual([]);
      expect(handlers(out), `${h} → ${out}`).toEqual([]);
      expect(out, h).not.toMatch(/javascript:|url\(/i);
      // Cleaned again (as when the label is kept), it is the same: nothing in it joined up into something new
      expect(sanitise(out), h).toBe(out);
    }
    // A '<' that is no tag is text
    expect(sanitise('<<x>img src=x onerror="window.x=1">')).toBe('&lt;img src=x onerror="window.x=1">');
    expect(sanitise('a < b')).toBe('a &lt; b');
  });

  it("a label's formatting is kept as it was", () => {
    expect(sanitise('<b>bold</b> <i>it</i><br>next <font color="#ff0000" size="3">red</font>')).toBe('<b>bold</b> <i>it</i><br>next <font color="#ff0000" size="3">red</font>');
    expect(sanitise('<div style="text-align: center; color: rgb(0, 0, 255)">x</div>')).toBe('<div style="text-align: center; color: rgb(0, 0, 255);">x</div>');
    expect(sanitise('<a href="https://konium.app/">site</a>')).toBe('<a href="https://konium.app/">site</a>');
    expect(sanitise('1 &lt; 2 &amp; 3 &gt; 2')).toBe('1 &lt; 2 &amp; 3 &gt; 2');
  });

  it('a diagram with such labels opens, its labels shown as text', () => {
    const cells = hostile.map((h, i) => `<mxCell id="c${i}" value="${h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="60" y="${40 + i * 90}" width="320" height="60" as="geometry"/></mxCell>`).join('');
    const d = readDrawio(new TextEncoder().encode(`<mxfile host="x"><diagram id="d" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`), 'A.drawio');
    expect(cellsOf(d.pages[0]!).filter((c) => c.vertex).length).toBe(hostile.length);
  });
});

describe('links and titles made of what a file says (26.170)', () => {
  it('an address is a link only when it is a web address', () => {
    expect(webLink('https://www.lcsc.com/product-detail/C1.html')).toBe('https://www.lcsc.com/product-detail/C1.html');
    expect(webLink(' http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1');
    for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', '//example.com', 'example.com', 'https://a b', '', null, undefined]) expect(webLink(u), String(u)).toBe('');
  });

  it("the print page's title and its pages' names are written as text", () => {
    const html = svgPagesHtml([{ name: 'A</title><script>window.x=1</script>"onload="x.SchDoc', svg: '<svg></svg>', box: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }]);
    expect(tags(html).map((t) => t.tag).filter((t) => t === 'script')).toEqual([]);
    expect(handlers(html)).toEqual([]);
    expect(html).toContain('<title>A&lt;/title&gt;&lt;script&gt;window.x=1&lt;/script&gt;&quot;onload=&quot;x.SchDoc</title>');
  });

  it("the app's page refuses script written into an attribute, whatever put it there", () => {
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="script-src-attr 'none'" />`);
    // Konium has none of its own
    expect(handlers(page.replace(/<!--[\s\S]*?-->/g, ''))).toEqual([]);
  });
});

describe('the library editors and the requirements of the selection (26.170)', () => {
  it('a library has no parts of a design and no nets: nothing to link, and nothing read from a board or a sheet it is not', () => {
    const demo = demoFiles();
    const file = (n: string) => demo.find((f) => f.name === n)!.bytes;
    const pcbLib = openPcbLib(file('Demo.PcbLib'), 'Demo.PcbLib'), schLib = openSchLib(file('Demo.SchLib'), 'Demo.SchLib');
    const pe = new PcbLibEditor(pcbLib), se = new SchLibEditor(schLib);
    const was = [docs.value, activeId.value] as const;
    try {
      for (const [doc, editor] of [[pcbLib, pe], [schLib, se]] as const) {
        docs.value = [{ id: 'd1', name: doc.name, doc, editor } as unknown as OpenDoc];
        activeId.value = 'd1';
        (editor as unknown as { selectAll(): void }).selectAll();
        expect(editor.selection.size, doc.name).toBeGreaterThan(0);
        expect(selectionLinks(), doc.name).toEqual([]);
      }
    } finally { docs.value = was[0]; activeId.value = was[1]; }
  });
});

describe('files cut short and character references that name no character (26.170)', () => {
  const xml = `<?xml version="1.0"?><!-- c --><eagle version="9.6"><drawing><layers><layer number="1" name="Top" color='4'/></layers><board><elements><element name="R1" value="10k &amp; more" x="1.5" y = "2"><attribute name="A" value="b"/></element></elements><![CDATA[x<y]]></board></drawing></eagle>`;

  it('both XML readers end at the end of a file cut anywhere (they began again from its start, for ever)', () => {
    for (let n = 0; n <= xml.length; n++) {
      const cut = xml.slice(0, n);
      expect(() => parseXml(cut), `parseXml at ${n}`).not.toThrow();
      try { parseTree(cut); } catch (e) { expect((e as Error).message, `parseTree at ${n}`).toBe('No XML element'); }
    }
    // Cut inside a quoted value, a closing tag and an empty element's end: what was read is there
    const el = (t: string) => parseXml(t).children[0]!;
    expect(el('<a b="1" c="unfinished').attrs).toEqual({ b: '1', c: 'unfinished' });
    expect(el('<a><b/></a').children.map((c) => c.name)).toEqual(['b']);
    expect(el('<a b="1" /').attrs).toEqual({ b: '1' });
    expect(parseTree('<a b="1" c="unfinished').root.attrs).toEqual([['b', '1'], ['c', 'unfinished']]);
    // The whole file as before
    expect(parseXml(xml).children[0]!.name).toBe('eagle');
  });

  it("a reference to no character is the replacement character, not an error that stops the file", () => {
    expect(charOf(0x20ac)).toBe('€');
    for (const n of [0x110000, 99999999999, -1, 0, NaN, 1.5]) expect(charOf(n), String(n)).toBe('�');
    expect(unescapeXml('a&#8364;b&#x20AC;c&#1114112;d&#xFFFFFFFF;e&amp;')).toBe('a€b€c�d�e&');
    expect(parseXml('<a v="&#99999999;"/>').children[0]!.attrs.v).toBe('�');
    expect(sanitise('x&#99999999;y')).toBe('x&#99999999;y');
  });
});

describe('damaged files said as damaged (26.170)', () => {
  it('a requirements document cut short, and a spreadsheet whose list of contents points past its end', async () => {
    expect(() => readReqDoc(new TextEncoder().encode('{"koniumRequirements": 1, "rows": [{"kind": "req", "id": "REQ-0'), 'A.ReqDoc')).toThrow(/^A\.ReqDoc is damaged, or cut short: /);
    const xlsx = demoFiles().find((f) => /\.xlsx$/i.test(f.name))!.bytes.slice();
    // The end record's place for the list of contents: past the file's end
    let eocd = -1;
    for (let i = xlsx.length - 22; i >= 0; i--) if (xlsx[i] === 0x50 && xlsx[i + 1] === 0x4b && xlsx[i + 2] === 5 && xlsx[i + 3] === 6) { eocd = i; break; }
    expect(eocd).toBeGreaterThan(0);
    xlsx.set([0xff, 0xff, 0xff, 0x7f], eocd + 16);
    await expect(readXlsx(xlsx)).rejects.toThrow('The file is damaged: its list of contents points past its end');
  });
});

describe('lists longer than a call takes arguments (26.170)', () => {
  it('a routing session\'s worth of tracks is added to a board in one step, and taken back', () => {
    const big = Array.from({ length: 150_000 }, (_, i) => i);
    // What the old way did with as many
    expect(() => { const a: number[] = []; a.push(...big); }).toThrow(RangeError);
    const to: number[] = [1];
    pushAll(to, big);
    expect([to.length, to[1], to[150_000]]).toEqual([150_001, 0, 149_999]);

    const board = readPcbDoc(demoFiles().find((f) => f.name === 'Demo.PcbDoc')!.bytes, 'Demo.PcbDoc');
    const before = board.prims.length;
    const layer = board.prims.find((p) => p.kind === 'track')!.layer;
    const step = addTracks(board, big.map((i) => ({ layer, a: { x: i * 100, y: 0 }, b: { x: i * 100 + 50, y: 0 }, width: 100000 })));
    step.apply();
    expect(board.prims.length).toBe(before + 150_000);
    step.revert();
    expect(board.prims.length).toBe(before);
  }, 120_000);
});
