/**
 * Dialogs of 26.042 [est: laid out from AD17's]: Project Packager, Create Projects from Path,
 * Explore (a folder of the project, as the system's file browser would show it), All Recent
 * Documents and Projects, Add New to Project › Other, a message's More Info, and the save
 * question before Exit.
 */
import { featureOn } from '../../core/release';
import { locale } from '../../core/locale';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon, docIcon } from '../icons';
import { notify, type Message, type OpenDoc, type Project } from '../state';
import { packageZip, type PackFile, type PackKind } from '../../model/packager';
import type { PathProject } from '../../model/designWorkspace';
import { fileFromHandle, listFolder, saveFileAs } from '../../platform/fs';
import { openBatch, openDocument, openProjectFolder, reopenRecent, reopenRecentDocument } from '../actions';
import { recentDocuments, recentProjects } from '../state';
import { PROJECT_FILE } from '../../formats/altium/prjpcb';

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} KB`);
const KIND_LABEL: Record<PackKind, string> = { project: 'Project', document: 'Document', library: 'Library', output: 'Generated', other: 'Other' };

/* ─── Project Packager ───────────────────────────────────────────────────────────────── */

export function ProjectPackagerDialog({ project, files }: { project: Project; files: PackFile[] }) {
  const base = project.name.replace(/\.[^.]+$/, '');
  const [zipName, setZipName] = useState(`${base}.zip`);
  const [outputs, setOutputs] = useState(false);
  const [other, setOther] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const shown = files.filter((f) => (f.kind !== 'output' || outputs) && (f.kind !== 'other' || other));
  const chosen = shown.filter((f) => f.kind === 'project' || !off.has(f.path));
  const size = chosen.reduce((s, f) => s + f.bytes.length, 0);
  const counts = { output: files.filter((f) => f.kind === 'output').length, other: files.filter((f) => f.kind === 'other').length };
  const modified = chosen.filter((f) => f.modified).length;
  const toggle = (f: PackFile) => { const s = new Set(off); if (s.has(f.path)) s.delete(f.path); else s.add(f.path); setOff(s); };
  const finish = async () => {
    if (busy) return;
    const name = /\.zip$/i.test(zipName.trim()) ? zipName.trim() : `${zipName.trim() || base}.zip`;
    setBusy(true);
    try {
      const h = await saveFileAs(name, packageZip(project.name, chosen), project.dir);
      if (h === null) return;
      closeDialog();
      notify(`Packaged ${project.name}: ${chosen.length} files, ${kb(size)} into ${name}`);
    } catch (e) {
      notify(`Couldn't write the package: ${(e as Error).message}`, 'error');
    } finally { setBusy(false); }
  };
  return (
    <Dialog title="Project Packager" width={720} height={560} onClose={closeDialog} onAccept={() => { void finish(); return false; }} class="packager"
      footer={<><span class="muted small">{chosen.length} files, {kb(size)}{modified ? ` · ${modified} modified document${modified > 1 ? 's' : ''} packed as they are now` : ''}</span><span class="spacer" />
        <button class="btn default" disabled={busy || !chosen.length} onClick={() => void finish()}>Finish</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="do-row"><span>Output Zip File</span><input type="text" aria-label="Zip file name" value={zipName} onInput={(e) => setZipName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      <fieldset><legend>Package Options</legend>
        <label class="out-check"><input type="checkbox" checked={outputs} disabled={!counts.output} onChange={() => setOutputs(!outputs)} />Include generated files ({counts.output})</label>
        <label class="out-check"><input type="checkbox" checked={other} disabled={!counts.other} onChange={() => setOther(!other)} />Include non-project files in the project folder ({counts.other})</label>
        {!project.dir && <p class="muted small">The project wasn't opened from its folder: only its documents are packed.</p>}
      </fieldset>
      <Grid cols={[
        { label: 'Include', width: '56px', get: (f: PackFile) => <input type="checkbox" aria-label={`Include ${f.path}`} checked={f.kind === 'project' || !off.has(f.path)} disabled={f.kind === 'project'} onChange={() => toggle(f)} /> },
        { label: 'File', width: 'minmax(200px, 1fr)', get: (f) => <span class="pk-file"><ColourIcon name={docIcon(f.path)} size={14} />{f.path}{f.modified ? ' *' : ''}</span> },
        { label: 'Kind', width: '90px', get: (f) => KIND_LABEL[f.kind] },
        { label: 'Size', width: '80px', align: 'right', get: (f) => kb(f.bytes.length) },
      ]} rows={shown} empty="Nothing to pack" />
    </Dialog>
  );
}

/* ─── Create Projects from Path ──────────────────────────────────────────────────────── */

export function CreateProjectsDialog({ root, found, onOk }: { root: string; found: PathProject[]; onOk: (chosen: PathProject[]) => void }) {
  const [on, setOn] = useState<Set<number>>(() => new Set(found.map((_, i) => i)));
  const ok = () => { closeDialog(); onOk(found.filter((_, i) => on.has(i))); };
  const toggle = (i: number) => { const s = new Set(on); if (s.has(i)) s.delete(i); else s.add(i); setOn(s); };
  return (
    <Dialog title="Create Projects from Path" width={680} height={480} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" disabled={!on.size} onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">Folders of “{root}” that hold design documents but no project. Each ticked one gets a project named after it, listing its documents; save the projects to write them there.</p>
      <Grid cols={[
        { label: 'Create', width: '56px', get: (r: PathProject) => { const i = found.indexOf(r); return <input type="checkbox" aria-label={`Create ${r.name}`} checked={on.has(i)} onChange={() => toggle(i)} />; } },
        { label: 'Project', width: '200px', get: (r) => <span class="pk-file"><ColourIcon name={docIcon(r.name)} size={14} />{r.name}</span> },
        { label: 'Folder', width: '160px', get: (r) => (r.folder ? `${root}\\${r.folder.replace(/\//g, '\\')}` : root) },
        { label: 'Documents', width: 'minmax(160px, 1fr)', get: (r) => <span title={r.documents.join(', ')}>{r.documents.length}: {r.documents.slice(0, 4).join(', ')}{r.documents.length > 4 ? ' …' : ''}</span> },
      ]} rows={found} />
    </Dialog>
  );
}

/* ─── Explore ────────────────────────────────────────────────────────────────────────── */

type Entry = { name: string; kind: 'file' | 'directory'; handle: FileSystemHandle };
const OPENS = /\.(prjpcb|libpkg|dsnwrk|schdoc|pcbdoc|schlib|pcblib|intlib|outjob)$/i;

export function ExploreDialog({ dir, label, project }: { dir: FileSystemDirectoryHandle; label: string; project: Project | null }) {
  const [stack, setStack] = useState<{ dir: FileSystemDirectoryHandle; name: string }[]>([{ dir, name: label }]);
  const [list, setList] = useState<Entry[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const here = stack.at(-1)!;
  useEffect(() => {
    let live = true;
    setList(null); setSel(null);
    listFolder(here.dir).then((l) => { if (live) setList(l); }).catch((e) => { if (live) { setList([]); notify(`Couldn't read “${here.name}”: ${(e as Error).message}`, 'error'); } });
    return () => { live = false; };
  }, [here]);
  const open = async (e: Entry | undefined) => {
    if (!e) return;
    if (e.kind === 'directory') { setStack([...stack, { dir: e.handle as FileSystemDirectoryHandle, name: e.name }]); return; }
    if (!OPENS.test(e.name)) { notify(`${e.name} isn't a document Konium Designer opens`, 'error'); return; }
    closeDialog();
    if (PROJECT_FILE.test(e.name) || /\.dsnwrk$/i.test(e.name)) { await openProjectFolder(here.dir, e.name); return; }
    const f = await fileFromHandle(e.handle as FileSystemFileHandle);
    const inProject = project?.files.get(e.name.toLowerCase());
    if (project && inProject) openDocument(inProject, project.id); else openBatch([f]);
  };
  const path = stack.map((s) => s.name).join('\\');
  return (
    <Dialog title={`Explore — ${path}`} width={640} height={480} onClose={closeDialog} class="explore"
      footer={<><button class="btn" disabled={stack.length < 2} onClick={() => setStack(stack.slice(0, -1))}>Up</button><span class="spacer" />
        <button class="btn default" disabled={sel === null} onClick={() => void open(sel === null ? undefined : list?.[sel])}>Open</button><button class="btn" onClick={closeDialog}>Close</button></>}>
      <div class="explore-path" title={path}><ColourIcon name="folderOpen" size={14} /> {path}</div>
      {list === null ? <p class="muted">Reading the folder…</p> : (
        <Grid cols={[
          { label: 'Name', width: 'minmax(220px, 1fr)', get: (e: Entry) => <span class="pk-file"><ColourIcon name={e.kind === 'directory' ? 'folder' : docIcon(e.name)} size={14} />{e.name}</span> },
          { label: 'Type', width: '140px', get: (e) => (e.kind === 'directory' ? 'Folder' : `${(e.name.split('.').pop() ?? '').toUpperCase()} File`) },
        ]} rows={list} sel={sel} onSel={setSel} onOpen={(i) => void open(list[i])} empty="The folder is empty" />
      )}
    </Dialog>
  );
}

/* ─── All Recent Documents and Projects ──────────────────────────────────────────────── */

type Recent = { kind: 'Project' | 'Document'; name: string; where: string; at: number; open: () => Promise<void> };

export function RecentAllDialog() {
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const all = useMemo<Recent[]>(() => [
    ...recentProjects.value.map((r): Recent => ({ kind: 'Project', name: r.name, where: `${r.folder}\\${r.prjPath.replace(/\//g, '\\')}`, at: r.at, open: () => reopenRecent(r) })),
    ...recentDocuments.value.map((r): Recent => ({ kind: 'Document', name: r.name, where: '', at: r.at, open: () => reopenRecentDocument(r) })),
  ].sort((a, b) => b.at - a.at), []);
  const rows = all.filter((r) => !filter || `${r.name} ${r.where}`.toLowerCase().includes(filter.toLowerCase()));
  const open = (r: Recent | undefined) => { if (!r) return; closeDialog(); void r.open(); };
  return (
    <Dialog title="All Recent Documents and Projects" width={680} height={460} onClose={closeDialog} onAccept={() => { open(sel === null ? undefined : rows[sel]); return false; }}
      footer={<><span class="spacer" /><button class="btn default" disabled={sel === null} onClick={() => open(sel === null ? undefined : rows[sel])}>Open</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="do-row"><span>Filter</span><input type="text" aria-label="Filter" value={filter} onInput={(e) => { setFilter((e.target as HTMLInputElement).value); setSel(null); }} onKeyDown={(e) => e.stopPropagation()} /></label>
      <Grid cols={[
        { label: 'Name', width: '220px', get: (r: Recent) => <span class="pk-file"><ColourIcon name={docIcon(r.name)} size={14} />{r.name}</span> },
        { label: 'Kind', width: '80px', get: (r) => r.kind },
        { label: 'Location', width: 'minmax(160px, 1fr)', get: (r) => r.where },
        { label: 'Opened', width: '140px', get: (r) => new Date(r.at).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) },
      ]} rows={rows} sel={sel} onSel={setSel} onOpen={(i) => open(rows[i])} empty="Nothing opened yet" />
    </Dialog>
  );
}

/* ─── Add New to Project › Other ─────────────────────────────────────────────────────── */

const OTHER: [string, string, string][] = [
  ['SchDoc', 'Schematic', 'schdoc'], ['PcbDoc', 'PCB', 'pcbdoc'], ['SchLib', 'Schematic Library', 'schlib'], ['PcbLib', 'PCB Library', 'pcblib'],
  ['OutJob', 'Output Job File', 'file'], ['Draftsman', 'Draftsman Document', 'pcbdoc'],
  // Shown once Diagrams is switched on (a planned feature until then)
  ...(featureOn('diagrams') ? [['Diagram', 'Diagram', 'diagramDoc'] as [string, string, string]] : []),
  ...(featureOn('requirements') ? [['ReqDoc', 'Requirements', 'reqDoc'] as [string, string, string]] : []),
];

export function NewOtherDialog({ project, make }: { project: Project | null; make: Record<string, () => void> }) {
  const [sel, setSel] = useState(0);
  const ok = () => { closeDialog(); make[OTHER[sel]![0]]?.(); };
  return (
    <Dialog title="New Document" width={420} height={360} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">{project ? `Adds the new document to ${project.name}.` : 'A free document (no project is focused).'}</p>
      <div class="vc-list" role="listbox" aria-label="Document Types">
        {OTHER.map(([k, label, icon], i) => <div key={k} role="option" aria-selected={sel === i} class={`np-item${sel === i ? ' on' : ''}`} onClick={() => setSel(i)} onDblClick={() => { setSel(i); closeDialog(); make[k]?.(); }}>
          <ColourIcon name={icon} size={16} /> {label}</div>)}
      </div>
    </Dialog>
  );
}

/* ─── Messages › More Info ───────────────────────────────────────────────────────────── */

export function MessageInfoDialog({ m }: { m: Message }) {
  const cls = m.cls ?? `[${m.level === 'warn' ? 'Warning' : m.level === 'error' ? 'Error' : 'Info'}]`;
  const rows: [string, string][] = [['Class', cls], ['Document', m.doc], ['Source', m.source], ['Message', m.message],
    ['Time', new Date(m.at).toLocaleTimeString(locale())], ['Date', new Date(m.at).toLocaleDateString(locale())], ['No.', String(m.no)]];
  return (
    <Dialog title="Message" width={520} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><span class="spacer" />{m.locate && <button class="btn" onClick={() => { closeDialog(); m.locate?.(); }}>Cross Probe</button>}<button class="btn default" onClick={closeDialog}>Close</button></>}>
      <dl class="msg-info">{rows.map(([k, v]) => <div key={k} class="prop"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </Dialog>
  );
}

/* ─── Exit ───────────────────────────────────────────────────────────────────────────── */

export type Unsaved = { label: string; doc?: OpenDoc; project?: Project };

/** Confirm Save for Modified Documents: tick what to save; OK saves those, then exits. */
export function ExitDialog({ items, onExit }: { items: Unsaved[]; onExit: (save: Unsaved[]) => void }) {
  const [on, setOn] = useState<Set<number>>(() => new Set(items.map((_, i) => i)));
  const ok = () => { closeDialog(); onExit(items.filter((_, i) => on.has(i))); };
  const toggle = (i: number) => { const s = new Set(on); if (s.has(i)) s.delete(i); else s.add(i); setOn(s); };
  return (
    <Dialog title="Confirm Save for Modified Documents" width={520} height={400} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><button class="btn" onClick={() => setOn(new Set(items.map((_, i) => i)))}>Save All</button><button class="btn" onClick={() => setOn(new Set())}>Save None</button><span class="spacer" />
        <button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p>{items.length} document{items.length > 1 ? 's have' : ' has'} unsaved changes. Ticked ones are saved before Konium Designer closes.</p>
      <Grid cols={[
        { label: 'Save', width: '50px', get: (u: Unsaved) => { const i = items.indexOf(u); return <input type="checkbox" aria-label={`Save ${u.label}`} checked={on.has(i)} onChange={() => toggle(i)} />; } },
        { label: 'Document', width: 'minmax(200px, 1fr)', get: (u) => <span class="pk-file"><ColourIcon name={docIcon(u.label)} size={14} />{u.label}</span> },
      ]} rows={items} />
    </Dialog>
  );
}
