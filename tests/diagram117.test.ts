import { describe, expect, it } from 'vitest';
import { addVertex, cells, change, drawOrder, newDrawio, orderCells, readDrawio, setCellStyle, setModelAttr, setStyles, Style, undoDiagram, writeDrawio, attr } from '../src/formats/drawio';
import { LIBRARIES, searchLibraries, sheetEntry } from '../src/app/diagram/library';
import { BUILT_IN, look, outline } from '../src/app/diagram/render';
import { clearDefaultStyle, insertEntry, pageLayout, paperOf, pageSize, setDefaultStyle, withDefaults } from '../src/app/diagram/ops';
import viewSrc from '../src/app/DiagramView.tsx?raw';
import { readStencil } from '../src/formats/stencil';
import cmdSrc from '../src/app/pcb41Commands.ts?raw';
import { detect } from '../src/formats/registry';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const entries = LIBRARIES.flatMap((l) => l.entries);

describe('Diagrams D1: the Shapes panel\'s libraries and their shapes', () => {
  it('every shape in the libraries is one Konium draws, and draws without gaps at any size or direction', () => {
    expect(entries.length).toBeGreaterThan(55);
    for (const x of entries.filter((e) => !e.edge)) {
      const s = Style.parse(x.style);
      // A built-in shape, or a stencil of its own that reads
      if (s.shape().startsWith('stencil(')) { expect(readStencil(s.shape()), x.title).not.toBeNull(); continue; }
      expect(BUILT_IN.has(s.shape()), x.title).toBe(true);
      for (const [w, h] of [[x.w, x.h], [1, 1], [400, 20], [20, 400]] as const) {
        const parts = outline(s.shape(), w, h, s);
        if (['text', 'swimlane', 'group', 'image', 'partialRectangle'].includes(s.shape())) continue;
        expect(parts, x.title).not.toBeNull();
        for (const p of parts!) expect(p.d, `${x.title} ${w}×${h}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('the format\'s named styles: a text sits top left unless its style says otherwise; a container\'s title is bold', () => {
    expect(look(Style.parse('text;html=1;'), 'align')).toBe('left');
    expect(look(Style.parse('text;html=1;align=center;'), 'align')).toBe('center');
    expect(look(Style.parse('swimlane;'), 'fontStyle')).toBe('1');
    expect(look(Style.parse('rounded=1;'), 'align')).toBeUndefined();
  });

  it('search finds shapes by name and tags; nothing for a word no shape has', () => {
    const t = searchLibraries('arrow').map((e) => e.title);
    expect(t).toEqual(expect.arrayContaining(['Arrow', 'Arrow Right', 'Double Arrow', 'Bidirectional Arrow']));
    expect(searchLibraries('database').map((e) => e.title)).toContain('Cylinder');
    expect(searchLibraries('zzzz')).toEqual([]);
  });

  it('placing entries: a list with its items inside it, a connector with its ends and waypoints, a sheet block linked; saved and read back', () => {
    const d = newDrawio('L.drawio');
    const p = d.pages[0]!;
    const list = entries.find((e) => e.title === 'List')!, curve = entries.find((e) => e.title === 'Curve')!;
    let a: string[] = [], b: string[] = [], c: string[] = [];
    change(d, 'Add', () => { a = insertEntry(p, list, { x: 100, y: 100 }); b = insertEntry(p, curve, { x: 300, y: 100 }); c = insertEntry(p, sheetEntry('Power.SchDoc'), { x: 0, y: 300 }); }, p);
    expect(a).toHaveLength(4);
    const back = readDrawio(writeDrawio(d), 'L.drawio');
    const all = cells(back.pages[0]!);
    expect(all.filter((x) => x.parent === a[0])).toHaveLength(3);
    const e = all.find((x) => x.id === b[0])!;
    expect(e.edge).toBe(true);
    expect(e.sourcePoint).toEqual({ x: 300, y: 150 });
    expect(e.targetPoint).toEqual({ x: 350, y: 100 });
    expect(e.points).toEqual([{ x: 350, y: 150 }, { x: 300, y: 100 }]);
    expect(all.find((x) => x.id === c[0])!.sheet).toBe('Power.SchDoc');
    expect(dec(writeDrawio(d))).toContain('as="sourcePoint"');
  });

  it('Set as Default Style: new shapes take its colours (a bare text keeps no fill), connectors their line; cleared, the standard style again', () => {
    setDefaultStyle('vertex', Style.parse('rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#333333;endArrow=block;'));
    setDefaultStyle('edge', Style.parse('endArrow=block;strokeColor=#ff0000;fillColor=#00ff00;'));
    const v = Style.parse(withDefaults('ellipse;whiteSpace=wrap;html=1;', 'vertex'));
    expect([v.get('fillColor'), v.get('strokeColor'), v.get('rounded'), v.get('endArrow')]).toEqual(['#dae8fc', '#6c8ebf', '1', undefined]);
    const t = Style.parse(withDefaults('text;strokeColor=none;fillColor=none;', 'vertex'));
    expect([t.get('fillColor'), t.get('fontColor')]).toEqual(['none', '#333333']);
    const e = Style.parse(withDefaults('endArrow=classic;html=1;', 'edge'));
    expect([e.get('endArrow'), e.get('strokeColor'), e.get('fillColor')]).toEqual(['block', '#ff0000', undefined]);
    clearDefaultStyle();
    expect(withDefaults('ellipse;', 'vertex')).toBe('ellipse;');
  });
});

describe('Diagrams D1: order, styles, paper', () => {
  const FILE = '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />'
    + '<mxCell id="g" value="" style="swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="200" as="geometry" /></mxCell>'
    + '<mxCell id="a" value="A" style="" vertex="1" parent="1"><mxGeometry x="10" y="10" width="10" height="10" as="geometry" /></mxCell>'
    + '<mxCell id="k1" value="" style="" vertex="1" parent="g"><mxGeometry x="10" y="30" width="10" height="10" as="geometry" /></mxCell>'
    + '<mxCell id="b" value="B" style="" vertex="1" parent="1"><mxGeometry x="10" y="10" width="10" height="10" as="geometry" /></mxCell>'
    + '<mxCell id="k2" value="" style="" vertex="1" parent="g"><mxGeometry x="10" y="60" width="10" height="10" as="geometry" /></mxCell>'
    + '<mxCell id="c" value="C" style="" vertex="1" parent="1"><mxGeometry x="10" y="10" width="10" height="10" as="geometry" /></mxCell>'
    + '</root></mxGraphModel></diagram></mxfile>';
  const ids = (d: ReturnType<typeof readDrawio>) => cells(d.pages[0]!).map((c) => c.id).join(' ');

  it('to front, to back, a step forward or backward: among the cells of the same parent, the others kept in place', () => {
    const d = readDrawio(enc(FILE), 'o.drawio');
    const p = d.pages[0]!;
    change(d, 'Front', () => orderCells(p, new Set(['a']), 'front'), p);
    expect(ids(d)).toBe('0 1 g b k1 c k2 a');
    change(d, 'Back', () => orderCells(p, new Set(['c', 'k2']), 'back'), p);
    expect(ids(d)).toBe('0 1 c g k2 b k1 a');
    change(d, 'Forward', () => orderCells(p, new Set(['c']), 'forward'), p);
    expect(ids(d)).toBe('0 1 g c k2 b k1 a');
    change(d, 'Backward', () => orderCells(p, new Set(['a']), 'backward'), p);
    expect(ids(d)).toBe('0 1 g c k2 a k1 b');
    for (let i = 0; i < 4; i++) undoDiagram(d);
    expect(ids(d)).toBe('0 1 g a k1 b k2 c');
  });

  it('drawn in the format\'s order: a container\'s cells right after it, whatever order the file lists them in', () => {
    const d = readDrawio(enc(FILE), 'o.drawio');
    expect(drawOrder(cells(d.pages[0]!)).map((c) => c.id).join(' ')).toBe('0 1 g k1 k2 a b c');
  });

  it('styles: several keys at once, a whole style replaced; page options are the model\'s attributes', () => {
    const d = readDrawio(enc(FILE), 'o.drawio');
    const p = d.pages[0]!;
    change(d, 'Quick Style', () => setStyles(p, ['a', 'b'], { fillColor: '#dae8fc', strokeColor: '#6c8ebf', gradientColor: null }), p);
    change(d, 'Edit Style', () => setCellStyle(p, ['c'], 'ellipse;fillColor=#ffcccc'), p);
    change(d, 'Paper', () => { setModelAttr(p, 'pageWidth', '827'); setModelAttr(p, 'pageHeight', '1169'); setModelAttr(p, 'page', '0'); }, p);
    const out = dec(writeDrawio(d));
    expect(out).toContain('id="a" value="A" style="fillColor=#dae8fc;strokeColor=#6c8ebf;"');
    expect(out).toContain('style="ellipse;fillColor=#ffcccc;"');
    expect(out).toMatch(/<mxGraphModel[^>]*pageWidth="827"[^>]*pageHeight="1169"[^>]*page="0"/);
    expect(attr(readDrawio(enc(out), 'o.drawio').pages[0]!.model, 'page')).toBe('0');
  });

  it('paper: the standard sizes either way round; the page view\'s pages cover what is drawn', () => {
    expect(paperOf(1169, 827)).toEqual({ id: 'a4', landscape: true });
    expect(paperOf(850, 1100)).toEqual({ id: 'letter', landscape: false });
    expect(paperOf(1000, 1000).id).toBe('custom');
    const d = newDrawio('n.drawio');
    expect(pageSize(d.pages[0]!.model)).toEqual({ w: 1169, h: 827 });
    expect(pageLayout({ w: 100, h: 50 }, null)).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);
    expect(pageLayout({ w: 100, h: 50 }, { x: 10, y: 10, w: 150, h: 20 })).toHaveLength(2);
    expect(pageLayout({ w: 100, h: 50 }, { x: -30, y: 10, w: 20, h: 60 })).toEqual([{ x: -100, y: 0, w: 100, h: 50 }, { x: -100, y: 50, w: 100, h: 50 }]);
  });

  it('the editor: the Shapes panel, the toolbar and the Format panel', () => {
    expect(viewSrc).toMatch(/<Sidebar libs=\{libs\} onPress=\{pressEntry\} \/>/);
    for (const t of ['To Front (Ctrl+Shift+F)', 'To Back (Ctrl+Shift+B)', 'Fill Colour', 'Line Colour', "'Shadow'", 'Waypoints', 'Insert', 'Format Panel (Ctrl+Shift+P)']) expect(viewSrc).toContain(t);
    expect(viewSrc).toMatch(/<Format d=\{d\} page=\{page\}/);
  });
});

describe('Diagrams: Konium\'s own file type', () => {
  it('a new diagram is a .DgmDoc; .DgmDoc and .drawio files open as diagrams', () => {
    expect(cmdSrc).toMatch(/freshName\('Diagram', 'DgmDoc'\)/);
    const xml = enc(dec(writeDrawio(newDrawio('A.DgmDoc'))));
    expect(detect(xml, 'A.DgmDoc')).toBe('Diagram');
    expect(detect(xml, 'B.drawio')).toBe('Diagram');
    expect(detect(enc('<x/>'), 'C.dgmdoc')).toBe('Diagram');
  });
});

void addVertex;
