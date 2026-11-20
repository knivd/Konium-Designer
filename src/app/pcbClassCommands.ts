/**
 * Design › Classes (the Object Class Explorer) and the net class commands AD17 offers on the
 * PCB panel's net list and the right-click Net Actions: create a net class from the selected
 * nets, add them to one, take them out of one.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify } from './state';
import { showDialog } from './dialogs';
import { ClassExplorerDialog } from './dialogs/ClassExplorer';
import { ChooseListDialog } from './dialogs/ChooseList';
import { PromptDialog } from './dialogs/Confirm';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { NO_NET } from '../model/pcb';
import { classBag, freshClassName, isGenerated, netsOfSelection, setClasses, withMembers } from '../model/pcbClasses';

const PCB: Scope[] = ['pcb'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The nets of the selection (and the highlighted net), by name. */
export function selectedNetNames(e: PcbEditor): string[] {
  const nets = new Set<number>();
  for (const k of e.selection) {
    const p = e.primByKey(k);
    if (p && 'net' in p && p.net !== NO_NET) nets.add(p.net);
    if (k.startsWith('poly:')) { const pg = e.doc.polygons[Number(k.slice(5))]; if (pg && pg.net !== NO_NET) nets.add(pg.net); }
  }
  if (!nets.size && e.highlightNet !== null && e.highlightNet !== NO_NET) nets.add(e.highlightNet);
  return netsOfSelection(e.doc, nets);
}

function editNetClass(e: PcbEditor, label: string, i: number, members: string[]): void {
  const bags = e.doc.classes.map((c, j) => (j === i ? withMembers(c.bag, members) : c.bag));
  e.undo.transact(label, (tx) => tx.add(setClasses(e.doc, bags)));
}

export function pcbClassCommands(): Command[] {
  const userNetClasses = (e: PcbEditor) => e.doc.classes.map((c, i) => ({ c, i })).filter(({ c }) => c.kind === 0 && !isGenerated(c));
  return [
    { id: 'ad:PCB:Classes', label: 'Classes...', scopes: PCB, enabled: () => !!board(), run: () => { const e = board(); if (e) showDialog(ClassExplorerDialog, { ed: e }); } },
    { id: 'ad:PCB:CreateNetClassFromSelectedNets', label: 'Create NetClass from Selected Nets', scopes: PCB, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const nets = selectedNetNames(e);
      if (!nets.length) { notify('Select objects on the nets first', 'error'); return; }
      showDialog(PromptDialog, { title: 'Create Net Class', fields: [{ label: 'Name', value: freshClassName(e.doc, 0) }], onOk: ([v]: string[]) => {
        const name = (v ?? '').trim();
        if (!name) return;
        if (e.doc.classes.some((c) => c.kind === 0 && c.name.toLowerCase() === name.toLowerCase())) { notify(`There is already a net class "${name}"`, 'error'); return; }
        e.undo.transact(`Create net class ${name}`, (tx) => tx.add(setClasses(e.doc, [...e.doc.classes.map((c) => c.bag), classBag(name, 0, nets)])));
        notify(`Net class ${name}: ${plural(nets.length, 'net')}`);
      } });
    } },
    { id: 'ad:PCB:AddSelectedNetsToNetClass', label: 'Add Selected Nets to NetClass', scopes: PCB, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const nets = selectedNetNames(e), list = userNetClasses(e);
      if (!nets.length) { notify('Select objects on the nets first', 'error'); return; }
      if (!list.length) { notify('The board has no net classes of its own: Create NetClass from Selected Nets makes one', 'error'); return; }
      showDialog(ChooseListDialog, { title: 'Add Nets To Net Class', header: 'Net Class', items: list.map(({ c }) => c.name), onOk: (k: number) => {
        const { c, i } = list[k]!;
        const add = nets.filter((n) => !c.members.some((m) => m.toLowerCase() === n.toLowerCase()));
        if (!add.length) { notify(`Already in ${c.name}`); return; }
        editNetClass(e, `Add nets to ${c.name}`, i, [...c.members, ...add]);
        notify(`${plural(add.length, 'net')} added to ${c.name}`);
      } });
    } },
    { id: 'ad:PCB:RemoveSelectedNetsFromNetClass', label: 'Remove Selected Nets from NetClass', scopes: PCB, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const nets = new Set(selectedNetNames(e).map((n) => n.toLowerCase()));
      const list = userNetClasses(e).filter(({ c }) => c.members.some((m) => nets.has(m.toLowerCase())));
      if (!nets.size) { notify('Select objects on the nets first', 'error'); return; }
      if (!list.length) { notify('No net class holds those nets', 'error'); return; }
      showDialog(ChooseListDialog, { title: 'Remove Nets From Net Class', header: 'Net Class', items: list.map(({ c }) => c.name), onOk: (k: number) => {
        const { c, i } = list[k]!;
        const keep = c.members.filter((m) => !nets.has(m.toLowerCase()));
        editNetClass(e, `Remove nets from ${c.name}`, i, keep);
        notify(`${plural(c.members.length - keep.length, 'net')} taken out of ${c.name}`);
      } });
    } },
  ];
}
