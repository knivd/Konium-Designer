/**
 * Signal Integrity's analyses: a net's rising and falling edges simulated (the driver stepping
 * between its levels behind its output resistance) and measured at each receiver as AD measures
 * them — overshoot and undershoot (ringback) of each edge, the top and base values it settles at,
 * the flight time (the receiver reaching its threshold, after the driver's own edge would) and the
 * slope (threshold to threshold) — the worst receiver's for the net; terminations tried (series
 * resistor at the driver; parallel resistors to the supply, to ground or both, capacitor, RC,
 * Schottky clamps at the receivers) with values worked out from the line.
 */
import { addNode, transient, type Circuit } from './circuit';
import type { Stimulus } from './rules';
import type { SiNetwork } from './topology';

export interface EdgeMeasures { overshoot: number; undershoot: number; level: number; flight: number; slope: number }
export type Edge = 'rising' | 'falling';
export type TermKind = 'none' | 'series' | 'pullup' | 'pulldown' | 'thevenin' | 'cap' | 'rc' | 'schottky';
export const TERMINATIONS: { kind: TermKind; label: string }[] = [
  { kind: 'none', label: 'No Termination' }, { kind: 'series', label: 'Serial Res' }, { kind: 'pullup', label: 'Parallel Res to VCC' },
  { kind: 'pulldown', label: 'Parallel Res to GND' }, { kind: 'thevenin', label: 'Parallel Res to VCC & GND' }, { kind: 'cap', label: 'Parallel Cap to GND' },
  { kind: 'rc', label: 'Res and Cap to GND' }, { kind: 'schottky', label: 'Parallel Schottky Diode' },
];

/** The line's impedance a termination matches (the middle of the net's range). */
const zOf = (n: SiNetwork) => (n.zMin + n.zMax) / 2;
/** The longest delay through the net's lines (an upper bound: all of them in a row). */
const delayOf = (c: Circuit) => c.tls.reduce((s, t) => s + t.td, 0);

/** A termination's values for this net (Ω, F), as the advisor suggests them. */
export function termValues(n: SiNetwork, kind: TermKind): { r?: number; r2?: number; c?: number } {
  const z = zOf(n), d = n.driver.model, td = delayOf(n.circuit);
  switch (kind) {
    case 'series': return { r: Math.max(0, Math.round(z - (d.rup + d.rdown) / 2)) };
    case 'pullup': case 'pulldown': return { r: Math.round(z) };
    case 'thevenin': return { r: Math.round(2 * z), r2: Math.round(2 * z) };
    case 'cap': return { c: Math.max(1e-12, d.tr / z) };
    case 'rc': return { r: Math.round(z), c: Math.max(10e-12, (6 * td) / z) };
    default: return {};
  }
}

export type TermValues = { r?: number; r2?: number; c?: number };

/** A copy of the circuit with a termination added (its values as given, else as suggested). */
function terminated(n: SiNetwork, kind: TermKind, given?: TermValues): { c: Circuit; extraR: number } {
  const c: Circuit = { names: [...n.circuit.names], res: [...n.circuit.res], caps: [...n.circuit.caps], srcs: [...n.circuit.srcs], tls: [...n.circuit.tls], nl: [...n.circuit.nl] };
  const v = { ...termValues(n, kind), ...Object.fromEntries(Object.entries(given ?? {}).filter(([, x]) => x !== undefined && Number.isFinite(x) && x > 0)) } as TermValues;
  let extraR = 0;
  for (const r of n.receivers) {
    const vcc = r.model.vcc;
    if (kind === 'pullup') c.srcs.push({ a: r.node, r: v.r!, v: () => vcc });
    else if (kind === 'pulldown') c.res.push({ a: r.node, b: 0, r: v.r! });
    else if (kind === 'thevenin') { c.srcs.push({ a: r.node, r: v.r!, v: () => vcc }); c.res.push({ a: r.node, b: 0, r: v.r2! }); }
    else if (kind === 'cap') c.caps.push({ a: r.node, b: 0, c: v.c! });
    else if (kind === 'rc') { const m = addNode(c, `${r.designator}-${r.pin}:rc`); c.res.push({ a: r.node, b: m, r: v.r! }); c.caps.push({ a: m, b: 0, c: v.c! }); }
    else if (kind === 'schottky') {
      c.nl.push({ a: r.node, ref: 0, table: [[-3, -3 / 2], [-0.3, -0.0005], [0, 0], [50, 0]] });
      c.nl.push({ a: r.node, ref: vcc, table: [[-50, 0], [0, 0], [0.3, 0.0005], [3, 3 / 2]] });
    }
  }
  if (kind === 'series') extraR = v.r ?? 0;
  return { c, extraR };
}

/**
 * Lines shorter than a step become a short and their capacitance; chains of lines through a node
 * with nothing else on it (and much the same impedance) become one line. The probed nodes' new numbers.
 */
function simplify(c: Circuit, dt: number, probe: number[]): { c: Circuit; probe: number[] } {
  const n = c.names.length;
  const up = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  const merge = (a: number, b: number) => { const x = find(a), y = find(b); if (x === y) return; if (y === 0) up[x] = 0; else up[y] = x; };
  const extraC: { a: number; c: number }[] = [];
  let tls = c.tls.filter((t) => { if (t.td >= dt) return true; merge(t.a, t.b); extraC.push({ a: t.a, c: t.td / t.z }); return false; });
  // Chains: a node only two lines touch, no load
  const loads = new Set<number>([...probe, ...c.res.flatMap((r) => [r.a, r.b]), ...c.caps.flatMap((k) => [k.a, k.b]), ...c.srcs.map((s) => s.a), ...c.nl.map((d) => d.a)].map(find));
  for (let pass = 0; pass < 4; pass++) {
    const by = new Map<number, number[]>();
    tls.forEach((t, i) => { for (const e of [find(t.a), find(t.b)]) by.set(e, [...(by.get(e) ?? []), i]); });
    const gone = new Set<number>();
    const add: typeof tls = [];
    for (const [node, list] of by) {
      if (loads.has(node) || list.length !== 2 || list.some((i) => gone.has(i))) continue;
      const [t1, t2] = [tls[list[0]!]!, tls[list[1]!]!];
      if (Math.abs(t1.z - t2.z) / Math.max(t1.z, t2.z) > 0.15) continue;
      const o1 = find(t1.a) === node ? find(t1.b) : find(t1.a), o2 = find(t2.a) === node ? find(t2.b) : find(t2.a);
      if (o1 === o2) continue;
      gone.add(list[0]!); gone.add(list[1]!);
      add.push({ a: o1, b: o2, z: (t1.z * t1.td + t2.z * t2.td) / (t1.td + t2.td), td: t1.td + t2.td });
    }
    if (!gone.size) break;
    tls = [...tls.filter((_, i) => !gone.has(i)), ...add];
  }
  // Numbered again: the nodes left
  const used = new Set<number>([...tls.flatMap((t) => [t.a, t.b]), ...c.res.flatMap((r) => [r.a, r.b]), ...c.caps.flatMap((k) => [k.a, k.b]), ...extraC.map((x) => x.a), ...c.srcs.map((s) => s.a), ...c.nl.map((d) => d.a), ...probe].map(find));
  used.delete(0);
  const num = new Map<number, number>([[0, 0]]);
  const names = [''];
  for (const u of [...used].sort((a, b) => a - b)) { num.set(u, names.length); names.push(c.names[u] ?? `n${u}`); }
  const m = (i: number) => num.get(find(i)) ?? 0;
  return {
    c: {
      names,
      res: c.res.map((r) => ({ ...r, a: m(r.a), b: m(r.b) })).filter((r) => r.a !== r.b),
      caps: [...c.caps.map((k) => ({ ...k, a: m(k.a), b: m(k.b) })), ...extraC.map((x) => ({ a: m(x.a), b: 0, c: x.c }))].filter((k) => k.a !== k.b),
      srcs: c.srcs.map((s) => ({ ...s, a: m(s.a) })),
      tls: tls.map((t) => ({ ...t, a: m(t.a), b: m(t.b) })).filter((t) => t.a !== t.b),
      nl: c.nl.map((d) => ({ ...d, a: m(d.a) })),
    },
    probe: probe.map(m),
  };
}

export interface EdgeRun { edge: Edge; t: Float64Array; driver: Float64Array; receivers: Float64Array[]; measures: EdgeMeasures[]; worst: EdgeMeasures }
/** When the driver's edge starts (s). */
const T0 = 2e-9;

/** A net's edge simulated (with a termination, if asked) and measured at each receiver. */
export function runEdge(n: SiNetwork, edge: Edge, kind: TermKind = 'none', given?: TermValues): EdgeRun {
  const d = n.driver.model;
  const { c: c0, extraR } = terminated(n, kind, given);
  const tr = edge === 'rising' ? d.tr : d.tf, ramp = tr / 0.8;
  const [v0, v1] = edge === 'rising' ? [d.vlow, d.vcc] : [d.vcc, d.vlow];
  const src = c0.srcs[n.source]!;
  c0.srcs[n.source] = { ...src, r: (edge === 'rising' ? d.rup : d.rdown) + extraR, v: (t) => (t <= T0 ? v0 : t >= T0 + ramp ? v1 : v0 + ((v1 - v0) * (t - T0)) / ramp) };
  const dt = Math.min(50e-12, Math.max(2e-12, tr / 50));
  const probes = [n.driver.node, ...n.receivers.map((r) => r.node)];
  const s = simplify(c0, dt, probes);
  const total = delayOf(s.c);
  const tEnd = Math.min(400e-9, T0 + ramp + Math.max(20e-9, 14 * total));
  const res = transient(s.c, { dt, tEnd, probe: s.probe, points: 3000 });
  const t = res.t;
  const measures = n.receivers.map((r, i) => measure(t, res.v[i + 1]!, edge, r.model.vil, r.model.vih, T0 + ((edge === 'rising' ? r.model.vih - v0 : v0 - r.model.vil) / Math.abs(v1 - v0 || 1)) * ramp));
  const worst: EdgeMeasures = {
    overshoot: Math.max(0, ...measures.map((m) => m.overshoot)), undershoot: Math.max(0, ...measures.map((m) => m.undershoot)),
    level: edge === 'rising' ? Math.min(...measures.map((m) => m.level)) : Math.max(...measures.map((m) => m.level)),
    flight: Math.max(...measures.map((m) => m.flight)), slope: Math.max(...measures.map((m) => m.slope)),
  };
  return { edge, t, driver: res.v[0]!, receivers: res.v.slice(1), measures, worst };
}

/** A receiver's edge as AD measures it. */
export function measure(t: Float64Array, v: Float64Array, edge: Edge, vil: number, vih: number, tRef: number): EdgeMeasures {
  const n = v.length;
  const tail = Math.max(1, Math.floor(n * 0.08));
  let level = 0;
  for (let i = n - tail; i < n; i++) level += v[i]!;
  level /= tail;
  const first = (test: (x: number) => boolean) => { for (let i = 0; i < n; i++) if (test(v[i]!)) return i; return -1; };
  const cross = (i: number) => (i < 0 ? NaN : t[i]!);
  // Undershoot (ringback): how far it falls back once it has gone past its level (none if it never does)
  const settle = 0.005 + 0.002 * Math.abs(level);
  if (edge === 'rising') {
    const iH = first((x) => x >= vih), iL = first((x) => x >= vil), iTop = first((x) => x > level + settle);
    let max = -Infinity, minAfter = Infinity;
    for (let i = 0; i < n; i++) { max = Math.max(max, v[i]!); if (iTop >= 0 && i > iTop) minAfter = Math.min(minAfter, v[i]!); }
    return { overshoot: Math.max(0, max - level), undershoot: iTop >= 0 && Number.isFinite(minAfter) ? Math.max(0, level - minAfter) : 0, level, flight: cross(iH) - tRef, slope: cross(iH) - cross(iL) };
  }
  const iL = first((x) => x <= vil), iH = first((x) => x <= vih), iBase = first((x) => x < level - settle);
  let min = Infinity, maxAfter = -Infinity;
  for (let i = 0; i < n; i++) { min = Math.min(min, v[i]!); if (iBase >= 0 && i > iBase) maxAfter = Math.max(maxAfter, v[i]!); }
  return { overshoot: Math.max(0, level - min), undershoot: iBase >= 0 && Number.isFinite(maxAfter) ? Math.max(0, maxAfter - level) : 0, level, flight: cross(iL) - tRef, slope: cross(iL) - cross(iH) };
}

export interface Waves { t: Float64Array; names: string[]; v: Float64Array[] }

/**
 * A net driven by the stimulus (a single pulse, a constant level, pulses each period; its edges
 * the driver's own, pulling up through its high resistance and down through its low one): the
 * driver's and each receiver's voltages.
 */
export function runStimulus(n: SiNetwork, stim: Stimulus, kind: TermKind = 'none', given?: TermValues): Waves {
  const d = n.driver.model;
  const { c: c0, extraR } = terminated(n, kind, given);
  const width = Math.max(0, stim.stop - stim.start);
  // Each moment the output turns: its time and whether it goes high
  const turns: [number, boolean][] = [];
  const tEnd = Math.min(1e-6, stim.kind === 'Periodic Pulse' ? Math.max(stim.start + 2 * stim.period, stim.stop + 20e-9) : stim.kind === 'Constant Level' ? 50e-9 : Math.max(stim.period, stim.stop + 20e-9));
  if (stim.kind === 'Single Pulse') turns.push([stim.start, !stim.startHigh], [stim.stop, stim.startHigh]);
  else if (stim.kind === 'Periodic Pulse') for (let t = stim.start; t < tEnd && turns.length < 400; t += Math.max(stim.period, 1e-10)) turns.push([t, !stim.startHigh], [t + width, stim.startHigh]);
  turns.sort((a, b) => a[0] - b[0]);
  const lo = d.vlow, hi = d.vcc;
  const rampOf = (high: boolean) => (high ? d.tr : d.tf) / 0.8;
  // Each turn's start level: where the ramp before it had got to
  const from: number[] = [];
  turns.forEach(([t, h], i) => {
    if (!i) { from.push(stim.startHigh ? hi : lo); return; }
    const [tp, hp] = turns[i - 1]!, to = hp ? hi : lo, r = rampOf(hp);
    from.push(t - tp >= r ? to : from[i - 1]! + ((to - from[i - 1]!) * (t - tp)) / r);
    void h;
  });
  let k = 0;
  /** The output at t (asked in rising t, as the solver does; earlier asks start the search again). */
  const state = (t: number): { high: boolean; v: number } => {
    if (k > 0 && turns[k - 1]![0] > t) k = 0;
    while (k < turns.length && turns[k]![0] <= t) k++;
    if (!k) return { high: stim.startHigh, v: stim.startHigh ? hi : lo };
    const [at, high] = turns[k - 1]!, to = high ? hi : lo, r = rampOf(high);
    return { high, v: t - at >= r ? to : from[k - 1]! + ((to - from[k - 1]!) * (t - at)) / r };
  };
  const src = c0.srcs[n.source]!;
  c0.srcs[n.source] = { ...src, r: (stim.startHigh ? d.rup : d.rdown) + extraR, v: (t) => state(t).v, rt: (t) => (state(t).high ? d.rup : d.rdown) + extraR };
  const dt = Math.min(50e-12, Math.max(2e-12, Math.min(d.tr, d.tf) / 50));
  const probes = [n.driver.node, ...n.receivers.map((r) => r.node)];
  const s = simplify(c0, dt, probes);
  const res = transient(s.c, { dt, tEnd, probe: s.probe, points: 4000 });
  return { t: res.t, names: [`${n.driver.designator}-${n.driver.pin}`, ...n.receivers.map((r) => `${r.designator}-${r.pin}`)], v: res.v };
}
