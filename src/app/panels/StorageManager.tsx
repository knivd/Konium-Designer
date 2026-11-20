/**
 * The Storage Manager panel, as AD's (its Project Files and Local History regions; version
 * control has its own History, Project › Version Control): the focused project's files — File, Size, Kind, Date Modified,
 * Status (the active document bold, changed ones red) — and the selected file's time line:
 * Document (as it is open), Last Saved Contents (the file), then its Local History versions,
 * newest first (Version n, Version n [label], Version n [AutoSave …]), and with Show
 * Autobackups its auto-saved copies. Right-click: Open, Compare (a schematic or board: the line
 * picked beside the document as it is, or the two picked side by side), Apply Label, Revert to,
 * Delete, Purge History, Show Autobackups, Refresh; double-click opens.
 */
import { locale } from '../../core/locale';
import { useEffect, useState } from 'preact/hooks';
import { docBaseName } from '../../formats/altium/prjpcb';
import { active, activeId, currentProject, docs, isDocDirty, notify, projects, tick } from '../state';
import { openMenuAt } from '../MenuBar';
import { showDialog, closeDialog } from '../dialogs';
import { ConfirmDialog, PromptDialog } from '../dialogs/Confirm';
import { Dialog } from '../Dialog';
import {
  autoCopyBytes, backupName, backupTick, copiesOf, deleteVersions, labelVersion, openVersion, purgeHistory, refOf, revertTo, versionBytes, versionTitle,
  versionsOf, type FileRef, type Version,
} from '../backup';
import type { AutoCopy } from '../../platform/backupStore';
import { canCompare, startCompare } from '../compare';

const kindOf = (name: string) => (/\.([^.]+)$/.exec(name)?.[1] ?? '').replace(/^prjpcb$/i, 'PrjPcb');
const size = (n?: number) => (n === undefined ? '' : n < 1024 ? `${n} B` : `${Math.round(n / 1024).toLocaleString(locale())} KB`);
const when = (t?: number) => (t ? new Date(t).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'medium' }) : '');

interface Row { ref: FileRef; size?: number; at?: number }
type Line =
  | { kind: 'document'; title: string }
  | { kind: 'saved'; title: string; size?: number; at?: number }
  | { kind: 'version'; title: string; v: Version }
  | { kind: 'auto'; title: string; c: AutoCopy };

/** The focused project's files (its documents and the project file), or the open free documents. */
function filesNow(): FileRef[] {
  const p = currentProject();
  if (!p) return docs.value.filter((d) => !d.projectId && !d.hidden).map(refOf);
  const open = (name: string) => docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
  const rows: FileRef[] = [{ name: p.name, project: p, path: p.path, handle: p.handle }];
  for (const d of p.prj.documents) {
    const name = docBaseName(d), od = open(name), f = p.files.get(name.toLowerCase());
    rows.push(od ? refOf(od) : { name, project: p, path: f?.path, handle: f?.handle });
  }
  return rows;
}

async function statOf(f: FileRef): Promise<{ size?: number; at?: number }> {
  try { if (f.handle) { const x = await f.handle.getFile(); return { size: x.size, at: x.lastModified }; } } catch { /* gone or no access */ }
  const b = f.project?.files.get(f.name.toLowerCase())?.bytes;
  return b ? { size: b.length } : {};
}

export function StorageManagerPanel() {
  void tick.value; void backupTick.value; void projects.value; void docs.value;
  const refs = filesNow();
  const [rows, setRows] = useState<Row[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState<number[]>([]);
  const [autos, setAutos] = useState(false);
  const [again, setAgain] = useState(0);
  const sig = refs.map((r) => `${r.name}|${r.od?.id ?? ''}`).join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(refs.map(async (ref) => ({ ref, ...(await statOf(ref)) }))).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [sig, backupTick.value, again]);
  const chosen = refs.find((r) => r.name === sel) ?? (active.value ? refs.find((r) => r.od === active.value) : undefined) ?? refs[0];
  useEffect(() => {
    let live = true;
    if (!chosen) { setLines([]); return; }
    void (async () => {
      const out: Line[] = [];
      if (chosen.od) out.push({ kind: 'document', title: 'Document' });
      const st = await statOf(chosen);
      if (chosen.handle || st.size !== undefined) out.push({ kind: 'saved', title: 'Last Saved Contents', ...st });
      for (const v of await versionsOf(chosen).catch(() => [])) out.push({ kind: 'version', title: versionTitle(v.n, v.label), v });
      if (autos) for (const c of await copiesOf(chosen)) out.push({ kind: 'auto', title: `AutoSave ${backupName(c.name, c.slot)}`, c });
      if (live) { setLines(out); setPick([]); }
    })();
    return () => { live = false; };
  }, [chosen?.name, chosen?.od?.id, autos, backupTick.value, again]);

  const dirty = (r: FileRef) => !!r.od && isDocDirty(r.od);
  const bytesOfLine = async (l: Line): Promise<Uint8Array | null> => {
    if (!chosen) return null;
    if (l.kind === 'version') return versionBytes(chosen, l.v);
    if (l.kind === 'auto') return autoCopyBytes(l.c.key);
    if (l.kind === 'saved') return chosen.handle ? new Uint8Array(await (await chosen.handle.getFile()).arrayBuffer()) : chosen.project?.files.get(chosen.name.toLowerCase())?.bytes ?? null;
    return null;
  };
  const openLine = async (l: Line) => {
    if (!chosen) return;
    if (l.kind === 'document') { if (chosen.od) activeId.value = chosen.od.id; return; }
    if (l.kind === 'version') { await openVersion(chosen, l.v); return; }
    const b = await bytesOfLine(l);
    if (!b) { notify(`${l.title} couldn't be read`, 'error'); return; }
    const { openDocument } = await import('../actions');
    openDocument({ name: `[${l.kind === 'auto' ? backupName(l.c.name, l.c.slot) : 'Last Saved'}] ${chosen.name}`, bytes: b });
  };
  /** Two lines (or one and the document as it is) side by side, the older on the left. */
  const compareLines = async (picked: number[]) => {
    if (!chosen) return;
    const [newerI, olderI] = picked.length === 1 ? [lines.findIndex((x) => x.kind === 'document'), picked[0]!] : [Math.min(...picked), Math.max(...picked)];
    const nl = lines[newerI], ol = lines[olderI];
    let cur = chosen.od ?? null;
    if (!cur && nl?.kind === 'document') {
      const f = chosen.project?.files.get(chosen.name.toLowerCase());
      const { openDocument } = await import('../actions');
      cur = f ? openDocument(f, chosen.project!.id, false) : null;
    }
    const side = async (l: Line | undefined, tag: string) => {
      if (!l) return null;
      if (l.kind === 'document') return cur ? { od: cur, title: `${chosen.name} as it is` } : null;
      const b = await bytesOfLine(l);
      return b ? { bytes: b, title: `${chosen.name}: ${l.title}`, tag } : null;
    };
    const o = await side(ol, ol?.kind === 'version' ? `Version ${ol.v.n}` : 'older'), n = await side(nl, nl?.kind === 'version' ? `Version ${nl.v.n}` : 'newer');
    if (!o || !n) { notify(`${chosen.name}: that version couldn't be read`, 'error'); return; }
    await startCompare(chosen.name, o, n);
  };
  const menu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    const cur = pick.includes(i) ? pick : [i];
    setPick(cur);
    const l = lines[i]!;
    const vs = cur.map((k) => lines[k]).filter((x): x is Extract<Line, { kind: 'version' }> => x?.kind === 'version').map((x) => x.v);
    const one = cur.length === 1;
    openMenuAt({ key: '', label: 'Local History', children: [
      { key: 'O', label: 'Open', action: () => void openLine(l), disabled: !one },
      { key: 'C', label: 'Compare', disabled: !chosen || !canCompare(chosen.name) || cur.length > 2 || (one && l.kind === 'document') || (!one && cur.length !== 2), action: () => void compareLines(cur) },
      { key: 'L', label: 'Apply Label...', disabled: !one || l.kind !== 'version', action: () => { if (l.kind === 'version' && chosen) showDialog(PromptDialog, { title: 'Apply Label', fields: [{ label: 'Label', value: l.v.label ?? '' }], onOk: ([t]: string[]) => void labelVersion(chosen, l.v, t) }); } },
      { key: 'R', label: 'Revert to', disabled: !one || (l.kind !== 'version' && l.kind !== 'auto' && l.kind !== 'saved'), action: () => {
        if (!chosen) return;
        showDialog(ConfirmDialog, { title: 'Revert', message: `Revert ${chosen.name} to ${l.title}?`, detail: chosen.handle || chosen.project?.dir ? 'The file is saved as that version; the file it replaces is kept in history.' : 'The document becomes that version (unsaved).',
          onYes: () => void (async () => { const b = await bytesOfLine(l); if (!b) { notify(`${l.title} couldn't be read`, 'error'); return; } if (await revertTo(chosen, b)) notify(`${chosen.name} reverted to ${l.title}`); setAgain((x) => x + 1); })() });
      } },
      { key: 'D', label: 'Delete', disabled: !vs.length, action: () => { if (chosen) showDialog(ConfirmDialog, { title: 'Delete', message: `Delete ${vs.length === 1 ? versionTitle(vs[0]!.n, vs[0]!.label) : `${vs.length} versions`} of ${chosen.name} from its history?`, onYes: () => void deleteVersions(chosen, vs) }); } },
      { key: 'P', label: 'Purge History...', separatorBefore: true, disabled: !lines.some((x) => x.kind === 'version'), action: () => { if (chosen) showDialog(PurgeDialog, { f: chosen }); } },
      { key: 'A', label: 'Show Autobackups', checked: autos, action: () => setAutos(!autos) },
      { key: 'F', label: 'Refresh', action: () => setAgain((x) => x + 1) },
    ] }, e.clientX, e.clientY);
  };
  const p = currentProject();
  return (
    <section class="panel docked storage" aria-label="Storage Manager">
      <div class="panel-body">
        <h4 class="sm-head">Project Files <span class="muted small">{p ? p.name : 'Free documents'}</span></h4>
        {!rows.length ? <p class="panel-empty">Open a project or a document: its files, and each one's Local History, show here.</p> : (
          <table class="sm-table" aria-label="Project Files">
            <thead><tr><th>File</th><th>Size</th><th>Kind</th><th>Date Modified</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ref.name} class={`${chosen?.name === r.ref.name ? 'on' : ''}${r.ref.od && r.ref.od === active.value ? ' sm-active' : ''}${dirty(r.ref) ? ' sm-dirty' : ''}`}
                  onClick={() => setSel(r.ref.name)} onDblClick={() => { if (r.ref.od) activeId.value = r.ref.od.id; }}>
                  <td>{r.ref.name}</td><td class="num">{size(r.size)}</td><td>{kindOf(r.ref.name)}</td><td>{when(r.at)}</td><td>{dirty(r.ref) ? 'Modified' : r.ref.od ? 'Open' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {chosen && <>
          <h4 class="sm-head">Local History <span class="muted small">{chosen.name}</span></h4>
          <table class="sm-table sm-time" aria-label="Local History">
            <thead><tr><th>Event</th><th>Date Modified</th><th>Size</th><th>Kept in</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.kind}${i}`} class={pick.includes(i) ? 'on' : ''}
                  onClick={(e) => setPick(e.ctrlKey || e.metaKey ? (pick.includes(i) ? pick.filter((k) => k !== i) : [...pick, i]) : e.shiftKey && pick.length ? range(pick[0]!, i) : [i])}
                  onDblClick={() => void openLine(l)} onContextMenu={(e) => menu(e as unknown as MouseEvent, i)}>
                  <td>{l.title}</td>
                  <td>{l.kind === 'version' ? when(l.v.at) : l.kind === 'auto' ? when(l.c.at) : l.kind === 'saved' ? when(l.at) : chosen.od && isDocDirty(chosen.od) ? 'Modified' : ''}</td>
                  <td class="num">{l.kind === 'version' ? size(l.v.size) : l.kind === 'auto' ? size(l.c.size) : l.kind === 'saved' ? size(l.size) : ''}</td>
                  <td>{l.kind === 'version' ? (l.v.where === 'folder' ? 'History folder' : 'Browser') : l.kind === 'auto' ? 'Browser' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!lines.some((l) => l.kind === 'version') && <p class="muted small">No versions yet: each save keeps the file it replaces (Preferences › Data Management › Local History).</p>}
        </>}
      </div>
    </section>
  );
}
const range = (a: number, b: number) => Array.from({ length: Math.abs(b - a) + 1 }, (_, k) => Math.min(a, b) + k);

/** Purge History: all versions, or those older than so many days; the newest few kept, labelled ones unless included. */
function PurgeDialog({ f }: { f: FileRef }) {
  const [all, setAll] = useState(false);
  const [days, setDays] = useState('7');
  const [keep, setKeep] = useState('1');
  const [labelled, setLabelled] = useState(false);
  const ok = async () => {
    // (an empty box is not a nought: purging cannot be taken back)
    const d = days.trim() === '' ? NaN : Number(days), k = keep.trim() === '' ? NaN : Number(keep);
    if (!all && !(d >= 0)) { notify('Older than: a number of days', 'error'); return; }
    if (!(k >= 0)) { notify('Keep: a number of versions', 'error'); return; }
    closeDialog();
    const n = await purgeHistory(f, { days: all ? undefined : d, keep: Math.floor(k), labelled });
    notify(`${n} version${n === 1 ? '' : 's'} of ${f.name} purged`);
  };
  return (
    <Dialog title="Purge History" width={380} onClose={closeDialog} onAccept={() => { void ok(); return false; }} class="purge-history"
      footer={<><span class="spacer" /><button class="btn default" onClick={() => void ok()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="prompt-body">
        <label class="do-check"><input type="radio" name="purge" checked={all} onChange={() => setAll(true)} />All versions</label>
        <label class="do-check"><input type="radio" name="purge" checked={!all} onChange={() => setAll(false)} />Versions older than <input type="text" aria-label="Days" size={3} value={days} disabled={all} onInput={(e) => setDays((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /> days</label>
        <label>Keep at least <input type="text" aria-label="Keep" size={3} value={keep} onInput={(e) => setKeep((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /> latest versions</label>
        <label class="do-check"><input type="checkbox" checked={labelled} onChange={(e) => setLabelled((e.target as HTMLInputElement).checked)} />Include labelled versions</label>
      </div>
    </Dialog>
  );
}
