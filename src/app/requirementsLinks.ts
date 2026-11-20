/**
 * Requirements and the design: what is selected in the schematic or on the board, as links (its
 * parts by designator, its nets by name; nothing selected, the document itself), and a link
 * followed back (Altium's cross-probe): a part or a net selected and zoomed to on the board when
 * the board is in front, else found on the schematic through a compile; a document opened.
 */
import { active, activeId, docs, notify, tick, type Project } from './state';
import { openProjectDocument } from './actions';
import { cmdCompile, compiled, crossProbe } from './project';
import { PcbEditor, primKey } from '../editors/pcb/PcbEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import type { SchDocument } from '../model/sch';
import type { PcbDocument } from '../model/pcb';
import { mergeLinks, type ReqLink } from '../model/requirements';

/** What is selected in the schematic or board in front, as links (none: nothing to link). */
export function selectionLinks(): ReqLink[] {
  const od = active.value, ed = od?.editor;
  if (!od || !ed) return [];
  // A library has no parts of a design and no nets: nothing to link (its editors are the schematic's and the board's, its document is not)
  if (od.doc.kind !== 'SchDoc' && od.doc.kind !== 'PcbDoc') return [];
  const out: ReqLink[] = [];
  if (ed instanceof SchEditor) {
    const doc = od.doc as SchDocument;
    for (const k of ed.selection) {
      for (const i of ed.indicesOfKey(k)) {
        const o = doc.objects[i];
        if (!o) continue;
        const comp = o.kind === 'component' ? o : o.owner >= 0 && doc.objects[o.owner]?.kind === 'component' ? doc.objects[o.owner] : null;
        if (comp?.kind === 'component' && comp.designator && !/\?$/.test(comp.designator)) { out.push({ kind: 'part', ref: comp.designator }); continue; }
        if (o.kind === 'text' && o.role === 'netlabel' && o.text) out.push({ kind: 'net', ref: o.text });
        else if (o.kind === 'power' && o.text) out.push({ kind: 'net', ref: o.text });
        else if (o.kind === 'port' && o.name) out.push({ kind: 'net', ref: o.name });
      }
    }
    if (!ed.selection.size) out.push({ kind: 'sheet', ref: od.name });
  } else if (ed instanceof PcbEditor) {
    const doc = od.doc as PcbDocument;
    if (ed.selection.size) {
      for (const c of ed.moveSet().components) { const d = doc.components[c]?.designator; if (d) out.push({ kind: 'part', ref: d }); }
      const parts = new Set(ed.moveSet().components);
      for (const p of doc.prims) {
        if (!ed.selection.has(primKey(p)) || ('component' in p && parts.has(p.component as number))) continue;
        const n = 'net' in p && typeof p.net === 'number' ? doc.nets[p.net]?.name : undefined;
        if (n) out.push({ kind: 'net', ref: n });
      }
    } else out.push({ kind: 'board', ref: od.name });
  }
  return mergeLinks([], out);
}

/** Follow a link: the part or net shown and selected (on the board in front, else on the schematic), the document opened. */
export function probe(link: ReqLink, p: Project | null): void {
  if (link.kind === 'sheet' || link.kind === 'board') {
    const open = docs.value.find((d) => d.name.toLowerCase() === link.ref.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null));
    if (open) { activeId.value = open.id; return; }
    if (p && p.files.has(link.ref.toLowerCase())) { openProjectDocument(p, link.ref); return; }
    notify(`${link.ref} isn't in the project`, 'error');
    return;
  }
  // The board, when it is in front (or the project's only open board when nothing of the project's design is)
  const front = active.value;
  const board = front?.editor instanceof PcbEditor && (front.projectId ?? null) === (p?.id ?? null) ? front : null;
  if (board) {
    const ed = board.editor as PcbEditor, doc = board.doc as PcbDocument;
    let keys: string[] = [];
    if (link.kind === 'part') { const c = doc.components.find((x) => x.designator === link.ref); if (c) keys = ed.componentKeys(c.index); }
    else { const n = doc.nets.find((x) => x.name === link.ref); if (n) keys = doc.prims.filter((q) => 'net' in q && q.net === n.index).map(primKey); }
    if (keys.length) { ed.select(keys, false); ed.zoomToBox(ed.boundsOf(keys), 2_000_000); ed.invalidateOverlay(); tick.value++; return; }
  }
  // On the schematic: through the last compile of this project (compiled now if there's none)
  let res = compiled.value;
  if (!res || (res.projectId ?? null) !== (p?.id ?? null)) res = cmdCompile(p);
  if (!res) { notify('Compile the project to find it', 'error'); return; }
  const refs = link.kind === 'part' ? res.result.components.find((c) => c.designator === link.ref)?.refs : res.result.nets.find((n) => n.name === link.ref)?.refs;
  if (!refs?.length) { notify(`${link.kind === 'part' ? 'Part' : 'Net'} ${link.ref} isn't in the design`, 'error'); return; }
  crossProbe(refs, p);
}
