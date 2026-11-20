/**
 * Altium Designer 17's menus, built from the generated resource data (ad17.gen.ts): the menu bar
 * per editor, the single-key popups (S, X, M, A, J, Z, O, G, N …), the right-click menus and the
 * default shortcuts. Captions keep Altium's & accelerators; items Konium doesn't have yet
 * are registered as planned commands and show greyed. Lists Altium fills at run time (recent
 * projects, open windows, outputs …) come from providers registered here.
 */
import { commands, scopeIncludes, type Command, type Scope } from '../../core/commands';
import type { AccelNode, MenuRoot, Shortcut } from '../../core/keymap';
import { CONTEXT, MENUBAR, PLANNED, POPUPS, SHORTCUTS, TOOLBARS, type MenuSpec } from './ad17.gen';

/**
 * File › Import Wizard: an extension's item, which AD17's resources leave out of the File menu,
 * after Smart PDF in every editor's File menu, as AD17 lists it [est: its place]; Konium's Export
 * Wizard (to other tools' files) after it.
 */
for (const bar of Object.values(MENUBAR)) {
  const file = bar.find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&File' && Array.isArray(s[1]));
  if (!file || file[1].some((s) => Array.isArray(s) && s[1] === 'file.importWizard')) continue;
  const at = file[1].findIndex((s) => Array.isArray(s) && s[0] === 'S&mart PDF...');
  if (at >= 0) file[1].splice(at + 1, 0, ['&Import Wizard', 'file.importWizard'] as MenuSpec, ['Export &Wizard', 'file.exportWizard'] as MenuSpec);
}

/**
 * The schematic's right-click menu, first of all (Konium's): what a running sheet's Live Simulation can do with the wire,
 * pin or two-pin part right-clicked. Each shows only while it applies ("…WithContext").
 */
{
  const sch = CONTEXT.sch;
  if (Array.isArray(sch) && Array.isArray(sch[1]) && !(sch[1] as MenuSpec[]).some((s) => Array.isArray(s) && s[1] === 'live.monitorWithContext')) {
    (sch[1] as MenuSpec[]).unshift(['&Monitor Here', 'live.monitorWithContext'] as MenuSpec, ['Add to the &Scope', 'live.scopeWithContext'] as MenuSpec,
      ['View in a &New Scope', 'live.newScopeWithContext'] as MenuSpec, ['St&op Monitoring Here', 'live.unmonitorWithContext'] as MenuSpec, 0);
  }
}

/** Design › Netlist › Load a Netlist... (Konium's): first in the board's Netlist menu. */
{
  const design = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Design' && Array.isArray(s[1]));
  const netlist = design?.[1].find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Netlist' && Array.isArray(s[1]));
  if (netlist && !netlist[1].some((s) => Array.isArray(s) && s[1] === 'pcb.loadNetlist')) netlist[1].unshift(['&Load a Netlist...', 'pcb.loadNetlist'] as MenuSpec, 0);
}

/** Route › ActiveRoute (AD 18 and later): after Interactive Multi-Routing. */
{
  const route = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === 'Ro&ute' && Array.isArray(s[1]));
  if (route && !route[1].some((s) => Array.isArray(s) && s[1] === 'route.active')) {
    const at = route[1].findIndex((s) => Array.isArray(s) && s[1] === 'route.multi');
    route[1].splice(at + 1, 0, ['Activ&eRoute', 'route.active'] as MenuSpec);
  }
}

/**
 * Place › Wire Link (Konium's): after Place › Track, its I the Place menu's free letter (P, I); and on
 * the PCB Wiring toolbar after the routing tools.
 */
{
  const place = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Place' && Array.isArray(s[1]));
  if (place && !place[1].some((s) => Array.isArray(s) && s[1] === 'place.wireLink')) {
    const at = place[1].findIndex((s) => Array.isArray(s) && s[1] === 'route.interactive');
    place[1].splice(at < 0 ? place[1].length : at + 1, 0, ['W&ire Link', 'place.wireLink'] as MenuSpec);
  }
  const wiring = TOOLBARS['pcb.wiring']?.[2];
  if (wiring && !wiring.some((s) => Array.isArray(s) && s[1] === 'place.wireLink')) {
    const at = wiring.findIndex((s) => Array.isArray(s) && s[1] === 'route.diffPair');
    wiring.splice(at < 0 ? wiring.length : at + 1, 0, ['W&ire Link', 'place.wireLink'] as MenuSpec);
  }
}

/** Route › Auto Route › Export Specctra Design… and Import Specctra Session… (Konium's: an outside autorouter's way there and back), after Pause. */
{
  const route = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === 'Ro&ute' && Array.isArray(s[1]));
  const auto = route?.[1].find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Auto Route' && Array.isArray(s[1]));
  if (auto && !auto[1].some((s) => Array.isArray(s) && s[1] === 'route.specctraImport')) {
    auto[1].push(0 as unknown as MenuSpec, ['Export Specctra &Design...', 'file.exportSpecctra'] as MenuSpec, ['&Import Specctra Session...', 'route.specctraImport'] as MenuSpec);
  }
}

/** Design › Fab-House Profile… (Konium's): after the Rule Wizard. */
{
  const design = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Design' && Array.isArray(s[1]));
  if (design && !design[1].some((s) => Array.isArray(s) && s[1] === 'design.fabProfile')) {
    const at = design[1].findIndex((s) => Array.isArray(s) && s[1] === 'ad:PCB:RunRuleWizard');
    design[1].splice(at + 1, 0, ['&Fab-House Profile...', 'design.fabProfile'] as MenuSpec);
  }
}

/** Tools › Component Builder… (Konium's) in both library editors: after New Component, and after the Component Wizard. */
for (const [scope, after] of [['schlib', 'schlib.newComponent'], ['pcblib', 'ad:CompMake:RunWizard']] as const) {
  const tools = (MENUBAR[scope] ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Tools' && Array.isArray(s[1]));
  if (!tools || tools[1].some((s) => Array.isArray(s) && s[1] === 'ai.componentBuilder')) continue;
  const at = tools[1].findIndex((s) => Array.isArray(s) && s[1] === after);
  // No accelerator: the letters of its name are taken in one menu or the other
  tools[1].splice(at + 1, 0, ['Component Builder...', 'ai.componentBuilder'] as MenuSpec, ['Parts...', 'parts.panel'] as MenuSpec);
}

/** File › New › Multi-board Schematic and Multi-board Assembly (AD 18 and later), after the Draftsman document, in every editor's File menu. */
for (const bar of Object.values(MENUBAR)) {
  const file = bar.find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&File' && Array.isArray(s[1]));
  const nw = file?.[1].find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&New' && Array.isArray(s[1]));
  if (!nw || nw[1].some((s) => Array.isArray(s) && s[1] === 'file.newMbs')) continue;
  const at = nw[1].findIndex((s) => Array.isArray(s) && s[1] === 'file.newDraftsman');
  const more = [['Multi-board Sc&hematic', 'file.newMbs'], ['Multi-board &Assembly', 'file.newMba'], ['D&iagram', 'file.newDiagram'], ['E&nclosure', 'file.newEnclosure'], ['&Requirements', 'file.newRequirements']] as MenuSpec[];
  // The general File menu (no document, or one with no editor of its own) has no Draftsman entry: at its end
  if (at >= 0) nw[1].splice(at + 1, 0, ...more); else nw[1].push(...more);
}

/**
 * Project › Version Control (Konium's: Git, in Konium's store or the team's own server) after the
 * Project Packager in every editor's Project menu, and in the Projects panel's project and
 * document menus after Explore; File › Open Project from Version Control after Open Project.
 * [est: AD 17 has its own Version Control items, which its resources here leave out]
 */
{
  const vcItems = (): MenuSpec[] => [['&Add Project to Version Control...', 'vcs.add'], 0, ['&Commit Whole Project...', 'vcs.commit'], ['&Update Whole Project', 'vcs.update'], ['&Push', 'vcs.push'], 0, ['&History...', 'vcs.history'], ['&Document History...', 'vcs.docHistory'], 0, ['&Lock', 'vcs.lock'], ['U&nlock', 'vcs.unlock'], 0, ['Repository &Settings...', 'vcs.settings']];
  const sub = (): MenuSpec => ['Version Con&trol', vcItems()];
  for (const bar of Object.values(MENUBAR)) {
    const prj = bar.find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === 'Proje&ct' && Array.isArray(s[1]));
    if (prj && !prj[1].some((s) => Array.isArray(s) && s[0] === 'Version Con&trol')) {
      const at = prj[1].findIndex((s) => Array.isArray(s) && s[1] === 'ad:WorkspaceManager:Archive');
      prj[1].splice(at + 1, 0, sub());
    }
    const file = bar.find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&File' && Array.isArray(s[1]));
    if (file && !file[1].some((s) => Array.isArray(s) && s[1] === 'vcs.clone')) {
      const at = file[1].findIndex((s) => Array.isArray(s) && s[1] === 'file.openProject');
      if (at >= 0) file[1].splice(at + 1, 0, ['Open Project from Version Control...', 'vcs.clone'] as MenuSpec);
    }
  }
  for (const [key, docMenu] of [['wm_project', false], ['wm_document', true]] as const) {
    const m = CONTEXT[key];
    if (!Array.isArray(m) || !Array.isArray(m[1]) || m[1].some((s) => Array.isArray(s) && s[0] === 'Version Con&trol')) continue;
    const at = m[1].findIndex((s) => Array.isArray(s) && /Explore/.test(s[0]));
    const items: MenuSpec[] = docMenu ? [['&Commit Whole Project...', 'vcs.commit'], ['&Update Whole Project', 'vcs.update'], 0, ['Document &History...', 'vcs.docHistory'], 0, ['&Lock', 'vcs.lock'], ['U&nlock', 'vcs.unlock']] : vcItems();
    m[1].splice(at + 1, 0, ['Version Con&trol', items]);
  }
}

/** Tools › Convert › Create Pad from Selected Primitives (Konium's polygon pads), after Create Region, wherever that is. */
{
  const add = (items: MenuSpec[]): void => {
    for (const it of items) if (Array.isArray(it) && Array.isArray(it[1])) add(it[1]);
    const at = items.findIndex((it) => Array.isArray(it) && it[1] === 'ad:PCB:ConvertSelectedToRegion');
    if (at >= 0 && !items.some((it) => Array.isArray(it) && it[1] === 'pcb.padFromSelection')) items.splice(at + 1, 0, ['Create Pad from &Selected Primitives', 'pcb.padFromSelection']);
  };
  for (const bar of Object.values(MENUBAR)) add(bar);
  for (const m of Object.values(CONTEXT)) if (Array.isArray(m) && Array.isArray(m[1])) add(m[1] as MenuSpec[]);
}

/** Tools › Design Adviser… (Konium's) in the schematic editor, with the problem finders, and in the PCB editor. */
{
  const tools = (MENUBAR.sch ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Tools' && Array.isArray(s[1]));
  if (tools && !tools[1].some((s) => Array.isArray(s) && s[1] === 'ai.adviser')) {
    const at = tools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ad:WorkspaceManager:HarnessDefinitionResolver');
    tools[1].splice(at + 1, 0, ['Des&ign Adviser...', 'ai.adviser'] as MenuSpec);
  }
  // …and in the PCB editor, after the design rule check
  const pcbTools = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Tools' && Array.isArray(s[1]));
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'ai.adviser')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'tools.resetMarkers');
    pcbTools[1].splice(at + 1, 0, ['Des&ign Adviser...', 'ai.adviser'] as MenuSpec);
  }
  // Layout Planner (Konium's, R20): after the adviser in the PCB editor
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'ai.layoutPlanner')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.adviser');
    pcbTools[1].splice(at + 1, 0, ['Layout Planner...', 'ai.layoutPlanner'] as MenuSpec);
  }
  // Make Free-Flowing (Konium's, R20): in Route, after Retrace Selected
  const pcbRoute = (MENUBAR.pcb ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === 'Ro&ute' && Array.isArray(s[1]));
  if (pcbRoute && !pcbRoute[1].some((s) => Array.isArray(s) && s[1] === 'route.makeFlowing')) {
    const at = pcbRoute[1].findIndex((s) => Array.isArray(s) && s[1] === 'ad:PCB:Retrace');
    pcbRoute[1].splice(at + 1, 0, ['Make Free-Flo&wing', 'route.makeFlowing'] as MenuSpec);
  }
  // Smart Router (Konium's, R20): after the planner
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'ai.smartRouter')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.layoutPlanner');
    pcbTools[1].splice(at + 1, 0, ['Smart Router...', 'ai.smartRouter'] as MenuSpec);
  }
  // …and the two as one run: after the router
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'ai.boardRun')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.smartRouter');
    pcbTools[1].splice(at + 1, 0, ['Plan, Place and Route...', 'ai.boardRun'] as MenuSpec);
  }
  // Parts (Konium's, R21): after the adviser in the schematic editor, after the run in the PCB editor
  if (tools && !tools[1].some((s) => Array.isArray(s) && s[1] === 'parts.panel')) {
    const at = tools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.adviser');
    tools[1].splice(at + 1, 0, ['Parts...', 'parts.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'parts.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.boardRun');
    pcbTools[1].splice(at + 1, 0, ['Parts...', 'parts.panel'] as MenuSpec);
  }
  // Signal Integrity (AD's; its I is the adviser's here): before the adviser in the schematic editor, after Re-Annotate in the PCB editor
  if (tools && !tools[1].some((s) => Array.isArray(s) && s[1] === 'si.panel')) {
    const at = tools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ai.adviser');
    tools[1].splice(at, 0, ['Signal In&tegrity...', 'si.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'si.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'ad:PCB:ReAnnotate');
    pcbTools[1].splice(at + 1, 0, ['Signal In&tegrity...', 'si.panel'] as MenuSpec);
  }
  // Power Analysis (Konium's): after Signal Integrity
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'power.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'si.panel');
    pcbTools[1].splice(at + 1, 0, ['Power &Analysis...', 'power.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'thermal.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'power.panel');
    pcbTools[1].splice(at + 1, 0, ['Thermal Anal&ysis...', 'thermal.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'emc.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'thermal.panel');
    pcbTools[1].splice(at + 1, 0, ['EMC Chec&k...', 'emc.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'field.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'emc.panel');
    pcbTools[1].splice(at + 1, 0, ['&Field Solver...', 'field.panel'] as MenuSpec);
  }
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'pdn.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'power.panel');
    pcbTools[1].splice(at + 1, 0, ['S&upply Impedance...', 'pdn.panel'] as MenuSpec);
  }
  // Antenna Analysis (Konium's): after the Field Solver (every letter of its name is another item's here)
  if (pcbTools && !pcbTools[1].some((s) => Array.isArray(s) && s[1] === 'antenna.panel')) {
    const at = pcbTools[1].findIndex((s) => Array.isArray(s) && s[1] === 'field.panel');
    pcbTools[1].splice(at + 1, 0, ['Antenna Analysis...', 'antenna.panel'] as MenuSpec);
  }
}

/** Help › User Guide (before Shortcut Keys) and Help › Scripting Reference (after), in every editor's Help menu. */
for (const scope of Object.keys(MENUBAR)) {
  const h = (MENUBAR[scope] ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Help' && Array.isArray(s[1]));
  if (!h || h[1].some((s) => Array.isArray(s) && s[1] === 'help.scripting')) continue;
  const at = h[1].findIndex((s) => Array.isArray(s) && s[1] === 'help.shortcuts');
  h[1].splice(at + 1, 0, ['Scr&ipting Reference', 'help.scripting'] as MenuSpec);
  h[1].splice(Math.max(0, at), 0, ['&User Guide', 'help.guide'] as MenuSpec);
}

/** Tools › Scripts... (Konium's scripting) in the PCB and PCB library editors, before Preferences. */
for (const scope of ['pcb', 'pcblib']) {
  const t = (MENUBAR[scope] ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Tools' && Array.isArray(s[1]));
  if (!t || t[1].some((s) => Array.isArray(s) && s[1] === 'tools.scripts')) continue;
  let at = t[1].findIndex((s) => Array.isArray(s) && /Preferences/.test(s[0]));
  if (at < 0) at = t[1].length;
  t[1].splice(at, 0, ...(t[1][at - 1] === 0 ? [] : [0 as MenuSpec]), ['Sc&ripts...', 'tools.scripts'] as MenuSpec, 0);
}

/** Tools › Calculators... (Konium's) in every editor's Tools menu: after Scripts where that is, else in a block of its own before Preferences. */
for (const scope of ['sch', 'schlib', 'pcb', 'pcblib']) {
  const t = (MENUBAR[scope] ?? []).find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&Tools' && Array.isArray(s[1]));
  if (!t || t[1].some((s) => Array.isArray(s) && s[1] === 'tools.calculators')) continue;
  const item = ['Calculators...', 'tools.calculators'] as MenuSpec, scripts = t[1].findIndex((s) => Array.isArray(s) && s[1] === 'tools.scripts');
  if (scripts >= 0) { t[1].splice(scripts + 1, 0, item); continue; }
  let at = t[1].findIndex((s) => Array.isArray(s) && /Preferences/.test(s[0]));
  if (at < 0) at = t[1].length;
  t[1].splice(at, 0, ...(t[1][at - 1] === 0 ? [] : [0 as MenuSpec]), item, 0);
}

/**
 * Documents without an editor of their own (Output Job, BOM document, Draftsman …): the general
 * menus, with File › Save, Save As and Save Copy As before Save Project, as every other document's
 * File menu has them (the general one, with no document open, has none).
 */
if (MENUBAR.global && !MENUBAR.inspect) {
  const bar = structuredClone(MENUBAR.global);
  const file = bar.find((s): s is [string, MenuSpec[]] => Array.isArray(s) && s[0] === '&File' && Array.isArray(s[1]));
  if (file) {
    let at = file[1].findIndex((s) => Array.isArray(s) && s[1] === 'wm.saveProject');
    if (at < 0) at = file[1].findIndex((s) => Array.isArray(s) && s[1] === 'file.saveAll');
    if (at >= 0) file[1].splice(at, 0, ['&Save', 'file.save'], ['Save &As...', 'file.saveAs'], ['Save Cop&y As...', 'file.saveCopyAs'], 0);
  }
  MENUBAR.inspect = bar;
}

/** "Annotate Schematics Q&uietly..." → label, accelerator key and its position; && is a literal &. */
export function parseCaption(caption: string): { label: string; key: string; accelAt?: number } {
  let label = '', key = '', accelAt: number | undefined;
  for (let i = 0; i < caption.length; i++) {
    const c = caption[i]!;
    if (c === '&') {
      if (caption[i + 1] === '&') { label += '&'; i++; continue; }
      const n = caption[i + 1];
      if (n && accelAt === undefined && n !== ' ') { accelAt = label.length; key = n.toUpperCase(); }
      continue;
    }
    label += c;
  }
  return { label: label.trim(), key, accelAt };
}

/** Run-time lists: '@recentProjects', '@windows', '@fabOutputs' … */
type Provider = (scope: Scope) => AccelNode[];
const providers = new Map<string, Provider>();
export function registerMenuProvider(name: string, fn: Provider): void { providers.set(name, fn); }

const SCOPE_TABLE: Partial<Record<Scope, string>> = { sch: 'sch', pcb: 'pcb', pcblib: 'pcblib', global: 'global', inspect: 'global', schlib: 'schlib', simview: 'simview', cam: 'cam', simtext: 'simtext' };

/** Menu nodes from specs; a submenu builds its children when opened (so run-time lists are current). */
export function nodes(specs: readonly MenuSpec[], scope: Scope): AccelNode[] {
  {
    const out: AccelNode[] = [];
    let sep = false;
    for (const s of specs) {
      if (s === 0) { sep = out.length > 0; continue; }
      if (s.length === 1) {
        const got = providers.get(s[0])?.(scope) ?? [];
        got.forEach((n, i) => out.push(i === 0 && sep ? { ...n, separatorBefore: true } : n));
        if (got.length) sep = false;
        continue;
      }
      const { label, key, accelAt } = parseCaption(s[0]);
      let n: AccelNode;
      if (Array.isArray(s[1])) {
        const kids = s[1] as MenuSpec[];
        n = { key, label, accelAt };
        Object.defineProperty(n, 'children', { get: () => nodes(kids, scope), enumerable: true, configurable: true });
      } else n = { key, label, accelAt, command: s[1] as string };
      if (sep) { n.separatorBefore = true; sep = false; }
      out.push(n);
    }
    return out;
  }
}

/** The menu bar and popup roots for every editor. */
export function buildMenus(): MenuRoot[] {
  const roots: MenuRoot[] = [];
  const scopes: Scope[] = ['global', 'sch', 'pcb', 'pcblib', 'inspect', 'schlib', 'simview', 'simtext', 'cam'];
  for (const scope of scopes) {
    const table = SCOPE_TABLE[scope]!;
    // (a scope with a menu bar of its own over the table it shares: inspect's File › Save)
    const bar = MENUBAR[scope] ?? MENUBAR[table] ?? [];
    for (const s of bar) {
      if (s === 0 || s.length === 1 || !Array.isArray(s[1])) continue;
      const { label, key: alt, accelAt } = parseCaption(s[0]);
      const popup = (s[2] as string | undefined) ?? '';
      const kids = s[1] as MenuSpec[];
      const root = { key: popup, label, accelAt, alt, scopes: [scope], inMenuBar: true } as MenuRoot;
      Object.defineProperty(root, 'children', { get: () => nodes(kids, scope), enumerable: true, configurable: true });
      roots.push(root);
    }
    // Single-key popups: submenus with a popup letter (Select S, Move M …), then the extra popups
    const seen = new Set(roots.filter((r) => r.scopes[0] === scope && r.key).map((r) => r.key));
    const visit = (list: readonly MenuSpec[]) => {
      for (const s of list) {
        if (s === 0 || s.length === 1 || !Array.isArray(s[1])) continue;
        const popup = s[2] as string | undefined;
        if (popup && /^[A-Z]$/.test(popup) && !seen.has(popup)) {
          seen.add(popup);
          const { label, accelAt } = parseCaption(s[0]);
          const kids = s[1] as MenuSpec[];
          const root = { key: popup, label, accelAt, scopes: [scope], inMenuBar: false } as MenuRoot;
          Object.defineProperty(root, 'children', { get: () => nodes(kids, scope), enumerable: true, configurable: true });
          roots.push(root);
        }
        visit(s[1] as MenuSpec[]);
      }
    };
    visit(bar);
    visit(POPUPS[table] ?? []);
  }
  return roots;
}

/** The DXP menu (Preferences, Customize): Konium's logo opens it. */
export function systemMenu(scope: Scope): AccelNode {
  return { key: '', label: 'DXP', children: nodes(MENUBAR.dxp ?? [], scope) };
}

/**
 * The right-click menu: Altium's, without what isn't available here (planned items, empty
 * groups), as Altium leaves out the actions that don't apply to what was clicked.
 */
export function contextMenuFor(scope: Scope, onObject: boolean): AccelNode {
  const table = SCOPE_TABLE[scope]!;
  const spec = (onObject && CONTEXT[`${table}_object`]) || CONTEXT[table];
  const kids = spec && Array.isArray(spec[1]) ? nodes(spec[1] as MenuSpec[], scope) : [];
  return { key: '', label: 'Context', children: prune(kids, scope) };
}

/**
 * A panel's or the workspace's right-click menu (Projects tree, Messages …) as Altium lists it:
 * items Konium doesn't have yet stay, greyed, as on the menu bar.
 */
export function chromeMenu(name: string, scope: Scope): AccelNode | null {
  const spec = CONTEXT[name];
  if (!Array.isArray(spec) || !Array.isArray(spec[1])) return null;
  return { key: '', label: parseCaption(spec[0]).label, children: nodes(spec[1] as MenuSpec[], scope) };
}

function prune(list: AccelNode[], scope: Scope): AccelNode[] {
  const out: AccelNode[] = [];
  let sep = false;
  for (const n of list) {
    if (n.separatorBefore && out.length) sep = true;
    let keep: AccelNode | null = n;
    if (n.children) {
      const kids = prune(n.children, scope);
      keep = kids.length ? { ...n, children: kids, separatorBefore: false } : null;
    } else if (n.command) {
      const c = commands.get(n.command);
      // "…WithContext" items apply to what was right-clicked: they show only when they do
      if (!c || c.planned || !scopeIncludes(c.scopes, scope) || (/WithContext$/.test(c.id) && c.enabled && !c.enabled())) keep = null;
      else keep = { ...n, separatorBefore: false };
    } else if (n.disabled) keep = null;
    if (!keep) continue;
    if (sep) { keep.separatorBefore = true; sep = false; }
    out.push(keep);
  }
  return out;
}

/** Planned commands for every Altium item Konium doesn't have yet. */
export function plannedCommands(notify: (msg: string) => void): Command[] {
  const out: Command[] = [];
  for (const [id, [label, scopes]] of Object.entries(PLANNED)) {
    if (commands.get(id)) continue;
    const sc = scopes.filter((x) => x !== 'global') as Scope[];
    out.push({ id, label, scopes: sc.length && !scopes.includes('global') ? sc : undefined, planned: true, run: () => notify(`${label.replace(/\.\.\.$/, '')} is on the roadmap`) });
  }
  return out;
}

/** Altium's default shortcuts, for the commands they belong to. */
export function ad17Shortcuts(): Shortcut[] {
  return SHORTCUTS.map(([combo, command, scopes]) => ({ combo, command, scopes: scopes.filter((s) => s !== 'global').length && !scopes.includes('global') ? scopes as Scope[] : undefined }));
}
