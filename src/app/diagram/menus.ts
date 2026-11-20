/**
 * A diagram's own menus in the menu bar while it is in front: Edit, Arrange and Extras (and its
 * view items at the top of View), each item acting on the diagram through the API its view
 * registers.
 */
import type { AccelNode, MenuRoot } from '../../core/keymap';
import { active } from '../state';
import { MENUS } from '../commands';

/** What a diagram's view offers its menus (the view in front). */
export interface DiagramApi {
  canUndo: boolean; canRedo: boolean; canPaste: boolean; hasSel: boolean; hasEdges: boolean; manySel: boolean; format: boolean; layers: boolean; grid: boolean; paged: boolean; sheets: boolean;
  undo(): void; redo(): void; cut(): void; copy(): void; paste(): void; del(): void; duplicate(): void; find(): void;
  editStyle(): void; editData(): void; editLink(): void;
  selectVertices(): void; selectEdges(): void; selectAll(): void; selectNone(): void; lock(): void;
  toggleFormat(): void; toggleLayers(): void; toggleGrid(): void; togglePageView(): void; resetView(): void; zoomIn(): void; zoomOut(): void; fit(): void; fitPage(): void;
  order(how: 'front' | 'back' | 'forward' | 'backward'): void; group(): void; ungroup(): void; align(how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void; distribute(horizontal: boolean): void;
  rotate90(): void; flip(horizontal: boolean): void; waypoints(kind: string): void; clearWaypoints(): void; waypointKinds: { id: string; label: string; on: boolean }[];
  editDiagram(): void; exportAs(kind: 'png' | 'svg' | 'pdf'): void; exportFile(kind: 'drawio' | 'vsdx'): void; print(): void; addSheets(): void;
}
export const diagramApi = new Map<string, DiagramApi>();
const api = (): DiagramApi | undefined => (active.value?.doc.kind === 'Diagram' ? diagramApi.get(active.value.id) : undefined);
const isDiagram = () => active.value?.doc.kind === 'Diagram';

const it = (label: string, act: (a: DiagramApi) => void, o: { hint?: string; off?: (a: DiagramApi) => boolean; checked?: (a: DiagramApi) => boolean; sep?: boolean } = {}): AccelNode => {
  const a = api();
  return { key: '', label, hint: o.hint, action: () => { const x = api(); if (x) act(x); }, disabled: !a || (o.off?.(a) ?? false), checked: a && o.checked ? o.checked(a) : undefined, separatorBefore: o.sep };
};
const sub = (label: string, kids: () => AccelNode[], sep = false): AccelNode => {
  const n: AccelNode = { key: '', label, separatorBefore: sep };
  Object.defineProperty(n, 'children', { get: kids, enumerable: true, configurable: true });
  return n;
};
const noSel = (a: DiagramApi) => !a.hasSel;

export function editMenu(): AccelNode[] {
  return [
    it('Undo', (a) => a.undo(), { hint: 'Ctrl+Z', off: (a) => !a.canUndo }), it('Redo', (a) => a.redo(), { hint: 'Ctrl+Y', off: (a) => !a.canRedo }),
    it('Cut', (a) => a.cut(), { hint: 'Ctrl+X', off: noSel, sep: true }), it('Copy', (a) => a.copy(), { hint: 'Ctrl+C', off: noSel }), it('Paste', (a) => a.paste(), { hint: 'Ctrl+V', off: (a) => !a.canPaste }),
    it('Delete', (a) => a.del(), { hint: 'Delete', off: noSel }), it('Duplicate', (a) => a.duplicate(), { hint: 'Ctrl+D', off: noSel }),
    it('Find...', (a) => a.find(), { hint: 'Ctrl+F', sep: true }),
    it('Edit Style...', (a) => a.editStyle(), { hint: 'Ctrl+E', off: noSel, sep: true }), it('Edit Data...', (a) => a.editData(), { hint: 'Ctrl+M', off: (a) => !a.hasSel || a.manySel }),
    it('Edit Link...', (a) => a.editLink(), { hint: 'Alt+Shift+L', off: (a) => !a.hasSel || a.manySel }),
    it('Select Shapes', (a) => a.selectVertices(), { hint: 'Ctrl+Shift+I', sep: true }), it('Select Connectors', (a) => a.selectEdges(), { hint: 'Ctrl+Shift+E' }),
    it('Select All', (a) => a.selectAll(), { hint: 'Ctrl+A' }), it('Select None', (a) => a.selectNone(), { hint: 'Ctrl+Shift+A', off: noSel }),
    it('Lock / Unlock', (a) => a.lock(), { hint: 'Ctrl+L', off: noSel, sep: true }),
  ];
}
export function viewMenu(): AccelNode[] {
  return [
    it('Format Panel', (a) => a.toggleFormat(), { hint: 'Ctrl+Shift+P', checked: (a) => a.format }), it('Layers', (a) => a.toggleLayers(), { hint: 'Ctrl+Shift+L', checked: (a) => a.layers }),
    it('Grid', (a) => a.toggleGrid(), { checked: (a) => a.grid }), it('Page View', (a) => a.togglePageView(), { checked: (a) => a.paged }),
    it('Reset View', (a) => a.resetView(), { hint: 'Ctrl+H', sep: true }), it('Zoom In', (a) => a.zoomIn(), { hint: 'Ctrl+Plus' }), it('Zoom Out', (a) => a.zoomOut(), { hint: 'Ctrl+Minus' }),
    it('Fit Window', (a) => a.fit(), { hint: 'Ctrl+Shift+H' }), it('Fit Page', (a) => a.fitPage(), { off: (a) => !a.paged }),
  ];
}
export function arrangeMenu(): AccelNode[] {
  return [
    it('To Front', (a) => a.order('front'), { hint: 'Ctrl+Shift+F', off: noSel }), it('To Back', (a) => a.order('back'), { hint: 'Ctrl+Shift+B', off: noSel }),
    it('Bring Forward', (a) => a.order('forward'), { off: noSel }), it('Send Backward', (a) => a.order('backward'), { off: noSel }),
    it('Group', (a) => a.group(), { hint: 'Ctrl+G', off: noSel, sep: true }), it('Ungroup', (a) => a.ungroup(), { hint: 'Ctrl+Shift+U', off: noSel }),
    sub('Align', () => ([['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const).map(([h, l]) => it(l, (a) => a.align(h), { off: (a) => !a.manySel })), true),
    sub('Distribute', () => [it('Horizontally', (a) => a.distribute(true), { off: (a) => !a.manySel }), it('Vertically', (a) => a.distribute(false), { off: (a) => !a.manySel })]),
    it('Rotate 90°', (a) => a.rotate90(), { hint: 'Ctrl+R', off: noSel, sep: true }), it('Flip Horizontal', (a) => a.flip(true), { off: noSel }), it('Flip Vertical', (a) => a.flip(false), { off: noSel }),
    sub('Waypoints', () => (api()?.waypointKinds ?? []).map((w) => it(w.label, (a) => a.waypoints(w.id), { off: (a) => !a.hasEdges, checked: () => w.on })), true),
    it('Clear Waypoints', (a) => a.clearWaypoints(), { off: (a) => !a.hasEdges }),
  ];
}
export function extrasMenu(): AccelNode[] {
  return [
    it('Edit Diagram...', (a) => a.editDiagram()),
    sub('Export as', () => [it('PNG...', (a) => a.exportAs('png')), it('SVG...', (a) => a.exportAs('svg')), it('PDF...', (a) => a.exportAs('pdf')),
      it('.drawio File...', (a) => a.exportFile('drawio'), { sep: true }), it('Visio Drawing (.vsdx)...', (a) => a.exportFile('vsdx'))], true),
    it('Print...', (a) => a.print(), { hint: 'Ctrl+P' }),
    it('Add Project Sheets', (a) => a.addSheets(), { off: (a) => !a.sheets, sep: true }),
  ];
}

/** The menus put in the menu bar (once): Edit after File, Arrange and Extras after View; View's own items first while a diagram is in front. */
let installed = false;
export function installDiagramMenus(): void {
  if (installed) return;
  installed = true;
  const root = (label: string, alt: string, kids: () => AccelNode[]): MenuRoot => {
    const r = { key: '', label, alt, scopes: ['inspect'], inMenuBar: true, when: isDiagram } as unknown as MenuRoot;
    Object.defineProperty(r, 'children', { get: kids, enumerable: true, configurable: true });
    return r;
  };
  const at = (label: string) => MENUS.findIndex((m) => m.inMenuBar && m.label === label && m.scopes.includes('inspect'));
  const f = at('File');
  MENUS.splice(f + 1, 0, root('Edit', 'E', editMenu));
  const v = at('View');
  MENUS.splice(v + 1, 0, root('Arrange', 'A', arrangeMenu), root('Extras', 'X', extrasMenu));
  const view = MENUS[at('View')];
  if (view) {
    const own = Object.getOwnPropertyDescriptor(view, 'children');
    const old: () => AccelNode[] = own?.get ?? (() => own?.value as AccelNode[]);
    Object.defineProperty(view, 'children', { get: () => (isDiagram() ? [...viewMenu(), ...old().map((n: AccelNode, i: number) => (i === 0 ? { ...n, separatorBefore: true } : n))] : old()), enumerable: true, configurable: true });
  }
}
