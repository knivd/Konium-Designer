import { openGeneratedInCam } from '../camCommands';
import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { activeProject } from '../project';
import { notify, replaceMessages, units, type Project } from '../state';
import { formatCoord, parseLengthIn } from '../../core/units';
import { showPanel } from '../dock/store';
import { apertureRow, defaultGerberSetup, gerberExtension, gerberFiles, type GerberSetup, type OutputFile } from '../../formats/gerber/gerber';
import { forOutput } from '../../model/duplicates';
import { gerberX2Files, x2Function } from '../../formats/gerber/gerberX2';
import { ROUT_TOOL, defaultDrillSetup, drillFiles, type DrillSetup } from '../../formats/gerber/drill';
import { PNP_COLUMNS, defaultPnpSetup, pnpFile, type PnpColumn, type PnpSetup } from '../../formats/gerber/pnp';
import { zip } from '../../formats/zip';
import { defaultTestPointSetup, testFeatures, testPointFiles, type TestPointSetup } from '../../formats/gerber/testpoints';
import { ensurePermission, saveFile, saveFileAs } from '../../platform/fs';
import { iniGet } from '../../formats/altium/prjpcb';
import { layerName } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';

/**
 * File › Fabrication Outputs › Gerber Files / NC Drill Files and File › Assembly Outputs ›
 * Generates pick and place files: Altium's setup dialogs; OK writes the files into the project's
 * Output Path (by default "Project Outputs for <project>") next to the project (or downloads them as one .zip when the
 * project wasn't opened from a folder). Setups are remembered per board for the session.
 */

export const gerberSetups = new WeakMap<PcbDocument, GerberSetup>();
export const gerberX2Setups = new WeakMap<PcbDocument, GerberSetup>();
export const drillSetups = new WeakMap<PcbDocument, DrillSetup>();
export const pnpSetups = new WeakMap<PcbDocument, PnpSetup>();

/**
 * Where a project's outputs go, as folders from the project's folder: Project Options › Output
 * Path when it is set, else "Project Outputs for <project>". The path is taken from the project's
 * folder; an absolute one is followed from the project folder's name when it names it
 * (C:\Work\Demo\Out with the project in Demo: Out), else the default is used, as it is for a path
 * that leaves the project's folder (..), which the browser can't reach.
 */
export function outputFolder(p: Project | null, board: string): string[] {
  const name = (p?.name ?? board).replace(/\.(prjpcb|libpkg|pcbdoc)$/i, '');
  const fallback = [`Project Outputs for ${name}`];
  const set = p ? (iniGet(p.prj, 'Design', 'OutputPath') ?? '').trim() : '';
  if (!set) return fallback;
  let segs = set.split(/[\\/]+/).filter((x) => x && x !== '.');
  if (/^([a-z]:|[\\/])/i.test(set)) {
    const own = (p?.path ?? '').split('/').slice(0, -1).at(-1) ?? p?.folder;
    const at = own ? segs.map((x) => x.toLowerCase()).lastIndexOf(own.toLowerCase()) : -1;
    segs = at >= 0 ? segs.slice(at + 1) : [];
  }
  return segs.length && !segs.includes('..') ? segs : fallback;
}

/** The zip a folderless project's outputs go into, asked for before generating them (see pickSaveHandle). */
export const outputsZipName = (p: Project | null, board: string, what: string) => `Project Outputs for ${(p?.name ?? board).replace(/\.(prjpcb|libpkg|pcbdoc)$/i, '')} - ${what}.zip`;

/** Write outputs where Altium would: <project folder>/<Output Path>/ (by default Project Outputs for <project>); a zip of that folder when the project has none. */
export async function deliverOutputs(p: Project | null, board: string, what: string, files: OutputFile[], zipTarget?: FileSystemFileHandle | null): Promise<boolean | void> {
  const path = outputFolder(p, board), folder = path.join('/');
  const enc = new TextEncoder();
  let where = '';
  try {
    if (p?.dir && (await ensurePermission(p.dir, 'readwrite'))) {
      let d = p.dir;
      for (const seg of (p.path ?? '').split('/').slice(0, -1).filter(Boolean)) d = await d.getDirectoryHandle(seg);
      let out = d;
      for (const seg of path) out = await out.getDirectoryHandle(seg, { create: true });
      for (const f of files) {
        const fh = await out.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write((f.bytes ?? enc.encode(f.text)) as Uint8Array<ArrayBuffer>);
        await w.close();
      }
      where = `${p.folder ?? p.dir.name}\\${path.join('\\')}`;
    } else {
      const bytes = zip(files.map((f) => ({ name: `${folder}/${f.name}`, bytes: f.bytes ?? enc.encode(f.text) })));
      const zipName = outputsZipName(p, board, what);
      if (zipTarget) await saveFile(zipName, bytes, zipTarget); else await saveFileAs(zipName, bytes);
      where = zipName;
    }
  } catch (e) {
    notify(`Couldn't write the ${what}: ${(e as Error).message}`, 'error');
    return false;
  }
  replaceMessages(`Output Generator: ${what}`, [
    ...files.map((f) => ({ doc: board, level: 'info' as const, message: `Generated ${f.name}` })),
    { doc: board, level: 'info' as const, message: `${what}: ${files.length} files in ${where}` },
  ]);
  notify(`${what}: ${files.length} files written to ${where}`);
}

const Radio = <T extends string>({ name, value, options, onChange }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) => (
  <div class="out-radios">{options.map(([v, l]) => <label key={v}><input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />{l}</label>)}</div>
);

const formats = (u: 'in' | 'mm', x2 = false): [string, string][] => (u === 'in' ? [['2:3', '2:3'], ['2:4', '2:4'], ['2:5', '2:5'], ...(x2 ? [['2:6', '2:6']] as [string, string][] : [])] : [['4:2', '4:2'], ['4:3', '4:3'], ['4:4', '4:4'], ...(x2 ? [['4:5', '4:5'], ['4:6', '4:6']] as [string, string][] : [])]);

/* ─── Gerber Setup ───────────────────────────────────────────────────────────────────── */

/** The setups open from the board's File menu (OK writes the files) or from an Output Job (OK keeps the setup there). */
interface SetupProps<T> { ed?: PcbEditor; doc?: PcbDocument; initial?: T; onSave?: (s: T) => void }

/** Gerber Setup, or (x2) Gerber X2 Setup: the same units, format and layers; X2 files carry attributes and name their function. */
export function GerberSetupDialog({ ed, doc: given, initial, onSave, x2 = false }: SetupProps<GerberSetup> & { x2?: boolean }) {
  const doc = given ?? ed!.doc;
  const store = x2 ? gerberX2Setups : gerberSetups;
  const [s, setS] = useState<GerberSetup>(() => structuredClone(initial ?? store.get(doc) ?? { ...defaultGerberSetup(doc), ...(x2 ? { units: 'mm' as const, intDigits: 4, decDigits: 6 } : {}) }));
  const [tab, setTab] = useState('General');
  const [menu, setMenu] = useState<'plot' | 'mirror' | null>(null);
  const set = (patch: Partial<GerberSetup>) => setS({ ...s, ...patch });
  const used = new Set(doc.prims.flatMap((p) => ('layer' in p && p.kind !== 'body' ? [p.layer] : [])));
  const ok = () => {
    if (onSave) { onSave(s); closeDialog(); return; }
    store.set(doc, s);
    const { files, notes } = x2 ? gerberX2Files(forOutput(doc), s) : gerberFiles(forOutput(doc), s);
    closeDialog();
    void deliverOutputs(activeProject(), doc.name, x2 ? 'Gerber X2 Files' : 'Gerber Files', files).then((ok) => {
      if (notes.length) { replaceMessages('Output Generator: notes', notes.map((n) => ({ doc: doc.name, level: 'warn' as const, message: n }))); showPanel('messages'); }
      // As AD does: the files open in the CAM editor
      if (ok !== false) openGeneratedInCam(files);
    });
  };
  const fmt = `${s.intDigits}:${s.decDigits}`;
  // RS-274-D: the aperture list the files would use, worked out when the tab shows it
  const key = tab === 'Apertures' && s.embedded === false ? JSON.stringify(s) : '';
  const apertures = useMemo(() => (key ? gerberFiles(forOutput(doc), s).apertures?.defs ?? [] : []), [key]);
  return (
    <Dialog title={x2 ? 'Gerber X2 Setup' : 'Gerber Setup'} width={760} height={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <nav class="out-tabs" role="tablist">
        {(x2 ? ['General', 'Layers', 'Advanced'] : ['General', 'Layers', 'Drill Drawing', 'Apertures', 'Advanced']).map((t) => <button key={t} role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      {tab === 'General' && (
        <div class="out-page">
          <p class="muted">Specify the units and format to be used in the output files. This controls the units (inches or millimetres) and the number of digits before and after the decimal point.</p>
          <fieldset><legend>Units</legend>
            <Radio name="gu" value={s.units} options={[['in', 'Inches'], ['mm', 'Millimetres']]} onChange={(u) => set({ units: u, intDigits: u === 'in' ? 2 : 4, decDigits: u === 'in' ? 5 : 4 })} />
          </fieldset>
          <fieldset><legend>Format</legend>
            <Radio name="gf" value={fmt} options={formats(s.units, x2)} onChange={(f) => { const [a, b] = f.split(':').map(Number); set({ intDigits: a!, decDigits: b! }); }} />
            <p class="muted small">{s.units === 'in' ? '2:5 has a resolution of 0.01 mil.' : '4:4 has a resolution of 0.1 µm.'} Check your fabricator supports the format chosen.</p>
          </fieldset>
        </div>
      )}
      {tab === 'Layers' && (
        <div class="out-page out-layers">
          <Grid
            cols={[
              x2 ? { label: 'File Function', width: '170px', get: (l: GerberSetup['layers'][number]) => x2Function(doc, l.layer)?.fn ?? '—' }
                : { label: 'Extension', width: '80px', get: (l: GerberSetup['layers'][number]) => `.${gerberExtension(l.layer)}` },
              { label: 'Layer Name', width: 'minmax(160px, 1fr)', get: (l) => <span class={used.has(l.layer) ? '' : 'muted'}>{doc.board.layerNames.get(l.layer) ?? layerName(l.layer)}</span> },
              { label: 'Plot', width: '50px', align: 'center', get: (l) => <input type="checkbox" checked={l.plot} onChange={() => set({ layers: s.layers.map((x) => (x === l ? { ...x, plot: !x.plot } : x)) })} /> },
              { label: 'Mirror', width: '56px', align: 'center', get: (l) => <input type="checkbox" checked={l.mirror} onChange={() => set({ layers: s.layers.map((x) => (x === l ? { ...x, mirror: !x.mirror } : x)) })} /> },
            ]}
            rows={s.layers} />
          <div class="out-layer-buttons">
            <div class="dropdown">
              <button class="btn" onClick={() => setMenu(menu === 'plot' ? null : 'plot')}>Plot Layers ▾</button>
              {menu === 'plot' && <div class="dropdown-menu">
                <button onClick={() => { set({ layers: s.layers.map((l) => ({ ...l, plot: true })) }); setMenu(null); }}>All On</button>
                <button onClick={() => { set({ layers: s.layers.map((l) => ({ ...l, plot: false })) }); setMenu(null); }}>All Off</button>
                <button onClick={() => { set({ layers: s.layers.map((l) => ({ ...l, plot: used.has(l.layer) || l.layer <= 32 })) }); setMenu(null); }}>Used On</button>
              </div>}
            </div>
            <div class="dropdown">
              <button class="btn" onClick={() => setMenu(menu === 'mirror' ? null : 'mirror')}>Mirror Layers ▾</button>
              {menu === 'mirror' && <div class="dropdown-menu">
                <button onClick={() => { set({ layers: s.layers.map((l) => ({ ...l, mirror: true })) }); setMenu(null); }}>All On</button>
                <button onClick={() => { set({ layers: s.layers.map((l) => ({ ...l, mirror: false })) }); setMenu(null); }}>All Off</button>
              </div>}
            </div>
            {x2 ? <span class="muted small">The board shape goes in its own Profile file; plated and non-plated holes in Gerber drill files.</span>
              : <label class="out-check"><input type="checkbox" checked={s.outlineOnMech1} onChange={() => set({ outlineOnMech1: !s.outlineOnMech1 })} />Add the board shape to Mechanical 1 (.GM1)</label>}
            <label class="out-check" title="Off: a through pad or via is plotted on an inner signal layer only where its net's copper meets it"><input type="checkbox" checked={!!s.unconnectedMidPads} onChange={() => set({ unconnectedMidPads: !s.unconnectedMidPads })} />Include unconnected mid-layer pads</label>
          </div>
        </div>
      )}
      {tab === 'Drill Drawing' && (
        <div class="out-page">
          <div class="out-cols">
            <fieldset><legend>Drill Drawing Plots</legend>
              <label class="out-check"><input type="checkbox" checked={s.drillDrawing} onChange={() => set({ drillDrawing: !s.drillDrawing })} />Plot all used drill pairs</label>
              <label class="out-check"><input type="checkbox" checked={s.mirrorDrillDrawing} disabled={!s.drillDrawing} onChange={() => set({ mirrorDrillDrawing: !s.mirrorDrillDrawing })} />Mirror plots</label>
              <div class="muted small">{`${doc.board.layerNames.get(doc.board.copperStack[0]!) ?? layerName(doc.board.copperStack[0]!)} - ${doc.board.layerNames.get(doc.board.copperStack.at(-1)!) ?? layerName(doc.board.copperStack.at(-1)!)}`} (.GD1)</div>
            </fieldset>
            <fieldset><legend>Drill Guide Plots</legend>
              <label class="out-check"><input type="checkbox" checked={s.drillGuide} onChange={() => set({ drillGuide: !s.drillGuide })} />Plot all used drill pairs</label>
              <label class="out-check"><input type="checkbox" checked={s.mirrorDrillGuide} disabled={!s.drillGuide} onChange={() => set({ mirrorDrillGuide: !s.mirrorDrillGuide })} />Mirror plots</label>
              <div class="muted small">{`${doc.board.layerNames.get(doc.board.copperStack[0]!) ?? layerName(doc.board.copperStack[0]!)} - ${doc.board.layerNames.get(doc.board.copperStack.at(-1)!) ?? layerName(doc.board.copperStack.at(-1)!)}`} (.GG1)</div>
            </fieldset>
          </div>
          <fieldset><legend>Drill Drawing Symbols</legend>
            <Radio name="ds" value={s.drill.kind} options={[['graphic', 'Graphic symbols'], ['characters', 'Characters'], ['size', 'Size of hole string']]} onChange={(k) => set({ drill: { ...s.drill, kind: k } })} />
            <label class="do-row"><span>Symbol size</span><input type="text" value={formatCoord(s.drill.size, units.value)}
              onChange={(e) => { const v = parseLengthIn((e.target as HTMLInputElement).value, units.value); if (v && v > 0) set({ drill: { ...s.drill, size: Math.round(v) } }); else notify('Symbol size: give a length', 'error'); }} /></label>
            <p class="muted small">The drill table is drawn where a .Legend string stands on the Drill Drawing layer.</p>
          </fieldset>
        </div>
      )}
      {tab === 'Apertures' && (
        <div class="out-page">
          <label class="out-check"><input type="checkbox" checked={s.embedded !== false} onChange={() => set({ embedded: s.embedded === false })} />Embedded apertures (RS274X)</label>
          {s.embedded !== false
            ? <p class="muted">Apertures are defined inside each Gerber file, so no separate aperture file is needed. Rotated and rounded pads are plotted as regions.</p>
            : <>
              <p class="muted">RS-274-D: the Gerber files carry no format or aperture definitions; the D-codes below, shared by every file, are written to {doc.name.replace(/\.pcbdoc$/i, '')}.APR.</p>
              <div class="out-apertures" role="table" aria-label="Aperture list">
                <div class="ap-row ap-head" role="row"><span>D-Code</span><span>Shape</span><span>X Size</span><span>Y Size</span><span>Sides</span><span>Rotation</span></div>
                {apertures.map(({ d, def }) => { const r = apertureRow(def); return <div key={d} class="ap-row" role="row"><span>D{d}</span><span>{r.shape}</span><span>{r.x}</span><span>{r.y}</span><span>{r.sides}</span><span>{r.rotation}</span></div>; })}
              </div>
              <p class="muted small">Sizes in {s.units === 'in' ? 'inches' : 'millimetres'}, from the layers ticked on the Layers tab.</p>
            </>}
        </div>
      )}
      {tab === 'Advanced' && (
        <div class="out-page">
          <fieldset><legend>Leading/Trailing Zeroes</legend>
            <Radio name="gz" value={s.zeros} options={[['none', 'Keep leading and trailing zeroes'], ['leading', 'Suppress leading zeroes'], ['trailing', 'Suppress trailing zeroes']]} onChange={(z) => set({ zeros: z })} />
          </fieldset>
          <fieldset><legend>Position on Film</legend>
            <Radio name="gp" value={s.relative ? 'rel' : 'abs'} options={[['abs', 'Reference to absolute origin'], ['rel', 'Reference to relative origin']]} onChange={(v) => set({ relative: v === 'rel' })} />
          </fieldset>
        </div>
      )}
    </Dialog>
  );
}

/* ─── NC Drill Setup ─────────────────────────────────────────────────────────────────── */

export function DrillSetupDialog({ ed, doc: given, initial, onSave }: SetupProps<DrillSetup>) {
  const doc = given ?? ed!.doc;
  const [s, setS] = useState<DrillSetup>(() => ({ ...(initial ?? drillSetups.get(doc) ?? defaultDrillSetup()) }));
  const set = (patch: Partial<DrillSetup>) => setS({ ...s, ...patch });
  const ok = () => {
    closeDialog();
    if (onSave) { onSave(s); return; }
    drillSetups.set(doc, s);
    const files = drillFiles(forOutput(doc), s);
    void deliverOutputs(activeProject(), doc.name, 'NC Drill Files', files).then((done) => { if (done !== false) openGeneratedInCam(files); });
  };
  return (
    <Dialog title="NC Drill Setup" width={620} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="out-page">
        <p class="muted">Specify the units and format to be used in the NC Drill output files.</p>
        <div class="out-cols">
          <fieldset><legend>Units</legend>
            <Radio name="du" value={s.units} options={[['in', 'Inches'], ['mm', 'Millimetres']]} onChange={(u) => set({ units: u, intDigits: u === 'in' ? 2 : 4, decDigits: u === 'in' ? 5 : 4 })} />
          </fieldset>
          <fieldset><legend>Format</legend>
            <Radio name="df" value={`${s.intDigits}:${s.decDigits}`} options={formats(s.units)} onChange={(f) => { const [a, b] = f.split(':').map(Number); set({ intDigits: a!, decDigits: b! }); }} />
          </fieldset>
        </div>
        <fieldset><legend>Leading/Trailing Zeroes</legend>
          <Radio name="dz" value={s.zeros} options={[['none', 'Keep leading and trailing zeroes'], ['leading', 'Suppress leading zeroes'], ['trailing', 'Suppress trailing zeroes']]} onChange={(z) => set({ zeros: z })} />
        </fieldset>
        <fieldset><legend>Coordinate Positions</legend>
          <Radio name="dp" value={s.relative ? 'rel' : 'abs'} options={[['abs', 'Reference to absolute origin'], ['rel', 'Reference to relative origin']]} onChange={(v) => set({ relative: v === 'rel' })} />
        </fieldset>
        <fieldset><legend>Other</legend>
          <label class="out-check"><input type="checkbox" checked={s.optimise !== false} onChange={() => set({ optimise: s.optimise === false })} />Optimise change location commands</label>
          <label class="out-check"><input type="checkbox" checked={s.separatePlated} onChange={() => set({ separatePlated: !s.separatePlated })} />Generate separate NC Drill files for plated &amp; non-plated holes</label>
          <label class="out-check" title="Off: a slot is routed from one end to the other"><input type="checkbox" checked={!!s.g85} onChange={() => set({ g85: !s.g85 })} />Use drilled slot command (G85)</label>
          <label class="out-check"><input type="checkbox" checked={!!s.edgeRout} onChange={() => set({ edgeRout: !s.edgeRout })} />Generate Board Edge Rout Paths</label>
          <label class={`do-row${s.edgeRout ? '' : ' muted'}`}><span>Rout Tool Dia</span><input type="text" aria-label="Rout Tool Dia" disabled={!s.edgeRout} value={formatCoord(s.routTool ?? ROUT_TOOL, units.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => { const v = parseLengthIn((e.target as HTMLInputElement).value, units.value); if (v && v > 0) set({ routTool: Math.round(v) }); else notify('Rout Tool Dia: give a length', 'error'); }} /></label>
        </fieldset>
      </div>
    </Dialog>
  );
}

/* ─── Pick and Place Setup ───────────────────────────────────────────────────────────── */

export function PickPlaceSetupDialog({ ed, doc: given, initial, onSave }: SetupProps<PnpSetup>) {
  const doc = given ?? ed!.doc;
  const [s, setS] = useState<PnpSetup>(() => structuredClone(initial ?? pnpSetups.get(doc) ?? defaultPnpSetup()));
  const set = (patch: Partial<PnpSetup>) => setS({ ...s, ...patch });
  const ok = () => {
    if (onSave) { closeDialog(); onSave(s); return; }
    pnpSetups.set(doc, s); closeDialog();
    const p = activeProject();
    void deliverOutputs(p, doc.name, 'Pick and Place', [pnpFile(forOutput(doc), s, p ? `${p.folder ?? ''}\\${p.name}` : '')]);
  };
  const toggle = (c: PnpColumn) => set({ columns: s.columns.includes(c) ? s.columns.filter((x) => x !== c) : PNP_COLUMNS.filter((x) => x === c || s.columns.includes(x)) });
  return (
    <Dialog title="Pick and Place Setup" width={560} height={480} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="out-cols out-pnp">
        <fieldset class="out-columns"><legend>Columns</legend>
          <Grid
            cols={[
              { label: 'Name', width: 'minmax(120px, 1fr)', get: (c: PnpColumn) => c },
              { label: 'Show', width: '50px', align: 'center', get: (c) => <input type="checkbox" checked={s.columns.includes(c)} onChange={() => toggle(c)} /> },
            ]}
            rows={[...PNP_COLUMNS]} />
        </fieldset>
        <div>
          <fieldset><legend>Formats</legend>
            <label class="out-check"><input type="radio" name="pf" checked={s.format === 'csv'} onChange={() => set({ format: 'csv' })} />CSV</label>
            <label class="out-check"><input type="radio" name="pf" checked={s.format === 'txt'} onChange={() => set({ format: 'txt' })} />Text</label>
          </fieldset>
          <fieldset><legend>Units</legend>
            <label class="out-check"><input type="radio" name="pu" checked={s.units === 'mil'} onChange={() => set({ units: 'mil' })} />Imperial</label>
            <label class="out-check"><input type="radio" name="pu" checked={s.units === 'mm'} onChange={() => set({ units: 'mm' })} />Metric</label>
          </fieldset>
        </div>
      </div>
    </Dialog>
  );
}

/* ─── Test Point Report ──────────────────────────────────────────────────────────────── */

const testPointSetups = new WeakMap<PcbDocument, TestPointSetup>();

/** File › Fabrication Outputs › Test Point Report: the formats, units and origin, then the files. */
export function TestPointSetupDialog({ ed, doc: given, initial, onSave }: SetupProps<TestPointSetup>) {
  const doc = given ?? ed!.doc;
  const [s, setS] = useState<TestPointSetup>(() => ({ ...(initial ?? testPointSetups.get(doc) ?? defaultTestPointSetup()) }));
  const set = (patch: Partial<TestPointSetup>) => setS({ ...s, ...patch });
  const marked = testFeatures(doc).filter((f) => f.testTop || f.testBottom).length;
  const ok = () => {
    if (!s.ipc && !s.text && !s.csv) { notify('Choose at least one report format', 'error'); return; }
    closeDialog();
    if (onSave) { onSave(s); return; }
    testPointSetups.set(doc, s);
    void deliverOutputs(activeProject(), doc.name, 'Test Point Report', testPointFiles(forOutput(doc), s));
  };
  return (
    <Dialog title="Fabrication Testpoint Setup" width={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="out-page">
        <div class="out-cols">
          <fieldset><legend>Report Formats</legend>
            <label class="out-check"><input type="checkbox" checked={s.ipc} onChange={() => set({ ipc: !s.ipc })} />IPC-D-356A</label>
            <label class="out-check"><input type="checkbox" checked={s.text} onChange={() => set({ text: !s.text })} />Text</label>
            <label class="out-check"><input type="checkbox" checked={s.csv} onChange={() => set({ csv: !s.csv })} />CSV</label>
          </fieldset>
          <fieldset><legend>Units</legend>
            <Radio name="tu" value={s.units} options={[['in', 'Imperial'], ['mm', 'Metric']]} onChange={(u) => set({ units: u })} />
          </fieldset>
        </div>
        <fieldset><legend>Coordinate Positions</legend>
          <Radio name="tp" value={s.relative ? 'rel' : 'abs'} options={[['abs', 'Reference to absolute origin'], ['rel', 'Reference to relative origin']]} onChange={(v) => set({ relative: v === 'rel' })} />
        </fieldset>
        <p class="muted small">{marked ? `${marked} pad${marked === 1 ? '' : 's'} and via${marked === 1 ? '' : 's'} marked as fabrication test points.` : 'No pads or vias are marked as fabrication test points; the IPC-D-356A netlist still lists every pad and via.'}</p>
      </div>
    </Dialog>
  );
}
