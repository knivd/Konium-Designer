/**
 * Output Job › Generate content: each output enabled in the container, in its order there.
 * - Folder Structure: the files of Gerber, NC Drill, Pick Place, Test Points, BOM, Simple BOM,
 *   Design Rules Check, Electrical Rules Check and Protel netlist outputs, into the project's
 *   Output Path ("Project Outputs for <project>" by default) or a .zip, as File › … writes them;
 * - PDF and Print Job: the pages of the print outputs (PCB Prints, Final, Drill, Composite,
 *   Assembly, Mask, Plane, Schematic Prints) through the browser's print (Save as PDF).
 * Gerber X2, IPC-2581, ODB++ (a .tgz) and Export STEP write files too; PCB 3D Print prints its
 * views (top, bottom, angled). Outputs Konium can't generate yet (DXF …) are listed in Messages.
 * A Folder Structure run also writes Status Report.Txt, as AD does.
 */
import { docs, notify, projects, replaceMessages, type OpenDoc, type Project } from './state';
import { compileOptions, projectSheets } from './project';
import { showPanel } from './dock/store';
import { compileProject, type CompiledProject } from '../model/compile';
import { deliverOutputs, outputsZipName } from './dialogs/Outputs';
import { pickSaveHandle } from '../platform/fs';
import { documentPages, printPages, type Page } from './print';
import { printJobPages } from '../render/pcbPrint';
import { defaultGerberSetup, gerberFiles, type OutputFile } from '../formats/gerber/gerber';
import { gerberX2Files } from '../formats/gerber/gerberX2';
import { ipc2581 } from '../formats/ipc2581';
import { odbArchive } from '../formats/odb';
import { exportStep, leftOutWords } from '../formats/step/write';
import { embeddedModels } from '../render/gl3d/stepBodies';
import { print3dPages } from '../render/gl3d/print3d';
import { drillFiles } from '../formats/gerber/drill';
import { pnpFile } from '../formats/gerber/pnp';
import { defaultTestPointSetup, testPointFiles } from '../formats/gerber/testpoints';
import { protelNetlist } from '../formats/netlist';
import { outJobKey, outJobOutputs, outputConfig, setOutJobKey, type OutJobDocument, type OutJobMedium, type OutJobOutput } from '../formats/altium/outjob';
import { isFitted, readVariants, variantComponents, type Variant } from '../model/variants';
import { bomFromConfig, drillFromConfig, gerberFromConfig, pnpFromConfig, printJobFromConfig } from '../formats/altium/outjobConfig';
import { defaultJob, type PrintJobKind } from '../model/printouts';
import { bomItems, buildBom, simpleBom, wireLinkBomItems } from '../model/bom';
import { boardOf } from './reqFacts';
import { drcRules, runDrc } from '../model/drc';
import { drcSettings } from '../model/drcOptions';
import { reportHtml } from './dialogs/Drc';
import { bomFile } from './dialogs/Bom';
import { load } from '../formats/registry';
import { forOutput } from '../model/duplicates';
import { ercReportHtml, statusReport, type StatusEntry } from '../formats/reports';
import { SchEditor } from '../editors/sch/SchEditor';
import type { PcbDocument } from '../model/pcb';

const activeProjectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((x) => x.id === od.projectId) ?? null : null);
const projectSheetsFor = (p: Project | null) => projectSheets(p);
/** The project compiled without touching Messages or the sheets' markers. */
function cmdCompileQuiet(p: Project | null): (CompiledProject & { name: string }) | null {
  const sheets = projectSheets(p);
  if (!sheets.length) return null;
  return { ...compileProject(sheets, compileOptions(p)), name: p?.name ?? sheets[0]!.name };
}

/** Output types that print (PDF / Print Job) and the print job each stands for. */
export const PRINT_TYPES: Record<string, PrintJobKind | 'sch'> = {
  'PCB Print': 'pcb', Final: 'final', 'Composite Drill Guide': 'composite', Drill: 'drill', Assembly: 'assembly', Mask: 'mask', Plane: 'plane', 'Schematic Print': 'sch',
};
/** Output types that write files (Folder Structure). */
export const FILE_TYPES = new Set(['Gerber', 'Gerber X2', 'IPC2581', 'ODB', 'ExportSTEP', 'NC Drill', 'Pick Place', 'Test Points', 'BOM_PartType', 'SimpleBOM', 'Design Rules Check', 'Electrical Rules Check', 'Protel']);

/** The board an output takes its data from: its OutputDocumentPath, else the project's first PCB. */
export function outputBoard(p: Project | null, o: OutJobOutput): PcbDocument | null {
  const want = o.document.trim().split(/[\\/]/).pop()?.toLowerCase();
  const open = docs.value.filter((d) => d.doc.kind === 'PcbDoc' && (!p || d.projectId === p.id));
  const hit = open.find((d) => !want || d.name.toLowerCase() === want);
  if (hit) return hit.doc as PcbDocument;
  if (!p) return null;
  const path = p.prj.documents.find((x) => /\.pcbdoc$/i.test(x) && (!want || x.split(/[\\/]/).pop()!.toLowerCase() === want));
  const f = path ? p.files.get(path.split(/[\\/]/).pop()!.toLowerCase()) : undefined;
  if (!f) return null;
  try { const d = load(f.bytes, f.name); return d.kind === 'PcbDoc' ? d : null; } catch { return null; }
}

/** The enabled outputs of a container, in their order there. */
export const containerOutputs = (job: OutJobDocument, m: number): OutJobOutput[] =>
  outJobOutputs(job).filter((o) => (o.media.get(m) ?? 0) > 0).sort((a, b) => (a.media.get(m) ?? 0) - (b.media.get(m) ?? 0));

/** The files one output writes. */
export async function outputFiles(p: Project | null, o: OutJobOutput, notes: string[], variant: Variant | null = null): Promise<OutputFile[]> {
  const cfg = outputConfig(o);
  const notFitted = (): Set<string> => { const r = variant ? cmdCompileQuiet(p) : null; return new Set(r ? r.components.filter((c) => !isFitted(variant, c.designator, c.uniqueId)).map((c) => c.designator) : []); };
  // (without duplicate objects: Preferences › PCB Editor › General › Remove Duplicates)
  const board = () => { const b = outputBoard(p, o); if (!b) notes.push(`${o.name}: no PCB document to take the data from`); return b && forOutput(b); };
  switch (o.type) {
    case 'Gerber': { const b = board(); if (!b) return []; const r = gerberFiles(b, gerberFromConfig(b, cfg), p?.folder ? `${p.folder}\\${b.name}` : b.name); notes.push(...r.notes.map((n) => `${o.name}: ${n}`)); return r.files; }
    case 'Gerber X2': { const b = board(); if (!b) return []; const r = gerberX2Files(b, { ...defaultGerberSetup(b), units: 'mm', intDigits: 4, decDigits: 6 }); notes.push(...r.notes.map((n) => `${o.name}: ${n}`)); return r.files; }
    case 'IPC2581': { const b = board(); return b ? [{ name: `${b.name.replace(/\.pcbdoc$/i, '')}.xml`, text: ipc2581(b) }] : []; }
    case 'ODB': { const b = board(); if (!b) return []; const a = await odbArchive(b); return [{ name: a.name, text: '', bytes: a.bytes }]; }
    case 'ExportSTEP': {
      const b = board();
      if (!b) return [];
      const leftOut: string[] = [], name = `${b.name.replace(/\.pcbdoc$/i, '')}.step`;
      const text = await exportStep(b, { models: embeddedModels(b.cfb.root), leftOut });
      if (leftOut.length) notify(`${name}: ${leftOutWords(leftOut)}`, 'error');
      return [{ name, text }];
    }
    case 'NC Drill': { const b = board(); return b ? drillFiles(b, drillFromConfig(cfg)) : []; }
    case 'Pick Place': { const b = board(); return b ? [pnpFile(b, pnpFromConfig(cfg), p ? `${p.folder ?? ''}\\${p.name}` : '', new Date(), variant ? { name: variant.name, notFitted: notFitted() } : undefined)] : []; }
    case 'Test Points': { const b = board(); return b ? testPointFiles(b, defaultTestPointSetup()) : []; }
    case 'Design Rules Check': {
      const b = board();
      if (!b) return [];
      const t0 = Date.now(), r = runDrc(b);
      return [{ name: `Design Rule Check - ${b.name.replace(/\.pcbdoc$/i, '')}.html`, text: reportHtml(b.name, drcRules(b), new Set(drcRules(b).map((x) => x.bag.get('RULEKIND') ?? '')), r, Date.now() - t0, new Date(), drcSettings(b).subNet) }];
    }
    case 'BOM_PartType': case 'SimpleBOM': case 'Electrical Rules Check': case 'Protel': {
      const res = cmdCompileQuiet(p);
      if (!res) { notes.push(`${o.name}: nothing to compile`); return []; }
      const base = (p?.name ?? res.name).replace(/\.(prjpcb|schdoc)$/i, '');
      if (o.type === 'Protel') return [{ name: `${base}.NET`, text: protelNetlist(res) }];
      if (o.type === 'Electrical Rules Check') return [{ name: `Electrical Rules Check - ${base}.html`, text: ercReportHtml(p?.name ?? res.name, res.messages, 0) }];
      // With the board's wire links, which no sheet has
      const wired = p ? boardOf(p) : null;
      const items = [...bomItems(variantComponents(res.components, variant)), ...(wired ? wireLinkBomItems(wired.doc) : [])];
      if (o.type === 'SimpleBOM') { const s = simpleBom(p?.name ?? base, items); return [{ name: `${base}.BOM`, text: s.bom }, { name: `${base}.CSV`, text: s.csv }]; }
      const setup = bomFromConfig(cfg);
      return [bomFile(`Bill of Materials for ${p?.name ?? base}`, base, 'xlsx', setup.columns, buildBom(items, setup))];
    }
    default:
      notes.push(PRINT_TYPES[o.type] ? `${o.name}: a print output — add it to a PDF or Print Job container` : `${o.name}: ${o.type} outputs aren't generated by Konium Designer yet`);
      return [];
  }
}

/**
 * The variant an output builds: the job's Variant Choice ([OutputGroup1] VariantName), or the
 * output's own (OutputVariantName) when the job lets each output choose (VariantScope=1).
 */
export function outputVariantName(job: OutJobDocument | null, o: OutJobOutput): string {
  const own = o.rest.find(([k]) => /^OutputVariantName/i.test(k))?.[1]?.trim() ?? '';
  const scope = job ? outJobKey(job, 'OutputGroup1', 'VariantScope') : undefined;
  const name = scope === '1' ? own : (job ? outJobKey(job, 'OutputGroup1', 'VariantName') ?? '' : own);
  return /^\[?No Variations\]?$/i.test(name.trim()) ? '' : name.trim();
}
/**
 * What the job's Variant Choice shows: the variant every output builds ('' for none). A job saved
 * with each output naming its own (VariantScope=1): theirs when they all agree, else null.
 */
export function jobVariant(job: OutJobDocument): string | null {
  if (outJobKey(job, 'OutputGroup1', 'VariantScope') === '1') {
    const own = [...new Set(outJobOutputs(job).map((o) => outputVariantName(job, o)))];
    if (own.length > 1) return null;
    if (own.length === 1) return own[0]!;
  }
  const name = outJobKey(job, 'OutputGroup1', 'VariantName')?.trim() ?? '';
  return /^\[?No Variations\]?$/i.test(name) ? '' : name;
}
/** Variant Choice › Build the selected variant: every output builds it ('' or [No Variations]: none). */
export function chooseJobVariant(job: OutJobDocument, name: string): void {
  setOutJobKey(job, 'OutputGroup1', 'VariantName', name.trim() || '[No Variations]');
  setOutJobKey(job, 'OutputGroup1', 'VariantScope', '0');
}
const outputVariant = (p: Project | null, job: OutJobDocument, o: OutJobOutput): Variant | null => {
  const n = outputVariantName(job, o);
  return n && p ? readVariants(p.prj).find((v) => v.name === n) ?? null : null;
};

/** Outputs that take a variant (Status Report: "Variant [[No Variations]] of …") [est beyond Gerber, BOM and ODB++]. */
const VARIANT_TYPES = new Set(['Gerber', 'BOM_PartType', 'SimpleBOM', 'ODB', 'Pick Place', 'IPC2581']);
/** The Status Report's lines for one output: AD's type name and where the data came from. */
export function statusEntry(p: Project | null, o: OutJobOutput, files: string[], job: OutJobDocument | null = null): StatusEntry {
  const doc = o.document.trim().split(/[\\/]/).pop();
  const src = doc ? `PCB Document [${doc}]` : `Project [${p?.name ?? ''}]`;
  const variant = outputVariantName(job, o);
  return {
    name: o.name, type: o.type === 'BOM_PartType' ? 'BOM' : o.type, files,
    from: VARIANT_TYPES.has(o.type) ? `Variant [${variant || '[No Variations]'}] of ${src}` : src,
  };
}

/** The pages one print output prints. */
export async function outputPages(p: Project | null, o: OutJobOutput, notes: string[]): Promise<Page[]> {
  if (o.type === 'PCB 3D Print') {
    const b = outputBoard(p, o);
    if (!b) { notes.push(`${o.name}: no PCB document to take the data from`); return []; }
    try { return (await print3dPages(b, embeddedModels(b.cfb.root))).map((pg) => ({ ...pg, name: `${o.name} - ${pg.name}` })); } catch (e) { notes.push(`${o.name}: ${(e as Error).message}`); return []; }
  }
  const kind = PRINT_TYPES[o.type];
  if (!kind) { notes.push(FILE_TYPES.has(o.type) ? `${o.name}: writes files — add it to a Folder Structure container` : `${o.name}: ${o.type} outputs aren't generated by Konium Designer yet`); return []; }
  if (kind === 'sch') {
    const sheets = projectSheetsFor(p);
    return documentPages(sheets.map((s) => ({ name: s.name, ed: new SchEditor(s.doc) })));
  }
  const b = outputBoard(p, o);
  if (!b) { notes.push(`${o.name}: no PCB document to take the data from`); return []; }
  const job = printJobFromConfig(kind, o.name, outputConfig(o), defaultJob(b, kind));
  return printJobPages(b, job).map((pg) => ({ ...pg, name: `${o.name} - ${pg.name}` }));
}

/** Generate content for a container of the Output Job open in `od`. */
export async function runContainer(od: OpenDoc, medium: OutJobMedium): Promise<void> {
  const job = od.doc as OutJobDocument;
  const p = activeProjectOf(od);
  const outs = containerOutputs(job, medium.m);
  if (!outs.length) { notify(`No outputs are enabled for ${medium.name}`, 'error'); return; }
  const notes: string[] = [];
  if (medium.type === 'GeneratedFiles') {
    // A project without a folder: where the zip goes is asked now, while the click still counts
    let target: FileSystemFileHandle | null | undefined;
    if (!p?.dir) { target = await pickSaveHandle(outputsZipName(p, od.name, medium.name)); if (target === null) return; }
    const entries: StatusEntry[] = [];
    const files: OutputFile[] = [];
    for (const o of outs) { const f = await outputFiles(p, o, notes, outputVariant(p, job, o)); entries.push(statusEntry(p, o, f.map((x) => x.name), job)); files.push(...f); }
    if (files.length) await deliverOutputs(p, od.name, medium.name, [...files, { name: 'Status Report.Txt', text: statusReport(entries, 0) }], target);
  } else {
    const pages: Page[] = [];
    for (const o of outs) pages.push(...(await outputPages(p, o, notes)));
    if (pages.length) { printPages(pages); if (medium.type === 'Publish') notify('In the print dialog choose “Save as PDF” as the destination'); }
  }
  if (notes.length) {
    replaceMessages(`Output Generator: ${od.name}`, notes.map((message) => ({ doc: od.name, level: 'warn' as const, message })));
    showPanel('messages');
  }
}
