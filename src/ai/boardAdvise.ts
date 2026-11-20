/**
 * A board as the AI adviser reads it: written out as compact text, with the measurements a layout
 * review rests on worked out here (a model guesses distances badly): the board's size and layers,
 * its design rules, each component's footprint, side and place, how far each IC supply pad's
 * nearest capacitors are, how far a crystal is from the pins it drives, each net's routing (length,
 * widths, layers, vias, pours, connections still unrouted), differential pairs' lengths, parts by
 * the board's edge, exposed pads and their vias. Positions in mm from the board's origin.
 */
import { NO_NET, copperNet, inPour, type PcbDocument, type PcbPad, type PcbPrim } from '../model/pcb';
import { connections } from '../model/drc';
import { isCopper, layerName, L } from '../model/layers';
import { toMm } from '../core/units';
import { natural } from '../model/compile';
import type { Vec2 } from '../core/geom';

export interface BoardDigest {
  text: string;
  parts: number;
  nets: number;
  /** Component index by designator, net index by name (upper case): to show a finding's on the board. */
  compIndex: Map<string, number>;
  netIndex: Map<string, number>;
}

const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
/** Nets that are supplies by their names (VCC, +3V3, VDD_IO, 5V …); grounds by theirs. */
const SUPPLY = /^[+-]?(\d+V\d*|\d+\.\d+V|V(CC|DD|IN|BAT|BUS|REF|IO|SYS|CORE|OUT|PP|MOT|LED)\w*|A?VDD\w*|D?VCC\w*|[AD]VCC|[AD]VDD|\d+V\d+\w*|P\d+V\d*)$/i;
const GROUND = /^(A|D|P|S|CHASSIS_?|EARTH_?)?(GND|VSS|0V)\w*$/i;
export const isSupplyNet = (name: string) => SUPPLY.test(name.replace(/^NET/i, '')) && !GROUND.test(name);
export const isGroundNet = (name: string) => GROUND.test(name);
const IC = /^(U|IC|Q|VR|PS|M|MOD)\d/i, CAP = /^C\d/i, XTAL = /^(Y|X|XTAL|OSC)\d/i;

/** A segment's length, an arc's. */
const lengthOf = (p: PcbPrim) => (p.kind === 'track' ? dist(p.a, p.b) : p.kind === 'arc' ? (p.r * Math.PI * (((p.end - p.start) % 360 + 360) % 360 || 360)) / 180 : 0);
/** The shortest distance from a point to the board's outline. */
function toEdge(p: Vec2, outline: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * The board's text. `pinTypes` (designator-pin → electrical type, from the project's schematic
 * when there is one) tells supply pins exactly; without it, supplies go by their nets' names.
 */
export function boardDigest(doc: PcbDocument, o: { pinTypes?: Map<string, number> } = {}): BoardDigest {
  const mmAt = (v: Vec2) => `(${r2(toMm(v.x - doc.board.origin.x))}, ${r2(toMm(v.y - doc.board.origin.y))})`;
  const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad');
  const comps = [...doc.components].sort((a, b) => natural(a.designator, b.designator));
  const desOf = (i: number) => doc.components.find((c) => c.index === i)?.designator ?? '';
  const netNameOf = (n: number) => (n === NO_NET ? '' : doc.nets[n]?.name ?? '');
  const padsOf = new Map<number, PcbPad[]>();
  for (const p of pads) if (p.component !== NO_NET) padsOf.set(p.component, [...(padsOf.get(p.component) ?? []), p]);
  const comment = (i: number) => { const t = doc.prims.find((p) => p.kind === 'text' && p.isComment && p.component === i); return t?.kind === 'text' ? t.text : ''; };
  const outline = doc.board.outline;
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  const w = outline.length ? toMm(Math.max(...xs) - Math.min(...xs)) : 0, h = outline.length ? toMm(Math.max(...ys) - Math.min(...ys)) : 0;
  const copper = doc.board.copperStack.filter(isCopper);
  const lname = (l: number) => doc.board.layerNames.get(l) ?? layerName(l);
  const tracks = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'track' | 'arc' }> => (p.kind === 'track' || p.kind === 'arc') && isCopper(p.layer) && !inPour(p) && !p.keepout);
  const vias = doc.prims.filter((p) => p.kind === 'via');
  const bottom = doc.components.filter((c) => c.layer === L.BOTTOM).length;
  const lines: string[] = [];
  lines.push(`Board "${doc.name}": ${r1(w)} × ${r1(h)} mm, ${copper.length} copper layer${copper.length === 1 ? '' : 's'} (${copper.map(lname).join(', ')}), ${doc.components.length} components (${bottom} on the bottom), ${doc.nets.length} nets, ${tracks.length} tracks and arcs, ${vias.length} vias. Positions in mm from the board's origin.`);
  // Design rules: the routing ones, as the board has them
  const rules = doc.rules.filter((r) => r.bag.get('ENABLED') !== 'FALSE' && /^(Clearance|Width|RoutingVias|HoleSize|MinimumAnnularRing|PlaneClearance|PolygonConnect|DiffPairsRouting)$/.test(r.bag.get('RULEKIND') ?? ''));
  if (rules.length) {
    lines.push('', 'Design rules:');
    for (const r of rules.slice(0, 24)) {
      const b = r.bag, k = b.get('RULEKIND') ?? '';
      const vals = ['GAP', 'GENERICCLEARANCE', 'CLEARANCE', 'MINLIMIT', 'PREFEREDWIDTH', 'MAXLIMIT', 'MINWIDTH', 'WIDTH', 'HOLEWIDTH', 'MINHOLEWIDTH', 'MAXHOLEWIDTH', 'MINRING', 'CONNECTSTYLE']
        .filter((x) => b.has(x)).map((x) => `${x.toLowerCase()} ${b.get(x)}`).slice(0, 5);
      lines.push(`${b.get('NAME') ?? k} (${k}; ${b.get('SCOPE1EXPRESSION') ?? 'All'}${b.has('SCOPE2EXPRESSION') ? ` / ${b.get('SCOPE2EXPRESSION')}` : ''}): ${vals.join(', ')}`);
    }
  }
  // Components
  lines.push('', 'Components (designator: footprint; comment; side; position; rotation):');
  const compIndex = new Map<string, number>();
  for (const c of comps) {
    compIndex.set(c.designator.toUpperCase(), c.index);
    lines.push(`${c.designator}: ${c.pattern}; ${comment(c.index) || '—'}; ${c.layer === L.BOTTOM ? 'bottom' : 'top'}; ${mmAt(c.at)}; ${Math.round(c.rotation)}°`);
  }
  // Decoupling: each IC supply pad's nearest capacitors on its net
  const supplyPad = (p: PcbPad) => {
    const des = desOf(p.component), name = netNameOf(p.net);
    if (!name || isGroundNet(name)) return false;
    // A power pin by the schematic, or a pin on a net named as a supply
    return o.pinTypes?.get(`${des}-${p.name}`.toUpperCase()) === 7 || isSupplyNet(name);
  };
  const capPads = pads.filter((p) => CAP.test(desOf(p.component)) && p.net !== NO_NET);
  const dec: string[] = [];
  for (const c of comps) {
    if (!IC.test(c.designator)) continue;
    for (const p of (padsOf.get(c.index) ?? []).filter(supplyPad).sort((a, b) => natural(a.name, b.name))) {
      const near = capPads.filter((q) => q.net === p.net).map((q) => ({ q, d: toMm(dist(q.at, p.at)) })).sort((a, b) => a.d - b.d);
      const seen = new Set<number>();
      const top2 = near.filter((x) => (seen.has(x.q.component) ? false : (seen.add(x.q.component), true))).slice(0, 2);
      const side = (q: PcbPad) => (doc.components.find((k) => k.index === q.component)?.layer !== c.layer ? ' (other side)' : '');
      dec.push(`${c.designator}-${p.name} (${netNameOf(p.net)}): ${top2.length ? top2.map((x) => `${desOf(x.q.component)} ${r1(x.d)} mm${side(x.q)}`).join(', ') : 'no capacitor on its net'}`);
    }
  }
  if (dec.length) lines.push('', 'Decoupling (each IC supply pad: its nearest capacitors on the same net, centre to centre):', ...dec.slice(0, 300));
  // Crystals: how far from the pads they drive
  const xt: string[] = [];
  for (const c of comps) {
    if (!XTAL.test(c.designator)) continue;
    for (const p of padsOf.get(c.index) ?? []) {
      if (p.net === NO_NET || isGroundNet(netNameOf(p.net))) continue;
      const to = pads.filter((q) => q.net === p.net && q.component !== c.index && IC.test(desOf(q.component)));
      for (const q of to) xt.push(`${c.designator}-${p.name} to ${desOf(q.component)}-${q.name} (${netNameOf(p.net)}): ${r1(toMm(dist(p.at, q.at)))} mm`);
    }
  }
  if (xt.length) lines.push('', 'Crystals and oscillators (to the IC pins they drive, straight line):', ...xt.slice(0, 40));
  // Nets: routing as it stands
  const unrouted = new Map<number, number>();
  for (const k of connections(doc)) unrouted.set(k.net, (unrouted.get(k.net) ?? 0) + 1);
  const netIndex = new Map<string, number>();
  const netLines: string[] = [];
  const byNet = new Map<number, { len: number; minW: number; maxW: number; layers: Set<string>; vias: number }>();
  for (const t of tracks) {
    const n = copperNet(doc, t);
    if (n === NO_NET) continue;
    const s = byNet.get(n) ?? { len: 0, minW: Infinity, maxW: 0, layers: new Set<string>(), vias: 0 };
    s.len += lengthOf(t); s.minW = Math.min(s.minW, t.width); s.maxW = Math.max(s.maxW, t.width); s.layers.add(lname(t.layer));
    byNet.set(n, s);
  }
  for (const v of vias) { const n = (v as { net: number }).net; if (n === NO_NET) continue; const s = byNet.get(n) ?? { len: 0, minW: Infinity, maxW: 0, layers: new Set<string>(), vias: 0 }; s.vias++; byNet.set(n, s); }
  const padCount = new Map<number, number>();
  for (const p of pads) if (p.net !== NO_NET) padCount.set(p.net, (padCount.get(p.net) ?? 0) + 1);
  const pours = new Map<number, string[]>();
  for (const pg of doc.polygons) if (pg.net !== NO_NET && isCopper(pg.layer) && !/cutout/i.test(pg.type)) pours.set(pg.net, [...(pours.get(pg.net) ?? []), `${lname(pg.layer)}${pg.hatch && pg.hatch !== 'Solid' ? ` (${pg.hatch})` : ''}`]);
  const planeNets = new Set<number>();
  for (const [l, name] of doc.board.layerNames) if (l >= L.PLANE1 && l <= L.PLANE16 && name) { const i = doc.nets.findIndex((n) => n.name === name); if (i >= 0) planeNets.add(i); }
  doc.nets.forEach((n, i) => {
    netIndex.set(n.name.toUpperCase(), i);
    const pc = padCount.get(i) ?? 0;
    if (pc < 2 && !byNet.has(i)) return;
    const s = byNet.get(i);
    const parts = [`${pc} pads`, s && s.len ? `${r1(toMm(s.len))} mm of track, ${r2(toMm(s.minW))}${s.maxW !== s.minW ? `–${r2(toMm(s.maxW))}` : ''} mm wide, on ${[...s.layers].join(' and ')}` : 'no tracks',
      s?.vias ? `${s.vias} via${s.vias === 1 ? '' : 's'}` : '', pours.get(i) ? `pour on ${pours.get(i)!.join(', ')}` : '', planeNets.has(i) ? 'plane' : '',
      unrouted.get(i) ? `${unrouted.get(i)} connection${unrouted.get(i) === 1 ? '' : 's'} unrouted` : ''].filter(Boolean);
    netLines.push(`${n.name}: ${parts.join('; ')}`);
  });
  lines.push('', 'Nets (pads; routing; vias; pours; unrouted):', ...netLines.slice(0, 600));
  // Differential pairs
  const pairs = (doc.diffPairs ?? []).map((b) => [b.get('NAME') ?? '', b.get('POSITIVENETNAME') ?? '', b.get('NEGATIVENETNAME') ?? ''] as const).filter(([, p, n]) => p && n);
  if (pairs.length) {
    lines.push('', 'Differential pairs (track length of each net):');
    for (const [name, p, n] of pairs) {
      const lp = byNet.get(netIndex.get(p.toUpperCase()) ?? -1)?.len ?? 0, ln = byNet.get(netIndex.get(n.toUpperCase()) ?? -1)?.len ?? 0;
      lines.push(`${name}: ${p} ${r2(toMm(lp))} mm, ${n} ${r2(toMm(ln))} mm (difference ${r2(toMm(Math.abs(lp - ln)))} mm)`);
    }
  }
  // Parts by the edge
  if (outline.length > 2) {
    const edge: string[] = [];
    for (const c of comps) {
      const d = Math.min(...(padsOf.get(c.index) ?? []).map((p) => toEdge(p.at, outline)));
      if (Number.isFinite(d) && toMm(d) < 1) edge.push(`${c.designator}: a pad ${r2(toMm(d))} mm from the edge`);
    }
    if (edge.length) lines.push('', 'Parts by the board\'s edge (pad centre within 1 mm):', ...edge.slice(0, 60));
  }
  // Exposed pads: an IC's pad much larger than its others, and the vias inside it
  const ep: string[] = [];
  for (const c of comps) {
    const ps = padsOf.get(c.index) ?? [];
    if (ps.length < 4 || !IC.test(c.designator)) continue;
    const area = (p: PcbPad) => p.top.w * p.top.h;
    const big = [...ps].sort((a, b) => area(b) - area(a));
    const second = big[1] ? area(big[1]) : 0;
    if (!big[0] || area(big[0]) < second * 6 || big[0].hole) continue;
    const e = big[0], hw = e.top.w / 2, hh = e.top.h / 2;
    const inside = vias.filter((v) => Math.abs((v as { at: Vec2 }).at.x - e.at.x) <= Math.max(hw, hh) && Math.abs((v as { at: Vec2 }).at.y - e.at.y) <= Math.max(hw, hh) && (v as { net: number }).net === e.net).length;
    ep.push(`${c.designator}-${e.name} (${netNameOf(e.net) || 'no net'}): ${r2(toMm(e.top.w))} × ${r2(toMm(e.top.h))} mm, ${inside} via${inside === 1 ? '' : 's'} in it`);
  }
  if (ep.length) lines.push('', 'Exposed pads (vias in them):', ...ep);
  return { text: lines.join('\n'), parts: doc.components.length, nets: doc.nets.length, compIndex, netIndex };
}
