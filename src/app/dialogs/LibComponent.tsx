import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { SR, bagOf, componentKind } from '../../model/sch';
import { componentKindPatch } from '../../model/schProps';
import { addRecords, removeObjects, setProps, uniqueId } from '../../model/schEdit';
import { PropertyBag } from '../../formats/altium/props';
import { setSchCoord } from '../../model/sch';
import type { SchLibEditor } from '../../editors/sch/SchLibEditor';
import type { Change } from '../../core/undo';

/**
 * Tools › Component Properties in the schematic library editor: Altium's Library Component
 * Properties — Symbol Reference, Default Designator and Comment, Description, Type, the PCB
 * footprint model and the component's parameters. OK applies it all as one undo step.
 */
const KINDS: [string, string][] = [['0', 'Standard'], ['1', 'Mechanical'], ['2', 'Graphical'], ['3', 'Net Tie (In BOM)'], ['4', 'Net Tie'], ['5', 'Standard (No BOM)']];

/**
 * The COMPONENT record's keys the Properties set. Type is written as the Inspector and Component
 * Properties write it (componentKindPatch): Standard (No BOM) as COMPONENTKINDVERSION2=5, as Altium
 * writes it and as componentKind and the importers read it.
 */
export function libComponentProps(f: { libRef: string; description: string; kind: string }): Record<string, string | null> {
  return { LIBREFERENCE: f.libRef, DESIGNITEMID: f.libRef, COMPONENTDESCRIPTION: f.description || null, ...componentKindPatch(Number(f.kind) || 0) };
}

export function LibComponentDialog({ ed }: { ed: SchLibEditor }) {
  const doc = ed.doc;
  const comp = ed.component!;
  const cbag = bagOf(doc, comp)!;
  const owned = doc.objects.filter((o) => o.owner === comp.index);
  const textOf = (rec: number, name?: string) => owned.find((o) => o.record === rec && (!name || (bagOf(doc, o)?.get('NAME') ?? '').toLowerCase() === name.toLowerCase()));
  const des = textOf(SR.DESIGNATOR), com = textOf(SR.PARAMETER, 'Comment');
  const params = owned.filter((o) => o.record === SR.PARAMETER && o !== com).map((o) => ({ o, name: bagOf(doc, o)?.get('NAME') ?? '', value: bagOf(doc, o)?.get('TEXT') ?? '' }));
  const impls = doc.objects.filter((o) => o.record === SR.IMPLEMENTATION && (bagOf(doc, o)?.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB');
  const current = impls.find((o) => bagOf(doc, o)?.bool('ISCURRENT')) ?? impls[0];

  const [f, setF] = useState(() => ({
    libRef: cbag.get('LIBREFERENCE') ?? ed.symbol?.libRef ?? '', designator: des ? bagOf(doc, des)?.get('TEXT') ?? '' : 'U?',
    comment: com ? bagOf(doc, com)?.get('TEXT') ?? '' : '', description: cbag.get('COMPONENTDESCRIPTION') ?? '', kind: String(componentKind(cbag)),
    footprint: current ? bagOf(doc, current)?.get('MODELNAME') ?? '' : '',
    params: params.map((p) => ({ name: p.name, value: p.value })),
  }));
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  const ok = () => {
    const ref = f.libRef.trim();
    if (!ref) { notify('A component needs a Symbol Reference', 'error'); return; }
    if (ed.lib.symbols.some((s) => s !== ed.symbol && s.libRef.toLowerCase() === ref.toLowerCase())) { notify(`The library already has ${ref}`, 'error'); return; }
    closeDialog();
    const changes: (() => Change)[] = [];
    const sym = ed.symbol!, oldRef = sym.libRef;
    changes.push(() => setProps(doc, comp.index, libComponentProps({ ...f, libRef: ref })));
    if (ref !== oldRef) changes.push(() => ({ apply: () => { sym.libRef = ref; }, revert: () => { sym.libRef = oldRef; } }));
    const text = (o: typeof des, rec: number, name: string, v: string) => {
      if (o) changes.push(() => setProps(doc, o.index, { TEXT: v }));
      else {
        const b = PropertyBag.from({ RECORD: rec, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: v, NAME: name, UNIQUEID: uniqueId(), OWNERINDEX: comp.index });
        setSchCoord(b, 'LOCATION.X', 0); setSchCoord(b, 'LOCATION.Y', 0);
        changes.push(() => addRecords(doc, [b]));
      }
    };
    text(des, SR.DESIGNATOR, 'Designator', f.designator);
    text(com, SR.PARAMETER, 'Comment', f.comment);
    // Parameters: changed values, removed ones, new ones
    const keep = new Map(f.params.filter((p) => p.name.trim()).map((p) => [p.name.trim().toLowerCase(), p]));
    const removed = params.filter((p) => !keep.has(p.name.toLowerCase())).map((p) => p.o.index);
    for (const p of params) { const n = keep.get(p.name.toLowerCase()); if (n && n.value !== p.value) changes.push(() => setProps(doc, p.o.index, { TEXT: n.value })); }
    const fresh = [...keep.values()].filter((p) => !params.some((q) => q.name.toLowerCase() === p.name.trim().toLowerCase()));
    if (fresh.length) changes.push(() => addRecords(doc, fresh.map((p) => PropertyBag.from({ RECORD: SR.PARAMETER, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, ISHIDDEN: 'T', TEXT: p.value, NAME: p.name.trim(), UNIQUEID: uniqueId(), OWNERINDEX: comp.index }))));
    // Footprint: rename the current PCB model, or add one
    const fp = f.footprint.trim();
    if (current && fp) changes.push(() => setProps(doc, current.index, { MODELNAME: fp, MODELDATAFILEENTITY0: fp }));
    else if (fp) changes.push(() => addFootprint(ed, fp));
    if (removed.length) changes.push(() => removeObjects(doc, removed));
    ed.undo.transact('Component properties', (tx) => { for (const c of changes) tx.add(c()); });
    ed.invalidate();
  };

  return (
    <Dialog title="Library Component Properties" width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="libcomp"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="libcomp-body">
        <fieldset><legend>Properties</legend>
          <label>Symbol Reference<input type="text" value={f.libRef} autofocus onInput={(e) => set({ libRef: (e.target as HTMLInputElement).value })} /></label>
          <label>Default Designator<input type="text" value={f.designator} onInput={(e) => set({ designator: (e.target as HTMLInputElement).value })} /></label>
          <label>Default Comment<input type="text" value={f.comment} onInput={(e) => set({ comment: (e.target as HTMLInputElement).value })} /></label>
          <label>Description<input type="text" value={f.description} onInput={(e) => set({ description: (e.target as HTMLInputElement).value })} /></label>
          <label>Type<select value={f.kind} onChange={(e) => set({ kind: (e.target as HTMLSelectElement).value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>Footprint<input type="text" value={f.footprint} placeholder="PCB library footprint name" onInput={(e) => set({ footprint: (e.target as HTMLInputElement).value })} /></label>
          <p class="muted small">{ed.partCount} part{ed.partCount === 1 ? '' : 's'}</p>
        </fieldset>
        <fieldset class="libcomp-params"><legend>Parameters</legend>
          <div class="libcomp-row libcomp-head"><span>Name</span><span>Value</span><span /></div>
          {f.params.map((p, i) => (
            <div key={i} class="libcomp-row">
              <input type="text" value={p.name} aria-label="Parameter name" onInput={(e) => set({ params: f.params.map((q, k) => (k === i ? { ...q, name: (e.target as HTMLInputElement).value } : q)) })} />
              <input type="text" value={p.value} aria-label="Parameter value" onInput={(e) => set({ params: f.params.map((q, k) => (k === i ? { ...q, value: (e.target as HTMLInputElement).value } : q)) })} />
              <button class="btn" aria-label={`Remove ${p.name}`} onClick={() => set({ params: f.params.filter((_, k) => k !== i) })}>×</button>
            </div>
          ))}
          <button class="btn" onClick={() => set({ params: [...f.params, { name: '', value: '' }] })}>Add...</button>
        </fieldset>
      </div>
    </Dialog>
  );
}

/** A PCB footprint model on the shown symbol: IMPLEMENTATION (+ its map and parameter lists) under the list. */
export function addFootprint(ed: SchLibEditor, name: string): Change {
  const doc = ed.doc;
  const comp = ed.component!;
  const list = doc.objects.find((o) => o.record === SR.IMPLEMENTATION_LIST && o.owner === comp.index);
  const base = doc.records.length - 1;
  const bags: PropertyBag[] = [];
  let listIndex = list?.index;
  if (listIndex === undefined) { bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: comp.index })); listIndex = base; }
  const impl = base + bags.length;
  bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: listIndex, MODELNAME: name, MODELTYPE: 'PCBLIB', DATAFILECOUNT: 1,
    MODELDATAFILEENTITY0: name, MODELDATAFILEKIND0: 'PCBLib', ISCURRENT: 'T', UNIQUEID: uniqueId() }));
  bags.push(PropertyBag.from({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl }), PropertyBag.from({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl }));
  return addRecords(doc, bags);
}
