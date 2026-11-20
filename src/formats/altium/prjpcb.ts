import { ansiToStr, binToBytes, binToUtf8, bytesToBin, codePageFor, strToAnsi, utf8ToBin } from '../text';

/**
 * PrjPcb: Windows INI. Kept as raw lines so an unmodified project saves byte-identical; edits
 * (documents added or removed, Project Options, parameters) change only the lines they touch.
 * Documents are [DocumentN] sections with DocumentPath= relative to the project file.
 */
export interface PrjPcb {
  kind: 'PrjPcb';
  name: string;
  lines: string[];       // binary strings
  eol: string;
  documents: string[];   // DocumentPath values, '\' normalised to '/'
  /** Project › Project Options › Parameters: [ParameterN] Name= / Value=, keyed by upper-case name. */
  parameters: Map<string, string>;
  /** Saved as UTF-8 with a byte-order mark (kept so): its lines are UTF-8, not Windows-1252. */
  bom?: boolean;
  /** The Windows code page of its text (no BOM: the author's system's; Western unless the text says otherwise). */
  cp?: number;
}

export function readPrjPcb(bytes: Uint8Array, name: string): PrjPcb {
  let text = bytesToBin(bytes);
  const bom = text.startsWith('\xef\xbb\xbf');
  if (bom) text = text.slice(3);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  // (no BOM: 8-bit text in the code page of the author's Windows, told from its values)
  const cp = bom ? 1252 : codePageFor(lines.map((l) => l.slice(l.indexOf('=') + 1)).filter((v) => /[\x80-\xff]/.test(v)));
  const p: PrjPcb = { kind: 'PrjPcb', name, lines, eol, documents: [], parameters: new Map(), ...(bom ? { bom } : {}), ...(cp !== 1252 ? { cp } : {}) };
  reparse(p);
  return p;
}

/** Recompute documents and parameters from the lines (after an edit). */
export function reparse(p: PrjPcb): void {
  const documents: string[] = [];
  const parameters = new Map<string, string>();
  for (const s of iniSections(p)) {
    if (/^Document\d+$/i.test(s.name)) {
      const path = s.entries.find(([k]) => k.toLowerCase() === 'documentpath')?.[1];
      if (path !== undefined) documents.push(path.replace(/\\/g, '/'));
    } else if (/^Parameter\d+$/i.test(s.name)) {
      const n = s.entries.find(([k]) => k.toLowerCase() === 'name')?.[1];
      const v = s.entries.find(([k]) => k.toLowerCase() === 'value')?.[1] ?? '';
      if (n && !parameters.has(n.toUpperCase())) parameters.set(n.toUpperCase(), v);
    }
  }
  p.documents = documents;
  p.parameters = parameters;
}

export function writePrjPcb(p: PrjPcb): Uint8Array {
  return binToBytes((p.bom ? '\xef\xbb\xbf' : '') + p.lines.join(p.eol));
}

/** Basename of a project-relative document path. */
export const docBaseName = (path: string): string => path.split('/').pop() ?? path;

/* ─── INI access ────────────────────────────────────────────────────────────────────── */

export interface IniSection {
  name: string;
  /** Line of the [header]. */
  at: number;
  /** One past the last line belonging to the section (blank lines before the next header excluded). */
  end: number;
  /** Key / value pairs, values decoded from Windows-1252. */
  entries: [string, string][];
}

export function iniSections(p: PrjPcb): IniSection[] {
  const out: IniSection[] = [];
  let cur: IniSection | null = null;
  p.lines.forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith('[') && l.endsWith(']')) {
      cur = { name: l.slice(1, -1), at: i, end: i + 1, entries: [] };
      out.push(cur);
      return;
    }
    if (!cur || !l) return;
    const eq = raw.indexOf('=');
    if (eq < 0) return;
    cur.entries.push([decode(p, raw.slice(0, eq)), decode(p, raw.slice(eq + 1))]);
    cur.end = i + 1;
  });
  return out;
}

export function iniSection(p: PrjPcb, name: string): IniSection | undefined {
  return iniSections(p).find((s) => s.name.toLowerCase() === name.toLowerCase());
}

export function iniGet(p: PrjPcb, section: string, key: string): string | undefined {
  return iniSection(p, section)?.entries.find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
}

/** A line's text: UTF-8 in a file with a byte-order mark, else Windows-1252 (UTF-8 when it can't hold it). */
const decode = (p: PrjPcb, bin: string): string => (p.bom ? binToUtf8(bin) : ansiToStr(bin, p.cp ?? 1252));
const line = (p: PrjPcb, k: string, v: string): string => (p.bom ? utf8ToBin(`${k}=${v}`) : strToAnsi(`${k}=${v}`, p.cp ?? 1252) ?? utf8ToBin(`${k}=${v}`));

/** Set one key, adding the key (or the section, at the end) when missing. */
export function iniSet(p: PrjPcb, section: string, key: string, value: string): void {
  const s = iniSection(p, section);
  if (!s) { appendSection(p, section, [[key, value]]); return; }
  for (let i = s.at + 1; i < s.end; i++) {
    const raw = p.lines[i]!, eq = raw.indexOf('=');
    if (eq > 0 && decode(p, raw.slice(0, eq)).toLowerCase() === key.toLowerCase()) { p.lines[i] = line(p, decode(p, raw.slice(0, eq)), value); return; }
  }
  p.lines.splice(s.end, 0, line(p, key, value));
}

/** Replace a section's whole content (created at the end when missing). */
export function iniSetSection(p: PrjPcb, section: string, entries: [string, string][]): void {
  const s = iniSection(p, section);
  if (!s) { appendSection(p, section, entries); return; }
  p.lines.splice(s.at + 1, s.end - s.at - 1, ...entries.map(([k, v]) => line(p, k, v)));
}

export function iniRemoveSection(p: PrjPcb, section: string): void {
  const s = iniSection(p, section);
  if (!s) return;
  // The section and one blank line after it
  const end = s.end < p.lines.length && !p.lines[s.end]!.trim() ? s.end + 1 : s.end;
  p.lines.splice(s.at, end - s.at);
}

function appendSection(p: PrjPcb, section: string, entries: [string, string][]): void {
  // Before the trailing blank lines, keeping one blank line between sections
  let at = p.lines.length;
  while (at > 0 && !p.lines[at - 1]!.trim()) at--;
  const block = [...(at > 0 ? [''] : []), `[${section}]`, ...entries.map(([k, v]) => line(p, k, v))];
  p.lines.splice(at, 0, ...block);
}

/** Renumber [PrefixN] sections 1, 2, 3 … in file order (after one was removed). */
function renumber(p: PrjPcb, prefix: string): void {
  let n = 0;
  for (const s of iniSections(p)) {
    if (!new RegExp(`^${prefix}\\d+$`, 'i').test(s.name)) continue;
    n++;
    p.lines[s.at] = `[${prefix}${n}]`;
  }
}

/* ─── Documents and parameters ──────────────────────────────────────────────────────── */

const docId = () => Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 25))).join('');

/** Project › Add Existing to Project: a [DocumentN] section as Altium Designer 17 writes it. */
export function addDocument(p: PrjPcb, path: string): boolean {
  const winPath = path.replace(/\//g, '\\');
  if (p.documents.some((d) => d.toLowerCase() === winPath.replace(/\\/g, '/').toLowerCase())) return false;
  const n = iniSections(p).filter((s) => /^Document\d+$/i.test(s.name)).length + 1;
  const entries: [string, string][] = [
    ['DocumentPath', winPath], ['AnnotationEnabled', '1'], ['AnnotateStartValue', '1'], ['AnnotationIndexControlEnabled', '0'], ['AnnotateSuffix', ''],
    ['AnnotateScope', 'All'], ['AnnotateOrder', '-1'], ['DoLibraryUpdate', '1'], ['DoDatabaseUpdate', '1'], ['ClassGenCCAutoEnabled', '1'],
    ['ClassGenCCAutoRoomEnabled', '1'], ['ClassGenNCAutoScope', 'None'], ['DItemRevisionGUID', ''], ['GenerateClassCluster', '0'], ['DocumentUniqueId', docId()],
  ];
  // After the last [DocumentN] (or at the end)
  const docs = iniSections(p).filter((s) => /^Document\d+$/i.test(s.name));
  const last = docs.at(-1);
  if (last) p.lines.splice(last.end, 0, '', `[Document${n}]`, ...entries.map(([k, v]) => line(p, k, v)));
  else appendSection(p, `Document${n}`, entries);
  reparse(p);
  return true;
}

/** Project › Remove from Project. */
export function removeDocument(p: PrjPcb, path: string): boolean {
  const want = path.replace(/\\/g, '/').toLowerCase();
  const s = iniSections(p).find((x) => /^Document\d+$/i.test(x.name)
    && (x.entries.find(([k]) => k.toLowerCase() === 'documentpath')?.[1] ?? '').replace(/\\/g, '/').toLowerCase() === want);
  if (!s) return false;
  iniRemoveSection(p, s.name);
  renumber(p, 'Document');
  reparse(p);
  return true;
}

/** Rename a document path (Save As, Rename Child Sheet). */
export function renameDocument(p: PrjPcb, from: string, to: string): void {
  const want = from.replace(/\\/g, '/').toLowerCase();
  const s = iniSections(p).find((x) => /^Document\d+$/i.test(x.name)
    && (x.entries.find(([k]) => k.toLowerCase() === 'documentpath')?.[1] ?? '').replace(/\\/g, '/').toLowerCase() === want);
  if (s) iniSet(p, s.name, 'DocumentPath', to.replace(/\//g, '\\'));
  reparse(p);
}

/** Reorder the project's documents (Number Schematic Sheets › Move Up / Down); paths in the new order. */
export function reorderDocuments(p: PrjPcb, order: string[]): boolean {
  const secs = iniSections(p).filter((s) => /^Document\d+$/i.test(s.name));
  if (secs.length < 2) return false;
  const first = secs[0]!.at, last = secs.at(-1)!;
  // Only when the [DocumentN] sections sit together (as Altium writes them)
  const span = iniSections(p).filter((s) => s.at >= first && s.at <= last.at);
  if (span.length !== secs.length) return false;
  const pathOf = (s: IniSection) => (s.entries.find(([k]) => k.toLowerCase() === 'documentpath')?.[1] ?? '').replace(/\\/g, '/').toLowerCase();
  const want = order.map((x) => x.toLowerCase());
  const sorted = [...secs].sort((a, b) => {
    const ia = want.indexOf(pathOf(a)), ib = want.indexOf(pathOf(b));
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  if (sorted.every((s, i) => s === secs[i])) return false;
  const block: string[] = [];
  sorted.forEach((s, i) => { if (i) block.push(''); block.push(...p.lines.slice(s.at, s.end)); });
  p.lines.splice(first, last.end - first, ...block);
  renumber(p, 'Document');
  reparse(p);
  return true;
}

/** Project Options › Parameters: the whole list, in order. */
export function projectParameters(p: PrjPcb): { name: string; value: string }[] {
  return iniSections(p).filter((s) => /^Parameter\d+$/i.test(s.name)).map((s) => ({
    name: s.entries.find(([k]) => k.toLowerCase() === 'name')?.[1] ?? '',
    value: s.entries.find(([k]) => k.toLowerCase() === 'value')?.[1] ?? '',
  }));
}

export function setProjectParameters(p: PrjPcb, list: { name: string; value: string }[]): void {
  for (const s of iniSections(p).filter((x) => /^Parameter\d+$/i.test(x.name)).reverse()) iniRemoveSection(p, s.name);
  // After the documents, as Altium places them
  const anchor = [...iniSections(p)].reverse().find((s) => /^(GeneratedDocument|Document)\d+$/i.test(s.name));
  const block: string[] = [];
  list.forEach((x, i) => block.push('', `[Parameter${i + 1}]`, line(p, 'Name', x.name), line(p, 'Value', x.value)));
  if (anchor) p.lines.splice(anchor.end, 0, ...block);
  else for (const [i, x] of list.entries()) appendSection(p, `Parameter${i + 1}`, [['Name', x.name], ['Value', x.value]]);
  reparse(p);
}

/** A new, empty project as Altium Designer 17 starts one. */
export function newPrjPcb(name: string): PrjPcb {
  const text = ['[Design]', 'Version=1.0', 'HierarchyMode=0', 'ChannelRoomNamingStyle=0', 'ReleasesFolder=', 'ChannelDesignatorFormatString=$Component_$RoomName',
    'ChannelRoomLevelSeperator=_', 'OpenOutputs=1', 'ArchiveProject=0', 'TimestampOutput=0', 'SeparateFolders=0', 'TemplateLocationPath=', 'PinSwapBy_Netlabel=1',
    'PinSwapBy_Pin=1', 'AllowPortNetNames=0', 'AllowSheetEntryNetNames=1', 'AppendSheetNumberToLocalNets=0', 'NetlistSinglePinNets=0', 'DefaultConfiguration=',
    'UserID=0xFFFFFFFF', 'DefaultPcbProtel=1', 'DefaultPcbPcad=0', 'ReorderDocumentsOnCompile=1', 'NameNetsHierarchically=0', 'PowerPortNamesTakePriority=0',
    'PushECOToAnnotationFile=1', 'DItemRevisionGUID=', 'ReportSuppressedErrorsInMessages=0', `OutputPath=Project Outputs for ${name.replace(/\.prjpcb$/i, '')}`,
    'LogFolderPath=', 'ManagedProjectGUID=', 'IncludeDesignInRelease=0', ''].join('\r\n');
  return readPrjPcb(binToBytes(text), name);
}

/** A new, empty Integrated Library package (.LibPkg): the same file, the library project's settings [est]. */
export function newLibPkg(name: string): PrjPcb {
  const text = ['[Design]', 'Version=1.0', 'HierarchyMode=0', 'ChannelRoomNamingStyle=0', 'ReleasesFolder=', 'ChannelDesignatorFormatString=$Component_$RoomName',
    'ChannelRoomLevelSeperator=_', 'OpenOutputs=1', 'ArchiveProject=0', 'TimestampOutput=0', 'SeparateFolders=0', 'TemplateLocationPath=', 'PinSwapBy_Netlabel=1',
    'PinSwapBy_Pin=1', 'AllowPortNetNames=0', 'AllowSheetEntryNetNames=1', 'AppendSheetNumberToLocalNets=0', 'NetlistSinglePinNets=0', 'DefaultConfiguration=',
    'UserID=0xFFFFFFFF', 'DefaultPcbProtel=1', 'DefaultPcbPcad=0', 'ReorderDocumentsOnCompile=1', 'NameNetsHierarchically=0', 'PowerPortNamesTakePriority=0',
    'PushECOToAnnotationFile=1', 'DItemRevisionGUID=', 'ReportSuppressedErrorsInMessages=0', `OutputPath=Project Outputs for ${name.replace(/\.libpkg$/i, '')}`,
    'LogFolderPath=', 'ManagedProjectGUID=', ''].join('\r\n');
  return readPrjPcb(binToBytes(text), name);
}

/** Project kinds Konium opens: PCB projects and Integrated Library packages. */
export const PROJECT_FILE = /\.(prjpcb|libpkg|prjmbd|prjhar)$/i;
export const isLibPkgName = (name: string): boolean => /\.libpkg$/i.test(name);
