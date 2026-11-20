import { describe, expect, it } from 'vitest';
import {
  addEdge, addPage, addVertex, cells, change, clip, edgeRoute, labelText, layout, moveCells, newDrawio, readDrawio, redoDiagram, removeCells, resizeCell, setLabel, setSheet, setStyle,
  undoDiagram, writeDrawio, Style,
} from '../src/formats/drawio';
import { detect, load } from '../src/formats/registry';
import { docIcon } from '../src/app/icons';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A diagram as draw.io writes one (made up): a power block and an MCU in a container, joined; a label on the edge. */
const MODEL = '<mxGraphModel dx="1000" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root>'
  + '<mxCell id="0" /><mxCell id="1" parent="0" />'
  + '<mxCell id="pwr" value="Power&lt;br&gt;5 V &amp;amp; 3V3" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry" /></mxCell>'
  + '<mxCell id="box" value="Board" style="swimlane;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="300" y="20" width="200" height="160" as="geometry" /></mxCell>'
  + '<UserObject label="MCU" koniumSheet="MCU.SchDoc" id="mcu"><mxCell style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="box"><mxGeometry x="40" y="60" width="120" height="60" as="geometry" /></mxCell></UserObject>'
  + '<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="pwr" target="mcu"><mxGeometry relative="1" as="geometry" /></mxCell>'
  + '<mxCell id="e1l" value="VBUS" style="edgeLabel;html=1;align=center;" vertex="1" connectable="0" parent="e1"><mxGeometry x="-0.2" relative="1" as="geometry"><mxPoint as="offset" /></mxGeometry></mxCell>'
  + '</root></mxGraphModel>';
const FILE = `<mxfile host="Electron" agent="x" version="24.7.17">\n  <diagram id="d1" name="Overview">${MODEL}</diagram>\n</mxfile>\n`;

/** draw.io's compressed form: base64 of the raw-deflated, URI-encoded XML. */
async function compressed(xml: string): Promise<string> {
  const s = new Blob([enc(encodeURIComponent(xml)) as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const b = new Uint8Array(await new Response(s).arrayBuffer());
  return btoa(String.fromCharCode(...b));
}

describe('Diagrams (.drawio)', () => {
  it('read: pages, cells, styles, labels (HTML), shapes in containers, an edge routed square between its shapes', () => {
    const b = enc(FILE);
    expect(detect(b, 'Block.drawio')).toBe('Diagram');
    const d = readDrawio(b, 'Block.drawio');
    expect(d.pages).toHaveLength(1);
    const list = cells(d.pages[0]!);
    expect(list.map((c) => c.id)).toEqual(['0', '1', 'pwr', 'box', 'mcu', 'e1', 'e1l']);
    const pwr = list[2]!, mcu = list[4]!;
    expect(labelText(pwr)).toBe('Power\n5 V & 3V3');
    expect([pwr.style.shape(), pwr.style.get('fillColor'), list[3]!.style.shape()]).toEqual(['rectangle', '#dae8fc', 'swimlane']);
    expect([mcu.value, mcu.sheet]).toEqual(['MCU', 'MCU.SchDoc']);
    const L = layout(list);
    // The MCU sits in the container: its place on the page is the container's plus its own
    expect(L.abs.get('mcu')).toEqual({ x: 340, y: 80, w: 120, h: 60 });
    // From the power block's right side across, down and into the MCU's left side
    expect(edgeRoute(list[5]!, L)).toEqual([{ x: 160, y: 70 }, { x: 250, y: 70 }, { x: 250, y: 110 }, { x: 340, y: 110 }]);
    expect(clip({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: 25 }, { x: 50, y: 300 })).toEqual({ x: 50, y: 50 });
    expect(new Style([['ellipse', null], ['whiteSpace', 'wrap']]).toString()).toBe('ellipse;whiteSpace=wrap;');
    // Unchanged: written back as read
    expect(dec(writeDrawio(d))).toBe(FILE);
  });

  it('a compressed page is read, kept as it was until changed, then written plain', async () => {
    const z = await compressed(MODEL);
    const file = `<mxfile host="app.diagrams.net" compressed="true"><diagram id="d1" name="Page-1">${z}</diagram></mxfile>`;
    const d = readDrawio(enc(file), 'Z.drawio');
    expect(cells(d.pages[0]!).filter((c) => c.vertex)).toHaveLength(4);
    expect(dec(writeDrawio(d))).toBe(file);
    change(d, 'Move', () => moveCells(d.pages[0]!, new Set(['pwr']), 10, 0), d.pages[0]);
    const out = dec(writeDrawio(d));
    expect(out).toContain('compressed="false"');
    expect(out).toContain('<mxCell id="pwr" value="Power&lt;br&gt;5 V &amp;amp; 3V3" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="50" y="40"');
    expect(readDrawio(enc(out), 'Z.drawio').pages[0]!.compressed).toBe(false);
  });

  it('edited: shapes added, joined, moved (their edge\'s waypoints too), resized, labelled, styled, linked to a sheet, removed; undo and redo', () => {
    const d = newDrawio('New.drawio');
    const p = d.pages[0]!;
    let a = '', b = '', e = '';
    change(d, 'Add', () => { a = addVertex(p, { x: 0, y: 0, w: 120, h: 60 }, '', 'rounded=0;whiteSpace=wrap;html=1;'); b = addVertex(p, { x: 200, y: 0, w: 120, h: 60 }, '', 'ellipse;html=1;'); e = addEdge(p, a, b, 'edgeStyle=orthogonalEdgeStyle;html=1;'); }, p);
    change(d, 'Label', () => { setLabel(p, a, 'MCU <main>\nrev B'); setStyle(p, [a], 'fillColor', '#ffe6cc'); setSheet(p, a, 'MCU.SchDoc'); resizeCell(p, b, { x: 200, y: 0, w: 140, h: 80 }); }, p);
    let list = cells(p);
    const ca = list.find((c) => c.id === a)!;
    expect([labelText(ca), ca.value, ca.style.get('fillColor'), ca.sheet, ca.wrap?.name]).toEqual(['MCU <main>\nrev B', 'MCU &lt;main&gt;<br>rev B', '#ffe6cc', 'MCU.SchDoc', 'UserObject']);
    expect(list.find((c) => c.id === b)!.rect).toEqual({ x: 200, y: 0, w: 140, h: 80 });
    // A waypoint on the edge moves with both its ends
    p.model.kids; // (the waypoint is added the way draw.io keeps it)
    const g = list.find((c) => c.id === e)!.node.kids.find((k) => typeof k !== 'string' && k.name === 'mxGeometry') as { kids: unknown[]; empty: boolean };
    g.kids.push({ name: 'Array', attrs: [['as', 'points']], kids: [{ name: 'mxPoint', attrs: [['x', '160'], ['y', '100']], kids: [], empty: true }], empty: false }); g.empty = false;
    change(d, 'Move', () => moveCells(p, new Set([a, b]), 20, 10), p);
    list = cells(p);
    expect(list.find((c) => c.id === e)!.points).toEqual([{ x: 180, y: 110 }]);
    expect(list.find((c) => c.id === a)!.rect).toMatchObject({ x: 20, y: 10 });
    // Removing a shape takes its edges
    change(d, 'Delete', () => removeCells(p, new Set([b])), p);
    expect(cells(p).map((c) => c.id)).toEqual(['0', '1', a]);
    expect(undoDiagram(d)).toBe('Delete');
    expect(cells(d.pages[0]!).map((c) => c.id)).toEqual(['0', '1', a, b, e]);
    expect(redoDiagram(d)).toBe('Delete');
    expect(cells(d.pages[0]!)).toHaveLength(3);
    // Pages; saved and read again
    change(d, 'Add Page', () => addPage(d, 'Power'));
    const back = load(writeDrawio(d), 'New.drawio') as ReturnType<typeof readDrawio>;
    expect(back.pages.map((x) => x.node && x.node.attrs.find(([k]) => k === 'name')?.[1])).toEqual(['Page-1', 'Power']);
    expect(cells(back.pages[0]!).find((c) => c.id === a)!.sheet).toBe('MCU.SchDoc');
    expect(docIcon('New.drawio')).toBe('diagramDoc');
  });

  it('a bare mxGraphModel file is a diagram of one page', () => {
    const d = readDrawio(enc(MODEL), 'Bare.drawio');
    expect([d.pages.length, cells(d.pages[0]!).length]).toEqual([1, 7]);
    expect(dec(writeDrawio(d))).toBe(MODEL);
  });
});
