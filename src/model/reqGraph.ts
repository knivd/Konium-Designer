/**
 * A requirements document's connection graph: its requirements as a tree read left to right (each
 * under its parent, the sections as bands), and on the right what in the design each is met by
 * (parts, nets, documents, the board), joined to the requirements linked to it. Laid out in
 * columns: a requirement's column is its depth, its place the middle of its children's (a leaf
 * takes the next place down); a design item sits level with the requirements linked to it, as near
 * as the items above it let.
 */
import { LINK_KINDS, isReq, treeRows, type LinkKind, type ReqLink, type ReqRow, type Requirement } from './requirements';

export interface GraphReqNode { kind: 'req'; row: number; req: Requirement; x: number; y: number; w: number; h: number; depth: number }
export interface GraphLinkNode { kind: 'link'; link: ReqLink; key: string; x: number; y: number; w: number; h: number }
export interface GraphSection { row: number; title: string; y: number }
export interface GraphEdge { from: string; to: string; kind: 'parent' | LinkKind }
export interface ReqGraph { reqs: GraphReqNode[]; links: GraphLinkNode[]; sections: GraphSection[]; edges: GraphEdge[]; width: number; height: number }

export const NODE_W = 190, NODE_H = 40, LINK_W = 160, LINK_H = 26, COL_GAP = 70, ROW_GAP = 12, SECTION_H = 30, MARGIN = 16;
export const linkKey = (l: ReqLink): string => `${l.kind}:${l.kind === 'sheet' || l.kind === 'board' ? l.ref.toLowerCase() : l.ref}`;

/** The graph of a document's rows (requirements keyed by their identifiers, design items by kind and name). */
export function reqGraph(rows: ReqRow[]): ReqGraph {
  const tr = treeRows(rows);
  const reqs: GraphReqNode[] = [], sections: GraphSection[] = [], edges: GraphEdge[] = [];
  const pitch = NODE_H + ROW_GAP;
  let y = MARGIN, maxDepth = 0;
  // Each top-level item and what is under it: its leaves down the page, a parent level with the middle of its children
  const kidsOf = new Map<number, number[]>();
  const stack: number[] = [];
  tr.forEach((t, k) => {
    stack.length = t.depth;
    if (t.depth > 0 && stack.length) { const p = stack[t.depth - 1]!; const l = kidsOf.get(p); if (l) l.push(k); else kidsOf.set(p, [k]); }
    stack.push(k);
  });
  const yOf = new Map<number, number>();
  const place = (k: number): number => {
    const kids = kidsOf.get(k) ?? [];
    if (!kids.length) { const at = y; y += pitch; yOf.set(k, at); return at; }
    const ys = kids.map(place);
    const at = (ys[0]! + ys[ys.length - 1]!) / 2;
    yOf.set(k, at);
    return at;
  };
  tr.forEach((t, k) => {
    if (t.depth > 0) return;
    const r = rows[t.i]!;
    if (!isReq(r)) { if (sections.length || reqs.length) y += ROW_GAP; sections.push({ row: t.i, title: r.title, y }); y += SECTION_H; return; }
    place(k);
  });
  tr.forEach((t, k) => {
    const r = rows[t.i]!;
    if (!isReq(r)) return;
    maxDepth = Math.max(maxDepth, t.depth);
    reqs.push({ kind: 'req', row: t.i, req: r, depth: t.depth, x: MARGIN + t.depth * (NODE_W + COL_GAP), y: yOf.get(k)!, w: NODE_W, h: NODE_H });
  });
  const here = new Set(reqs.map((n) => n.req.id));
  for (const n of reqs) if (n.req.parent && here.has(n.req.parent)) edges.push({ from: `req:${n.req.parent}`, to: `req:${n.req.id}`, kind: 'parent' });

  // Design items: level with the requirements linked to them, in order down the page, none overlapping
  const byKey = new Map<string, { link: ReqLink; ys: number[] }>();
  for (const n of reqs) for (const l of n.req.links) {
    const k = linkKey(l);
    const e = byKey.get(k) ?? { link: l, ys: [] };
    e.ys.push(n.y + NODE_H / 2);
    byKey.set(k, e);
    edges.push({ from: `req:${n.req.id}`, to: `link:${k}`, kind: l.kind });
  }
  const order = (k: LinkKind) => LINK_KINDS.findIndex(([x]) => x === k);
  const want = [...byKey].map(([key, e]) => ({ key, link: e.link, at: e.ys.reduce((a, b) => a + b, 0) / e.ys.length - LINK_H / 2 }))
    .sort((a, b) => a.at - b.at || order(a.link.kind) - order(b.link.kind) || a.link.ref.localeCompare(b.link.ref, undefined, { numeric: true }));
  const lx = MARGIN + (maxDepth + 1) * (NODE_W + COL_GAP) + COL_GAP;
  const links: GraphLinkNode[] = [];
  let next = MARGIN;
  for (const w of want) {
    const at = Math.max(w.at, next);
    links.push({ kind: 'link', link: w.link, key: w.key, x: lx, y: at, w: LINK_W, h: LINK_H });
    next = at + LINK_H + 6;
  }
  const bottom = Math.max(y, next, ...reqs.map((n) => n.y + NODE_H + ROW_GAP), MARGIN + pitch);
  const width = (links.length ? lx + LINK_W : MARGIN + (maxDepth + 1) * (NODE_W + COL_GAP) - COL_GAP) + MARGIN;
  return { reqs, links, sections, edges, width, height: bottom + MARGIN };
}

/** What is joined to a requirement: the ones above and under it, and the design items it and those under it are linked to (keys as the edges have them). */
export function related(g: ReqGraph, id: string): Set<string> {
  const self = `req:${id}`;
  const up = new Map<string, string>(), down = new Map<string, string[]>();
  for (const e of g.edges) if (e.kind === 'parent') { up.set(e.to, e.from); down.set(e.from, [...(down.get(e.from) ?? []), e.to]); }
  const below = new Set<string>([self]);
  const walk = (k: string) => { for (const c of down.get(k) ?? []) if (!below.has(c)) { below.add(c); walk(c); } };
  walk(self);
  const out = new Set(below);
  for (let at = up.get(self), guard = 0; at && guard < 1000; at = up.get(at), guard++) out.add(at);
  for (const e of g.edges) if (e.kind !== 'parent' && below.has(e.from)) out.add(e.to);
  return out;
}
