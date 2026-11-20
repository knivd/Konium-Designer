/**
 * Design › Classes (D, C): AD17's Object Class Explorer. The classes as a tree by kind; a class
 * chosen shows its Non-Members and Members, moved across with >, >>, <, <<; right-click a kind or
 * a class to Add, Delete or Rename. "All …" classes and the component classes AD17 generates
 * (Top Side Components …) are shown with their members, not edited. Close applies it all as one
 * undo step [est: AD17 applies as you go].
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { PromptDialog } from './Confirm';
import { openMenuAt } from '../MenuBar';
import { notify } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PropertyBag } from '../../formats/altium/props';
import { readClasses } from '../../formats/altium/rules';
import { CLASS_KINDS, candidates, classBag, isGenerated, membersOf, setClasses, withMembers } from '../../model/pcbClasses';

type Node = { t: 'root' } | { t: 'kind'; kind: number } | { t: 'class'; i: number };

export function ClassExplorerDialog({ ed, focus }: { ed: PcbEditor; focus?: { kind: number; name?: string } }) {
  const doc = ed.doc;
  const [bags, setBags] = useState<PropertyBag[]>(() => doc.classes.map((c) => c.bag.clone()));
  const classes = readClasses(bags);
  const [node, setNode] = useState<Node>(() => {
    if (!focus) return { t: 'root' };
    const i = classes.findIndex((c) => c.kind === focus.kind && c.name === focus.name);
    return i >= 0 ? { t: 'class', i } : { t: 'kind', kind: focus.kind };
  });
  const [open, setOpen] = useState<Set<number>>(() => new Set(focus ? [focus.kind] : [0, 1]));
  const [selL, setSelL] = useState<Set<string>>(new Set());
  const [selR, setSelR] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const update = (next: PropertyBag[]) => { setBags(next); setDirty(true); };

  const close = () => {
    if (dirty) { ed.undo.transact('Edit classes', (tx) => tx.add(setClasses(doc, bags))); ed.invalidate(); }
    closeDialog();
  };
  const addClass = (kind: number) => {
    const k = CLASS_KINDS.find((x) => x.kind === kind)!;
    const taken = new Set(classes.filter((c) => c.kind === kind).map((c) => c.name.toLowerCase()));
    let name = `New ${k.one}`;
    for (let n = 1; taken.has(name.toLowerCase()); n++) name = `New ${k.one} ${n}`;
    const next = [...bags, classBag(name, kind)];
    update(next);
    setOpen(new Set([...open, kind]));
    setNode({ t: 'class', i: next.length - 1 });
  };
  const deleteClass = (i: number) => {
    const c = classes[i];
    if (!c || isGenerated(c)) return;
    update(bags.filter((_, j) => j !== i));
    setNode({ t: 'kind', kind: c.kind });
  };
  const renameClass = (i: number) => {
    const c = classes[i];
    if (!c || isGenerated(c)) return;
    showDialog(PromptDialog, { title: 'Rename Class', fields: [{ label: 'Name', value: c.name }], onOk: ([v]: string[]) => {
      const name = (v ?? '').trim();
      if (!name || name === c.name) return;
      if (classes.some((x, j) => j !== i && x.kind === c.kind && x.name.toLowerCase() === name.toLowerCase())) { notify(`There is already a class "${name}"`, 'error'); return; }
      const nb = bags[i]!.clone(); nb.set('NAME', name);
      update(bags.map((b, j) => (j === i ? nb : b)));
    } });
  };
  const menu = (e: MouseEvent, kind: number, i?: number) => {
    e.preventDefault();
    const c = i !== undefined ? classes[i] : undefined;
    openMenuAt({ key: '', label: '', children: [
      { key: 'A', label: 'Add Class', accelAt: 0, action: () => addClass(kind) },
      { key: 'D', label: 'Delete Class', accelAt: 0, disabled: !c || isGenerated(c), action: () => { if (i !== undefined) deleteClass(i); } },
      { key: 'R', label: 'Rename Class', accelAt: 0, disabled: !c || isGenerated(c), action: () => { if (i !== undefined) renameClass(i); } },
    ] }, e.clientX, e.clientY);
  };

  const cur = node.t === 'class' ? classes[node.i] : undefined;
  const fixed = !!cur && isGenerated(cur);
  const members = cur ? membersOf(doc, cur) : [];
  const memberSet = new Set(members.map((m) => m.toLowerCase()));
  const nonMembers = cur ? candidates(doc, cur.kind).filter((m) => !memberSet.has(m.toLowerCase())) : [];
  const moveItems = (toMembers: boolean, pick: string[]) => {
    if (node.t !== 'class' || !cur || fixed || !pick.length) return;
    const next = toMembers ? [...members, ...pick] : members.filter((m) => !pick.includes(m));
    update(bags.map((b, j) => (j === node.i ? withMembers(b, next) : b)));
    setSelL(new Set()); setSelR(new Set());
  };
  const move = (toMembers: boolean, all: boolean) => moveItems(toMembers, toMembers ? (all ? nonMembers : nonMembers.filter((m) => selL.has(m))) : (all ? members : members.filter((m) => selR.has(m))));
  return (
    <Dialog title="Object Class Explorer" width={860} height={600} onClose={close} class="oce"
      footer={<><span class="spacer" /><button class="btn default" onClick={close}>Close</button></>}>
      <div class="oce-main">
        <div class="oce-tree" role="tree" aria-label="Object Classes">
          <div role="treeitem" class={`oce-node root${node.t === 'root' ? ' on' : ''}`} onMouseDown={() => setNode({ t: 'root' })}>Object Classes</div>
          {CLASS_KINDS.map((k) => {
            const kids = classes.map((c, i) => ({ c, i })).filter((x) => x.c.kind === k.kind);
            const isOpen = open.has(k.kind);
            return (
              <div key={k.kind} role="group">
                <div role="treeitem" aria-expanded={isOpen} class={`oce-node kind${node.t === 'kind' && node.kind === k.kind ? ' on' : ''}`}
                  onMouseDown={() => setNode({ t: 'kind', kind: k.kind })} onContextMenu={(e) => { setNode({ t: 'kind', kind: k.kind }); menu(e, k.kind); }}>
                  <button class="twisty" aria-label={isOpen ? 'Collapse' : 'Expand'} onMouseDown={(e) => { e.stopPropagation(); const n = new Set(open); if (n.has(k.kind)) n.delete(k.kind); else n.add(k.kind); setOpen(n); }}>{kids.length ? (isOpen ? '▾' : '▸') : ''}</button>
                  {k.group}
                </div>
                {isOpen && kids.map(({ c, i }) => (
                  <div key={i} role="treeitem" class={`oce-node cls${node.t === 'class' && node.i === i ? ' on' : ''}${isGenerated(c) ? ' fixed' : ''}`}
                    onMouseDown={() => { setNode({ t: 'class', i }); setSelL(new Set()); setSelR(new Set()); }} onContextMenu={(e) => { setNode({ t: 'class', i }); menu(e, c.kind, i); }}
                    onDblClick={() => renameClass(i)}>{isGenerated(c) ? <b>{c.name}</b> : c.name}</div>
                ))}
              </div>
            );
          })}
        </div>
        <div class="oce-pane">
          {node.t === 'root' && (
            <table class="oce-table"><thead><tr><th>Class Kind</th><th>Classes</th></tr></thead>
              <tbody>{CLASS_KINDS.map((k) => <tr key={k.kind}><td>{k.group}</td><td>{classes.filter((c) => c.kind === k.kind).length}</td></tr>)}</tbody></table>
          )}
          {node.t === 'kind' && (
            <table class="oce-table"><thead><tr><th>Name</th><th>Members</th></tr></thead>
              <tbody>{classes.map((c, i) => ({ c, i })).filter((x) => x.c.kind === node.kind).map(({ c, i }) => (
                <tr key={i} onDblClick={() => setNode({ t: 'class', i })}><td>{c.name}</td><td>{membersOf(doc, c).length}</td></tr>))}</tbody></table>
          )}
          {cur && <>
            {fixed && <p class="muted small">{cur.superClass ? `${cur.name} holds every object of its kind on the board.` : `${cur.name} is worked out from the board: its members are not edited.`}</p>}
            <div class="oce-move">
              <MemberList label="Non-Members" items={fixed ? [] : nonMembers} sel={selL} setSel={setSelL} onOpen={(m) => moveItems(true, [m])} />
              <div class="oce-buttons">
                <button class="btn" disabled={fixed || !selL.size} aria-label="Add the chosen" onClick={() => move(true, false)}>&gt;</button>
                <button class="btn" disabled={fixed || !nonMembers.length} aria-label="Add all" onClick={() => move(true, true)}>&gt;&gt;</button>
                <button class="btn" disabled={fixed || !selR.size} aria-label="Remove the chosen" onClick={() => move(false, false)}>&lt;</button>
                <button class="btn" disabled={fixed || !members.length} aria-label="Remove all" onClick={() => move(false, true)}>&lt;&lt;</button>
              </div>
              <MemberList label="Members" items={members} sel={selR} setSel={setSelR} onOpen={(m) => moveItems(false, [m])} />
            </div>
          </>}
        </div>
      </div>
    </Dialog>
  );
}

/** A list of names: click picks one, Ctrl+click adds or takes one away, double-click moves it across. */
function MemberList(props: { label: string; items: string[]; sel: Set<string>; setSel: (s: Set<string>) => void; onOpen: (m: string) => void }) {
  return (
    <div class="oce-list">
      <div class="oce-list-head">{props.label}</div>
      <div class="oce-list-body" role="listbox" aria-multiselectable="true" aria-label={props.label}>
        {props.items.map((m) => (
          <div key={m} role="option" aria-selected={props.sel.has(m)} class={`oce-item${props.sel.has(m) ? ' on' : ''}`}
            onMouseDown={(e) => { const multi = e.ctrlKey || e.metaKey; const n = new Set(multi ? props.sel : []); if (multi && n.has(m)) n.delete(m); else n.add(m); props.setSel(n); }}
            onDblClick={() => props.onOpen(m)}>{m}</div>
        ))}
      </div>
    </div>
  );
}
