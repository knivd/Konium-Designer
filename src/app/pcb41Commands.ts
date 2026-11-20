/**
 * 26.041: Tools › IPC Compliant Footprint Wizard and Batch Generator (PCB library); Tools ›
 * Update From PCB Libraries; Route › Add / Remove Subnet Jumpers; Design › Netlist › Configure
 * Physical Nets; the Find Selections toolbar's Jump First / Previous / Next / Last Group;
 * Backspace while routing (Clear For Routing Unwind); Design › Netlist For Project / Document ›
 * EDIF for PCB, Pcad for PCB, MultiWire; File › New › Draftsman Document.
 */
import type { Command, Scope } from '../core/commands';
import { active, docs, notify, tick } from './state';
import { showDialog } from './dialogs';
import { IpcBatchDialog, IpcWizardDialog } from './dialogs/IpcWizard';
import { LibSyncDialog, PhysicalNetsDialog, SubnetJumpersDialog } from './dialogs/Pcb41Dialogs';
import { newDraftsmanDocument } from './draftsmanNew';
import { newMbaDoc, newMbsDoc, writeMbaDoc, writeMbsDoc } from '../formats/altium/multiboard';
import { newDrawio, writeDrawio } from '../formats/drawio';
import { newEnclosure, writeEnclosure } from '../formats/enclosureDoc';
import { newReqDoc, writeReqDoc } from '../formats/reqDoc';
import { addNewDocument, freshName, openDocument } from './actions';
import { pickFileHandle } from '../platform/fs';
import { newDocTarget } from './workspace';
import { findFootprint } from './dialogs/PcbModel';
import { activeProject, cmdCompile } from './project';
import { projectBoard } from './syncCommands';
import { footprintFinder } from './eco';
import { deliverOutputs } from './dialogs/Outputs';
import { registerMenuProvider } from './menus';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import type { AccelNode } from '../core/keymap';
import { encodeTrack } from '../formats/altium/pcbdoc';
import { withRecordUnion } from '../formats/altium/unions';
import { addPrimRecords, freshRecord, removePrims } from '../model/pcbEdit';
import { freshUnionName, nextUnion, setUnionMeta, unionMembers } from '../model/unions';
import { JUMPER_UNION, planJumpers } from '../model/subnets';
import { edifNetlist, multiwireNetlist, pcadNetlist } from '../formats/netlists';
import type { PcbDocument, PcbPrim } from '../model/pcb';
import type { BBox } from '../core/geom';

const PCB: Scope[] = ['pcb'];
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const board = () => { const e = anyPcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };
const lib = () => { const e = active.value?.editor; return e instanceof PcbLibEditor ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };

/** The union holding the jumpers (made on first use). */
const jumperUnion = (doc: PcbDocument) => doc.unionNames?.find((u) => u.name === JUMPER_UNION)?.index ?? 0;

/** A primitive's extent (roughly: enough to zoom to it). */
function primBox(p: PcbPrim): BBox | null {
  const pts = p.kind === 'track' ? [p.a, p.b] : p.kind === 'fill' ? [p.a, p.b] : p.kind === 'region' || p.kind === 'body' ? p.outline
    : p.kind === 'arc' ? [{ x: p.c.x - p.r, y: p.c.y - p.r }, { x: p.c.x + p.r, y: p.c.y + p.r }]
      : p.kind === 'pad' ? [{ x: p.at.x - p.top.w, y: p.at.y - p.top.h }, { x: p.at.x + p.top.w, y: p.at.y + p.top.h }]
        : p.kind === 'via' ? [{ x: p.at.x - p.diameter, y: p.at.y - p.diameter }, { x: p.at.x + p.diameter, y: p.at.y + p.diameter }]
          : [{ x: p.at.x, y: p.at.y }, { x: p.at.x + p.height * Math.max(1, p.text.length * 0.6), y: p.at.y + p.height }];
  if (!pts.length) return null;
  return { minX: Math.min(...pts.map((v) => v.x)), minY: Math.min(...pts.map((v) => v.y)), maxX: Math.max(...pts.map((v) => v.x)), maxY: Math.max(...pts.map((v) => v.y)) };
}

/** The Find Selections toolbar's place in the selection: groups are components (whole) and free objects. */
let groupAt = -1;
function selectionGroups(e: PcbEditor): BBox[] {
  const seen = new Set<number>(), out: BBox[] = [];
  const box = (ps: PcbPrim[]) => { const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; for (const p of ps) { const r = primBox(p); if (!r) continue; b.minX = Math.min(b.minX, r.minX); b.minY = Math.min(b.minY, r.minY); b.maxX = Math.max(b.maxX, r.maxX); b.maxY = Math.max(b.maxY, r.maxY); } return Number.isFinite(b.minX) ? b : null; };
  for (const k of e.selection) {
    const p = e.primByKey(k);
    if (!p) continue;
    if ('component' in p && p.component !== 0xffff) {
      if (seen.has(p.component)) continue;
      seen.add(p.component);
      const b = box(e.doc.prims.filter((q) => 'component' in q && q.component === p.component));
      if (b) out.push(b);
    } else { const b = box([p]); if (b) out.push(b); }
  }
  return out;
}
function jump(which: 'first' | 'prev' | 'next' | 'last') {
  return () => {
    const e = board();
    if (!e) return;
    const g = selectionGroups(e);
    if (!g.length) { notify('Nothing is selected to jump to', 'error'); return; }
    groupAt = which === 'first' ? 0 : which === 'last' ? g.length - 1 : which === 'next' ? Math.min(g.length - 1, groupAt + 1) : Math.max(0, groupAt - 1);
    e.zoomToBox(g[groupAt]!, 2_000_000);
    notify(`Selection group ${groupAt + 1} of ${g.length}`);
  };
}

/** Netlists: the compiled project, or the sheet in front only. */
function netlist(kind: 'edif' | 'pcad' | 'multiwire', document: boolean): () => void {
  return () => {
    const p = activeProject(), od = active.value, s = od?.editor instanceof SchEditor && !od.editor.libraryMode ? od.editor : null;
    if (document && (!s || !od)) { notify('Open a schematic sheet first', 'error'); return; }
    const res = document && s && od ? cmdCompile(p, [{ name: od.name, doc: s.doc }]) : cmdCompile(p);
    if (!res) return;
    if (res.result.messages.some((m) => m.fatal)) { notify('The compile halted on a fatal error: no netlist written', 'error'); return; }
    const base = (document ? od!.name : p?.name ?? res.name).replace(/\.(prjpcb|schdoc)$/i, '');
    const file = kind === 'edif' ? { name: `${base}.EDF`, text: edifNetlist(res.result, base) } : kind === 'pcad' ? { name: `${base}.NET`, text: pcadNetlist(res.result) } : { name: `${base}.NET`, text: multiwireNetlist(res.result, base) };
    void deliverOutputs(p, res.name, kind === 'edif' ? 'EDIF Netlist' : kind === 'pcad' ? 'Pcad Netlist' : 'MultiWire Netlist', [file]);
  };
}

/** The board a Draftsman document draws: the one in front, else the project's. */
function draftBoard(): PcbDocument | null {
  const b = board();
  if (b) return b.doc;
  const p = activeProject();
  const od = p ? projectBoard(p) : null;
  if (od?.doc.kind === 'PcbDoc') return od.doc as PcbDocument;
  return (docs.value.find((d) => d.doc.kind === 'PcbDoc')?.doc as PcbDocument | undefined) ?? null;
}

export function pcb41Commands(): Command[] {
  const finder = () => { const p = activeProject(); return p ? footprintFinder(p) : (name: string, library?: string) => findFootprint(name, library) ?? undefined; };
  const libSync = on((e) => showDialog(LibSyncDialog, { ed: e, find: finder() }));
  return [
    { id: 'ad:IPCFootprintWizard:Run', label: 'IPC Compliant Footprint Wizard...', scopes: ['pcblib'], enabled: () => !!lib(), run: () => { const e = lib(); if (e) showDialog(IpcWizardDialog, { ed: e }); } },
    { id: 'ad:IPCFootprintWizard:BatchGenerator', label: 'IPC Compliant Footprints Batch generator...', scopes: ['pcblib'], enabled: () => !!lib(), run: () => { const e = lib(); if (e) showDialog(IpcBatchDialog, { ed: e }); } },
    { id: 'ad:WorkspaceManager:ConfigurePCBLibrarySynch', label: 'Update From PCB Libraries...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: libSync },
    { id: 'ad:WorkspaceManager:ConfigurePCBLibrarySynchWithContext', label: 'Update From PCB Libraries...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: libSync },
    { id: 'ad:PCB:ConnectSubnets', label: 'Add Subnet Jumpers', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(SubnetJumpersDialog, { ed: e, onOk: (max: number) => {
      const { jumpers, left } = planJumpers(e.doc, e.currentLayer, max);
      if (!jumpers.length) { notify(left ? `No jumper of ${(max / 39370.0787).toFixed(2)} mm or less joins the pieces on ${e.layerLabel(e.currentLayer)}` : 'Every net is in one piece'); return; }
      const doc = e.doc;
      e.undo.transact('Add subnet jumpers', (tx) => {
        let u = jumperUnion(doc);
        const fresh = !u;
        if (fresh) u = nextUnion(doc);
        const recs = jumpers.map((j) => ({ storage: 'Tracks6', rec: withRecordUnion('Tracks6', freshRecord(doc, 'Tracks6', (tpl) => encodeTrack({ layer: j.layer, a: j.a, b: j.b, width: j.width, net: j.net }, tpl)), u) ?? freshRecord(doc, 'Tracks6', (tpl) => encodeTrack({ layer: j.layer, a: j.a, b: j.b, width: j.width, net: j.net }, tpl)) }));
        tx.add(addPrimRecords(doc, recs));
        if (fresh) tx.add(setUnionMeta(doc, [...(doc.unionNames ?? []), { index: u, name: freshUnionName(doc, JUMPER_UNION) }], [...(doc.smartUnions ?? [])]));
      });
      e.invalidate(); tick.value++;
      notify(`${jumpers.length} subnet jumper${jumpers.length === 1 ? '' : 's'} added${left ? `; ${left} piece${left === 1 ? '' : 's'} too far apart` : ''}`);
    } })) },
    { id: 'ad:PCB:RemoveSubnetJumpers', label: 'Remove Subnet Jumpers', scopes: PCB, enabled: () => !!board() && jumperUnion(board()!.doc) > 0, run: on((e) => {
      const u = jumperUnion(e.doc);
      const m = unionMembers(e.doc, u).prims;
      if (!m.length) { notify('There are no subnet jumpers'); return; }
      e.undo.transact('Remove subnet jumpers', (tx) => {
        tx.add(removePrims(e.doc, m));
        tx.add(setUnionMeta(e.doc, (e.doc.unionNames ?? []).filter((x) => x.index !== u), [...(e.doc.smartUnions ?? [])]));
      });
      e.invalidate(); tick.value++;
      notify(`${m.length} subnet jumper${m.length === 1 ? '' : 's'} removed`);
    }) },
    { id: 'ad:PCB:ConfigurePhysicalNets', label: 'Configure Physical Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(PhysicalNetsDialog, { ed: e })) },
    { id: 'ad:PCB:JumpFirstGroup', label: 'Jump First Group', scopes: PCB, enabled: () => !!board()?.selection.size, run: jump('first') },
    { id: 'ad:PCB:JumpPreviousGroup', label: 'Jump Previous Group', scopes: PCB, enabled: () => !!board()?.selection.size, run: jump('prev') },
    { id: 'ad:PCB:JumpNextGroup', label: 'Jump Next Group', scopes: PCB, enabled: () => !!board()?.selection.size, run: jump('next') },
    { id: 'ad:PCB:JumpLastGroup', label: 'Jump Last Group', scopes: PCB, enabled: () => !!board()?.selection.size, run: jump('last') },
    { id: 'ad:PCB:ClearForUnwind', label: 'Clear For Routing Unwind', scopes: PCB, run: () => { const e = anyPcb(); e?.tool.key?.('Backspace'); } },
    { id: 'netlist.project.edif', label: 'EDIF for PCB', run: netlist('edif', false) },
    { id: 'netlist.project.pcad', label: 'Pcad for PCB', run: netlist('pcad', false) },
    { id: 'netlist.project.multiwire', label: 'MultiWire', run: netlist('multiwire', false) },
    { id: 'netlist.document.edif', label: 'EDIF for PCB', scopes: ['sch'], run: netlist('edif', true) },
    { id: 'netlist.document.pcad', label: 'Pcad for PCB', scopes: ['sch'], run: netlist('pcad', true) },
    { id: 'netlist.document.multiwire', label: 'MultiWire', scopes: ['sch'], run: netlist('multiwire', true) },
    { id: 'file.newMbs', label: 'Multi-board Schematic', run: () => { const name = freshName('MultiBoard', 'MbsDoc'); const od = addNewDocument(name, writeMbsDoc(newMbsDoc(name)), newDocTarget()); if (od) { (od.doc as { dirty: boolean }).dirty = true; tick.value++; } } },
    { id: 'file.newDiagram', label: 'Diagram', run: () => { const name = freshName('Diagram', 'DgmDoc'); const od = addNewDocument(name, writeDrawio(newDrawio(name)), newDocTarget()); if (od) { (od.doc as { dirty: boolean }).dirty = true; tick.value++; } } },
    // Made round the open board; with none open, a PCB document asked for first and opened
    { id: 'file.newEnclosure', label: 'Enclosure', run: async () => {
      let b = draftBoard();
      if (!b) {
        notify('An enclosure is made round a board: choose its PCB document');
        const f = await pickFileHandle(['.PcbDoc'], 'PCB documents', 'konium-board');
        if (!f) return;
        const opened = openDocument(f);
        if (opened?.doc.kind !== 'PcbDoc') { notify(`${f.name} is not a PCB document`, 'error'); return; }
        b = opened.doc as PcbDocument;
      }
      const name = freshName(b.name.replace(/\.[^.]+$/, ''), 'Enclosure');
      const od = addNewDocument(name, writeEnclosure(newEnclosure(name, b.name)), newDocTarget());
      if (od) { (od.doc as { dirty: boolean }).dirty = true; tick.value++; }
    } },
    // A project's requirements: the next document's identifiers carry on from the others'
    { id: 'file.newRequirements', label: 'Requirements', run: () => { const name = freshName('Requirements', 'ReqDoc'); const od = addNewDocument(name, writeReqDoc(newReqDoc(name)), newDocTarget()); if (od) { (od.doc as { dirty: boolean }).dirty = true; tick.value++; } } },
    { id: 'file.newMba', label: 'Multi-board Assembly', run: () => { const name = freshName('Assembly', 'MbaDoc'); const od = addNewDocument(name, writeMbaDoc(newMbaDoc(name)), newDocTarget()); if (od) { (od.doc as { dirty: boolean }).dirty = true; tick.value++; } } },
    { id: 'file.newDraftsman', label: 'Draftsman Document', enabled: () => !!draftBoard(), run: () => { const d = draftBoard(); if (d) newDraftsmanDocument(d); else notify('Draftsman draws a board: open a PCB first', 'error'); } },
  ];
}

const it = (key: string, command: string, label: string): AccelNode => ({ key, label, command });
registerMenuProvider('@netlistProject', () => [it('E', 'netlist.project.edif', 'EDIF for PCB'), it('M', 'netlist.project.multiwire', 'MultiWire'), it('P', 'netlist.project.pcad', 'Pcad for PCB'), it('N', 'netlist.project.net', 'Netlist (.NET)')]);
registerMenuProvider('@netlistDocument', () => [it('E', 'netlist.document.edif', 'EDIF for PCB'), it('M', 'netlist.document.multiwire', 'MultiWire'), it('P', 'netlist.document.pcad', 'Pcad for PCB'), it('N', 'netlist.document.net', 'Netlist (.NET)')]);
