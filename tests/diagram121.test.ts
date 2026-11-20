import { describe, expect, it } from 'vitest';
import { cellProps, cells, change, readDrawio, replaceModel, setProperty, undoDiagram, writeDrawio } from '../src/formats/drawio';
import { arrangeMenu, editMenu, extrasMenu, installDiagramMenus, viewMenu } from '../src/app/diagram/menus';
import { MENUS } from '../src/app/commands';
import viewSrc from '../src/app/DiagramView.tsx?raw';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const FILE = '<mxfile><diagram id="p1" name="One"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry" /></mxCell></root></mxGraphModel></diagram><diagram id="p2" name="Two"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

describe('Diagrams D5: data, links, the page\'s XML', () => {
  it('Edit Data: properties kept in a UserObject (its id and label moved to it), changed, removed; a link and a tooltip', () => {
    const d = readDrawio(enc(FILE), 'D.DgmDoc');
    const p = d.pages[0]!;
    change(d, 'Data', () => { setProperty(p, 'a', 'part', 'U1'); setProperty(p, 'a', 'value', '3V3'); setProperty(p, 'a', 'link', 'data:page/id,p2'); setProperty(p, 'a', 'tooltip', 'The regulator'); }, p);
    const out = dec(writeDrawio(d));
    expect(out).toContain('<UserObject label="A" id="a" part="U1" value="3V3" link="data:page/id,p2" tooltip="The regulator"><mxCell style="rounded=1;" vertex="1" parent="1">');
    const c = cells(readDrawio(enc(out), 'D.DgmDoc').pages[0]!).find((x) => x.id === 'a')!;
    expect([cellProps(c), c.link, c.value]).toEqual([[['part', 'U1'], ['value', '3V3']], 'data:page/id,p2', 'A']);
    change(d, 'Data', () => { setProperty(p, 'a', 'part', null); setProperty(p, 'a', 'bad name', 'x'); setProperty(p, 'a', 'id', 'zz'); }, p);
    expect(cellProps(cells(p).find((x) => x.id === 'a')!)).toEqual([['value', '3V3']]);
  });

  it('Edit Diagram: the page\'s XML replaced; anything but a page refused; undone', () => {
    const d = readDrawio(enc(FILE), 'D.DgmDoc');
    const p = d.pages[0]!;
    let ok = false;
    change(d, 'Edit Diagram', () => { ok = replaceModel(d, p, '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry" /></mxCell></root></mxGraphModel>'); }, p);
    expect(ok).toBe(true);
    expect(cells(d.pages[0]!).map((c) => c.id)).toEqual(['0', '1', 'b']);
    expect(dec(writeDrawio(d))).toContain('<diagram id="p1" name="One"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="b"');
    expect(replaceModel(d, d.pages[0]!, '<svg/>')).toBe(false);
    expect(replaceModel(d, d.pages[0]!, '<mxGraphModel')).toBe(false);
    undoDiagram(d);
    expect(cells(d.pages[0]!).map((c) => c.id)).toEqual(['0', '1', 'a']);
  });
});

describe('Diagrams D5: the menu bar', () => {
  it('Edit, Arrange and Extras after File and View, only while a diagram is in front; View\'s diagram items', () => {
    installDiagramMenus();
    const bar = MENUS.filter((m) => m.inMenuBar && m.scopes.includes('inspect')).map((m) => m.label);
    expect(bar.indexOf('Edit')).toBe(bar.indexOf('File') + 1);
    expect(bar.slice(bar.indexOf('View') + 1, bar.indexOf('View') + 3)).toEqual(['Arrange', 'Extras']);
    for (const l of ['Edit', 'Arrange', 'Extras']) expect(MENUS.find((m) => m.label === l && m.scopes.includes('inspect'))!.when!()).toBe(false);
    expect(editMenu().map((n) => n.label)).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Delete', 'Duplicate', 'Find...', 'Edit Style...', 'Edit Data...', 'Edit Link...', 'Select Shapes', 'Select Connectors', 'Select All', 'Select None', 'Lock / Unlock']);
    expect(editMenu().every((n) => n.disabled)).toBe(true);
    expect(editMenu()[0]!.hint).toBe('Ctrl+Z');
    expect(viewMenu().map((n) => n.label)).toContain('Page View');
    expect(arrangeMenu().map((n) => n.label)).toEqual(['To Front', 'To Back', 'Bring Forward', 'Send Backward', 'Group', 'Ungroup', 'Align', 'Distribute', 'Rotate 90°', 'Flip Horizontal', 'Flip Vertical', 'Waypoints', 'Clear Waypoints']);
    expect(extrasMenu().map((n) => n.label)).toEqual(['Edit Diagram...', 'Export as', 'Print...', 'Add Project Sheets']);
    expect(extrasMenu()[1]!.children!.map((n) => n.label).slice(0, 3)).toEqual(['PNG...', 'SVG...', 'PDF...']);
  });

  it('the editor: its keys and the dialogs behind the menus', () => {
    for (const t of ["'Ctrl+E'", "'Ctrl+M'", "'Alt+Shift+L'", "'Ctrl+F'", "'Ctrl+P'", "'Ctrl+R'", "'Ctrl+Shift+A'", 'EditDataDialog', 'EditLinkDialog', 'EditDiagramDialog', 'ExportDialog', 'diagramApi.set(od.id', 'openLink(c0)']) expect(viewSrc).toContain(t);
  });
});
