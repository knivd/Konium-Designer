/**
 * Component placement and board netlist tools of 26.023: Tools › Component Placement ›
 * Arrange Within Rectangle, Arrange Outside Board, Swap Components, Position Component Text;
 * Tools › Re-Annotate (positional); Design › Netlist › Update Free Primitives From Component
 * Pads; right-click › Applicable Unary / Binary Rules.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify } from './state';
import { showDialog } from './dialogs';
import { ApplicableRulesDialog, ComponentTextPositionDialog, ReannotateDialog } from './dialogs/PcbComponentTools';
import type { ReannotateOrder } from '../model/pcbPlacement';
import { ReportDialog } from './dialogs/Hierarchy';
import { SelectionMemoryDialog } from './dialogs/SelectionMemory';
import { NetlistManagerDialog } from './dialogs/NetlistManager';
import { cmdLoadNetlist } from './eco';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { commitMove } from '../editors/pcb/PcbMoveTool';
import { TwoPointTool } from '../editors/pcb/PcbEditTools';
import { PickTool } from '../editors/Editor';
import { placement } from '../formats/altium/pcbTransform';
import { TEXT, put } from '../formats/altium/pcbLayouts';
import { replaceRecords, retarget, setComponentProps } from '../model/pcbEdit';
import { itemChange } from '../model/pcbEco';
import { netsFromPads } from '../model/pcbNets';
import { applicableRules } from '../model/drc';
import { autoposition, reannotation } from '../model/pcbPlacement';
import { mil } from '../core/units';
import { NO_NET, type PcbPrim } from '../model/pcb';
import type { BBox, Vec2 } from '../core/geom';
import type { Change } from '../core/undo';

const PCB: Scope[] = ['pcb'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const GAP = mil(10);

/** A component's extent without its designator and comment (the scene must be built). */
function componentBox(e: PcbEditor, c: number): BBox {
  return e.boundsOf(e.componentKeys(c).filter((k) => e.primByKey(k)?.kind !== 'text'));
}
const boxer = (e: PcbEditor) => { e.scene(); return (c: number) => componentBox(e, c); };
const move = (e: PcbEditor, c: number, d: Vec2) => { if (d.x || d.y) commitMove(e, { components: [c], polygons: [], prims: [] }, placement({ x: 0, y: 0 }, 0, { x: Math.round(d.x), y: Math.round(d.y) }), 0, 'move'); };

/** Rows of components, left to right then down, inside `area` from its top-left corner [est: Altium's packing order]. */
function pack(e: PcbEditor, comps: number[], area: BBox, label: string): number {
  e.scene();
  const boxes = comps.map((c) => ({ c, b: componentBox(e, c) })).filter((x) => x.b.minX <= x.b.maxX)
    .sort((a, b) => (b.b.maxY - b.b.minY) - (a.b.maxY - a.b.minY) || e.doc.components[a.c]!.designator.localeCompare(e.doc.components[b.c]!.designator, undefined, { numeric: true }));
  let x = area.minX, y = area.maxY, rowH = 0, placed = 0;
  e.undo.transact(label, () => {
    for (const { c, b } of boxes) {
      const w = b.maxX - b.minX, h = b.maxY - b.minY;
      if (x > area.minX && x + w > area.maxX) { x = area.minX; y -= rowH + GAP * 2; rowH = 0; }
      move(e, c, { x: x - b.minX, y: y - h - b.minY });
      x += w + GAP * 2; rowH = Math.max(rowH, h); placed++;
    }
  });
  e.invalidate();
  return placed;
}

function positionTexts(e: PcbEditor, comps: number[], des: number, com: number): number {
  e.scene();
  const edits: { storage: string; index: number; after: ReturnType<typeof retarget> }[] = [];
  const props: Change[] = [];
  for (const c of comps) {
    const box = componentBox(e, c);
    if (!(box.minX <= box.maxX)) continue;
    const kv: Record<string, string> = { NAMEAUTOPOSITION: String(des), COMMENTAUTOPOSITION: String(com) };
    props.push(setComponentProps(e.doc, c, kv));
    for (const p of e.doc.prims) {
      if (p.kind !== 'text' || p.component !== c || !(p.isDesignator || p.isComment)) continue;
      const at = autoposition(p.isDesignator ? des : com, box, p);
      if (!at || (at.x === p.at.x && at.y === p.at.y)) continue;
      const rec = e.doc.streams.get(p.src.storage)!.records[p.src.index]!;
      const subs = rec.subs.map((x) => x.slice());
      put(subs[0]!, TEXT.x, at.x); put(subs[0]!, TEXT.y, at.y);
      edits.push({ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } });
    }
  }
  if (!props.length) return 0;
  e.undo.transact('Position component text', (tx) => { if (edits.length) tx.add(replaceRecords(e.doc, edits)); for (const p of props) tx.add(p); });
  e.invalidate();
  return props.length;
}

/** The component under the right-click (or the selection's). */
function contextComponent(e: PcbEditor): number | null {
  const k = e.contextKey ?? [...e.selection][0];
  const p = k ? e.primByKey(k) : undefined;
  return p && 'component' in p && p.component !== NO_NET && e.doc.components[p.component] ? p.component : null;
}
const describePrim = (e: PcbEditor, p: PcbPrim) => {
  const comp = 'component' in p && p.component !== NO_NET ? e.doc.components[p.component]?.designator : undefined;
  const k = p.kind[0]!.toUpperCase() + p.kind.slice(1);
  return p.kind === 'pad' ? `Pad ${comp ? `${comp}-` : ''}${p.name}` : `${k}${comp ? ` (${comp})` : ''}`;
};

export function pcbComponentCommands(): Command[] {
  const selComps = (e: PcbEditor) => e.moveSet().components;
  const textPos = on((e) => {
    const comps = selComps(e).length ? selComps(e) : [contextComponent(e)].filter((c): c is number => c !== null);
    if (!comps.length) { notify('Select the components first', 'error'); return; }
    const first = e.doc.components[comps[0]!]!.bag;
    showDialog(ComponentTextPositionDialog, { designator: first.int('NAMEAUTOPOSITION'), comment: first.int('COMMENTAUTOPOSITION'),
      onOk: (d: number, c: number) => { const n = positionTexts(e, comps, d, c); notify(`Text positioned on ${plural(n, 'component')}`); } });
  });
  return [
    { id: 'ad:PCB:ArrangeComponentsWithinRectangle', label: 'Arrange Within Rectangle', scopes: PCB, enabled: () => !!board()?.moveSet().components.length,
      run: on((e) => {
        const comps = selComps(e);
        e.setTool(new TwoPointTool(e, 'arrange-rect', ['Arrange Within Rectangle: click one corner', 'Arrange Within Rectangle: click the opposite corner'], (a, b) => {
          const n = pack(e, comps, { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }, 'Arrange within rectangle');
          e.setTool(null); notify(`${plural(n, 'component')} arranged`);
        }));
      }) },
    { id: 'ad:PCB:ArrangeComponentsOutsideBoard', label: 'Arrange Outside Board', scopes: PCB, enabled: () => !!board()?.moveSet().components.length,
      run: on((e) => {
        const o = e.doc.board.outline;
        if (o.length < 3) { notify('The board has no shape', 'error'); return; }
        const xs = o.map((p) => p.x), ys = o.map((p) => p.y);
        const w = Math.max(...xs) - Math.min(...xs);
        // In rows to the right of the board, as wide as the board, from its top [est]
        const left = Math.max(...xs) + mil(200);
        const n = pack(e, selComps(e), { minX: left, maxX: left + Math.max(w, mil(2000)), minY: -1e12, maxY: Math.max(...ys) }, 'Arrange outside board');
        notify(`${plural(n, 'component')} arranged outside the board`);
      }) },
    { id: 'ad:PCB:SwapComponents', label: 'Swap Components', scopes: PCB, enabled: () => board()?.moveSet().components.length === 2,
      run: on((e) => {
        const [a, b] = selComps(e) as [number, number];
        const pa = e.doc.components[a]!.at, pb = e.doc.components[b]!.at;
        e.undo.transact('Swap components', () => { move(e, a, { x: pb.x - pa.x, y: pb.y - pa.y }); move(e, b, { x: pa.x - pb.x, y: pa.y - pb.y }); });
        e.invalidate();
      }) },
    { id: 'ad:PCB:AutopositionComponentTexts', label: 'Position Component Text...', scopes: PCB, enabled: () => !!board(), run: textPos },
    { id: 'ad:PCB:PopupAutopositionComponentTexts', label: 'Position Component Text...', scopes: PCB, enabled: () => !!board(), run: textPos },
    { id: 'ad:PCB:ReAnnotate', label: 'Re-Annotate...', scopes: PCB, enabled: () => !!board()?.doc.components.length,
      run: on((e) => showDialog(ReannotateDialog, {
        preview: (o: ReannotateOrder) => reannotation(e.doc, o, boxer(e)),
        onOk: (o: ReannotateOrder) => {
          const ren = reannotation(e.doc, o, boxer(e)).filter((r) => r.from !== r.to);
          if (!ren.length) return;
          // All the changes are made before any applies, so swaps (R1 ↔ R2) find the right parts
          const changes = ren.map((r) => itemChange(e.doc, { kind: 'changeDesignator', group: 'Change Component Designators', action: 'Modify', object: `${r.from} -> ${r.to}`, index: e.doc.components.findIndex((c) => c.designator === r.from), from: r.from, to: r.to }, () => undefined));
          e.undo.transact('Positional re-annotate', (tx) => { for (const c of changes) tx.add(c); });
          e.invalidate();
          const was = ren.map((r) => `${r.from.padEnd(12)}${r.to}`).join('\r\n');
          showDialog(ReportDialog, { title: 'Positional Re-Annotate', name: `${e.doc.name.replace(/\.[^.]+$/, '')}.WAS`, text: `${was}\r\n`, project: null });
        },
      })) },
    { id: 'ad:PCB:UpdateFreePrimitiveNets', label: 'Update Free Primitives From Component Pads...', scopes: PCB, enabled: () => !!board(),
      run: on((e) => {
        const { changes, conflicts } = netsFromPads(e.doc);
        if (!changes.length) { notify(conflicts ? `Nothing changed: ${plural(conflicts, 'object')} reach pads of more than one net` : 'Free primitives already take their pads’ nets'); return; }
        const edits = changes.map(({ prim, net }) => ({ storage: prim.src.storage, index: prim.src.index, after: retarget(e.doc.streams.get(prim.src.storage)!.records[prim.src.index]!, { net: () => net }) }));
        e.undo.transact('Update free primitives from component pads', (tx) => tx.add(replaceRecords(e.doc, edits)));
        e.invalidate();
        notify(`${plural(edits.length, 'primitive')} took their pads’ nets${conflicts ? `; ${conflicts} reaching more than one net left alone` : ''}`);
      }) },
    // Konium's: a netlist file brought to the board through an Engineering Change Order
    { id: 'pcb.loadNetlist', label: 'Load a Netlist...', scopes: PCB, enabled: () => !!board(), run: () => { void cmdLoadNetlist(); } },
    { id: 'ad:PCB:EditNets', label: 'Edit Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(NetlistManagerDialog, { ed: e })) },
    { id: 'ad:PCB:ShowSelectionMemoryDialog', label: 'Selection Memory Dialog', scopes: ['pcb', 'pcblib'], enabled: () => active.value?.editor instanceof PcbEditor,
      run: () => { const e = active.value?.editor; if (e instanceof PcbEditor) showDialog(SelectionMemoryDialog, { ed: e }); } },
    { id: 'ad:PCB:PopupRightMouseUnaryRules', label: 'Applicable Unary Rules...', scopes: PCB, enabled: () => !!board(),
      run: on((e) => {
        const k = e.contextKey ?? [...e.selection][0];
        const p = k ? e.primByKey(k) : undefined;
        if (!p) { notify('Right-click an object first', 'error'); return; }
        showDialog(ApplicableRulesDialog, { title: 'Applicable Unary Rules', subject: describePrim(e, p), rules: applicableRules(e.doc, p) });
      }) },
    { id: 'ad:PCB:PopupRightMouseBinaryRules', label: 'Applicable Binary Rules...', scopes: PCB, enabled: () => !!board(),
      run: on((e) => {
        const k = e.contextKey ?? [...e.selection][0];
        const a = k ? e.primByKey(k) : undefined;
        if (!a) { notify('Right-click an object first', 'error'); return; }
        e.setTool(new PickTool(e, 'Applicable Binary Rules: click the second object', (pt) => {
          const h = e.hits(pt.raw).map((x) => e.primByKey(x.key)).find((q): q is PcbPrim => !!q && q !== a);
          if (!h) return false;
          showDialog(ApplicableRulesDialog, { title: 'Applicable Binary Rules', subject: `${describePrim(e, a)} and ${describePrim(e, h)}`, rules: applicableRules(e.doc, a, h) });
          return true;
        }));
      }) },
  ];
}
