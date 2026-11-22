import { loadProjectFolder, openBatch } from './actions';
import { hasFolderAccess } from '../platform/fs';
import { notify, projectAccess, projects } from './state';
import { Dialog } from './Dialog';

/**
 * Shown when a project file arrived without its documents (File › Open Project when the browser
 * needs another click, a dropped .PrjPcb, or a double-click from the desktop). One button opens
 * the folder picker inside the project's own folder.
 */
export function ProjectAccess() {
  const p = projectAccess.value;
  if (!p) return null;
  const close = () => { projectAccess.value = null; };
  const wrk = /\.dsnwrk$/i.test(p.name);
  const choose = async () => {
    try { await loadProjectFolder(p); } catch (e) { notify(`Couldn't open the folder: ${(e as Error).message}`, 'error'); }
  };
  return (
    <Dialog title={`Open ${p.name}`} class="access" width={520} onClose={close}
      footer={<>
        <button class="btn default" autoFocus onClick={choose}>{wrk ? 'Choose workspace folder...' : 'Choose project folder...'}</button>
        {!wrk && <button class="btn" onClick={() => {
          // Opened via drop/Open… the project is already in the tree; via File › Open Project it isn't yet.
          // openBatch runs while the dialog is still set, so it doesn't ask again.
          if (!projects.value.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) openBatch([p.file]);
          close();
        }}>Open project file only</button>}
        <span class="spacer" />
        <button class="btn" onClick={close}>Cancel</button>
      </>}>
      {p.error
        ? <p class="error-text">{p.error}</p>
        : wrk ? <p>Your browser gave Konium Designer only the workspace file. Confirm a folder that holds it and its {p.missing} project{p.missing === 1 ? '' : 's'} (a workspace often lists projects in folders beside its own: choose the folder above them) and they open together.</p>
        : <p>Your browser gave Konium Designer only the project file. Confirm its folder once and the schematics and board load with it. Konium Designer only reads and saves the project's files there.</p>}
      <p class="muted small">{hasFolderAccess()
        ? 'After that, the project opens from Recent projects, or from File › Open Project, without asking for the folder again.'
        : 'This browser hands a folder\'s files over once and keeps no way back to it: the folder is chosen each time the project is opened, and what you save comes as downloads. Chrome and Edge remember the folder and save into it.'}</p>
    </Dialog>
  );
}
