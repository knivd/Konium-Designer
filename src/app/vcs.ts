/**
 * Version control in Konium Designer: a project opened from its folder can be put under version
 * control (a Git repository in that folder), kept in Konium's store (a team's, sealed with the
 * team's key) or on the team's own Git server. Here: the teams' keys and Git sign-ins kept in
 * this browser, each project's state (its files' status, what is waiting to be pushed, what the
 * others have pushed), and the work behind Commit, Update, History, Restore and Export, the
 * changed files read again afterwards; who has which file locked. The Git code loads only when a
 * project needs it.
 */
import { signal } from '@preact/signals';
import { settings } from '../core/settings';
import { mayConnect, OFFLINE_NOTE } from '../platform/network';
import { readPrjPcb, docBaseName } from '../formats/altium/prjpcb';
import { resolvePath } from '../model/designWorkspace';
import { activeId, docs, isDocDirty, notify, projects, tick, type OpenDoc, type Project } from './state';
import type { Access, Author, FileState, Lock, Locks, Remote, Repo } from '../vcs/git';

const gitCode = () => import('../vcs/git');

/* ─── Teams and sign-ins (this browser only) ───────────────────────────────────────────── */

export interface Team { id: string; name: string; key: string }
export interface Login { username: string; password: string }
const TEAMS = 'konium.vcsTeams', LOGINS = 'konium.vcsLogins';
const read = <T>(k: string, d: T): T => { try { const v = globalThis.localStorage?.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } vcsTick.value++; };
/** Bumped when teams, sign-ins or a project's state change. */
export const vcsTick = signal(0);

export const teams = (): Team[] => read<Team[]>(TEAMS, []);
/** A team's key kept (a new team, or one joined); the same key twice is kept once. */
export async function keepTeam(name: string, key: string): Promise<Team> {
  const { teamCrypto, readTeamKey } = await import('../vcs/keys');
  const k = readTeamKey(key);
  if (!k) throw new Error('That isn\'t a Konium team key (KON1- and eight groups of four letters and digits)');
  const t: Team = { id: (await teamCrypto(k)).id, name: name.trim() || 'Team', key: k };
  write(TEAMS, [...teams().filter((x) => x.id !== t.id), t]);
  return t;
}
export const forgetTeam = (id: string): void => write(TEAMS, teams().filter((t) => t.id !== id));
export async function newTeam(name: string): Promise<Team> { const { newTeamKey } = await import('../vcs/keys'); return keepTeam(name, newTeamKey()); }

export const logins = (): Record<string, Login> => read<Record<string, Login>>(LOGINS, {});
export function setLogin(host: string, l: Login | null): void {
  const all = logins();
  if (l && l.password) all[host.toLowerCase()] = l; else delete all[host.toLowerCase()];
  write(LOGINS, all);
}
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/** The relay a team's own Git server is reached through (null: straight). */
export function relayUrl(): string | null {
  if (settings.vcsRelay === 'none') return null;
  if (settings.vcsRelay === 'custom') return settings.vcsRelayUrl.trim().replace(/\/$/, '') || null;
  return 'https://konium.app/api/git';
}

/** Who commits: the name and email from Preferences (null until both are set). */
export function author(): Author | null {
  const name = settings.vcsName.trim(), email = settings.vcsEmail.trim();
  return name && email ? { name, email } : null;
}

/** What a remote needs: the team's store opened with its key, or the sign-in and relay. */
export async function accessFor(m: Remote): Promise<Access> {
  if (!mayConnect('vcs')) throw new Error(OFFLINE_NOTE);
  if (m.kind === 'konium') {
    const t = teams().find((x) => x.id === m.team);
    if (!t) throw new Error('This project is kept in a team\'s store whose key isn\'t in this browser: Preferences › Data Management › Version Control › Join a Team');
    const { KoniumStore } = await import('../vcs/store');
    return { store: await KoniumStore.open(t.key) };
  }
  return { auth: logins()[hostOf(m.url)], relay: relayUrl() };
}

/** A remote in words: "Konium's store (Team A)", "github.com/acme/board". */
export function remoteWords(m: Remote | null): string {
  if (!m) return 'none';
  if (m.kind === 'konium') return `Konium's store (${teams().find((t) => t.id === m.team)?.name ?? 'a team whose key isn\'t here'})`;
  return m.url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

/* ─── Each project's state ────────────────────────────────────────────────────────────── */

export interface VcsInfo {
  repo: boolean;
  remote: Remote | null;
  /** Repository path → state, for the files Git sees. */
  status: Map<string, FileState>;
  head: string | null;
  remoteHead: string | null;
  /** Committed here, not yet pushed. */
  unpushed: boolean;
  /** Files the others changed that this hasn't brought in yet (Update). */
  incoming: Set<string>;
  busy: string | null;
  error: string | null;
  checked: number;
  /** Repository path → who is working on it (soft locks: they tell, they don't stop anyone). */
  locks: Locks;
}
export const vcsInfo = signal<Record<string, VcsInfo>>({});
const setInfo = (id: string, patch: Partial<VcsInfo>) => {
  const was = vcsInfo.value[id] ?? { repo: false, remote: null, status: new Map(), head: null, remoteHead: null, unpushed: false, incoming: new Set(), busy: null, error: null, checked: 0, locks: {} };
  vcsInfo.value = { ...vcsInfo.value, [id]: { ...was, ...patch } };
};

const repos = new Map<string, { dir: FileSystemDirectoryHandle; repo: Repo }>();
/** The project's repository (null: its folder has none, or it wasn't opened from a folder). */
export async function repoFor(p: Project, evenIfNone = false): Promise<Repo | null> {
  if (!p.dir) return null;
  let c = repos.get(p.id);
  if (!c || c.dir !== p.dir) { const g = await gitCode(); c = { dir: p.dir, repo: g.repoAt(p.dir) }; repos.set(p.id, c); }
  if (evenIfNone) return c.repo;
  return (await (await gitCode()).isRepo(c.repo)) ? c.repo : null;
}

/** A project document's path in the repository. */
export function repoPath(p: Project, docPath: string): string {
  const at = (p.path ?? p.name).split('/').slice(0, -1).join('/');
  return (resolvePath(at, docPath.replace(/\\/g, '/')) ?? docPath).replace(/^\/+/, '');
}
export const projectFilePath = (p: Project): string => p.path ?? p.name;

const asked = new Set<string>();
/** The project's state worked out once it shows (then after each change). */
export function ensureVcs(p: Project): void {
  if (!p.dir || asked.has(p.id)) return;
  asked.add(p.id);
  void refresh(p, { fetch: true });
}

/** The project's state again: its files' status, and (fetch) what the others have pushed. */
export async function refresh(p: Project, o: { fetch?: boolean } = {}): Promise<void> {
  try {
    const r = await repoFor(p);
    if (!r) { setInfo(p.id, { repo: false, remote: null, status: new Map(), checked: Date.now() }); return; }
    const g = await gitCode();
    const remote = await g.remoteOf(r);
    let error: string | null = null, remoteHead = await g.remoteHeadOf(r), locks: Locks | undefined;
    if (o.fetch && remote && mayConnect('vcs')) {
      try {
        const a = await accessFor(remote);
        remoteHead = await g.fetchRemote(r, remote, a);
        locks = await g.readLocks(r, remote, a);
      } catch (e) { error = (e as Error).message; }
    }
    const [status, head] = await Promise.all([g.statusOf(r), g.headOf(r)]);
    let unpushed = false, incoming = new Set<string>();
    if (remote && head && head !== remoteHead) {
      const theirsAhead = !!remoteHead && !(await g.isAncestor(r, remoteHead, head));
      unpushed = !remoteHead || !(await g.isAncestor(r, head, remoteHead));
      if (theirsAhead && remoteHead) incoming = new Set(await g.changedSince(r, head, remoteHead));
    }
    setInfo(p.id, { repo: true, remote, status, head, remoteHead, unpushed, incoming, error, checked: Date.now(), ...(locks ? { locks } : {}) });
    warnLocked(p);
  } catch (e) { setInfo(p.id, { error: (e as Error).message, checked: Date.now() }); }
}

/* ─── Soft locks ──────────────────────────────────────────────────────────────────────── */

/** A lock taken by this browser's user (by email; else by name). */
export function isMine(l: Lock): boolean {
  const me = author();
  return !!me && (l.email && me.email ? l.email.toLowerCase() === me.email.toLowerCase() : l.by === me.name);
}
/** Who has a document locked, when it isn't me. */
export function lockedByOther(p: Project, path: string): Lock | null {
  const l = vcsInfo.value[p.id]?.locks[repoPath(p, path)];
  return l && !isMine(l) ? l : null;
}
export const lockWords = (l: Lock): string => `${l.by}${l.email ? ` (${l.email})` : ''} since ${new Date(l.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
export const setLocks = (p: Project, locks: Locks): void => setInfo(p.id, { locks });

/** Documents with changes not saved, or saved and not committed, that someone else has locked: told once. */
const warned = new Set<string>();
function warnLocked(p: Project): void {
  const i = vcsInfo.value[p.id];
  if (!i) return;
  for (const d of docs.value) {
    if (d.projectId !== p.id) continue;
    const path = repoPath(p, p.prj.documents.find((x) => docBaseName(x).toLowerCase() === d.name.toLowerCase()) ?? d.name);
    const l = i.locks[path];
    const key = `${p.id}|${path}|${l?.email}|${l?.at}`;
    const changed = isDocDirty(d) || (i.status.get(path) ?? 'unchanged') !== 'unchanged';
    if (!l || isMine(l) || !changed || warned.has(key)) continue;
    warned.add(key);
    notify(`${d.name} is locked by ${lockWords(l)}: they are working on it too, so one of you will have to choose whose to keep`, 'error');
  }
}

/** A saved document: its project's status again (soon, once for several saves). */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
export function touched(p: Project | null | undefined): void {
  if (!p || !vcsInfo.value[p.id]?.repo) return;
  warnLocked(p);
  clearTimeout(pending.get(p.id));
  pending.set(p.id, setTimeout(() => { pending.delete(p.id); void refresh(p); }, 400));
}

/** Every so often (Preferences › Data Management › Version Control), open projects look for the others' changes. */
let timer: ReturnType<typeof setInterval> | null = null;
export function startChecking(): void {
  if (timer || typeof window === 'undefined') return;
  timer = setInterval(() => {
    const mins = settings.vcsCheckMinutes;
    if (!mins || document.hidden || !mayConnect('vcs')) return;
    for (const p of projects.value) {
      const i = vcsInfo.value[p.id];
      if (i?.repo && i.remote && !i.busy && Date.now() - i.checked >= mins * 60_000 - 5_000) void refresh(p, { fetch: true });
    }
  }, 30_000);
}

/* ─── Changed files read again ────────────────────────────────────────────────────────── */

async function fileHandle(dir: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | null> {
  try {
    let d = dir;
    const s = path.split('/');
    for (const x of s.slice(0, -1)) d = await d.getDirectoryHandle(x);
    return await d.getFileHandle(s.at(-1)!);
  } catch { return null; }
}

/** Files the repository changed in the folder: open documents and the project read again. */
export async function reloadFiles(p: Project, paths: string[]): Promise<void> {
  if (!p.dir) return;
  const { openDocument, cmdClose } = await import('./actions');
  const prjPath = projectFilePath(p).toLowerCase();
  let projectChanged = false;
  for (const path of paths) {
    if (path.toLowerCase() === prjPath) { projectChanged = true; continue; }
    const name = path.split('/').pop()!;
    const h = await fileHandle(p.dir, path);
    const od = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
    if (!h) {
      p.files.delete(name.toLowerCase());
      if (od) await cmdClose(od, false);
      continue;
    }
    const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
    const f = { name, bytes, handle: h, path };
    if (p.files.has(name.toLowerCase()) || p.prj.documents.some((d) => docBaseName(d).toLowerCase() === name.toLowerCase())) p.files.set(name.toLowerCase(), f);
    if (od) {
      const front = activeId.value === od.id;
      await cmdClose(od, false);
      openDocument(f, p.id, front);
    }
  }
  if (projectChanged) {
    const h = await fileHandle(p.dir, projectFilePath(p));
    if (h) {
      const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
      p.prj = readPrjPcb(bytes, p.name);
      p.handle = h;
      p.dirty = false;
      // Documents new to the project: read in
      for (const d of p.prj.documents) {
        const name = docBaseName(d);
        if (p.files.has(name.toLowerCase())) continue;
        const path = repoPath(p, d);
        const fh = await fileHandle(p.dir, path);
        if (fh) p.files.set(name.toLowerCase(), { name, bytes: new Uint8Array(await (await fh.getFile()).arrayBuffer()), handle: fh, path });
      }
    }
  }
  projects.value = [...projects.value];
  tick.value++;
}

/** Open documents of the project with changes not saved. */
export const unsavedIn = (p: Project): OpenDoc[] => docs.value.filter((d) => d.projectId === p.id && isDocDirty(d));

/* ─── Busy marker ─────────────────────────────────────────────────────────────────────── */

/** Work on a project's repository, shown as busy while it runs; its error shown, not thrown. */
export async function working<T>(p: Project, what: string, job: () => Promise<T>): Promise<T | undefined> {
  if (vcsInfo.value[p.id]?.busy) { notify(`${p.name}: ${vcsInfo.value[p.id]!.busy} is still running`, 'error'); return undefined; }
  setInfo(p.id, { busy: what, error: null });
  try { return await job(); } catch (e) {
    const m = (e as Error).message;
    setInfo(p.id, { error: m });
    notify(`${what}: ${m}`, 'error');
    return undefined;
  } finally { setInfo(p.id, { busy: null }); }
}
