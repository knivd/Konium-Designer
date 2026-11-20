import { describe, expect, it } from 'vitest';
import { addVertex, cells, change, copyCells, edgeRoute, groupCells, labelPoint, labelText, layout, moveCells, newDrawio, pageName, pasteCells, portPoint, readDrawio, readModel, reparentCells, resizeCell, setLabelPosition, setModelAttr, Style, ungroupCells } from '../src/formats/drawio';
import { vsdxToDiagram } from '../src/formats/vsdx';
import { zip } from '../src/formats/zip';
import { ELECTRICAL } from '../src/app/diagram/electrical';
import { LIBRARIES } from '../src/app/diagram/library';
import { insertEntry } from '../src/app/diagram/ops';
import viewSrc from '../src/app/DiagramView.tsx?raw';

describe('Diagrams R4: lists stack their items; pictures', () => {
  it('a list\'s items one under another, as wide as the list; the list grows with an item dropped in and shrinks when one goes', () => {
    const d = newDrawio('L.DgmDoc');
    const entries = LIBRARIES.flatMap((l) => l.entries);
    let ids: string[] = [], item = '';
    change(d, 'List', () => { ids = insertEntry(d.pages[0]!, entries.find((e) => e.title === 'List')!, { x: 100, y: 100 }); }, d.pages[0]);
    change(d, 'Item', () => { item = addVertex(d.pages[0]!, { x: 400, y: 400, w: 80, h: 30 }, 'Item 4', entries.find((e) => e.title === 'List Item')!.style); }, d.pages[0]);
    change(d, 'Into', () => reparentCells(d.pages[0]!, [item], ids[0]!), d.pages[0]);
    let all = cells(d.pages[0]!);
    const kids = all.filter((c) => c.parent === ids[0]);
    expect(kids.map((c) => [c.value, c.rect.x, c.rect.y, c.rect.w])).toEqual([['Item 1', 0, 30, 140], ['Item 2', 0, 60, 140], ['Item 3', 0, 90, 140], ['Item 4', 0, 120, 140]]);
    expect(all.find((c) => c.id === ids[0])!.rect.h).toBe(150);
    change(d, 'Out', () => reparentCells(d.pages[0]!, [ids[1]!], '1'), d.pages[0]);
    all = cells(d.pages[0]!);
    expect(all.filter((c) => c.parent === ids[0]).map((c) => c.rect.y)).toEqual([30, 60, 90]);
    expect(all.find((c) => c.id === ids[0])!.rect.h).toBe(120);
  });

  it('Insert › Image and pictures dropped on the page: kept in the file', () => {
    expect(viewSrc).toContain("{ label: 'Image...', action: () => imageInput.current?.click() }");
    expect(viewSrc).toMatch(/image=\$\{url\.replace\(';base64,', ','\)\}/);
    expect(viewSrc).toContain('isPictureDrag(');
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const page = (body: string) => readDrawio(enc(`<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${body}</root></mxGraphModel></diagram></mxfile>`), 'T.DgmDoc');
const box = (d: ReturnType<typeof page>, id: string) => cells(d.pages[0]!).find((c) => c.id === id)!;

describe('Diagrams R4: as the other editors keep them', () => {
  it('stacks: laid out again only when a change touches them; side by side unless horizontalStack=0; a folded one left alone', () => {
    const lane = (id: string, x: number) => `<mxCell id="${id}" value="${id}" style="swimlane;" vertex="1" parent="pool"><mxGeometry x="${x}" y="23" width="120" height="377" as="geometry"/></mxCell>`;
    const d = page(`<mxCell id="pool" value="Pool" style="swimlane;childLayout=stackLayout;resizeParent=1;resizeParentMax=0;startSize=23;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="360" height="400" as="geometry"/></mxCell>${lane('a', 0)}${lane('b', 120)}${lane('c', 240)}`
      + '<mxCell id="cls" value="C" style="swimlane;childLayout=stackLayout;horizontalStack=0;startSize=26;resizeParent=1;resizeParentMax=0;" vertex="1" parent="1" collapsed="1"><mxGeometry x="400" y="10" width="160" height="26" as="geometry"><mxRectangle width="160" height="86" as="alternateBounds"/></mxGeometry></mxCell><mxCell id="f" value="x" style="text;" vertex="1" parent="cls"><mxGeometry y="26" width="160" height="60" as="geometry"/></mxCell>');
    const p = d.pages[0]!;
    // Nothing touched: as they were
    change(d, 'Grid', () => setModelAttr(p, 'grid', '0'), p);
    expect([box(d, 'pool').rect, box(d, 'c').rect, box(d, 'cls').rect.h]).toEqual([{ x: 10, y: 10, w: 360, h: 400 }, { x: 240, y: 23, w: 120, h: 377 }, 26]);
    // A lane wider: the next ones after it, below the title; the pool as wide as they are
    change(d, 'Wider', () => resizeCell(p, 'a', { x: 0, y: 23, w: 200, h: 377 }), p);
    expect(['a', 'b', 'c'].map((id) => [box(d, id).rect.x, box(d, id).rect.y, box(d, id).rect.h])).toEqual([[0, 23, 377], [200, 23, 377], [320, 23, 377]]);
    expect(box(d, 'pool').rect.w).toBe(440);
    // The folded class: its field moved, but it stays folded as it is
    change(d, 'Field', () => resizeCell(p, 'f', { x: 0, y: 26, w: 160, h: 80 }), p);
    expect(box(d, 'cls').rect.h).toBe(26);
  });

  it('ungrouping groups within groups: every shape where it was, in a parent still there', () => {
    const d = page('<mxCell id="A" vertex="1" parent="1"><mxGeometry x="130" y="130" width="40" height="40" as="geometry"/></mxCell><mxCell id="C" vertex="1" parent="1"><mxGeometry x="300" y="300" width="40" height="40" as="geometry"/></mxCell>');
    const p = d.pages[0]!;
    let g1 = '', g2 = '';
    change(d, 'G1', () => { g1 = groupCells(p, new Set(['A'])); }, p);
    change(d, 'G2', () => { g2 = groupCells(p, new Set([g1, 'C'])); }, p);
    change(d, 'Ungroup', () => ungroupCells(p, new Set([g1, g2, 'A', 'C'])), p);
    const all = cells(p), L = layout(all);
    expect(all.some((c) => c.id === g1 || c.id === g2)).toBe(false);
    expect([box(d, 'A').parent, L.abs.get('A'), box(d, 'C').parent, L.abs.get('C')]).toEqual(['1', { x: 130, y: 130, w: 40, h: 40 }, '1', { x: 300, y: 300, w: 40, h: 40 }]);
  });

  it('moving: a connector inside a moved container keeps its waypoints in it; a connector\'s label stays on its line', () => {
    const d = page('<mxCell id="pool" style="swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="200" as="geometry"/></mxCell>'
      + '<mxCell id="a" vertex="1" parent="pool"><mxGeometry x="20" y="40" width="40" height="40" as="geometry"/></mxCell><mxCell id="b" vertex="1" parent="pool"><mxGeometry x="300" y="40" width="40" height="40" as="geometry"/></mxCell>'
      + '<mxCell id="e" edge="1" source="a" target="b" parent="pool"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="150" y="120"/></Array></mxGeometry></mxCell>'
      + '<mxCell id="l" value="lbl" style="edgeLabel;" vertex="1" connectable="0" parent="e"><mxGeometry x="-0.5" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>');
    const p = d.pages[0]!;
    change(d, 'Move', () => moveCells(p, new Set(['pool', 'a', 'b', 'e', 'l']), 40, 0), p);
    expect([box(d, 'pool').rect.x, box(d, 'a').rect.x, box(d, 'e').points, box(d, 'l').rect.x]).toEqual([40, 20, [{ x: 150, y: 120 }], -0.5]);
  });

  it('copy and paste: a connector\'s label comes with it; a connector copied alone keeps its ends where they were', () => {
    const d = page('<mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="40" height="40" as="geometry"/></mxCell><mxCell id="b" vertex="1" parent="1"><mxGeometry x="200" y="0" width="40" height="40" as="geometry"/></mxCell>'
      + '<mxCell id="e" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="l" value="lbl" style="edgeLabel;" vertex="1" parent="e"><mxGeometry relative="1" as="geometry"/></mxCell>');
    const p = d.pages[0]!;
    expect(copyCells(p, new Set(['a', 'b']))).toContain('value="lbl"');
    let ids: string[] = [];
    change(d, 'Paste', () => { ids = pasteCells(p, copyCells(p, new Set(['e'])), 0, 100); }, p);
    const e = box(d, ids[0]!);
    expect([e.source, e.target, e.sourcePoint, e.targetPoint]).toEqual(['', '', { x: 40, y: 120 }, { x: 200, y: 120 }]);
    expect(cells(p).some((c) => c.parent === e.id && c.value === 'lbl')).toBe(true);
  });

  it('a connector\'s label across its line (its y), as the other editors place it; moving it puts that in its offset', () => {
    expect(labelPoint([{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 20)).toEqual({ x: 50, y: -20 });
    expect(labelPoint([{ x: 0, y: 0 }, { x: 0, y: 100 }], 0, 20)).toEqual({ x: 20, y: 50 });
    const d = page('<mxCell id="e" value="x" edge="1" parent="1"><mxGeometry x="0.5" y="20" relative="1" as="geometry"><mxPoint x="0" y="0" as="sourcePoint"/><mxPoint x="100" y="0" as="targetPoint"/></mxGeometry></mxCell>');
    change(d, 'Move Label', () => setLabelPosition(d.pages[0]!, 'e', 0, { x: 0, y: -20 }), d.pages[0]);
    expect([box(d, 'e').rect.y, box(d, 'e').offset]).toEqual([0, { x: 0, y: -20 }]);
  });

  it('connection points turned and mirrored with their shape; on the outline unless perimeter=0', () => {
    const r = { x: 0, y: 0, w: 100, h: 40 };
    const P = (st: string, f: { x: number; y: number }, per = true) => { const q = portPoint(r, Style.parse(st), f, { x: 0, y: 0 }, per); return { x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 }; };
    expect(P('', { x: 0, y: 0.5 }, false)).toEqual({ x: 0, y: 20 });
    expect(P('flipH=1;', { x: 0, y: 0.5 }, false)).toEqual({ x: 100, y: 20 });
    expect(P('rotation=90;', { x: 0, y: 0.5 }, false)).toEqual({ x: 50, y: -30 });
    expect(P('direction=south;', { x: 0, y: 0.5 }, false)).toEqual({ x: 50, y: 0 });
    // On an ellipse's outline: its box's corner onto the ellipse
    const q = P('ellipse;', { x: 1, y: 0 });
    expect(Math.hypot((q.x - 50) / 50, (q.y - 20) / 20)).toBeCloseTo(1);
    // A connector to a flipped symbol's lead: its end at the lead as drawn
    const d = page(`<mxCell id="s" style="${ELECTRICAL[0]!.style.replace(/"/g, '&quot;')}flipH=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="20" as="geometry"/></mxCell><mxCell id="e" style="exitX=0;exitY=0.5;exitPerimeter=0;" edge="1" source="s" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="300" y="10" as="targetPoint"/></mxGeometry></mxCell>`);
    const all = cells(d.pages[0]!);
    expect(edgeRoute(all.find((c) => c.id === 'e')!, layout(all))[0]).toEqual({ x: 100, y: 10 });
  });

  it('Visio text shown as written in a formatted label; page names read once', () => {
    const ns = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const files = [
      { name: 'visio/pages/pages.xml', bytes: enc(`<Pages ${ns}><Page ID="0" Name="R&amp;D"><Rel r:id="rId1"/></Page></Pages>`) },
      { name: 'visio/pages/_rels/pages.xml.rels', bytes: enc('<Relationships><Relationship Id="rId1" Target="page1.xml" Type="x"/></Relationships>') },
      { name: 'visio/pages/page1.xml', bytes: enc(`<PageContents ${ns}><Shapes><Shape ID="1"><Cell N="PinX" V="1"/><Cell N="PinY" V="1"/><Cell N="Width" V="1"/><Cell N="Height" V="1"/><Text>&lt;&lt;include&gt;&gt; a&lt;b&gt;c\nnext</Text></Shape></Shapes></PageContents>`) },
    ];
    const back = readDrawio(enc(vsdxToDiagram(zip(files)).xml), 'V.DgmDoc');
    expect(pageName(back.pages[0]!, 0)).toBe('R&D');
    expect(labelText(cells(back.pages[0]!).find((c) => c.vertex)!)).toBe('<<include>> a<b>c\nnext');
  });

  it('the editor: labels sanitised before they are edited, placeholders kept; Edit Diagram checks first; no changes mid-drag; a layer hidden lets its cells go', () => {
    for (const t of ['const text = html ? sanitise(c.value) : c.value;', 'edit.orig !== v0', 'if (!readModel(x)) return false;', 'if (dragging.current) return true;', 'placeLater.current({', 'return !!c && shown(c) && !frozen(c);']) expect(viewSrc).toContain(t);
    expect(readModel('<svg/>')).toBeNull();
  });
});
