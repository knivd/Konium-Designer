/**
 * AD's multi-board design files.
 *
 * - .PrjMbd: a project file (as .PrjPcb) whose documents are its multi-board schematic and
 *   assembly and the child projects (..\Board\Board.PrjPcb), one per module.
 * - .MbsDoc (multi-board schematic): a ZIP of JSON — logical.json (the modules, each with its
 *   source project, the connectors imported from it with their pins and nets, its entries and
 *   which pins each entry takes; the connections between entries: direct, wire, cable,
 *   harness), Pages\page_N.json (the drawing: the sheet, then items by $type — a module's
 *   rectangle, its entries docked on its sides, linked texts, connection points and lines, all
 *   in WPF units of 1/96 inch, y down), styles, defaults, options, parameters.
 * - .MbaDoc (multi-board assembly): a ZIP of each part's folder (general.partjson: the board it
 *   shows — DesignFileName, DocumentPath — its 4×4 Transform into the assembly (row vectors,
 *   translation in M41–M43, millimetres [est]), the board's offset, outline, holes, components
 *   and layer stack as AD last read them; STEP\ models; geometry.bin), the mates and settings.
 *
 * Konium keeps every file of the archive and rewrites only the JSON it changed (with AD's
 * indentation for the schematic's, compact for the assembly's parts).
 */
import { unzipSync } from '../inflate';
import { zip } from '../zip';

type Json = Record<string, unknown>;
const dec = new TextDecoder(), enc = new TextEncoder();
const parse = (b: Uint8Array): unknown => JSON.parse(dec.decode(b).replace(/^﻿/, ''));

/** A ZIP's files, kept in order, with the JSON ones changed marked. */
interface Archive { files: { name: string; bytes: Uint8Array }[] }
const fileOf = (a: Archive, name: string) => a.files.find((f) => f.name.toLowerCase() === name.toLowerCase());

export interface Change { label: string; undo: () => void; redo: () => void }

/* ─── Multi-board schematic ────────────────────────────────────────────────────── */

export interface MbsModule {
  id: number; designator: string; title?: string;
  source: { sourceProject?: string; boardFileName?: string };
  components: { designator: string; comment?: string; pins: { pinId: string; name: string; number: string; parameters: { name: string; value?: string; id: number }[]; id: number }[]; parameters?: unknown[]; id: number }[];
  entries: { id: number; logicalConnection?: number; definedDesignator?: string; calculatedDesignator?: string; entryType?: number }[];
  entryPinMap?: { map: { key: number; value: number }[] };
  [k: string]: unknown;
}
export interface MbsConnection {
  $type: string; id: number; designator?: string;
  entriesConnection?: { entry1: number; entry2: number; id: number };
  entries?: MbsModule['entries'];
  components?: MbsModule['components'];
  entryPinMap?: { map: { key: number; value: number }[] };
  [k: string]: unknown;
}
export interface MbsLogical { uniqueId?: string; modules: MbsModule[]; powerPorts: unknown[]; connections: MbsConnection[]; conflicts: unknown[]; parameters: unknown[]; [k: string]: unknown }
export interface MbsItem { $type: string; id: number; parentId?: number; logicalObjectId?: number; rect?: { x?: number; y?: number; width?: number; height?: number }; offset?: { x?: number; y?: number }; position?: { x?: number; y?: number }; [k: string]: unknown }
export interface MbsPage { name: string; data: { size?: { width?: number; height?: number }; margin?: { top?: number; left?: number; right?: number; bottom?: number }; standardSizeName?: string; horizontalZoneCount?: number; verticalZoneCount?: number; showZones?: boolean; items: MbsItem[]; [k: string]: unknown } }

export interface MbsDocument {
  kind: 'MbsDoc'; name: string; dirty: boolean;
  archive: Archive;
  logical: MbsLogical;
  pages: MbsPage[];
  styles: { lineStyles?: { id?: number; thickness?: number; color?: Rgb; dashPattern?: number[] }[]; fillStyles?: (Rgb & { id?: number; color?: Rgb })[]; fontStyles?: { id?: number; size?: number; familyName?: string }[] };
  undo: Change[]; redo: Change[];
}
export interface Rgb { a?: number; r?: number; g?: number; b?: number }

export function isZip(b: Uint8Array): boolean { return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; }

export function readMbsDoc(bytes: Uint8Array, name: string): MbsDocument {
  const archive: Archive = { files: unzipSync(bytes) };
  const lf = fileOf(archive, 'logical.json');
  if (!lf) throw new Error(`${name}: no logical.json — not a multi-board schematic`);
  const logical = parse(lf.bytes) as MbsLogical;
  if (!isObj(logical)) throw new Error(`${name}: its logical.json is not a multi-board schematic's`);
  for (const k of ['modules', 'powerPorts', 'connections', 'conflicts', 'parameters'] as const) (logical as Json)[k] = objects(logical[k]);
  const pages = archive.files.filter((f) => /^pages[\\/]page_\d+\.json$/i.test(f.name)).sort((a, b) => num(a.name) - num(b.name))
    .map((f) => { const data = parse(f.bytes); return { name: f.name, data: (isObj(data) ? data : {}) as MbsPage['data'] }; });
  for (const p of pages) p.data.items = objects(p.data.items);
  const st = fileOf(archive, 'styles.json'), read = st ? parse(st.bytes) : null;
  const styles: MbsDocument['styles'] = {};
  if (isObj(read)) for (const k of ['lineStyles', 'fillStyles', 'fontStyles'] as const) if (Array.isArray(read[k])) (styles as Json)[k] = objects(read[k]);
  return { kind: 'MbsDoc', name, dirty: false, archive, logical, pages, styles, undo: [], redo: [] };
}
/** What a file's JSON holds is whatever its writer put there: lists are made lists of objects before anything walks them. */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const objects = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v.filter(isObj) : []) as T[];

/** One part of a colour: a whole number from 0 to 255, or the default. */
const part = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : def);
/**
 * A style's colour for the drawing, made of numbers only. The styles are read as the file gives
 * them, so a "colour" there may be any text: none of it may reach the drawing's markup.
 */
export function mbsColour(c: unknown, def: string): string {
  if (!isObj(c)) return def;
  return `rgba(${part(c.r, 0)},${part(c.g, 0)},${part(c.b, 0)},${Math.round((part(c.a, 255) / 255) * 1000) / 1000})`;
}
/** A line style for the drawing: its colour, its width and its dashes, numbers only. */
export function mbsLine(l: unknown): { colour: string; w: number; dash: string } {
  const o = isObj(l) ? l : {};
  const t = typeof o.thickness === 'number' && Number.isFinite(o.thickness) && o.thickness > 0 ? Math.min(o.thickness, 100) : null;
  const dash = Array.isArray(o.dashPattern) ? o.dashPattern.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0).slice(0, 16).map((x) => Math.round(x * (t ?? 1) * 100) / 100).join(' ') : '';
  return { colour: mbsColour(o.color, '#2f5a8e'), w: t ?? 1.5, dash };
}
const num = (s: string) => Number(/(\d+)\.json$/i.exec(s)?.[1] ?? 0);

/** AD's JSON layout for the schematic's files: two-space indents, CRLF. */
const adJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/\n/g, '\r\n');

export function writeMbsDoc(d: MbsDocument): Uint8Array {
  const files = d.archive.files.map((f) => {
    if (f.name.toLowerCase() === 'logical.json') return { name: f.name, bytes: enc.encode(adJson(d.logical)) };
    const p = d.pages.find((x) => x.name === f.name);
    return p ? { name: f.name, bytes: enc.encode(adJson(p.data)) } : f;
  });
  for (const p of d.pages) if (!files.some((f) => f.name === p.name)) files.push({ name: p.name, bytes: enc.encode(adJson(p.data)) });
  return zip(files);
}

/** A new multi-board schematic: one A3 sheet, no modules [est: AD's defaults trimmed to what is read back]. */
export function newMbsDoc(name: string): MbsDocument {
  const files = [
    { name: 'core.json', bytes: enc.encode(adJson({ version: 1, modified: new Date().toISOString() })) },
    { name: 'styles.json', bytes: enc.encode(adJson(defaultStyles())) },
    { name: 'logical.json', bytes: enc.encode(adJson({ uniqueId: uid(), modules: [], powerPorts: [], connections: [], conflicts: [], parameters: [] })) },
    { name: 'Pages\\page_1.json', bytes: enc.encode(adJson({ size: { width: 1587.401574803, height: 1122.519685039 }, margin: { top: 10, left: 10, right: 10, bottom: 10 }, sheetSizingMode: 1, standardSizeName: 'A3', horizontalZoneCount: 8, verticalZoneCount: 6, showZones: true, items: [] })) },
  ];
  const d = readMbsDoc(zip(files), name);
  d.dirty = true;
  return d;
}
function defaultStyles() {
  return {
    lineStyles: [{ thickness: 1.889763779527559, color: { a: 255, r: 112, g: 48, b: 160 }, thicknessPresetId: 2, dashPatternPresetId: 0, id: 1 },
      { thickness: 0.3779527559055119, color: { a: 255, r: 112, g: 48, b: 160 }, thicknessPresetId: 0, dashPatternPresetId: 0, id: 2 },
      { thickness: 1.92, color: { a: 255, r: 47, g: 90, b: 142 }, id: 3 }, { thickness: 0.384, color: { a: 255, r: 47, g: 90, b: 142 }, id: 5 }],
    fillStyles: [{ color: { a: 255, r: 146, g: 205, b: 220 }, id: 1 }, { color: { a: 255, r: 255, g: 255, b: 255 }, id: 2 }],
    fontStyles: [{ size: 14, familyName: 'Arial', id: 1 }, { size: 14, familyName: 'Arial', id: 2 }, { size: 14, familyName: 'Arial', id: 3 }, { size: 10, familyName: 'Arial', id: 4 }],
  };
}
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

/* ─── The schematic's meaning ──────────────────────────────────────────────────── */

/** An entry's name: its designator as set, else as worked out. */
export const entryName = (e: { definedDesignator?: string; calculatedDesignator?: string }) => e.definedDesignator || e.calculatedDesignator || '?';
export const moduleName = (m: MbsModule) => (m.title ? `${m.designator} ${m.title}` : m.designator);
export const moduleProject = (m: MbsModule) => (m.source?.sourceProject ?? '').split(/[\\/]/).pop() ?? '';
const CONNECTION_KINDS: Record<string, string> = { __logicalDirectConnection: 'Direct', __logicalWireConnection: 'Wire', __logicalCableConnection: 'Cable', __logicalHarnessConnection: 'Harness' };
export const connectionKind = (c: MbsConnection) => CONNECTION_KINDS[c.$type] ?? c.$type.replace(/^__logical|Connection$/g, '');

export interface MbsPin { module: MbsModule; entry: number; connector: string; pin: string; name: string; net: string }
/** Every module pin that an entry takes, with its net in the child project. */
export function entryPins(d: MbsDocument): Map<number, MbsPin[]> {
  const out = new Map<number, MbsPin[]>();
  for (const m of d.logical.modules) {
    const byPin = new Map<number, number>((m.entryPinMap?.map ?? []).map((x) => [x.key, x.value]));
    for (const c of m.components ?? []) {
      for (const p of c.pins ?? []) {
        let e = byPin.get(p.id);
        // One entry for a lone connector: its pins are the entry's [est]
        if (e === undefined && (m.entries ?? []).length === 1 && (m.components ?? []).length === 1) e = m.entries[0]!.id;
        if (e === undefined) continue;
        const net = p.parameters?.find((x) => x.name === 'ExternalNetName')?.value ?? '';
        const list = out.get(e) ?? [];
        list.push({ module: m, entry: e, connector: c.designator, pin: p.number || p.pinId, name: p.name, net });
        out.set(e, list);
      }
    }
  }
  return out;
}

export interface MbsLink { connection: string; kind: string; a: string; b: string; netA: string; netB: string }
/**
 * Pin to pin across the boards: a direct or wire connection joins its two entries' pins by
 * number [est: AD's straight-through mapping]; a harness or cable joins each module entry to its
 * own end's connector, pin by number, and through the harness its pins of the same net.
 */
export function crossBoardLinks(d: MbsDocument): MbsLink[] {
  const pins = entryPins(d);
  const entryOwner = new Map<number, MbsModule>();
  for (const m of d.logical.modules) for (const e of m.entries ?? []) entryOwner.set(e.id, m);
  const label = (p: MbsPin) => `${p.module.designator}:${p.connector}-${p.pin}`;
  const out: MbsLink[] = [];
  for (const c of d.logical.connections) {
    const kind = connectionKind(c), name = c.designator ?? String(c.id);
    if (c.entriesConnection) {
      const a = pins.get(c.entriesConnection.entry1) ?? [], b = pins.get(c.entriesConnection.entry2) ?? [];
      // Entries with no connector imported: the entries themselves, by name
      if (!a.length && !b.length) {
        const ea = entryOwner.get(c.entriesConnection.entry1), eb = entryOwner.get(c.entriesConnection.entry2);
        const na = ea?.entries.find((x) => x.id === c.entriesConnection!.entry1), nb = eb?.entries.find((x) => x.id === c.entriesConnection!.entry2);
        out.push({ connection: name, kind, a: `${ea?.designator ?? '?'}:${na ? entryName(na) : '?'}`, b: `${eb?.designator ?? '?'}:${nb ? entryName(nb) : '?'}`, netA: na ? entryName(na) : '', netB: nb ? entryName(nb) : '' });
        continue;
      }
      for (const pa of a) {
        const pb = b.find((x) => x.pin === pa.pin);
        out.push({ connection: name, kind, a: label(pa), b: pb ? label(pb) : '(none)', netA: pa.net, netB: pb?.net ?? '' });
      }
      continue;
    }
    // A harness or cable: its own connectors' pins name the nets they carry (ExternalNetName)
    const ends = c.components ?? [];
    const byNet = new Map<string, string[]>();
    const endOf = new Map<number, number>((c.entryPinMap?.map ?? []).map((x) => [x.key, x.value]));
    for (const comp of ends) for (const p of comp.pins ?? []) {
      const net = p.parameters?.find((x) => x.name === 'ExternalNetName')?.value ?? '';
      if (!net) continue;
      // The harness end's own name (P1 …) where its entry gives one
      const e = (c.entries ?? []).find((x) => x.id === endOf.get(p.id));
      byNet.set(net, [...(byNet.get(net) ?? []), `${e ? entryName(e) : comp.designator}-${p.number}`]);
    }
    // Each module entry tied to the harness (its logical connection): its pins by net
    for (const [e, list] of pins) {
      const owner = entryOwner.get(e);
      const ent = owner?.entries.find((x) => x.id === e);
      if (!owner || ent?.logicalConnection !== c.id) continue;
      for (const p of list) if (p.net) out.push({ connection: name, kind, a: label(p), b: (byNet.get(p.net) ?? ['(not wired)']).join(', '), netA: p.net, netB: p.net });
    }
  }
  return out;
}

/** Problems a designer would want told: entries joined to nothing, pins with no partner, connectors with no entry. */
export function mbsChecks(d: MbsDocument): string[] {
  const out: string[] = [];
  const used = new Set<number>();
  for (const c of d.logical.connections) {
    if (c.entriesConnection) { used.add(c.entriesConnection.entry1); used.add(c.entriesConnection.entry2); }
  }
  for (const m of d.logical.modules) {
    if (!m.source?.sourceProject) out.push(`Module ${m.designator}: no child project`);
    for (const e of m.entries ?? []) if (!used.has(e.id) && e.logicalConnection === undefined) out.push(`Module ${m.designator}: entry ${entryName(e)} isn't connected`);
  }
  for (const l of crossBoardLinks(d)) {
    if (l.b === '(none)') out.push(`${l.connection}: ${l.a} (${l.netA || 'no net'}) has no pin to meet on the other side`);
    else if (l.kind !== 'Harness' && l.netA && l.netB && l.netA !== l.netB) out.push(`${l.connection}: ${l.a} (${l.netA}) meets ${l.b} (${l.netB})`);
  }
  return out;
}

/* ─── Editing ─────────────────────────────────────────────────────────────────── */

export function change(d: { undo: Change[]; redo: Change[]; dirty: boolean }, label: string, redo: () => void, undo: () => void): void {
  redo();
  d.undo.push({ label, undo, redo });
  if (d.undo.length > 200) d.undo.shift();
  d.redo = [];
  d.dirty = true;
}
export function undoChange(d: { undo: Change[]; redo: Change[]; dirty: boolean }): string | null {
  const c = d.undo.pop(); if (!c) return null; c.undo(); d.redo.push(c); d.dirty = true; return c.label;
}
export function redoChange(d: { undo: Change[]; redo: Change[]; dirty: boolean }): string | null {
  const c = d.redo.pop(); if (!c) return null; c.redo(); d.undo.push(c); d.dirty = true; return c.label;
}

/** Moves an item placed by itself (a module's rectangle, a connection point) by dx, dy. */
export function moveMbsItem(d: MbsDocument, it: MbsItem, dx: number, dy: number): void {
  const r = it.rect, p = it.position;
  const at = r ? { x: r.x ?? 0, y: r.y ?? 0 } : p ? { x: p.x ?? 0, y: p.y ?? 0 } : null;
  if (!at) return;
  const set = (x: number, y: number) => { if (r) { r.x = x; r.y = y; } else if (p) { p.x = x; p.y = y; } };
  change(d, 'Move', () => set(at.x + dx, at.y + dy), () => set(at.x, at.y));
}

let nextNo = 0;
export function nextMbsId(d: MbsDocument): number {
  let max = nextNo;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v as Json)) { if (k === 'id' && typeof x === 'number') max = Math.max(max, x); else walk(x); } }
  };
  walk(d.logical); for (const p of d.pages) walk(p.data.items);
  nextNo = max + 1;
  return nextNo;
}

/** Design › Place Module: a module for a child project, its rectangle at x, y on the first page. */
export function addModule(d: MbsDocument, project: string, x: number, y: number): MbsModule {
  const id = nextMbsId(d), rid = nextMbsId(d), tid = nextMbsId(d), did = nextMbsId(d);
  const taken = new Set(d.logical.modules.map((m) => m.designator));
  let n = 1; while (taken.has(String(n))) n++;
  const title = project.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const m: MbsModule = { designator: String(n), title, source: { sourceProject: project }, functionalBlocks: [], components: [], entries: [], entryPinMap: { map: [] }, parameters: [{ name: 'SourceId', value: project.split(/[\\/]/).pop()!, id: nextMbsId(d) }], id };
  const page = d.pages[0]!;
  const items: MbsItem[] = [
    { $type: '__drawingModule', logicalObjectId: id, rect: { x, y, width: 134.4, height: 172.8 }, lineStyleId: 1, fillStyleId: 1, anchor: 5, selectable: true, id: rid },
    { $type: '__drawingLinkedProperty', offset: { y: 1.92 }, color: { a: 255, b: 128 }, directValue: String(n), propertyValuePath: 'LogicalObject.Designator', fontStyleId: 2, autoposition: true, isVisible: true, anchor: 5, parentId: rid, selectable: true, id: did },
    { $type: '__drawingLinkedProperty', offset: { y: -16.49 }, color: { a: 255, b: 128 }, directName: 'Title', directValue: title, propertyValuePath: 'LogicalObject.Title', fontStyleId: 2, autoposition: true, isVisible: true, anchorType: 6, group: 2, order: 1, showPropertyName: true, anchor: 5, parentId: rid, selectable: true, id: tid },
  ];
  change(d, 'Place Module', () => { d.logical.modules.push(m); page.data.items.push(...items); }, () => {
    d.logical.modules.splice(d.logical.modules.indexOf(m), 1);
    page.data.items = page.data.items.filter((i) => !items.includes(i));
  });
  return m;
}

/* ─── Multi-board assembly ────────────────────────────────────────────────────── */

export interface MbaPart {
  folder: string;
  json: Json;
  /** A board (PartType 0) or a mechanical model (STEP, 2). */
  type: number;
  name: string;
  /** Row-vector 4×4: [M11 … M44]. */
  m: number[];
  changed: boolean;
}
export interface MbaDocument { kind: 'MbaDoc'; name: string; dirty: boolean; archive: Archive; parts: MbaPart[]; undo: Change[]; redo: Change[] }

const MKEYS = ['M11', 'M12', 'M13', 'M14', 'M21', 'M22', 'M23', 'M24', 'M31', 'M32', 'M33', 'M34', 'M41', 'M42', 'M43', 'M44'];
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function readMbaDoc(bytes: Uint8Array, name: string): MbaDocument {
  const archive: Archive = { files: unzipSync(bytes) };
  const parts: MbaPart[] = [];
  for (const f of archive.files) {
    const m = /^(.+)[\\/]general\.partjson$/i.exec(f.name);
    if (!m) continue;
    try {
      const json = parse(f.bytes) as Json;
      const t = (json.Transform ?? {}) as Json;
      parts.push({
        folder: m[1]!, json, type: Number(json.PartType ?? 0), changed: false,
        name: String(json.PCBTitle || json.Title || json.DesignFileName || m[1]),
        m: MKEYS.map((k, i) => (typeof t[k] === 'number' ? (t[k] as number) : IDENTITY[i]!)),
      });
    } catch { /* a part that can't be read stays in the archive as it is */ }
  }
  return { kind: 'MbaDoc', name, dirty: false, archive, parts, undo: [], redo: [] };
}

/** The transform's derived members (AD writes them beside the matrix). */
function transformJson(m: number[], was: Json): Json {
  const v = (x: number, y: number, z: number, w?: number) => {
    const len = Math.hypot(x, y, z, w ?? 0);
    return { X: x, Y: y, Z: z, ...(w !== undefined ? { W: w } : {}), IsNormalized: Math.abs(len - 1) < 1e-6, IsZero: len === 0 };
  };
  const [m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44] = m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const out: Json = { ...was };
  MKEYS.forEach((k, i) => { out[k] = m[i]; });
  Object.assign(out, {
    Up: v(m21, m22, m23), Down: v(-m21, -m22, -m23), Right: v(m11, m12, m13), Left: v(-m11, -m12, -m13), Forward: v(-m31, -m32, -m33), Backward: v(m31, m32, m33),
    Row1: v(m11, m12, m13, m14), Row2: v(m21, m22, m23, m24), Row3: v(m31, m32, m33, m34), Row4: v(m41, m42, m43, m44),
    Column1: v(m11, m21, m31, m41), Column2: v(m12, m22, m32, m42), Column3: v(m13, m23, m33, m43), Column4: v(m14, m24, m34, m44),
    TranslationVector: v(m41, m42, m43), ScaleVector: v(m11, m22, m33),
    IsIdentity: m.every((x, i) => Math.abs(x - IDENTITY[i]!) < 1e-12),
  });
  return out;
}

export function writeMbaDoc(d: MbaDocument): Uint8Array {
  const files = d.archive.files.map((f) => {
    const p = d.parts.find((x) => x.changed && f.name.toLowerCase() === `${x.folder}\\general.partjson`.toLowerCase() || x.changed && f.name.toLowerCase() === `${x.folder}/general.partjson`.toLowerCase());
    if (!p) return f;
    p.json.Transform = transformJson(p.m, (p.json.Transform ?? {}) as Json);
    return { name: f.name, bytes: enc.encode(JSON.stringify(p.json)) };
  });
  return zip(files);
}

/** A part's matrix set (undoably). */
export function setPartMatrix(d: MbaDocument, p: MbaPart, m: number[], label = 'Move'): void {
  const was = p.m.slice(), wasChanged = p.changed;
  change(d, label, () => { p.m = m.slice(); p.changed = true; }, () => { p.m = was; p.changed = wasChanged; });
}

/** Row-vector product: a then b. */
export function mulM(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k]! * b[k * 4 + c]!;
  return o;
}
/** A turn about an axis through the part's own position (degrees), or a shift (mm). */
export function turned(m: number[], axis: 'x' | 'y' | 'z', deg: number): number[] {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const r = axis === 'z' ? [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : axis === 'x' ? [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1] : [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  const t = m.slice(12, 15);
  const rot = mulM([...m.slice(0, 12), 0, 0, 0, 1], r);
  rot[12] = t[0]!; rot[13] = t[1]!; rot[14] = t[2]!;
  return rot;
}
export const shifted = (m: number[], dx: number, dy: number, dz: number) => { const o = m.slice(); o[12] += dx; o[13] += dy; o[14] += dz; return o; };
/** A point (mm) into the assembly: [x y z 1] × M. */
export const applyM = (m: number[], p: [number, number, number]): [number, number, number] => [
  p[0] * m[0]! + p[1] * m[4]! + p[2] * m[8]! + m[12]!, p[0] * m[1]! + p[1] * m[5]! + p[2] * m[9]! + m[13]!, p[0] * m[2]! + p[1] * m[6]! + p[2] * m[10]! + m[14]!];
export const applyDirM = (m: number[], p: [number, number, number]): [number, number, number] => [
  p[0] * m[0]! + p[1] * m[4]! + p[2] * m[8]!, p[0] * m[1]! + p[1] * m[5]! + p[2] * m[9]!, p[0] * m[2]! + p[1] * m[6]! + p[2] * m[10]!];

/** A board part's offset (board units: its local origin on the board) and its outline as AD last read it (board units, local). */
export function partOffset(p: MbaPart): { x: number; y: number } { const o = (p.json.PCBInitialOffset ?? {}) as Json; return { x: Number(o.X ?? 0), y: Number(o.Y ?? 0) }; }
export function partOutline(p: MbaPart): { x: number; y: number }[] {
  const regs = (p.json.BoardRegions ?? []) as Json[];
  const c = ((regs[0]?.Contours ?? []) as Json[])[0];
  return ((c?.Points ?? []) as Json[]).map((q) => ({ x: Number(q.X ?? 0), y: Number(q.Y ?? 0) }));
}
/** The board's document by its path from the assembly (..\Board\Board.PcbDoc), else its name. */
export const partBoardName = (p: MbaPart) => String(p.json.DocumentPath || p.json.DesignFileName || '').split(/[\\/]/).pop() ?? '';
/** The part's STEP files (a mechanical part's model). */
export function partSteps(d: MbaDocument, p: MbaPart): { name: string; bytes: Uint8Array }[] {
  const pre = `${p.folder}\\step\\`.toLowerCase(), pre2 = `${p.folder}/step/`.toLowerCase();
  return d.archive.files.filter((f) => (f.name.toLowerCase().startsWith(pre) || f.name.toLowerCase().startsWith(pre2)) && /\.(stp|step)$/i.test(f.name));
}

/** A new assembly: nothing in it yet [est: AD's settings file only]. */
export function newMbaDoc(name: string): MbaDocument {
  const d = readMbaDoc(zip([{ name: 'settings.json', bytes: enc.encode(JSON.stringify({ MeasurementSystem: 0, DocumentVersion: { Version: 2, Subversion: 3 } }, null, 2)) }, { name: 'tree.treejson', bytes: enc.encode(JSON.stringify({ DataModelUniqueId: 'Root', Name: 'Root', Designator: 'Root', Title: 'Root', Children: [] }, null, 2)) }]), name);
  d.dirty = true;
  return d;
}

/** A board added to the assembly (a part of type 0 with its transform and the board's offset). */
export function addBoardPart(d: MbaDocument, board: { name: string; path: string; offset: { x: number; y: number }; designator: string; title: string; sourceId: string }, at: [number, number, number]): MbaPart {
  const folder = `${board.sourceId.replace(/[\\/]/g, '-')}`;
  const uidN = d.parts.reduce((m, p) => Math.max(m, Number(p.json.InternalUID ?? 0)), -1) + 1;
  const m = [...IDENTITY]; m[12] = at[0]; m[13] = at[1]; m[14] = at[2];
  const json: Json = {
    PartType: 0, InternalUID: uidN, Unit: 0, DesignFileName: board.name, Transform: transformJson(m, {}), PCBInitialOffset: { X: board.offset.x, Y: board.offset.y, Z: 0 },
    Nets: [], LayerStack: {}, BoardRegions: [], Holes: [], RegionMates: [], Components: [], ParentDocumentPath: null, DocumentPath: board.path,
    EcoProps: { Designator: board.designator, SourceUniqueID: board.sourceId, UniqueID: null }, Title: board.title, PCBDesignator: board.designator, PCBTitle: board.title,
    IsVisible: true, IsLocked: false, ZTop: 0, ZBottom: 0, ParentMBAUniqueID: '',
  };
  const part: MbaPart = { folder, json, type: 0, name: board.title, m, changed: true };
  const file = { name: `${folder}\\general.partjson`, bytes: enc.encode(JSON.stringify(json)) };
  change(d, 'Insert Board', () => { d.parts.push(part); d.archive.files.push(file); }, () => {
    d.parts.splice(d.parts.indexOf(part), 1); d.archive.files.splice(d.archive.files.indexOf(file), 1);
  });
  return part;
}
