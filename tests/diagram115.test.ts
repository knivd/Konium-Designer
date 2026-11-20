import { describe, expect, it } from 'vitest';
import { addPage, addVertex, cells, change, copyCells, pasteCells, readDrawio, redoDiagram, renamePage, setSheet, undoDiagram, writeDrawio } from '../src/formats/drawio';
import { MENUBAR } from '../src/app/menus/ad17.gen';
import '../src/app/menus/index';
import homeSrc from '../src/app/Home.tsx?raw';
import otherSrc from '../src/app/dialogs/Workspace42.tsx?raw';
import viewSrc from '../src/app/DiagramView.tsx?raw';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const BARE = '<mxGraphModel dx="1000" dy="600" grid="1"><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry" /></mxCell></root></mxGraphModel>\n';
const shapes = (bytes: Uint8Array, page = 0) => cells(readDrawio(bytes, 'x.drawio').pages[page]!).filter((c) => c.vertex).length;

describe('Diagrams, the corners found before R4 (26.115)', () => {
  it('an empty page: saved as it was untouched; drawn on, what is drawn is saved', () => {
    const file = '<mxfile host="x">\n  <diagram id="p1" name="Empty"></diagram>\n</mxfile>\n';
    const d = readDrawio(enc(file), 'E.drawio');
    expect(dec(writeDrawio(d))).toBe(file);
    change(d, 'Add', () => addVertex(d.pages[0]!, { x: 10, y: 10, w: 80, h: 40 }, 'New', 'rounded=1;'), d.pages[0]);
    const out = writeDrawio(d);
    expect(dec(out)).toContain('value="New"');
    expect(shapes(out)).toBe(1);
  });

  it('a page that can\'t be read: shown blank, said so, saved as it was, even after undoing on another page', () => {
    const file = '<mxfile host="x"><diagram id="p1" name="Odd">%%%not-a-page%%%</diagram><diagram id="p2" name="Two"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';
    const d = readDrawio(enc(file), 'O.drawio');
    expect(d.pages[0]!.unreadable).toBe(true);
    change(d, 'Add', () => addVertex(d.pages[1]!, { x: 0, y: 0, w: 40, h: 40 }, 'B', ''), d.pages[1]);
    undoDiagram(d);
    expect(d.pages[0]!.unreadable).toBe(true);
    expect(dec(writeDrawio(d))).toContain('%%%not-a-page%%%');
    expect(viewSrc).toMatch(/This page couldn't be read: it is saved as it was unless you draw on it/);
  });

  it('a bare mxGraphModel file: a page added or renamed makes it an mxfile (as draw.io saves it); undo takes it back, redo again', () => {
    const d = readDrawio(enc(BARE), 'B.drawio');
    change(d, 'Add Page', () => { addPage(d, 'Page-2'); });
    const two = writeDrawio(d);
    expect(dec(two)).toMatch(/^<mxfile[\s\S]*<diagram[^>]*name="Page-1"[\s\S]*<diagram[^>]*name="Page-2"/);
    const back = readDrawio(two, 'B.drawio');
    expect(back.pages).toHaveLength(2);
    expect(shapes(two, 0)).toBe(1);
    undoDiagram(d);
    expect(dec(writeDrawio(d))).toBe(BARE);
    redoDiagram(d);
    expect(readDrawio(writeDrawio(d), 'B.drawio').pages).toHaveLength(2);
    const r = readDrawio(enc(BARE), 'R.drawio');
    change(r, 'Rename Page', () => renamePage(r, r.pages[0]!, 'Overview'), r.pages[0]);
    expect(dec(writeDrawio(r))).toMatch(/<diagram[^>]*name="Overview"/);
  });

  it('a duplicate keeps its block\'s linked sheet (26.118: Ctrl+D copies and pastes, the UserObject with it)', () => {
    expect(viewSrc).toMatch(/const xml = copyCells\(page, sel\);[\s\S]{0,120}pasteCells\(page, xml, grid, grid\)/);
    const d = readDrawio(enc(BARE), 'S.drawio');
    const p = d.pages[0]!;
    change(d, 'Link', () => setSheet(p, 'a', 'Power.SchDoc'), p);
    let ids: string[] = [];
    change(d, 'Duplicate', () => { ids = pasteCells(p, copyCells(p, new Set(['a'])), 10, 10); }, p);
    const copy = cells(p).find((c) => c.id === ids[0])!;
    expect([copy.sheet, copy.rect.x, copy.value]).toEqual(['Power.SchDoc', 50, 'A']);
  });

  it('File › New › Diagram everywhere: the general File menu too, the Home page, Add New to Project › Other', () => {
    const has = (bar: string) => JSON.stringify(MENUBAR[bar]).includes('"file.newDiagram"');
    expect(has('global')).toBe(true);
    expect(has('sch')).toBe(true);
    expect(homeSrc).toMatch(/run\('file\.newDiagram'\)/);
    expect(otherSrc).toMatch(/\['Diagram', 'Diagram', 'diagramDoc'\]/);
  });
});
