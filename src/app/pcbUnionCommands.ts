/**
 * Unions on the board: Tools › Convert › Create Union from selected objects, Break objects from
 * Union, Break all objects Unions, Explode Length Tuning To Free Primitives; right-click ›
 * Unions › Select / Deselect All In Union, Resize Union [est: scales the members about the
 * union's lower-left corner].
 */
import type { Command, Scope } from '../core/commands';
import { active, notify, tick } from './state';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { NumberDialog } from './dialogs/RouteTools';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PickTool } from '../editors/Editor';
import { commitMove } from '../editors/pcb/PcbMoveTool';
import { placement } from '../formats/altium/pcbTransform';
import { encodeArc, encodeTrack } from '../formats/altium/pcbdoc';
import { TEXT, put } from '../formats/altium/pcbLayouts';
import { replaceRecords, setComponentProps } from '../model/pcbEdit';
import {
  canJoinUnion, componentUnion, freshUnionName, metaWithout, nextUnion, setUnionMeta, smartOf, unionEdits, unionMembers, unionOf, unionsInUse,
} from '../model/unions';
import { componentExtent } from '../model/rooms';
import type { PcbPrim } from '../model/pcb';

const PCB: Scope[] = ['pcb'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The union of the object under the right-click (or the first selected). */
function contextUnion(e: PcbEditor): number {
  const k = (e as unknown as { contextKey?: string | null }).contextKey ?? [...e.selection][0];
  const p = k ? e.primByKey(k) : undefined;
  if (!p) return 0;
  const u = canJoinUnion(p) ? unionOf(e.doc, p) : 0;
  return u || ('component' in p ? componentUnion(e.doc, p.component) : 0);
}

/** Members out of their unions; unions left empty lose their name and smart record. */
function breakOut(e: PcbEditor, prims: PcbPrim[], comps: number[], label: string): number {
  const doc = e.doc;
  const touched = new Set<number>();
  for (const p of prims) { const u = canJoinUnion(p) ? unionOf(doc, p) : 0; if (u) touched.add(u); }
  for (const c of comps) { const u = componentUnion(doc, c); if (u) touched.add(u); }
  if (!touched.size) return 0;
  const edits = unionEdits(doc, prims.filter((p) => canJoinUnion(p) && unionOf(doc, p)), 0);
  const cs = comps.filter((c) => componentUnion(doc, c));
  e.undo.transact(label, (tx) => {
    if (edits.length) tx.add(replaceRecords(doc, edits));
    for (const c of cs) tx.add(setComponentProps(doc, c, { UNIONINDEX: '0' }));
    const empty = new Set([...touched].filter((u) => { const m = unionMembers(doc, u); return !m.prims.length && !m.components.length; }));
    if (empty.size) { const m = metaWithout(doc, empty); tx.add(setUnionMeta(doc, m.names, m.smart)); }
  });
  e.invalidate(); tick.value++;
  return edits.length + cs.length;
}

/** Resize Union: the members scaled by `k` about the lower-left of their extent [est]. */
function resizeUnion(e: PcbEditor, u: number, k: number): void {
  const doc = e.doc, m = unionMembers(doc, u);
  const xs: number[] = [], ys: number[] = [];
  for (const p of m.prims) { if (p.kind === 'track') xs.push(p.a.x, p.b.x), ys.push(p.a.y, p.b.y); else if (p.kind === 'arc') xs.push(p.c.x - p.r, p.c.x + p.r), ys.push(p.c.y - p.r, p.c.y + p.r); else if (p.kind === 'text') xs.push(p.at.x), ys.push(p.at.y); }
  for (const c of m.components) { const b = componentExtent(doc, c); if (b) xs.push(b.minX, b.maxX), ys.push(b.minY, b.maxY); }
  if (!xs.length) return;
  const o = { x: Math.min(...xs), y: Math.min(...ys) };
  const sc = (p: { x: number; y: number }) => ({ x: Math.round(o.x + (p.x - o.x) * k), y: Math.round(o.y + (p.y - o.y) * k) });
  const edits: { storage: string; index: number; after: ReturnType<typeof encodeTrack> }[] = [];
  for (const p of m.prims) {
    const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
    if (p.kind === 'track') edits.push({ storage: p.src.storage, index: p.src.index, after: encodeTrack({ layer: p.layer, a: sc(p.a), b: sc(p.b), width: Math.round(p.width * k), net: p.net, component: p.component, polygon: p.polygon, keepout: p.keepout }, rec) });
    else if (p.kind === 'arc') edits.push({ storage: p.src.storage, index: p.src.index, after: encodeArc({ layer: p.layer, c: sc(p.c), r: Math.round(p.r * k), start: p.start, end: p.end, width: Math.round(p.width * k), net: p.net, component: p.component }, rec) });
    else if (p.kind === 'text') {
      const s = rec.subs[0]!.slice(), at = sc(p.at);
      put(s, TEXT.x, at.x); put(s, TEXT.y, at.y); put(s, TEXT.height, Math.round(p.height * k)); put(s, TEXT.strokeWidth, Math.round(p.strokeWidth * k));
      edits.push({ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] } });
    }
  }
  e.undo.transact('Resize union', (tx) => {
    // Encoding from the old record keeps the union index
    if (edits.length) tx.add(replaceRecords(doc, edits));
    for (const c of m.components) { const at = doc.components[c]!.at, to = sc(at); if (to.x !== at.x || to.y !== at.y) commitMove(e, { components: [c], polygons: [], prims: [] }, placement({ x: 0, y: 0 }, 0, { x: to.x - at.x, y: to.y - at.y }), 0, 'move'); }
  });
  e.invalidate();
}

export function pcbUnionCommands(): Command[] {
  const hasUnion = () => !!board() && unionsInUse(board()!.doc).size > 0;
  const inUnion = () => { const e = board(); return !!e && contextUnion(e) > 0; };
  return [
    { id: 'ad:PCB:CreateUnion', label: 'Create Union from selected objects', scopes: PCB, enabled: () => (board()?.selection.size ?? 0) > 1, run: on((e) => {
      const set = e.moveSet(), doc = e.doc;
      const prims = set.prims.filter(canJoinUnion), left = set.prims.length - prims.length;
      if (prims.length + set.components.length < 2) { notify('Select two or more tracks, arcs, texts or components', 'error'); return; }
      const u = nextUnion(doc), name = freshUnionName(doc, 'Unions');
      e.undo.transact('Create union', (tx) => {
        const edits = unionEdits(doc, prims, u);
        if (edits.length) tx.add(replaceRecords(doc, edits));
        for (const c of set.components) tx.add(setComponentProps(doc, c, { UNIONINDEX: String(u) }));
        tx.add(setUnionMeta(doc, [...(doc.unionNames ?? []), { index: u, name }], [...(doc.smartUnions ?? [])]));
      });
      notify(`${name}: ${plural(prims.length + set.components.length, 'object')}${left ? ` (${left} vias, pads, fills or regions can't join a union yet)` : ''}`);
      e.invalidate(); tick.value++;
    }) },
    { id: 'ad:PCB:BreakUnion', label: 'Break objects from Union', scopes: PCB, enabled: () => !!board()?.selection.size && hasUnion(), run: on((e) => {
      const set = e.moveSet();
      const n = breakOut(e, set.prims, set.components, 'Break objects from union');
      notify(n ? `${plural(n, 'object')} out of their union` : 'Nothing selected is in a union');
    }) },
    { id: 'ad:PCB:BreakAllUnions', label: 'Break all objects Unions', scopes: PCB, enabled: hasUnion, run: on((e) => {
      const n = unionsInUse(e.doc).size;
      showDialog(ConfirmDialog, { title: 'Confirm', message: `Break all ${plural(n, 'union')} into free objects?`, detail: 'Drill tables and length tunings become plain tracks, arcs and text.', onYes: () => {
        e.undo.transact('Break all unions', (tx) => { breakOut(e, e.doc.prims, e.doc.components.map((_, i) => i), 'Break all unions'); tx.add(setUnionMeta(e.doc, [], [])); });
      } });
    }) },
    { id: 'ad:PCB:SelectAllInUnion', label: 'Select All In Union', scopes: PCB, enabled: inUnion, run: on((e) => {
      const keys = e.unionKeys(contextUnion(e));
      for (const k of keys) e.selection.add(k);
      e.invalidateOverlay();
    }) },
    { id: 'ad:PCB:DeSelectAllInUnion', label: 'Deselect All In Union', scopes: PCB, enabled: inUnion, run: on((e) => {
      for (const k of e.unionKeys(contextUnion(e))) e.selection.delete(k);
      e.invalidateOverlay();
    }) },
    { id: 'ad:PCB:ResizeUnion', label: 'Resize Union', scopes: PCB, enabled: inUnion, run: on((e) => {
      const u = contextUnion(e);
      showDialog(NumberDialog, { title: 'Resize Union', label: 'Scale', value: 100, unit: '%', onOk: (v: number) => { if (v > 0 && v !== 100) resizeUnion(e, u, v / 100); } });
    }) },
    { id: 'ad:PCB:ExplodeLengthTuningToFreePrimitives', label: 'Explode Length Tuning To Free Primitives', scopes: PCB, enabled: hasUnion, run: on((e) => {
      e.setTool(new PickTool(e, 'Explode Length Tuning: click a length tuning', (p) => {
        const doc = e.doc;
        const hit = e.hits(p.raw).map((h) => e.primByKey(h.key)).find((q): q is PcbPrim => !!q && canJoinUnion(q) && unionOf(doc, q) > 0);
        if (!hit) return false;
        const u = unionOf(doc, hit);
        const name = (doc.unionNames ?? []).find((n) => n.index === u)?.name ?? '';
        if (smartOf(doc, u)?.type !== 4 && !/^Interactive Length Tunings/.test(name)) { notify('That is not a length tuning', 'error'); return false; }
        const m = unionMembers(doc, u);
        const n = breakOut(e, m.prims, m.components, 'Explode length tuning');
        notify(`${plural(n, 'object')} freed`);
        return true;
      }, true));
    }) },
  ];
}

