import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, type Project } from '../state';
import { exportAndSave, projectForExport } from '../exportFiles';
import { EXPORTERS } from '../../formats/exporters';
import { hasFolderAccess, requestProjectFolder } from '../../platform/fs';
import { activeProject } from '../project';
import { active } from '../state';

let lastOut: FileSystemDirectoryHandle | null = null;

/**
 * File › Export Wizard (Konium's, the Import Wizard's other way): the type of files to write, what
 * of the project goes (schematics, board, libraries), the output folder (none: a zip download),
 * then Export: the files are written, the report goes to Messages.
 */
export function ExportWizardDialog({ type: given0 }: { type?: string }) {
  const [type, setType] = useState(given0 ?? EXPORTERS[0]!.id);
  const exporter = EXPORTERS.find((e) => e.id === type) ?? EXPORTERS[0]!;
  const p: Project | null = activeProject();
  const what = p ? p.name : active.value?.name ?? '';
  const [parts, setParts] = useState({ sheets: true, board: true, libraries: true });
  const [out, setOut] = useState<FileSystemDirectoryHandle | null>(lastOut ?? p?.dir ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const counts = p ? {
    sheets: p.prj.documents.filter((d) => /\.schdoc$/i.test(d)).length, board: p.prj.documents.filter((d) => /\.pcbdoc$/i.test(d)).length,
    libraries: p.prj.documents.filter((d) => /\.(schlib|pcblib)$/i.test(d)).length,
  } : null;
  const browse = async () => {
    try { const d = await requestProjectFolder(out ?? undefined); if (d) { setOut(d); lastOut = d; } }
    catch (e) { notify(`Couldn't open the folder selector: ${(e as Error).message}`, 'error'); }
  };
  const run = async () => {
    if (busy) return;
    setBusy('Exporting…');
    try {
      const project = await projectForExport(p, parts);
      if (!project) { notify('Nothing to export: open a project or a document', 'error'); setBusy(null); return; }
      const r = await exportAndSave(exporter, project, out, (s) => setBusy(s));
      if (r) closeDialog(); else setBusy(null);
    } catch (e) { notify(`Export failed: ${(e as Error).message}`, 'error'); setBusy(null); }
  };
  const box = (k: keyof typeof parts, label: string, n?: number) => (
    <label class="iw-item"><input type="checkbox" checked={parts[k]} disabled={!!busy || n === 0} onChange={() => setParts({ ...parts, [k]: !parts[k] })} />
      <span class="iw-kind">{label}</span><span class="iw-path">{n === undefined ? '' : n === 0 ? 'none in the project' : `${n} document${n === 1 ? '' : 's'}`}</span></label>
  );
  return (
    <Dialog title="Export Wizard" width={720} height={600} onClose={() => { if (!busy) closeDialog(); }} onAccept={() => { void run(); return false; }} class="importwizard"
      footer={<><span class="muted small">{busy ?? (what ? `From ${what}` : 'Open a project or a document to export')}</span><span class="spacer" />
        <button class="btn default" disabled={!what || !!busy} onClick={() => void run()}>Export</button><button class="btn" disabled={!!busy} onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Select Type of Files to Export</legend>
        <div class="vc-list" role="listbox" aria-label="Type of files">
          {EXPORTERS.map((t) => <div key={t.id} role="option" aria-selected={type === t.id} class={`np-item${type === t.id ? ' on' : ''}`} onClick={() => { if (!busy) setType(t.id); }}>{t.label}</div>)}
        </div>
        <p class="muted small">{exporter.note}</p>
      </fieldset>
      <fieldset><legend>What to Export</legend>
        <div class="vc-list iw-list ew-list" role="list" aria-label="What to export">
          {p ? <>{box('sheets', 'Schematics', counts!.sheets)}{box('board', 'PCB', counts!.board)}{box('libraries', 'Libraries', counts!.libraries)}</>
            : <p class="muted small iw-empty">{what ? `${what} (a free document: exported alone)` : 'Open a project or a document.'}</p>}
        </div>
      </fieldset>
      <fieldset><legend>Output Folder</legend>
        <div class="iw-out">
          <input readOnly value={out?.name ?? ''} placeholder={hasFolderAccess() ? 'None: downloaded as a zip' : 'Downloaded as a zip'} aria-label="Output folder" />
          <button class="btn" disabled={!hasFolderAccess() || !!busy} onClick={() => void browse()}>Browse...</button>
          {out && <button class="btn" disabled={!!busy} onClick={() => { setOut(null); lastOut = null; }}>None</button>}
        </div>
        <p class="muted small">{out ? `The files go in a folder named after the project in “${out.name}”.` : 'The files are downloaded as one zip, in a folder named after the project.'}</p>
      </fieldset>
    </Dialog>
  );
}
