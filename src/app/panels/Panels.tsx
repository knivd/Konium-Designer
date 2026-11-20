import { featureOn } from '../../core/release';
import { ensureVcs, isMine, lockWords, remoteWords, repoPath, vcsInfo } from '../vcs';
import { locale } from '../../core/locale';
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { ColourIcon, docIcon } from '../icons';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from '../dialogs';
import type { PadTemplate } from '../../editors/pcb/PlacePadTool';
import { currentProjectId, isDocDirty, active, activeId, activeScope, docs, messages, projects, tick, cursorTick, workspace } from '../state';
import { commands } from '../../core/commands';
import { openProjectDocument } from '../actions';
import { compiled, crossProbe, projectSheet, projectTree } from '../project';
import { symbolNames, type HierNode } from '../../model/schHierarchy';
import { docBaseName } from '../../formats/altium/prjpcb';
import { backupTick, versionsOf } from '../backup';
import { walkCfb, type CfbEntry } from '../../formats/cfb/cfb';
import { splitBinaryRecords, splitSchRecords, splitTextRecords } from '../../formats/altium/framing';
import { hexDump } from '../../formats/bin';
import { SR_NAME } from '../../model/sch';
import { settings, updateSettings } from '../../core/settings';
import { ctxRow, msgFolded, msgGroup, msgGroupKey, msgSel } from '../workspace';
import type { Message, Project } from '../state';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { viaSize } from '../../editors/pcb/PcbPlaceTools';
import { ROUTE_MODES } from '../../editors/pcb/RouteTool';

/* ─── Projects ───────────────────────────────────────────────────────────────────────── */

/** Folders (and child sheets) opened or closed by hand, against how they start (System › Projects Panel › Default Expansion). */
const toggled = signal<Set<string>>(new Set());
const toggleFolder = (key: string) => {
  const next = new Set(toggled.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  toggled.value = next;
};
/** How a folder starts: every one open; the source documents only (and their sheets); or all closed. */
const startsOpen = (id: string): boolean => {
  switch (settings.projExpand) {
    case 'full': return true;
    case 'source': return /:src$/.test(id) || /:h:/.test(id);
    default: return false;
  }
};
const isOpen = (id: string) => startsOpen(id) !== toggled.value.has(id);

const LIB = /\.(schlib|pcblib|intlib|pcb3dlib|dblink|dblib|svndblib)$/i;

function Folder({ id, label, children, project, folder }: { id: string; label: string; children: ComponentChildren; project?: string; folder?: string }) {
  const open = isOpen(id);
  const ctx = project && folder ? { 'data-ctx': 'category', 'data-project': project, 'data-folder': folder } : {};
  return (
    <div class="tree-folder" role="group">
      <button class={`tree-row tree-folder-row${ctxRow.value === `c:${project}:${folder}` ? ' ctx' : ''}`} aria-expanded={open} onClick={() => toggleFolder(id)} {...ctx}>
        <span class="tree-twisty">{open ? '▾' : '▸'}</span>
        <ColourIcon name={open ? 'folderOpen' : 'folder'} />
        <span>{label}</span>
      </button>
      {open && <div class="tree-children">{children}</div>}
    </div>
  );
}

type Twisty = { open: boolean; toggle: () => void };
/** A document's state under version control, as a mark beside it. */
export interface VcsMark { cls: string; glyph: string; title: string }
const VCS_MARKS: Record<string, VcsMark> = {
  unchanged: { cls: 'ok', glyph: '✓', title: 'No change since the last commit' },
  modified: { cls: 'mod', glyph: '●', title: 'Changed: not committed yet' },
  added: { cls: 'new', glyph: '+', title: 'New: not committed yet' },
  deleted: { cls: 'mod', glyph: '✕', title: 'Deleted: not committed yet' },
  untracked: { cls: 'off', glyph: '?', title: 'Not in version control: commit it to add it' },
  incoming: { cls: 'late', glyph: '↓', title: 'Out of date: someone pushed a newer version (Update Whole Project)' },
  conflict: { cls: 'clash', glyph: '!', title: 'Changed here and by someone else: Update asks which to keep' },
};
/** A project document's mark from its project's version control state. */
export function vcsMark(state: string | undefined, incoming: boolean): VcsMark | undefined {
  if (incoming) return VCS_MARKS[state === 'modified' || state === 'deleted' ? 'conflict' : 'incoming'];
  return state ? VCS_MARKS[state] : undefined;
}

/** A document locked (by me, or by someone else): a padlock beside it. */
export interface LockMark { mine: boolean; title: string }
const Padlock = () => <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true"><path d="M2 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.3" /><rect x="0.5" y="5" width="8" height="5.5" rx="1" fill="currentColor" /></svg>;

function DocRow({ name, on, open, missing, dirty, title, onOpen, project, path, twisty, position, versions, vcs, lock }: { name: string; on: boolean; open: boolean; missing?: boolean; dirty?: boolean; title?: string; onOpen: () => void; project?: string; path?: string; position?: number; twisty?: Twisty; versions?: number; vcs?: VcsMark; lock?: LockMark }) {
  const ctx = ctxRow.value === `d:${project ?? ''}:${name.toLowerCase()}`;
  // System › Projects Panel › Single Click: nothing, or bring an open document to the front, or open it; a double-click always opens it
  const click = () => { if (settings.projSingleClick === 'open' || (settings.projSingleClick === 'activate' && open)) onOpen(); };
  const status = settings.projShowStatus;
  return (
    <button class={`tree-row tree-doc${on ? ' on' : ''}${open && status ? ' open' : ''}${missing ? ' missing' : ''}${ctx ? ' ctx' : ''}${twisty ? ' has-twisty' : ''}`} onClick={click} onDblClick={onOpen} title={title ?? name}
      data-ctx="document" data-project={project ?? ''} data-name={name} data-path={path ?? name}>
      {twisty && <span class="tree-twisty" role="button" aria-expanded={twisty.open} aria-label={twisty.open ? 'Collapse' : 'Expand'}
        onClick={(e) => { e.stopPropagation(); twisty.toggle(); }}>{twisty.open ? '▾' : '▸'}</span>}
      <span class="tree-icon"><ColourIcon name={docIcon(name)} />{dirty && status && <span class="tree-dirty" aria-label="modified" />}</span>
      <span class="tree-name">{position !== undefined && settings.projShowPosition ? <span class="tree-pos">{position}.</span> : null}{name}</span>
      {lock && <span class={`tree-lock ${lock.mine ? 'mine' : 'other'}`} title={lock.title} aria-label={lock.title}><Padlock /></span>}
      {vcs ? <span class={`tree-vcs vcs-${vcs.cls}`} title={vcs.title} aria-label={vcs.title}>{vcs.glyph}</span>
        : versions ? <span class="tree-hist" title={`${versions} version${versions === 1 ? '' : 's'} in Local History`}>⟲{versions}</span> : null}
    </button>
  );
}

/** System › Projects Panel › Sorting: the project's order, by name, or open and modified ones first; either way round. */
export function sortProjectRows<R extends { name: string; position: number; open?: unknown; dirty?: boolean }>(rows: R[]): R[] {
  const rank = (r: R) => (r.dirty ? 0 : r.open ? 1 : 2);
  const by = settings.projSort === 'alpha' ? (a: R, b: R) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : settings.projSort === 'status' ? (a: R, b: R) => rank(a) - rank(b) || a.position - b.position
    : (a: R, b: R) => a.position - b.position;
  const out = [...rows].sort(by);
  return settings.projAscending ? out : out.reverse();
}

/**
 * System › Projects Panel › Show VCS status: Konium keeps versions in Local History rather than in
 * version control, so each document shows how many it has there.
 */
const historyCounts = signal<Map<string, number>>(new Map());
let countsFor = '';
function refreshHistoryCounts(): void {
  const sig = `${backupTick.value}|${projects.value.map((p) => `${p.id}:${p.prj.documents.length}`).join(',')}`;
  if (sig === countsFor) return;
  countsFor = sig;
  void (async () => {
    const m = new Map<string, number>();
    for (const p of projects.value) for (const path of p.prj.documents) {
      const name = docBaseName(path);
      try { const n = (await versionsOf({ name, project: p, path })).length; if (n) m.set(`${p.id}|${name.toLowerCase()}`, n); } catch { /* not readable now */ }
    }
    historyCounts.value = m;
  })();
}

/** A project under version control: kept where, busy, waiting to be pushed, others' changes to bring in, a problem. */
function VcsBadges({ p }: { p: Project }) {
  const i = vcsInfo.value[p.id];
  if (!i?.repo) return null;
  const mine = vcsMark(i.status.get(repoPath(p, p.path ?? p.name)), i.incoming.has(repoPath(p, p.path ?? p.name)));
  return (
    <span class="tree-vcs-badges">
      {mine && <span class={`tree-vcs vcs-${mine.cls}`} title={mine.title}>{mine.glyph}</span>}
      {i.busy && <span class="tree-vcs vcs-busy" title={`${i.busy}…`}>⋯</span>}
      {i.unpushed && <span class="tree-vcs vcs-new" title={`Committed, not pushed yet (Push, or Commit and Push) to ${remoteWords(i.remote)}`}>↑</span>}
      {i.incoming.size > 0 && <span class="tree-vcs vcs-late" title={`${i.incoming.size} file${i.incoming.size === 1 ? '' : 's'} pushed by others to bring in (Update Whole Project)`}>↓{i.incoming.size}</span>}
      {i.error && <span class="tree-vcs vcs-clash" title={i.error}>⚠</span>}
      {!i.remote && <span class="tree-vcs vcs-off" title="Under version control on this computer only: Repository Settings to keep it with the team">⌂</span>}
    </span>
  );
}

export function ProjectsPanel() {
  void tick.value;
  const vcsOn = featureOn('versionControl');
  if (settings.projHistoryStatus) refreshHistoryCounts();
  const counts = settings.projHistoryStatus ? historyCounts.value : null;
  const loose = docs.value.filter((d) => !d.projectId && !d.forCompare);
  const empty = !projects.value.length && !loose.length;
  const isDirty = (id?: string) => isDocDirty(docs.value.find((d) => d.id === id));
  return (
    <section class="panel docked" aria-label="Projects">
      <div class={`panel-body tree${settings.projGrid ? ' grid' : ''}`} data-ctx="workspace">
        <div class={`tree-row tree-workspace-row${ctxRow.value === 'w' ? ' ctx' : ''}`} title={workspace.value.name} data-ctx="workspace"><ColourIcon name="dsnwrk" /><span class="tree-name">{workspace.value.name}</span></div>
        {empty && <p class="panel-empty">Open a project or document to see it here.</p>}
        {projects.value.map((p) => {
          const rows = sortProjectRows(p.prj.documents.map((path, i) => {
            const name = docBaseName(path);
            const open = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
            return { path, name, open, available: p.files.has(name.toLowerCase()), position: i + 1, dirty: isDirty(open?.id) };
          }));
          const jobs = rows.filter((r) => /\.outjob$/i.test(r.name));
          // An Integrated Library package's libraries are its source documents
          const pkg = /\.libpkg$/i.test(p.name);
          const src = rows.filter((r) => (pkg || !LIB.test(r.name)) && !jobs.includes(r)), libs = pkg ? [] : rows.filter((r) => LIB.test(r.name));
          // Schematics show as their hierarchy, each child sheet under its parent (as soon as the project opens)
          // (System › Projects Panel › Show Project Structure off: a plain list)
          const tree = !settings.projShowStructure ? null : projectTree(p) ?? (compiled.value?.projectId === p.id ? compiled.value.result.hierarchy.roots : null);
          const anyDirty = !!p.dirty || rows.some((r) => isDirty(r.open?.id));
          // What the project made (Mixed Sim's netlist and results): open, not among its documents [est: AD's Generated folder]
          const made = docs.value.filter((d) => d.projectId === p.id && !rows.some((r) => r.name.toLowerCase() === d.name.toLowerCase()));
          // System › Projects Panel › Show full path information in hint: the document's path from its folder; off, its name
          const hint = (r: typeof rows[number]) => (settings.projFullPathHint ? (p.folder ? `${p.folder}\\${r.path.replace(/\//g, '\\')}` : r.path) : r.name);
          // Under version control: each document's state (always), the project's waiting pushes and others' changes
          if (vcsOn) ensureVcs(p);
          const vi = vcsOn ? vcsInfo.value[p.id] : undefined;
          const markOf = (path: string) => { if (!vi?.repo) return undefined; const rp = repoPath(p, path); return vcsMark(vi.status.get(rp), vi.incoming.has(rp)); };
          const lockOf = (path: string): LockMark | undefined => {
            const l = vi?.repo ? vi.locks[repoPath(p, path)] : undefined;
            if (!l) return undefined;
            return isMine(l) ? { mine: true, title: `Locked by you: the team sees you are working on it (Unlock, or push it)` } : { mine: false, title: `Locked by ${lockWords(l)}: they are working on it` };
          };
          const row = (r: typeof rows[number], twisty?: Twisty) => {
            const own = settings.projDocStructure && /\.schdoc$/i.test(r.name) ? docStructure(p, r.name) : [];
            const id = `${p.id}:ds:${r.name.toLowerCase()}`, sOpen = isOpen(id);
            const sTwisty = !twisty && own.length ? { open: sOpen, toggle: () => toggleFolder(id) } : twisty;
            const line = <DocRow key={r.path} name={r.name} on={r.open?.id === activeId.value} open={!!r.open} missing={!r.available} dirty={isDirty(r.open?.id)} project={p.id} path={r.path}
              title={r.available ? hint(r) : `${hint(r)} (not loaded: open the project folder)`} onOpen={() => openProjectDocument(p, r.path)} twisty={sTwisty} position={r.position}
              versions={counts?.get(`${p.id}|${r.name.toLowerCase()}`)} vcs={markOf(r.path)} lock={lockOf(r.path)} />;
            // System › Projects Panel › Show Document Structure: a schematic's sheet symbols and ports under it
            if (!own.length || twisty) return line;
            return <div key={r.path} class="tree-hier">{line}{sOpen && <div class="tree-children">{own.map((x) => (
              <button key={`${x.kind}:${x.index}`} class="tree-row tree-struct" title={x.title} onDblClick={() => crossProbe([{ sheet: r.name, index: x.index }], p)}>
                <ColourIcon name={x.kind === 'sheetsymbol' ? 'schdoc' : 'port'} /><span class="tree-name">{x.label}</span>
              </button>))}</div>}</div>;
          };
          // System › Projects Panel › Grouping: by document type (folders within folders), by class, or none
          const byType = settings.projGroup === 'type';
          return (
            <div class="tree-project" key={p.id}>
              <div class={`tree-row tree-project-row${ctxRow.value === `p:${p.id}` ? ' ctx' : ''}${currentProjectId.value === p.id ? ' focus' : ''}`} title={p.folder ? `${p.folder}\\${p.name}` : p.name} data-ctx="project" data-project={p.id}
                onClick={() => { currentProjectId.value = p.id; }}>
                <ColourIcon name={pkg ? 'libpkg' : /\.(prjmbd|prjhar)$/i.test(p.name) ? docIcon(p.name) : 'prjpcb'} /><span class="tree-name">{p.name}{anyDirty && settings.projShowStatus ? ' *' : ''}</span>
                {vi?.repo && <VcsBadges p={p} />}
              </div>
              {!rows.length && <div class="tree-children"><div class="tree-row tree-none">No Documents Added</div></div>}
              {rows.length > 0 && settings.projGroup === 'none' && <div class="tree-children">
                {tree ? <>{hierRows(tree, src, row, `${p.id}:h`)}{src.filter((r) => !inTree(tree, r.name)).map((r) => row(r))}</> : src.map((r) => row(r))}
                {libs.map((r) => row(r))}{jobs.map((r) => row(r))}
                {made.map((d) => <DocRow key={d.id} name={d.name} on={d.id === activeId.value} open dirty={isDirty(d.id)} onOpen={() => { activeId.value = d.id; }} />)}
              </div>}
              {rows.length > 0 && settings.projGroup !== 'none' && <div class="tree-children">
                <Folder id={`${p.id}:src`} label="Source Documents" project={p.id} folder="src">
                  {tree ? <>{hierRows(tree, src, row, `${p.id}:h`)}{src.filter((r) => !inTree(tree, r.name)).map((r) => row(r))}</> : src.map((r) => row(r))}
                </Folder>
                {libs.length > 0 && (
                  <Folder id={`${p.id}:libs`} label="Libraries" project={p.id} folder="libs">
                    {!byType && libs.map((r) => row(r))}
                    {byType && libs.some((r) => /\.schlib$/i.test(r.name)) && <Folder id={`${p.id}:schlibs`} label="Schematic Library Documents" project={p.id} folder="schlibs">{libs.filter((r) => /\.schlib$/i.test(r.name)).map((r) => row(r))}</Folder>}
                    {byType && libs.some((r) => /\.pcblib$/i.test(r.name)) && <Folder id={`${p.id}:pcblibs`} label="PCB Library Documents" project={p.id} folder="pcblibs">{libs.filter((r) => /\.pcblib$/i.test(r.name)).map((r) => row(r))}</Folder>}
                    {byType && libs.some((r) => /\.(svn)?dblib$/i.test(r.name)) && <Folder id={`${p.id}:dblibs`} label="Database Libraries" project={p.id} folder="dblibs">{libs.filter((r) => /\.(svn)?dblib$/i.test(r.name)).map((r) => row(r))}</Folder>}
                    {byType && libs.filter((r) => !/\.(schlib|pcblib|dblib|svndblib)$/i.test(r.name)).map((r) => row(r))}
                  </Folder>
                )}
                {made.length > 0 && (
                  <Folder id={`${p.id}:generated`} label="Generated" project={p.id} folder="generated">
                    {made.map((d) => <DocRow key={d.id} name={d.name} on={d.id === activeId.value} open dirty={isDirty(d.id)} onOpen={() => { activeId.value = d.id; }} />)}
                  </Folder>
                )}
                {jobs.length > 0 && (
                  <Folder id={`${p.id}:settings`} label="Settings" project={p.id} folder="settings">
                    {byType ? <Folder id={`${p.id}:outjobs`} label="Output Job Files" project={p.id} folder="outjobs">{jobs.map((r) => row(r))}</Folder> : jobs.map((r) => row(r))}
                  </Folder>
                )}
              </div>}
            </div>
          );
        })}
        {loose.length > 0 && (
          <div class="tree-project">
            <div class="tree-row tree-project-row"><ColourIcon name="folderOpen" /><span class="tree-name">Free Documents</span></div>
            <div class="tree-children">
              <Folder id="free:src" label="Source Documents">
                {loose.map((d) => <DocRow key={d.id} name={d.name} on={d.id === activeId.value} open dirty={isDirty(d.id)} onOpen={() => { activeId.value = d.id; }} />)}
              </Folder>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A schematic's sheet symbols and ports (System › Projects Panel › Show Document Structure). */
function docStructure(p: Project, name: string): { kind: string; index: number; label: string; title: string }[] {
  const doc = projectSheet(p, name);
  if (!doc) return [];
  const out: { kind: string; index: number; label: string; title: string }[] = [];
  for (const o of doc.objects) {
    if (o.kind === 'sheetsymbol') { const n = symbolNames(doc, o.index); out.push({ kind: o.kind, index: o.index, label: `${n.designator || 'Sheet Symbol'}${n.fileName ? ` (${n.fileName})` : ''}`, title: 'Sheet symbol: double-click to go to it' }); }
    else if (o.kind === 'port') out.push({ kind: o.kind, index: o.index, label: `Port ${o.name}`, title: 'Port: double-click to go to it' });
  }
  return out;
}

type TreeRow = { name: string; path: string };
const inTree = (nodes: readonly HierNode[], name: string): boolean => nodes.some((n) => n.sheet.toLowerCase() === name.toLowerCase() || inTree(n.children, name));
function hierRows<R extends TreeRow>(nodes: readonly HierNode[], rows: R[], row: (r: R, twisty?: Twisty) => ComponentChildren, key: string): ComponentChildren {
  return nodes.map((n) => {
    const r = rows.find((x) => x.name.toLowerCase() === n.sheet.toLowerCase());
    if (!r) return null;
    const id = `${key}:${n.sheet.toLowerCase()}`, open = isOpen(id);
    const twisty = n.children.length ? { open, toggle: () => toggleFolder(id) } : undefined;
    return <div key={r.path} class="tree-hier">{row(r, twisty)}{n.children.length > 0 && open && <div class="tree-children">{hierRows(n.children, rows, row, id)}</div>}</div>;
  });
}

/* ─── Tab while placing on a board: the tool's settings in Altium's dialog ──────────── */

const TOOL_TITLES: Record<string, string> = { 'place-track': 'Line Constraints', route: 'Interactive Routing', 'place-pad': 'Pad', 'place-via': 'Via', 'place-string': 'String' };
export const hasToolProps = (toolId: string) => toolId in TOOL_TITLES;

export function ToolPropsDialog({ toolId }: { toolId: string }) {
  const close = () => { closeDialog(); active.value?.editor?.invalidateOverlay(); };
  const ed = active.value?.editor as unknown as { tool: { netLabel?: string; active?: boolean } } | undefined;
  const title = toolId === 'route' && ed?.tool.active && ed.tool.netLabel ? `Interactive Routing For Net [${ed.tool.netLabel}]` : TOOL_TITLES[toolId] ?? 'Properties';
  return (
    <Dialog title={title} width={toolId === 'route' ? 380 : 340} onClose={close} onAccept={() => { (document.activeElement as HTMLElement | null)?.blur(); close(); return false; }} class="toolprops"
      footer={<><span class="spacer" /><button class="btn default" onClick={close}>OK</button><button class="btn" onClick={close}>Cancel</button></>}>
      {(toolId === 'place-track' || toolId === 'route') && <TrackToolProps />}
      {toolId === 'place-pad' && <PadToolProps />}
      {toolId === 'place-via' && <ViaToolProps />}
      {toolId === 'place-string' && <StringToolProps />}
    </Dialog>
  );
}

function TrackToolProps() {
  void tick.value; // signals' shouldComponentUpdate skips prop-less children otherwise
  const ed = active.value?.editor as unknown as { trackWidth: number; units(): 'mil' | 'mm'; invalidateOverlay(): void; tool: { id: string; netLabel?: string; active?: boolean } };
  const u = ed.units();
  const v = u === 'mil' ? ed.trackWidth / 10_000 : ed.trackWidth / (10_000_000 / 25.4);
  const route = ed.tool.id === 'route';
  return (
    <div class="props">
      <h3>{route ? 'Interactive Routing' : 'Placing track'}</h3>
      {route && <dl><div class="prop"><dt>Net</dt><dd>{ed.tool.active ? ed.tool.netLabel : '(click a pad, via or track)'}</dd></div></dl>}
      <dl>
        <div class="prop"><dt>Width ({u})</dt><dd>
          <input id="tool-width" type="number" step="any" value={+v.toFixed(4)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Tab') (e.target as HTMLInputElement).blur(); }}
            onChange={(e) => {
              const n = parseFloat((e.target as HTMLInputElement).value);
              if (n > 0) { ed.trackWidth = Math.round(u === 'mil' ? n * 10_000 : n * (10_000_000 / 25.4)); ed.invalidateOverlay(); }
            }} />
        </dd></div>
      </dl>
      {route && <>
        <h3>Routing Conflict Resolution</h3>
        <div class="route-modes">
          {ROUTE_MODES.map(([m, label, k]) => (
            <label key={m} class={`chk${settings[k] ? '' : ' dim'}`}>
              <input type="radio" name="route-mode" checked={settings.pcbRoutingMode === m} onChange={() => { updateSettings({ pcbRoutingMode: m }); ed.invalidateOverlay(); }} /> {label}
            </label>
          ))}
        </div>
        <h3>Interactive Routing Options</h3>
        <div class="route-modes">
          {([['pcbAutoTerminate', 'Automatically Terminate Routing'], ['pcbRemoveLoops', 'Automatically Remove Loops'], ['pcbClearanceBoundaries', 'Display Clearance Boundaries']] as const).map(([k, label]) => (
            <label key={k} class="chk"><input type="checkbox" checked={!!settings[k]} onChange={(e) => { updateSettings({ [k]: (e.target as HTMLInputElement).checked }); ed.invalidateOverlay(); }} /> {label}</label>
          ))}
          <label class="do-row"><span>Gloss Effort (Routed)</span><select value={settings.pcbGlossRouted} onChange={(e) => updateSettings({ pcbGlossRouted: (e.target as HTMLSelectElement).value as 'off' | 'weak' | 'strong' })}>
            <option value="off">Off</option><option value="weak">Weak</option><option value="strong">Strong</option></select></label>
        </div>
      </>}
    </div>
  );
}

function PadToolProps() {
  void tick.value;
  const ed = active.value?.editor as unknown as { padTemplate: PadTemplate; units(): 'mil' | 'mm'; invalidateOverlay(): void; layerLabel(l: number): string };
  const t = ed.padTemplate, u = ed.units();
  const k = u === 'mil' ? 10_000 : 10_000_000 / 25.4;
  const num = (label: string, key: 'w' | 'h' | 'hole', id?: string) => (
    <div class="prop"><dt>{label} ({u})</dt><dd>
      <input id={id} type="number" step="any" min={0} value={+(t[key] / k).toFixed(4)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onChange={(e) => { const n = parseFloat((e.target as HTMLInputElement).value); if (n >= 0 && (key === 'hole' || n > 0)) { t[key] = Math.round(n * k); ed.invalidateOverlay(); } }} />
    </dd></div>
  );
  return (
    <div class="props">
      <h3>Placing pad</h3>
      <dl>
        <div class="prop"><dt>Designator</dt><dd><input id="tool-pad-designator" value={t.designator} onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => { t.designator = (e.target as HTMLInputElement).value.trim() || t.designator; ed.invalidateOverlay(); }} /></dd></div>
        <div class="prop"><dt>Layer</dt><dd><select value={String(t.layer)} onChange={(e) => { t.layer = Number((e.target as HTMLSelectElement).value); ed.invalidateOverlay(); }}>
          {[74, 1, 32].map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}
        </select></dd></div>
        <div class="prop"><dt>Shape</dt><dd><select value={t.shape} onChange={(e) => { t.shape = (e.target as HTMLSelectElement).value as PadTemplate['shape']; ed.invalidateOverlay(); }}>
          <option value="round">Round</option><option value="rect">Rectangular</option><option value="octagon">Octagonal</option>
        </select></dd></div>
        {num('X-Size', 'w')}
        {num('Y-Size', 'h')}
        {num('Hole Size', 'hole')}
      </dl>
      <p class="muted small">A hole makes it a Multi-Layer pad; without one it is an SMD pad on the chosen layer.</p>
    </div>
  );
}

/** Place › Via defaults: from the Routing Via Style rule until a size is typed. */
function ViaToolProps() {
  void tick.value;
  void cursorTick.value; // the rule's via size where the cursor is
  const ed = active.value?.editor as PcbEditor;
  const t = ed.viaTemplate, u = ed.units();
  const k = u === 'mil' ? 10_000 : 10_000_000 / 25.4;
  const cur = viaSize(ed, ed.cursor, 0xffff);
  const num = (label: string, key: 'diameter' | 'hole', id?: string) => (
    <div class="prop"><dt>{label} ({u})</dt><dd>
      <input id={id} type="number" step="any" min={0} value={+(cur[key] / k).toFixed(4)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onChange={(e) => { const n = parseFloat((e.target as HTMLInputElement).value); if (n > 0) { t.diameter = cur.diameter; t.hole = cur.hole; t[key] = Math.round(n * k); t.fromRule = false; ed.invalidateOverlay(); tick.value++; } }} />
    </dd></div>
  );
  return (
    <div class="props">
      <h3>Placing via</h3>
      <dl>
        {num('Diameter', 'diameter', 'tool-via-diameter')}
        {num('Hole Size', 'hole')}
        <div class="prop"><dt>Size from rule</dt><dd><input type="checkbox" checked={t.fromRule} onChange={(e) => { t.fromRule = (e.target as HTMLInputElement).checked; tick.value++; }} /></dd></div>
      </dl>
      <p class="muted small">The via takes the net of the copper it is placed on.</p>
    </div>
  );
}

/** Place › String defaults. */
function StringToolProps() {
  void tick.value;
  const ed = active.value?.editor as PcbEditor;
  const t = ed.stringTemplate, u = ed.units();
  const k = u === 'mil' ? 10_000 : 10_000_000 / 25.4;
  const num = (label: string, key: 'height' | 'width') => (
    <div class="prop"><dt>{label} ({u})</dt><dd>
      <input type="number" step="any" min={0} value={+(t[key] / k).toFixed(4)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onChange={(e) => { const n = parseFloat((e.target as HTMLInputElement).value); if (n > 0) { t[key] = Math.round(n * k); ed.invalidateOverlay(); } }} />
    </dd></div>
  );
  return (
    <div class="props">
      <h3>Placing string</h3>
      <dl>
        <div class="prop"><dt>Text</dt><dd><input id="tool-string-text" value={t.text} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onChange={(e) => { t.text = (e.target as HTMLInputElement).value || t.text; ed.invalidateOverlay(); tick.value++; }} /></dd></div>
        {num('Text Height', 'height')}
        {num('Stroke Width', 'width')}
        <div class="prop"><dt>Layer</dt><dd>{ed.layerLabel(ed.currentLayer)}</dd></div>
      </dl>
    </div>
  );
}

/* ─── File inspector: the reverse-engineering bench ──────────────────────────────────── */

const TEXT_STORAGES = /^(Board6|Nets6|Components6|Classes6|Rules6|Polygons6|Dimensions6|DifferentialPairs6|Library|Models|Parameters|EmbeddedBoards6|Embeddeds6)$/i;
const BIN_STORAGES = /^(Tracks6|Arcs6|Vias6|Pads6|Fills6|Texts6|Regions6|ShapeBasedRegions6)$/i;

export function FileInspectorPanel() {
  const od = active.value;
  const cfb = od && 'cfb' in od.doc ? od.doc.cfb : od?.doc.kind === 'PcbLib' ? od.doc.lib?.cfb ?? null : null;
  const [sel, setSel] = useState<string | null>(null);
  const entries = useMemo(() => {
    const out: { path: string; e: CfbEntry; depth: number }[] = [];
    if (cfb) walkCfb(cfb.root, (e, path) => out.push({ path, e, depth: path.split('/').length - 1 }));
    return out;
  }, [cfb]);
  return (
    <section class="panel docked" aria-label="File inspector">
      <div class="panel-body">
      {!cfb && <p class="panel-empty">{od ? `${od.name} isn't a compound file.` : 'Open a compound document (.SchDoc, .PcbDoc, .SchLib, .PcbLib) to see its streams.'}</p>}
      <div class="cfb-tree">
        {entries.map(({ path, e, depth }) => (
          <button key={path} class={`cfb-row${sel === path ? ' on' : ''}`} style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => setSel(path)} disabled={e.kind !== 'stream'}>
            <span>{e.name}</span>
            {e.kind === 'stream' && <span class="muted">{e.data.length.toLocaleString(locale())} B</span>}
          </button>
        ))}
      </div>
      {sel && cfb && <StreamView path={sel} data={entries.find((x) => x.path === sel)?.e.data ?? new Uint8Array()} />}
      </div>
    </section>
  );
}

function StreamView({ path, data }: { path: string; data: Uint8Array }) {
  const parts = path.split('/');
  const storage = parts.length > 1 ? parts.at(-2)! : '';
  const leaf = parts.at(-1)!;
  let body: preact.ComponentChildren;
  try {
    if (leaf === 'FileHeader' && data.length > 4 && data[3] === 0 && data[4] === 0x7c) {
      const recs = splitSchRecords(data);
      body = <RecordList rows={recs.map((r, i) => ({
        title: r.bag ? `${i === 0 ? 'header' : `#${i - 1} ${SR_NAME[r.bag.int('RECORD', -1)] ?? 'record ' + r.bag.getRaw('RECORD')}`}` : `#${i - 1} binary (${r.data.length} B)`,
        detail: r.bag ? Object.entries(r.bag.toObject()).map(([k, v]) => `${k}=${v}`).join('\n') : hexDump(r.data, 256),
      }))} />;
    } else if (leaf === 'Data' && TEXT_STORAGES.test(storage)) {
      const bags = splitTextRecords(data);
      body = <RecordList rows={bags.map((b, i) => ({ title: `#${i} ${b.get('NAME') ?? b.get('SOURCEDESIGNATOR') ?? b.get('PATTERN') ?? ''} (${b.size} keys)`, detail: Object.entries(b.toObject()).map(([k, v]) => `${k}=${v}`).join('\n') }))} />;
    } else if (leaf === 'Data' && BIN_STORAGES.test(storage)) {
      const recs = splitBinaryRecords(data);
      body = <RecordList rows={recs.map((r, i) => ({ title: `#${i} tag ${r.tag}, subrecords ${r.subs.map((s) => s.length).join('/')}`, detail: r.subs.map((s, k) => `sub ${k}\n${hexDump(s, 640)}`).join('\n\n') }))} />;
    } else {
      body = <pre class="hex">{hexDump(data, 4096)}</pre>;
    }
  } catch (e) {
    body = <><p class="error-text">Couldn't frame this stream: {(e as Error).message}</p><pre class="hex">{hexDump(data, 2048)}</pre></>;
  }
  return <div class="stream-view"><h3>{path}</h3>{body}</div>;
}

function RecordList({ rows }: { rows: { title: string; detail: string }[] }) {
  const shown = rows.slice(0, 400);
  return (
    <div class="records">
      {shown.map((r, i) => <details key={i}><summary>{r.title}</summary><pre>{r.detail}</pre></details>)}
      {rows.length > shown.length && <p class="muted">{rows.length - shown.length} more records not listed</p>}
    </div>
  );
}

/* ─── Messages ───────────────────────────────────────────────────────────────────────── */

const CLASS: Record<string, string> = { error: '[Error]', warn: '[Warning]', info: '[Info]' };

export function MessagesPanel() {
  const [showInfo, setShowInfo] = useState(settings.showInfoMessages);
  const flat = messages.value.filter((m) => showInfo || m.level !== 'info');
  const g = msgGroup.value, folded = msgFolded.value;
  type Head = { head: string; key: string; count: number };
  type Row = Message | Head;
  const isHead = (r: Row): r is Head => 'head' in r;
  let list: Row[] = flat;
  if (g !== 'none') {
    const groups = new Map<string, Message[]>();
    for (const m of flat) { const k = msgGroupKey(m, g); const l = groups.get(k); if (l) l.push(m); else groups.set(k, [m]); }
    list = [...groups].flatMap(([k, ms]): Row[] => [{ head: k || '(none)', key: k, count: ms.length }, ...(folded.has(k) ? [] : ms)]);
  }
  const selIdx = list.findIndex((m) => !isHead(m) && m.no === msgSel.value);
  const sel = selIdx < 0 ? null : selIdx;
  const setSel = (i: number | null) => {
    const r = i === null ? undefined : list[i];
    if (r && isHead(r)) { const f = new Set(folded); if (f.has(r.key)) f.delete(r.key); else f.add(r.key); msgFolded.value = f; return; }
    msgSel.value = r ? r.no : null;
  };
  const time = (t: number) => new Date(t).toLocaleTimeString(locale());
  const date = (t: number) => new Date(t).toLocaleDateString(locale());
  const cell = (f: (m: Message) => preact.ComponentChildren) => (r: Row) => (isHead(r) ? '' : f(r));
  return (
    <section class="messages panel" aria-label="Messages">
      <div class="msg-bar">
        <label class="msg-filter"><input type="checkbox" checked={showInfo} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setShowInfo(v); updateSettings({ showInfoMessages: v }); }} />Show information</label>
        {g !== 'none' && <span class="muted small">Grouped by {g}</span>}
        <button class="link" onClick={() => { messages.value = []; setSel(null); }}>Clear</button>
      </div>
      {/* Ctrl+C copies the selected message while the panel has the focus (the editors keep Ctrl+C for their own Copy) */}
      <div class="messages-body" data-ctx="messages" tabIndex={-1} onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && msgSel.value !== null) { e.preventDefault(); commands.run('msg.copy', activeScope.value); }
      }}>
      <Grid
        cols={[
          { label: 'Class', width: '230px', get: (r: Row) => (isHead(r)
            ? <span class="msg-head" aria-expanded={!folded.has(r.key)}>{folded.has(r.key) ? '▸' : '▾'} {r.head} ({r.count})</span>
            : <span class={`msg-class ${r.level}`} title={r.cls ?? CLASS[r.level]}>{r.cls ?? CLASS[r.level]}</span>) },
          { label: 'Document', width: '150px', get: cell((m) => m.doc) },
          { label: 'Source', width: '110px', get: cell((m) => m.source) },
          { label: 'Message', width: 'minmax(200px, 1fr)', get: cell((m) => m.message) },
          { label: 'Time', width: '72px', get: cell((m) => time(m.at)) },
          { label: 'Date', width: '80px', get: cell((m) => date(m.at)) },
          { label: 'No.', width: '44px', align: 'right', get: cell((m) => m.no) },
        ]}
        rows={list}
        sel={sel}
        onSel={setSel}
        onOpen={(i) => { const r = list[i]; if (r && !isHead(r)) r.locate?.(); }}
        empty={showInfo ? 'No messages.' : 'No warnings or errors.'}
        rowClass={(r) => (isHead(r) ? 'msg-grouprow' : `msg-${r.level}`)}
      />
      </div>
    </section>
  );
}
