/**
 * A board or footprint for a script (R8): the snapshot it reads, and its changes made on the
 * document afterwards in one undo step. Ids: a part 'c<index>', a primitive '<storage>:<index>'
 * (as the editor keys it); millimetres from the board's origin.
 */
import type { Vec2 } from '../core/geom';
import { UNITS_PER_MM } from '../core/units';
import type { Change } from '../core/undo';
import { NO_NET, inPour, type PcbDocument, type PcbPrim } from '../model/pcb';
import { L, layerName, mechLayer, type LayerId } from '../model/layers';
import { addPrimRecords, freshRecord, moveComponent, removePrims, replaceRecords } from '../model/pcbEdit';
import { itemChange } from '../model/pcbEco';
import { padShapeGroup } from '../model/padShapes';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, type PadFields } from '../formats/altium/pcbdoc';
import { placement, transformRecord } from '../formats/altium/pcbTransform';
import { ARC, FILL, PAD, REGION, TRACK, VIA, put, type Field } from '../formats/altium/pcbLayouts';
import type { PcbRawRecord } from '../formats/altium/framing';
import type { ScriptOp, SnapComponent, Snapshot, SnapPrim } from './runtime';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** An angle from 0 up to 360. */
const deg = (v: number) => { const d = r6(((v % 360) + 360) % 360); return d === 360 ? 0 : d; };
/** Millimetres to 10 nm: a 23.622 mil track reads 0.6, as it was drawn (the file's unit is 2.54 nm). */
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** The layers a script may name: the copper stack, then the others. */
export function scriptLayers(doc: PcbDocument): { id: LayerId; name: string }[] {
  const ids: LayerId[] = [...doc.board.copperStack, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER,
    L.DRILL_GUIDE, L.KEEPOUT, L.DRILL_DRAWING, L.MULTI];
  for (let n = 1; n <= 16; n++) ids.push(mechLayer(n));
  for (const p of doc.prims) if ('layer' in p && !ids.includes(p.layer)) ids.push(p.layer);
  return [...new Set(ids)].map((id) => ({ id, name: layerName(id) }));
}

const PRIM_LISTS = { pad: 'pads', track: 'tracks', arc: 'arcs', via: 'vias', text: 'texts', region: 'regions', fill: 'fills' } as const;
const idOf = (p: PcbPrim) => `${p.src.storage}:${p.src.index}`;
/** What a script sees of the board: pour copper, 3D bodies, a polygon pad's shape and hidden part texts left out. */
function shown(p: PcbPrim): boolean {
  if (p.kind === 'body' || inPour(p)) return false;
  if (p.kind === 'region') return p.regionKind === 0 && !p.boardCutout && !p.shapeOf;
  if (p.kind === 'text') return !p.hidden;
  return true;
}

/** The board (or footprint) as a script gets it; `selection` is the editor's selected keys. */
export function snapshot(doc: PcbDocument, kind: 'board' | 'footprint', selection: ReadonlySet<string>): Snapshot {
  const o = doc.board.origin;
  const mm = (v: number) => r5(v / UNITS_PER_MM);
  const xy = (v: Vec2) => ({ x: mm(v.x - o.x), y: mm(v.y - o.y) });
  const net = (n: number) => (n === NO_NET ? null : doc.nets[n]?.name ?? null);
  const part = (c: number) => (c === NO_NET ? null : doc.components[c]?.designator ?? null);
  const layer = (l: LayerId) => layerName(l);
  const out: Snapshot = {
    kind, name: doc.name.replace(/\.(PcbDoc|PcbLib)$/i, ''), outline: doc.board.outline.map(xy), layers: scriptLayers(doc).map((l) => l.name),
    nets: doc.nets.map((n) => n.name), components: [], pads: [], tracks: [], arcs: [], vias: [], texts: [], regions: [], fills: [], selection: [],
  };
  const comment = new Map<number, string>();
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && p.component !== NO_NET) comment.set(p.component, p.text);
  const whole = new Set<number>();
  doc.components.forEach((c, i) => {
    const sc: SnapComponent = { id: `c${i}`, designator: c.designator, comment: comment.get(i) ?? c.bag.get('COMMENT') ?? '', footprint: c.pattern, ...xy(c.at), rotation: deg(c.rotation),
      side: c.layer === L.BOTTOM ? 'bottom' : 'top', locked: c.bag.bool('LOCKED') };
    out.components.push(sc);
    const keys = doc.prims.filter((q) => 'component' in q && q.component === i).map(primKeyOf);
    if (keys.length && keys.every((k) => selection.has(k))) { whole.add(i); out.selection.push(sc.id); }
  });
  for (const p of doc.prims) {
    if (!shown(p)) continue;
    const id = idOf(p);
    const c = 'component' in p ? p.component : NO_NET;
    let s: SnapPrim;
    switch (p.kind) {
      case 'pad': s = { id, kind: 'pad', name: p.name, component: part(c), net: net(p.net), ...xy(p.at), layer: layer(p.layer), width: mm(p.top.w), height: mm(p.top.h), shape: p.top.shape, hole: mm(p.hole), plated: p.plated, rotation: deg(p.rotation) }; break;
      case 'track': { const a = xy(p.a), b = xy(p.b); s = { id, kind: 'track', x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: mm(p.width), layer: layer(p.layer), net: net(p.net), component: part(c), keepout: p.keepout }; break; }
      case 'arc': s = { id, kind: 'arc', ...xy(p.c), radius: mm(p.r), start: r6(p.start), end: r6(p.end), width: mm(p.width), layer: layer(p.layer), net: net(p.net), component: part(c), keepout: p.keepout }; break;
      case 'via': s = { id, kind: 'via', ...xy(p.at), diameter: mm(p.diameter), hole: mm(p.hole), net: net(p.net) }; break;
      case 'text': s = { id, kind: 'text', ...xy(p.at), text: p.text, height: mm(p.height), layer: layer(p.layer), rotation: deg(p.rotation), component: part(c) }; break;
      case 'region': s = { id, kind: 'region', points: p.outline.map(xy), layer: layer(p.layer), net: net(p.net), component: part(c), keepout: p.keepout }; break;
      case 'fill': { const a = xy(p.a), b = xy(p.b); s = { id, kind: 'fill', x1: a.x, y1: a.y, x2: b.x, y2: b.y, rotation: deg(p.rotation), layer: layer(p.layer), net: net(p.net), component: part(c), keepout: p.keepout }; break; }
      default: continue;
    }
    out[PRIM_LISTS[p.kind]].push(s);
    if (selection.has(primKeyOf(p)) && !(c !== NO_NET && whole.has(c))) out.selection.push(id);
  }
  return out;
}

/** The editor's key of a primitive (PcbEditor's primKey). */
const primKeyOf = (p: PcbPrim) => ('polygon' in p && p.polygon !== NO_NET ? `poly:${p.polygon}` : idOf(p));

const NET_FIELD: Record<string, { sub: number; f: Field }> = {
  Tracks6: { sub: 0, f: TRACK.net }, Arcs6: { sub: 0, f: ARC.net }, Vias6: { sub: 0, f: VIA.net }, Fills6: { sub: 0, f: FILL.net }, Regions6: { sub: 0, f: REGION.net }, Pads6: { sub: 4, f: PAD.net },
};
const WIDTH_FIELD: Record<string, Field> = { Tracks6: TRACK.width, Arcs6: ARC.width };

export interface ScriptResult {
  /** The editor keys to select afterwards (null: the selection as it was). */
  select: string[] | null;
  /** What changed, for the console and the status message. */
  summary: string;
  changed: number;
}

/**
 * Make a script's changes on the document, inside the caller's undo transaction: parts moved and
 * turned, designators, primitives' nets, moves and widths, new primitives, then removals (so the
 * others' places in their storages hold until the end).
 */
export function applyScript(doc: PcbDocument, ops: readonly ScriptOp[], tx: { add(c: Change): void }): ScriptResult {
  const o = doc.board.origin;
  const U = (v: number) => { if (!Number.isFinite(v)) throw new Error(`Not a number: ${String(v)}`); return Math.round(v * UNITS_PER_MM); };
  const at = (x: number, y: number): Vec2 => ({ x: o.x + U(x), y: o.y + U(y) });
  const layers = new Map(scriptLayers(doc).map((l) => [l.name.toLowerCase(), l.id]));
  const layerOf = (n: unknown): LayerId => { const l = layers.get(String(n).toLowerCase()); if (l === undefined) throw new Error(`No layer "${String(n)}"`); return l; };
  const netOf = (n: unknown): number => { if (n === null || n === undefined) return NO_NET; const i = doc.nets.findIndex((x) => x.name === n); if (i < 0) throw new Error(`No net "${String(n)}"`); return i; };
  const prim = (id: string): PcbPrim => {
    const p = doc.prims.find((q) => q.src.storage + ':' + q.src.index === id && shown(q));
    if (!p) throw new Error(`No object ${id} on the board (it changed while the script ran?)`);
    return p;
  };
  const compIndex = (id: string): number => { const i = Number(id.slice(1)); if (!/^c\d+$/.test(id) || !doc.components[i]) throw new Error(`No part ${id}`); return i; };

  // Gather: each part's last place, turn and designator; each primitive's edits in order; the new ones as their fields last were
  const parts = new Map<number, { x?: number; y?: number; rotation?: number; designator?: string }>();
  const edits = new Map<string, ScriptOp[]>();
  const added = new Map<string, { kind: string; fields: Record<string, unknown> }>();
  const gone = new Set<string>();
  let select: string[] | null = null;
  for (const op of ops) {
    switch (op.op) {
      case 'compMove': { const p = parts.get(compIndex(op.id)) ?? {}; p.x = op.x; p.y = op.y; parts.set(compIndex(op.id), p); break; }
      case 'compRotate': { const p = parts.get(compIndex(op.id)) ?? {}; p.rotation = op.rotation; parts.set(compIndex(op.id), p); break; }
      case 'designator': { const p = parts.get(compIndex(op.id)) ?? {}; p.designator = op.value; parts.set(compIndex(op.id), p); break; }
      case 'add': added.set(op.id, { kind: op.kind, fields: { ...op.fields } }); break;
      case 'select': select = op.ids.slice(); break;
      default: {
        const a = added.get(op.id);
        if (a) {
          const f = a.fields;
          if (op.op === 'remove') added.delete(op.id);
          else if (op.op === 'net') f.net = op.net;
          else if (op.op === 'width') f.width = op.width;
          else if (op.op === 'move') {
            for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) if (typeof f[k] === 'number') f[k] = (f[k] as number) + (k[0] === 'x' ? op.dx : op.dy);
            if (Array.isArray(f.points)) f.points = (f.points as Vec2[]).map((q) => ({ x: q.x + op.dx, y: q.y + op.dy }));
          }
        } else if (op.op === 'remove') gone.add(op.id);
        else { const l = edits.get(op.id) ?? []; l.push(op); edits.set(op.id, l); }
      }
    }
  }
  let changed = 0;
  const said: string[] = [];
  const count = (n: number, one: string, many = `${one}s`) => { if (n) said.push(`${n} ${n === 1 ? one : many}`); changed += n; };
  /** Where every record we will want selected ends up: by the record itself (indices shift when others go). */
  const recOf = new Map<string, { storage: string; rec: PcbRawRecord }>();
  const recordOf = (p: PcbPrim) => ({ storage: p.src.storage, rec: doc.streams.get(p.src.storage)!.records[p.src.index]! });

  // Parts: one move (with its turn) each, then the designators
  let moved = 0, renamed = 0;
  for (const [i, p] of parts) {
    const c = doc.components[i]!;
    const target = p.x === undefined ? c.at : at(p.x, p.y!);
    const d = { x: target.x - c.at.x, y: target.y - c.at.y };
    const rot = p.rotation === undefined ? 0 : (((p.rotation - c.rotation) % 360) + 540) % 360 - 180;
    if (d.x || d.y || Math.abs(rot) > 1e-9) { tx.add(moveComponent(doc, i, d, rot)); moved++; }
  }
  for (const [i, p] of parts) {
    const c = doc.components[i]!;
    if (p.designator === undefined || p.designator === c.designator) continue;
    tx.add(itemChange(doc, { kind: 'changeDesignator', group: 'Change Component Designators', action: 'Modify', object: `${c.designator} -> ${p.designator}`, index: i, from: c.designator, to: p.designator }, () => undefined));
    renamed++;
  }
  count(moved, 'part moved or turned', 'parts moved or turned'); count(renamed, 'designator changed', 'designators changed');

  // Primitives' nets, moves and widths: each record changed once, with its polygon pad's shape when it moves
  const replace: { storage: string; index: number; after: PcbRawRecord }[] = [];
  const shapeMoves = new Map<string, Vec2>();
  for (const [id, list] of edits) {
    const p = prim(id);
    let rec = recordOf(p).rec;
    for (const e of list) {
      if (e.op === 'net') {
        const nf = NET_FIELD[p.src.storage];
        if (!nf) throw new Error(`A ${p.kind} has no net`);
        const subs = rec.subs.slice(); subs[nf.sub] = subs[nf.sub]!.slice(); put(subs[nf.sub]!, nf.f, netOf(e.net)); rec = { ...rec, subs };
      } else if (e.op === 'width') {
        const wf = WIDTH_FIELD[p.src.storage];
        if (!wf) throw new Error(`A ${p.kind} has no width`);
        const subs = rec.subs.slice(); subs[0] = subs[0]!.slice(); put(subs[0]!, wf, Math.max(0, U(e.width))); rec = { ...rec, subs };
      } else if (e.op === 'move') {
        const d = { x: U(e.dx), y: U(e.dy) };
        rec = transformRecord(rec, placement({ x: 0, y: 0 }, 0, d), 0, { storage: p.src.storage });
        if (p.kind === 'pad' && p.shapeKeys?.length) {
          for (const k of p.shapeKeys) { const m = shapeMoves.get(k) ?? { x: 0, y: 0 }; shapeMoves.set(k, { x: m.x + d.x, y: m.y + d.y }); }
        }
      }
    }
    replace.push({ storage: p.src.storage, index: p.src.index, after: rec });
    recOf.set(id, { storage: p.src.storage, rec });
  }
  for (const [k, d] of shapeMoves) {
    const [storage, n] = k.split(':') as [string, string];
    const before = doc.streams.get(storage)?.records[Number(n)];
    if (before) replace.push({ storage, index: Number(n), after: transformRecord(before, placement({ x: 0, y: 0 }, 0, d), 0, { storage }) });
  }
  if (replace.length) tx.add(replaceRecords(doc, replace));
  count(edits.size, 'object changed', 'objects changed');

  // New primitives
  const fresh: { id: string; storage: string; rec: PcbRawRecord }[] = [];
  for (const [id, a] of added) {
    const f = a.fields as Record<string, number> & { layer: string; net: string | null; text: string; points: Vec2[] };
    let storage: string, rec: PcbRawRecord;
    switch (a.kind) {
      case 'track': storage = 'Tracks6'; rec = freshRecord(doc, storage, (t) => encodeTrack({ layer: layerOf(f.layer), a: at(f.x1, f.y1), b: at(f.x2, f.y2), width: U(f.width), net: netOf(f.net) }, t)); break;
      case 'arc': storage = 'Arcs6'; rec = freshRecord(doc, storage, (t) => encodeArc({ layer: layerOf(f.layer), c: at(f.x, f.y), r: U(f.radius), start: f.start, end: f.end, width: U(f.width), net: netOf(f.net) }, t)); break;
      case 'via': storage = 'Vias6'; rec = freshRecord(doc, storage, (t) => encodeVia({ at: at(f.x, f.y), diameter: U(f.diameter), hole: U(f.hole), net: netOf(f.net), layerStart: L.TOP, layerEnd: L.BOTTOM }, t)); break;
      case 'text': storage = 'Texts6'; rec = freshRecord(doc, storage, (t) => encodeText({ layer: layerOf(f.layer), at: at(f.x, f.y), height: U(f.height), text: String(f.text), rotation: f.rotation, strokeWidth: Math.max(1, U(f.height / 10)) }, t)); break;
      case 'pad': storage = 'Pads6'; rec = encodePad({ name: String(f.name), layer: layerOf(f.layer), at: at(f.x, f.y), w: U(f.width), h: U(f.height), shape: f.shape as unknown as PadFields['shape'], hole: U(f.hole), rotation: f.rotation, net: netOf(f.net), cornerPct: 50 }); break;
      case 'region': storage = 'Regions6'; rec = encodeRegion({ layer: layerOf(f.layer), outline: f.points.map((q) => at(q.x, q.y)), net: netOf(f.net) }); break;
      default: throw new Error(`Can’t add a ${a.kind}`);
    }
    fresh.push({ id, storage, rec });
    recOf.set(id, { storage, rec });
  }
  if (fresh.length) tx.add(addPrimRecords(doc, fresh.map(({ storage, rec }) => ({ storage, rec }))));
  count(fresh.length, 'object added', 'objects added');

  // The records to select, found before removals move the others along
  const pick = new Map<string, { storage: string; rec: PcbRawRecord }>();
  for (const id of select ?? []) {
    if (/^c\d+$/.test(id) || gone.has(id)) continue;
    const [st, n] = id.split(':') as [string, string];
    const rec = doc.streams.get(st)?.records[Number(n)];
    const r = recOf.get(id) ?? (rec ? { storage: st, rec } : undefined);
    if (r) pick.set(id, r);
  }

  // Removals last, with a polygon pad's shape
  if (gone.size) {
    const list: PcbPrim[] = [];
    for (const id of gone) { const p = prim(id); list.push(p); if (p.kind === 'pad' && p.shapeKeys?.length) list.push(...doc.prims.filter((q) => p.shapeKeys!.includes(idOf(q)))); }
    tx.add(removePrims(doc, list));
  }
  count(gone.size, 'object removed', 'objects removed');

  // The selection asked for, as editor keys
  let keys: string[] | null = null;
  if (select) {
    const want = new Set<string>();
    for (const id of select) {
      if (/^c\d+$/.test(id)) { const i = Number(id.slice(1)); for (const p of doc.prims) if ('component' in p && p.component === i) want.add(primKeyOf(p)); continue; }
      const r = pick.get(id);
      if (!r) continue;
      const i = doc.streams.get(r.storage)?.records.indexOf(r.rec) ?? -1;
      const p = i < 0 ? undefined : doc.prims.find((q) => q.src.storage === r.storage && q.src.index === i);
      if (p) for (const k of padShapeGroup(doc.prims, p)) want.add(k);
    }
    keys = [...want];
  }
  return { select: keys, summary: said.length ? said.join(', ') : 'nothing changed', changed };
}
