/**
 * What the CAM editor's commands share: the editor in front, the layer new objects go to (the
 * current layer, or the open composite's sub-layer), the D-code and drill tool they use, objects
 * appended in one undo step, and asking for values in the CAM form.
 */
import type { Vec2 } from '../core/geom';
import { CamEditor } from '../editors/cam/CamEditor';
import { active, notify, tick, units, docs } from './state';
import { showDialog } from './dialogs';
import { CamFormDialog, type CamField, type CamValues } from './dialogs/CamForm';
import { colourOf, sortLayers, type CamDocument, type CamLayer, type CamLayerType } from '../formats/cam/camDoc';
import { findOrAddAperture, findOrAddTool, nextGroup, type CamGroup } from '../formats/cam/camModel';
import type { DrillHit, DrillLayer, GerberLayer, GerberObject } from '../formats/gerber/gerberRead';
import { formatCoord, mil } from '../core/units';

export const activeCam = (): CamEditor | null => (active.value?.editor instanceof CamEditor ? active.value.editor : null);
/** The document changed outside an undo step (the panel, the tables): marked and redrawn. */
export function camChanged(ed: CamEditor): void { ed.touch(); tick.value++; docs.value = [...docs.value]; }
/** After an undoable edit: panels follow. */
export function camEdited(): void { tick.value++; docs.value = [...docs.value]; }

export const fmtLen = (c: number): string => formatCoord(c, units.value, units.value === 'mil' ? 3 : 4);

/** Ask in the CAM form; `ok` gets the values (a string back: an error shown in the dialog). */
export function ask(title: string, fields: CamField[], ok: (v: CamValues) => void | string, opts: { width?: number; okLabel?: string } = {}): void {
  showDialog(CamFormDialog, { title, fields, units: units.value, onOk: ok, ...opts });
}

/** A new, empty layer (Edit › Layers › Add): Gerber or NC drill, in millimetres. */
export function emptyLayer(name: string, type: CamLayerType, drill = false): CamLayer {
  const data: GerberLayer | DrillLayer = drill
    ? { kind: 'drill', units: 'mm', tools: new Map(), hits: [], routes: [], warnings: [] }
    : { kind: 'gerber', units: 'mm', attributes: {}, apertures: new Map(), macros: new Map(), objects: [], negative: false, warnings: [] };
  return { name, type, colour: colourOf(type), visible: true, text: '', data, edited: true };
}

/** A layer name not in use: base, base_1 … */
export function freshLayerName(d: CamDocument, base: string): string {
  const names = new Set(d.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  let n = 1;
  while (names.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** The current layer as a Gerber layer (where draws and flashes go); said so when it isn't one. */
export function gerberLayer(ed: CamEditor): { l: CamLayer; g: GerberLayer } | null {
  const l = ed.layer;
  if (!l) { notify('Add or load a layer first (Edit › Layers › Add, File › Import)', 'error'); return null; }
  if (l.data.kind !== 'gerber') { notify(`${l.name} is a drill layer: make a Gerber layer current to place on it`, 'error'); return null; }
  return { l, g: l.data };
}

/** The current layer as a drill layer, or the first drill layer, or a new one. */
export function drillLayer(ed: CamEditor): { l: CamLayer; d: DrillLayer; added: boolean } {
  const cur = ed.layer;
  if (cur?.data.kind === 'drill') return { l: cur, d: cur.data, added: false };
  const first = ed.doc.layers.find((l) => l.data.kind === 'drill');
  if (first) return { l: first, d: first.data as DrillLayer, added: false };
  const l = emptyLayer(freshLayerName(ed.doc, 'Drill.TXT'), 'Drill Top', true);
  return { l, d: l.data as DrillLayer, added: true };
}

/** The D-code to place with on a layer: the one chosen, else the layer's most used draw aperture, else a 10 mil round one. */
export function currentAperture(ed: CamEditor, l: CamLayer, g: GerberLayer): number {
  const cur = ed.currentAp.get(l);
  if (cur !== undefined && g.apertures.has(cur)) return cur;
  const count = new Map<number, number>();
  for (const o of g.objects) if (o.kind === 'draw' && g.apertures.get(o.ap)?.shape === 'C') count.set(o.ap, (count.get(o.ap) ?? 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ap = best ?? findOrAddAperture(g, 'C', mil(10));
  ed.currentAp.set(l, ap);
  return ap;
}

/** The drill tool to place with: the one chosen, else the layer's first, else a 0.8 mm one. */
export function currentTool(ed: CamEditor, l: CamLayer, d: DrillLayer): number {
  const cur = ed.currentTool.get(l);
  if (cur !== undefined && d.tools.has(cur)) return cur;
  const t = [...d.tools.keys()].sort((a, b) => a - b)[0] ?? findOrAddTool(d, Math.round(0.8 * 393700.787));
  ed.currentTool.set(l, t);
  return t;
}

/** The polarity and sub-layer new objects get: the open composite sub-layer's, else dark. */
export function placing(ed: CamEditor, l: CamLayer): { dark: boolean; sub?: number } {
  const open = ed.doc.openComposite;
  if (open && open.layer === l.name && l.composite?.[open.sub]) return { dark: true, sub: open.sub };
  return { dark: true };
}

/** Objects added to the current Gerber layer as one undo step (a group made of them when `group` is given). */
export function addObjects(ed: CamEditor, label: string, make: (ap: number, dark: boolean, grp: number | undefined, l: CamLayer, g: GerberLayer) => GerberObject[], group?: CamGroup): number[] {
  const t = gerberLayer(ed);
  if (!t) return [];
  const { l, g } = t;
  const at: number[] = [];
  ed.edit(label, [l], () => {
    const ap = currentAperture(ed, l, g);
    const pol = placing(ed, l);
    let grp: number | undefined;
    if (group) { grp = nextGroup(l); (l.groups ??= new Map()).set(grp, group); }
    for (const o of make(ap, pol.dark, grp, l, g)) {
      at.push(g.objects.length);
      g.objects.push({ ...o, ...(pol.sub !== undefined ? { sub: pol.sub } : {}), ...(grp !== undefined && o.grp === undefined ? { grp } : {}) });
    }
  });
  camEdited();
  return at;
}

/** Hits added to the drill layer (made when there's none) as one undo step. */
export function addHits(ed: CamEditor, label: string, make: (tool: number, d: DrillLayer, l: CamLayer) => DrillHit[], group?: CamGroup): void {
  const { l, d, added } = drillLayer(ed);
  ed.edit(label, added ? 'all' : [l], () => {
    if (added) { ed.doc.layers = sortLayers([...ed.doc.layers, l]); ed.doc.current = ed.doc.layers.indexOf(l); }
    const tool = currentTool(ed, l, d);
    let grp: number | undefined;
    if (group) { grp = nextGroup(l); (l.groups ??= new Map()).set(grp, group); }
    for (const h of make(tool, d, l)) d.hits.push({ ...h, ...(grp !== undefined ? { grp } : {}) });
  });
  camEdited();
}

/** A point as the status bar shows it (from the origin). */
export const ptText = (ed: CamEditor, p: Vec2): string => { const o = ed.origin(); return `${fmtLen(p.x - o.x)}, ${fmtLen(p.y - o.y)}`; };
