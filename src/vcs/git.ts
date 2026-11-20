/**
 * Version control on a project folder: a real Git repository (.git in the folder), so every
 * version is on the computer and the folder works with any Git tool. Its remote is either
 * Konium's store (konium://<team>/<project>: packs and the branch head, sealed with the team's
 * key) or the team's own Git server (https://…, through the relay when the server doesn't allow
 * pages to reach it).
 *
 * Update brings the remote's commits in: a fast-forward when only they moved on, else a merge of
 * the two, file by file (design files can't be merged inside): a file changed on one side only
 * takes that side, one changed on both is the designer's choice (keep mine, keep theirs, keep
 * both: theirs beside mine as "Name (theirs abc1234).Ext"). Files changed but not committed that
 * the update would overwrite stop it until they are committed or put back.
 */
import { Buffer } from 'buffer';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { folderFs, type FolderFs } from './fsa';
import { KoniumStore, StoreConflict, type StoreRefs, type TeamIndex } from './store';
import { zipDeflated } from '../formats/zip';

// isomorphic-git reads packs with Node's Buffer
const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;

export interface Repo { fs: FolderFs; dir: string; cache: object }
export interface Author { name: string; email: string }

/** The repository in a folder (it may not have one yet). */
export const repoAt = (root: FileSystemDirectoryHandle): Repo => ({ fs: folderFs(root), dir: '/', cache: {} });
const base = (r: Repo) => ({ fs: r.fs, dir: r.dir, cache: r.cache });

/** What a new repository leaves out: Local History, previews, outputs and logs, AD's temporary files. */
export const IGNORE = ['History/', '__Previews/', 'Project Outputs*/', 'Project Logs*/', '*.~*', '*.PrjPcbStructure', '*.SchDocPreview', '*.PcbDocPreview', '*.tmp', ''].join('\n');

export type Remote = { kind: 'konium'; team: string; repo: string } | { kind: 'git'; url: string };
export interface Access {
  /** Konium's store, opened with the team's key (for a konium:// remote). */
  store?: KoniumStore;
  /** For a Git server: user name and password or access token, and the relay (null: none). */
  auth?: { username: string; password: string };
  relay?: string | null;
}

export const remoteUrl = (m: Remote): string => (m.kind === 'konium' ? `konium://${m.team}/${m.repo}` : m.url);
export function parseRemote(url: string | undefined | null): Remote | null {
  if (!url) return null;
  const k = /^konium:\/\/([0-9a-f]{6,32})\/([0-9a-z]{4,32})$/.exec(url);
  if (k) return { kind: 'konium', team: k[1]!, repo: k[2]! };
  return /^https?:\/\//i.test(url) ? { kind: 'git', url } : null;
}

export async function isRepo(r: Repo): Promise<boolean> {
  try { await r.fs.promises.stat(`${r.dir}.git/HEAD`); return true; } catch { return false; }
}
export async function remoteOf(r: Repo): Promise<Remote | null> {
  return parseRemote(await git.getConfig({ ...base(r), path: 'remote.origin.url' }).catch(() => null) as string | null);
}
export async function branchOf(r: Repo): Promise<string> { return (await git.currentBranch({ ...base(r) }).catch(() => null)) ?? 'main'; }
export async function headOf(r: Repo): Promise<string | null> { return git.resolveRef({ ...base(r), ref: await branchOf(r) }).catch(() => null); }
export async function remoteHeadOf(r: Repo): Promise<string | null> { return git.resolveRef({ ...base(r), ref: `refs/remotes/origin/${await branchOf(r)}` }).catch(() => null); }

/* ─── Working folder ──────────────────────────────────────────────────────────────────── */

async function writeWork(r: Repo, path: string, data: Uint8Array): Promise<void> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    try { await r.fs.promises.mkdir(`${r.dir}${parts.slice(0, i).join('/')}`); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
  }
  await r.fs.promises.writeFile(`${r.dir}${path}`, data);
}
async function removeWork(r: Repo, path: string): Promise<void> { await r.fs.promises.unlink(`${r.dir}${path}`).catch(() => undefined); }
export async function readWork(r: Repo, path: string): Promise<Uint8Array | null> {
  try { return (await r.fs.promises.readFile(`${r.dir}${path}`)) as Uint8Array; } catch { return null; }
}

/* ─── Status and commits ──────────────────────────────────────────────────────────────── */

export type FileState = 'unchanged' | 'modified' | 'added' | 'deleted' | 'untracked';

/** Each file's state against the last commit (ignored files left out). */
export async function statusOf(r: Repo): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>();
  for (const [path, head, work, stage] of await git.statusMatrix({ ...base(r) })) {
    const s: FileState = head === 0 ? (stage === 0 ? 'untracked' : 'added') : work === 0 ? 'deleted' : work === 1 && stage === 1 ? 'unchanged' : 'modified';
    out.set(path, s);
  }
  return out;
}

/** Changed (committable) files: not unchanged. */
export const changedOf = (s: Map<string, FileState>): string[] => [...s].filter(([, v]) => v !== 'unchanged').map(([k]) => k);

/** Put files in a repository the folder doesn't have yet, with what it leaves out, and commit them. */
export async function createRepo(r: Repo, author: Author, remote: Remote | null, message = 'Added to version control'): Promise<string> {
  await git.init({ ...base(r), defaultBranch: 'main' });
  if (!(await readWork(r, '.gitignore'))) await writeWork(r, '.gitignore', new TextEncoder().encode(IGNORE));
  await setIdentity(r, author);
  if (remote) await git.setConfig({ ...base(r), path: 'remote.origin.url', value: remoteUrl(remote) });
  const files = [...(await statusOf(r)).keys()];
  return commitFiles(r, files, message, author);
}

export async function setIdentity(r: Repo, a: Author): Promise<void> {
  await git.setConfig({ ...base(r), path: 'user.name', value: a.name });
  await git.setConfig({ ...base(r), path: 'user.email', value: a.email });
}
export async function setRemote(r: Repo, m: Remote | null): Promise<void> {
  // What was known of the old remote goes (a new one starts from nothing)
  const branch = await branchOf(r);
  await git.deleteRef({ ...base(r), ref: `refs/remotes/origin/${branch}` }).catch(() => undefined);
  await git.setConfig({ ...base(r), path: 'remote.origin.url', value: m ? remoteUrl(m) : undefined });
  if (m?.kind === 'git') await git.setConfig({ ...base(r), path: 'remote.origin.fetch', value: '+refs/heads/*:refs/remotes/origin/*' });
}

/** Commit these files as they are in the folder (a deleted one leaves the repository). */
export async function commitFiles(r: Repo, paths: string[], message: string, author: Author): Promise<string> {
  const s = await statusOf(r);
  for (const p of paths) {
    if (s.get(p) === 'deleted') await git.remove({ ...base(r), filepath: p });
    else await git.add({ ...base(r), filepath: p });
  }
  return git.commit({ ...base(r), message: message.trim() || 'Changes', author });
}

/** Files put back as they were last committed (their changes dropped). */
export async function discard(r: Repo, paths: string[]): Promise<void> {
  const head = await headOf(r);
  const t = head ? await flatTree(r, head) : new Map<string, TreeFile>();
  for (const p of paths) {
    const e = t.get(p);
    if (e) { await writeWork(r, p, (await git.readBlob({ ...base(r), oid: e.oid })).blob); await git.resetIndex({ ...base(r), filepath: p }).catch(() => undefined); }
    else { await removeWork(r, p); await git.remove({ ...base(r), filepath: p }).catch(() => undefined); }
  }
}

/* ─── Trees ───────────────────────────────────────────────────────────────────────────── */

export interface TreeFile { oid: string; mode: string }

/** A commit's files: path → blob. */
export async function flatTree(r: Repo, commit: string): Promise<Map<string, TreeFile>> {
  const out = new Map<string, TreeFile>();
  const { commit: c } = await git.readCommit({ ...base(r), oid: commit });
  const walk = async (oid: string, prefix: string) => {
    for (const e of (await git.readTree({ ...base(r), oid })).tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else if (e.type === 'blob') out.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  await walk(c.tree, '');
  return out;
}

/** The files that differ between two commits (either may be null: nothing). */
export async function changedBetween(r: Repo, a: string | null, b: string | null): Promise<string[]> {
  const A = a ? await flatTree(r, a) : new Map<string, TreeFile>(), B = b ? await flatTree(r, b) : new Map<string, TreeFile>();
  return [...new Set([...A.keys(), ...B.keys()])].filter((p) => A.get(p)?.oid !== B.get(p)?.oid).sort();
}

async function writeTreeOf(r: Repo, files: Map<string, TreeFile>): Promise<string> {
  const build = async (prefix: string): Promise<string> => {
    const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    const subs = new Set<string>();
    for (const [p, f] of files) {
      if (prefix && !p.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? p.slice(prefix.length + 1) : p;
      const i = rest.indexOf('/');
      if (i < 0) entries.push({ mode: f.mode, path: rest, oid: f.oid, type: 'blob' });
      else subs.add(rest.slice(0, i));
    }
    for (const s of subs) entries.push({ mode: '040000', path: s, oid: await build(prefix ? `${prefix}/${s}` : s), type: 'tree' });
    return git.writeTree({ ...base(r), tree: entries });
  };
  return build('');
}

/** Every object a commit needs that another (and what it needs) doesn't have. */
async function objectsBetween(r: Repo, from: string, stopAt: string | null): Promise<string[]> {
  const collect = async (start: string, into: Set<string>, stop: Set<string>) => {
    const stack = [start];
    const tree = async (oid: string) => {
      if (into.has(oid) || stop.has(oid)) return;
      into.add(oid);
      for (const e of (await git.readTree({ ...base(r), oid })).tree) {
        if (e.type === 'tree') await tree(e.oid);
        else if (e.type === 'blob' && !stop.has(e.oid)) into.add(e.oid);
      }
    };
    while (stack.length) {
      const c = stack.pop()!;
      if (into.has(c) || stop.has(c)) continue;
      into.add(c);
      const { commit } = await git.readCommit({ ...base(r), oid: c });
      await tree(commit.tree);
      stack.push(...commit.parent);
    }
  };
  const stop = new Set<string>();
  if (stopAt) await collect(stopAt, stop, new Set());
  const out = new Set<string>();
  await collect(from, out, stop);
  return [...out];
}

/** Whether a commit is the other or comes before it. */
export async function isAncestor(r: Repo, ancestor: string, oid: string): Promise<boolean> {
  return ancestor === oid || git.isDescendent({ ...base(r), oid, ancestor, depth: -1 }).catch(() => false);
}

/** The files the other side changed since the two parted. */
export async function changedSince(r: Repo, ours: string, theirs: string): Promise<string[]> {
  const [mb] = await git.findMergeBase({ ...base(r), oids: [ours, theirs] }).catch(() => [] as string[]);
  return changedBetween(r, mb ?? null, theirs);
}

/* ─── Remotes ─────────────────────────────────────────────────────────────────────────── */

const PACKS = '.git/konium-packs';
const refsName = (m: { repo: string }) => `r/${m.repo}/refs`;
async function packsHad(r: Repo): Promise<Set<string>> {
  const t = (await readWork(r, PACKS)) ?? new Uint8Array();
  return new Set(new TextDecoder().decode(t).split('\n').filter(Boolean));
}
async function packsAdd(r: Repo, ids: string[]): Promise<void> {
  const had = await packsHad(r);
  for (const i of ids) had.add(i);
  await writeWork(r, PACKS, new TextEncoder().encode(`${[...had].join('\n')}\n`));
}

function needStore(a: Access): KoniumStore {
  if (!a.store) throw new Error('This project is in Konium\'s store: its team key isn\'t in this browser (Preferences › Data Management › Version Control › Teams)');
  return a.store;
}
const httpOpts = (r: Repo, m: { url: string }, a: Access) => ({
  ...base(r), http, url: m.url, corsProxy: a.relay ?? undefined, remote: 'origin',
  onAuth: () => (a.auth ? { username: a.auth.username, password: a.auth.password } : { cancel: true }),
});

/** The remote's commits fetched (not yet in the working folder); its head, or null when it has none. */
export async function fetchRemote(r: Repo, m: Remote, a: Access): Promise<string | null> {
  const branch = await branchOf(r);
  if (m.kind === 'konium') {
    const store = needStore(a);
    const refs = await store.getJson<StoreRefs>(refsName(m));
    if (!refs?.value.head) return null;
    const had = await packsHad(r);
    const got: string[] = [];
    for (const id of refs.value.packs) {
      if (had.has(id)) continue;
      const b = await store.get(`r/${m.repo}/p/${id}`);
      if (!b) throw new Error(`A part of the project is missing from Konium's store (${id.slice(0, 8)})`);
      const path = `.git/objects/pack/pack-${id}.pack`;
      await writeWork(r, path, b.data);
      await git.indexPack({ ...base(r), filepath: path });
      got.push(id);
    }
    if (got.length) await packsAdd(r, got);
    await git.writeRef({ ...base(r), ref: `refs/remotes/origin/${branch}`, value: refs.value.head, force: true });
    return refs.value.head;
  }
  try {
    await git.fetch({ ...httpOpts(r, m, a), ref: branch, singleBranch: true, tags: false });
  } catch (e) {
    // A new, empty repository on the server: nothing to fetch yet
    if (/could not find|NotFoundError|empty/i.test(String((e as Error).message)) || (e as { code?: string }).code === 'NotFoundError') return null;
    throw explain(e);
  }
  return remoteHeadOf(r);
}

export type PushResult = 'pushed' | 'up-to-date' | 'behind';

/** This branch sent to the remote; 'behind' when the remote has commits this hasn't (update first). */
export async function pushRemote(r: Repo, m: Remote, a: Access, projectName?: string): Promise<PushResult> {
  const local = await headOf(r);
  if (!local) return 'up-to-date';
  const branch = await branchOf(r);
  if (m.kind === 'konium') {
    const store = needStore(a);
    const cur = await store.getJson<StoreRefs>(refsName(m));
    const theirs = cur?.value.head ?? null;
    if (theirs === local) return 'up-to-date';
    if (theirs && !(await git.isDescendent({ ...base(r), oid: local, ancestor: theirs, depth: -1 }).catch(() => false))) return 'behind';
    const oids = await objectsBetween(r, local, theirs);
    const { filename, packfile } = await git.packObjects({ ...base(r), oids, write: false });
    const id = /pack-([0-9a-f]+)\.pack/.exec(filename ?? '')?.[1] ?? [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, '0')).join('');
    try { await store.put(`r/${m.repo}/p/${id}`, packfile as Uint8Array, null); } catch (e) { if (!(e instanceof StoreConflict)) throw e; }
    try { await store.putJson(refsName(m), { head: local, packs: [...(cur?.value.packs ?? []), id] } satisfies StoreRefs, cur ? cur.tag : null); } catch (e) {
      if (e instanceof StoreConflict) return 'behind';
      throw e;
    }
    await packsAdd(r, [id]);
    await git.writeRef({ ...base(r), ref: `refs/remotes/origin/${branch}`, value: local, force: true });
    if (!cur && projectName) await addToIndex(store, m.repo, projectName);
    return 'pushed';
  }
  if ((await remoteHeadOf(r)) === local) return 'up-to-date';
  try {
    const res = await git.push({ ...httpOpts(r, m, a), ref: branch, remoteRef: branch });
    if (!res.ok) return 'behind';
  } catch (e) {
    if ((e as { code?: string }).code === 'PushRejectedError') return 'behind';
    throw explain(e);
  }
  await git.writeRef({ ...base(r), ref: `refs/remotes/origin/${branch}`, value: local, force: true });
  return 'pushed';
}

/** The team's projects (from Konium's store). */
export async function teamProjects(store: KoniumStore): Promise<TeamIndex> {
  return (await store.getJson<TeamIndex>('index'))?.value ?? { projects: [] };
}
async function addToIndex(store: KoniumStore, id: string, name: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const cur = await store.getJson<TeamIndex>('index');
    const v: TeamIndex = cur?.value ?? { projects: [] };
    if (v.projects.some((p) => p.id === id)) return;
    v.projects.push({ id, name, at: Date.now() });
    try { await store.putJson('index', v, cur ? cur.tag : null); return; } catch (e) { if (!(e instanceof StoreConflict)) throw e; }
  }
}

/** A Git server's refusal in words. */
function explain(e: unknown): Error {
  const err = e as { code?: string; data?: { statusCode?: number; response?: string }; message?: string };
  const status = err.data?.statusCode;
  if (status === 401 || status === 403 || err.code === 'UserCanceledError') return new Error('The Git server refused the sign-in: check the user name and access token (Preferences › Data Management › Version Control)');
  if (status === 404) return new Error('The Git server has no repository at that address (or the access token can\'t see it)');
  if (err.code === 'HttpError' || /Failed to fetch|NetworkError|CORS/i.test(err.message ?? '')) return new Error(`The Git server can't be reached from this page${status ? ` (${status})` : ''}: check the address, the connection, and the relay setting (Preferences › Data Management › Version Control)`);
  return e instanceof Error ? e : new Error(String(e));
}

/** A project from a remote put in an empty folder (the files checked out). */
export async function cloneInto(r: Repo, m: Remote, a: Access, author: Author): Promise<string | null> {
  if (m.kind === 'git') {
    try {
      await git.clone({ ...httpOpts(r, m, a), singleBranch: true, noTags: true });
    } catch (e) {
      // An empty repository: start one that pushes there
      if (/could not find|empty/i.test(String((e as Error).message))) { await git.init({ ...base(r), defaultBranch: 'main' }); await setRemote(r, m); await setIdentity(r, author); return null; }
      throw explain(e);
    }
    await setIdentity(r, author);
    return headOf(r);
  }
  await git.init({ ...base(r), defaultBranch: 'main' });
  await setRemote(r, m);
  await setIdentity(r, author);
  const head = await fetchRemote(r, m, a);
  if (!head) return null;
  await git.writeRef({ ...base(r), ref: 'refs/heads/main', value: head, force: true });
  await git.checkout({ ...base(r), ref: 'main', force: true });
  return head;
}

/* ─── Update ──────────────────────────────────────────────────────────────────────────── */

export type Choice = 'mine' | 'theirs' | 'both';
export interface Conflict { path: string; mine: string | null; theirs: string | null; by: string }
export interface UpdateResult {
  /** Files the update changed in the folder (to read again). */
  changed: string[];
  /** Theirs kept beside mine (Keep both). */
  extra: string[];
  /** Nothing to bring in. */
  upToDate?: boolean;
  /** Changed here but not committed, and changed in the remote: commit or put them back first. */
  blocked?: string[];
  /** Cancelled at the choice. */
  cancelled?: boolean;
  merged?: boolean;
}

const short = (oid: string) => oid.slice(0, 7);
const beside = (path: string, tag: string) => { const m = /^(.*?)(\.[^./]+)?$/.exec(path)!; return `${m[1]} (theirs ${tag})${m[2] ?? ''}`; };

/** Files in the folder set to a commit's (written, or deleted), and the index with them. */
async function syncFiles(r: Repo, commit: string, paths: string[]): Promise<void> {
  const t = await flatTree(r, commit);
  for (const p of paths) {
    const e = t.get(p);
    if (e) { await writeWork(r, p, (await git.readBlob({ ...base(r), oid: e.oid })).blob); await git.add({ ...base(r), filepath: p }); }
    else { await removeWork(r, p); await git.remove({ ...base(r), filepath: p }).catch(() => undefined); }
  }
}

/** The remote's head brought into this branch and the folder (fetch first). */
export async function integrate(r: Repo, theirs: string | null, author: Author, choose: (c: Conflict[]) => Promise<Map<string, Choice> | null>): Promise<UpdateResult> {
  const ours = await headOf(r);
  const branch = await branchOf(r);
  if (!theirs || ours === theirs) return { changed: [], extra: [], upToDate: true };
  if (ours && (await git.isDescendent({ ...base(r), oid: ours, ancestor: theirs, depth: -1 }).catch(() => false))) return { changed: [], extra: [], upToDate: true };
  // Changed here and not committed
  const status = await statusOf(r);
  const dirty = new Set([...status].filter(([, s]) => s === 'modified' || s === 'added' || s === 'deleted').map(([p]) => p));
  // Fast-forward: only they moved on
  if (!ours || (await git.isDescendent({ ...base(r), oid: theirs, ancestor: ours, depth: -1 }).catch(() => false))) {
    const changed = await changedBetween(r, ours, theirs);
    // An untracked file in the way of one coming in counts as changed here too
    const blocked = changed.filter((p) => dirty.has(p) || (status.get(p) === 'untracked'));
    if (blocked.length) return { changed: [], extra: [], blocked };
    await git.writeRef({ ...base(r), ref: `refs/heads/${branch}`, value: theirs, force: true });
    if (!ours) await git.writeRef({ ...base(r), ref: 'HEAD', value: `refs/heads/${branch}`, symbolic: true, force: true });
    await syncFiles(r, theirs, changed);
    return { changed, extra: [] };
  }
  // Both moved on: merge file by file from where they parted
  const [mb] = await git.findMergeBase({ ...base(r), oids: [ours, theirs] });
  const B = mb ? await flatTree(r, mb) : new Map<string, TreeFile>(), O = await flatTree(r, ours), T = await flatTree(r, theirs);
  const merged = new Map(O);
  const conflicts: Conflict[] = [];
  const { commit: tc } = await git.readCommit({ ...base(r), oid: theirs });
  /** Who last changed a file on their side (since the two parted). */
  const whoChanged = async (path: string): Promise<string> => {
    const at = (c: string) => git.readBlob({ ...base(r), oid: c, filepath: path }).then((x) => x.oid, () => null);
    for (const e of await git.log({ ...base(r), ref: theirs, depth: 300 }).catch(() => [])) {
      if (e.oid === mb) break;
      const parent = e.commit.parent[0];
      if ((await at(e.oid)) !== (parent ? await at(parent) : null)) return e.commit.author.name;
    }
    return tc.author.name;
  };
  for (const p of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(p)?.oid ?? null, o = O.get(p)?.oid ?? null, t = T.get(p)?.oid ?? null;
    if (o === t || t === b) continue;
    if (o === b) { if (T.get(p)) merged.set(p, T.get(p)!); else merged.delete(p); continue; }
    conflicts.push({ path: p, mine: o, theirs: t, by: await whoChanged(p) });
  }
  const touched = [...new Set([...merged.keys(), ...O.keys()])].filter((p) => merged.get(p)?.oid !== O.get(p)?.oid);
  const blocked = [...new Set([...touched, ...conflicts.map((c) => c.path)])].filter((p) => dirty.has(p));
  if (blocked.length) return { changed: [], extra: [], blocked };
  const extra: string[] = [];
  if (conflicts.length) {
    const picked = await choose(conflicts);
    if (!picked) return { changed: [], extra: [], cancelled: true };
    for (const c of conflicts) {
      const ch = picked.get(c.path) ?? 'mine';
      if (ch === 'theirs') { if (T.get(c.path)) merged.set(c.path, T.get(c.path)!); else merged.delete(c.path); touched.push(c.path); }
      if (ch === 'both' && c.theirs) extra.push(c.path);
    }
  }
  const tree = await writeTreeOf(r, merged);
  const now = Math.floor(Date.now() / 1000);
  const who = { ...author, timestamp: now, timezoneOffset: new Date().getTimezoneOffset() };
  const oid = await git.writeCommit({ ...base(r), commit: { message: `Update: ${conflicts.length ? `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} changed on both sides, ` : ''}${short(theirs)} brought in\n`, tree, parent: [ours, theirs], author: who, committer: who } });
  await git.writeRef({ ...base(r), ref: `refs/heads/${branch}`, value: oid, force: true });
  const changed = [...new Set(touched)].sort();
  await syncFiles(r, oid, changed);
  for (const p of extra) {
    const t = T.get(p)!;
    const name = beside(p, short(theirs));
    await writeWork(r, name, (await git.readBlob({ ...base(r), oid: t.oid })).blob);
    changed.push(name);
  }
  return { changed, extra: extra.map((p) => beside(p, short(theirs))), merged: true };
}

/* ─── History ─────────────────────────────────────────────────────────────────────────── */

export interface Version { oid: string; message: string; author: string; email: string; at: number; parents: string[] }

/** The branch's commits, newest first (only those changing a file, when one is given). */
export async function history(r: Repo, filepath?: string, depth = 500): Promise<Version[]> {
  const ref = await branchOf(r);
  let list: Awaited<ReturnType<typeof git.log>>;
  try { list = await git.log({ ...base(r), ref, depth, ...(filepath ? { filepath, force: true } : {}) }); } catch { return []; }
  return list.map((c) => ({ oid: c.oid, message: c.commit.message.trim(), author: c.commit.author.name, email: c.commit.author.email, at: c.commit.author.timestamp * 1000, parents: c.commit.parent }));
}

/** A file as it was in a commit (null: it wasn't there). */
export async function fileAt(r: Repo, commit: string, path: string): Promise<Uint8Array | null> {
  try { return (await git.readBlob({ ...base(r), oid: commit, filepath: path })).blob; } catch { return null; }
}

/** The project as it was in a commit, zipped (folders kept). */
export async function exportZip(r: Repo, commit: string, folder: string): Promise<Uint8Array> {
  const t = await flatTree(r, commit);
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const [p, f] of t) files.push({ name: `${folder}/${p}`, bytes: (await git.readBlob({ ...base(r), oid: f.oid })).blob });
  return zipDeflated(files, new Date(((await git.readCommit({ ...base(r), oid: commit })).commit.author.timestamp) * 1000));
}

/** Files set back to how they were in a commit (in the folder, not committed). */
export async function restoreFiles(r: Repo, commit: string, paths: string[]): Promise<void> {
  const t = await flatTree(r, commit);
  for (const p of paths) {
    const e = t.get(p);
    if (e) await writeWork(r, p, (await git.readBlob({ ...base(r), oid: e.oid })).blob);
    else await removeWork(r, p);
  }
}

/* ─── Soft locks ──────────────────────────────────────────────────────────────────────── */

/**
 * Who is working on which file: a lock says so to the team (it doesn't stop anyone). Kept apart
 * from the project's history, so taking one never waits on an update: in Konium's store as the
 * project's "locks" blob, on a Git server as the branch konium-locks (one file, locks.json). Two
 * taking one at once: the second finds the first's and is told.
 */
export interface Lock { by: string; email: string; at: number }
export type Locks = Record<string, Lock>;
const LOCKS_BRANCH = 'konium-locks';

interface LockState { locks: Locks; tag: string | null }

async function readLockState(r: Repo, m: Remote, a: Access): Promise<LockState> {
  if (m.kind === 'konium') {
    const b = await needStore(a).getJson<Locks>(`r/${m.repo}/locks`);
    return { locks: b?.value ?? {}, tag: b?.tag ?? null };
  }
  try { await git.fetch({ ...httpOpts(r, m, a), ref: LOCKS_BRANCH, singleBranch: true, tags: false }); } catch (e) {
    if (!/could not find|NotFoundError/i.test(String((e as Error).message)) && (e as { code?: string }).code !== 'NotFoundError') throw explain(e);
    return { locks: {}, tag: null };
  }
  const oid = await git.resolveRef({ ...base(r), ref: `refs/remotes/origin/${LOCKS_BRANCH}` }).catch(() => null);
  if (!oid) return { locks: {}, tag: null };
  const blob = await fileAt(r, oid, 'locks.json');
  return { locks: blob ? (JSON.parse(new TextDecoder().decode(blob)) as Locks) : {}, tag: oid };
}

/** Written if nobody wrote them since they were read; false: someone did (read again). */
async function writeLockState(r: Repo, m: Remote, a: Access, s: LockState, locks: Locks, who: Author): Promise<boolean> {
  const json = new TextEncoder().encode(`${JSON.stringify(locks, null, 1)}\n`);
  if (m.kind === 'konium') {
    try { await needStore(a).putJson(`r/${m.repo}/locks`, locks, s.tag); return true; } catch (e) { if (e instanceof StoreConflict) return false; throw e; }
  }
  const blob = await git.writeBlob({ ...base(r), blob: json });
  const tree = await git.writeTree({ ...base(r), tree: [{ mode: '100644', path: 'locks.json', oid: blob, type: 'blob' }] });
  const now = { ...who, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() };
  const commit = await git.writeCommit({ ...base(r), commit: { message: 'Locks\n', tree, parent: s.tag ? [s.tag] : [], author: now, committer: now } });
  await git.writeRef({ ...base(r), ref: `refs/heads/${LOCKS_BRANCH}`, value: commit, force: true });
  try {
    const res = await git.push({ ...httpOpts(r, m, a), ref: LOCKS_BRANCH, remoteRef: LOCKS_BRANCH });
    if (!res.ok) return false;
  } catch (e) {
    if ((e as { code?: string }).code === 'PushRejectedError') return false;
    throw explain(e);
  }
  await git.writeRef({ ...base(r), ref: `refs/remotes/origin/${LOCKS_BRANCH}`, value: commit, force: true });
  return true;
}

/** The team's locks now. */
export async function readLocks(r: Repo, m: Remote, a: Access): Promise<Locks> { return (await readLockState(r, m, a)).locks; }

export type LockResult = { ok: true; locks: Locks } | { ok: false; holder: Lock; locks: Locks };

/** Files locked for me (each refused, with its holder, if someone else has it: unless taken over). */
export async function lockFiles(r: Repo, m: Remote, a: Access, paths: string[], me: Author, takeOver = false): Promise<LockResult> {
  for (let i = 0; i < 5; i++) {
    const s = await readLockState(r, m, a);
    for (const p of paths) {
      const h = s.locks[p];
      if (h && h.email.toLowerCase() !== me.email.toLowerCase() && !takeOver) return { ok: false, holder: h, locks: s.locks };
    }
    const locks = { ...s.locks };
    for (const p of paths) locks[p] = { by: me.name, email: me.email, at: Date.now() };
    if (await writeLockState(r, m, a, s, locks, me)) return { ok: true, locks };
  }
  throw new Error('The locks kept changing while they were written: try again');
}

/** Locks given up (mine; someone else's only when broken on purpose). */
export async function unlockFiles(r: Repo, m: Remote, a: Access, paths: string[], me: Author, breakOthers = false): Promise<Locks> {
  for (let i = 0; i < 5; i++) {
    const s = await readLockState(r, m, a);
    const locks = { ...s.locks };
    let changed = false;
    for (const p of paths) {
      const h = locks[p];
      if (h && (breakOthers || h.email.toLowerCase() === me.email.toLowerCase())) { delete locks[p]; changed = true; }
    }
    if (!changed || (await writeLockState(r, m, a, s, locks, me))) return locks;
  }
  throw new Error('The locks kept changing while they were written: try again');
}
