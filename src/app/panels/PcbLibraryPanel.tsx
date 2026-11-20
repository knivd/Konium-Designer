import { useState } from 'preact/hooks';
import { Grid } from '../Dialog';
import { Dialog } from '../Dialog';
import { active, tick, units } from '../state';
import { closeDialog, showDialog } from '../dialogs';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { formatCoord } from '../../core/units';
import { layerName } from '../../model/layers';
import type { PcbPrim } from '../../model/pcb';
import { footprintCounts, type FootprintEntry } from '../../model/pcbLib';

/**
 * PCB Library panel: the footprints of the active library (Mask filter, Name / Pads /
 * Primitives), Add / Delete / Edit, and the selected footprint's primitives. Clicking a
 * footprint shows it in the editor; double-clicking opens its properties.
 */
export function PcbLibraryPanel() {
  void tick.value;
  const [mask, setMask] = useState('');
  const [primSel, setPrimSel] = useState<number | null>(null);
  const ed = active.value?.editor;
  if (!(ed instanceof PcbLibEditor)) {
    return (
      <section class="panel" aria-label="PCB Library">
        <p class="panel-empty">Open a PCB library (.PcbLib) to see its footprints.</p>
      </section>
    );
  }
  const lib = ed.lib;
  void lib.version;
  const re = (() => { try { return new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i'); } catch { return /.*/; } })();
  const list = lib.footprints.map((f, i) => ({ f, i })).filter(({ f }) => !mask || re.test(f.name));
  const sel = list.findIndex((x) => x.i === ed.current);
  const u = units.value;
  const prims = ed.entry.doc.prims;
  const name = (p: PcbPrim) => (p.kind === 'pad' ? p.name : p.kind === 'text' ? p.text : '');
  const size = (p: PcbPrim): [string, string] => {
    switch (p.kind) {
      case 'pad': return [formatCoord(p.top.w, u), formatCoord(p.top.h, u)];
      case 'track': case 'arc': return [formatCoord(p.width, u), ''];
      case 'via': return [formatCoord(p.diameter, u), ''];
      case 'text': return [formatCoord(p.height, u), ''];
      case 'body': return [formatCoord(p.overall, u), ''];
      default: return ['', ''];
    }
  };
  return (
    <section class="panel pcblib" aria-label="PCB Library">
      <label class="pcblib-mask">Mask <input type="search" value={mask} placeholder="e.g. SOT*" onInput={(e) => setMask((e.target as HTMLInputElement).value)} /></label>
      <div class="pcblib-list" data-ctx="footprints">
        <Grid
          cols={[
            { label: 'Name', width: 'minmax(90px, 1fr)', get: (x: { f: FootprintEntry }) => x.f.name },
            { label: 'Pads', width: '42px', align: 'right', get: (x) => footprintCounts(x.f).pads },
            { label: 'Primitives', width: '66px', align: 'right', get: (x) => footprintCounts(x.f).prims },
          ]}
          rows={list} sel={sel < 0 ? null : sel}
          onSel={(k) => { const x = list[k]; if (x) { ed.showFootprint(x.i); setPrimSel(null); tick.value++; } }}
          onOpen={(k) => { const x = list[k]; if (x) showDialog(FootprintDialog, { ed, index: x.i }); }}
          empty="No footprints match." />
      </div>
      <div class="pcblib-buttons">
        <button class="btn" onClick={() => { ed.newFootprint(); tick.value++; }}>Add</button>
        <button class="btn" disabled={lib.footprints.length < 2} onClick={() => { ed.deleteFootprint(); tick.value++; }}>Delete</button>
        <button class="btn" onClick={() => showDialog(FootprintDialog, { ed, index: ed.current })}>Edit</button>
      </div>
      <h3 class="pcblib-sub">Footprint Primitives</h3>
      <div class="pcblib-prims">
        <Grid
          cols={[
            { label: 'Type', width: '56px', get: (p: PcbPrim) => (p.kind === 'body' ? '3D Body' : p.kind[0]!.toUpperCase() + p.kind.slice(1)) },
            { label: 'Name', width: 'minmax(40px, 1fr)', get: name },
            { label: 'X-Size', width: '64px', get: (p) => size(p)[0] },
            { label: 'Y-Size', width: '64px', get: (p) => size(p)[1] },
            { label: 'Layer', width: 'minmax(70px, 1fr)', get: (p) => ('layer' in p ? ed.layerLabel(p.layer) : layerName(74)) },
          ]}
          rows={prims} sel={primSel}
          onSel={(k) => { setPrimSel(k); const p = prims[k]; if (p) { ed.select([`${p.src.storage}:${p.src.index}`]); } }}
          onOpen={(k) => { const p = prims[k]; if (p) { ed.select([`${p.src.storage}:${p.src.index}`]); ed.fitSelection(500_000); } }}
          empty="Empty footprint: place pads (P, P) and lines (P, L)." />
      </div>
    </section>
  );
}

/** Library Component Parameters: Name, Height, Description. */
export function FootprintDialog({ ed, index }: { ed: PcbLibEditor; index: number }) {
  const e = ed.lib.footprints[index]!;
  const [v, setV] = useState({ name: e.name, height: e.height, description: e.description });
  const taken = ed.lib.footprints.some((f, i) => i !== index && f.name.toLowerCase() === v.name.trim().toLowerCase());
  const ok = () => { if (!v.name.trim() || taken) return false; ed.setFootprintProps(index, { ...v, name: v.name.trim() }); tick.value++; closeDialog(); return true; };
  return (
    <Dialog title="PCB Library Footprint" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok} disabled={!v.name.trim() || taken}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="fp-form">
        <label>Name<input type="text" value={v.name} autoFocus onInput={(x) => setV({ ...v, name: (x.target as HTMLInputElement).value })} /></label>
        {taken && <p class="warn small">Another footprint already has this name.</p>}
        {v.name.length > 31 && <p class="warn small">Names over 31 characters need section keys, which Konium Designer doesn't write yet.</p>}
        <label>Height<input type="text" value={v.height} onInput={(x) => setV({ ...v, height: (x.target as HTMLInputElement).value })} /></label>
        <label>Description<input type="text" value={v.description} onInput={(x) => setV({ ...v, description: (x.target as HTMLInputElement).value })} /></label>
      </div>
    </Dialog>
  );
}
