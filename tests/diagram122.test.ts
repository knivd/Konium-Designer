import { describe, expect, it } from 'vitest';
import { addEdge, addVertex, cells, change, layout, newDrawio, readDrawio, Style } from '../src/formats/drawio';
import { readStencil, stencilStyle, stencilXml } from '../src/formats/stencil';
import { vsdxToDiagram, isVsdx } from '../src/formats/vsdx';
import { zip } from '../src/formats/zip';
import { IMPORTERS } from '../src/formats/importers';
import { ELECTRICAL } from '../src/app/diagram/electrical';
import { diagramToVsdx, flattenPath } from '../src/app/diagram/vsdx';
import { extrasMenu } from '../src/app/diagram/menus';

const enc = (s: string) => new TextEncoder().encode(s);
const XML = '<shape name="t" w="40" h="20" aspect="fixed" strokewidth="inherit"><connections><constraint x="0" y="0.5" perimeter="0"/></connections><background/><foreground><path><move x="0" y="10"/><line x="40" y="10"/></path><stroke/><ellipse x="10" y="0" w="20" h="20"/><fillstroke/></foreground></shape>';

describe('Diagrams D6: stencils', () => {
  it('a stencil written into a style and read back; one the other editors compressed is read too', async () => {
    const shape = stencilStyle(XML);
    expect(shape).toMatch(/^stencil\([A-Za-z0-9+/=]+\)$/);
    expect(stencilXml(shape)).toBe(XML);
    const st = readStencil(shape)!;
    expect([st.w, st.h, st.aspect, st.points, st.foreground.map((o) => o.k)]).toEqual([40, 20, 'fixed', [{ x: 0, y: 0.5 }], ['path', 'paint', 'path', 'paint']]);
    const packed = new Uint8Array(await new Response(new Blob([encodeURIComponent(XML)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const squeezed = `stencil(${btoa(String.fromCharCode(...packed))})`;
    expect(readStencil(squeezed)!.w).toBe(40);
    // In a style, its base64 survives the style's parsing
    expect(Style.parse(`shape=${shape};html=1;`).shape()).toBe(shape);
  });

  it('the Electrical library: every symbol reads, its connection points on its box', () => {
    expect(ELECTRICAL.length).toBe(37);
    for (const e of ELECTRICAL) {
      const st = readStencil(Style.parse(e.style).shape());
      expect(st, e.title).not.toBeNull();
      expect(st!.points.length, e.title).toBeGreaterThan(0);
      for (const q of st!.points) expect(q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1, e.title).toBe(true);
    }
  });
});

describe('Diagrams D6: Visio drawings', () => {
  const sample = () => {
    const d = newDrawio('V.DgmDoc');
    const p = d.pages[0]!;
    change(d, 'x', () => {
      const a = addVertex(p, { x: 100, y: 100, w: 120, h: 60 }, 'Box', 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;');
      const b = addVertex(p, { x: 400, y: 300, w: 100, h: 50 }, 'Oval', 'ellipse;whiteSpace=wrap;html=1;');
      addVertex(p, { x: 600, y: 100, w: 100, h: 20 }, 'R1', ELECTRICAL[0]!.style);
      addVertex(p, { x: 100, y: 400, w: 60, h: 80 }, '', 'triangle;whiteSpace=wrap;html=1;rotation=30;');
      addEdge(p, a, b, 'edgeStyle=orthogonalEdgeStyle;html=1;');
    }, p);
    return d;
  };

  it('written as a Visio drawing: a package of its parts, each shape and connector, glued', () => {
    const { bytes } = diagramToVsdx(sample());
    expect(isVsdx(bytes)).toBe(true);
    const text = new TextDecoder('latin1').decode(bytes);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'visio/document.xml', 'visio/pages/pages.xml', 'visio/pages/page1.xml']) expect(text).toContain(part);
    expect(text).toContain('<Connect FromSheet="5" FromCell="BeginX" FromPart="9" ToSheet="1" ToCell="PinX" ToPart="3"/>');
    expect(text).toContain('<Row T="Ellipse" IX="1">');
  });

  it('read back: the same shapes in the same places, the connector on the same shapes, the text below the symbol', () => {
    const d = sample();
    const back = readDrawio(enc(vsdxToDiagram(diagramToVsdx(d).bytes).xml), 'B.DgmDoc');
    const all = cells(back.pages[0]!), L = layout(all);
    const v = all.filter((c) => c.vertex);
    expect(v.map((c) => c.value)).toEqual(['Box', 'Oval', 'R1', '']);
    expect(L.abs.get(v[0]!.id)).toEqual({ x: 100, y: 100, w: 120, h: 60 });
    expect(v[0]!.style.get('fillColor')).toBe('#dae8fc');
    expect(v[1]!.style.shape()).toBe('ellipse');
    expect(Number(v[3]!.style.get('rotation'))).toBeCloseTo(30);
    expect(L.abs.get(v[3]!.id)!.x).toBeCloseTo(100);
    const e = all.find((c) => c.edge)!;
    expect([e.source, e.target]).toEqual([v[0]!.id, v[1]!.id]);
  });

  it('a drawing Visio might write: a master\'s geometry inherited, an arc, a group with its shapes, a 1-D connector', () => {
    const ns = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const rel = (rid: string, t: string) => `<Relationship Id="${rid}" Target="${t}" Type="x"/>`;
    const files = [
      { name: 'visio/pages/pages.xml', bytes: enc(`<Pages ${ns}><Page ID="0" Name="Plan"><PageSheet><Cell N="PageWidth" V="10"/><Cell N="PageHeight" V="5"/></PageSheet><Rel r:id="rId1"/></Page></Pages>`) },
      { name: 'visio/pages/_rels/pages.xml.rels', bytes: enc(`<Relationships>${rel('rId1', 'page1.xml')}</Relationships>`) },
      { name: 'visio/masters/masters.xml', bytes: enc(`<Masters ${ns}><Master ID="2" NameU="Arch"><Rel r:id="rId1"/></Master></Masters>`) },
      { name: 'visio/masters/_rels/masters.xml.rels', bytes: enc(`<Relationships>${rel('rId1', 'master1.xml')}</Relationships>`) },
      { name: 'visio/masters/master1.xml', bytes: enc(`<MasterContents ${ns}><Shapes><Shape ID="5" Type="Shape"><Cell N="FillForegnd" V="#ff0000"/><Section N="Geometry" IX="0"><Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row><Row T="ArcTo" IX="3"><Cell N="X" V="0"/><Cell N="Y" V="0"/><Cell N="A" V="0.5"/></Row></Section></Shape></Shapes></MasterContents>`) },
      { name: 'visio/pages/page1.xml', bytes: enc(`<PageContents ${ns}><Shapes>`
        + `<Shape ID="1" Master="2"><Cell N="PinX" V="1"/><Cell N="PinY" V="4"/><Cell N="Width" V="1"/><Cell N="Height" V="0.5"/><Text>Arch</Text></Shape>`
        + `<Shape ID="2" Type="Group"><Cell N="PinX" V="5"/><Cell N="PinY" V="2.5"/><Cell N="Width" V="2"/><Cell N="Height" V="1"/><Shapes><Shape ID="3"><Cell N="PinX" V="0.5"/><Cell N="PinY" V="0.5"/><Cell N="Width" V="1"/><Cell N="Height" V="1"/><Section N="Geometry"><Row T="Ellipse"><Cell N="X" V="0.5"/><Cell N="Y" V="0.5"/><Cell N="A" V="1"/><Cell N="B" V="0.5"/><Cell N="C" V="0.5"/><Cell N="D" V="1"/></Row></Section></Shape></Shapes></Shape>`
        + `<Shape ID="4"><Cell N="PinX" V="3"/><Cell N="PinY" V="4"/><Cell N="Width" V="2"/><Cell N="Height" V="0"/><Cell N="BeginX" V="1.5"/><Cell N="BeginY" V="4"/><Cell N="EndX" V="4.5"/><Cell N="EndY" V="2.5"/><Cell N="EndArrow" V="4"/></Shape>`
        + `</Shapes><Connects><Connect FromSheet="4" FromCell="BeginX" ToSheet="1"/><Connect FromSheet="4" FromCell="EndX" ToSheet="2"/></Connects></PageContents>`) },
    ];
    const { xml } = vsdxToDiagram(zip(files));
    const d = readDrawio(enc(xml), 'X.DgmDoc');
    expect(d.pages[0]!.node ? xml : '').toContain('name="Plan"');
    expect(xml).toContain('pageWidth="1000" pageHeight="500"');
    const all = cells(d.pages[0]!), L = layout(all);
    const arch = all.find((c) => c.value === 'Arch')!;
    expect(arch.style.shape()).toMatch(/^stencil\(/);
    expect(arch.style.get('fillColor')).toBe('#ff0000');
    expect(stencilXml(arch.style.shape())).toContain('<arc rx="50" ry="50"');
    expect(L.abs.get(arch.id)).toEqual({ x: 50, y: 75, w: 100, h: 50 });
    const grp = all.find((c) => c.style.shape() === 'group')!;
    const kid = all.find((c) => c.parent === grp.id)!;
    expect([kid.style.shape(), L.abs.get(kid.id)]).toEqual(['ellipse', { x: 400, y: 200, w: 100, h: 100 }]);
    const e = all.find((c) => c.edge)!;
    expect([e.source, e.target, e.style.get('endArrow')]).toEqual([arch.id, grp.id, 'block']);
  });

  it('paths flattened for Visio: curves and arcs through their points, closed ones back to their start', () => {
    const [sp] = flattenPath('M0,0 L10,0 Q20,0 20,10 A10,10 0 0 1 10,20 Z');
    expect(sp![0]).toEqual({ x: 0, y: 0 });
    expect(sp!.at(-1)).toEqual({ x: 0, y: 0 });
    expect(sp!.some((q) => Math.abs(Math.hypot(q.x - 10, q.y - 10) - 10) < 1e-6 && q.x > 17 && q.y > 15)).toBe(true);
    expect(flattenPath('M0,0 h10 v5 h-10 Z')[0]!.map((q) => [q.x, q.y])).toEqual([[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]);
  });

  it('File › Import and Open: .drawio and .vsdx files become Konium diagrams; Extras › Export as offers both', async () => {
    const im = IMPORTERS.find((i) => i.id === 'diagram')!;
    expect(im.exts).toEqual(['.drawio', '.vsdx']);
    const r = await im.run([{ path: 'Plan.vsdx', bytes: diagramToVsdx(newDrawio('x')).bytes }, { path: 'f/Other.drawio', bytes: enc('<mxfile><diagram id="a" name="A"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>') }, { path: 'Bad.drawio', bytes: enc('hello') }]);
    expect(r.libraries.map((x) => x.name)).toEqual(['Plan.DgmDoc', 'Other.DgmDoc']);
    expect(r.messages.map((m) => m.level)).toEqual(['error']);
    expect(extrasMenu()[1]!.children!.map((n) => n.label)).toEqual(['PNG...', 'SVG...', 'PDF...', '.drawio File...', 'Visio Drawing (.vsdx)...']);
  });
});
