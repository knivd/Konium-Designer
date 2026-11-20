/**
 * Version control's dialogs: Add Project to Version Control (Konium's store for a team, or the
 * team's own Git server), Commit (the changed files ticked, a message, pushed), the choice for
 * files changed on both sides, files in the way of an update, History (each version: open a
 * document as it was, restore it, export the project as it was), Open Project from Version
 * Control (a team's project or a Git address, into an empty folder) and Repository Settings.
 */
import { canCompare } from '../compare';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { locale } from '../../core/locale';
import { settings, updateSettings } from '../../core/settings';
import { notify, type Project } from '../state';
import { author, keepTeam, logins, newTeam, remoteWords, setLogin, teams, vcsInfo, vcsTick, type Team } from '../vcs';
import type { Choice, Conflict, FileState, Remote, Version } from '../../vcs/git';

const STATE_WORDS: Record<FileState, string> = { modified: 'Modified', added: 'New', deleted: 'Deleted', untracked: 'Not in version control', unchanged: 'No change' };
const when = (t: number) => new Date(t).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/** Name and email for commits, asked for where they aren't set yet. */
function Identity() {
  void vcsTick.value;
  const [name, setName] = useState(settings.vcsName), [email, setEmail] = useState(settings.vcsEmail);
  if (author() && settings.vcsName === name && settings.vcsEmail === email) return null;
  const save = () => { updateSettings({ vcsName: name.trim(), vcsEmail: email.trim() }); vcsTick.value++; };
  return (
    <fieldset class="vcd-ident"><legend>Your name in the history</legend>
      <label>Name<input aria-label="Your name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onChange={save} /></label>
      <label>Email<input aria-label="Your email" type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} onChange={save} /></label>
    </fieldset>
  );
}

/** A team chosen from those kept here, or a new one made, or one joined with its key. */
export function TeamPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  void vcsTick.value;
  const list = teams();
  const [mode, setMode] = useState<'pick' | 'new' | 'join'>(list.length ? 'pick' : 'new');
  const [name, setName] = useState(''), [key, setKey] = useState(''), [err, setErr] = useState('');
  useEffect(() => { if (!value && list[0]) onChange(list[0].id); }, [list.length]);
  const done = (t: Team) => { onChange(t.id); setMode('pick'); setName(''); setKey(''); setErr(''); };
  return (
    <div class="vcd-team">
      {mode === 'pick' && <div class="vcd-row">
        <select aria-label="Team" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>{list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <button class="btn" onClick={() => setMode('new')}>New Team…</button><button class="btn" onClick={() => setMode('join')}>Join a Team…</button>
      </div>}
      {mode === 'new' && <div class="vcd-row">
        <input aria-label="New team's name" placeholder="The team's name (only you see it)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="btn" onClick={() => void newTeam(name || 'My team').then(done)}>Make the Team</button>
        {list.length > 0 && <button class="btn" onClick={() => setMode('pick')}>Cancel</button>}
      </div>}
      {mode === 'join' && <div class="vcd-row">
        <input aria-label="Team key" placeholder="KON1-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
        <input aria-label="Joined team's name" placeholder="Its name (only you see it)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="btn" onClick={() => void keepTeam(name || 'Team', key).then(done).catch((e) => setErr((e as Error).message))}>Join</button>
        <button class="btn" onClick={() => setMode('pick')}>Cancel</button>
      </div>}
      {err && <p class="small ai-error">{err}</p>}
      {mode === 'new' && <p class="small muted">A new team gets a key: send it to your colleagues (Preferences › Data Management › Version Control › Copy Key) and they join with it. Whoever has the key can open the team's projects; konium.app never has it.</p>}
    </div>
  );
}

/** A Git server's sign-in for an address, kept in this browser. */
function GitLogin({ url }: { url: string }) {
  void vcsTick.value;
  const host = hostOf(url);
  const have = host ? logins()[host] : undefined;
  const [user, setUser] = useState(have?.username ?? ''), [tok, setTok] = useState('');
  if (!host) return null;
  return (
    <div class="vcd-row">
      <input aria-label="User name" placeholder="User name" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} />
      <input aria-label="Access token" type="password" placeholder={have ? 'Access token (kept)' : 'Password or access token'} value={tok} onInput={(e) => setTok((e.target as HTMLInputElement).value)} />
      <button class="btn" disabled={!user || !tok} onClick={() => { setLogin(host, { username: user, password: tok }); setTok(''); }}>Keep for {host}</button>
    </div>
  );
}

export function AddToVcDialog({ p, onAdd }: { p: Project; onAdd: (m: { team?: string; url?: string }) => void }) {
  void vcsTick.value;
  const [where, setWhere] = useState<'konium' | 'git'>('konium');
  const [team, setTeam] = useState(''), [url, setUrl] = useState('');
  const ok = !!author() && (where === 'konium' ? !!team : /^https:\/\/\S+$/i.test(url.trim()));
  return (
    <Dialog title="Add Project to Version Control" width={600} onClose={closeDialog}
      footer={<><button class="btn default" disabled={!ok} onClick={() => { closeDialog(); onAdd(where === 'konium' ? { team } : { url: url.trim() }); }}>Add and Push</button><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="vcd-dlg">
        <p>{p.name} and the files in its folder ({p.folder ?? p.dir?.name}) go into a Git repository there, every version kept on this computer, and are pushed where the team keeps them. History, previews and outputs are left out.</p>
        <Identity />
        <fieldset><legend>Where the team keeps it</legend>
          <label><input type="radio" name="vc-where" checked={where === 'konium'} onChange={() => setWhere('konium')} />Konium's store: nothing to set up; sealed with the team's key, which konium.app never has</label>
          {where === 'konium' && <TeamPicker value={team} onChange={setTeam} />}
          <label><input type="radio" name="vc-where" checked={where === 'git'} onChange={() => setWhere('git')} />Your own Git server (GitHub, GitLab, Bitbucket, Gitea …): an empty repository</label>
          {where === 'git' && <>
            <input aria-label="Repository address" placeholder="https://github.com/team/board.git" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
            <GitLogin url={url} />
          </>}
        </fieldset>
      </div>
    </Dialog>
  );
}

export interface CommitRow { path: string; state: FileState; inProject: boolean }
export function CommitDialog({ p, rows, unsaved, canPush, mine, onCommit, onSaveAll }: { p: Project; rows: CommitRow[]; unsaved: string[]; canPush: boolean; mine: number; onCommit: (paths: string[], message: string, push: boolean, unlock: boolean) => void; onSaveAll: () => void }) {
  const [ticked, setTicked] = useState(() => new Set(rows.filter((r) => r.state !== 'untracked' || r.inProject).map((r) => r.path)));
  const [msg, setMsg] = useState('');
  const [unlock, setUnlock] = useState(true);
  const go = (push: boolean) => { closeDialog(); onCommit([...ticked], msg, push, unlock); };
  const ok = ticked.size > 0 && msg.trim().length > 0 && !!author();
  return (
    <Dialog title={`Commit: ${p.name}`} width={640} onClose={closeDialog}
      footer={<>{canPush && <button class="btn default" disabled={!ok} onClick={() => go(true)}>Commit and Push</button>}<button class={`btn${canPush ? '' : ' default'}`} disabled={!ok} onClick={() => go(false)}>Commit{canPush ? ' Only' : ''}</button><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="vcd-dlg">
        <Identity />
        {unsaved.length > 0 && <p class="small ai-error">Not saved yet (commit takes the files as saved): {unsaved.join(', ')} <button class="btn" onClick={onSaveAll}>Save All</button></p>}
        {!rows.length ? <p>Nothing has changed since the last commit.</p> : (
          <div class="vcd-files">
            <table class="sd-table" aria-label="Changed files">
              <thead><tr><th><input type="checkbox" aria-label="Tick all" checked={ticked.size === rows.length} onChange={() => setTicked(ticked.size === rows.length ? new Set() : new Set(rows.map((r) => r.path)))} /></th><th>File</th><th>Change</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.path}><td><input type="checkbox" aria-label={`Commit ${r.path}`} checked={ticked.has(r.path)} onChange={() => { const t = new Set(ticked); if (t.has(r.path)) t.delete(r.path); else t.add(r.path); setTicked(t); }} /></td>
                  <td>{r.path}</td><td class={`vcd-st vcd-${r.state}`}>{STATE_WORDS[r.state]}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <label class="rq-field">What changed<textarea aria-label="Commit message" rows={3} placeholder="e.g. Moved the regulator, widened the 3V3 tracks" value={msg} onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)} /></label>
        {canPush && mine > 0 && <label class="vcd-check"><input type="checkbox" checked={unlock} onChange={() => setUnlock(!unlock)} /> Unlock my locked files once pushed ({mine})</label>}
      </div>
    </Dialog>
  );
}

/** Files changed on both sides: keep mine, keep theirs, or both (theirs beside mine). */
export function ConflictDialog({ conflicts, onDone }: { conflicts: Conflict[]; onDone: (m: Map<string, Choice> | null) => void }) {
  const [pick, setPick] = useState(() => new Map(conflicts.map((c) => [c.path, 'mine' as Choice])));
  const close = (m: Map<string, Choice> | null) => { closeDialog(); onDone(m); };
  const all = (c: Choice) => setPick(new Map(conflicts.map((x) => [x.path, c])));
  return (
    <Dialog title="Changed on Both Sides" width={640} onClose={() => close(null)}
      footer={<><button class="btn default" onClick={() => close(pick)}>Update</button><span class="spacer" /><button class="btn" onClick={() => close(null)}>Cancel</button></>}>
      <div class="vcd-dlg">
        <p>These were changed here and by someone else since you last updated. Design files can't be merged inside: keep one, or both (theirs saved beside yours, to compare).</p>
        <div class="vcd-row"><span class="muted small">All:</span><button class="btn" onClick={() => all('mine')}>Mine</button><button class="btn" onClick={() => all('theirs')}>Theirs</button><button class="btn" onClick={() => all('both')}>Both</button></div>
        <table class="sd-table" aria-label="Files changed on both sides">
          <thead><tr><th>File</th><th>Theirs by</th><th>Keep</th></tr></thead>
          <tbody>{conflicts.map((c) => (
            <tr key={c.path}><td>{c.path}</td><td>{c.by}</td><td>
              <select aria-label={`Keep for ${c.path}`} value={pick.get(c.path)} onChange={(e) => setPick(new Map(pick).set(c.path, (e.target as HTMLSelectElement).value as Choice))}>
                <option value="mine">Mine</option><option value="theirs">Theirs{c.theirs ? '' : ' (deleted)'}</option><option value="both" disabled={!c.theirs}>Both (theirs beside mine)</option>
              </select></td></tr>
          ))}</tbody>
        </table>
      </div>
    </Dialog>
  );
}

/** Files changed here (not committed) that an update would overwrite. */
export function BlockedDialog({ files, onCommit, onDiscard }: { files: string[]; onCommit: () => void; onDiscard: () => void }) {
  return (
    <Dialog title="Update" width={520} onClose={closeDialog}
      footer={<><button class="btn default" onClick={() => { closeDialog(); onCommit(); }}>Commit…</button><button class="btn" onClick={() => { closeDialog(); onDiscard(); }}>Put Them Back</button><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="vcd-dlg">
        <p>Changed here but not committed, and changed by someone else too:</p>
        <ul>{files.map((f) => <li key={f}>{f}</li>)}</ul>
        <p class="small muted">Commit them first (then the update asks which to keep), or put them back as they were last committed (your changes to them are lost).</p>
      </div>
    </Dialog>
  );
}

export interface HistoryActions {
  open?: (v: Version) => void;
  compare?: (v: Version) => void;
  /** A changed schematic or board of the version, beside it as it is now. */
  compareFile?: (v: Version, path: string) => void;
  restore: (v: Version) => void;
  exportZip: (v: Version) => void;
  changes: (v: Version) => Promise<string[]>;
}
export function HistoryDialog({ title, list, doc, act }: { title: string; list: Version[]; doc?: string; act: HistoryActions }) {
  const [sel, setSel] = useState<number>(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const v = list[sel];
  // (an answer that comes after another version was chosen is that version's, not this one's: dropped)
  useEffect(() => { let on = true; setFiles(null); if (v) void act.changes(v).then((f) => { if (on) setFiles(f); }).catch(() => { if (on) setFiles([]); }); return () => { on = false; }; }, [v?.oid]);
  return (
    <Dialog title={title} width={760} height={540} onClose={closeDialog}
      footer={<>
        {doc && act.open && <button class="btn" disabled={!v} onClick={() => v && act.open!(v)}>Open This Version</button>}
        {act.compare && <button class="btn" disabled={!v} onClick={() => v && act.compare!(v)}>Compare with Current</button>}
        <button class="btn" disabled={!v || sel === 0} onClick={() => v && act.restore(v)}>{doc ? 'Restore This Version' : 'Restore the Project to This Version'}</button>
        <button class="btn" disabled={!v} onClick={() => v && act.exportZip(v)}>{doc ? 'Save This Version As…' : 'Export This Version…'}</button>
        <span class="spacer" /><button class="btn" onClick={closeDialog}>Close</button></>}>
      <div class="vcd-history">
        {!list.length ? <p class="muted">No versions yet: commit first.</p> : (
          <div class="vcd-hist-list">
            <table class="sd-table" aria-label="Versions">
              <thead><tr><th>Version</th><th>When</th><th>Who</th><th>What changed</th></tr></thead>
              <tbody>{list.map((x, i) => (
                <tr key={x.oid} class={i === sel ? 'sel' : ''} onClick={() => setSel(i)} aria-selected={i === sel}>
                  <td class="vcd-oid">{x.oid.slice(0, 7)}{i === 0 ? <span class="muted"> (latest)</span> : null}</td><td class="vcd-nowrap">{when(x.at)}</td><td class="vcd-nowrap" title={x.email}>{x.author}</td><td>{x.message.split('\n')[0]}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {v && <div class="vcd-hist-files"><b>Files in this version's change</b>{files === null ? <p class="muted small">…</p> : files.length ? <ul>{files.map((f) => <li key={f}>{f}{!doc && act.compareFile && canCompare(f) && <button class="linkish vcd-cmp" title={`${f} in this version beside it as it is now`} onClick={() => act.compareFile!(v, f)}>Compare</button>}</li>)}</ul> : <p class="muted small">None</p>}</div>}
      </div>
    </Dialog>
  );
}

export function CloneDialog({ onClone, list }: { onClone: (m: { team?: string; project?: string; url?: string }) => void; list: (team: string) => Promise<{ id: string; name: string }[]> }) {
  void vcsTick.value;
  const [where, setWhere] = useState<'konium' | 'git'>('konium');
  const [team, setTeam] = useState(''), [project, setProject] = useState(''), [url, setUrl] = useState('');
  const [items, setItems] = useState<{ id: string; name: string }[] | null>(null), [err, setErr] = useState('');
  useEffect(() => { setItems(null); setErr(''); if (where === 'konium' && team) void list(team).then((x) => { setItems(x); setProject(x[0]?.id ?? ''); }).catch((e) => setErr((e as Error).message)); }, [where, team]);
  const ok = !!author() && (where === 'konium' ? !!project : /^https:\/\/\S+$/i.test(url.trim()));
  return (
    <Dialog title="Open Project from Version Control" width={600} onClose={closeDialog}
      footer={<><button class="btn default" disabled={!ok} onClick={() => { closeDialog(); onClone(where === 'konium' ? { team, project } : { url: url.trim() }); }}>Choose an Empty Folder…</button><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="vcd-dlg">
        <Identity />
        <fieldset><legend>From</legend>
          <label><input type="radio" name="vc-from" checked={where === 'konium'} onChange={() => setWhere('konium')} />A team's project in Konium's store</label>
          {where === 'konium' && <>
            <TeamPicker value={team} onChange={setTeam} />
            {err && <p class="small ai-error">{err}</p>}
            {items && (items.length ? <select aria-label="Project" size={Math.min(8, Math.max(3, items.length))} value={project} onChange={(e) => setProject((e.target as HTMLSelectElement).value)}>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : <p class="small muted">The team has no projects yet.</p>)}
          </>}
          <label><input type="radio" name="vc-from" checked={where === 'git'} onChange={() => setWhere('git')} />A Git server</label>
          {where === 'git' && <><input aria-label="Repository address" placeholder="https://github.com/team/board.git" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /><GitLogin url={url} /></>}
        </fieldset>
        <p class="small muted">Its files and every version go into the folder you choose next (an empty one), and the project opens from there.</p>
      </div>
    </Dialog>
  );
}

export function RepoSettingsDialog({ p, onMove }: { p: Project; onMove: (m: { team?: string; url?: string }) => void }) {
  void vcsTick.value;
  const info = vcsInfo.value[p.id];
  const remote: Remote | null = info?.remote ?? null;
  const [moving, setMoving] = useState(false), [where, setWhere] = useState<'konium' | 'git'>('git');
  const [team, setTeam] = useState(''), [url, setUrl] = useState('');
  const team0 = useMemo(() => (remote?.kind === 'konium' ? teams().find((t) => t.id === remote.team) : undefined), [remote]);
  return (
    <Dialog title={`Repository Settings: ${p.name}`} width={600} onClose={closeDialog}
      footer={<>{moving && <button class="btn default" disabled={where === 'konium' ? !team : !/^https:\/\/\S+$/i.test(url.trim())} onClick={() => { closeDialog(); onMove(where === 'konium' ? { team } : { url: url.trim() }); }}>Move and Push Everything</button>}<span class="spacer" /><button class="btn" onClick={closeDialog}>Close</button></>}>
      <div class="vcd-dlg">
        <table class="vcd-facts"><tbody>
          <tr><th>Kept</th><td>{remoteWords(remote)}</td></tr>
          {remote?.kind === 'konium' && <tr><th>Team key</th><td>{team0 ? <button class="btn" onClick={() => { void navigator.clipboard?.writeText(team0.key); notify('Team key copied: send it only to people who should have the team\'s projects'); }}>Copy Key</button> : 'not in this browser'}</td></tr>}
          <tr><th>Folder</th><td>{p.folder ?? p.dir?.name}</td></tr>
          <tr><th>Latest version</th><td>{info?.head?.slice(0, 7) ?? 'none'}{info?.unpushed ? ' (not pushed yet)' : ''}</td></tr>
        </tbody></table>
        {!moving ? <button class="btn" onClick={() => setMoving(true)}>Move to Another Place…</button> : (
          <fieldset><legend>Move to</legend>
            <label><input type="radio" name="vc-move" checked={where === 'git'} onChange={() => setWhere('git')} />Your own Git server: an empty repository</label>
            {where === 'git' && <><input aria-label="Repository address" placeholder="https://github.com/team/board.git" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} /><GitLogin url={url} /></>}
            <label><input type="radio" name="vc-move" checked={where === 'konium'} onChange={() => setWhere('konium')} />Konium's store, a team's</label>
            {where === 'konium' && <TeamPicker value={team} onChange={setTeam} />}
            <p class="small muted">Every version goes with it. The team's colleagues open it from the new place (Open Project from Version Control).</p>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

export { showDialog };
