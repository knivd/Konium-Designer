/**
 * The enclosure designer's face editor: one face of the box drawn flat as seen from outside — a
 * wall (its straight part, its corners, the floor, the joint and the top's underside, the board
 * edge on, and the parts behind it, darker the nearer they are) or the top or the bottom (the
 * outside and the cavity, the board and its parts, the standoffs, screws and posts) — with its
 * openings (pockets shaded), vent patches, protrusions (outside solid, inside dashed), text and
 * logos, which are moved by dragging (sized by their handles too). With a tool picked, its feature
 * follows the pointer (snapped) and a click anywhere on the face puts it there, over what is there
 * too. A click on a part picks it, and an opening is made for it in one go.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { keyholeLayout, logoOf, ventCells, type Add, type BoardFacts, type Face, type Label, type Layout, type Opening, type EnclosureSpec, type Side, type Vent } from '../model/enclosure';
import { FACE_NAME } from '../model/enclosureSolid';
import { strokeText } from '../formats/gerber/stroke';
import { pickFileHandle } from '../platform/fs';
import { notify } from './state';
import { TOOLS, makeItem, type Item, type ItemList, type Pick, type ToolId } from './EnclosureTools';

interface P { x: number; y: number }
export type { ItemList, Pick };
const WALLS: Side[] = ['S', 'E', 'N', 'W'];
const snap = (v: number, fine: boolean) => (fine ? Math.round(v * 10) / 10 : Math.round(v * 2) / 2);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** An opening fitted to a part, on a face: on a wall, as wide and high as the part reaches it; on the top or bottom, over its footprint. */
export function openingFor(part: BoardFacts['parts'][number], face: Face, g: Layout, n: number): Opening {
  const m = 0.5;
  if (face === 'top' || face === 'bottom') {
    const x = (part.x0 + part.x1) / 2, y = (part.y0 + part.y1) / 2, w = part.x1 - part.x0 + 2 * m, h = part.y1 - part.y0 + 2 * m;
    const round = part.kind === 'led' || part.kind === 'switch';
    const d = Math.min(w, h);
    return { name: part.name || `Opening ${n}`, face, shape: round ? 'circle' : 'rect', x: r2(x), y: r2(y), w: r2(round ? d : w), h: r2(round ? d : h), on: true, part: part.name };
  }
  const f = g.sides[face];
  const us = [part.x0, part.x1].flatMap((x) => [part.y0, part.y1].map((y) => x * f.d.x + y * f.d.y));
  const u0 = Math.min(...us) - m, u1 = Math.max(...us) + m;
  return { name: part.name || `Opening ${n}`, face, shape: 'rect', x: r2((u0 + u1) / 2), y: r2(part.z1 / 2), w: r2(u1 - u0), h: r2(part.z1 + 2 * m), on: true, part: part.name };
}

/** A shape's outline as an SVG path, centred at 0,0, y up (it is drawn flipped). */
function shapePath(o: { shape: Opening['shape']; w: number; h: number }, teardrop: boolean): string {
  const w = Math.max(0.2, o.w), h = Math.max(0.2, o.h);
  if (o.shape === 'circle') {
    const r = w / 2;
    if (teardrop) { const a = Math.PI / 4, t = r * Math.SQRT2; return `M ${-r * Math.cos(a)} ${r * Math.sin(a)} A ${r} ${r} 0 1 1 ${r * Math.cos(a)} ${r * Math.sin(a)} L 0 ${t} Z`; }
    return `M ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 Z`;
  }
  const rr = o.shape === 'slot' ? Math.min(w, h) / 2 : o.shape === 'rounded' ? Math.max(0, Math.min(2, Math.min(w, h) / 2 - 0.05)) : 0;
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  if (!rr) return `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;
  return `M ${x0 + rr} ${y0} H ${x1 - rr} A ${rr} ${rr} 0 0 1 ${x1} ${y0 + rr} V ${y1 - rr} A ${rr} ${rr} 0 0 1 ${x1 - rr} ${y1} H ${x0 + rr} A ${rr} ${rr} 0 0 1 ${x0} ${y1 - rr} V ${y0 + rr} A ${rr} ${rr} 0 0 1 ${x0 + rr} ${y0} Z`;
}
const rrectPath = (hx: number, hy: number, r: number) => { const k = Math.max(0, Math.min(r, hx, hy)); return `M ${-hx + k} ${-hy} H ${hx - k} A ${k} ${k} 0 0 1 ${hx} ${-hy + k} V ${hy - k} A ${k} ${k} 0 0 1 ${hx - k} ${hy} H ${-hx + k} A ${k} ${k} 0 0 1 ${-hx} ${hy - k} V ${-hy + k} A ${k} ${k} 0 0 1 ${-hx + k} ${-hy} Z`; };
/**
 * A drawing (SVG) picked and made a logo, as a label not yet placed (its text the file's name,
 * as high as the drawing, 5 to 25 mm, cut 0.6 mm in); nothing when it fills no shapes.
 */
export async function pickLogo(then: (l: Omit<Label, 'face' | 'x' | 'y'>) => void): Promise<void> {
  const f = await pickFileHandle(['.svg'], 'SVG drawings', 'konium-logo');
  if (!f) return;
  const name = f.name.replace(/\.svg$/i, '');
  const r = logoOf(new TextDecoder().decode(f.bytes), name);
  if (!r) { notify(`${f.name} has no filled shapes (text in it must be turned into paths first)`, 'error'); return; }
  then({ text: name, logo: r.logo, size: Math.round(Math.max(5, Math.min(25, r.height)) * 10) / 10, depth: 0.6, raised: false, on: true });
}

/** A logo's shapes as SVG paths (centred, y up, at its height), each with its fill rule and whether it takes away. */
export const logoPaths = (l: Label): { d: string; rule: 'evenodd' | 'nonzero'; knock: boolean }[] =>
  (l.logo?.shapes ?? []).map((sh) => ({ rule: sh.evenOdd ? 'evenodd' : 'nonzero', knock: !!sh.knock, d: sh.rings.map((r) => r.map(([x, y], k) => `${k ? 'L' : 'M'} ${(x * l.size).toFixed(3)} ${(y * l.size).toFixed(3)}`).join(' ') + ' Z').join(' ') }));

/** A label's strokes (face coordinates, centred on its middle) and their width; a logo's size. */
export function labelStrokes(l: Label, nozzle: number): { lines: P[][]; width: number; w: number; h: number } {
  if (l.logo) return { lines: [], width: 0, w: Math.max(1, l.size) * l.logo.aspect, h: Math.max(1, l.size) };
  const size = Math.max(1, l.size), width = Math.max(nozzle * 2, size * 0.14);
  const lines = strokeText(l.text, { x: 0, y: 0 }, size);
  const pts = lines.flat();
  if (!pts.length) return { lines: [], width, w: 0, h: 0 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { lines: lines.map((ln) => ln.map((p) => ({ x: p.x - cx, y: p.y - cy }))), width, w: Math.max(...xs) - Math.min(...xs) + width, h: Math.max(...ys) - Math.min(...ys) + width };
}

type Drag = { list: ItemList; i: number; kind: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'; from: P; was: Item; begun?: boolean };
/** The grid's steps (mm): the finest at least 8 px apart; every fifth (or second) line stronger. */
const STEPS = [1, 2, 5, 10, 20, 50];
const majorOf = (minor: number) => (minor === 5 || minor === 50 ? minor * 2 : minor * 5);
const fmt = (v: number) => (Math.abs(v) < 0.05 ? '0' : v.toFixed(Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1));

export function EnclosureFace({ s, g, facts, face, setFace, pick, setPick, change, begin, tool, place }: {
  s: EnclosureSpec; g: Layout; facts: BoardFacts; face: Face; setFace: (f: Face) => void;
  pick: Pick; setPick: (p: Pick) => void;
  /** A list changed (part of a change already begun). */
  change: (list: ItemList, items: Item[]) => void;
  /** A change starts that undo takes back in one step. */
  begin: () => void;
  /** The tool picked: anything but Select puts its feature where the face is clicked. */
  tool: ToolId;
  place: (face: Face, p: P) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [part, setPart] = useState<string | null>(null);
  const [at, setAt] = useState<P | null>(null);
  /** With a tool picked, where its feature would go (snapped). */
  const [hover, setHover] = useState<P | null>(null);
  /** The view: zoomed (1: the whole face) about a centre moved from the face's. */
  const [zoom, setZoom] = useState({ k: 1, cx: 0, cy: 0 });
  const [px, setPx] = useState({ w: 600, h: 300 });
  /** Lines the pointer has snapped to (drawing coordinates). */
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const pan = useRef<{ sx: number; sy: number; cx: number; cy: number; moved: boolean } | null>(null);
  useEffect(() => setZoom({ k: 1, cx: 0, cy: 0 }), [face]);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setPx({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wall = face !== 'top' && face !== 'bottom';
  const mirror = face === 'bottom' ? -1 : 1;
  // The face's extent (face coordinates: along and up on a wall; x and y on the top or bottom)
  const half = wall ? (face === 'S' || face === 'N' ? g.ox : g.oy) : g.ox;
  const lo = wall ? -g.boardTop : -g.oy, hi = wall ? g.height - g.boardTop : g.oy;
  const pad = 6;
  const bx0 = -half - pad, by0 = -hi - pad, bw = 2 * half + 2 * pad, bh = hi - lo + 2 * pad;
  const vw = bw / zoom.k, vh = bh / zoom.k, vcx = bx0 + bw / 2 + zoom.cx, vcy = by0 + bh / 2 + zoom.cy;
  const vb = `${vcx - vw / 2} ${vcy - vh / 2} ${vw} ${vh}`;
  /** Pixels to a millimetre, and what the view shows (it is fitted whole, so one way shows more). */
  const ppm = Math.max(0.01, Math.min(px.w / vw, px.h / vh));
  const vis = { x0: vcx - px.w / ppm / 2, x1: vcx + px.w / ppm / 2, y0: vcy - px.h / ppm / 2, y1: vcy + px.h / ppm / 2 };
  const minor = STEPS.find((st) => st * ppm >= 8) ?? 100, major = majorOf(minor);
  /** Face coordinates to the drawing's (y down; the bottom seen from below). */
  const X = (x: number) => x * mirror, Y = (y: number) => -y;
  const toFace = (e: PointerEvent): P | null => {
    const el = svg.current, m = el?.getScreenCTM();
    if (!el || !m) return null;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: q.x * mirror, y: -q.y };
  };
  const listOf = (l: ItemList): Item[] => s[l];
  const isSel = (l: ItemList, i: number) => pick?.list === l && pick.i === i;
  /**
   * A point snapped: to the middle across the face (on a wall, also the board's top and halfway up
   * the inside), the parts' middles and the other features' middles on this face when within 6 px
   * of one (the line shown), else to half a millimetre (Shift: a tenth).
   */
  const snapPt = (q: P, fine: boolean, skip?: { list: ItemList; i: number }): P => {
    const tol = 6 / ppm;
    // On a wall: the board's top, and halfway up the inside (from the floor to the top's underside), as Centre up puts it
    const xs = [0], ys = wall ? [0, Math.round(((g.floorTop + g.rim) / 2 - g.boardTop) * 10) / 10] : [0];
    for (const p of partsHere) { xs.push((p.x0 + p.x1) / 2); ys.push((p.y0 + p.y1) / 2); }
    for (const l of ['openings', 'vents', 'labels', 'adds'] as ItemList[]) listOf(l).forEach((o, i) => { if (o.face === face && !(skip && skip.list === l && skip.i === i)) { xs.push(o.x); ys.push(o.y); } });
    const near = (v: number, vs: number[]) => { let b: number | null = null; for (const c of vs) if (Math.abs(c - v) <= tol && (b === null || Math.abs(c - v) < Math.abs(b - v))) b = c; return b; };
    const gx = fine ? null : near(q.x, xs), gy = fine ? null : near(q.y, ys);
    setGuides({ x: gx === null ? null : X(gx), y: gy === null ? null : Y(gy) });
    return { x: r2(gx ?? snap(q.x, fine)), y: r2(gy ?? snap(q.y, fine)) };
  };

  const down = (e: PointerEvent, list: ItemList, i: number, kind: Drag['kind']) => {
    // With a tool picked, a click on a feature puts the tool's there too (the face takes the click)
    if (tool !== 'select' && e.button === 0) return;
    e.stopPropagation(); e.preventDefault();
    const q = toFace(e);
    if (!q) return;
    setPick({ list, i }); setPart(null);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    // The undo step begins with the first real move (a click that only picks it changes nothing)
    setDrag({ list, i, kind, from: q, was: { ...listOf(list)[i]! } });
  };
  const move = (e: PointerEvent) => {
    const q = toFace(e);
    setAt(q);
    if (!drag || !q) return;
    const fine = e.shiftKey, w = drag.was as Item & { w?: number; h?: number; shape?: string };
    const dx = snap(q.x - drag.from.x, fine), dy = snap(q.y - drag.from.y, fine);
    let o: Item;
    if (drag.kind === 'move' || w.w === undefined || w.h === undefined) { const c = snapPt({ x: w.x + (q.x - drag.from.x), y: w.y + (q.y - drag.from.y) }, fine, drag); o = { ...w, x: c.x, y: c.y }; }
    else {
      let x0 = w.x - w.w / 2, x1 = w.x + w.w / 2, y0 = w.y - w.h / 2, y1 = w.y + w.h / 2;
      // The drawing's east is the face's west on the bottom (seen from below)
      if (drag.kind.includes('e')) { if (mirror > 0) x1 += dx; else x0 += dx; }
      if (drag.kind.includes('w')) { if (mirror > 0) x0 += dx; else x1 += dx; }
      if (drag.kind.includes('n')) y1 += dy;
      if (drag.kind.includes('s')) y0 += dy;
      // A circle's diameter: along the side dragged
      if (w.shape === 'circle') { const d = Math.max(0.5, drag.kind === 'e' || drag.kind === 'w' ? Math.abs(x1 - x0) : Math.abs(y1 - y0)); o = { ...w, w: r2(d), h: r2(d) } as Item; }
      else o = { ...w, x: r2((x0 + x1) / 2), y: r2((y0 + y1) / 2), w: r2(Math.max(0.5, Math.abs(x1 - x0))), h: r2(Math.max(0.5, Math.abs(y1 - y0))) } as Item;
    }
    const cur = listOf(drag.list)[drag.i] as Item & { w?: number; h?: number };
    const o2 = o as Item & { w?: number; h?: number };
    if (cur && cur.x === o2.x && cur.y === o2.y && cur.w === o2.w && cur.h === o2.h) return;
    if (!drag.begun) { begin(); drag.begun = true; }
    change(drag.list, listOf(drag.list).map((x, k) => (k === drag.i ? (drag.list === 'openings' ? { ...o, auto: false } : o) : x)));
  };
  const up = () => { setDrag(null); setGuides({ x: null, y: null }); };
  /** The wheel zooms about the pointer. */
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const el = svg.current, m = el?.getScreenCTM();
    if (!el || !m) return;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const k = Math.max(1, Math.min(40, zoom.k * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
    const f = zoom.k / k, ncx = q.x + (vcx - q.x) * f, ncy = q.y + (vcy - q.y) * f;
    setZoom(k === 1 ? { k: 1, cx: 0, cy: 0 } : { k, cx: ncx - (bx0 + bw / 2), cy: ncy - (by0 + bh / 2) });
  };

  /** The parts as the face sees them: on a wall, their extent along it and up, and how far behind it they are. */
  const partsHere = (face === 'bottom' ? [] : facts.parts).map((p) => {
    if (!wall) return { p, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1, near: 1 };
    const f = g.sides[face as Side];
    const us = [p.x0, p.x1].flatMap((x) => [p.y0, p.y1].map((y) => x * f.d.x + y * f.d.y));
    const ns = [p.x0, p.x1].flatMap((x) => [p.y0, p.y1].map((y) => x * f.n.x + y * f.n.y));
    const depth = (f.m.x * f.n.x + f.m.y * f.n.y) - Math.max(...ns);
    return { p, x0: Math.min(...us), x1: Math.max(...us), y0: 0, y1: p.z1, near: Math.max(0.12, 1 - depth / 12) };
  }).sort((a, b) => a.near - b.near);
  const parts = partsHere;
  const picked = facts.parts.find((p) => p.name === part) ?? null;
  const add = (list: ItemList, o: Item) => { begin(); change(list, [...listOf(list), o]); setPick({ list, i: listOf(list).length }); setPart(null); };
  const placing = tool !== 'select';
  const toolName = TOOLS.find((x) => x.id === tool)?.label ?? '';

  const handles = (list: ItemList, o: Opening | Vent | Add, i: number) => {
    const circle = 'shape' in o && o.shape === 'circle';
    const hs: [Drag['kind'], number, number][] = circle ? [['e', o.w / 2, 0], ['n', 0, o.w / 2], ['w', -o.w / 2, 0], ['s', 0, -o.w / 2]]
      : [['nw', -o.w / 2, o.h / 2], ['n', 0, o.h / 2], ['ne', o.w / 2, o.h / 2], ['e', o.w / 2, 0], ['se', o.w / 2, -o.h / 2], ['s', 0, -o.h / 2], ['sw', -o.w / 2, -o.h / 2], ['w', -o.w / 2, 0]];
    const size = 8 / ppm;
    // Placed by the drawing's compass (the bottom is seen from below)
    return hs.map(([k, dx, dy]) => <rect key={k} class={`encf-handle h-${k}`} x={X(o.x + mirror * dx) - size / 2} y={Y(o.y + dy) - size / 2} width={size} height={size} onPointerDown={(e) => down(e as unknown as PointerEvent, list, i, k)} />);
  };

  /** The tool's feature where a click would put it, drawn faintly (a logo: a cross, as its drawing is not picked yet). */
  const ghost = (p: P) => {
    const m = makeItem(tool, s, g, face, p.x, p.y);
    const tr = `translate(${X(p.x)} ${Y(p.y)}) scale(${mirror} -1)`;
    const cross = 2.5;
    let body: preact.JSX.Element;
    if (!m) body = <path d={`M ${X(p.x) - cross} ${Y(p.y)} H ${X(p.x) + cross} M ${X(p.x)} ${Y(p.y) - cross} V ${Y(p.y) + cross}`} />;
    else if (m.list === 'labels') { const st = labelStrokes(m.item as Label, s.print.nozzle); body = <path class="encf-ghost-text" d={st.lines.map((ln) => ln.map((q, k) => `${k ? 'L' : 'M'} ${X(p.x) + q.x} ${Y(p.y + q.y)}`).join(' ')).join(' ')} stroke-width={st.width} />; }
    else if (m.list === 'vents') { const v = m.item as Vent; body = <rect x={X(p.x) - v.w / 2} y={Y(p.y) - v.h / 2} width={v.w} height={v.h} />; }
    else { const o = m.item as Opening | Add; body = <><path d={shapePath(o, false)} transform={tr} />{m.list === 'adds' && (o as Add).hole > 0 && <circle cx={X(p.x)} cy={Y(p.y)} r={(o as Add).hole / 2} />}</>; }
    return <g class="encf-ghost" aria-hidden="true">{body}</g>;
  };
  /** The picked feature's distances to the face's edges, drawn as dimensions. */
  const dims = () => {
    const o = pick ? (listOf(pick.list)[pick.i] as (Item & { w?: number; h?: number; shape?: string }) | undefined) : undefined;
    if (!o || o.face !== face || drag) return null;
    let w = o.w ?? 0, h = o.h ?? 0;
    if (pick!.list === 'labels') { const st = labelStrokes(o as Label, s.print.nozzle); w = st.w; h = st.h; }
    if (o.shape === 'circle') h = w;
    const x0 = o.x - w / 2, x1 = o.x + w / 2, y0 = o.y - h / 2, y1 = o.y + h / 2;
    const tick = 3 / ppm;
    const dim = (key: string, ax: number, ay: number, bx: number, by: number, v: number) => {
      if (v <= 0.05) return null;
      const A = { x: X(ax), y: Y(ay) }, B = { x: X(bx), y: Y(by) }, vert = Math.abs(A.x - B.x) < 1e-9;
      const ends = vert ? [`M ${A.x - tick} ${A.y} H ${A.x + tick}`, `M ${B.x - tick} ${B.y} H ${B.x + tick}`] : [`M ${A.x} ${A.y - tick} V ${A.y + tick}`, `M ${B.x} ${B.y - tick} V ${B.y + tick}`];
      return <g key={key} class="encf-dim"><path d={`M ${A.x} ${A.y} L ${B.x} ${B.y} ${ends.join(' ')}`} /><text x={(A.x + B.x) / 2 + (vert ? 3 / ppm : 0)} y={(A.y + B.y) / 2 - (vert ? -3.5 / ppm : 3 / ppm)} text-anchor={vert ? 'start' : 'middle'}>{fmt(v)}</text></g>;
    };
    return <g aria-hidden="true">{[
      dim('l', -half, o.y, x0, o.y, x0 + half), dim('r', x1, o.y, half, o.y, half - x1),
      dim('b', o.x, lo, o.x, y0, y0 - lo), dim('t', o.x, y1, o.x, hi, hi - y1),
    ]}</g>;
  };
  /** Rulers along the view's top and left, in the face's millimetres. */
  const rulers = () => {
    const band = 16 / ppm, out: preact.JSX.Element[] = [];
    for (let x = Math.ceil(vis.x0 / major) * major; x <= vis.x1; x += major) out.push(<g key={`rx${x}`}><line x1={x} x2={x} y1={vis.y0 + band * 0.55} y2={vis.y0 + band} /><text x={x + 2 / ppm} y={vis.y0 + band * 0.62}>{fmt(x * mirror)}</text></g>);
    for (let y = Math.ceil(vis.y0 / major) * major; y <= vis.y1; y += major) out.push(<g key={`ry${y}`}><line x1={vis.x0 + band * 0.55} x2={vis.x0 + band} y1={y} y2={y} /><text x={vis.x0 + 2 / ppm} y={y - 2 / ppm}>{fmt(-y)}</text></g>);
    return <g class="encf-ruler" aria-hidden="true"><rect x={vis.x0} y={vis.y0} width={vis.x1 - vis.x0} height={band} /><rect x={vis.x0} y={vis.y0} width={band} height={vis.y1 - vis.y0} />{out}</g>;
  };

  return (
    <div class="encf" aria-label={`${FACE_NAME[face]} face`}>
      <div class="encf-bar" role="toolbar" aria-label="Face">
        <span class="ex-seg encf-faces" role="radiogroup" aria-label="Face">
          {[...WALLS, 'top' as const, 'bottom' as const].map((f) => <button key={f} type="button" role="radio" aria-checked={f === face} class={f === face ? 'on' : ''} onClick={() => { setFace(f); setPick(null); setPart(null); }}>{FACE_NAME[f]}</button>)}
        </span>
        {picked && <button type="button" class="ex-chip-btn" onClick={() => add('openings', openingFor(picked, face, g, s.openings.length + 1))}>Opening for {picked.name}</button>}
        <span class="muted small encf-at">{at ? `${at.x.toFixed(1)}, ${at.y.toFixed(1)} mm` : placing ? `${toolName}: click the face to place it` : wall ? 'Seen from outside: along the wall from its middle, up from the board\'s top' : face === 'top' ? 'Seen from above, from the board\'s middle' : 'Seen from below, from the board\'s middle'}</span>
      </div>
      <svg ref={svg} class={`encf-svg${placing ? ' placing' : ''}${pan.current?.moved ? ' panning' : ''}`} viewBox={vb} font-size={11 / ppm} preserveAspectRatio="xMidYMid meet"
        onPointerMove={(e) => {
          const pe = e as unknown as PointerEvent, pn = pan.current;
          if (pn) {
            const dx = pe.clientX - pn.sx, dy = pe.clientY - pn.sy;
            if (pn.moved || Math.hypot(dx, dy) > 3) { pn.moved = true; setZoom({ k: zoom.k, cx: pn.cx - dx / ppm, cy: pn.cy - dy / ppm }); }
            return;
          }
          move(pe);
          if (placing && !drag) { const q = toFace(pe); setHover(q ? snapPt(q, pe.shiftKey) : null); }
        }}
        onPointerUp={(e) => { const pn = pan.current; pan.current = null; if (pn && !pn.moved && (e as unknown as PointerEvent).button === 0) { setPick(null); setPart(null); } up(); }}
        onPointerLeave={() => { setAt(null); setHover(null); if (placing) setGuides({ x: null, y: null }); }}
        onWheel={(e) => wheel(e as unknown as WheelEvent)}
        onDblClick={(e) => { if (e.target === svg.current) setZoom({ k: 1, cx: 0, cy: 0 }); }}
        onPointerDown={(e) => {
          const pe = e as unknown as PointerEvent;
          if (placing && pe.button === 0) { const q = toFace(pe); if (q) place(face, snapPt(q, pe.shiftKey)); return; }
          // Dragging the background (or with the middle button anywhere) moves the view; a click there drops the pick
          if (pe.button === 0 || pe.button === 1) { pan.current = { sx: pe.clientX, sy: pe.clientY, cx: zoom.cx, cy: zoom.cy, moved: false }; (e.currentTarget as Element).setPointerCapture?.(pe.pointerId); }
        }}>
        {wall ? (() => {
          const f = g.sides[face as Side], bw = face === 'S' || face === 'N' ? facts.w : facts.h;
          const line = (v: number, cls: string, label: string) => <g class={cls}><line x1={-half} x2={half} y1={Y(v)} y2={Y(v)} /><text x={half + 0.6} y={Y(v) + 0.6}>{label}</text></g>;
          return <>
            <rect class="encf-face" x={-half} y={Y(hi)} width={2 * half} height={hi - lo} />
            {/* The corners: not flat, openings there are clipped */}
            <rect class="encf-corner" x={-half} y={Y(hi)} width={half - f.len / 2} height={hi - lo} />
            <rect class="encf-corner" x={f.len / 2} y={Y(hi)} width={half - f.len / 2} height={hi - lo} />
            {line(g.floorTop - g.boardTop, 'encf-line', 'floor')}
            {line(g.rim - g.boardTop, 'encf-line', g.flatLid ? 'lid' : 'top')}
            {!g.flatLid && line(g.joint - g.boardTop, 'encf-joint', 'joint')}
            <rect class="encf-board" x={-bw / 2} y={Y(0)} width={bw} height={facts.thickness} />
          </>;
        })() : <>
          <path class="encf-face" d={rrectPath(g.ox, g.oy, g.ro)} />
          <path class="encf-cavity" d={rrectPath(g.ix, g.iy, g.ri)} />
          <rect class="encf-board" x={-facts.w / 2} y={-facts.h / 2} width={facts.w} height={facts.h} />
          {g.standoffs.map((p, i) => <circle key={`s${i}`} class="encf-standoff" cx={X(p.x)} cy={Y(p.y)} r={Math.max(1.5, p.d / 2 + 1)} />)}
          {(g.screws?.at ?? []).map((p, i) => <circle key={`c${i}`} class="encf-screw" cx={X(p.x)} cy={Y(p.y)} r={g.screws!.boss / 2} />)}
          {face === 'top' && g.clamps.map((p, i) => <circle key={`p${i}`} class="encf-post" cx={X(p.x)} cy={Y(p.y)} r={p.r} />)}
          {face === 'bottom' && s.keyholes > 0 && (() => { const kh = keyholeLayout(Math.max(4, s.keyholes), g); return kh.at.map((p, i) => <g key={`k${i}`} class="encf-keyhole">
            <circle cx={X(p.x)} cy={Y(p.y)} r={kh.r} /><rect x={X(p.x) - kh.slot / 2} y={Y(p.y + kh.travel + kh.slot / 2)} width={kh.slot} height={kh.travel + kh.slot} rx={kh.slot / 2} />
          </g>); })()}
        </>}
        {/* The grid over the face: every step from the face's middle (and the board's top on a wall) */}
        <g class="encf-grid" aria-hidden="true">
          {Array.from({ length: Math.floor((vis.x1 - vis.x0) / minor) + 2 }, (_, k) => Math.floor(vis.x0 / minor) * minor + k * minor).map((x) => <line key={`gx${x}`} class={Math.abs(x / major - Math.round(x / major)) < 1e-6 ? 'major' : ''} x1={x} x2={x} y1={vis.y0} y2={vis.y1} />)}
          {Array.from({ length: Math.floor((vis.y1 - vis.y0) / minor) + 2 }, (_, k) => Math.floor(vis.y0 / minor) * minor + k * minor).map((y) => <line key={`gy${y}`} class={Math.abs(y / major - Math.round(y / major)) < 1e-6 ? 'major' : ''} x1={vis.x0} x2={vis.x1} y1={y} y2={y} />)}
        </g>
        {parts.map(({ p, x0, x1, y0, y1, near }) => (
          <g key={p.name} class={`encf-part${part === p.name ? ' sel' : ''}`} style={{ opacity: near }}
            onPointerDown={(e) => { if (placing) return; e.stopPropagation(); setPart(p.name); setPick(null); }}
            onDblClick={(e) => { e.stopPropagation(); add('openings', openingFor(p, face, g, s.openings.length + 1)); }}>
            <rect x={Math.min(X(x0), X(x1))} y={Y(y1)} width={Math.abs(x1 - x0)} height={y1 - y0} />
            {Math.abs(x1 - x0) > 3 && <text x={X((x0 + x1) / 2)} y={Y((y0 + y1) / 2) + 0.7}>{p.name}</text>}
          </g>
        ))}
        {s.vents.map((v, i) => {
          if (v.face !== face) return null;
          const vc = ventCells(v, s);
          const hexPts = (cx: number, cy: number) => Array.from({ length: 6 }, (_, k) => { const a = ((vc.pointUp ? 30 : 0) + k * 60) * Math.PI / 180; return `${X(cx + vc.r * Math.cos(a))},${Y(cy + vc.r * Math.sin(a))}`; }).join(' ');
          return (
            <g key={`v${i}`} class={`encf-vent${isSel('vents', i) ? ' sel' : ''}${v.on ? '' : ' off'}`}>
              <rect class="encf-patch" x={Math.min(X(v.x - v.w / 2), X(v.x + v.w / 2))} y={Y(v.y + v.h / 2)} width={v.w} height={v.h} onPointerDown={(e) => down(e as unknown as PointerEvent, 'vents', i, 'move')} />
              {vc.cells.map((c, k) => vc.kind === 'slot' ? <line key={k} class="encf-cell slot" x1={X(c.x)} y1={Y(c.y)} x2={X(c.x2!)} y2={Y(c.y2!)} stroke-width={vc.r * 2} />
                : vc.kind === 'hex' ? <polygon key={k} class="encf-cell" points={hexPts(c.x, c.y)} /> : <circle key={k} class="encf-cell" cx={X(c.x)} cy={Y(c.y)} r={vc.r} />)}
              {isSel('vents', i) && handles('vents', v, i)}
            </g>
          );
        })}
        {s.labels.map((l, i) => {
          if (l.face !== face) return null;
          const st = labelStrokes(l, s.print.nozzle);
          return (
            <g key={`l${i}`} class={`encf-label${isSel('labels', i) ? ' sel' : ''}${l.on ? '' : ' off'}${l.through ? ' through' : l.raised ? ' raised' : ''}`} onPointerDown={(e) => down(e as unknown as PointerEvent, 'labels', i, 'move')}>
              <rect class="encf-labelbox" x={X(l.x) - st.w / 2} y={Y(l.y) - st.h / 2} width={st.w} height={st.h} />
              {l.logo ? logoPaths(l).map((p, k) => <path key={k} class={p.knock ? 'encf-logo knock' : 'encf-logo'} d={p.d} fill-rule={p.rule} transform={`translate(${X(l.x)} ${Y(l.y)}) scale(1 -1)`} style={l.colour && !l.through && !p.knock ? { fill: l.colour } : undefined} />)
                : <path class="encf-text" d={st.lines.map((ln) => ln.map((p, k) => `${k ? 'L' : 'M'} ${X(l.x) + p.x} ${Y(l.y + p.y)}`).join(' ')).join(' ')} stroke-width={st.width} style={l.colour && !l.through ? { stroke: l.colour } : undefined} />}
            </g>
          );
        })}
        {s.openings.map((o, i) => o.face !== face ? null : (
          <g key={i} class={`encf-open${isSel('openings', i) ? ' sel' : ''}${o.on ? '' : ' off'}${o.depth ? ' recess' : ''}${wall && Math.abs(o.x) + o.w / 2 > g.sides[face as Side].len / 2 ? ' corner' : ''}`}>
            {o.open && !o.depth && wall && o.y + o.h / 2 < g.joint - g.boardTop && <rect class="encf-slot" x={X(o.x) - o.w / 2} y={Y(g.joint - g.boardTop)} width={o.w} height={g.joint - g.boardTop - (o.y + o.h / 2)} />}
            {o.shape === 'circle' && o.sink && !o.depth && <circle class="encf-sink" cx={X(o.x)} cy={Y(o.y)} r={o.sink.d / 2} />}
            <path d={shapePath(o, wall && s.print.teardrops && !o.depth)} transform={`translate(${X(o.x)} ${Y(o.y)}) scale(${mirror} -1)`} onPointerDown={(e) => down(e as unknown as PointerEvent, 'openings', i, 'move')} />
            <text x={X(o.x)} y={Y(o.y + (o.shape === 'circle' ? o.w : o.h) / 2) - 0.8}>{o.name}</text>
            {isSel('openings', i) && handles('openings', o, i)}
          </g>
        ))}
        {s.adds.map((a, i) => a.face !== face ? null : (
          <g key={`a${i}`} class={`encf-add ${a.side}${isSel('adds', i) ? ' sel' : ''}${a.on ? '' : ' off'}`}>
            <path d={shapePath(a, false)} transform={`translate(${X(a.x)} ${Y(a.y)}) scale(${mirror} -1)`} onPointerDown={(e) => down(e as unknown as PointerEvent, 'adds', i, 'move')} />
            {a.hole > 0 && <circle class="encf-addhole" cx={X(a.x)} cy={Y(a.y)} r={a.hole / 2} />}
            <text x={X(a.x)} y={Y(a.y + (a.shape === 'circle' ? a.w : a.h) / 2) - 0.8}>{a.name}</text>
            {isSel('adds', i) && handles('adds', a, i)}
          </g>
        ))}
        {dims()}
        {placing && hover && !drag && ghost(hover)}
        {guides.x !== null && <line class="encf-guide" x1={guides.x} x2={guides.x} y1={vis.y0} y2={vis.y1} />}
        {guides.y !== null && <line class="encf-guide" x1={vis.x0} x2={vis.x1} y1={guides.y} y2={guides.y} />}
        {rulers()}
      </svg>
    </div>
  );
}
