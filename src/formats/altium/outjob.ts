/**
 * Output Job files (.OutJob), as AD writes them: an INI text with CR LF lines.
 * - [OutputJobFile]: Version=1.0 and vault keys.
 * - [OutputGroup1]: Name, Description, TargetOutputMedium (the container selected), VariantName,
 *   TargetPrinter, PrinterOptions; the containers OutputMediumM (name) and OutputMediumM_Type
 *   (Printer, Publish = PDF, GeneratedFiles = Folder Structure, Multimedia); then per output N:
 *   OutputTypeN (Gerber, NC Drill, BOM_PartType, PCB Print, Final …), OutputNameN,
 *   OutputCategoryN (Fabrication, Assembly, Documentation, Report, Validation, Export, Netlist),
 *   OutputDocumentPathN (data source; empty: the project / its PCB), OutputVariantNameN,
 *   OutputEnabledN (connected to the target container), OutputEnabledN_OutputMediumM (its place in
 *   container M, 0: not in it), OutputDefaultN, PageOptionsN, ConfigurationN_NameK / _ItemK (the
 *   output's setup: "Key=Value|Key=Value…" records).
 * - [PublishSettings] (PDF containers) and [GeneratedFilesSettings] (folder containers), keyed by
 *   the container's number.
 * Read and written back line for line: an unchanged file saves identical; edits rewrite only the
 * output group, keeping every key Konium doesn't model.
 */
import { binToBytes, bytesToBin } from '../text';

export interface IniSection { name: string; entries: [string, string][] }
export interface OutJobDocument {
  kind: 'OutJob';
  name: string;
  /** Lines before the first section (none in AD's files). */
  head: string[];
  sections: IniSection[];
  /** Original bytes, written back while nothing changed. */
  original: Uint8Array | null;
  dirty: boolean;
}

export interface OutJobOutput {
  n: number;
  type: string; name: string; category: string; document: string; enabled: boolean;
  /** Container number → place in it (0: not in it). */
  media: Map<number, number>;
  /** The output's other keys (PageOptions, Configuration…), suffix after the number → value. */
  rest: [string, string][];
}
export interface OutJobMedium { m: number; name: string; type: string }

export function parseIni(text: string): { head: string[]; sections: IniSection[] } {
  const head: string[] = [], sections: IniSection[] = [];
  for (const raw of text.replace(/^\xef\xbb\xbf|^\ufeff/, '').split(/\r?\n/)) {
    const line = raw;
    const m = /^\[(.*)\]\s*$/.exec(line);
    if (m) { sections.push({ name: m[1]!, entries: [] }); continue; }
    const cur = sections.at(-1);
    if (!cur) { if (line.trim()) head.push(line); continue; }
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    cur.entries.push(eq < 0 ? [line, ''] : [line.slice(0, eq), line.slice(eq + 1)]);
  }
  return { head, sections };
}

export function iniText(head: string[], sections: IniSection[]): string {
  const out: string[] = [...head];
  sections.forEach((s, i) => {
    if (i > 0 || head.length) out.push('');
    out.push(`[${s.name}]`, ...s.entries.map(([k, v]) => `${k}=${v}`));
  });
  // (AD ends the file with an empty line)
  return out.join('\r\n') + '\r\n\r\n';
}

export function readOutJob(bytes: Uint8Array, name: string): OutJobDocument {
  const { head, sections } = parseIni(bytesToBin(bytes));
  return { kind: 'OutJob', name, head, sections, original: bytes, dirty: false };
}

export function writeOutJob(d: OutJobDocument): Uint8Array {
  if (d.original && !d.dirty) return d.original;
  return binToBytes(iniText(d.head, d.sections));
}

/**
 * A new Output Job as AD starts one: no outputs, the Print Job, PDF and Folder Structure containers.
 * Its Variant Choice builds the selected variant for every output (VariantScope=0; 1 lets each
 * output name its own, which the job's view has no column for).
 */
export function newOutJob(name: string): OutJobDocument {
  const vault = ['Caption', 'Description', 'VaultGUID', 'ItemGUID', 'ItemHRID', 'RevisionGUID', 'RevisionId', 'VaultHRID', 'AutoItemHRID', 'NextRevId', 'FolderGUID',
    'LifeCycleDefinitionGUID', 'RevisionNamingSchemeGUID'].map((k): [string, string] => [k, '']);
  const printer = 'Record=PrinterOptions|Copies=1|Duplex=1|TrueTypeOptions=3|Collate=1|PrintJobKind=1|PrintWhat=1';
  const sections: IniSection[] = [
    { name: 'OutputJobFile', entries: [['Version', '1.0'], ...vault] },
    { name: 'OutputGroup1', entries: [['Name', name], ['Description', ''], ['TargetOutputMedium', 'Folder Structure'], ['VariantName', '[No Variations]'], ['VariantScope', '0'],
      ['CurrentConfigurationName', ''], ['TargetPrinter', ''], ['PrinterOptions', printer],
      ['OutputMedium1', 'Print Job'], ['OutputMedium1_Type', 'Printer'], ['OutputMedium1_Printer', ''], ['OutputMedium1_PrinterOptions', printer],
      ['OutputMedium2', 'PDF'], ['OutputMedium2_Type', 'Publish'], ['OutputMedium3', 'Folder Structure'], ['OutputMedium3_Type', 'GeneratedFiles']] },
    { name: 'PublishSettings', entries: [['OutputFilePath2', ''], ['ReleaseManaged2', '1'], ['OutputBasePath2', ''], ['OutputPathMedia2', ''], ['OutputPathMediaValue2', ''],
      ['OutputPathOutputer2', '[Output Type]'], ['OutputPathOutputerPrefix2', ''], ['OutputPathOutputerValue2', ''], ['OutputFileName2', ''], ['OutputFileNameMulti2', ''],
      ['UseOutputNameForMulti2', '1'], ['OutputFileNameSpecial2', ''], ['OpenOutput2', '1'], ['PromptOverwrite2', '1'], ['PublishMethod2', '0'], ['ZoomLevel2', '50'],
      ['FitSCHPrintSizeToDoc2', '1'], ['FitPCBPrintSizeToDoc2', '1'], ['GenerateNetsInfo2', '1'], ['MarkPins2', '1'], ['MarkNetLabels2', '1'], ['MarkPortsId2', '1'],
      ['GenerateTOC', '1'], ['ShowComponentParameters2', '1'], ['GlobalBookmarks2', '0']] },
    { name: 'GeneratedFilesSettings', entries: [['RelativeOutputPath3', ''], ['OpenOutputs3', '1'], ['AddToProject3', '1'], ['TimestampFolder3', '0'], ['UseOutputName3', '0'],
      ['OpenODBOutput3', '0'], ['OpenGerberOutput3', '0'], ['OpenNCDrillOutput3', '0'], ['OpenIPCOutput3', '0'], ['EnableReload3', '0']] },
  ];
  return { kind: 'OutJob', name, head: [], sections, original: null, dirty: true };
}

const group = (d: OutJobDocument) => d.sections.find((s) => /^OutputGroup1$/i.test(s.name));
const OUT_KEY = /^(OutputType|OutputName|OutputCategory|OutputDocumentPath|OutputVariantName|OutputEnabled|OutputDefault|PageOptions)(\d+)(_OutputMedium\d+)?$/;
const CONF_KEY = /^Configuration(\d+)_(Name|Item)(\d+)$/;
const outputOf = (k: string): number | null => { const m = OUT_KEY.exec(k) ?? null; if (m) return Number(m[2]); const c = CONF_KEY.exec(k); return c ? Number(c[1]) : null; };

export function outJobMedia(d: OutJobDocument): OutJobMedium[] {
  const g = group(d);
  if (!g) return [];
  const out: OutJobMedium[] = [];
  for (const [k, v] of g.entries) { const m = /^OutputMedium(\d+)$/.exec(k); if (m) out.push({ m: Number(m[1]), name: v, type: g.entries.find(([x]) => x === `OutputMedium${m[1]}_Type`)?.[1] ?? '' }); }
  return out;
}

export function outJobOutputs(d: OutJobDocument): OutJobOutput[] {
  const g = group(d);
  if (!g) return [];
  const map = new Map<number, OutJobOutput>();
  const get = (n: number) => { let o = map.get(n); if (!o) map.set(n, (o = { n, type: '', name: '', category: '', document: '', enabled: false, media: new Map(), rest: [] })); return o; };
  for (const [k, v] of g.entries) {
    const n = outputOf(k);
    if (n === null) continue;
    const o = get(n);
    const m = OUT_KEY.exec(k);
    if (m && !m[3]) {
      switch (m[1]) {
        case 'OutputType': o.type = v; continue;
        case 'OutputName': o.name = v; continue;
        case 'OutputCategory': o.category = v; continue;
        case 'OutputDocumentPath': o.document = v; continue;
        case 'OutputEnabled': o.enabled = v.trim() === '1'; continue;
      }
    }
    if (m?.[3]) { o.media.set(Number(/\d+$/.exec(m[3])![0]), Number(v) || 0); continue; }
    o.rest.push([k.replace(/^(\D+?)\d+/, '$1#'), v]);
  }
  return [...map.values()].sort((a, b) => a.n - b.n);
}

/** The output group written from outputs (renumbered 1…), the group's own keys kept in place. */
export function setOutJobOutputs(d: OutJobDocument, outs: OutJobOutput[]): void {
  const g = group(d);
  if (!g) return;
  const own = g.entries.filter(([k]) => outputOf(k) === null);
  const media = outJobMedia(d).map((x) => x.m);
  const target = outJobMedia(d).find((x) => x.name === (g.entries.find(([k]) => k === 'TargetOutputMedium')?.[1] ?? ''))?.m;
  const rows: [string, string][] = [];
  outs.forEach((o, i) => {
    const n = i + 1;
    const fix = (k: string) => k.replace('#', String(n));
    rows.push([`OutputType${n}`, o.type], [`OutputName${n}`, o.name], [`OutputCategory${n}`, o.category], [`OutputDocumentPath${n}`, o.document]);
    const variant = o.rest.find(([k]) => k === 'OutputVariantName#');
    rows.push([`OutputVariantName${n}`, variant?.[1] ?? '']);
    rows.push([`OutputEnabled${n}`, target !== undefined && (o.media.get(target) ?? 0) > 0 ? '1' : '0']);
    for (const m of media) rows.push([`OutputEnabled${n}_OutputMedium${m}`, String(o.media.get(m) ?? 0)]);
    const def = o.rest.find(([k]) => k === 'OutputDefault#');
    rows.push([`OutputDefault${n}`, def?.[1] ?? '0']);
    for (const [k, v] of o.rest) if (k !== 'OutputVariantName#' && k !== 'OutputDefault#') rows.push([fix(k), v]);
    o.n = n;
  });
  g.entries = [...own, ...rows];
  d.dirty = true;
}

export function setOutJobKey(d: OutJobDocument, section: string, key: string, value: string): void {
  let s = d.sections.find((x) => x.name === section);
  if (!s) d.sections.push((s = { name: section, entries: [] }));
  const e = s.entries.find(([k]) => k === key);
  if (e) e[1] = value; else s.entries.push([key, value]);
  d.dirty = true;
}
export const outJobKey = (d: OutJobDocument, section: string, key: string): string | undefined => d.sections.find((x) => x.name === section)?.entries.find(([k]) => k === key)?.[1];

/** An output's configuration records ("Key=Value|…"), in order. */
export function outputConfig(o: OutJobOutput): Record<string, string>[] {
  const items = o.rest.filter(([k]) => /^Configuration#_Item\d+$/.test(k)).sort((a, b) => Number(/\d+$/.exec(a[0])![0]) - Number(/\d+$/.exec(b[0])![0]));
  return items.map(([, v]) => Object.fromEntries(v.split('|').map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; })));
}
/**
 * Replace an output's configuration records: named OutputConfigurationParameterK as AD names
 * them, or as given (a BOM's are General, GroupOrder, SortOrder, VisibleOrder …); a string is
 * written as it is.
 */
export function setOutputConfig(o: OutJobOutput, records: (Record<string, string> | string)[], names?: string[]): void {
  o.rest = o.rest.filter(([k]) => !/^Configuration#_(Name|Item)\d+$/.test(k));
  records.forEach((r, i) => o.rest.push([`Configuration#_Name${i + 1}`, names?.[i] ?? `OutputConfigurationParameter${i + 1}`],
    [`Configuration#_Item${i + 1}`, typeof r === 'string' ? r : Object.entries(r).map(([k, v]) => `${k}=${v}`).join('|')]));
}

/** AD's page options for a print output (A4 landscape, fit) [est: the defaults AD gives a new one]. */
export const DEFAULT_PAGE_OPTIONS = 'Record=PageOptions|CenterHorizontal=True|CenterVertical=True|PrintScale=1.00|XCorrection=1.00|YCorrection=1.00|PrintKind=1|BorderSize=5000000|LeftOffset=0|BottomOffset=0|Orientation=2|PaperLength=1000|PaperWidth=1000|Scale=100|PaperSource=7|PrintQuality=-4|MediaType=1|DitherType=10|PrintScaleMode=1|PaperKind=A4|PaperIndex=9';

/** What the editor offers under each category's "Add New … Output", with AD's type names [est: those not seen in files]. */
export const OUTPUT_KINDS: { category: string; title: string; types: [type: string, name: string][] }[] = [
  { category: 'Netlist', title: 'Netlist Outputs', types: [['Protel', 'Netlist (.NET)']] }, // the file's type name stays; the app never shows it
  { category: 'Documentation', title: 'Documentation Outputs', types: [['PCB Print', 'PCB Prints'], ['Schematic Print', 'Schematic Prints'], ['PCB 3D Print', 'PCB 3D Print'], ['Composite', 'Composite Drawing']] },
  { category: 'Assembly', title: 'Assembly Outputs', types: [['Assembly', 'Assembly Drawings'], ['Pick Place', 'Generates pick and place files'], ['Test Points', 'Test Point Report']] },
  { category: 'Fabrication', title: 'Fabrication Outputs', types: [['Composite Drill Guide', 'Composite Drill Guide'], ['Drill', 'Drill Drawing/Guides'], ['Final', 'Final Artwork Prints'],
    ['Gerber', 'Gerber Files'], ['Gerber X2', 'Gerber X2 Files'], ['IPC2581', 'IPC-2581 Files'], ['Mask', 'Mask Set'], ['NC Drill', 'NC Drill Files'], ['ODB', 'ODB++ Files'], ['Plane', 'Power-Plane Set'], ['Test Points', 'Test Point Report']] },
  { category: 'Report', title: 'Report Outputs', types: [['BOM_PartType', 'Bill of Materials'], ['SimpleBOM', 'Simple BOM']] },
  { category: 'Validation', title: 'Validation Outputs', types: [['Design Rules Check', 'Design Rules Check'], ['Electrical Rules Check', 'Electrical Rules Check']] },
  { category: 'Export', title: 'Export Outputs', types: [['ExportSTEP', 'Export STEP'], ['AutoCAD dwg/dxf PCB', 'AutoCAD dwg/dxf PCB']] },
];

/** A new output of a type (enabled in no container yet). */
export function newOutput(type: string, name: string, category: string, document = '', print = false): OutJobOutput {
  return { n: 0, type, name, category, document, enabled: false, media: new Map(), rest: [['OutputVariantName#', ''], ['OutputDefault#', '0'], ...(print ? [['PageOptions#', DEFAULT_PAGE_OPTIONS] as [string, string]] : [])] };
}
