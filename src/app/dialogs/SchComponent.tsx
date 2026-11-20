import { schUnitsOf } from '../newSheet';
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourDialog } from './Pickers';
import { PromptDialog } from './Confirm';
import { AddRuleDialog } from './AddRule';
import { isRuleParameter, ruleSummary } from '../../model/schRules';
import { SiModelsDialog } from './SignalIntegrity';
import { PcbModelDialog, type PcbModelValue } from './PcbModel';
import { PlacePartDialog, availableLibraries, type PartChoice } from './PlacePart';
import { applyPartUpdates, updatedPart } from '../../model/schUpdate';
import { notify, units } from '../state';
import { SchEditor } from '../../editors/sch/SchEditor';
import { PropertyBag } from '../../formats/altium/props';
import { ELECTRICAL } from '../../model/compile';
import { partLetter, SR, bagOf, rederive, schCoord, setSchCoord, type SchDocument, type SchObject } from '../../model/sch';
import { addRecords, removeObjects, replaceBags, setProps, uniqueId } from '../../model/schEdit';
import { footprintModelBag, withModelLibrary } from '../../model/libModels';
import { SimModelDialog, newSimModel, type SimModelValue } from './SimModel';
import { simModelAt, simModelBags } from '../../model/simModels';
import { MODEL_KINDS } from '../../model/simKinds';
import { modelFinder } from '../simRun';
import { activeProject } from '../project';
import {
  COMPONENT_KINDS, ORIENTATIONS, componentKind, componentKindPatch, fmtCoord, hexOf, bgrOf, schProps, type SchCtx,
} from '../../model/schProps';
import type { Change } from '../../core/undo';

/**
 * Double-click on a part: Altium Designer 17's "Properties for Schematic Component in Sheet"
 * — Properties (designator, comment, part, description, unique id, type), Link to Library
 * Component, Graphical (location, orientation, mode, locks, mirror, local colours), the
 * Parameters list and the Models list; Edit Pins... opens the Component Pin Editor.
 * OK applies everything as one undo step.
 */

interface ParamRow { index?: number; name: string; value: string; visible: boolean; type: string; /** A design rule: its summary, shown in place of its value. */ rule?: string }
interface ModelRow { index?: number; name: string; type: string; description: string; current: boolean; raw: string; useLib?: boolean; library?: string; /** A SIM model as the Sim Model dialog left it (written anew on OK). */ sim?: SimModelValue }

const MODEL_TYPES: Record<string, string> = { PCBLIB: 'Footprint', SIM: 'Simulation', SI: 'Signal Integrity', PCB3DLIB: 'PCB3D', IBIS: 'Ibis Model' };

function childrenOf(doc: SchDocument, comp: number) { return doc.objects.filter((o) => o.owner === comp); }
const nameOf = (doc: SchDocument, o: SchObject) => bagOf(doc, o)?.get('NAME') ?? '';

function modelsOf(doc: SchDocument, comp: number): SchObject[] {
  const lists = new Set(doc.objects.filter((o) => o.owner === comp && o.record === SR.IMPLEMENTATION_LIST).map((o) => o.index));
  return doc.objects.filter((o) => o.record === SR.IMPLEMENTATION && lists.has(o.owner));
}

export interface SchComponentDialogProps {
  ed: SchEditor;
  index: number;
  docName: string;
  /** Placing (Tab): no location — the cursor decides; called once OK has applied the changes. */
  template?: boolean;
  onDone?: () => void;
}

export function SchComponentDialog({ ed, index, docName, template, onDone }: SchComponentDialogProps) {
  const doc = ed.doc;
  const comp = doc.objects[index]!;
  const cb = bagOf(doc, comp)!;
  const u = schUnitsOf(ed, units.value);
  const x: SchCtx = { doc, index, units: u, docName, libraryMode: ed.libraryMode };
  const props = schProps(doc, comp, ed.libraryMode);
  const prop = (name: string) => props.find((p) => p.name === name)!;
  const kids = childrenOf(doc, index);
  const des = kids.find((o) => o.record === SR.DESIGNATOR);
  const com = kids.find((o) => o.record === SR.PARAMETER && nameOf(doc, o).toLowerCase() === 'comment');
  const params0: ParamRow[] = kids.filter((o) => o.record === SR.PARAMETER && o !== com).map((o) => {
    const b = bagOf(doc, o)!;
    const text = b.get('TEXT') ?? '';
    return { index: o.index, name: b.get('NAME') ?? '', value: text, visible: !b.bool('ISHIDDEN'), type: b.get('PARAMTYPE') ?? 'STRING', ...(isRuleParameter(b.get('NAME'), text) ? { rule: b.get('DESCRIPTION') || ruleSummary(text) } : {}) };
  });
  const models0: ModelRow[] = modelsOf(doc, index).map((o) => {
    const b = bagOf(doc, o)!;
    const raw = (b.get('MODELTYPE') ?? '').toUpperCase();
    return { index: o.index, name: b.get('MODELNAME') ?? '', type: MODEL_TYPES[raw] ?? raw, description: b.get('DESCRIPTION') ?? '', current: b.bool('ISCURRENT'), raw, useLib: b.bool('USECOMPONENTLIBRARY'), library: b.get('MODELDATAFILE0') ?? '' };
  });
  const partCount = Math.max(1, cb.int('PARTCOUNT', 2) - 1);
  const modes = Math.max(1, cb.int('DISPLAYMODECOUNT', 1));

  const [f, setF] = useState(() => ({
    designator: des ? bagOf(doc, des)?.get('TEXT') ?? '' : '', desVisible: !!des && !bagOf(doc, des)?.bool('ISHIDDEN'), desLocked: cb.bool('DESIGNATORLOCKED'),
    comment: com ? bagOf(doc, com)?.get('TEXT') ?? '' : '', comVisible: !!com && !bagOf(doc, com)?.bool('ISHIDDEN'),
    part: cb.int('CURRENTPARTID', 1), partLocked: cb.bool('PARTIDLOCKED'),
    description: cb.get('COMPONENTDESCRIPTION') ?? '', uniqueId: cb.get('UNIQUEID') ?? '', kind: componentKind(cb),
    designItemId: cb.get('DESIGNITEMID') ?? cb.get('LIBREFERENCE') ?? '', library: cb.get('SOURCELIBRARYNAME') ?? '', table: cb.get('DATABASETABLENAME') ?? '',
    // Library Name / Table Name ticked: the link names them; unticked, any library (USELIBRARYNAME, USEDBTABLENAME [est])
    useLibrary: cb.has('USELIBRARYNAME') ? cb.bool('USELIBRARYNAME') : true, useTable: cb.has('USEDBTABLENAME') ? cb.bool('USEDBTABLENAME') : !!cb.get('DATABASETABLENAME'),
    x: fmtCoord(schCoord(cb, 'LOCATION.X'), u), y: fmtCoord(schCoord(cb, 'LOCATION.Y'), u), orientation: ORIENTATIONS[cb.int('ORIENTATION') & 3]!,
    locked: cb.bool('GRAPHICALLYLOCKED'), mode: cb.int('DISPLAYMODE'), lockPins: !cb.bool('PINSMOVEABLE'), mirrored: cb.bool('ISMIRRORED'),
    showPins: cb.bool('SHOWHIDDENPINS'), localColours: cb.bool('OVERIDECOLORS'), fill: hexOf(cb.int('AREACOLOR', 11599871)), line: hexOf(cb.int('COLOR', 128)),
  }));
  const [params, setParams] = useState<ParamRow[]>(params0);
  const [models, setModels] = useState<ModelRow[]>(models0);
  const [pSel, setPSel] = useState<number | null>(params.length ? 0 : null);
  const [mSel, setMSel] = useState<number | null>(models.length ? 0 : null);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  /** Choose…: Browse Libraries; the picked symbol replaces this part's at once, then its properties open again. */
  const choose = () => showDialog(PlacePartDialog, { choose: true, onPlace: (c: PartChoice) => {
    if (template) { notify('Choose a different part from Place › Part while placing', 'error'); return; }
    const r = updatedPart(doc, index, c.symbol, c.library, { graphics: true, parameters: 'replace', models: true });
    if (!r) return;
    ed.undo.transact(`Replace ${f.designator || 'part'} with ${c.symbol.libRef}`, (tx) => tx.add(applyPartUpdates(doc, [r])));
    ed.invalidate();
    closeDialog();
    const ni = doc.objects.length - r.items.length;
    ed.select([`o${ni}`]);
    setTimeout(() => showDialog(SchComponentDialog, { ed, index: ni, docName, onDone }), 0);
  } });

  const ok = () => {
    const ch: (() => Change | null)[] = [];
    const patch: Record<string, string | null> = {};
    const flag = (k: string, on: boolean, was: boolean) => { if (on !== was) patch[k] = on ? 'T' : null; };
    flag('DESIGNATORLOCKED', f.desLocked, cb.bool('DESIGNATORLOCKED'));
    flag('PARTIDLOCKED', f.partLocked, cb.bool('PARTIDLOCKED'));
    flag('GRAPHICALLYLOCKED', f.locked, cb.bool('GRAPHICALLYLOCKED'));
    flag('OVERIDECOLORS', f.localColours, cb.bool('OVERIDECOLORS'));
    flag('SHOWHIDDENPINS', f.showPins, cb.bool('SHOWHIDDENPINS'));
    if (f.lockPins !== !cb.bool('PINSMOVEABLE')) patch.PINSMOVEABLE = f.lockPins ? null : 'T';
    if (f.description !== (cb.get('COMPONENTDESCRIPTION') ?? '')) patch.COMPONENTDESCRIPTION = f.description || null;
    if (f.uniqueId !== (cb.get('UNIQUEID') ?? '') && f.uniqueId) patch.UNIQUEID = f.uniqueId;
    if (f.kind !== componentKind(cb)) Object.assign(patch, componentKindPatch(f.kind));
    if (f.designItemId !== (cb.get('DESIGNITEMID') ?? cb.get('LIBREFERENCE') ?? '')) patch.DESIGNITEMID = f.designItemId;
    if (f.library !== (cb.get('SOURCELIBRARYNAME') ?? '')) patch.SOURCELIBRARYNAME = f.library;
    if (f.table !== (cb.get('DATABASETABLENAME') ?? '')) patch.DATABASETABLENAME = f.table || null;
    if (f.useLibrary !== (cb.has('USELIBRARYNAME') ? cb.bool('USELIBRARYNAME') : true)) patch.USELIBRARYNAME = f.useLibrary ? 'T' : 'F';
    if (f.useTable !== (cb.has('USEDBTABLENAME') ? cb.bool('USEDBTABLENAME') : !!cb.get('DATABASETABLENAME'))) patch.USEDBTABLENAME = f.useTable ? 'T' : 'F';
    if (f.mode !== cb.int('DISPLAYMODE')) patch.DISPLAYMODE = f.mode ? String(f.mode) : null;
    if (f.part !== cb.int('CURRENTPARTID', 1)) patch.CURRENTPARTID = String(f.part);
    if (f.localColours) {
      const fill = bgrOf(f.fill), line = bgrOf(f.line);
      if (fill !== undefined && fill !== cb.int('AREACOLOR', 11599871)) patch.AREACOLOR = String(fill);
      if (line !== undefined && line !== cb.int('COLOR', 128)) patch.COLOR = String(line);
    }
    if (Object.keys(patch).length) ch.push(() => setProps(doc, index, patch));
    // Location, orientation and mirror carry the pins, graphics and parameters along
    for (const [name, v] of [['X1', f.x], ['Y1', f.y], ['Orientation', f.orientation], ['Mirrored', String(f.mirrored)]] as const) {
      if (v !== prop(name).get(x)) ch.push(() => prop(name).set!(x, v));
    }
    // Designator and comment
    const text = (o: SchObject | undefined, name: string, rec: number, value: string, visible: boolean) => {
      if (o) {
        const b = bagOf(doc, o)!;
        const p: Record<string, string | null> = {};
        if (value !== (b.get('TEXT') ?? '')) p.TEXT = value;
        if (visible === b.bool('ISHIDDEN')) p.ISHIDDEN = visible ? null : 'T';
        if (Object.keys(p).length) ch.push(() => setProps(doc, o.index, p));
      } else if (value) {
        ch.push(() => {
          const at = { x: schCoord(bagOf(doc, doc.objects[index]!)!, 'LOCATION.X'), y: schCoord(bagOf(doc, doc.objects[index]!)!, 'LOCATION.Y') };
          const b = PropertyBag.from({ RECORD: rec, OWNERINDEX: index, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: value, NAME: name, UNIQUEID: uniqueId() });
          if (!visible) b.set('ISHIDDEN', 'T');
          if (rec === SR.DESIGNATOR) b.set('READONLYSTATE', '1');
          setSchCoord(b, 'LOCATION.X', at.x); setSchCoord(b, 'LOCATION.Y', at.y + (rec === SR.DESIGNATOR ? 1 : -1) * 10 * 100_000);
          return addRecords(doc, [b]);
        });
      }
    };
    text(des, 'Designator', SR.DESIGNATOR, f.designator, f.desVisible);
    text(com, 'Comment', SR.PARAMETER, f.comment, f.comVisible);
    // Parameters
    for (const p of params) {
      const o = p.index !== undefined ? doc.objects[p.index] : undefined;
      if (o) {
        const b = bagOf(doc, o)!, q: Record<string, string | null> = {};
        if (p.name !== (b.get('NAME') ?? '')) q.NAME = p.name;
        if (p.value !== (b.get('TEXT') ?? '')) q.TEXT = p.value;
        if (p.visible === b.bool('ISHIDDEN')) q.ISHIDDEN = p.visible ? null : 'T';
        if (Object.keys(q).length) ch.push(() => setProps(doc, o.index, q));
      } else if (p.name.trim()) {
        ch.push(() => {
          const cbag = bagOf(doc, doc.objects[index]!)!;
          const b = PropertyBag.from({ RECORD: SR.PARAMETER, OWNERINDEX: index, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: p.value, NAME: p.name.trim(), UNIQUEID: uniqueId() });
          if (p.rule) b.set('DESCRIPTION', p.rule);
          if (!p.visible) b.set('ISHIDDEN', 'T');
          setSchCoord(b, 'LOCATION.X', schCoord(cbag, 'LOCATION.X')); setSchCoord(b, 'LOCATION.Y', schCoord(cbag, 'LOCATION.Y') - 20 * 100_000);
          return addRecords(doc, [b]);
        });
      }
    }
    // Models: renamed, made current, added
    let list = doc.objects.find((o) => o.owner === index && o.record === SR.IMPLEMENTATION_LIST)?.index;
    const simGone: number[] = [];
    for (const m of models) {
      const o = m.index !== undefined ? doc.objects[m.index] : undefined;
      // A SIM model from the Sim Model dialog: written as AD keeps it (an edited one replaces the old records)
      if (m.raw === 'SIM' && m.sim) {
        const sim = m.sim;
        if (o) simGone.push(o.index);
        ch.push(() => {
          const bags: PropertyBag[] = [];
          const base = doc.records.length - 1;
          if (list === undefined) { bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: index })); list = base; }
          bags.push(...simModelBags(list, base + bags.length, { ...sim, name: m.name || sim.name, description: m.description, current: m.current }));
          return addRecords(doc, bags);
        });
        continue;
      }
      if (o) {
        const b = bagOf(doc, o)!, q: Record<string, string | null> = {};
        if (m.name !== (b.get('MODELNAME') ?? '')) { q.MODELNAME = m.name; if (b.has('MODELDATAFILEENTITY0')) q.MODELDATAFILEENTITY0 = m.name; }
        if (m.description !== (b.get('DESCRIPTION') ?? '')) q.DESCRIPTION = m.description || null;
        if (m.current !== b.bool('ISCURRENT')) q.ISCURRENT = m.current ? 'T' : null;
        if (m.raw === 'PCBLIB' && !!m.useLib !== b.bool('USECOMPONENTLIBRARY')) q.USECOMPONENTLIBRARY = m.useLib ? 'T' : null;
        if (Object.keys(q).length) ch.push(() => setProps(doc, o.index, q));
        // PCB Library › Library name / path: MODELDATAFILE0, in its place before the entity
        const lib = m.useLib ? '' : m.library ?? '';
        if (m.raw === 'PCBLIB' && lib !== (b.get('MODELDATAFILE0') ?? '')) ch.push(() => { const now = bagOf(doc, doc.objects[o.index]!)!; return replaceBags(doc, [{ index: o.index, before: now.clone(), after: withModelLibrary(now, lib) }]); });
      } else {
        ch.push(() => {
          const bags: PropertyBag[] = [];
          const base = doc.records.length - 1;
          if (list === undefined) { bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: index })); list = base; }
          const impl = base + bags.length;
          // PCB Library › Any writes neither USECOMPONENTLIBRARY nor MODELDATAFILE0 (as AD's PCB Model dialog does)
          bags.push(footprintModelBag(list, { name: m.name, description: m.description, current: m.current, useComponentLibrary: m.useLib, library: m.library }));
          bags.push(PropertyBag.from({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl }), PropertyBag.from({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl }));
          return addRecords(doc, bags);
        });
      }
    }
    // Removals last: they renumber what follows
    const gone = [...params0.filter((p) => !params.some((q) => q.index === p.index)).map((p) => p.index!), ...models0.filter((m) => !models.some((q) => q.index === m.index)).map((m) => m.index!), ...simGone];
    if (gone.length) ch.push(() => removeObjects(doc, gone));
    closeDialog();
    if (ch.length) {
      ed.undo.transact(`Properties of ${f.designator || 'part'}`, (tx) => { for (const c of ch) { const v = c(); if (v) tx.add(v); } });
      ed.invalidate();
    }
    onDone?.();
  };

  const validate = () => {
    const id = f.designItemId.trim().toLowerCase();
    const libs = availableLibraries().filter((l) => !f.useLibrary || !f.library || l.name.toLowerCase() === f.library.toLowerCase());
    const hit = libs.find((l) => l.symbols.some((s) => s.libRef.toLowerCase() === id));
    notify(hit ? `${f.designItemId} found in ${hit.name}` : `${f.designItemId} isn't in ${f.library || 'the available libraries'}`, hit ? 'ok' : 'error');
  };

  const addParam = () => showDialog(PromptDialog, { title: 'Parameter Properties', fields: [{ label: 'Name', value: `Parameter${params.length + 1}` }, { label: 'Value', value: '' }],
    onOk: ([n, v]: string[]) => { if (!n?.trim()) return; setParams([...params, { name: n.trim(), value: v ?? '', visible: false, type: 'STRING' }]); setPSel(params.length); } });
  // The PCB Model dialog: Browse, Pin Map, PCB Library, the footprint drawn
  const srcLib = cb.get('SOURCELIBRARYNAME') ?? cb.get('LIBRARYPATH') ?? '';
  const pinList = doc.objects.filter((o) => o.owner === index && o.kind === 'pin').map((o) => { const b = bagOf(doc, o)!; return { designator: b.get('DESIGNATOR') ?? '', name: b.get('NAME') ?? '' }; });
  const modelDialog = (value: PcbModelValue, onOk: (v: PcbModelValue) => void) =>
    showDialog(PcbModelDialog, { value, componentLibrary: srcLib, integrated: /\.intlib$/i.test(srcLib), pins: pinList, onOk });
  const addModel = () => modelDialog({ name: '', description: '', useComponentLibrary: false }, (v) => {
    const first = !models.some((m) => m.raw === 'PCBLIB');
    setModels([...models, { name: v.name, type: 'Footprint', description: v.description, current: first, raw: 'PCBLIB', useLib: v.useComponentLibrary, library: v.library ?? '' }]);
    setMSel(models.length);
  });
  // The Sim Model dialog: the part's pins, its own parameters (for Component parameter values), the project's model files
  const partParam = (n: string) => { const q = params.find((x) => x.name.toLowerCase() === n.toLowerCase()); return q ? q.value : n.toLowerCase() === 'comment' ? f.comment : undefined; };
  const simDialog = (value: SimModelValue, onOk: (v: SimModelValue) => void) =>
    showDialog(SimModelDialog, { value, pins: pinList, partParam, findModel: modelFinder(activeProject()), onOk });
  /** A new SIM model of the sub-kind the designator suggests (R a resistor, Q a BJT, U a subcircuit …). */
  const addSimModel = () => {
    const letter = (f.designator.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
    const [kind, sub] = ({ R: ['General', 'Resistor'], C: ['General', 'Capacitor'], L: ['General', 'Inductor'], D: ['General', 'Diode'], Q: ['Transistor', 'BJT'], M: ['Transistor', 'MOSFET'],
      J: ['Transistor', 'JFET'], V: ['Voltage Source', 'DC Source'], I: ['Current Source', 'DC Source'], U: ['General', 'Spice Subcircuit'], X: ['General', 'Spice Subcircuit'] } as Record<string, [string, string]>)[letter] ?? ['General', 'Resistor'];
    simDialog(newSimModel(kind, MODEL_KINDS[kind]!.find((x) => x.name === sub)!, pinList), (v) => {
      const first = !models.some((m) => m.raw === 'SIM');
      setModels([...models, { name: v.name, type: 'Simulation', description: v.description, current: first, raw: 'SIM', sim: v }]);
      setMSel(models.length);
    });
  };
  const editModel = () => {
    const m = mSel !== null ? models[mSel] : undefined;
    if (!m) return;
    if (m.raw === 'SIM') {
      const was = m.sim ?? (() => {
        const r = m.index !== undefined ? simModelAt(doc, m.index) : null;
        if (!r) return null;
        const names = r.names ?? [...r.params.keys()];
        return { name: r.name, description: r.description ?? '', kind: r.kind, subKind: r.subKind, prefix: r.prefix, netlist: r.netlist,
          ...(r.fileName || r.fileKind ? { file: { entity: r.fileName, kind: r.fileKind || 'MDL' } } : {}),
          params: names.map((n) => [n, r.params.get(n.toUpperCase()) ?? ''] as [string, string]), portMap: [...r.portMap] } as SimModelValue;
      })();
      if (!was) return;
      simDialog(was, (v) => setModels(models.map((q, i) => (i === mSel ? { ...q, name: v.name || q.name, description: v.description, sim: v } : q))));
      return;
    }
    if (m.raw === 'PCBLIB') {
      modelDialog({ name: m.name, description: m.description, useComponentLibrary: !!m.useLib, library: m.library ?? '' },
        (v) => setModels(models.map((q, i) => (i === mSel ? { ...q, name: v.name || q.name, description: v.description, useLib: v.useComponentLibrary, library: v.library ?? '' } : q))));
      return;
    }
    showDialog(PromptDialog, { title: `${m.type} Model`, fields: [{ label: 'Model Name', value: m.name }, { label: 'Description', value: m.description }],
      onOk: ([n, d]: string[]) => setModels(models.map((q, i) => (i === mSel ? { ...q, name: n?.trim() || q.name, description: d ?? '' } : q))) });
  };
  const [addMenu, setAddMenu] = useState(false);
  const footprints = models.filter((m) => m.raw === 'PCBLIB');
  const commentChoices = params.map((p) => `=${p.name}`);

  return (
    <Dialog title={`Properties for Schematic Component in Sheet [${docName}]`} width={1080} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="compprops"
      footer={<><button class="btn" onClick={() => showDialog(PinEditorDialog, { ed, comp: index })}>Edit Pins...</button><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="compprops-cols">
        <div class="compprops-left">
          <fieldset><legend>Properties</legend>
            <div class="cp-row"><span class="dlg-label">Designator</span><input type="text" value={f.designator} autofocus onInput={(e) => set({ designator: (e.target as HTMLInputElement).value })} />
              <label class="cp-check"><input type="checkbox" checked={f.desVisible} onChange={(e) => set({ desVisible: (e.target as HTMLInputElement).checked })} />Visible</label>
              <label class="cp-check"><input type="checkbox" checked={f.desLocked} onChange={(e) => set({ desLocked: (e.target as HTMLInputElement).checked })} />Locked</label></div>
            <div class="cp-row"><span class="dlg-label">Comment</span><input type="text" list="cp-comment-list" value={f.comment} onInput={(e) => set({ comment: (e.target as HTMLInputElement).value })} />
              <datalist id="cp-comment-list">{commentChoices.map((c) => <option key={c} value={c} />)}</datalist>
              <label class="cp-check"><input type="checkbox" checked={f.comVisible} onChange={(e) => set({ comVisible: (e.target as HTMLInputElement).checked })} />Visible</label><span /></div>
            <div class="cp-row cp-parts"><span />
              <span class="cp-partnav">
                <button class="btn" disabled={f.part <= 1} onClick={() => set({ part: 1 })}>&lt;&lt;</button>
                <button class="btn" disabled={f.part <= 1} onClick={() => set({ part: f.part - 1 })}>&lt;</button>
                <button class="btn" disabled={f.part >= partCount} onClick={() => set({ part: f.part + 1 })}>&gt;</button>
                <button class="btn" disabled={f.part >= partCount} onClick={() => set({ part: partCount })}>&gt;&gt;</button>
              </span>
              <span class="cp-partno">Part {f.part}/{partCount}</span>
              <label class="cp-check"><input type="checkbox" checked={f.partLocked} onChange={(e) => set({ partLocked: (e.target as HTMLInputElement).checked })} />Locked</label></div>
            <div class="cp-row wide"><span class="dlg-label">Description</span><input type="text" value={f.description} onInput={(e) => set({ description: (e.target as HTMLInputElement).value })} /></div>
            <div class="cp-row"><span class="dlg-label">Unique Id</span><input type="text" value={f.uniqueId} onInput={(e) => set({ uniqueId: (e.target as HTMLInputElement).value })} />
              <button class="btn" onClick={() => set({ uniqueId: uniqueId() })}>Reset</button><span /></div>
            <div class="cp-row wide"><span class="dlg-label">Type</span><select value={String(f.kind)} onChange={(e) => set({ kind: Number((e.target as HTMLSelectElement).value) })}>{COMPONENT_KINDS.map((k, i) => <option key={k} value={String(i)}>{k}</option>)}</select></div>
          </fieldset>
          <fieldset><legend>Link to Library Component</legend>
            <div class="cp-row"><span class="dlg-label">Design Item ID</span><input type="text" value={f.designItemId} onInput={(e) => set({ designItemId: (e.target as HTMLInputElement).value })} />
              <button class="btn" onClick={choose} title="Replace the symbol with one from a library (designator and placement kept)">Choose...</button><span /></div>
            <div class="cp-row wide"><label class="cp-check" title="Unticked: the symbol is looked for in any library"><input type="checkbox" checked={f.useLibrary} onChange={(e) => set({ useLibrary: (e.target as HTMLInputElement).checked })} />Library Name</label>
              <input type="text" value={f.library} disabled={!f.useLibrary} onInput={(e) => set({ library: (e.target as HTMLInputElement).value })} /></div>
            <div class="cp-row wide"><label class="cp-check" title="A database library's table the part comes from"><input type="checkbox" checked={f.useTable} onChange={(e) => set({ useTable: (e.target as HTMLInputElement).checked })} />Table Name</label>
              <input type="text" value={f.table} disabled={!f.useTable} onInput={(e) => set({ table: (e.target as HTMLInputElement).value })} /></div>
            <div class="cp-validate"><button class="btn" onClick={validate}>Validate Link</button></div>
          </fieldset>
          <fieldset><legend>Graphical</legend>
            {!template && <div class="cp-row cp-loc"><span class="dlg-label">Location</span><span>X</span><input type="text" value={f.x} onInput={(e) => set({ x: (e.target as HTMLInputElement).value })} />
              <span>Y</span><input type="text" value={f.y} onInput={(e) => set({ y: (e.target as HTMLInputElement).value })} /></div>}
            <div class="cp-row"><span class="dlg-label">Orientation</span><select value={f.orientation} onChange={(e) => set({ orientation: (e.target as HTMLSelectElement).value as typeof f.orientation })}>{ORIENTATIONS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              <label class="cp-check"><input type="checkbox" checked={f.locked} onChange={(e) => set({ locked: (e.target as HTMLInputElement).checked })} />Locked</label><span /></div>
            <div class="cp-row"><span class="dlg-label">Mode</span><select value={String(f.mode)} disabled={modes < 2} onChange={(e) => set({ mode: Number((e.target as HTMLSelectElement).value) })}>
              {Array.from({ length: modes }, (_, i) => <option key={i} value={String(i)}>{i ? `Alternate ${i}` : 'Normal'}</option>)}</select>
              <label class="cp-check"><input type="checkbox" checked={f.lockPins} onChange={(e) => set({ lockPins: (e.target as HTMLInputElement).checked })} />Lock Pins</label>
              <label class="cp-check"><input type="checkbox" checked={f.mirrored} onChange={(e) => set({ mirrored: (e.target as HTMLInputElement).checked })} />Mirrored</label></div>
            <label class="cp-check cp-line"><input type="checkbox" checked={f.showPins} onChange={(e) => set({ showPins: (e.target as HTMLInputElement).checked })} />Show All Pins On Sheet (Even if Hidden)</label>
            <div class="cp-line cp-colours"><label class="cp-check"><input type="checkbox" checked={f.localColours} onChange={(e) => set({ localColours: (e.target as HTMLInputElement).checked })} />Local Colours</label>
              {f.localColours && <>
                <span>Fills</span><button class="dlg-colour" aria-label="Fill colour" onClick={() => showDialog(ColourDialog, { value: f.fill, onOk: (v: string) => set({ fill: v }) })}><span class="swatch" style={{ background: f.fill }} /></button>
                <span>Lines</span><button class="dlg-colour" aria-label="Line colour" onClick={() => showDialog(ColourDialog, { value: f.line, onOk: (v: string) => set({ line: v }) })}><span class="swatch" style={{ background: f.line }} /></button>
              </>}</div>
          </fieldset>
        </div>
        <div class="compprops-right">
          <fieldset class="cp-params"><legend>Parameters</legend>
            <div class="cp-grid" role="grid">
              <div class="cp-grow cp-ghead" role="row"><span>Visible</span><span>Name</span><span>Value</span><span>Type</span></div>
              {params.map((p, i) => (
                <div key={i} class={`cp-grow${pSel === i ? ' on' : ''}`} role="row" onMouseDown={() => setPSel(i)}>
                  <span><input type="checkbox" checked={p.visible} aria-label={`${p.name} visible`} onChange={(e) => setParams(params.map((q, k) => (k === i ? { ...q, visible: (e.target as HTMLInputElement).checked } : q)))} /></span>
                  <input type="text" value={p.name} aria-label="Parameter name" onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, name: (e.target as HTMLInputElement).value } : q)))} />
                  <input type="text" value={p.rule ?? p.value} readOnly={!!p.rule} title={p.rule ? 'A design rule: remove it and Add as Rule... again to change it' : undefined} aria-label={`${p.name} value`}
                    onInput={(e) => setParams(params.map((q, k) => (k === i ? { ...q, value: (e.target as HTMLInputElement).value } : q)))} />
                  <span>{p.type}</span>
                </div>
              ))}
            </div>
            <div class="cp-buttons">
              <button class="btn" onClick={addParam}>Add...</button>
              <button class="btn" disabled={pSel === null || !params[pSel]} onClick={() => { setParams(params.filter((_, k) => k !== pSel)); setPSel(null); }}>Remove...</button>
              <button class="btn" disabled={pSel === null || !params[pSel]} onClick={() => (document.querySelector(`.cp-params .cp-grow.on input[type=text]:nth-of-type(2)`) as HTMLInputElement | null)?.focus()}>Edit...</button>
              <button class="btn" title="A design rule for this component, added to the board by Update PCB Document"
                onClick={() => showDialog(AddRuleDialog, { onOk: (text: string, description: string) => { setParams([...params, { name: 'Rule', value: text, rule: description, visible: false, type: 'STRING' }]); setPSel(params.length); } })}>Add as Rule...</button>
            </div>
          </fieldset>
          <fieldset class="cp-models"><legend>Models</legend>
            <div class="cp-grid cp-mgrid" role="grid">
              <div class="cp-mrow cp-ghead" role="row"><span>Name</span><span>Type</span><span>Description</span><span>Vault</span><span>Item Revision</span><span>Revision State</span></div>
              {models.map((m, i) => (
                <div key={i} class={`cp-mrow${mSel === i ? ' on' : ''}`} role="row" onMouseDown={() => setMSel(i)} onDblClick={editModel}>
                  {m.raw === 'PCBLIB' && footprints.length > 1
                    ? <select value={footprints.find((q) => q.current)?.name ?? m.name} aria-label="Current footprint"
                        onChange={(e) => { const n = (e.target as HTMLSelectElement).value; setModels(models.map((q) => (q.raw === 'PCBLIB' ? { ...q, current: q.name === n } : q))); }}>
                        {footprints.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}</select>
                    : <span>{m.name}</span>}
                  <span>{m.type}</span><span>{m.description}</span><span /><span /><span>{m.raw === 'PCBLIB' ? '[Unknown]' : ''}</span>
                </div>
              ))}
            </div>
            <div class="cp-buttons">
              <span class="dropdown cp-split"><button class="btn" onClick={addModel}>Add...</button><button class="btn cp-split-arrow" aria-label="Add a model of another type" onClick={() => setAddMenu(!addMenu)}>▾</button>
                {addMenu && <span class="dropdown-menu cp-addmenu">
                  <button onClick={() => { setAddMenu(false); addModel(); }}>Footprint</button>
                  <button onClick={() => { setAddMenu(false); addSimModel(); }}>Simulation</button>
                  <button title="IBIS files are read in Signal Integrity's Model Assignments (kept in the project)" onClick={() => { setAddMenu(false); showDialog(SiModelsDialog, { onDone: () => {} }); }}>Ibis Model</button>
                  <button title="Signal Integrity models are assigned in Model Assignments (kept in the project)" onClick={() => { setAddMenu(false); showDialog(SiModelsDialog, { onDone: () => {} }); }}>Signal Integrity</button>
                </span>}</span>
              <button class="btn" disabled={mSel === null || !models[mSel]} onClick={() => { setModels(models.filter((_, k) => k !== mSel)); setMSel(null); }}>Remove...</button>
              <button class="btn" disabled={mSel === null || !models[mSel]} onClick={editModel}>Edit...</button>
            </div>
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}

/* ─── Component Pin Editor ──────────────────────────────────────────────────────────── */

interface PinRow { index: number; designator: string; name: string; description: string; type: number; owner: number; show: boolean; number: boolean; showName: boolean }

/** Edit Pins...: every pin of the part — designator, name, description, type, shown, number and name visibility. */
export function PinEditorDialog({ ed, comp }: { ed: SchEditor; comp: number }) {
  const doc = ed.doc;
  const pins = doc.objects.filter((o) => o.owner === comp && o.kind === 'pin');
  const [rows, setRows] = useState<PinRow[]>(() => pins.map((o) => {
    const b = bagOf(doc, o)!, pc = b.int('PINCONGLOMERATE');
    return { index: o.index, designator: b.get('DESIGNATOR') ?? '', name: b.get('NAME') ?? '', description: b.get('DESCRIPTION') ?? '', type: b.int('ELECTRICAL'),
      owner: b.int('OWNERPARTID'), show: (pc & 4) === 0, number: (pc & 0x10) !== 0, showName: (pc & 0x08) !== 0 };
  }));
  const upd = (i: number, p: Partial<PinRow>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const ok = () => {
    const ch: Change[] = [];
    for (const r of rows) {
      const b = doc.records[r.index + 1]!.bag!;
      let pc = b.int('PINCONGLOMERATE');
      pc = r.show ? pc & ~4 : pc | 4; pc = r.number ? pc | 0x10 : pc & ~0x10; pc = r.showName ? pc | 0x08 : pc & ~0x08;
      const q: Record<string, string | null> = {};
      if (r.designator !== (b.get('DESIGNATOR') ?? '')) q.DESIGNATOR = r.designator;
      if (r.name !== (b.get('NAME') ?? '')) q.NAME = r.name;
      if (r.description !== (b.get('DESCRIPTION') ?? '')) q.DESCRIPTION = r.description || null;
      if (r.type !== b.int('ELECTRICAL')) q.ELECTRICAL = r.type ? String(r.type) : null;
      if (pc !== b.int('PINCONGLOMERATE')) q.PINCONGLOMERATE = String(pc);
      if (Object.keys(q).length) ch.push(setProps(doc, r.index, q));
    }
    closeDialog();
    if (ch.length) { ed.undo.transact('Edit pins', (tx) => { for (const c of ch) tx.add(c); }); ed.invalidate(); }
  };
  const part = (n: number) => (n > 0 ? partLetter(n) : 'All');
  return (
    <Dialog title="Component Pin Editor" width={820} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pineditor"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="pe-grid" role="grid">
        <div class="pe-row cp-ghead" role="row"><span>Designator</span><span>Name</span><span>Desc</span><span>Type</span><span>Owner</span><span>Show</span><span>Number</span><span>Name</span></div>
        {rows.map((r, i) => (
          <div key={r.index} class="pe-row" role="row">
            <input type="text" value={r.designator} aria-label="Designator" onInput={(e) => upd(i, { designator: (e.target as HTMLInputElement).value })} />
            <input type="text" value={r.name} aria-label="Name" onInput={(e) => upd(i, { name: (e.target as HTMLInputElement).value })} />
            <input type="text" value={r.description} aria-label="Description" onInput={(e) => upd(i, { description: (e.target as HTMLInputElement).value })} />
            <select value={String(r.type)} aria-label="Type" onChange={(e) => upd(i, { type: Number((e.target as HTMLSelectElement).value) })}>{ELECTRICAL.map((t, k) => <option key={t} value={String(k)}>{t}</option>)}</select>
            <span>{part(r.owner)}</span>
            <input type="checkbox" checked={r.show} aria-label="Show" onChange={(e) => upd(i, { show: (e.target as HTMLInputElement).checked })} />
            <input type="checkbox" checked={r.number} aria-label="Show number" onChange={(e) => upd(i, { number: (e.target as HTMLInputElement).checked })} />
            <input type="checkbox" checked={r.showName} aria-label="Show name" onChange={(e) => upd(i, { showName: (e.target as HTMLInputElement).checked })} />
          </div>
        ))}
        {!rows.length && <p class="muted">This part has no pins.</p>}
      </div>
    </Dialog>
  );
}

/** Tab while placing a part: the part's records as a small sheet of their own, edited in the same dialog. */
export function editPlacingPart(base: SchEditor, items: { bag: PropertyBag; owner: number }[], apply: (items: { bag: PropertyBag; owner: number }[]) => void): void {
  const sheet = base.doc.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag?.clone() ?? PropertyBag.from({ RECORD: SR.SHEET });
  const rec = (b: PropertyBag) => ({ kind: 0 as const, data: b.toBytes(), bag: b });
  const bags = items.map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.setRaw('OWNERINDEX', String(it.owner + 1)); else b.delete('OWNERINDEX'); return b; });
  const doc: SchDocument = { kind: 'SchDoc', name: base.doc.name, cfb: null, asciiEol: null, records: [rec(PropertyBag.from({ HEADER: 'Template' })), rec(sheet), ...bags.map(rec)], objects: [], sheet: base.doc.sheet, diags: base.doc.diags };
  rederive(doc);
  const tmp = new SchEditor(doc);
  showDialog(SchComponentDialog, { ed: tmp, index: 1, docName: base.doc.name, template: true, onDone: () => {
    apply(doc.records.slice(2).map((r) => {
      const b = r.bag!.clone();
      const owner = b.has('OWNERINDEX') ? b.int('OWNERINDEX') - 1 : -1;
      b.delete('OWNERINDEX');
      return { bag: b, owner };
    }));
  } });
}
