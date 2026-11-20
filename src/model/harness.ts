/**
 * A harness's wire list from AD's Harness Wiring Diagram (and its length from the Harness Layout
 * Drawing): each wire with its designator, the connector pins or splices at its ends, its colour,
 * the cable, shields and twists it is in, and — with a layout — its length: the shortest way
 * along the layout's bundles (their Length, in mils) between the connectors (or connection
 * points) its ends are on.
 */
import { HR, SR, bagOf, ownedBy, type SchDocument, type SchObject } from './sch';
import { cfbStream } from '../formats/cfb/cfb';
import { inflateRawSync } from '../formats/inflate';

export interface WireRow { wire: string; from: string; to: string; colour: number; cable: string; shield: boolean; twisted: boolean; length?: number }

const raw = (doc: SchDocument, o: SchObject) => bagOf(doc, o)?.int('RECORD', -1) ?? -1;
const uid = (doc: SchDocument, o: SchObject) => bagOf(doc, o)?.get('UNIQUEID') ?? '';
const list = (doc: SchDocument, o: SchObject, count: string, item: string): string[] => {
  const b = bagOf(doc, o);
  const n = b?.int(count) ?? 0;
  return Array.from({ length: n }, (_, i) => b?.get(`${item}${i + 1}`) ?? '').filter(Boolean);
};

/** Each object by its unique ID. */
function byUid(doc: SchDocument): Map<string, SchObject> {
  const m = new Map<string, SchObject>();
  for (const o of doc.objects) { const u = uid(doc, o); if (u) m.set(u, o); }
  return m;
}

/** What a wire end is on: a connector's pin (J1-3) or a splice (SPL1). */
function endName(doc: SchDocument, o: SchObject | undefined): { label: string; node?: SchObject } {
  if (!o) return { label: '(open)' };
  if (o.kind === 'pin') {
    const owner = doc.objects[o.owner];
    return { label: `${owner?.kind === 'component' && owner.designator ? owner.designator : '?'}-${o.designator}`, node: owner };
  }
  if (o.kind === 'splice') return { label: o.name || 'splice', node: o };
  if (o.kind === 'noerc') return { label: 'no connect' };
  return { label: '?' };
}

export function wireList(wiring: SchDocument, layout?: SchDocument | null): WireRow[] {
  const u = byUid(wiring);
  const owned = ownedBy(wiring);
  // The layout's wires by the diagram's wire they stand for, its cables' names likewise
  const lu = layout ? byUid(layout) : null;
  const lay = new Map<string, SchObject>(), cableName = new Map<string, string>();
  if (layout) {
    for (const o of layout.objects) {
      const r = raw(layout, o), origin = bagOf(layout, o)?.get('WIRINGDIAGRAMORIGINUNIQUEID');
      if (!origin) continue;
      if (r === HR.LAYOUT_WIRE) lay.set(origin, o);
      if (r === HR.LAYOUT_CABLE) cableName.set(origin, [bagOf(layout, o)?.get('DESIGNATOR'), bagOf(layout, o)?.get('COMMENT')].filter((x) => x && x !== '*').join(' '));
    }
  }
  const graph = layout ? bundleGraph(layout) : null;
  const atPoint = layout ? connectionPoints(layout) : new Map<string, string>();
  const twisted = new Set<string>();
  for (const o of wiring.objects) if (raw(wiring, o) === HR.TWIST) for (const w of list(wiring, o, 'CONNECTEDWIRESUNIQUEIDSCOUNT', 'CONNECTEDWIREUNIQUEID')) twisted.add(w);
  const rows: WireRow[] = [];
  for (const o of wiring.objects) {
    if (raw(wiring, o) !== HR.WIRE) continue;
    const b = bagOf(wiring, o)!;
    const name = (owned.get(o.index) ?? []).find((k) => k.kind === 'text' && k.role === 'designator');
    const a = endName(wiring, u.get(b.get('ENDVERTEX1CONNECTEDOBJECTUNIQUEID') ?? '')), z = endName(wiring, u.get(b.get('ENDVERTEX2CONNECTEDOBJECTUNIQUEID') ?? ''));
    const cables = list(wiring, o, 'CONNECTEDCABLESUNIQUEIDSCOUNT', 'CONNECTEDCABLEUNIQUEID');
    const row: WireRow = {
      wire: name?.kind === 'text' ? name.text : '', from: a.label, to: z.label, colour: b.int('COLOR'),
      cable: cables.map((c) => cableName.get(c) ?? c).join(', '), shield: list(wiring, o, 'CONNECTEDSHIELDSUNIQUEIDSCOUNT', 'CONNECTEDSHIELDUNIQUEID').length > 0,
      twisted: twisted.has(uid(wiring, o)),
    };
    // Its length along the layout's bundles, between the connectors its ends are on there
    const lw = lay.get(uid(wiring, o));
    if (layout && lu && lw && graph) {
      const lb = bagOf(layout, lw)!;
      // A wire end's place on the layout: the connection point its pin, connector or splice sits on
      const nodeOf = (id: string): string | null => {
        if (atPoint.has(id)) return atPoint.get(id)!;
        const e = lu.get(id);
        if (!e) return null;
        if (e.kind === 'pin') { const owner = layout.objects[e.owner]; const ou = owner ? uid(layout, owner) : ''; return atPoint.get(ou) ?? ou ?? null; }
        return uid(layout, e);
      };
      const n1 = nodeOf(lb.get('ENDVERTEX1CONNECTEDOBJECTUNIQUEID') ?? ''), n2 = nodeOf(lb.get('ENDVERTEX2CONNECTEDOBJECTUNIQUEID') ?? '');
      if (n1 && n2) { const d = shortest(graph, n1, n2); if (d !== null) row.length = d * 0.0254; }
    }
    rows.push(row);
  }
  return rows.sort((p, q) => p.wire.localeCompare(q.wire, 'en', { numeric: true }));
}

/**
 * The layout's connection points and what sits on each (connectors, splices, no-connects), from
 * its HarnessConnectionPointConnector stream: a zlib block of [version, count, then each point's
 * ID, how many objects, each object's ID with its pins' IDs] (IDs as a length byte and text).
 */
export function connectionPoints(layout: SchDocument): Map<string, string> {
  const out = new Map<string, string>();
  const s = layout.cfb ? cfbStream(layout.cfb.root, 'HarnessConnectionPointConnector') : null;
  if (!s) return out;
  let z = -1;
  for (let i = 0; i + 1 < s.length; i++) if (s[i] === 0x78 && (s[i + 1] === 0x9c || s[i + 1] === 0xda || s[i + 1] === 0x01)) { z = i; break; }
  if (z < 0) return out;
  try {
    const b = inflateRawSync(s.subarray(z + 2));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 4;
    const id = () => { const n = b[p]!; const t = new TextDecoder().decode(b.subarray(p + 1, p + 1 + n)); p += 1 + n; return t; };
    const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
    const count = u32();
    for (let k = 0; k < count && p < b.length; k++) {
      const cp = id();
      const n = u32();
      for (let j = 0; j < n; j++) { const obj = id(); out.set(obj, cp); const m = u32(); for (let q = 0; q < m; q++) out.set(id(), cp); }
    }
  } catch { /* unreadable: no lengths */ }
  return out;
}

/** The layout's bundles as a graph: their ends (a connector, a connection point) and their lengths (mils). */
function bundleGraph(layout: SchDocument): Map<string, [string, number][]> {
  const g = new Map<string, [string, number][]>();
  const link = (a: string, b: string, w: number) => { g.set(a, [...(g.get(a) ?? []), [b, w]]); g.set(b, [...(g.get(b) ?? []), [a, w]]); };
  const u = byUid(layout);
  const node = (id: string) => { const o = u.get(id); if (o?.kind === 'pin') { const owner = layout.objects[o.owner]; return owner ? uid(layout, owner) : id; } return id; };
  for (const o of layout.objects) {
    if (raw(layout, o) !== HR.BUNDLE) continue;
    const b = bagOf(layout, o)!;
    const a = b.get('ENDVERTEX1CONNECTEDOBJECTUNIQUEID'), z = b.get('ENDVERTEX2CONNECTEDOBJECTUNIQUEID');
    if (!a || !z) continue;
    link(node(a), node(z), b.int('LENGTH') + b.int('LENGTH_FRAC') / 100_000);
  }
  return g;
}
function shortest(g: Map<string, [string, number][]>, from: string, to: string): number | null {
  if (from === to) return 0;
  const dist = new Map<string, number>([[from, 0]]);
  const open = new Set([from]);
  while (open.size) {
    let cur = '', best = Infinity;
    for (const n of open) { const d = dist.get(n)!; if (d < best) { best = d; cur = n; } }
    open.delete(cur);
    if (cur === to) return best;
    for (const [n, w] of g.get(cur) ?? []) {
      const nd = best + w;
      if (nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); open.add(n); }
    }
  }
  return null;
}

/** The wire list as CSV (lengths in mm), as AD's wiring list report [est]. */
export function wireListCsv(rows: WireRow[]): string {
  const q = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const hex = (c: number) => `#${[c & 255, (c >> 8) & 255, (c >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return ['Wire,From,To,Colour,Cable,Shield,Twisted,Length (mm)', ...rows.map((r) => [r.wire, r.from, r.to, hex(r.colour), r.cable, r.shield ? 'Yes' : 'No', r.twisted ? 'Yes' : 'No', r.length === undefined ? '' : r.length.toFixed(1)].map(q).join(','))].join('\r\n') + '\r\n';
}

/** A harness document's kind by its sheet record (or its name). */
export function harnessKind(doc: SchDocument): 'wiring' | 'layout' | null {
  const sheet = doc.objects.find((o) => o.record === SR.SHEET);
  const r = sheet ? raw(doc, sheet) : -1;
  return r === HR.WIRING_SHEET || /\.wirdoc$/i.test(doc.name) ? 'wiring' : r === HR.LAYOUT_SHEET || /\.ldrdoc$/i.test(doc.name) ? 'layout' : null;
}
