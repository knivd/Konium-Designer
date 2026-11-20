import { compileProject, type CompiledProject, type ObjRef, type SheetInput } from '../model/compile';
import { settings } from '../core/settings';
import { readSchDoc } from '../formats/altium/schdoc';
import { docBaseName, iniGet } from '../formats/altium/prjpcb';
import { readErc } from '../model/erc';
import { DIR_VECTORS, SR, type SchDocument } from '../model/sch';
import type { Vec2 } from '../core/geom';
import { SchEditor } from '../editors/sch/SchEditor';
import { sheetHierarchy, type HierNode } from '../model/schHierarchy';
import { active, activeId, docs, notify, projects, replaceMessages, tick, type Project } from './state';
import { showPanel } from './dock/store';
import { openDocument } from './actions';
import { compiled, type CompileResult } from './compiled';
import type { Editor } from '../editors/Editor';

/**
 * Project-level actions: compile (Project › Compile PCB Project), cross-probing from Messages
 * and the Navigator, and access to every schematic sheet of a project whether or not it is
 * open in a tab.
 */

export { compiled, sheetViolations, type CompileResult } from './compiled';

/** The project the active document belongs to (or null for a free document). */
export function activeProject(): Project | null {
  const d = active.value;
  return d?.projectId ? projects.value.find((p) => p.id === d.projectId) ?? null : null;
}

/** Every schematic of a project: live models for open tabs, freshly read ones for the rest. */
export function projectSheets(p: Project | null): SheetInput[] {
  if (!p) {
    const d = active.value;
    return d?.doc.kind === 'SchDoc' ? [{ name: d.name, doc: d.doc as SchDocument }] : [];
  }
  const out: SheetInput[] = [];
  for (const path of p.prj.documents) {
    const name = docBaseName(path);
    if (!/\.schdoc$/i.test(name)) continue;
    const open = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
    if (open?.doc.kind === 'SchDoc') { out.push({ name, doc: open.doc as SchDocument }); continue; }
    const f = p.files.get(name.toLowerCase());
    if (!f) continue;
    // Closed sheets are read once per version of their file (they are only read from, never edited here)
    const doc = parsed(f.bytes, name);
    if (doc) out.push({ name, doc });
  }
  // Device sheets the symbols stand for, read where the project keeps its files
  for (let i = 0; i < out.length; i++) {
    for (const o of out[i]!.doc.objects) {
      if (o.kind !== 'sheetsymbol' || !o.device) continue;
      const fn = out[i]!.doc.objects.find((x) => x.owner === o.index && x.record === SR.FILE_NAME);
      const name = fn?.kind === 'text' ? fn.text.split(/[\\/]/).pop()! : '';
      if (!name || out.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
      const f = p.files.get(name.toLowerCase());
      const doc = f ? parsed(f.bytes, name) : null;
      if (doc) out.push({ name, doc });
    }
  }
  return out;
}

const parsedSheets = new WeakMap<Uint8Array, SchDocument | null>();
function parsed(bytes: Uint8Array, name: string): SchDocument | null {
  let doc = parsedSheets.get(bytes);
  if (doc === undefined) { try { doc = readSchDoc(bytes, name); } catch { doc = null; } parsedSheets.set(bytes, doc); }
  return doc;
}
/** A project's schematic by name: as open (unsaved changes included), else read from its file. */
export function projectSheet(p: Project, name: string): SchDocument | null {
  const open = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
  if (open?.doc.kind === 'SchDoc') return open.doc as SchDocument;
  const f = p.files.get(name.toLowerCase());
  return f ? parsed(f.bytes, name) : null;
}
const trees = new Map<string, { tick: number; roots: HierNode[] | null }>();

/**
 * The Projects panel's sheet tree, as Altium shows it as soon as a project opens: each child
 * sheet under the sheet whose symbol stands for it, in the project's document order. Null for
 * a flat project. Recomputed when documents change; closed sheets are read once.
 */
export function projectTree(p: Project): HierNode[] | null {
  const t = tick.value;
  const hit = trees.get(p.id);
  if (hit && hit.tick === t) return hit.roots;
  const sheets: { name: string; doc: SchDocument }[] = [];
  for (const path of p.prj.documents) {
    const name = docBaseName(path);
    if (!/\.schdoc$/i.test(name)) continue;
    const open = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
    if (open?.doc.kind === 'SchDoc') { sheets.push({ name, doc: open.doc as SchDocument }); continue; }
    const f = p.files.get(name.toLowerCase());
    if (!f) continue;
    const doc = parsed(f.bytes, name);
    if (doc) sheets.push({ name, doc });
  }
  const roots = sheets.length > 1 ? sheetHierarchy(sheets, 'documents').roots : [];
  const out = roots.some((r) => r.children.length) ? roots : null;
  trees.set(p.id, { tick: t, roots: out });
  return out;
}

/** What a compile of the project goes by: Project Options › Error Reporting, Connection Matrix, Net Identifier Scope. */
export const compileOptions = (p: Project | null) => ({ erc: readErc(p?.prj ?? null), scope: Number(p ? iniGet(p.prj, 'Design', 'HierarchyMode') ?? 0 : 0) || 0,
  allowSheetEntryNetNames: !p || iniGet(p.prj, 'Design', 'AllowSheetEntryNetNames') !== '0', allowPortNetNames: !!p && iniGet(p.prj, 'Design', 'AllowPortNetNames') === '1',
  powerPortNamesTakePriority: !!p && iniGet(p.prj, 'Design', 'PowerPortNamesTakePriority') === '1',
  channelFormat: p ? iniGet(p.prj, 'Design', 'ChannelDesignatorFormatString') ?? undefined : undefined, channelSeparator: p ? iniGet(p.prj, 'Design', 'ChannelRoomLevelSeperator') ?? undefined : undefined });

const messageClass = (m: CompiledProject['messages'][number]) => (m.fatal ? '[Fatal Error]' : undefined);

export function cmdCompile(p: Project | null = activeProject(), only?: SheetInput[]): CompileResult | null {
  const sheets = only ?? projectSheets(p);
  if (!sheets.length) { notify('Nothing to compile: open a schematic or a project with schematics', 'error'); return null; }
  const result = compileProject(sheets, compileOptions(p));
  const res: CompileResult = { projectId: p?.id ?? null, name: only ? sheets[0]!.name : p?.name ?? sheets[0]!.name, at: Date.now(), result, sheets };
  compiled.value = res;
  const count = (f: (m: CompiledProject['messages'][number]) => boolean) => result.messages.filter(f).length;
  const fatal = count((m) => !!m.fatal);
  replaceMessages('Compiler', [
    ...result.messages.map((m) => ({ doc: m.sheet, level: m.level, cls: messageClass(m), message: m.message, locate: m.refs.length ? () => crossProbe(m.refs, p) : undefined })),
    { doc: res.name, level: fatal ? 'error' as const : 'info' as const,
      message: fatal ? `Compile halted: ${fatal} fatal error${fatal > 1 ? 's' : ''}`
        : `Compile successful, ${result.components.length} components, ${result.nets.length} nets, ${count((m) => m.level === 'error')} errors, ${count((m) => m.level === 'warn')} warnings` },
  ]);
  if (result.messages.some((m) => m.level !== 'info')) showPanel('messages');
  // Errors & Warnings markers on the sheets
  for (const d of docs.value) d.editor?.invalidate();
  notify(`Compiled ${res.name}: ${result.messages.length ? `${result.messages.length} message${result.messages.length > 1 ? 's' : ''}` : 'no errors'}`);
  return res;
}

/** Run fn once the editor's viewport is mounted (a tab that was just activated mounts on the next render). */
export function whenMounted(ed: Editor, fn: () => void, tries = 40): void {
  if (ed.viewport) { fn(); return; }
  if (tries > 0) setTimeout(() => whenMounted(ed, fn, tries - 1), 25);
}

/**
 * System › Navigation › Connection Graph: the points of a net's objects on a sheet (pin ends, ports,
 * power ports, net labels) joined by the shortest lines that link them all.
 */
export function connectionGraph(doc: SchDocument, indices: number[]): [Vec2, Vec2][] {
  const pts: Vec2[] = [];
  for (const i of indices) {
    const o = doc.objects[i];
    if (!o) continue;
    if (o.kind === 'pin') { const d = DIR_VECTORS[o.orient]!; pts.push({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length }); }
    else if (o.kind === 'power' || o.kind === 'port' || (o.kind === 'text' && o.role === 'netlabel')) pts.push(o.at);
  }
  const uniq = [...new Map(pts.map((p) => [`${p.x},${p.y}`, p])).values()];
  if (uniq.length < 2) return [];
  const out: [Vec2, Vec2][] = [];
  const inTree = new Set([0]);
  while (inTree.size < uniq.length) {
    let best: [number, number, number] | null = null;
    for (const a of inTree) for (let b = 0; b < uniq.length; b++) {
      if (inTree.has(b)) continue;
      const d = Math.hypot(uniq[a]!.x - uniq[b]!.x, uniq[a]!.y - uniq[b]!.y);
      if (!best || d < best[2]) best = [a, b, d];
    }
    if (!best) break;
    out.push([uniq[best[0]]!, uniq[best[1]]!]);
    inTree.add(best[1]);
  }
  return out;
}

/** Open the sheet holding the objects, select them and zoom to them (Altium's cross-probe). */
export function crossProbe(refs: ObjRef[], p: Project | null = activeProject()): void {
  if (!refs.length) return;
  const sheet = refs[0]!.sheet;
  let od = docs.value.find((d) => d.name.toLowerCase() === sheet.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null));
  if (!od && p) {
    const f = p.files.get(sheet.toLowerCase());
    if (f) od = openDocument(f, p.id) ?? undefined;
  }
  if (!od?.editor) { notify(`${sheet} isn't open`, 'error'); return; }
  activeId.value = od.id;
  const ed = od.editor;
  const doc = od.doc as SchDocument;
  const keys = new Set<string>(), passing: number[] = [];
  for (const r of refs) {
    if (r.sheet.toLowerCase() !== sheet.toLowerCase()) continue;
    const o = doc.objects[r.index];
    if (!o) continue;
    // System › Navigation › Include Power Parts: a net's power ports only when asked
    if (o.kind === 'power' && !settings.navPowerParts && refs.length > 1) continue;
    const owner = o.owner >= 0 ? doc.objects[o.owner] : undefined;
    keys.add(owner?.kind === 'component' ? `o${owner.index}` : `o${o.index}`);
    passing.push(owner?.kind === 'component' ? owner.index : o.index);
  }
  whenMounted(ed, () => {
    // System › Navigation › Highlight Methods: zoom to them, mask the rest, select them
    const before = ed.selection;
    ed.selection = keys;
    if (settings.navZoom) ed.jumpToSelection(30_000_000); // at least 3000 mil across, as Altium's zoom precision
    if (!settings.navSelect) ed.selection = before;
    if (settings.navMask) (ed as Editor & { setMask?: (p: Iterable<number> | null) => void }).setMask?.(passing);
    // …dim the rest; draw the connection graph between them
    if (ed instanceof SchEditor) ed.setNavigation(settings.navDim ? passing : null, settings.navGraph ? connectionGraph(doc, refs.filter((r) => r.sheet.toLowerCase() === sheet.toLowerCase()).map((r) => r.index)) : null);
    ed.invalidateOverlay();
    tick.value++;
  });
}

