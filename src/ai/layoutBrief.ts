/**
 * A board as the Layout Planner reads it (26.191): written out as compact text, with what a plan
 * of the placement rests on worked out here: the outline's size (its corners when it isn't a
 * rectangle), the copper layers, the holes and keepouts, each part with its value, footprint, size
 * at rotation 0, pads and mounting, the parts that stay where they are with their places, and each
 * net with its pins. With the project's schematic, each part also has its description and the
 * sheet it is drawn on, and each pin its name. Positions in mm from the outline's lower left
 * corner, seen from the top side (a plan's fractions are of the same rectangle).
 */
import { NO_NET, type PcbDocument, type PcbPad } from '../model/pcb';
import { isCopper, layerName } from '../model/layers';
import { natural } from '../model/compile';
import { boardFrame, isRectangle, outlineArea, partFacts, toPlace, toUnits, type PartFacts, type PlanScope } from '../model/layoutPlan';
import { roomsOf } from '../model/rooms';
import type { DesignDigest } from './advise';
import type { BBox, Vec2 } from '../core/geom';

export interface LayoutBrief {
  text: string;
  /** Every part's designator (what a plan may name), those the plan places, and those that stay. */
  parts: string[];
  placing: number;
  fixed: number;
  nets: number;
  /** The share of the board's area the parts to place cover (bodies and pads), 0 to 1 and above. */
  cover: number;
}

/** Pins of a net listed in full up to this many; a bigger net lists its first ones and says how many more. */
const NET_PINS = 80;
const mm = (v: number) => v / toUnits(1);
const r1 = (v: number) => Math.round(v * 10) / 10;
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

export function layoutBrief(doc: PcbDocument, o: { scope?: PlanScope; design?: DesignDigest | null } = {}): LayoutBrief | null {
  const frame = boardFrame(doc);
  if (!frame) return null;
  const scope = o.scope ?? 'unlocked';
  const at = (v: Vec2) => `(${r1(mm(v.x - frame.minX))}, ${r1(mm(v.y - frame.minY))})`;
  const box = (b: BBox) => `${at({ x: b.minX, y: b.minY })} to ${at({ x: b.maxX, y: b.maxY })}`;
  const lname = (l: number) => doc.board.layerNames.get(l) ?? layerName(l);
  const outline = doc.board.outline;
  const W = mm(frame.maxX - frame.minX), H = mm(frame.maxY - frame.minY);
  const copper = doc.board.copperStack.filter(isCopper);
  const facts = partFacts(doc).filter((f) => f.designator);
  const byIndex = new Map(facts.map((f) => [f.index, f]));
  const sorted = [...facts].sort((a, b) => natural(a.designator, b.designator));
  const placing = sorted.filter((f) => toPlace(f, scope)), fixed = sorted.filter((f) => !toPlace(f, scope));
  // The schematic's word on each part and pin
  const info = new Map((o.design?.list ?? []).map((p) => [p.designator.toUpperCase(), p]));
  const pinName = new Map<string, string>();
  for (const p of o.design?.list ?? []) for (const pin of p.pins) if (pin.name && pin.name !== pin.number) pinName.set(`${p.designator}-${pin.number}`.toUpperCase(), clean(pin.name, 24));
  const sheetOf = (d: string) => o.design?.partRefs.get(d.toUpperCase())?.[0]?.sheet ?? '';
  const sheets = new Set((o.design?.list ?? []).map((p) => sheetOf(p.designator)).filter(Boolean));
  const comment = new Map<number, string>();
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && p.component !== NO_NET && p.text.trim()) comment.set(p.component, clean(p.text, 60));

  const lines: string[] = [];
  const rect = isRectangle(outline, frame);
  lines.push(`Board "${doc.name}": ${r1(W)} × ${r1(H)} mm${rect ? ', a rectangle' : ` across its outline, which is not a rectangle (${r1(outlineArea(outline) / toUnits(1) ** 2)} mm²)`}. ${copper.length} copper layer${copper.length === 1 ? '' : 's'} (${copper.map(lname).join(', ')}). Positions in mm from the outline's lower left corner, x to the right and y up, seen from the top side.`);
  if (!rect) lines.push(`Outline corners: ${thin(outline, 40).map(at).join(', ')}`);
  // Holes that belong to no part (mounting holes), keepouts, the designer's rooms
  const holes = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === NO_NET && p.hole >= toUnits(1.5));
  if (holes.length) lines.push(`Holes that belong to no part: ${holes.slice(0, 40).map((p) => `${at(p.at)} ${r1(mm(p.hole))} mm`).join('; ')}`);
  const keep: string[] = [];
  for (const p of doc.prims) {
    if (keep.length >= 24) break;
    if (!('keepout' in p) || !p.keepout || ('component' in p && p.component !== NO_NET)) continue;
    if (p.kind === 'fill') keep.push(`${box({ minX: Math.min(p.a.x, p.b.x), minY: Math.min(p.a.y, p.b.y), maxX: Math.max(p.a.x, p.b.x), maxY: Math.max(p.a.y, p.b.y) })} (${lname(p.layer)})`);
    else if (p.kind === 'region' && p.outline.length >= 3) { const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y); keep.push(`${box({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) })} (${lname(p.layer)})`); }
  }
  if (keep.length) lines.push(`Keepout areas: ${keep.join('; ')}`);
  const rooms = roomsOf(doc).filter((r) => r.enabled);
  if (rooms.length) lines.push(`Rooms the designer drew: ${rooms.slice(0, 24).map((r) => { const xs = r.outline.map((q) => q.x), ys = r.outline.map((q) => q.y); return `"${clean(r.name, 40)}" ${box({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) })}`; }).join('; ')}`);

  // The parts: those to place with their sizes, those that stay with their places
  const area = (f: PartFacts) => (f.w * f.h) / toUnits(1) ** 2;
  const board = outlineArea(outline) / toUnits(1) ** 2;
  const cover = board > 0 ? placing.reduce((s, f) => s + area(f), 0) / board : 0;
  const mount = (f: PartFacts) => (f.holes === 0 ? 'SMD' : f.holes >= f.pads ? 'through-hole' : 'SMD with through-hole pads');
  const line = (f: PartFacts) => {
    const i = info.get(f.designator.toUpperCase());
    const value = clean(i?.value || comment.get(f.index) || '', 60), sheet = sheets.size > 1 ? sheetOf(f.designator) : '';
    return `${f.designator}: ${[value || '(no value)', clean(doc.components[f.index]!.pattern, 60) || 'no footprint', `${r1(mm(f.w))} × ${r1(mm(f.h))} mm`, `${f.pads} pad${f.pads === 1 ? '' : 's'}`, mount(f),
      i?.description ? `"${clean(i.description, 100)}"` : '', sheet ? `sheet ${clean(sheet.replace(/\.schdoc$/i, ''), 40)}` : ''].filter(Boolean).join('; ')}`;
  };
  lines.push('', `Parts to place: ${placing.length}. Their bodies and pads cover ${r1(placing.reduce((s, f) => s + area(f), 0))} mm² together, ${Math.round(cover * 100)}% of the board's ${r1(board)} mm².`);
  lines.push('', `Parts (designator: value; footprint; size across × up at rotation 0; pads; mounting${info.size ? '; description' : ''}${sheets.size > 1 ? '; schematic sheet' : ''}):`, ...placing.map(line));
  if (fixed.length) {
    lines.push('', 'Fixed parts (they stay where they are; plan round them):');
    for (const f of fixed) {
      const c = doc.components[f.index]!;
      const where = f.onBoard && f.box ? `at ${at({ x: (f.box.minX + f.box.maxX) / 2, y: (f.box.minY + f.box.maxY) / 2 })}, covering ${box(f.box)}, ${f.bottom ? 'bottom' : 'top'} side, turned ${Math.round(c.rotation)}°` : 'off the board';
      lines.push(`${line(f)}; ${where}`);
    }
  }

  // The nets, with each pin's name where the schematic gives one
  const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component !== NO_NET && p.net !== NO_NET && byIndex.has(p.component));
  const byNet = new Map<number, string[]>();
  for (const p of pads) {
    const id = `${byIndex.get(p.component)!.designator}-${p.name}`;
    const list = byNet.get(p.net) ?? [];
    if (!list.includes(id)) list.push(id);
    byNet.set(p.net, list);
  }
  const netLines: string[] = [];
  doc.nets.forEach((n, i) => {
    const pins = (byNet.get(i) ?? []).sort(natural);
    if (pins.length < 2) return;
    const named = pins.slice(0, NET_PINS).map((id) => { const nm = pinName.get(id.toUpperCase()); return nm ? `${id} ${nm}` : id; });
    netLines.push(`${n.name}${pins.length > 12 ? ` (${pins.length} pins)` : ''}: ${named.join(', ')}${pins.length > NET_PINS ? ` … and ${pins.length - NET_PINS} more` : ''}`);
  });
  lines.push('', `Nets (name: pins${pinName.size ? ', each pin\'s name after it where the schematic gives one' : ''}):`, ...netLines.slice(0, 3000));
  return { text: lines.join('\n'), parts: sorted.map((f) => f.designator), placing: placing.length, fixed: fixed.length, nets: netLines.length, cover };
}

/** An outline's corners, at most so many (every nth of a flattened arc's). */
function thin(o: Vec2[], most: number): Vec2[] {
  if (o.length <= most) return o;
  const step = Math.ceil(o.length / most);
  return o.filter((_, i) => i % step === 0);
}
