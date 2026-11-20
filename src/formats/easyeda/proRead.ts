/**
 * EasyEDA Pro's files read into one shape: projects (v2 .epro and its .zip: project.json and a
 * file per document; v3 .epro2: one log of every document's rows, the last revision of each row
 * kept, deleted ones dropped), libraries (.elibz, .elibz2) and lone documents (.efoo, .esym).
 * Every document comes out as v2's records (one array each, its type first): v3's named rows are
 * turned into them, its schematics' Y (down there) turned up as v2 has it, its styles inline.
 */
import { unzipEntries } from '../xlsxRead';

/** One record: v2's array (its type first); a symbol's records carry the part they belong to. */
export type Rec = unknown[] & { part?: string };
export interface ProDoc { type: string; uuid: string; title: string; recs: Rec[]; symbolType?: number }
export interface ProDevice { title: string; attributes: Record<string, string> }
export interface ProProject {
  title: string;
  version: 2 | 3;
  /** What links a schematic to its board. */
  boards: { name: string; schematic?: string; pcb?: string }[];
  schematics: Map<string, { name: string; pages: ProDoc[] }>;
  pcbs: Map<string, ProDoc>;
  symbols: Map<string, ProDoc>;
  footprints: Map<string, ProDoc>;
  devices: Map<string, ProDevice>;
  blobs: Map<string, string>;
  /** v2's poured copper (POUR/*.ecop), by board. */
  poured: Map<string, Rec[]>;
}

const td = new TextDecoder();
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const emptyProject = (title: string, version: 2 | 3): ProProject => ({ title, version, boards: [], schematics: new Map(), pcbs: new Map(), symbols: new Map(), footprints: new Map(), devices: new Map(), blobs: new Map(), poured: new Map() });
const attrsOf = (o: unknown): Record<string, string> => Object.fromEntries(Object.entries((o && typeof o === 'object' ? o : {}) as Record<string, unknown>).map(([k, v]) => [k, str(v)]));
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const uuidOf = (p: string) => baseName(p).split('.')[0] ?? '';

/** Whether the bytes look like an EasyEDA Pro file of this name. */
export function isEasyedaPro(name: string, bytes: Uint8Array): boolean {
  if (/\.(epro2?|elibz2?)$/i.test(name)) return true;
  const head = td.decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (/\.(efoo|esym)$/i.test(name)) return head.startsWith('[') || head.startsWith('{');
  if (/\.zip$/i.test(name) && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try { return unzipEntries(bytes).some((e) => e.name === 'project.json' || /(^|\/)project2\.json$/i.test(e.name)); } catch { return false; }
  }
  return false;
}

/** v2's records: one JSON array a line (a line that isn't one left out, as EasyEDA's own reader does). */
export function v2Recs(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('[')) continue;
    try { const r = JSON.parse(t) as unknown; if (Array.isArray(r) && typeof r[0] === 'string') out.push(r as Rec); } catch { /* skipped */ }
  }
  return out;
}

/* ── v3: the log ── */

interface Row { type: string; id: string; ticket: number; inner: unknown; seq: number }
interface LogDoc { docType: string; uuid: string; rows: Map<string, Row>; deleted: boolean; seq: number }

/** A v3 log's documents, each row at its last revision (an empty one a deletion). */
export function v3Docs(text: string): LogDoc[] {
  const docs = new Map<string, LogDoc>();
  let cur: LogDoc | null = null, seq = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const i = line.indexOf('||');
    if (i < 0) continue;
    let outer: { type?: string; id?: unknown; ticket?: number };
    try { outer = JSON.parse(line.slice(0, i)); } catch { continue; }
    let rest = line.slice(i + 2);
    if (rest.endsWith('|')) rest = rest.slice(0, -1);
    let inner: unknown = null;
    if (rest.trim() && rest.trim() !== '""') { try { inner = JSON.parse(rest); } catch { continue; } }
    if (outer.type === 'DOCHEAD') {
      const h = (inner ?? {}) as { docType?: string; uuid?: string };
      if (!h.docType || !h.uuid) { cur = null; continue; }
      const key = `${h.docType}\u0000${h.uuid}`;
      cur = docs.get(key) ?? { docType: h.docType, uuid: h.uuid, rows: new Map(), deleted: false, seq: seq++ };
      docs.set(key, cur);
      continue;
    }
    if (!cur || !outer.type) continue;
    if (outer.type === 'DELETE_DOC') { if (inner && (inner as { isDelete?: boolean }).isDelete) cur.deleted = true; continue; }
    const id = typeof outer.id === 'string' ? outer.id : JSON.stringify(outer.id ?? '');
    const key = `${outer.type}\u0000${id}`;
    const ticket = Number(outer.ticket ?? 0);
    const had = cur.rows.get(key);
    if (had && had.ticket > ticket) continue;
    cur.rows.set(key, { type: outer.type, id, ticket, inner, seq: had ? had.seq : seq++ });
  }
  return [...docs.values()].filter((d) => !d.deleted).sort((a, b) => a.seq - b.seq);
}

const rowsOf = (d: LogDoc): Row[] => [...d.rows.values()].filter((r) => r.inner !== null && typeof r.inner === 'object').sort((a, b) => a.seq - b.seq);
const metaOf = (d: LogDoc): Record<string, unknown> => (d.rows.get('META\u0000META')?.inner ?? {}) as Record<string, unknown>;
const keyId = (id: string): unknown[] => { if (id.startsWith('[')) { try { const v = JSON.parse(id); return Array.isArray(v) ? v : [id]; } catch { /* plain */ } } return [id]; };

/* ── v3 rows as v2 records ── */

type O = Record<string, unknown>;
const ORIGIN: Record<string, number> = { LEFT_TOP: 1, LEFT_MIDDLE: 2, LEFT_CENTER: 2, LEFT_BOTTOM: 3, CENTER_TOP: 4, CENTER_MIDDLE: 5, CENTER_CENTER: 5, CENTER_BOTTOM: 6, RIGHT_TOP: 7, RIGHT_MIDDLE: 8, RIGHT_CENTER: 8, RIGHT_BOTTOM: 9 };
const originCode = (v: unknown) => (typeof v === 'number' ? v : ORIGIN[str(v).toUpperCase()] ?? 3);
const PROHIBIT: Record<string, number> = { COMPONENT: 2, VIA: 3, TRACK: 5, FILL: 6, COPPER: 7, POUR: 7, PLANE: 8 };
/** A schematic text's look (v3 keeps it on the row): as a FONTSTYLE would give it. */
const fontLook = (o: O) => ({ color: o.color, size: o.fontSize, family: o.fontFamily, italic: o.italic, bold: o.fontWeight, align: o.align });
const lineLook = (o: O) => ({ color: o.strokeColor, dash: o.strokeStyle, fill: o.fillColor, width: o.strokeWidth, fillStyle: o.fillStyle });
const ny = (v: unknown) => (v === null || v === undefined ? v : -Number(v));
/** v3's points ({x, y}, [x, y] or flat), flat with Y turned up. */
function flatPoints(v: unknown): number[] {
  const out: number[] = [];
  if (!Array.isArray(v)) return out;
  if (v.length && typeof v[0] === 'number') { for (let i = 0; i + 1 < v.length; i += 2) out.push(Number(v[i]), -Number(v[i + 1])); return out; }
  for (const p of v) {
    if (Array.isArray(p)) out.push(Number(p[0]), -Number(p[1]));
    else if (p && typeof p === 'object') out.push(Number((p as O).x), -Number((p as O).y));
  }
  return out;
}

/** A schematic or symbol document's rows (Y down) as v2's records (Y up). */
function schRecs(d: LogDoc): Rec[] {
  const rows = rowsOf(d);
  const lines = new Map<string, number[][]>();
  for (const r of rows) {
    const o = r.inner as O;
    if (r.type === 'LINE' && o.lineGroup) {
      const g = str(o.lineGroup);
      if (!lines.has(g)) lines.set(g, []);
      lines.get(g)!.push([Number(o.startX), -Number(o.startY), Number(o.endX), -Number(o.endY)]);
    }
  }
  const parts: string[] = [];
  const byPart = new Map<string, Rec[]>();
  const loose: Rec[] = [];
  const put = (rec: Rec, o: O) => {
    const p = o.partId === undefined || o.partId === null ? undefined : str(o.partId);
    if (p === undefined) { loose.push(rec); return; }
    rec.part = p;
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p)!.push(rec);
  };
  for (const r of rows) {
    const o = r.inner as O, id = r.id;
    switch (r.type) {
      case 'PART': parts.push(id); byPart.set(id, byPart.get(id) ?? []); break;
      case 'ATTR': put(['ATTR', id, str(o.parentId), o.key, o.value, o.keyVisible, o.valueVisible, o.x, ny(o.y), o.rotation, fontLook(o), o.locked], o); break;
      case 'PIN': {
        const shape = str(o.pinShape).toUpperCase();
        put(['PIN', id, o.display ?? true, 0, o.x, ny(o.y), o.length, o.rotation, o.color, shape === 'INVERTED' ? 2 : shape === 'CLOCK' ? 1 : shape === 'INVERTED_CLOCK' ? 3 : 0, o.locked], o);
        break;
      }
      case 'RECT': put(['RECT', id, o.dotX1, ny(o.dotY1), o.dotX2, ny(o.dotY2), o.radiusX, o.radiusY, o.rotation, lineLook(o), o.locked], o); break;
      case 'CIRCLE': put(['CIRCLE', id, o.centerX, ny(o.centerY), o.radius, lineLook(o), o.locked], o); break;
      case 'ELLIPSE': put(['ELLIPSE', id, o.centerX, ny(o.centerY), o.radiusX, Math.abs(Number(o.radiusY)), o.rotation, lineLook(o), o.locked], o); break;
      case 'ARC': put(['ARC', id, o.startX, ny(o.startY), o.referX, ny(o.referY), o.endX, ny(o.endY), lineLook(o), o.locked], o); break;
      case 'POLY': put(['POLY', id, flatPoints(o.points), o.closed, lineLook(o), o.locked], o); break;
      case 'BEZIER': put(['BEZIER', id, flatPoints(o.controls), lineLook(o), o.locked], o); break;
      case 'TEXT': put(['TEXT', id, o.x, ny(o.y), o.rotation, o.value, fontLook(o), o.locked], o); break;
      case 'OBJ': put(['OBJ', id, str(o.fileName), o.startX ?? o.x, ny(o.startY ?? o.y), o.width, o.height, o.rotation, o.isMirror, o.content, o.locked], o); break;
      case 'COMPONENT': put(['COMPONENT', id, str(o.partId), o.x, ny(o.y), o.rotation, o.isMirror, o.attrs ?? {}, o.locked], { ...o, partId: undefined }); break;
      case 'WIRE': case 'BUS': {
        const dots = Array.isArray(o.dots) ? (o.dots as unknown[]).map((l) => flatPoints(l)) : [];
        put([r.type, id, [...(lines.get(id) ?? []), ...dots], lineLook(o), o.locked], { ...o, partId: undefined });
        break;
      }
      case 'LINE': if (!o.lineGroup) put(['POLY', id, [Number(o.startX), -Number(o.startY), Number(o.endX), -Number(o.endY)], false, lineLook(o), o.locked], o); break;
      case 'TABLE': put(['TABLE', id, o.startX, ny(o.startY), o.rowSizes, o.colSizes, o.rotation, o.tableCell], o); break;
      default:
    }
  }
  // v2's order: what belongs to no part, then each part after its PART
  const out: Rec[] = [...loose];
  for (const p of parts) {
    const head = rows.find((r) => r.type === 'PART' && r.id === p)!;
    const pr: Rec = ['PART', p, head.inner];
    pr.part = p;
    out.push(pr, ...(byPart.get(p) ?? []));
  }
  for (const [p, recs] of byPart) if (!parts.includes(p)) out.push(...recs);
  return out;
}

/** A board or footprint document's rows as v2's records (same units and axes in both). */
function pcbRecs(d: LogDoc): Rec[] {
  const out: Rec[] = [];
  for (const r of rowsOf(d)) {
    const o = r.inner as O, id = r.id, k = keyId(id);
    const net = str(o.netName);
    switch (r.type) {
      case 'CANVAS': out.push(['CANVAS', o.originX ?? 0, o.originY ?? 0, o.unit]); break;
      case 'LAYER': out.push(['LAYER', o.layerId ?? k[1], o.layerType, o.layerName, (o.use ? 1 : 0) | (o.show ? 2 : 0) | (o.locked ? 4 : 0)]); break;
      case 'LAYER_PHYS': out.push(['LAYER_PHYS', k[1], o.material, o.thickness, o.permittivity, o.lossTangent, o.isKeepIsland]); break;
      case 'NET': out.push(['NET', str(k[1]), o.netType, o.specialColor, o.retLine, o.differentialName, o.isPositiveNet, o.equalLengthGroupName]); break;
      case 'VIA': out.push(['VIA', id, o.groupId, net, str(o.ruleName), o.centerX, o.centerY, o.holeDiameter, o.viaDiameter, str(o.viaType) === 'NORMAL' || !o.viaType ? 0 : 1, o.topSolderExpansion, o.bottomSolderExpansion, o.locked]); break;
      case 'PAD': {
        const h = o.hole as O | null, p = (o.defaultPad ?? {}) as O;
        const hole = h && typeof h === 'object' ? [str(h.holeType) || 'ROUND', h.width, h.height] : null;
        const t = str(p.padType).toUpperCase();
        const shape = t === 'POLY' || t === 'POLYGON' ? ['POLY', p.path] : t === 'NGON' ? ['NGON', p.width, p.sides ?? p.height] : [t || 'RECT', p.width, p.height, p.radius ?? 0];
        const fn = str(o.padType).toUpperCase();
        out.push(['PAD', id, o.groupId, net, o.layerId, str(o.num), o.centerX, o.centerY, o.padAngle, hole, shape, o.specialPad ?? [], o.padOffsetX, o.padOffsetY, o.relativeAngle, o.plated ? 1 : 0,
          fn === 'TEST' || fn === 'TEST_POINT' ? 1 : fn === 'FIDUCIAL' ? 2 : 0, o.topSolderExpansion, o.bottomSolderExpansion, o.topPasteExpansion, o.bottomPasteExpansion, o.locked]);
        break;
      }
      case 'LINE': out.push(['LINE', id, o.groupId, net, o.layerId, o.startX, o.startY, o.endX, o.endY, o.width, o.locked]); break;
      case 'ARC': case 'CARC': out.push([r.type, id, o.groupId, net, o.layerId, o.startX, o.startY, o.endX, o.endY, o.angle, o.width, o.locked]); break;
      case 'POLY': out.push(['POLY', id, o.groupId, net, o.layerId, o.width, o.path, o.locked]); break;
      case 'FILL': out.push(['FILL', id, o.groupId, net, o.layerId, o.width, str(o.fillStyle).toUpperCase() === 'INNER_PLANE' ? 2 : 0, o.path, o.locked]); break;
      case 'REGION': {
        const pt = Array.isArray(o.prohibitType) ? (o.prohibitType as unknown[]).map((x) => (typeof x === 'number' ? x : PROHIBIT[str(x).toUpperCase()] ?? 0)).filter((x) => x > 0) : [];
        out.push(['REGION', id, o.groupId, o.layerId, o.width, pt, o.path, o.locked, str(o.name), str(o.regionType)]);
        break;
      }
      case 'POUR': {
        const t = (o.pourType ?? {}) as O;
        out.push(['POUR', id, o.groupId, net, o.layerId, o.width, str(o.name), o.order, o.path, [str(t.pourType) || 'SOLID', t.fineness ?? 0], o.keepIsland, o.locked]);
        break;
      }
      case 'POURED': {
        const pour = str(k[1] ?? o.targetId);
        for (const f of (Array.isArray(o.pourFill) ? o.pourFill : []) as O[]) out.push(['POURED', str(f.id), pour, f.strokeWidth, f.fill, f.path]);
        break;
      }
      case 'STRING': out.push(['STRING', id, o.groupId, o.layerId, o.x ?? o.positionX, o.y ?? o.positionY, o.text, o.fontFamily, o.fontSize, o.strokeWidth, o.bold, o.italic, originCode(o.origin), o.angle, o.reverse, o.expansion, o.mirror, o.locked]); break;
      case 'ATTR': out.push(['ATTR', id, o.groupId, str(o.parentId), o.layerId, o.x ?? o.positionX ?? null, o.y ?? o.positionY ?? null, o.key, o.value, o.keyVisible, o.valueVisible, o.fontFamily, o.fontSize, o.strokeWidth, o.bold, o.italic, originCode(o.origin), o.angle, o.reverse, o.expansion, o.mirror, o.locked]); break;
      case 'COMPONENT': out.push(['COMPONENT', id, o.groupId, o.layerId, o.x, o.y, o.angle, o.attrs ?? {}, o.locked]); break;
      case 'PAD_NET': out.push(['PAD_NET', str(k[1]), str(k[2]), str(o.padNet), str(k[3])]); break;
      case 'IMAGE': out.push(['IMAGE', id, o.groupId, o.layerId, o.startX, o.startY, o.width, o.height, o.angle, o.mirror, o.path, o.locked]); break;
      case 'TEARDROP': out.push(['TEARDROP', id, net, o.layerId, o.path, o.groupId]); break;
      case 'RULE': {
        const ctx = ((o.ruleContext ?? {}) as O);
        const cat = str(k[1]), name = str(k[2]);
        const state = str(o.ruleState).toUpperCase() === 'DEFAULT' ? 1 : 0;
        if (cat === 'SAFE') { const sp = (ctx.safeSpacing as O[] | undefined)?.[0]; if (sp) out.push(['RULE', '1', name, state, ['mil', sp.content]]); }
        else if (cat === 'TRACK') { const c = ((ctx.track as O | undefined)?.content as O[] | undefined)?.[0]; if (c) out.push(['RULE', '3', name, state, ['mil', c.stroMin, c.stroDef, c.stroMax]]); }
        break;
      }
      case 'DIMENSION': out.push(['DIMENSION', id, str(o.dimensionType), o.layerId, str(o.unit), o.lineWidth ?? o.width, o.precision, 1, o.coordinateSet ?? o.points ?? [], o.locked]); break;
      default:
    }
  }
  return out;
}

/* ── reading ── */

async function readZip(bytes: Uint8Array): Promise<Map<string, () => Promise<string>>> {
  const out = new Map<string, () => Promise<string>>();
  for (const e of unzipEntries(bytes)) {
    if (e.name.endsWith('/')) continue;
    let text: Promise<string> | null = null;
    out.set(e.name.replace(/\\/g, '/'), () => (text ??= e.data().then((b) => td.decode(b))));
  }
  return out;
}

/** v2 documents of a file: several in one (a board with its footprints) split at their DOCTYPE. */
function splitDocs(recs: Rec[]): Rec[][] {
  const out: Rec[][] = [];
  for (const r of recs) { if (r[0] === 'DOCTYPE' || !out.length) out.push([]); out[out.length - 1]!.push(r); }
  return out;
}
const headOf = (recs: Rec[]) => (recs.find((r) => r[0] === 'HEAD')?.[1] ?? {}) as Record<string, unknown>;
/** A lone footprint's or symbol's name: its Footprint / Symbol attribute. */
function ownName(recs: Rec[], fallback: string): string {
  const fp = recs.find((r) => r[0] === 'ATTR' && (r[7] === 'Footprint' || r[3] === 'Symbol'));
  return str(fp ? (fp[7] === 'Footprint' ? fp[8] : fp[4]) : '') || fallback;
}

/** An EasyEDA Pro file (project, library, footprint or symbol) as one shape. */
export async function readEasyedaPro(name: string, bytes: Uint8Array): Promise<ProProject> {
  const stem = baseName(name).replace(/\.[^.]+$/, '').replace(/^ProProject_/, '').replace(/_\d{4}-\d{2}-\d{2}$/, '');
  if (/\.(efoo|esym)$/i.test(name) || !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const text = td.decode(bytes).replace(/^﻿/, '');
    const p = emptyProject(stem, text.trimStart().startsWith('{') ? 3 : 2);
    const docs: { type: string; uuid: string; recs: Rec[]; title: string; symbolType?: number }[] = [];
    if (p.version === 3) {
      for (const d of v3Docs(text)) {
        const meta = metaOf(d);
        const recs = d.docType === 'SYMBOL' ? schRecs(d) : pcbRecs(d);
        docs.push({ type: d.docType, uuid: d.uuid, recs, title: str(meta.title ?? meta.name) || ownName(recs, stem), symbolType: Number(meta.docType ?? 2) });
      }
    } else {
      const recs = v2Recs(text);
      const type = str(recs.find((r) => r[0] === 'DOCTYPE')?.[1]) || (/\.esym$/i.test(name) ? 'SYMBOL' : 'FOOTPRINT');
      docs.push({ type, uuid: stem, recs, title: ownName(recs, stem), symbolType: Number(headOf(recs).symbolType ?? 2) });
    }
    for (const d of docs) {
      if (d.type === 'FOOTPRINT') p.footprints.set(d.uuid, { type: d.type, uuid: d.uuid, title: d.title, recs: d.recs });
      else if (d.type === 'SYMBOL') p.symbols.set(d.uuid, { type: d.type, uuid: d.uuid, title: d.title, recs: d.recs, symbolType: d.symbolType });
    }
    return p;
  }
  const files = await readZip(bytes);
  const names = [...files.keys()];
  const find = (re: RegExp) => names.find((n) => re.test(n));
  const log = find(/\.(epru|elibu)$/i);
  if (log && (find(/(^|\/)(project2|symbol2|footprint2|device2)\.json$/i) || /\.(epro2|elibz2)$/i.test(name))) return readV3(stem, files, names);
  return readV2(stem, files, names);
}

async function readV2(stem: string, files: Map<string, () => Promise<string>>, names: string[]): Promise<ProProject> {
  const indexName = ['project.json', 'device.json', 'footprint.json', 'symbol.json'].find((n) => files.has(n));
  let index: Record<string, unknown> = {};
  if (indexName) { try { index = JSON.parse(await files.get(indexName)!()); } catch { /* none */ } }
  const cfg = (index.config ?? {}) as Record<string, unknown>;
  const p = emptyProject(str(cfg.title) || stem, 2);
  const titleOf = (o: unknown, def: string) => { const v = (o ?? {}) as Record<string, unknown>; return str(v.display_title) || str(v.title) || def; };
  const symInfo = (index.symbols ?? {}) as Record<string, unknown>, fpInfo = (index.footprints ?? {}) as Record<string, unknown>;
  for (const [id, d] of Object.entries((index.devices ?? {}) as Record<string, { title?: string; attributes?: unknown }>)) p.devices.set(id, { title: titleOf(d, id), attributes: attrsOf(d.attributes) });
  for (const n of names) {
    const m = /^(SYMBOL|FOOTPRINT)\/([^/]+)\.(esym|efoo)$/i.exec(n);
    if (!m) continue;
    const recs = v2Recs(await files.get(n)!());
    const uuid = uuidOf(n);
    if (m[1]!.toUpperCase() === 'SYMBOL') {
      const info = (symInfo[uuid] ?? {}) as Record<string, unknown>;
      p.symbols.set(uuid, { type: 'SYMBOL', uuid, title: titleOf(info, ownName(recs, uuid)), recs, symbolType: Number(info.type ?? headOf(recs).symbolType ?? 2) });
    } else p.footprints.set(uuid, { type: 'FOOTPRINT', uuid, title: titleOf(fpInfo[uuid], ownName(recs, uuid)), recs });
  }
  for (const [id, s] of Object.entries((index.schematics ?? {}) as Record<string, { name?: string; sheets?: { id: number | string; name?: string }[] }>)) {
    const pages: ProDoc[] = [];
    for (const sh of s.sheets ?? []) {
      const f = files.get(`SHEET/${id}/${sh.id}.esch`);
      if (f) pages.push({ type: 'SCH', uuid: `${id}/${sh.id}`, title: str(sh.name) || `P${sh.id}`, recs: v2Recs(await f()) });
    }
    p.schematics.set(id, { name: str(s.name) || id, pages });
  }
  for (const [id, t] of Object.entries((index.pcbs ?? {}) as Record<string, unknown>)) {
    const f = files.get(`PCB/${id}.epcb`);
    if (!f) continue;
    const docs = splitDocs(v2Recs(await f()));
    p.pcbs.set(id, { type: 'PCB', uuid: id, title: typeof t === 'string' ? t : titleOf(t, id), recs: docs[0] ?? [] });
    // Footprints carried in the board's file
    for (const d of docs.slice(1)) {
      const h = headOf(d);
      if (str(d[0]?.[1]) === 'FOOTPRINT' && h.uuid && !p.footprints.has(str(h.uuid))) p.footprints.set(str(h.uuid), { type: 'FOOTPRINT', uuid: str(h.uuid), title: str(h.title) || str(h.uuid), recs: d });
    }
    // Its poured copper (the board's own cache: <base64(uuid_0)>.ecop)
    let b64 = '';
    try { b64 = btoa(`${id}_0`); } catch { /* not ASCII */ }
    const pour = files.get(`POUR/${b64}.ecop`);
    if (pour) p.poured.set(id, v2Recs(await pour()).filter((r) => r[0] === 'POURED'));
  }
  for (const [n, b] of Object.entries((index.boards ?? {}) as Record<string, { schematic?: string; pcb?: string }>)) p.boards.push({ name: n, schematic: b.schematic || undefined, pcb: b.pcb || undefined });
  for (const n of names) {
    if (!/^BLOB\//i.test(n)) continue;
    for (const r of v2Recs(await files.get(n)!())) if (r[0] === 'BLOB') p.blobs.set(str(r[1]), str(r[3]));
  }
  return p;
}

async function readV3(stem: string, files: Map<string, () => Promise<string>>, names: string[]): Promise<ProProject> {
  const projName = names.find((n) => /(^|\/)project2\.json$/i.test(n));
  let title = stem;
  if (projName) { try { title = str((JSON.parse(await files.get(projName)!()) as { title?: string }).title) || stem; } catch { /* stem */ } }
  const p = emptyProject(title, 3);
  const sch = new Map<string, { title: string; board: string; zIndex: number; seq: number }>();
  const pages: { schematic: string; doc: ProDoc; zIndex: number; seq: number }[] = [];
  const boards = new Map<string, string>();
  const pcbBoard = new Map<string, string>();
  for (const n of names.filter((x) => /\.(epru|elibu)$/i.test(x))) {
    for (const d of v3Docs(await files.get(n)!())) {
      const meta = metaOf(d);
      const t = str(meta.title ?? meta.name);
      switch (d.docType) {
        case 'BOARD': boards.set(d.uuid, t || d.uuid); break;
        case 'SCH': sch.set(d.uuid, { title: t || d.uuid, board: str(meta.board), zIndex: Number(meta.zIndex ?? 0), seq: d.seq }); break;
        case 'SCH_PAGE': pages.push({ schematic: str(meta.schematic), doc: { type: 'SCH', uuid: d.uuid, title: t || d.uuid, recs: schRecs(d) }, zIndex: Number(meta.zIndex ?? 0), seq: d.seq }); break;
        case 'PCB': p.pcbs.set(d.uuid, { type: 'PCB', uuid: d.uuid, title: t || d.uuid, recs: pcbRecs(d) }); pcbBoard.set(d.uuid, str(meta.board)); break;
        case 'FOOTPRINT': p.footprints.set(d.uuid, { type: 'FOOTPRINT', uuid: d.uuid, title: t || d.uuid, recs: pcbRecs(d) }); break;
        case 'SYMBOL': p.symbols.set(d.uuid, { type: 'SYMBOL', uuid: d.uuid, title: t || d.uuid, recs: schRecs(d), symbolType: Number(meta.docType ?? 2) }); break;
        case 'DEVICE': p.devices.set(d.uuid, { title: t || d.uuid, attributes: attrsOf(meta.attributes) }); break;
        case 'BLOB': for (const r of rowsOf(d)) if (r.type === 'BLOB') p.blobs.set(r.id, str((r.inner as O).content)); break;
        default:
      }
    }
  }
  for (const [id, s] of [...sch].sort((a, b) => a[1].seq - b[1].seq)) {
    const own = pages.filter((pg) => pg.schematic === id).sort((a, b) => a.zIndex - b.zIndex || a.seq - b.seq).map((pg) => pg.doc);
    p.schematics.set(id, { name: s.title, pages: own });
  }
  // Boards: the schematic and the PCB that name one; a lone schematic and a lone PCB are one too
  for (const [id, n] of boards) {
    const s = [...sch].find(([, v]) => v.board === id)?.[0];
    const b = [...pcbBoard].find(([, v]) => v === id)?.[0];
    if (s || b) p.boards.push({ name: n, schematic: s, pcb: b });
  }
  if (!p.boards.length && sch.size === 1 && p.pcbs.size === 1) p.boards.push({ name: title, schematic: [...sch.keys()][0], pcb: [...p.pcbs.keys()][0] });
  return p;
}

/** The project's symbols and footprints by AD name (their titles; a title two share numbered on): the schematic's library references and the board's footprints alike. */
export function proNames(p: ProProject): { symbols: Map<string, string>; footprints: Map<string, string> } {
  const name = (docs: Map<string, ProDoc>) => {
    const out = new Map<string, string>(), taken = new Set<string>();
    for (const [id, d] of docs) {
      const base = (d.title || id).replace(/[\\/:*?"<>|]/g, '_').trim() || id;
      let nm = base;
      for (let k = 2; taken.has(nm.toLowerCase()); k++) nm = `${base}_${k}`;
      taken.add(nm.toLowerCase());
      out.set(id, nm);
    }
    return out;
  };
  return { symbols: name(p.symbols), footprints: name(p.footprints) };
}
