/**
 * Everyday schematic editing from Altium Designer 17's Edit, View and right-click menus:
 * Bring To Front / Send To Back (… Of), Move To Front, Break Wire, Lasso Select / Deselect,
 * Select › Connection, Align… (the Align Objects dialog), Increment Part Number, Copy As Text,
 * Toggle Electrical Grid (Shift+E), Set Snap Grid…, and the classic zoom commands.
 */
import type { Command, Scope } from '../core/commands';
import type { Vec2 } from '../core/geom';
import { parseLength, formatCoord } from '../core/units';
import { PickTool } from '../editors/Editor';
import { LassoTool } from '../editors/LassoTool';
import { ZoomAreaTool } from '../editors/Editor';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchMoveTool } from '../editors/sch/SchMoveTool';
import { BreakWireTool } from '../editors/sch/BreakWireTool';
import type { AlignKind } from '../editors/align';
import { bagOf, type SchObject } from '../model/sch';
import { blockOf, reorderObjects, setProps } from '../model/schEdit';
import { wireConnection } from '../model/schConnect';
import { active, docs, notify, units } from './state';
import { showDialog } from './dialogs';
import { PromptDialog } from './dialogs/Confirm';
import { AlignDialog } from './dialogs/Align';
import { ColourDialog } from './dialogs/Pickers';

const SCH: Scope[] = ['sch'];
const SCH_ALL: Scope[] = ['sch', 'schlib'];
const anySch = (): SchEditor | null => { const e = active.value?.editor; return e instanceof SchEditor ? e : null; };
const sheet = (): SchEditor | null => { const e = anySch(); return e && !e.libraryMode ? e : null; };

/** The object a click picked (a part's pin or graphic picks the part). */
const picked = (e: SchEditor, raw: Vec2): number | undefined => { const k = e.hits(raw)[0]?.key; return k ? parseInt(k.slice(1), 10) : undefined; };
const ctxIndex = (): { e: SchEditor; o: SchObject } | null => {
  const e = anySch(), k = e?.contextKey;
  const o = e && k ? e.doc.objects[parseInt(k.slice(1), 10)] : undefined;
  return e && o ? { e, o } : null;
};

/* ─── Order ──────────────────────────────────────────────────────────────────────────── */

function toFrontOrBack(e: SchEditor, to: 'front' | 'back'): void {
  e.setTool(new PickTool(e, `${to === 'front' ? 'Bring To Front' : 'Send To Back'}: click the objects; right-click to finish`, (p) => {
    const i = picked(e, p.raw);
    if (i === undefined) return false;
    e.undo.transact(to === 'front' ? 'Bring to front' : 'Send to back', (tx) => tx.add(reorderObjects(e.doc, [i], to)));
    e.clearSelection();
    return true;
  }, true));
}

function relative(e: SchEditor, to: 'before' | 'after'): void {
  const what = to === 'after' ? 'Bring To Front Of' : 'Send To Back Of';
  e.setTool(new PickTool(e, `${what}: click the object to move`, (p) => {
    const i = picked(e, p.raw);
    if (i === undefined) return false;
    setTimeout(() => e.setTool(new PickTool(e, `${what}: click the object to put it ${to === 'after' ? 'in front of' : 'behind'}`, (q) => {
      const j = picked(e, q.raw);
      if (j === undefined || j === i) return false;
      e.undo.transact(what, (tx) => tx.add(reorderObjects(e.doc, [i], to === 'after' ? { after: j } : { before: j })));
      e.clearSelection();
      setTimeout(() => relative(e, to), 0);
      return true;
    })), 0);
    return true;
  }));
}

/** Move To Front: the object comes to the front and follows the cursor until a click places it. */
function moveToFront(e: SchEditor): void {
  e.setTool(new PickTool(e, 'Move To Front: click the object to move', (p) => {
    const i = picked(e, p.raw);
    if (i === undefined) return false;
    const block = blockOf(e.doc, i);
    e.undo.transact('Bring to front', (tx) => tx.add(reorderObjects(e.doc, [i], 'front')));
    const now = e.doc.objects.length - block.length + block.indexOf(i);
    const at = p.world;
    setTimeout(() => e.setTool(new SchMoveTool(e, 'move', [now], at)), 0);
    return true;
  }));
}

/* ─── Selection ─────────────────────────────────────────────────────────────────────── */

function selectConnection(e: SchEditor): void {
  e.setTool(new PickTool(e, 'Select Connection: click a wire', (p) => {
    const i = picked(e, p.raw);
    if (i === undefined) return false;
    const list = wireConnection(e.doc, i);
    if (!list.length) { notify('Not a wire, bus or something on one', 'error'); return false; }
    e.select(list.map((k) => `o${k}`));
    notify(`${list.length} object${list.length === 1 ? '' : 's'} in the connection`);
    return true;
  }));
}

/** Copy As Text: the text of what's selected (names, net labels, strings, designators …), one per line. */
export function selectionText(e: SchEditor): string[] {
  const out: string[] = [];
  for (const i of e.selectedIndices()) {
    const o = e.doc.objects[i]!, b = bagOf(e.doc, o);
    if (!b) continue;
    if (o.kind === 'component') {
      for (const c of e.doc.objects) if (c.owner === i && c.kind === 'text' && !c.hidden) out.push(c.text);
      continue;
    }
    const t = o.kind === 'textframe' ? o.text : b.get('TEXT') ?? b.get('NAME');
    if (t) out.push(t);
  }
  return out;
}

/* ─── Part numbers ──────────────────────────────────────────────────────────────────── */

export function incrementPart(e: SchEditor, i: number): boolean {
  const o = e.doc.objects[i];
  if (o?.kind !== 'component') return false;
  const parts = Math.max(1, o.partCount - 1);
  if (parts < 2) { notify(`${o.designator || 'The part'} has only one part`, 'error'); return false; }
  const next = (o.partId % parts) + 1;
  e.undo.transact('Increment part number', (tx) => tx.add(setProps(e.doc, i, { CURRENTPARTID: String(next) })));
  return true;
}

/* ─── Net colours ───────────────────────────────────────────────────────────────────── */

/** View › Set Net Colors: Altium's seven (the Delphi standard colours). */
export const NET_COLOURS: [string, number][] = [
  ['Blue', 0x0000ff], ['Light Green', 0x00ff00], ['Light Blue', 0x00ffff], ['Red', 0xff0000], ['Fuchsia', 0xff00ff], ['Yellow', 0xffff00], ['Dark Green', 0x008000],
];

function pickNet(e: SchEditor, prompt: string, then: (net: string) => void): void {
  e.setTool(new PickTool(e, `${prompt}; right-click to finish`, (p) => {
    const net = e.netAt(p.raw);
    if (!net) return false;
    then(net);
    e.invalidate();
    return true;
  }, true));
}
const colourNet = (e: SchEditor, rgb: number) => pickNet(e, 'Set Net Colour: click a wire of the net', (n) => {
  e.netColours.set(n, rgb);
  if (!SchEditor.showNetColours) { SchEditor.showNetColours = true; notify('Net colour override shown (F5 hides it)'); }
});

/* ─── Commands ──────────────────────────────────────────────────────────────────────── */

export function schEditCommands(): Command[] {
  const run = (fn: (e: SchEditor) => void, get = anySch) => () => { const e = get(); if (e) fn(e); };
  const has = () => !!anySch();
  const breakWire = (e: SchEditor) => e.setTool(new BreakWireTool(e));
  const increment = (e: SchEditor) => e.setTool(new PickTool(e, 'Increment Part Number: click the parts; right-click to finish', (p) => {
    const i = picked(e, p.raw);
    return i !== undefined && incrementPart(e, i);
  }, true));
  const align = (e: SchEditor) => {
    if (e.selectedIndices().length < 2) { notify('Select two or more objects to align', 'error'); return; }
    showDialog(AlignDialog, { onOk: (h: AlignKind | null, v: AlignKind | null, grid: boolean) => e.undo.transact('Align objects', () => { if (h) { e.align(h); e.invalidate(); } if (v) { e.align(v); e.invalidate(); } if (grid) e.alignToGrid(); }) });
  };
  const ctxComponent = () => { const c = ctxIndex(); return !!c && c.o.kind === 'component' && c.o.partCount > 2; };
  const ctxWire = () => { const c = ctxIndex(); return !!c && (c.o.kind === 'wire' || c.o.kind === 'bus'); };
  return [
    { id: 'ad:Sch:BringObjectToFront', label: 'Bring To Front', scopes: SCH_ALL, run: run((e) => toFrontOrBack(e, 'front')), enabled: has },
    { id: 'ad:Sch:SendObjectToBack', label: 'Send To Back', scopes: SCH_ALL, run: run((e) => toFrontOrBack(e, 'back')), enabled: has },
    { id: 'ad:Sch:BringObjectToFrontOf', label: 'Bring To Front Of', scopes: SCH_ALL, run: run((e) => relative(e, 'after')), enabled: has },
    { id: 'ad:Sch:SendObjectToBackOf', label: 'Send To Back Of', scopes: SCH_ALL, run: run((e) => relative(e, 'before')), enabled: has },
    { id: 'ad:Sch:MoveObjectToFront', label: 'Move To Front', scopes: SCH, run: run(moveToFront, sheet), enabled: () => !!sheet() },
    { id: 'ad:Sch:BreakPolyline', label: 'Break Wire', scopes: SCH, run: run(breakWire, sheet), enabled: () => !!sheet() },
    { id: 'ad:Sch:BreakPolylineWithContext', label: 'Break Wire', scopes: SCH, run: run(breakWire, sheet), enabled: ctxWire },
    { id: 'ad:Sch:SelectObjectsLasso', label: 'Lasso Select', scopes: SCH_ALL, run: run((e) => e.setTool(new LassoTool(e))), enabled: has },
    { id: 'ad:Sch:DeSelectObjectsLasso', label: 'Lasso Deselect', scopes: SCH_ALL, run: run((e) => e.setTool(new LassoTool(e, true))), enabled: has },
    { id: 'ad:Sch:SelectConnection', label: 'Connection', scopes: SCH, run: run(selectConnection, sheet), enabled: () => !!sheet() },
    { id: 'ad:Sch:AlignObjectsDialog', label: 'Align...', scopes: SCH_ALL, run: run(align), enabled: has },
    { id: 'ad:Sch:AlignObjectsDialogWithContext', label: 'Align...', scopes: SCH_ALL, run: run(align), enabled: has },
    { id: 'ad:Sch:IncrementComponentPartNumber', label: 'Increment Part Number', scopes: SCH, run: run(increment, sheet), enabled: () => !!sheet() },
    { id: 'ad:Sch:IncrementComponentPartNumberWithContext', label: 'Increment Part Number', scopes: SCH, run: () => { const c = ctxIndex(); if (c) incrementPart(c.e, c.o.index); }, enabled: ctxComponent },
    { id: 'ad:Sch:CopyAsText', label: 'Copy As Text', scopes: SCH_ALL, run: run((e) => {
      const lines = selectionText(e);
      if (!lines.length) { notify('Nothing with text selected', 'error'); return; }
      void navigator.clipboard?.writeText(lines.join('\r\n')).then(() => notify(`Copied ${lines.length} line${lines.length === 1 ? '' : 's'} of text`), () => notify('The browser refused the clipboard', 'error'));
    }), enabled: () => !!anySch()?.selection.size },
    { id: 'ad:Sch:ToggleElectricalGrid', label: 'Toggle Electrical Grid', scopes: SCH, run: run((e) => { e.electricalGrid = !e.electricalGrid; notify(`Electrical grid ${e.electricalGrid ? 'on' : 'off'}`); }, sheet),
      enabled: () => !!sheet(), checked: () => !!sheet()?.electricalGrid },
    { id: 'ad:Sch:SetSnapGrid', label: 'Set Snap Grid...', scopes: SCH_ALL, run: run((e) => showDialog(PromptDialog, {
      title: 'Choose a snap grid size', fields: [{ label: `Snap grid (${units.value})`, value: formatCoord(e.gridSize(), units.value).replace(/[a-z]+$/, '') }],
      onOk: ([v]: string[]) => {
        const n = parseLength(/^\s*[\d.]+\s*$/.test(v ?? '') ? `${(v ?? '').trim()}${units.value}` : v ?? '');
        if (!n || n <= 0) { notify(`"${v}" isn't a length`, 'error'); return; }
        e.setGrid(Math.round(n)); notify(`Snap grid ${formatCoord(Math.round(n), units.value)}`);
      } })), enabled: has },
    ...NET_COLOURS.map(([label, rgb], i): Command => ({ id: `sch.netColour.${i}`, label, scopes: SCH, run: run((e) => colourNet(e, rgb), sheet), enabled: () => !!sheet() })),
    { id: 'ad:Sch:SetNetColors_ChooseColor', label: 'Custom...', scopes: SCH, run: run((e) => showDialog(ColourDialog, { value: '#0000ff', onOk: (v: string) => colourNet(e, parseInt(v.slice(1), 16)) }), sheet), enabled: () => !!sheet() },
    { id: 'ad:Sch:ClearNetColors', label: 'Clear Net Colour', scopes: SCH, run: run((e) => pickNet(e, 'Clear Net Colour: click a wire of the net', (n) => { e.netColours.delete(n); }), sheet),
      enabled: () => !!sheet()?.netColours.size },
    { id: 'ad:Sch:ClearAllNetColors', label: 'Clear All Net Colours', scopes: SCH, run: run((e) => { e.netColours.clear(); e.invalidate(); }, sheet), enabled: () => !!sheet()?.netColours.size },
    { id: 'ad:Sch:ToggleNetColorOverride', label: 'Show Net Colour Override', scopes: SCH, run: () => {
      SchEditor.showNetColours = !SchEditor.showNetColours;
      for (const d of docs.value) if (d.editor instanceof SchEditor) d.editor.invalidate();
      notify(`Net colour override ${SchEditor.showNetColours ? 'shown' : 'hidden'}`);
    }, enabled: () => !!sheet(), checked: () => SchEditor.showNetColours },
    { id: 'ad:Sch:ZoomAllClassic', label: 'All', scopes: SCH_ALL, run: run((e) => e.fitObjects()), enabled: has },
    { id: 'ad:Sch:ZoomDocumentClassic', label: 'Sheet', scopes: SCH_ALL, run: run((e) => e.fit()), enabled: has },
    { id: 'ad:Sch:ZoomLastClassic', label: 'Last', scopes: SCH_ALL, run: run((e) => { if (!e.zoomLast()) notify('No previous view'); }), enabled: has },
    { id: 'ad:Sch:ZoomWindowClassic', label: 'Window', scopes: SCH_ALL, run: run((e) => e.setTool(new ZoomAreaTool(e))), enabled: has },
  ];
}
