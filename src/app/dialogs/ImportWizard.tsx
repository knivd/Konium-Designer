import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { importAndOpen } from '../importFiles';
import { importersOn, headOf } from '../../formats/importers';
import { hasFolderAccess, pickImportFiles, pickImportFolder, requestProjectFolder, type PickedFile } from '../../platform/fs';

let lastOut: FileSystemDirectoryHandle | null = null;

/**
 * File › Import Wizard: AD's wizard on one page — the type of files, the files (Add Folder takes
 * a project's folder with its sheets and libraries), what of them to import, the output folder
 * (the imported projects are saved there, each in its own folder; without one they stay in
 * Konium until saved), then Import: the projects open, the report goes to Messages.
 */
export function ImportWizardDialog({ files: given = [], type: given0 }: { files?: PickedFile[]; type?: string }) {
  const [type, setType] = useState(given0 ?? importersOn()[0]!.id);
  const importer = importersOn().find((i) => i.id === type) ?? importersOn()[0]!;
  const [files, setFiles] = useState<PickedFile[]>(given);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [out, setOut] = useState<FileSystemDirectoryHandle | null>(lastOut);
  const [busy, setBusy] = useState<string | null>(null);
  const mine = useMemo(() => files.filter((f) => importer.takes(f.name, headOf(f.bytes))), [files, importer]);
  const items = useMemo(() => importer.list(mine.map((f) => ({ path: f.path ?? f.name, bytes: f.bytes }))), [mine, importer]);
  const chosen = items.filter((i) => !off.has(i.path));
  const want = new RegExp(`(${importer.exts.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i');
  const add = (more: PickedFile[]) => {
    const seen = new Set(files.map((f) => (f.path ?? f.name).toLowerCase()));
    const fresh = more.filter((f) => importer.takes(f.name, headOf(f.bytes)) && !seen.has((f.path ?? f.name).toLowerCase()));
    if (more.length && !fresh.length) notify(`No ${importer.label} among them`, 'error');
    setFiles([...files, ...fresh]);
  };
  const addFolder = async () => {
    try { const got = await pickImportFolder(want); if (got) add(got); }
    catch (e) { notify(`Couldn't read the folder: ${(e as Error).message}`, 'error'); }
  };
  const addFiles = async () => {
    try { add(await pickImportFiles(importer.exts, importer.label)); } catch (e) { notify(`Couldn't read the files: ${(e as Error).message}`, 'error'); }
  };
  const browse = async () => {
    try { const d = await requestProjectFolder(out ?? undefined); if (d) { setOut(d); lastOut = d; } }
    catch (e) { notify(`Couldn't open the folder selector: ${(e as Error).message}`, 'error'); }
  };
  const run = async () => {
    if (!chosen.length || busy) return;
    setBusy('Importing…');
    try {
      await importAndOpen(importer, mine, { only: new Set(chosen.map((i) => i.path)), outDir: out, progress: (s) => setBusy(s) });
      closeDialog();
    } catch (e) { notify(`Import failed: ${(e as Error).message}`, 'error'); setBusy(null); }
  };
  const toggle = (p: string) => { const n = new Set(off); if (n.has(p)) n.delete(p); else n.add(p); setOff(n); };
  return (
    <Dialog title="Import Wizard" width={720} height={640} onClose={() => { if (!busy) closeDialog(); }} onAccept={() => { void run(); return false; }} class="importwizard"
      footer={<><span class="muted small">{busy ?? `${chosen.length} of ${items.length} to import`}</span><span class="spacer" />
        <button class="btn default" disabled={!chosen.length || !!busy} onClick={() => void run()}>Import</button><button class="btn" disabled={!!busy} onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Select Type of Files to Import</legend>
        <div class="vc-list" role="listbox" aria-label="Type of files">
          {importersOn().map((t) => <div key={t.id} role="option" aria-selected={type === t.id} class={`np-item${type === t.id ? ' on' : ''}`} onClick={() => { if (!busy) { setType(t.id); setOff(new Set()); } }}>{t.label}</div>)}
        </div>
        <p class="muted small">{importer.note}</p>
      </fieldset>
      <fieldset class="iw-files"><legend>Files to Import</legend>
        <div class="iw-buttons">
          <button class="btn" disabled={!!busy} onClick={() => void addFolder()}>Add Folder...</button>
          <button class="btn" disabled={!!busy} onClick={() => void addFiles()}>Add Files...</button>
          <button class="btn" disabled={!files.length || !!busy} onClick={() => { setFiles([]); setOff(new Set()); }}>Clear</button>
        </div>
        <div class="vc-list iw-list" role="list" aria-label="Files to import">
          {items.length ? items.map((i) => (
            <label key={i.path} class="iw-item"><input type="checkbox" checked={!off.has(i.path)} disabled={!!busy} onChange={() => toggle(i.path)} />
              <span class="iw-kind">{i.kind}</span><span class="iw-path" title={i.path}>{i.path}</span>{i.note && <span class="error-text small">{i.note}</span>}</label>
          )) : <p class="muted small iw-empty">Add a folder (a project's, with everything it uses) or files.</p>}
        </div>
      </fieldset>
      <fieldset><legend>Output Folder</legend>
        <div class="iw-out">
          <input readOnly value={out?.name ?? ''} placeholder={hasFolderAccess() ? 'None: kept in Konium Designer until you save' : 'Kept in Konium Designer until you save'} aria-label="Output folder" />
          <button class="btn" disabled={!hasFolderAccess() || !!busy} onClick={() => void browse()}>Browse...</button>
          {out && <button class="btn" disabled={!!busy} onClick={() => { setOut(null); lastOut = null; }}>None</button>}
        </div>
        <p class="muted small">{out ? `Each project is saved in its own folder in “${out.name}”, libraries beside them.` : 'The imported projects open unsaved.'} 3D models are linked by name (add their folder in Preferences › PCB Editor › Models).</p>
      </fieldset>
    </Dialog>
  );
}
