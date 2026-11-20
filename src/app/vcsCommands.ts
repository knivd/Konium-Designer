/**
 * Project › Version Control (and the Projects panel's right-click menus): Add Project to Version
 * Control, Commit Whole Project, Update Whole Project, Push, History, Document History, Lock,
 * Unlock, Repository Settings; File › Open Project from Version Control. Each works on the
 * project in focus (the one right-clicked, else the active document's).
 */
import type { Command } from '../core/commands';
import { featureOn } from '../core/release';
import { hasFolderAccess } from '../platform/fs';
import { active, projects, type Project } from './state';
import { focusedDocument, focusedProject } from './workspace';
import { isMine, repoPath, startChecking, vcsInfo } from './vcs';
import { cmdAddToVc, cmdClone, cmdCommit, cmdHistory, cmdLock, cmdPush, cmdRepoSettings, cmdUnlock, cmdUpdate } from './vcsActions';

/** The document in focus: the one right-clicked, else the active one (in a project). */
function docInFocus(): { project: Project; name: string; path: string } | null {
  const f = focusedDocument();
  if (f?.project) return { project: f.project, name: f.name, path: f.path ?? f.name };
  const a = active.value;
  const p = a?.projectId ? projects.value.find((x) => x.id === a.projectId) : undefined;
  if (!a || !p) return null;
  const d = p.prj.documents.find((x) => x.replace(/\\/g, '/').split('/').pop()!.toLowerCase() === a.name.toLowerCase());
  return { project: p, name: a.name, path: d ?? a.name };
}
/** The document in focus's lock (undefined: not under version control with a remote). */
function lockInFocus() {
  const d = docInFocus();
  const i = d && vcsInfo.value[d.project.id];
  if (!d || !i?.repo || !i.remote) return undefined;
  return { d, lock: i.locks[repoPath(d.project, d.path)] ?? null };
}

export function vcsCommands(): Command[] {
  if (featureOn('versionControl')) startChecking();
  const proj = () => focusedProject();
  const info = () => { const p = proj(); return p ? vcsInfo.value[p.id] : undefined; };
  const inVc = () => !!info()?.repo;
  return [
    { id: 'vcs.add', label: 'Add Project to Version Control...', run: () => cmdAddToVc(proj()), enabled: () => !!proj()?.dir && !inVc() },
    { id: 'vcs.commit', label: 'Commit Whole Project...', run: () => void cmdCommit(proj()), enabled: inVc },
    { id: 'vcs.update', label: 'Update Whole Project', run: () => void cmdUpdate(proj()), enabled: () => inVc() && !!info()?.remote },
    { id: 'vcs.push', label: 'Push', run: () => void cmdPush(proj()), enabled: () => inVc() && !!info()?.remote },
    { id: 'vcs.history', label: 'History...', run: () => void cmdHistory(proj()), enabled: inVc },
    { id: 'vcs.docHistory', label: 'Document History...', run: () => { const d = docInFocus(); if (d) void cmdHistory(d.project, d.name); }, enabled: () => { const d = docInFocus(); return !!d && !!vcsInfo.value[d.project.id]?.repo; } },
    { id: 'vcs.lock', label: 'Lock', run: () => { const d = docInFocus(); if (d) void cmdLock(d.project, d.path); }, enabled: () => { const x = lockInFocus(); return !!x && (!x.lock || !isMine(x.lock)); } },
    { id: 'vcs.unlock', label: 'Unlock', run: () => { const d = docInFocus(); if (d) void cmdUnlock(d.project, d.path); }, enabled: () => !!lockInFocus()?.lock },
    { id: 'vcs.settings', label: 'Repository Settings...', run: () => void cmdRepoSettings(proj()), enabled: inVc },
    { id: 'vcs.clone', label: 'Open Project from Version Control...', run: cmdClone, enabled: hasFolderAccess },
  ];
}
