import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { activeProject } from '../project';
import { installLibraries, installedLibs, installedPcbLibs, installedRows, installedKind, moveInstalled, removeInstalled, type InstalledRow } from './PlacePart';

/**
 * Design › Add/Remove Library: the libraries parts can be placed from — the project's own
 * (Project tab) and the installed ones, kept between sessions (Installed tab: Install...,
 * Remove, Move Up / Down set the order the Libraries panel lists them in).
 */
export function AvailableLibrariesDialog() {
  const [tab, setTab] = useState<'project' | 'installed'>('installed');
  const [sel, setSel] = useState<number | null>(null);
  const p = activeProject();
  const projectLibs = p ? p.prj.documents.filter((d) => /\.(schlib|pcblib|intlib|dblib|svndblib)$/i.test(d)) : [];
  void installedLibs.value; void installedPcbLibs.value;
  const inst = installedRows();
  const cur = sel !== null ? inst[sel] : undefined;
  const move = (d: -1 | 1) => { if (cur && moveInstalled(cur, d)) setSel(installedRows().indexOf(installedRows().find((r) => r.file === cur.file)!)); };
  return (
    <Dialog title="Available Libraries" width={640} height={440} onClose={closeDialog}
      footer={tab === 'installed' ? <>
        <button class="btn" onClick={async () => { await installLibraries(); }}>Install...</button>
        <button class="btn" disabled={!cur} onClick={() => { if (cur) removeInstalled(cur); setSel(null); }}>Remove</button>
        <button class="btn" disabled={!cur || inst[sel! - 1]?.kind !== cur.kind} onClick={() => move(-1)}>Move Up</button>
        <button class="btn" disabled={!cur || inst[sel! + 1]?.kind !== cur.kind} onClick={() => move(1)}>Move Down</button>
        <span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button>
      </> : <><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="dlg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'project'} onClick={() => { setTab('project'); setSel(null); }}>Project</button>
        <button role="tab" aria-selected={tab === 'installed'} onClick={() => { setTab('installed'); setSel(null); }}>Installed</button>
      </div>
      {tab === 'project'
        ? <Grid cols={[{ label: 'Library', get: (d: string) => d.split('/').pop() ?? d }, { label: 'Path', get: (d) => d.replace(/\//g, '\\') }]} rows={projectLibs} empty={p ? 'The project has no libraries' : 'No project is active'} />
        : <Grid cols={[{ label: 'Library', get: (r: InstalledRow) => r.file.name }, { label: 'Type', width: '130px', get: (r) => installedKind(r.kind) },
          { label: 'Size', width: '80px', align: 'right', get: (r) => sizeOf(r.size) }]} rows={inst} sel={sel} onSel={setSel}
          empty="No libraries installed: Install... adds .SchLib, .PcbLib, .IntLib and .DbLib files (kept for next time)" />}
    </Dialog>
  );
}

/** 236 KB, 42.1 MB. */
export const sizeOf = (n: number): string => (n >= 1e6 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
