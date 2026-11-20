import { useState } from 'preact/hooks';
import { PLANNED_NOTE, featureOn } from '../../core/release';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon } from '../icons';
import { createProject } from '../actions';
import { notify, projects } from '../state';
import { hasFolderAccess, requestProjectFolder } from '../../platform/fs';

/** The last Location chosen, offered again (for this session). */
let lastLocation: FileSystemDirectoryHandle | null = null;
const BAD = /[\\/:*?"<>|]/;

export type ProjectKind = 'PrjPcb' | 'LibPkg' | 'PrjMbd';
/** The project types Konium makes, as AD17's New Project dialog lists them. */
const TYPES: [ProjectKind, string, string][] = [['PrjPcb', 'PCB Project', 'prjpcb'], ['LibPkg', 'Integrated Library', 'libpkg'], ['PrjMbd', 'Multi-board Design Project', 'prjmbd']];
const STEM: Record<ProjectKind, string> = { PrjPcb: 'PCB_Project', LibPkg: 'Integrated_Library', PrjMbd: 'MultiBoard_Project' };

/** AD17's first name for a new project of the kind, made unique among the open ones [est]. */
export function defaultProjectName(kind: ProjectKind = 'PrjPcb'): string {
  const taken = new Set(projects.value.map((p) => p.name.toLowerCase()));
  const stem = STEM[kind], ext = kind.toLowerCase();
  if (!taken.has(`${stem}.${ext}`.toLowerCase())) return stem;
  let n = 1;
  while (taken.has(`${stem}${n}.${ext}`.toLowerCase())) n++;
  return `${stem}${n}`;
}

/**
 * File › New › Project: AD17's New Project dialog. Project Types and Templates as AD17 lists
 * them for what Konium makes (a PCB Project, the default template), the Name, the Location
 * (Browse Location: the folder selector, as a browser can't take a typed path) and Create
 * Project Folder. OK creates and saves the project there, as AD17 does.
 */
export function NewProjectDialog() {
  const [kind, setKind] = useState<ProjectKind>('PrjPcb');
  const [name, setName] = useState(() => defaultProjectName('PrjPcb'));
  const [edited, setEdited] = useState(false);
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(lastLocation);
  const [createFolder, setCreateFolder] = useState(true);
  const [busy, setBusy] = useState(false);
  const folders = hasFolderAccess();
  const trimmed = name.trim();
  const problem = !trimmed ? 'Type a name for the project' : BAD.test(trimmed) ? 'A name can\'t contain \\ / : * ? " < > |' : null;

  const browse = async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const d = await requestProjectFolder(dir ?? undefined);
      if (d) { setDir(d); lastLocation = d; }
      return d;
    } catch (e) { notify(`Couldn't open the folder selector: ${(e as Error).message}`, 'error'); return null; }
  };
  const ok = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const where = folders ? dir ?? (await browse()) : null;
      if (folders && !where) return;
      await createProject({ name: trimmed.replace(/\.(prjpcb|libpkg|prjmbd)$/i, ''), dir: where, createFolder, kind });
      closeDialog();
    } catch (e) {
      notify(`Couldn't create the project: ${(e as Error).message}`, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="New Project" width={560} onClose={closeDialog} onAccept={() => { void ok(); return false; }} class="newproject"
      footer={<><span class="spacer" /><button class="btn default" disabled={!!problem || busy} onClick={() => void ok()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="np-lists">
        <label class="np-col"><span>Project Types:</span>
          <div class="vc-list" role="listbox" aria-label="Project Types">
            {TYPES.map(([k, label, icon]) => {
              // A project kind of a feature not released yet: shown, planned
              const later = k === 'PrjMbd' && !featureOn('multiboard');
              return (
                <div key={k} role="option" aria-selected={kind === k} aria-disabled={later || undefined} title={later ? PLANNED_NOTE : undefined} class={`np-item${kind === k ? ' on' : ''}${later ? ' planned-feature' : ''}`}
                  onClick={() => { if (later) return; setKind(k); if (!edited) setName(defaultProjectName(k)); }}><ColourIcon name={icon} size={16} /> {label}{later && <span class="planned-tag">Planned</span>}</div>
              );
            })}
          </div>
        </label>
        <label class="np-col"><span>Project Templates:</span>
          <div class="vc-list" role="listbox" aria-label="Project Templates">
            <div role="option" aria-selected class="np-item on">&lt;Default&gt;</div>
          </div>
        </label>
      </div>
      <div class="np-fields">
        <label class="np-row"><span>Name</span>
          <input id="np-name" autoFocus value={name} onInput={(e) => { setName((e.target as HTMLInputElement).value); setEdited(true); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void ok(); } }} />
        </label>
        <div class="np-row"><span>Location</span>
          <input readOnly value={folders ? dir?.name ?? '' : ''} placeholder={folders ? 'Choose a folder...' : 'Kept in Konium Designer until you save it'} aria-label="Location" />
          <button class="btn" disabled={!folders} onClick={() => void browse()}>Browse Location...</button>
        </div>
        <label class="np-check"><input type="checkbox" checked={createFolder} disabled={!folders} onChange={(e) => setCreateFolder((e.target as HTMLInputElement).checked)} /> Create Project Folder</label>
        {problem ? <p class="error-text small">{problem}</p>
          : <p class="muted small">{folders
            ? (dir ? `Saves ${trimmed}.${kind} in “${dir.name}${createFolder ? `/${trimmed}` : ''}”. New documents are saved beside it.` : 'OK asks for the folder if none is chosen.')
            : 'This browser can\'t write into a folder: Save Project downloads the project file.'}</p>}
      </div>
    </Dialog>
  );
}
