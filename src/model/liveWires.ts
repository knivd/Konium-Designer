/**
 * Live Simulation on a sheet: where the running circuit shows. Each wire is cut where something
 * joins it (a pin's end, another wire's end, a junction, a power port) into runs; each run is of
 * a net, and carries the current that the pins on one side of it draw. Each pin is a run of its
 * own, from its end to the part's body, carrying the pin's current.
 *
 * The current in a wire's run follows from the pins: a net's wires are a tree (a loop of wire
 * has no current of its own to tell), and what flows through a run is the sum of what the pins
 * beyond it take. A power port or a net label joins the tree to the rest of its net elsewhere on
 * the sheet: what the tree's pins don't balance among themselves goes through it.
 */
import type { Vec2 } from '../core/geom';
import type { CompiledProject } from './compile';
import { DIR_VECTORS, isShown, type SchDocument } from './sch';

export interface LiveRun {
  a: Vec2; b: Vec2;
  /** The compiled net's name. */
  net: string;
  /** A pin's own run: "designator|pin" (a is its end, b at the body). */
  pin?: string;
}
export interface LiveGeometry {
  runs: LiveRun[];
  /** For each wire run: what to add up for its current from a to b, as [pin key, sign] (+1: the pin's current flows a → b). */
  sums: [string, number][][];
}

const key = (p: Vec2) => `${p.x},${p.y}`;
/** p strictly inside the segment a–b. */
function inside(p: Vec2, a: Vec2, b: Vec2): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (cross !== 0) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y), len = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot > 0 && dot < len;
}

/** The runs of the sheet `sheet` (its wires cut where things join them, and its parts' pins), with what each wire run's current is made of. */
export function liveGeometry(doc: SchDocument, compiled: CompiledProject, sheet = doc.name): LiveGeometry {
  const here = (s: string) => s.toLowerCase() === sheet.toLowerCase();
  const netOfObj = new Map<number, string>();
  for (const n of compiled.nets) for (const r of n.refs) if (here(r.sheet)) netOfObj.set(r.index, n.name);

  // Pins: each a run of its own; its end is where it joins a wire
  const runs: LiveRun[] = [];
  const pinsAt = new Map<string, string[]>();
  for (const n of compiled.nets) for (const p of n.pins) {
    if (!here(p.ref.sheet)) continue;
    const o = doc.objects[p.ref.index];
    if (!o || o.kind !== 'pin' || !isShown(doc, o)) continue;
    const d = DIR_VECTORS[o.orient]!, hot = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
    const k = `${p.designator}|${p.pin}`;
    runs.push({ a: hot, b: o.at, net: n.name, pin: k });
    const at = pinsAt.get(key(hot));
    if (at) at.push(k); else pinsAt.set(key(hot), [k]);
  }

  // Wires: cut at every point where something joins one
  const wires = doc.objects.filter((o) => o.kind === 'wire' && isShown(doc, o) && netOfObj.has(o.index));
  const joins = new Map<string, Vec2>();
  const join = (p: Vec2) => joins.set(key(p), p);
  for (const o of doc.objects) {
    if (!isShown(doc, o)) continue;
    if (o.kind === 'wire') for (const p of o.pts) join(p);
    else if (o.kind === 'junction' || o.kind === 'power' || o.kind === 'port' || (o.kind === 'text' && o.role === 'netlabel')) join(o.at);
  }
  for (const r of runs) join(r.a);
  /** Where a tree meets the rest of its net off the wires: power ports and net labels (anything named). */
  const outlets = new Set<string>();
  for (const o of doc.objects) if (isShown(doc, o) && (o.kind === 'power' || o.kind === 'port' || (o.kind === 'text' && o.role === 'netlabel'))) outlets.add(key(o.at));
  const pts = [...joins.values()];
  const edges: { a: Vec2; b: Vec2; net: string }[] = [];
  for (const w of wires) {
    if (w.kind !== 'wire') continue;
    const net = netOfObj.get(w.index)!;
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1]!, b = w.pts[i]!;
      if (a.x === b.x && a.y === b.y) continue;
      const cuts = pts.filter((p) => inside(p, a, b)).sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      let from = a;
      for (const c of [...cuts, b]) { edges.push({ a: from, b: c, net }); from = c; }
    }
  }

  // Each net's wires as trees: what flows in a run is what the pins beyond it take
  const at = new Map<string, number[]>();
  edges.forEach((e, i) => { for (const p of [e.a, e.b]) { const k = key(p), l = at.get(k); if (l) l.push(i); else at.set(k, [i]); } });
  const sums: [string, number][][] = edges.map(() => []);
  const seen = new Set<string>();
  for (const start of at.keys()) {
    if (seen.has(start)) continue;
    // The tree's points, breadth first; its root an outlet where it has one (what doesn't balance leaves there)
    const order: string[] = [], parentEdge = new Map<string, number>();
    const comp: string[] = [];
    const q = [start]; seen.add(start);
    while (q.length) { const k = q.shift()!; comp.push(k); for (const ei of at.get(k)!) { const e = edges[ei]!, o = key(e.a) === k ? key(e.b) : key(e.a); if (!seen.has(o)) { seen.add(o); q.push(o); } } }
    const root = comp.find((k) => outlets.has(k)) ?? comp[0]!;
    const done = new Set([root]);
    const bq = [root];
    while (bq.length) {
      const k = bq.shift()!; order.push(k);
      for (const ei of at.get(k)!) { const e = edges[ei]!, o = key(e.a) === k ? key(e.b) : key(e.a); if (!done.has(o)) { done.add(o); parentEdge.set(o, ei); bq.push(o); } }
    }
    // From the leaves in: a point's pins, and its children's, go through the run to its parent
    const below = new Map<string, [string, number][]>();
    for (let i = order.length - 1; i > 0; i--) {
      const k = order[i]!, ei = parentEdge.get(k)!, e = edges[ei]!;
      const mine: [string, number][] = [...(below.get(k) ?? []), ...(pinsAt.get(k) ?? []).map((p): [string, number] => [p, 1])];
      // The pins beyond k take their current through this run, towards k
      const towardsB = key(e.b) === k;
      sums[ei] = mine.map(([p, s]) => [p, towardsB ? s : -s]);
      const parent = towardsB ? key(e.a) : key(e.b);
      below.set(parent, [...(below.get(parent) ?? []), ...mine]);
    }
  }
  const base = runs.length;
  for (const e of edges) runs.push(e);
  return { runs, sums: [...Array.from({ length: base }, () => [] as [string, number][]), ...sums] };
}

/** Each run's current from a to b: a pin's own into the part; a wire run's the sum of the pins beyond it. */
export function runCurrents(geo: LiveGeometry, pinCurrent: (pin: string) => number): Float64Array {
  const out = new Float64Array(geo.runs.length);
  geo.runs.forEach((r, i) => {
    if (r.pin) out[i] = pinCurrent(r.pin);
    else { let s = 0; for (const [p, sign] of geo.sums[i]!) s += sign * pinCurrent(p); out[i] = s; }
  });
  return out;
}
