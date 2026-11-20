/**
 * A placed board as the Smart Router reads it (26.193): written out as compact text, with what a
 * plan of its routing rests on worked out here: the board's size and copper layers, its width,
 * clearance and via rules as they stand, each part with its value, footprint, side and where its
 * middle is, and each net with its pins, how many connections it still needs and how long they are
 * as the crow flies. With the project's schematic, each part also has its description and each pin
 * its name. Positions in mm from the outline's lower left corner, seen from the top side.
 */
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim } from '../model/pcb';
import { L, isCopper, isSignal, layerName, type LayerId } from '../model/layers';
import { natural } from '../model/compile';
import { connections, ruleFor } from '../model/drc';
import { netRouting } from '../model/autoroute';
import { ruleLength } from '../formats/altium/rules';
import { boardFrame, partFacts, toUnits } from '../model/layoutPlan';
import type { DesignDigest } from './advise';
import type { Vec2 } from '../core/geom';

export interface RouteBrief {
  text: string;
  /** The nets a plan may name (those with two pins or more), and the copper layers' names. */
  nets: string[];
  layers: string[];
  /** The connections still to route, and their length as the crow flies (mm). */
  toRoute: number;
  length: number;
  /** Parts not on the board (a board is routed once its parts are placed). */
  unplaced: number;
}

const NET_PINS = 80;
const mm = (v: number) => v / toUnits(1);
const r1 = (v: number) => Math.round(v * 10) / 10, r3 = (v: number) => Math.round(v * 1000) / 1000;
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** A copper layer's name as the board has it. */
export const copperName = (doc: PcbDocument, l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);

export function routeBrief(doc: PcbDocument, o: { design?: DesignDigest | null } = {}): RouteBrief | null {
  const frame = boardFrame(doc);
  if (!frame) return null;
  const at = (v: Vec2) => `(${r1(mm(v.x - frame.minX))}, ${r1(mm(v.y - frame.minY))})`;
  const copper = doc.board.copperStack.filter(isCopper);
  const facts = partFacts(doc).filter((f) => f.designator);
  const byIndex = new Map(facts.map((f) => [f.index, f]));
  const info = new Map((o.design?.list ?? []).map((p) => [p.designator.toUpperCase(), p]));
  const pinName = new Map<string, string>();
  for (const p of o.design?.list ?? []) for (const pin of p.pins) if (pin.name && pin.name !== pin.number) pinName.set(`${p.designator}-${pin.number}`.toUpperCase(), clean(pin.name, 24));
  const comment = new Map<number, string>();
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && p.component !== NO_NET && p.text.trim()) comment.set(p.component, clean(p.text, 60));

  const lines: string[] = [];
  const W = mm(frame.maxX - frame.minX), H = mm(frame.maxY - frame.minY);
  // Pours there already, by layer
  const pours = doc.polygons.filter((p) => p.net !== NO_NET && doc.nets[p.net]);
  // A plane layer with the net it carries
  const planeNet = (l: LayerId) => { const n = doc.board.bag?.get(`PLANE${l - L.PLANE1 + 1}NETNAME`); return n && doc.nets.some((x) => x.name === n) ? `, ${n}` : ''; };
  lines.push(`Board "${doc.name}": ${r1(W)} × ${r1(H)} mm. Copper layers from the top: ${copper.map((l) => `${copperName(doc, l)} (${isSignal(l) ? 'signal' : `plane${planeNet(l)}`})`).join(', ')}. Positions in mm from the outline's lower left corner, x to the right and y up, seen from the top side.`);
  // The rules as they stand, for a net of no class
  const probe: PcbPrim = { kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: L.TOP, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, width: 0, net: NO_NET, component: NO_NET, polygon: NO_NET } as PcbPrim;
  const wr = ruleFor(doc, 'Width', probe), cr = ruleFor(doc, 'Clearance', probe), nr = netRouting(doc, NO_NET);
  const wl = (key: string) => r3(mm(wr ? ruleLength(wr, key, '10mil') : 100_000));
  lines.push(`Its rules as they stand: tracks ${wl('PREFEREDWIDTH')} mm wide (${wl('MINLIMIT')} to ${wl('MAXLIMIT')} mm allowed), ${r3(mm(cr ? ruleLength(cr, 'GAP', '10mil') : 100_000))} mm between different nets, vias ${r3(mm(nr.via.diameter))} mm across with a ${r3(mm(nr.via.hole))} mm hole.`);
  if (pours.length) lines.push(`Pours on the board: ${pours.map((p) => `${doc.nets[p.net]!.name} on ${copperName(doc, p.layer)}`).join('; ')}.`);

  const sorted = [...facts].sort((a, b) => natural(a.designator, b.designator));
  const placed = sorted.filter((f) => f.onBoard), unplaced = sorted.length - placed.length;
  lines.push('', `Parts (designator: value; footprint; pads; side; where its middle is${info.size ? '; description' : ''}):`);
  for (const f of placed) {
    const i = info.get(f.designator.toUpperCase());
    const b = f.box!;
    lines.push(`${f.designator}: ${[clean(i?.value || comment.get(f.index) || '', 60) || '(no value)', clean(doc.components[f.index]!.pattern, 60) || 'no footprint', `${f.pads} pad${f.pads === 1 ? '' : 's'}${f.holes ? (f.holes >= f.pads ? ', through-hole' : ', some through-hole') : ''}`,
      f.bottom ? 'bottom' : 'top', at({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }), i?.description ? `"${clean(i.description, 100)}"` : ''].filter(Boolean).join('; ')}`);
  }
  if (unplaced) lines.push(`${unplaced} part${unplaced === 1 ? ' is' : 's are'} not on the board yet: ${sorted.filter((f) => !f.onBoard).map((f) => f.designator).slice(0, 60).join(', ')}.`);

  // The nets: their pins, and what is left to route
  const left = new Map<number, { n: number; len: number }>();
  let toRoute = 0, length = 0;
  for (const c of connections(doc)) {
    const d = Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y), e = left.get(c.net) ?? { n: 0, len: 0 };
    e.n++; e.len += d; left.set(c.net, e);
    toRoute++; length += d;
  }
  const byNet = new Map<number, string[]>();
  for (const p of doc.prims) {
    if (p.kind !== 'pad' || p.net === NO_NET) continue;
    const f = p.component !== NO_NET ? byIndex.get((p as PcbPad).component) : undefined;
    const id = f ? `${f.designator}-${p.name}` : `a free pad at ${at(p.at)}`;
    const list = byNet.get(p.net) ?? [];
    if (!list.includes(id)) list.push(id);
    byNet.set(p.net, list);
  }
  const names: string[] = [], netLines: string[] = [], done: string[] = [];
  doc.nets.forEach((n, i) => {
    const pins = (byNet.get(i) ?? []).sort(natural);
    if (pins.length < 2) return;
    names.push(n.name);
    const e = left.get(i);
    if (!e) done.push(n.name);
    const named = pins.slice(0, NET_PINS).map((id) => { const nm = pinName.get(id.toUpperCase()); return nm ? `${id} ${nm}` : id; });
    netLines.push(`${n.name} (${pins.length} pins; ${e ? `${e.n} to route, ${r1(mm(e.len))} mm` : 'routed'}): ${named.join(', ')}${pins.length > NET_PINS ? ` … and ${pins.length - NET_PINS} more` : ''}`);
  });
  lines.push('', `Nets (name (pins; connections still to route and their length as the crow flies): pins${pinName.size ? ', each pin\'s name after it where the schematic gives one' : ''}):`, ...netLines.slice(0, 3000));
  lines.push('', done.length ? `Routed already (their copper stays): ${done.slice(0, 200).join(', ')}.` : 'Nothing is routed yet.');
  return { text: lines.join('\n'), nets: names, layers: copper.map((l) => copperName(doc, l)), toRoute, length: mm(length), unplaced };
}
