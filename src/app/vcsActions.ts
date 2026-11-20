/**
 * Version control's commands: Add Project to Version Control, Commit (and push), Update (the
 * others' changes brought in: the choice for files changed on both sides; files in the way
 * stop it), History (open, restore, export a version), Open Project from Version Control,
 * Repository Settings (moving the project, history and all, to another place), and Lock and
 * Unlock (telling the team who is working on a file; a lock goes when its file is pushed).
 */
import { showDialog, closeDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { AddToVcDialog, BlockedDialog, CloneDialog, CommitDialog, ConflictDialog, HistoryDialog, RepoSettingsDialog, type CommitRow } from './dialogs/Vcs';
import { accessFor, author, isMine, lockWords, projectFilePath, refresh, reloadFiles, remoteWords, repoFor, repoPath, setLocks, teams, unsavedIn, vcsInfo, working } from './vcs';
import { docBaseName } from '../formats/altium/prjpcb';
import { docs, isDocDirty, notify, type Project } from './state';
import { canCompare, startCompare } from './compare';
import { requestProjectFolder, saveFileAs } from '../platform/fs';
import type { Remote, Repo, UpdateResult } from '../vcs/git';

const gitCode = () => import('../vcs/git');
const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const short = (oid: string) => oid.slice(0, 7);

function needFolder(p: Project | null): p is Project {
  if (!p) { notify('Open a project first', 'error'); return false; }
  if (!p.dir) { notify('Version control works on a project opened from its folder: File › Open Project, then Choose project folder', 'error'); return false; }
  return true;
}
async function needRepo(p: Project | null): Promise<{ p: Project; r: Repo } | null> {
  if (!needFolder(p)) return null;
  const r = await repoFor(p);
  if (!r) { cmdAddToVc(p); return null; }
  return { p, r };
}
function needAuthor(): boolean {
  if (author()) return true;
  notify('Set your name and email first: Preferences › Data Management › Version Control', 'error');
  return false;
}
const toRemote = async (m: { team?: string; url?: string }): Promise<Remote> => {
  if (m.team) { const { newRepoId } = await import('../vcs/store'); return { kind: 'konium', team: m.team, repo: newRepoId() }; }
  return { kind: 'git', url: m.url! };
};

/* ─── Add ─────────────────────────────────────────────────────────────────────────────── */

export function cmdAddToVc(p: Project | null): void {
  if (!needFolder(p)) return;
  void repoFor(p).then((r) => {
    if (r) { notify(`${p.name} is under version control already (${remoteWords(vcsInfo.value[p.id]?.remote ?? null)})`); return; }
    showDialog(AddToVcDialog, { p, onAdd: (m) => void addNow(p, m) });
  });
}
async function addNow(p: Project, m: { team?: string; url?: string }): Promise<void> {
  if (!needAuthor()) return;
  await working(p, 'Add to version control', async () => {
    const g = await gitCode();
    const r = (await repoFor(p, true))!;
    const remote = await toRemote(m);
    const access = await accessFor(remote);
    await g.createRepo(r, author()!, remote, `${stem(p.name)} added to version control`);
    await g.setRemote(r, remote);
    const res = await g.pushRemote(r, remote, access, stem(p.name));
    if (res === 'behind') throw new Error('The repository at that address isn\'t empty: choose an empty one, or open that one (File › Open Project from Version Control)');
    const unsaved = unsavedIn(p).length;
    notify(`${p.name} is under version control: kept in ${remoteWords(remote)}${unsaved ? `. ${unsaved} document${unsaved === 1 ? ' isn\'t' : 's aren\'t'} saved: save and commit ${unsaved === 1 ? 'it' : 'them'}` : ''}`);
  });
  await refresh(p);
}

/* ─── Commit and push ─────────────────────────────────────────────────────────────────── */

export async function cmdCommit(p: Project | null): Promise<void> {
  const x = await needRepo(p);
  if (!x) return;
  const g = await gitCode();
  const status = await g.statusOf(x.r);
  const inProject = new Set([projectFilePath(x.p), ...x.p.prj.documents.map((d) => repoPath(x.p, d))].map((s) => s.toLowerCase()));
  const rows: CommitRow[] = [...status].filter(([, s]) => s !== 'unchanged').map(([path, state]) => ({ path, state, inProject: inProject.has(path.toLowerCase()) || path === '.gitignore' }))
    .sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.path.localeCompare(b.path));
  const remote = await g.remoteOf(x.r);
  const locks = vcsInfo.value[x.p.id]?.locks ?? {};
  const mine = rows.filter((r) => locks[r.path] && isMine(locks[r.path]!)).length;
  showDialog(CommitDialog, {
    p: x.p, rows, unsaved: unsavedIn(x.p).map((d) => d.name), canPush: !!remote, mine,
    onCommit: (paths, message, push, unlock) => void commitNow(x.p, x.r, paths, message, push, unlock),
    onSaveAll: () => { closeDialog(); void import('./actions').then(async (a) => { await a.cmdSaveAll(); await cmdCommit(x.p); }); },
  });
}
async function commitNow(p: Project, r: Repo, paths: string[], message: string, push: boolean, unlock: boolean): Promise<void> {
  if (!needAuthor()) return;
  await working(p, 'Commit', async () => {
    const g = await gitCode();
    const oid = await g.commitFiles(r, paths, message, author()!);
    if (!push) { notify(`Committed ${short(oid)} (${paths.length} file${paths.length === 1 ? '' : 's'}): push it with Commit and Push, or with the next one`); return; }
    if ((await pushNow(p, r)) && unlock) await unlockNow(p, r, paths.filter((x) => { const l = vcsInfo.value[p.id]?.locks[x]; return l && isMine(l); }));
  });
  await refresh(p);
}

/** Pushed (true: the remote has it now); when someone pushed first, updated, then pushed again. */
async function pushNow(p: Project, r: Repo): Promise<boolean> {
  const g = await gitCode();
  const remote = await g.remoteOf(r);
  if (!remote) return false;
  const access = await accessFor(remote);
  let res = await g.pushRemote(r, remote, access, stem(p.name));
  if (res === 'behind') {
    notify('Someone pushed first: bringing their changes in');
    const up = await updateNow(p, r);
    if (!up || up.blocked || up.cancelled) { notify('Committed, not pushed: Update, then push (Commit and Push)', 'error'); return false; }
    res = await g.pushRemote(r, remote, access, stem(p.name));
  }
  notify(res === 'pushed' ? `Pushed to ${remoteWords(remote)}` : res === 'up-to-date' ? 'Nothing new to push' : 'Not pushed: someone pushed again meanwhile; Update, then push', res === 'behind' ? 'error' : 'ok');
  return res !== 'behind';
}

export async function cmdPush(p: Project | null): Promise<void> {
  const x = await needRepo(p);
  if (!x) return;
  await working(x.p, 'Push', () => pushNow(x.p, x.r));
  await refresh(x.p);
}

/* ─── Update ──────────────────────────────────────────────────────────────────────────── */

export async function cmdUpdate(p: Project | null): Promise<void> {
  const x = await needRepo(p);
  if (!x) return;
  const unsaved = unsavedIn(x.p);
  if (unsaved.length) {
    showDialog(ConfirmDialog, {
      title: 'Update', message: `Save ${unsaved.length === 1 ? unsaved[0]!.name : `the ${unsaved.length} changed documents`} first?`,
      detail: 'Update works on the files as saved; a document with changes not saved would be read again over them.',
      onYes: () => void import('./actions').then(async (a) => { if (await a.cmdSaveAll()) await cmdUpdate(x.p); }),
    });
    return;
  }
  await working(x.p, 'Update', () => updateNow(x.p, x.r));
  await refresh(x.p);
}

async function updateNow(p: Project, r: Repo): Promise<UpdateResult | null> {
  if (!needAuthor()) return null;
  const g = await gitCode();
  const remote = await g.remoteOf(r);
  if (!remote) { notify('This project has nowhere to update from: Repository Settings', 'error'); return null; }
  const theirs = await g.fetchRemote(r, remote, await accessFor(remote));
  const res = await g.integrate(r, theirs, author()!, (c) => new Promise((ok) => showDialog(ConflictDialog, { conflicts: c, onDone: ok })));
  if (res.blocked) {
    const files = res.blocked;
    showDialog(BlockedDialog, {
      files, onCommit: () => void cmdCommit(p),
      onDiscard: () => void working(p, 'Put back', async () => { await g.discard(r, files); await reloadFiles(p, files); }).then(() => cmdUpdate(p)),
    });
    return res;
  }
  if (res.cancelled) { notify('Update cancelled: nothing changed'); return res; }
  if (res.changed.length) await reloadFiles(p, res.changed);
  notify(res.upToDate ? 'Up to date' : `Updated: ${res.changed.length} file${res.changed.length === 1 ? '' : 's'} brought in${res.extra.length ? `; theirs kept beside yours: ${res.extra.join(', ')}` : ''}`);
  return res;
}

/* ─── History ─────────────────────────────────────────────────────────────────────────── */

export async function cmdHistory(p: Project | null, docName?: string): Promise<void> {
  const x = await needRepo(p);
  if (!x) return;
  const g = await gitCode();
  const { p: pr, r } = x;
  const docPath = docName ? repoPath(pr, pr.prj.documents.find((d) => docBaseName(d).toLowerCase() === docName.toLowerCase()) ?? docName) : undefined;
  const list = await g.history(r, docPath);
  /** A schematic or board as it was in a version, beside it as it is now. */
  const compareAt = async (v: { oid: string; at: number; author: string }, path: string) => {
    const name = path.split('/').pop()!;
    const bytes = await g.fileAt(r, v.oid, path);
    if (!bytes) { notify(`${name} isn't in ${short(v.oid)}`, 'error'); return; }
    let cur = docs.value.find((d) => d.projectId === pr.id && d.name.toLowerCase() === name.toLowerCase()) ?? null;
    if (!cur) {
      const f = pr.files.get(name.toLowerCase());
      const { openDocument } = await import('./actions');
      cur = f ? openDocument(f, pr.id, false) : null;
    }
    if (!cur) { notify(`${name} isn't in the project now: Open This Version to see it`, 'error'); return; }
    closeDialog();
    const when = new Date(v.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    await startCompare(name, { bytes, title: `${name} in ${short(v.oid)}, ${when}, ${v.author}`, tag: short(v.oid) }, { od: cur, title: `${name} now${isDocDirty(cur) ? ' (not saved)' : ''}` });
  };
  showDialog(HistoryDialog, {
    title: `History: ${docName ?? pr.name}`, list, doc: docName,
    act: {
      changes: (v) => g.changedBetween(r, v.parents[0] ?? null, v.oid),
      compare: docPath && docName && canCompare(docName) ? (v) => void compareAt(v, docPath) : undefined,
      compareFile: (v, path) => void compareAt(v, path),
      open: async (v) => {
        const bytes = docPath && (await g.fileAt(r, v.oid, docPath));
        if (!bytes) { notify('Not in that version', 'error'); return; }
        const { openDocument } = await import('./actions');
        const name = docName!.replace(/(\.[^.]+)$/, ` (${short(v.oid)})$1`);
        closeDialog();
        openDocument({ name, bytes }, undefined, true);
        notify(`${docName} as it was in ${short(v.oid)} (${new Date(v.at).toLocaleDateString()}): a copy, not part of the project`);
      },
      restore: (v) => {
        showDialog(ConfirmDialog, {
          title: 'Restore', message: docName ? `Put ${docName} back as it was in ${short(v.oid)}?` : `Put the whole project back as it was in ${short(v.oid)}?`,
          detail: 'The files in the folder are set to that version (not committed: commit them to keep it). Changes not committed to them are lost.',
          onYes: () => void working(pr, 'Restore', async () => {
            const head = await g.headOf(r);
            const paths = docPath ? [docPath] : await g.changedBetween(r, v.oid, head);
            await g.restoreFiles(r, v.oid, paths);
            await reloadFiles(pr, paths);
            closeDialog();
            notify(`${paths.length} file${paths.length === 1 ? '' : 's'} put back as in ${short(v.oid)}: commit to keep ${paths.length === 1 ? 'it' : 'them'}`);
          }).then(() => refresh(pr)),
        });
      },
      exportZip: async (v) => {
        if (docPath && docName) {
          const bytes = await g.fileAt(r, v.oid, docPath);
          if (bytes) await saveFileAs(docName.replace(/(\.[^.]+)$/, ` (${short(v.oid)})$1`), bytes, pr.dir);
          return;
        }
        const name = `${stem(pr.name)} ${short(v.oid)}`;
        await saveFileAs(`${name}.zip`, await g.exportZip(r, v.oid, name), pr.dir);
      },
    },
  });
}

/* ─── Open from version control ───────────────────────────────────────────────────────── */

export function cmdClone(): void {
  showDialog(CloneDialog, {
    list: async (teamId) => {
      const t = teams().find((x) => x.id === teamId);
      if (!t) return [];
      const remote: Remote = { kind: 'konium', team: teamId, repo: 'index0' };
      const a = await accessFor(remote);
      return (await (await gitCode()).teamProjects(a.store!)).projects.sort((x, y) => x.name.localeCompare(y.name));
    },
    onClone: (m) => void cloneNow(m),
  });
}
async function cloneNow(m: { team?: string; project?: string; url?: string }): Promise<void> {
  if (!needAuthor()) return;
  const dir = await requestProjectFolder();
  if (!dir) return;
  for await (const _ of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) { notify('Choose an empty folder: the project and its history go into it', 'error'); return; }
  const g = await gitCode();
  const remote: Remote = m.team ? { kind: 'konium', team: m.team, repo: m.project! } : { kind: 'git', url: m.url! };
  try {
    notify('Opening from version control…');
    const head = await g.cloneInto(g.repoAt(dir), remote, await accessFor(remote), author()!);
    if (!head) { notify('The repository is empty: nothing to open yet', 'error'); return; }
  } catch (e) { notify(`Open from version control: ${(e as Error).message}`, 'error'); return; }
  const { openProjectFolder } = await import('./actions');
  if (!(await openProjectFolder(dir))) notify('Opened, but its folder has no project file', 'error');
}

/* ─── Lock and Unlock ─────────────────────────────────────────────────────────────────── */

/** Lock: the team told that I am working on the document (someone else's lock: say whose, and offer to take it over). */
export async function cmdLock(p: Project | null, docPath: string): Promise<void> {
  const x = await needRepo(p);
  if (!x || !needAuthor()) return;
  const g = await gitCode();
  const remote = await g.remoteOf(x.r);
  if (!remote) { notify('Locks tell the team: this project isn\'t kept with one (Repository Settings)', 'error'); return; }
  const path = repoPath(x.p, docPath), name = path.split('/').pop()!;
  const take = async (takeOver: boolean) => {
    const res = await working(x.p, 'Lock', async () => g.lockFiles(x.r, remote, await accessFor(remote), [path], author()!, takeOver));
    if (!res) return;
    setLocks(x.p, res.locks);
    if (res.ok) { notify(`${name} locked: the team sees you are working on it until you push it, or Unlock`); return; }
    showDialog(ConfirmDialog, {
      title: 'Lock', message: `${name} is locked by ${lockWords(res.holder)}.`,
      detail: 'Ask them first: a lock taken over doesn\'t stop them, and whichever of you pushes second chooses whose to keep. Take it over?',
      yes: 'Take It Over', no: 'Cancel', onYes: () => void take(true),
    });
  };
  await take(false);
}

/** Unlock: mine given up; someone else's broken (asked first). */
export async function cmdUnlock(p: Project | null, docPath: string): Promise<void> {
  const x = await needRepo(p);
  if (!x || !needAuthor()) return;
  const path = repoPath(x.p, docPath), name = path.split('/').pop()!;
  const l = vcsInfo.value[x.p.id]?.locks[path];
  if (!l) { notify(`${name} isn't locked`); return; }
  if (isMine(l)) { await working(x.p, 'Unlock', () => unlockNow(x.p, x.r, [path])); return; }
  showDialog(ConfirmDialog, {
    title: 'Unlock', message: `Break ${l.by}'s lock on ${name}?`, detail: `Locked by ${lockWords(l)}. They aren't told; ask them first if you can.`,
    yes: 'Break the Lock', no: 'Cancel', onYes: () => void working(x.p, 'Unlock', () => unlockNow(x.p, x.r, [path], true)),
  });
}

async function unlockNow(p: Project, r: Repo, paths: string[], breakOthers = false): Promise<void> {
  if (!paths.length) return;
  const g = await gitCode();
  const remote = await g.remoteOf(r);
  if (!remote) return;
  setLocks(p, await g.unlockFiles(r, remote, await accessFor(remote), paths, author()!, breakOthers));
  notify(paths.length === 1 ? `${paths[0]!.split('/').pop()} unlocked` : `${paths.length} files unlocked`);
}

/* ─── Settings ────────────────────────────────────────────────────────────────────────── */

export async function cmdRepoSettings(p: Project | null): Promise<void> {
  const x = await needRepo(p);
  if (!x) return;
  await refresh(x.p);
  showDialog(RepoSettingsDialog, { p: x.p, onMove: (m) => void moveNow(x.p, x.r, m) });
}
async function moveNow(p: Project, r: Repo, m: { team?: string; url?: string }): Promise<void> {
  await working(p, 'Move', async () => {
    const g = await gitCode();
    const remote = await toRemote(m);
    const access = await accessFor(remote);
    const old = await g.remoteOf(r);
    await g.setRemote(r, remote);
    try {
      const res = await g.pushRemote(r, remote, access, stem(p.name));
      if (res === 'behind') throw new Error('The repository at that address isn\'t empty: choose an empty one');
    } catch (e) { await g.setRemote(r, old); throw e; }
    notify(`Moved, with every version: now kept in ${remoteWords(remote)}`);
  });
  await refresh(p, { fetch: true });
}
