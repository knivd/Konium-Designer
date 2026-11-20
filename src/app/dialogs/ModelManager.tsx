import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { PromptDialog } from './Confirm';
import { PcbModelDialog, type PcbModelValue } from './PcbModel';
import { notify } from '../state';
import type { SchLibEditor } from '../../editors/sch/SchLibEditor';
import type { LibSymbol } from '../../formats/altium/schlib';
import { addFootprintChange, currentModelChanges, editModelChange, removeModelChange, symbolModels, type SymbolModel } from '../../model/libModels';

/**
 * Tools › Model Manager (schematic library): every component down the left (tick several to
 * work on them together), the models of the one picked on the right. Add Footprint gives the
 * ticked components (or the picked one) a footprint; Remove, Edit and Set Current work on the
 * picked component's model. Each button is one undo step in the library.
 */
export function ModelManagerDialog({ ed }: { ed: SchLibEditor }) {
  const syms = ed.lib.symbols;
  const [mask, setMask] = useState('');
  const [focus, setFocus] = useState<LibSymbol | undefined>(ed.symbol);
  const [ticked, setTicked] = useState<Set<LibSymbol>>(new Set());
  const [msel, setMsel] = useState<number | null>(null);
  const [rev, setRev] = useState(0);
  const re = useMemo(() => { try { return new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i'); } catch { return /.*/; } }, [mask]);
  const rows = syms.filter((s) => !mask || re.test(s.libRef));
  // The picked component's models (read from its view, or a throwaway one: nothing changes until an edit)
  const models: SymbolModel[] = useMemo(() => (focus ? symbolModels(ed.peek(focus)) : []), [focus, rev]);
  const fpCache = useMemo(() => new Map<LibSymbol, string>(), [rev]);
  const footprintOf = (s: LibSymbol) => {
    let v = fpCache.get(s);
    if (v === undefined) { v = symbolModels(ed.peek(s)).filter((m) => m.footprint).map((m) => (m.current ? m.name : `(${m.name})`)).join(', '); fpCache.set(s, v); }
    return v;
  };
  const targets = () => (ticked.size ? [...ticked] : focus ? [focus] : []);
  const done = (n: number, what: string) => { setRev(rev + 1); if (!n) notify(`Nothing to ${what}`); };
  const m = msel !== null ? models[msel] : undefined;

  // Add Footprint and Edit open the PCB Model dialog (Browse, Pin Map, the footprint drawn), as in Altium
  const pinsOf = (sym: LibSymbol | undefined) => (sym ? ed.peek(sym).objects.filter((o) => o.kind === 'pin').map((o) => ({ designator: (o as { designator: string }).designator, name: (o as { name: string }).name })) : []);
  const addFootprint = () => showDialog(PcbModelDialog, {
    title: `PCB Model${targets().length > 1 ? ` for ${targets().length} components` : ''}`, value: { name: '', description: '', useComponentLibrary: false },
    componentLibrary: ed.lib.name, integrated: false, pins: pinsOf(focus),
    onOk: (v: PcbModelValue) => {
      const n = ed.editSymbols('Add footprint', targets().map((sym) => ({ sym, build: (vw) => [addFootprintChange(vw, v.name, v.description, v.library ?? '')] })));
      done(n, 'add: the components already have it');
    },
  });
  const edit = () => {
    if (!m || !focus) return;
    const apply = (name: string, description: string, library?: string) => { if (!name.trim()) return; done(ed.editSymbols('Edit model', [{ sym: focus, build: (v) => [editModelChange(v, m.index, name.trim(), description, library)] }]), 'change'); };
    if (m.footprint) { showDialog(PcbModelDialog, { value: { name: m.name, description: m.description, useComponentLibrary: false, library: m.library }, componentLibrary: ed.lib.name, integrated: false, pins: pinsOf(focus), onOk: (v: PcbModelValue) => apply(v.name, v.description, v.library ?? '') }); return; }
    showDialog(PromptDialog, { title: `Edit ${m.type} Model`, fields: [{ label: 'Name', value: m.name }, { label: 'Description', value: m.description }],
      onOk: ([name, description]: string[]) => apply(name ?? '', description ?? '') });
  };
  const remove = () => { if (m && focus) { done(ed.editSymbols('Remove model', [{ sym: focus, build: (v) => [removeModelChange(v, m.index)] }]), 'remove'); setMsel(null); } };
  const setCurrent = () => { if (m?.footprint && focus) done(ed.editSymbols('Set current footprint', [{ sym: focus, build: (v) => currentModelChanges(v, m.index) }]), 'change'); };

  return (
    <Dialog title="Model Manager" width={940} height={560} onClose={closeDialog} class="modelmgr"
      footer={<>
        <button class="btn" disabled={!targets().length} onClick={addFootprint}>Add Footprint{ticked.size > 1 ? ` (${ticked.size})` : ''}</button>
        <button class="btn" disabled={!m} onClick={remove}>Remove</button>
        <button class="btn" disabled={!m} onClick={edit}>Edit...</button>
        <button class="btn" disabled={!m?.footprint || m.current} onClick={setCurrent}>Set Current</button>
        <span class="spacer" /><span class="muted small">{syms.length} components{ticked.size ? `, ${ticked.size} ticked` : ''}</span>
        <button class="btn default" onClick={closeDialog}>Close</button>
      </>}>
      <div class="mm-split">
        <div class="mm-left">
          <label class="pcblib-mask">Mask <input type="search" value={mask} placeholder="e.g. RES*" onInput={(e) => setMask((e.target as HTMLInputElement).value)} /></label>
          <Grid
            cols={[
              { label: '', width: '24px', get: (s: LibSymbol) => <input type="checkbox" checked={ticked.has(s)} aria-label={`Tick ${s.libRef}`} onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => { const t = new Set(ticked); if ((e.target as HTMLInputElement).checked) t.add(s); else t.delete(s); setTicked(t); }} /> },
              { label: 'Component', width: 'minmax(120px, 1fr)', get: (s) => s.libRef },
              { label: 'Description', width: 'minmax(100px, 1fr)', get: (s) => s.description },
              { label: 'Footprint', width: 'minmax(90px, 0.8fr)', get: (s) => footprintOf(s) },
            ]}
            rows={rows} sel={focus ? rows.indexOf(focus) : null} onSel={(i) => { setFocus(rows[i]); setMsel(null); }} empty="No components match" />
          <div class="mm-tick">
            <button class="btn" onClick={() => setTicked(new Set(rows))}>Tick All Shown</button>
            <button class="btn" disabled={!ticked.size} onClick={() => setTicked(new Set())}>Clear Ticks</button>
          </div>
        </div>
        <div class="mm-right">
          <h3 class="pcblib-sub">Models of {focus?.libRef ?? '—'}</h3>
          <Grid
            cols={[{ label: 'Type', width: '90px', get: (x: SymbolModel) => x.type }, { label: 'Name', get: (x) => x.name },
              { label: 'Description', get: (x) => x.description }, { label: 'Current', width: '64px', align: 'center', get: (x) => (x.footprint ? (x.current ? '✓' : '') : '') }]}
            rows={models} sel={msel} onSel={setMsel} onOpen={() => edit()} empty="No models: Add Footprint gives it one" />
        </div>
      </div>
    </Dialog>
  );
}
