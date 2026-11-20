/**
 * Right-click menus outside the documents, as Altium Designer 17 has them: document tabs, panel
 * title bars and tabs, the toolbar and menu bar area (Toolbars), the Projects tree (project,
 * document, folder, empty space), Messages and the PCB Library list. Elements say what they
 * are with data-ctx (and data-* details); the browser's own menu never shows, except in text
 * fields where its Cut / Copy / Paste belongs.
 */
import type { Scope } from '../core/commands';
import type { AccelNode } from '../core/keymap';
import { docBaseName } from '../formats/altium/prjpcb';
import { chromeMenu, nodes, parseCaption } from './menus';
import { setCtxFocus } from './workspace';
import { active, docs, projects, type Project } from './state';
import { panelContextMenu } from './dock/Dock';

const LIB = /\.(schlib|pcblib|intlib|pcb3dlib|dblink|dblib|svndblib)$/i;

const it = (caption: string, command?: string, extra: Partial<AccelNode> = {}): AccelNode => {
  const { label, key, accelAt } = parseCaption(caption);
  return { key, label, accelAt, command, ...extra };
};
const sep = (n: AccelNode): AccelNode => ({ ...n, separatorBefore: true });
const menu = (label: string, children: AccelNode[]): AccelNode => ({ key: '', label, children });

/** Documents under a Projects-tree folder (Source Documents, Libraries …). */
export function folderPaths(p: Project, folder: string): string[] {
  const all = p.prj.documents;
  switch (folder) {
    case 'src': return all.filter((x) => !LIB.test(x));
    case 'libs': return all.filter((x) => LIB.test(x));
    case 'schlibs': return all.filter((x) => /\.schlib$/i.test(x));
    case 'pcblibs': return all.filter((x) => /\.pcblib$/i.test(x));
    case 'dblibs': return all.filter((x) => /\.(svn)?dblib$/i.test(x));
    default: return [];
  }
}

function docTab(id: string): AccelNode | null {
  const od = docs.value.find((d) => d.id === id);
  if (!od) return null;
  const project = projects.value.find((p) => p.id === od.projectId) ?? null;
  setCtxFocus({ doc: { project, name: od.name } });
  return menu(od.name, [
    it('Close Current', 'wm.closeDoc'), it('Close All Documents', 'window.closeAll'),
    sep(it('Save', 'wm.saveDoc')),
    sep(it('Hide Current', 'window.hideCurrent')), it('Hide All Documents', 'window.hideAll'),
    sep(it('Split Vertical', 'window.splitVertical')), it('Split Horizontal', 'window.splitHorizontal'),
    sep(it('Tile All', 'window.tileAll')), it('Merge All', 'window.mergeAll'),
    sep(it('Open In New Window', 'window.openInNewWindow')),
  ]);
}


const toolbars = (scope: Scope): AccelNode => menu('Toolbars', nodes([['@toolbars'], 0, ['&Customise...', 'dxp.customize']], scope));

function footprints(): AccelNode | null {
  if (active.value?.doc.kind !== 'PcbLib') return null;
  return menu('PCB Library', [
    it('Ne&w Blank Component', 'tools.newFootprint'), it('&Component Wizard...', 'ad:CompMake:RunWizard'),
    sep(it('&Delete', 'tools.removeFootprint')),
    sep(it('Compon&ent Properties...', 'tools.footprintProperties')),
    sep(it('&Place...', 'ad:PCB:PlaceComponentFromLibraryEditor')),
    sep(it('&Update PCB With Current Footprint', 'ad:PCB:UpdateFootprintsFromLibrary')), it('Update PCB With &All Footprints', 'ad:PCB:UpdateAllFootprintsFromLibrary'),
  ]);
}

/** The menu for a right-click on el, or null when that spot has none. */
export function menuForElement(el: HTMLElement, scope: Scope): AccelNode | null {
  const host = el.closest<HTMLElement>('[data-ctx]');
  if (!host) return null;
  const d = host.dataset;
  const project = () => projects.value.find((p) => p.id === d.project) ?? null;
  switch (d.ctx) {
    case 'doctab': return docTab(d.doc ?? '');
    case 'panel': return d.panelId ? panelContextMenu(d.panelId, scope) : null;
    case 'toolbars': return toolbars(scope);
    case 'project': { const p = project(); if (!p) return null; setCtxFocus({ project: p }, `p:${p.id}`); return chromeMenu('wm_project', scope); }
    case 'document': {
      const p = project();
      const name = d.name ?? '';
      setCtxFocus({ doc: { project: p, name, path: d.path }, project: p }, `d:${p?.id ?? ''}:${name.toLowerCase()}`);
      return chromeMenu('wm_document', scope);
    }
    case 'category': {
      const p = project();
      if (!p) return null;
      setCtxFocus({ category: { project: p, paths: folderPaths(p, d.folder ?? '') } }, `c:${p.id}:${d.folder}`);
      return chromeMenu('wm_category', scope);
    }
    case 'workspace': setCtxFocus({}, host.classList.contains('tree-workspace-row') ? 'w' : null); return chromeMenu('wm_workspace', scope);
    case 'messages': return chromeMenu('wm_messages', scope);
    case 'footprints': return footprints();
    default: return null;
  }
}

/** Projects-tree row key, for highlighting the right-clicked row. */
export const docRowKey = (p: Project | null, path: string) => `d:${p?.id ?? ''}:${docBaseName(path).toLowerCase()}`;
