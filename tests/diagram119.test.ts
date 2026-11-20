import { describe, expect, it } from 'vitest';
import { cells, change, edgeRoute, layout, nearestOnRoute, perimeterPoint, readDrawio, routeKind, setEdgePoints, setLabelPosition, setTerminal, Style, writeDrawio } from '../src/formats/drawio';
import { crossings } from '../src/app/diagram/geometry';
import { waypointKeys, waypointsOf } from '../src/app/diagram/Format';
import viewSrc from '../src/app/DiagramView.tsx?raw';

const enc = (s: string) => new TextEncoder().encode(s);
const doc = (cellsXml: string) => readDrawio(enc(`<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${cellsXml}</root></mxGraphModel></diagram></mxfile>`), 'T.DgmDoc');
const v = (id: string, style: string, x: number, y: number, w: number, h: number) => `<mxCell id="${id}" value="" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" /></mxCell>`;
const e = (id: string, style: string, s: string, t: string, pts = '') => `<mxCell id="${id}" style="${style}" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry">${pts}</mxGeometry></mxCell>`;
const route = (d: ReturnType<typeof doc>, id: string) => { const list = cells(d.pages[0]!); return edgeRoute(list.find((c) => c.id === id)!, layout(list)).map((q) => ({ x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 })); };

describe('Diagrams D3: where connectors meet shapes', () => {
  it('an ellipse, a diamond and a turned box: on their outlines, not their boxes', () => {
    const r = { x: 0, y: 0, w: 100, h: 50 };
    const el = perimeterPoint(r, Style.parse('ellipse;'), { x: 200, y: 125 });
    expect(((el.x - 50) / 50) ** 2 + ((el.y - 25) / 25) ** 2).toBeCloseTo(1);
    const dia = perimeterPoint(r, Style.parse('rhombus;'), { x: 100, y: 50 });
    expect([dia.x, dia.y]).toEqual([75, 37.5]);
    const box = perimeterPoint(r, Style.parse('rotation=90;'), { x: 50, y: -100 });
    expect([Math.round(box.x), Math.round(box.y)]).toEqual([50, -25]);
    expect(perimeterPoint(r, Style.parse(''), { x: 300, y: 25 })).toEqual({ x: 100, y: 25 });
  });

  it('routes: a fixed end leaves its side square to it; Simple bends once; Entity Relation goes out sideways first', () => {
    const shapes = v('a', '', 0, 0, 100, 40) + v('b', '', 300, 200, 100, 40);
    const d1 = doc(shapes + e('x', 'edgeStyle=orthogonalEdgeStyle;exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;', 'a', 'b'));
    const r1 = route(d1, 'x');
    expect(r1[0]).toEqual({ x: 50, y: 0 });
    expect(r1[1]!.x).toBe(50); expect(r1[1]!.y).toBeLessThan(0);
    expect(r1[r1.length - 1]).toEqual({ x: 300, y: 220 });
    expect(r1[r1.length - 2]!.y).toBe(220);
    for (let i = 1; i < r1.length; i++) expect(r1[i]!.x === r1[i - 1]!.x || r1[i]!.y === r1[i - 1]!.y).toBe(true);
    const d2 = doc(shapes + e('x', 'edgeStyle=elbowEdgeStyle;', 'a', 'b'));
    expect(route(d2, 'x')).toEqual([{ x: 100, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 220 }, { x: 300, y: 220 }]);
    const d3 = doc(shapes + e('x', 'edgeStyle=elbowEdgeStyle;elbow=vertical;', 'a', 'b'));
    expect(route(d3, 'x')).toEqual([{ x: 50, y: 40 }, { x: 50, y: 120 }, { x: 350, y: 120 }, { x: 350, y: 200 }]);
    const d4 = doc(shapes + e('x', 'edgeStyle=entityRelationEdgeStyle;', 'a', 'b'));
    expect(route(d4, 'x')).toEqual([{ x: 100, y: 20 }, { x: 130, y: 20 }, { x: 270, y: 220 }, { x: 300, y: 220 }]);
    expect(routeKind(Style.parse('edgeStyle=isometricEdgeStyle;'))).toBe('isometric');
  });

  it('the Waypoints choices write the format\'s edge styles and read back', () => {
    for (const k of ['straight', 'orthogonal', 'elbow', 'elbowVertical', 'isometric', 'curved', 'entityRelation']) {
      const st = Style.parse('html=1;');
      for (const [kk, vv] of Object.entries(waypointKeys(k))) st.set(kk, vv);
      expect(waypointsOf(st), k).toBe(k);
    }
  });
});

describe('Diagrams D3: changing connectors', () => {
  it('an end moved onto another shape at a connection point, then left loose; waypoints set and cleared; a label placed', () => {
    const d = doc(v('a', '', 0, 0, 100, 40) + v('b', '', 300, 0, 100, 40) + v('c', 'ellipse;', 0, 200, 100, 40) + e('x', 'endArrow=classic;', 'a', 'b'));
    const p = d.pages[0]!;
    change(d, 'End', () => setTerminal(p, 'x', false, 'c', undefined, { x: 0.5, y: 0 }), p);
    let x = cells(p).find((c) => c.id === 'x')!;
    expect([x.target, x.style.get('entryX'), x.style.get('entryY')]).toEqual(['c', '0.5', '0']);
    expect(route(d, 'x').at(-1)).toEqual({ x: 50, y: 200 });
    change(d, 'Loose', () => setTerminal(p, 'x', true, null, { x: -40, y: 20 }), p);
    x = cells(p).find((c) => c.id === 'x')!;
    expect([x.source, x.sourcePoint]).toEqual(['', { x: -40, y: 20 }]);
    change(d, 'Points', () => setEdgePoints(p, 'x', [{ x: 10, y: 100 }, { x: 60, y: 100 }]), p);
    change(d, 'Label', () => setLabelPosition(p, 'x', -0.5, { x: 0, y: -12 }), p);
    const back = readDrawio(writeDrawio(d), 'T.DgmDoc');
    x = cells(back.pages[0]!).find((c) => c.id === 'x')!;
    expect([x.points, x.rect.x, x.offset]).toEqual([[{ x: 10, y: 100 }, { x: 60, y: 100 }], -0.5, { x: 0, y: -12 }]);
    change(back, 'Clear', () => setEdgePoints(back.pages[0]!, 'x', []), back.pages[0]);
    expect(cells(back.pages[0]!).find((c) => c.id === 'x')!.points).toEqual([]);
  });

  it('nearest on a route; where routes cross (not at their ends)', () => {
    const r = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const n = nearestOnRoute(r, { x: 110, y: 50 });
    expect(n.at).toEqual({ x: 100, y: 50 });
    expect(n.along).toBeCloseTo(0.5);
    expect(crossings([{ x: 50, y: -50 }, { x: 50, y: 50 }], [r])).toEqual([{ x: 50, y: 0 }]);
    expect(crossings([{ x: 0, y: 0 }, { x: 0, y: 50 }], [r])).toEqual([]);
  });

  it('the editor: a picked connector\'s ends, waypoints, segments and label handles; line jumps drawn', () => {
    for (const t of ['downEnd(', 'downPoint(', 'removePoint(', 'downLabel(', 'jumpsOf(', 'dg-segment', 'dg-vbend']) expect(viewSrc).toContain(t);
  });
});
