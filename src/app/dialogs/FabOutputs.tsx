/**
 * File › Fabrication Outputs › IPC-2581 Files and ODB++ Files, File › Export › STEP 3D, and the
 * PCB 3D Print: their setup dialogs [est: AD17's options trimmed to what Konium writes]; OK
 * writes the files into "Project Outputs for <project>" (or downloads them).
 */
import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { activeProject } from '../project';
import { notify } from '../state';
import { deliverOutputs } from './Outputs';
import { forOutput } from '../../model/duplicates';
import { plottableLayers } from '../../formats/gerber/gerber';
import { ipc2581 } from '../../formats/ipc2581';
import { odbArchive } from '../../formats/odb';
import { exportStep, leftOutWords } from '../../formats/step/write';
import { parseStep } from '../../formats/step/parse';
import { tessellateStep } from '../../formats/step/tessellate';
import { writeStl } from '../../formats/stl';
import type { ModelFiles } from '../../render/gl3d/stepBodies';
import { layerName, type LayerId } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { saveFileAs } from '../../platform/fs';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';

interface LayerRow { layer: LayerId; on: boolean }
const usedLayers = (doc: PcbDocument) => new Set(doc.prims.flatMap((p) => ('layer' in p && p.kind !== 'body' ? [p.layer] : [])));
const initialRows = (doc: PcbDocument): LayerRow[] => { const used = usedLayers(doc); return plottableLayers(doc).map((layer) => ({ layer, on: layer <= 32 || (layer >= 39 && layer <= 54) || used.has(layer) })); };

function LayerList({ doc, rows, set }: { doc: PcbDocument; rows: LayerRow[]; set: (r: LayerRow[]) => void }) {
  const used = usedLayers(doc);
  return (
    <fieldset class="out-layers"><legend>Layers</legend>
      <Grid
        cols={[
          { label: 'Layer Name', width: 'minmax(160px, 1fr)', get: (r: LayerRow) => <span class={used.has(r.layer) ? '' : 'muted'}>{doc.board.layerNames.get(r.layer) ?? layerName(r.layer)}</span> },
          { label: 'Export', width: '60px', align: 'center', get: (r) => <input type="checkbox" aria-label={`Export ${layerName(r.layer)}`} checked={r.on} onChange={() => set(rows.map((x) => (x === r ? { ...x, on: !x.on } : x)))} /> },
        ]}
        rows={rows} />
      <div class="out-layer-buttons">
        <button class="btn" onClick={() => set(rows.map((r) => ({ ...r, on: true })))}>All On</button>
        <button class="btn" onClick={() => set(rows.map((r) => ({ ...r, on: false })))}>All Off</button>
        <button class="btn" onClick={() => set(rows.map((r) => ({ ...r, on: r.layer <= 32 || used.has(r.layer) })))}>Used On</button>
      </div>
    </fieldset>
  );
}

const footer = (ok: () => void) => <><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

export function Ipc2581Dialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const [rows, setRows] = useState(() => initialRows(doc));
  const [mode, setMode] = useState<'FULL' | 'FABRICATION' | 'ASSEMBLY'>('FULL');
  const ok = () => {
    closeDialog();
    const text = ipc2581(forOutput(doc), { mode, layers: rows.filter((r) => r.on).map((r) => r.layer) });
    void deliverOutputs(activeProject(), doc.name, 'IPC-2581 Files', [{ name: `${doc.name.replace(/\.pcbdoc$/i, '')}.xml`, text }]);
  };
  return (
    <Dialog title="IPC-2581 Configuration" width={560} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs" footer={footer(ok)}>
      <div class="out-page">
        <fieldset><legend>Contents</legend>
          {([['FULL', 'Full (fabrication, assembly and BOM)'], ['FABRICATION', 'Fabrication'], ['ASSEMBLY', 'Assembly']] as const).map(([v, l]) =>
            <label key={v} class="out-check"><input type="radio" name="ipc-mode" checked={mode === v} onChange={() => setMode(v)} />{l}</label>)}
          <p class="muted small">Revision B, millimetres from the board's relative origin; nets, packages, components and the stackup included.</p>
        </fieldset>
        <LayerList doc={doc} rows={rows} set={setRows} />
      </div>
    </Dialog>
  );
}

export function OdbSetupDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const [rows, setRows] = useState(() => initialRows(doc));
  const ok = () => {
    closeDialog();
    void odbArchive(forOutput(doc), { layers: rows.filter((r) => r.on).map((r) => r.layer) }).then((a) =>
      deliverOutputs(activeProject(), doc.name, 'ODB++ Files', [{ name: a.name, text: '', bytes: a.bytes }]));
  };
  return (
    <Dialog title="ODB++ Setup" width={520} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="outputs" footer={footer(ok)}>
      <div class="out-page">
        <p class="muted">An ODB++ (version 7) job packed as a .tgz: the layers chosen, the drill layer, the profile, components and nets.</p>
        <LayerList doc={doc} rows={rows} set={setRows} />
      </div>
    </Dialog>
  );
}

/** The board's models: those embedded, and those it links to that Konium finds (by name, in the project's folder and the model folders). */
export async function boardModels(ed: PcbEditor): Promise<ModelFiles> {
  const all: ModelFiles = new Map(ed.modelFiles());
  for (const [id, path] of ed.linkedModelNames()) {
    if (all.has(id) || !path) continue;
    const data = await ed.findModel(path).catch(() => null);
    if (data) all.set(id, { name: path.split(/[\\/]/).pop() ?? path, data, checksum: '' });
  }
  return all;
}

/**
 * File › Export › STEP 3D, and Konium's STL 3D: the board (drilled, its cut-outs), the bodies and
 * their models (embedded or linked), from the board's origin in millimetres. An STL is the same
 * assembly's triangles (no colours or parts: one mesh, for printing or an enclosure's design).
 */
export function StepExportDialog({ ed, format = 'step' }: { ed: PcbEditor; format?: 'step' | 'stl' }) {
  const doc = ed.doc;
  const selected = ed.moveSet().components;
  const [which, setWhich] = useState<'all' | 'selected'>('all');
  const [holes, setHoles] = useState(true);
  const label = format === 'stl' ? 'STL' : 'STEP';
  const ok = async () => {
    closeDialog();
    notify(`Writing the ${label} file…`);
    try {
      const leftOut: string[] = [];
      const text = await exportStep(doc, { models: await boardModels(ed), holes, components: which === 'selected' ? new Set(selected) : undefined, leftOut });
      const stem = doc.name.replace(/\.(pcbdoc|pcblib)$/i, '');
      let bytes: Uint8Array = new TextEncoder().encode(text);
      if (format === 'stl') {
        const m = tessellateStep(parseStep(text));
        if (!m.meshes.length) throw new Error('nothing to write');
        bytes = writeStl(stem, m.meshes);
      }
      const name = `${stem}.${format}`;
      await saveFileAs(name, bytes);
      notify(`${name} written`);
      if (leftOut.length) notify(`${name}: ${leftOutWords(leftOut)}`, 'error');
    } catch (e) { notify(`Couldn't write the ${label} file: ${(e as Error).message}`, 'error'); }
  };
  return (
    <Dialog title={`Export ${label}`} width={420} onClose={closeDialog} onAccept={() => { void ok(); return false; }} footer={footer(() => void ok())}>
      <fieldset class="pd-group"><legend>Components</legend>
        <label class="pd-radio"><input type="radio" name="step-which" checked={which === 'all'} onChange={() => setWhich('all')} /> All components</label>
        <label class="pd-radio"><input type="radio" name="step-which" checked={which === 'selected'} disabled={!selected.length} onChange={() => setWhich('selected')} /> Selected components only ({selected.length})</label>
      </fieldset>
      <fieldset class="pd-group"><legend>Board</legend>
        <label class="pd-radio"><input type="checkbox" checked={holes} onChange={() => setHoles(!holes)} /> Drill holes through the board</label>
      </fieldset>
      <p class="muted small">{format === 'stl' ? 'Binary STL, millimetres from the board\'s origin: the board and every body as one mesh of triangles.' : 'AP214, millimetres from the board\'s origin: the board and each component a part; STEP models (embedded, or linked and found) kept exact.'}</p>
    </Dialog>
  );
}
