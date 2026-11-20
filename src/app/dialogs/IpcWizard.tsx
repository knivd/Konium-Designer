import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { FootprintPreview } from './FootprintPreview';
import type { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { IPC_FAMILIES, ipcDefaults, ipcFootprint, ipcRecords, type Density, type IpcFamily, type IpcSpec, type Range } from '../../model/ipcFootprint';
import { readIpcBatch } from '../../model/ipcBatch';
import { decodePrim } from '../../formats/altium/pcbdoc';
import { storageFor } from '../../formats/altium/pcblib';
import { pickFileHandle } from '../../platform/fs';
import type { PcbPrim } from '../../model/pcb';

/**
 * Tools › IPC Compliant Footprint Wizard: the package family, its datasheet dimensions (min and
 * max, millimetres), the density level; the land pattern IPC-7351B gives (pad size, spacing,
 * courtyard) shown and drawn as it goes; Finish adds it to the library under IPC-7351's name.
 * AD17's pages side by side [est: their layout].
 */
const RANGES: [keyof IpcSpec, string, IpcFamily[] | 'all'][] = [
  ['bodyD', 'Body length (D)', 'all'], ['bodyE', 'Body width (E)', 'all'],
  ['span', 'Lead span (L)', ['CHIP', 'MOLDED', 'MELF', 'SOD', 'SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC', 'SON', 'QFN']],
  ['span2', 'Lead span, other sides (L2)', ['QFP', 'PLCC', 'QFN']],
  ['term', 'Terminal / foot length (T)', ['CHIP', 'MOLDED', 'MELF', 'SOD', 'SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC', 'SON', 'QFN']],
  ['leadW', 'Terminal / lead width (W)', ['CHIP', 'MOLDED', 'MELF', 'SOD', 'SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC', 'SON', 'QFN']],
];
const NUMS: [keyof IpcSpec, string, IpcFamily[] | 'all', number][] = [
  ['height', 'Height (A)', 'all', 0.01], ['pitch', 'Pitch (e)', ['SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC', 'SON', 'QFN', 'BGA'], 0.01],
  ['pins', 'Pins', ['SOT23', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC', 'SON', 'QFN'], 1], ['pinsSide', 'Pins on each left / right side', ['QFP', 'PLCC', 'QFN'], 1],
  ['tabW', 'Thermal pad / tab width', ['SOT223', 'DPAK', 'SON', 'QFN'], 0.01], ['tabL', 'Thermal pad / tab length', ['DPAK', 'SON', 'QFN'], 0.01],
  ['ball', 'Ball diameter', ['BGA'], 0.01], ['rows', 'Rows', ['BGA'], 1], ['cols', 'Columns', ['BGA'], 1],
];
const PREFIX: Partial<Record<IpcFamily, [string, string][]>> = {
  CHIP: [['RESC', 'Resistor'], ['CAPC', 'Capacitor'], ['INDC', 'Inductor']],
  MOLDED: [['CAPMP', 'Capacitor (polarised)'], ['DIOM', 'Diode']],
  MELF: [['DIOMELF', 'Diode'], ['RESMELF', 'Resistor']],
};
const applies = (f: IpcFamily, which: IpcFamily[] | 'all') => which === 'all' || which.includes(f);

export function IpcWizardDialog({ ed }: { ed: PcbLibEditor }) {
  const [s, setS] = useState<IpcSpec>(() => ipcDefaults('SOIC'));
  const [name, setName] = useState<string | null>(null);
  const set = (patch: Partial<IpcSpec>) => { setS({ ...s, ...patch }); };
  const fp = useMemo(() => ipcFootprint(s), [s]);
  const template = ed.doc.streams.get('Pads6')?.records[0];
  const records = useMemo(() => ipcRecords(fp, s, template), [fp, s, template]);
  const prims = useMemo(() => records.map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).filter((p): p is PcbPrim => !!p), [records]);
  const finalName = (name ?? fp.name).trim();
  const finish = () => { if (!finalName) return; closeDialog(); ed.insertFootprint(finalName, fp.description, `${(s.height / 0.0254).toFixed(2)}mil`, records); };
  const num = (k: keyof IpcSpec, label: string, step: number) => (
    <label key={k} class="do-row"><span>{label}</span><input type="number" step={step} min={0} aria-label={label} value={s[k] as number}
      onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v) && v >= 0) set({ [k]: step === 1 ? Math.round(v) : v } as Partial<IpcSpec>); }} /></label>
  );
  const range = (k: keyof IpcSpec, label: string) => {
    const v = s[k] as Range;
    const one = (which: 'min' | 'max') => <input type="number" step={0.01} min={0} aria-label={`${label} ${which}`} value={v[which]}
      onInput={(e) => { const x = Number((e.target as HTMLInputElement).value); if (Number.isFinite(x) && x >= 0) set({ [k]: { ...v, [which]: x } } as Partial<IpcSpec>); }} />;
    return <label key={k} class="do-row ipc-range"><span>{label}</span>{one('min')}<span class="muted">–</span>{one('max')}</label>;
  };
  const l = fp.land;
  return (
    <Dialog title="IPC Compliant Footprint Wizard" width={900} height={600} onClose={closeDialog} onAccept={() => { finish(); return false; }} class="compwizard ipcwizard"
      footer={<><span class="muted small">{fp.pads.length} pads · courtyard {fp.courtyard.w.toFixed(2)} × {fp.courtyard.h.toFixed(2)} mm</span><span class="spacer" />
        <button class="btn default" disabled={!finalName} onClick={finish}>Finish</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="cw-split">
        <div class="cw-form">
          <fieldset><legend>Component Type</legend>
            <select size={6} value={s.family} aria-label="Component Type" onChange={(e) => { setS(ipcDefaults((e.target as HTMLSelectElement).value as IpcFamily)); setName(null); }}>
              {IPC_FAMILIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            {PREFIX[s.family] && <label class="do-row"><span>Kind</span><select aria-label="Kind" value={s.prefix} onChange={(e) => set({ prefix: (e.target as HTMLSelectElement).value })}>
              {PREFIX[s.family]!.map(([v, t]) => <option key={v} value={v}>{t} ({v})</option>)}</select></label>}
          </fieldset>
          <fieldset><legend>Package Dimensions (mm, min – max)</legend>
            {RANGES.filter(([, , w]) => applies(s.family, w)).map(([k, label]) => range(k, label))}
            {NUMS.filter(([, , w]) => applies(s.family, w)).map(([k, label, , step]) => num(k, label, step))}
          </fieldset>
          <fieldset><legend>Footprint Dimensions</legend>
            <div class="out-radios">{([['M', 'Most'], ['N', 'Nominal'], ['L', 'Least']] as [Density, string][]).map(([v, t]) =>
              <label key={v}><input type="radio" name="ipc-density" checked={s.density === v} onChange={() => set({ density: v })} />{t}</label>)}</div>
            {l ? <p class="muted small">Z {l.Z.toFixed(2)} · G {l.G.toFixed(2)} · X {l.X.toFixed(2)} mm — pads {l.padL.toFixed(2)} × {l.padW.toFixed(2)}, {l.C.toFixed(2)} apart</p>
              : <p class="muted small">Lands {fp.pads[0]?.w.toFixed(2)} mm round</p>}
          </fieldset>
          <fieldset><legend>Footprint Description</legend>
            <label class="do-row"><span>Name</span><input type="text" aria-label="Footprint Name" value={name ?? fp.name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <p class="muted small">{fp.description}</p>
          </fieldset>
        </div>
        <div class="cw-preview"><FootprintPreview prims={prims} size={380} /></div>
      </div>
    </Dialog>
  );
}

/**
 * Tools › IPC Compliant Footprints Batch Generator: a CSV (or text) table of packages, one per
 * row (Family, Name, Density, then the dimensions by heading), turned into footprints in this
 * library in one step [est: AD's batch reads its own Excel templates].
 */
export function IpcBatchDialog({ ed }: { ed: PcbLibEditor }) {
  const [rows, setRows] = useState<{ spec: IpcSpec; name: string; error?: string }[]>([]);
  const [file, setFile] = useState('');
  const load = async () => {
    const f = await pickFileHandle(['.csv', '.txt'], 'Package tables', 'konium-ipc-batch');
    if (!f) return;
    setFile(f.name);
    setRows(readIpcBatch(new TextDecoder().decode(f.bytes)));
  };
  const ok = rows.filter((r) => !r.error);
  const run = () => {
    if (!ok.length) return;
    closeDialog();
    const template = ed.doc.streams.get('Pads6')?.records[0];
    for (const r of ok) { const fp = ipcFootprint(r.spec); ed.insertFootprint(r.name || fp.name, fp.description, `${(r.spec.height / 0.0254).toFixed(2)}mil`, ipcRecords(fp, r.spec, template)); }
    notify(`${ok.length} footprint${ok.length === 1 ? '' : 's'} added`);
  };
  return (
    <Dialog title="IPC Compliant Footprints Batch Generator" width={680} height={480} onClose={closeDialog} onAccept={() => { run(); return false; }}
      footer={<><button class="btn" onClick={() => void load()}>Load Table...</button><span class="spacer" /><button class="btn default" disabled={!ok.length} onClick={run}>Generate</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">Columns: Family (CHIP, SOIC, QFP …), Name (blank: IPC-7351's), Density (M, N, L), then any of BodyDMin, BodyDMax, BodyEMin, BodyEMax, SpanMin, SpanMax, Span2Min, Span2Max, TermMin, TermMax, LeadWMin, LeadWMax, Height, Pitch, Pins, PinsSide, TabW, TabL, Ball, Rows, Cols, Prefix (millimetres; what's missing takes the family's defaults).</p>
      {file && <p><b>{file}</b>: {ok.length} of {rows.length} rows usable</p>}
      <div class="grid" style={{ '--cols': '1fr 90px 1fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Name</span><span>Family</span><span>Note</span></div>
        <div class="grid-body" style={{ maxHeight: '260px' }}>
          {rows.map((r, i) => <div key={i} class="grid-row"><span>{r.name || (r.error ? '' : ipcFootprint(r.spec).name)}</span><span>{r.spec.family}</span><span class={r.error ? 'error' : 'muted'}>{r.error ?? 'OK'}</span></div>)}
        </div>
      </div>
    </Dialog>
  );
}
