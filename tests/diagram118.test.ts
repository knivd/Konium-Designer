import { describe, expect, it } from 'vitest';
import {
  addLayer, alignCells, cells, change, copyCells, defaultLayer, distributeCells, groupCells, layers, layout, moveToLayer, pasteCells, readDrawio, reparentCells, setLayer, ungroupCells,
  undoDiagram, writeDrawio, Style, type DrawioDocument,
} from '../src/formats/drawio';
import { connectionPoints, guideSnap, resizeBy, turn } from '../src/app/diagram/geometry';
import viewSrc from '../src/app/DiagramView.tsx?raw';

const enc = (s: string) => new TextEncoder().encode(s);
const FILE = '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />'
  + '<mxCell id="box" value="Box" style="swimlane;" vertex="1" parent="1"><mxGeometry x="300" y="100" width="200" height="200" as="geometry" /></mxCell>'
  + '<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry" /></mxCell>'
  + '<mxCell id="b" value="B" style="" vertex="1" parent="1"><mxGeometry x="40" y="140" width="80" height="40" as="geometry" /></mxCell>'
  + '<mxCell id="c" value="C" style="" vertex="1" parent="1"><mxGeometry x="200" y="400" width="40" height="40" as="geometry" /></mxCell>'
  + '<mxCell id="ab" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="20" y="110" /></Array></mxGeometry></mxCell>'
  + '<mxCell id="in" value="In" style="" vertex="1" parent="box"><mxGeometry x="20" y="40" width="60" height="30" as="geometry" /></mxCell>'
  + '</root></mxGraphModel></diagram></mxfile>';
const open = () => readDrawio(enc(FILE), 'T.DgmDoc');
const abs = (d: DrawioDocument, id: string) => layout(cells(d.pages[0]!)).abs.get(id)!;

describe('Diagrams D2: copy and paste, groups, containers', () => {
  it('copy and paste: new ids, moved by the offset, the connector between copied shapes kept (with its waypoints), a container\'s cells with it', () => {
    const d = open(); const p = d.pages[0]!;
    const xml = copyCells(p, new Set(['a', 'b', 'box']));
    let ids: string[] = [];
    change(d, 'Paste', () => { ids = pasteCells(p, xml, 20, 20); }, p);
    const all = cells(p);
    expect(ids).toHaveLength(4);
    expect(ids.some((id) => ['a', 'b', 'box', 'ab'].includes(id))).toBe(false);
    const a2 = all.find((c) => ids.includes(c.id) && c.value === 'A')!, b2 = all.find((c) => ids.includes(c.id) && c.value === 'B')!;
    expect(a2.rect).toEqual({ x: 60, y: 60, w: 80, h: 40 });
    const e2 = all.find((c) => ids.includes(c.id) && c.edge)!;
    expect([e2.source, e2.target, e2.points]).toEqual([a2.id, b2.id, [{ x: 40, y: 130 }]]);
    const box2 = all.find((c) => ids.includes(c.id) && c.value === 'Box')!;
    const in2 = all.find((c) => c.parent === box2.id)!;
    expect([in2.value, in2.rect.x, in2.rect.y]).toEqual(['In', 20, 40]);
    // A cell inside a container copied alone: pasted where it was on the page
    let one: string[] = [];
    change(d, 'Paste', () => { one = pasteCells(p, copyCells(p, new Set(['in'])), 0, 0); }, p);
    expect(abs(d, one[0]!)).toEqual(abs(d, 'in'));
    expect(cells(p).find((c) => c.id === one[0])!.parent).toBe('1');
  });

  it('group and ungroup: a group cell round them (the connector between them inside it); taken apart, everything where it was', () => {
    const d = open(); const p = d.pages[0]!;
    const before = ['a', 'b'].map((id) => abs(d, id));
    let g = '';
    change(d, 'Group', () => { g = groupCells(p, new Set(['a', 'b'])); }, p);
    const all = cells(p);
    // Its box: the shapes and the connector's waypoint
    expect(all.find((c) => c.id === g)!.rect).toEqual({ x: 20, y: 40, w: 100, h: 140 });
    expect(all.filter((c) => c.parent === g).map((c) => c.id).sort()).toEqual(['a', 'ab', 'b']);
    expect(['a', 'b'].map((id) => abs(d, id))).toEqual(before);
    expect(all.find((c) => c.id === 'ab')!.points).toEqual([{ x: 0, y: 70 }]);
    // In the file, the group before its cells
    const order = all.map((c) => c.id);
    expect(order.indexOf(g)).toBeLessThan(order.indexOf('a'));
    change(d, 'Ungroup', () => ungroupCells(p, new Set([g])), p);
    expect(cells(p).some((c) => c.id === g)).toBe(false);
    expect(['a', 'b'].map((id) => abs(d, id))).toEqual(before);
    expect(cells(p).find((c) => c.id === 'ab')!.points).toEqual([{ x: 20, y: 110 }]);
  });

  it('into a container and out again, staying where it is on the page; undone', () => {
    const d = open(); const p = d.pages[0]!;
    const at = abs(d, 'c');
    change(d, 'Into', () => reparentCells(p, ['c'], 'box'), p);
    const c = cells(p).find((x) => x.id === 'c')!;
    expect([c.parent, c.rect.x, c.rect.y]).toEqual(['box', -100, 300]);
    expect(abs(d, 'c')).toEqual(at);
    change(d, 'Out', () => reparentCells(p, ['in'], '1'), p);
    expect(abs(d, 'in')).toEqual({ x: 320, y: 140, w: 60, h: 30 });
    // Never into itself or its own cells
    change(d, 'Loop', () => reparentCells(p, ['box'], 'c'), p);
    expect(cells(p).find((x) => x.id === 'box')!.parent).toBe('1');
    undoDiagram(d); undoDiagram(d); undoDiagram(d);
    expect(cells(d.pages[0]!).find((x) => x.id === 'c')!.parent).toBe('1');
  });
});

describe('Diagrams D2: align, distribute, layers', () => {
  it('align on the selection\'s bounds; distribute the centres evenly', () => {
    const d = open(); const p = d.pages[0]!;
    change(d, 'Align', () => alignCells(p, new Set(['a', 'c']), 'right'), p);
    expect([abs(d, 'a').x + 80, abs(d, 'c').x + 40]).toEqual([240, 240]);
    change(d, 'Align', () => alignCells(p, new Set(['a', 'b', 'c']), 'middle'), p);
    expect(new Set(['a', 'b', 'c'].map((id) => abs(d, id).y + abs(d, id).h / 2)).size).toBe(1);
    const d2 = open(); const p2 = d2.pages[0]!;
    change(d2, 'Distribute', () => distributeCells(p2, new Set(['a', 'b', 'c']), false), p2);
    const mids = ['a', 'b', 'c'].map((id) => abs(d2, id).y + abs(d2, id).h / 2);
    expect(mids[1]! - mids[0]!).toBeCloseTo(mids[2]! - mids[1]!);
  });

  it('layers: added, hidden, locked, the one picked takes new cells, cells moved to one; written as the format keeps them', () => {
    const d = open(); const p = d.pages[0]!;
    let id = '';
    change(d, 'Add Layer', () => { id = addLayer(p, 'Notes'); }, p);
    expect(layers(p).map((l) => l.name)).toEqual(['Background', 'Notes']);
    p.current = id;
    expect(defaultLayer(p)).toBe(id);
    change(d, 'Move', () => moveToLayer(p, new Set(['a']), id), p);
    change(d, 'Hide', () => { setLayer(p, id, 'visible', false); setLayer(p, id, 'locked', true); }, p);
    const out = new TextDecoder().decode(writeDrawio(d));
    expect(out).toMatch(new RegExp(`<mxCell id="${id}" value="Notes" parent="0" visible="0" style="locked=1;"`));
    expect(cells(readDrawio(enc(out), 'x').pages[0]!).find((c) => c.id === 'a')!.parent).toBe(id);
    expect(layers(p).find((l) => l.id === id)).toMatchObject({ visible: false, locked: true });
  });
});

describe('Diagrams D2: the editor\'s geometry', () => {
  it('connection points: the style\'s own, else the shape\'s', () => {
    expect(connectionPoints({ style: Style.parse('text;points=[[0,0.5],[1,0.5,0]];') })).toEqual([{ x: 0, y: 0.5, perimeter: true }, { x: 1, y: 0.5, perimeter: false }]);
    expect(connectionPoints({ style: Style.parse('ellipse;') })).toHaveLength(8);
    expect(connectionPoints({ style: Style.parse('rounded=0;') })).toHaveLength(16);
  });

  it('resizing a turned shape: the corner across from the handle stays put; Shift keeps proportions', () => {
    const r0 = { x: 0, y: 0, w: 100, h: 50 };
    const r = resizeBy(r0, 90, [1, 1], { x: -10, y: 30 }, false);
    const anchor0 = turn({ x: 0, y: 0 }, { x: 50, y: 25 }, 90), anchor1 = turn({ x: r.x, y: r.y }, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 90);
    expect(anchor1.x).toBeCloseTo(anchor0.x); expect(anchor1.y).toBeCloseTo(anchor0.y);
    expect([r.w, r.h]).toEqual([130, 60]);
    const k = resizeBy(r0, 0, [1, 1], { x: 100, y: 0 }, true);
    expect([k.w, k.h, k.x, k.y]).toEqual([200, 100, 0, 0]);
  });

  it('guides: a near edge or centre lined up, and the line to draw', () => {
    const g = guideSnap({ x: 103, y: 300, w: 50, h: 20 }, [{ x: 100, y: 0, w: 80, h: 40 }], 6);
    expect(g.dx).toBe(-3);
    expect(g.dy).toBeNull();
    expect(g.lines[0]).toMatchObject({ x1: 100, x2: 100 });
    expect(guideSnap({ x: 500, y: 500, w: 10, h: 10 }, [{ x: 0, y: 0, w: 10, h: 10 }], 6)).toEqual({ dx: null, dy: null, lines: [] });
  });

  it('the editor: hover arrows, the turning handle, guides, containers, layers, Ctrl+C / X / V / G / Shift+U / L', () => {
    for (const t of ['downArrow', 'downRotate', 'guideSnap(', 'containerAt(', '<Layers ', "'Ctrl+C'", "'Ctrl+X'", "'Ctrl+V'", "'Ctrl+G'", "'Ctrl+Shift+U'", "'Ctrl+L'", "'Ctrl+Shift+L'"]) expect(viewSrc).toContain(t);
  });
});
