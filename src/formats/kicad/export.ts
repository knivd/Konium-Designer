/**
 * An AD project as a KiCad project (KiCad 8's files, which KiCad 8 and later open): the
 * .kicad_pro (net classes, design rules, text variables, sheets), the schematics, the board, a
 * symbol library of the symbols placed and one per SchLib, a footprint library (.pretty) of the
 * board's footprints and the project's PcbLibs, the library tables, and the 3D models the
 * board uses (embedded, or found where Konium looks for linked ones) in 3dmodels.
 */
import type { SheetInput } from '../../model/compile';
import { kicadNetNames } from './netName';
import type { PcbDocument } from '../../model/pcb';
import type { PcbLibDocument } from '../../model/pcbLib';
import type { SchFont } from '../../model/sch';
import type { PropertyBag } from '../altium/props';
import type { ModelFiles } from '../../render/gl3d/stepBodies';
import type { ImportMessage } from '../importers';
import { exportSchematics, libSymbol, symbolLibraryText } from './exportSch';
import { boardSettings, exportBoard, type KicadBoardSettings } from './exportPcb';
import { boardRules } from './board';
import { projectSettings } from './project';
import { kicadName } from './write';
import { writeSexpr, L } from './sexpr';
import { newEntry } from '../cfb/cfb';
import { Diagnostics } from '../../model/common';

export interface KicadExportInput {
  /** The project's name (its files' and folder's). */
  name: string;
  sheets: SheetInput[];
  board?: PcbDocument;
  /** The project's symbol libraries: each symbol's records and the library's fonts. */
  schLibs?: { name: string; symbols: { libRef: string; bags: PropertyBag[] }[]; fonts: SchFont[]; systemFont: number }[];
  pcbLibs?: PcbLibDocument[];
  /** Project Options › Net Identifier Scope (HierarchyMode): 0 Automatic, 1 Flat, 2 Hierarchical, 3 Global. */
  hierarchyMode?: number;
  channelFormat?: string;
  channelSeparator?: string;
  /** Project parameters: KiCad's text variables. */
  variables?: { name: string; value: string }[];
  /** Linked models found (embedded ones are read from the board). */
  models?: ModelFiles;
  /** KiCad's project files kept from an import: its settings (merged with Konium's), custom rules and local settings (as they were). */
  kicad?: { pro?: string; dru?: string; prl?: string };
}
export interface KicadExportResult { files: { path: string; bytes: Uint8Array }[]; messages: ImportMessage[] }

const enc = new TextEncoder();

/** How the design's ports and labels connect (AD's Automatic as the compile decides it). */
export function scopeOf(sheets: SheetInput[], mode = 0): 'hierarchical' | 'flat' | 'global' {
  if (mode === 1) return 'flat';
  if (mode === 2) return 'hierarchical';
  if (mode === 3) return sheets.length > 1 ? 'global' : 'flat';
  if (sheets.some((s) => s.doc.objects.some((o) => o.kind === 'sheetentry'))) return 'hierarchical';
  return 'flat';
}

export function exportKicad(i: KicadExportInput): KicadExportResult {
  const name = kicadName(i.name);
  const dir = `${name}/`;
  const files: KicadExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const put = (path: string, text: string | Uint8Array) => files.push({ path: dir + path, bytes: typeof text === 'string' ? enc.encode(text) : text });
  const info = (message: string) => messages.push({ level: 'info', source: name, message });
  const warn = (lines: string[], source = name) => { for (const message of lines) messages.push({ level: 'warn', source, message }); };
  const symbolLibs: string[] = [];
  let paths: Map<string, string> | undefined;
  let sheetList: [string, string][] = [];

  if (i.sheets.length) {
    const s = exportSchematics({ project: name, sheets: i.sheets, scope: scopeOf(i.sheets, i.hierarchyMode), footprintLib: name, channelFormat: i.channelFormat, channelSeparator: i.channelSeparator });
    for (const f of s.files) put(f.path, f.text);
    if (s.library.length) { put(`${name}.kicad_sym`, symbolLibraryText(s.library)); symbolLibs.push(name); }
    paths = s.paths;
    sheetList = s.sheetList;
    info(`${s.files.length} schematic sheet${s.files.length === 1 ? '' : 's'}, ${s.library.length} library symbol${s.library.length === 1 ? '' : 's'}`);
    warn(s.warnings, 'Schematics');
  }
  for (const lib of i.schLibs ?? []) {
    const stem = kicadName(lib.name.replace(/\.schlib$/i, ''));
    if (stem.toLowerCase() === name.toLowerCase() || symbolLibs.some((x) => x.toLowerCase() === stem.toLowerCase())) continue;
    const syms = lib.symbols.filter((x) => x.bags.length).map((x) => libSymbol(kicadName(x.libRef), { bags: x.bags, fonts: lib.fonts, systemFont: lib.systemFont, footprintLib: name }));
    put(`${stem}.kicad_sym`, symbolLibraryText(syms));
    symbolLibs.push(stem);
    info(`${stem}.kicad_sym: ${syms.length} symbols`);
  }
  let settings: KicadBoardSettings | undefined;
  let footprints = 0;
  if (i.board || i.pcbLibs?.length) {
    if (i.board) {
      // Nets by the names KiCad will give them from the schematics written with them
      const netNames = i.sheets.length ? kicadNetNames(i.sheets, { mode: i.hierarchyMode ?? 0, scope: scopeOf(i.sheets, i.hierarchyMode), channelFormat: i.channelFormat, channelSeparator: i.channelSeparator }) : undefined;
      const b = exportBoard({ name, board: i.board, footprintLib: name, paths, models: i.models, libraries: i.pcbLibs, netNames });
      put(`${name}.kicad_pcb`, b.text);
      for (const f of b.footprints) put(`${name}.pretty/${f.name}.kicad_mod`, f.text);
      for (const m of b.models) put(m.path, m.bytes);
      footprints = b.footprints.length;
      settings = b.settings;
      info(`Board: ${i.board.components.length} footprints placed, ${b.footprints.length} in ${name}.pretty, ${b.models.length} 3D model${b.models.length === 1 ? '' : 's'}`);
      warn(b.warnings, 'Board');
    } else {
      // Libraries only: their footprints through an empty board's writer
      const b = exportBoard({ name, board: emptyBoard(), footprintLib: name, libraries: i.pcbLibs });
      for (const f of b.footprints) put(`${name}.pretty/${f.name}.kicad_mod`, f.text);
      footprints = b.footprints.length;
      info(`${name}.pretty: ${b.footprints.length} footprints`);
    }
  }
  // Library tables
  const table = (kind: 'sym' | 'fp', libs: string[], ext: string) => `${writeSexpr(L(`${kind}_lib_table`, L('version', 7),
    ...libs.map((l) => L('lib', L('name', l), L('type', 'KiCad'), L('uri', `\${KIPRJMOD}/${l}${ext}`), L('options', ''), L('descr', '')))))}\n`;
  if (symbolLibs.length) put('sym-lib-table', table('sym', symbolLibs, '.kicad_sym'));
  if (footprints) put('fp-lib-table', table('fp', [name], '.pretty'));
  const made = projectJson(name, settings, sheetList, i.variables ?? []);
  let kept: Record<string, any> | null = null;
  try { kept = i.kicad?.pro ? JSON.parse(i.kicad.pro) as Record<string, any> : null; } catch { kept = null; }
  put(`${name}.kicad_pro`, `${JSON.stringify(kept ? mergeProject(kept, made, settings, name) : made, null, 2)}\n`);
  // (custom rules and local settings as KiCad had them: Konium makes nothing of them)
  if (i.kicad?.dru) { put(`${name}.kicad_dru`, i.kicad.dru); info(`${name}.kicad_dru: KiCad's custom rules as they were`); }
  if (i.kicad?.prl) put(`${name}.kicad_prl`, i.kicad.prl);
  return { files, messages };
}

/** The .kicad_pro: what KiCad takes from it (it fills in the rest with its defaults). */
function projectJson(name: string, s: KicadBoardSettings | undefined, sheets: [string, string][], variables: { name: string; value: string }[]) {
  const cls = (n: string, c: { clearance?: number; trackWidth?: number; viaDiameter?: number; viaDrill?: number }) => ({
    name: n, clearance: c.clearance ?? s?.clearance ?? 0.2, track_width: c.trackWidth ?? s?.trackWidth ?? 0.25, via_diameter: c.viaDiameter ?? s?.viaDiameter ?? 0.6, via_drill: c.viaDrill ?? s?.viaDrill ?? 0.3,
    microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, wire_width: 6, bus_width: 12, line_style: 0,
    pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)',
  });
  return {
    board: {
      design_settings: {
        defaults: {},
        rules: s ? { min_clearance: s.minClearance, min_track_width: s.minTrack, min_via_diameter: s.minVia, min_through_hole_diameter: s.minDrill, min_hole_to_hole: s.holeToHole, min_copper_edge_clearance: s.copperEdge } : {},
        track_widths: [], via_dimensions: [],
      },
    },
    boards: [],
    libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
    meta: { filename: `${name}.kicad_pro`, version: 1 },
    net_settings: {
      classes: [cls('Default', {}), ...(s?.classes ?? []).map((c) => cls(c.name, c))],
      meta: { version: 3 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: (s?.classes ?? []).flatMap((c) => c.nets.map((n) => ({ netclass: c.name, pattern: n }))),
    },
    pcbnew: { last_paths: {}, page_layout_descr_file: '' },
    schematic: { legacy_lib_dir: '', legacy_lib_list: [] },
    sheets,
    text_variables: Object.fromEntries(variables.map((v) => [v.name, v.value])),
  };
}

/**
 * KiCad's project settings kept from an import, with Konium's where Konium's say something else
 * than the import made of KiCad's (`was`: the same settings made from the kept ones): the file's
 * name, the text variables, the sheets, the board's minimum rules, each net class's clearance,
 * widths and via, and which nets are in which class (KiCad's patterns and assignments while the
 * classes hold the nets they did). The rest (ERC, schematic, board defaults …) as it was.
 */
function mergeProject(kept: Record<string, any>, made: ReturnType<typeof projectJson>, s: KicadBoardSettings | undefined, name: string): Record<string, any> {
  const out = JSON.parse(JSON.stringify(kept)) as Record<string, any>;
  const near = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 5e-4 : a === b);
  out.meta = { ...(kept.meta ?? {}), filename: made.meta.filename };
  const kv = kept.text_variables ?? {}, mv = made.text_variables;
  if (Object.keys(kv).length !== Object.keys(mv).length || Object.entries(mv).some(([k, v]) => kv[k] !== v)) out.text_variables = mv;
  // (the sheets: KiCad's names while they are the same sheets, the root's whatever Konium calls it)
  // (KiCad may list a sheet more than once, or none but the root: the same sheets)
  const sheetKey = (l: unknown) => (Array.isArray(l) ? [...new Set(l.map((x, i) => (Array.isArray(x) ? `${x[0]}|${i ? x[1] : ''}` : '')))].sort().join(';') : '');
  const onlyRoot = Array.isArray(kept.sheets) && !kept.sheets.length && made.sheets.length === 1;
  if (made.sheets.length && !onlyRoot && sheetKey(kept.sheets) !== sheetKey(made.sheets)) out.sheets = made.sheets;
  if (!s) return out;
  // What the import made of KiCad's settings, read back as the export reads Konium's
  const ks = projectSettings(JSON.stringify(kept)).rules;
  const nets = s.nets ?? [];
  const br = boardRules(ks, nets, nets);
  const fake = { rules: br.rules, nets: [], classes: br.classes.map((b) => ({ name: b.get('NAME') ?? '', kind: b.int('KIND'), superClass: b.bool('SUPERCLASS'), members: [] as string[] })) } as unknown as PcbDocument;
  const was = projectJson(name, boardSettings(fake), [], []);
  // The board's minimum rules: Konium's where they aren't what the import made
  const rules = ((out.board ??= {}).design_settings ??= {}).rules ??= {};
  for (const [k, v] of Object.entries(made.board.design_settings.rules)) {
    if (v === undefined || near((was.board.design_settings.rules as Record<string, unknown>)[k], v)) continue;
    rules[k] = v;
  }
  // Net classes: KiCad's in its order, their numbers Konium's where Konium changed them; a class
  // Konium has left out gone (one with no nets on the board Konium never had: kept); Konium's new ones after
  const ns = (out.net_settings ??= {});
  const keptClasses: Record<string, any>[] = Array.isArray(ns.classes) ? ns.classes : [];
  const re = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  const held = (c: { nets: string[]; patterns?: string[] }) => { const pats = (c.patterns ?? []).map(re); return new Set([...c.nets.filter((n) => nets.includes(n)), ...nets.filter((n) => pats.some((r) => r.test(n)))]); };
  const wasClasses = ks.classes ?? [];
  const FIELDS = ['clearance', 'track_width', 'via_diameter', 'via_drill'] as const;
  const merged: Record<string, any>[] = [];
  for (const k of keptClasses) {
    const m = made.net_settings.classes.find((c) => c.name === k.name);
    const w = was.net_settings.classes.find((c) => c.name === k.name);
    if (!m) { const wc = wasClasses.find((c) => c.name === k.name); if (k.name === 'Default' || !wc || !held(wc).size) merged.push(k); continue; }
    const c = { ...k };
    for (const f of FIELDS) if (!w || !near(w[f], m[f])) c[f] = m[f];
    merged.push(c);
  }
  for (const m of made.net_settings.classes) if (!keptClasses.some((k) => k.name === m.name)) merged.push(m);
  ns.classes = merged;
  // Which nets are in which class
  const same = s.classes.every((c) => {
    const w = wasClasses.find((x) => x.name === c.name);
    if (!w) return false;
    const h = held(w);
    return c.nets.length === h.size && c.nets.every((n) => h.has(n));
  }) && wasClasses.filter((c) => c.name !== 'Default' && held(c).size).every((c) => s.classes.some((x) => x.name === c.name));
  if (!same) { ns.netclass_patterns = made.net_settings.netclass_patterns; ns.netclass_assignments = null; for (const c of ns.classes) delete c.nets; }
  return out;
}

/** A board with nothing on it (for writing libraries' footprints alone). */
function emptyBoard(): PcbDocument {
  return {
    kind: 'PcbDoc', name: 'Libraries', cfb: { root: newEntry('Root Entry', 'root'), majorVersion: 3 },
    board: { bag: undefined, origin: { x: 0, y: 0 }, outline: [], vertices: [], copperStack: [1, 32], layerNames: new Map() },
    nets: [], components: [], prims: [], streams: new Map(), dirty: new Set(), diags: new Diagnostics(), rules: [], rulesInFile: false, classes: [], polygons: [], dimensions: [],
  };
}
