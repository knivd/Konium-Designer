/**
 * A diagram's cells drawn as the format defines them: its built-in shapes (geometry after the format's own
 * shapes, with their size, direction, rounding, flips and rotation), fills with gradients, lines
 * with their patterns, shadows, labels placed and wrapped as the format places them, and connectors
 * with their markers (the format's arrow heads), flex arrows and links.
 */
import type { ComponentChildren } from 'preact';
import { labelPoint, labelSource, labelText, Style, type Cell, type P, type Rect } from '../../formats/drawio';
import { layoutRich, parseHtml, type RunStyle } from './richtext';
import { fitStencil, readStencil, type Stencil } from '../../formats/stencil';

/* ─── Styles: the cell's own, else the format's named styles, else the defaults ─── */

/** The format's stylesheet: what a leading name (text, swimlane, ellipse …) brings. */
const SHEET: Record<string, Record<string, string>> = {
  text: { fillColor: 'none', strokeColor: 'none', align: 'left', verticalAlign: 'top' },
  edgeLabel: { fillColor: 'none', strokeColor: 'none', labelBackgroundColor: '#ffffff', fontSize: '11' },
  label: { fontStyle: '1', align: 'left', verticalAlign: 'middle', spacing: '2', spacingLeft: '52', rounded: '1' },
  swimlane: { fontStyle: '1', startSize: '23' },
  group: { fillColor: 'none', strokeColor: 'none', verticalAlign: 'top' },
  line: { strokeWidth: '4', verticalAlign: 'top', spacingTop: '8', labelBackgroundColor: '#ffffff' },
  image: { verticalLabelPosition: 'bottom', verticalAlign: 'top', labelBackgroundColor: '#ffffff' },
};
/** A style key: the cell's, else its named styles', else undefined. */
export function look(s: Style, k: string): string | undefined {
  const v = s.get(k);
  if (v !== undefined) return v;
  for (const [n, x] of s.parts) if (x === null && SHEET[n]?.[k] !== undefined) return SHEET[n]![k];
  return undefined;
}
export const num = (s: Style, k: string, def: number): number => { const v = look(s, k); const n = v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : def; };
const on = (s: Style, k: string, def = false) => { const v = look(s, k); return v === undefined ? def : v === '1' || v === 'true'; };

/** A colour as SVG takes it ('default' and unset: the default; 'none' stays). */
export function hex(v: string | undefined, def: string): string {
  if (!v || v === 'default') return def;
  if (v === 'none') return 'none';
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}
/** A line's dashes: dashed=1 with its dashPattern (3 3 by default), times the line width unless fixDash. */
export function dashes(s: Style, sw: number): string | undefined {
  if (!on(s, 'dashed')) return undefined;
  const pat = (look(s, 'dashPattern') ?? '3 3').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (!pat.length) return undefined;
  const k = on(s, 'fixDash') ? 1 : sw;
  return pat.map((n) => n * k).join(' ');
}
const opacity = (s: Style, k: string) => { const v = look(s, k); return v === undefined ? undefined : Math.max(0, Math.min(100, Number(v))) / 100; };

/* ─── Text ─── */

export const fontOf = (s: Style) => `${look(s, 'fontFamily') ?? 'Helvetica'}, Arial, sans-serif`;
let measureCtx: CanvasRenderingContext2D | null | undefined;
export function measure(text: string, size: number, bold: boolean, family = 'Helvetica, Arial, sans-serif'): number {
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!measureCtx) return text.length * size * 0.55;
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px ${family}`;
  return measureCtx.measureText(text).width;
}
/** Lines of a label, wrapped to a width (whiteSpace=wrap). */
export function wrap(text: string, width: number, size: number, bold: boolean, family?: string): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!isFinite(width) || width <= 0) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (line && measure(t, size, bold, family) > width) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** Where a cell's label goes: its box (outside the shape by labelPosition / verticalLabelPosition; a container's header). */
export function labelBox(s: Style, r: Rect): Rect {
  const lp = look(s, 'labelPosition'), vlp = look(s, 'verticalLabelPosition');
  let box: Rect = { x: lp === 'left' ? r.x - r.w : lp === 'right' ? r.x + r.w : r.x, y: vlp === 'top' ? r.y - r.h : vlp === 'bottom' ? r.y + r.h : r.y, w: r.w, h: r.h };
  if (s.shape() === 'swimlane') {
    const head = num(s, 'startSize', 23);
    box = look(s, 'horizontal') === '0' ? { x: r.x, y: r.y, w: head, h: r.h } : { x: r.x, y: r.y, w: r.w, h: head };
  }
  return box;
}

/** A label: its alignment, spacing, wrapping, font, colours, its background and border. */
export function Label({ s, r, text, edge, raw }: { s: Style; r: Rect; text: string; edge?: boolean; raw?: string }) {
  if (!text || on(s, 'noLabel')) return null;
  if (raw !== undefined && look(s, 'html') === '1' && /[<&]/.test(raw)) return <RichLabel s={s} r={r} raw={raw} edge={edge} />;
  const size = num(s, 'fontSize', edge ? 11 : 12);
  const fs = num(s, 'fontStyle', 0);
  const bold = (fs & 1) !== 0;
  const family = fontOf(s);
  const swim = s.shape() === 'swimlane';
  const vertical = look(s, 'horizontal') === '0';
  let box = labelBox(s, r);
  // Text running upwards: laid out in the box turned a quarter
  if (vertical) box = { x: box.x + box.w / 2 - box.h / 2, y: box.y + box.h / 2 - box.w / 2, w: box.h, h: box.w };
  const sp = num(s, 'spacing', 2);
  const inner = { x: box.x + sp + num(s, 'spacingLeft', 0), y: box.y + sp + num(s, 'spacingTop', 0) };
  const iw = box.w - 2 * sp - num(s, 'spacingLeft', 0) - num(s, 'spacingRight', 0), ih = box.h - 2 * sp - num(s, 'spacingTop', 0) - num(s, 'spacingBottom', 0);
  const lines = look(s, 'whiteSpace') === 'wrap' && !edge ? wrap(text, iw, size, bold, family) : text.split('\n');
  const align = look(s, 'align') ?? 'center', va = swim ? 'middle' : look(s, 'verticalAlign') ?? 'middle';
  const lh = size * 1.2, total = lines.length * lh;
  const x = align === 'left' ? inner.x : align === 'right' ? inner.x + iw : inner.x + iw / 2;
  const y0 = va === 'top' ? inner.y : va === 'bottom' ? inner.y + ih - total : inner.y + (ih - total) / 2;
  const bg = hex(look(s, 'labelBackgroundColor'), 'none'), border = hex(look(s, 'labelBorderColor'), 'none');
  const tw = (bg !== 'none' || border !== 'none') ? Math.max(...lines.map((l) => measure(l, size, bold, family))) : 0;
  const bx = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2;
  const deco = [(fs & 4) && 'underline', (fs & 8) && 'line-through'].filter(Boolean).join(' ') || undefined;
  const turn = vertical ? `rotate(-90 ${box.x + box.w / 2} ${box.y + box.h / 2})` : undefined;
  return (
    <g class="dg-text" pointer-events="none" transform={turn} opacity={opacity(s, 'textOpacity')}>
      {(bg !== 'none' || border !== 'none') && <rect x={bx - 1} y={y0} width={tw + 2} height={total} fill={bg} stroke={border} />}
      <text x={x} font-size={size} font-family={family} fill={hex(look(s, 'fontColor'), '#000000')} font-weight={bold ? 'bold' : undefined}
        font-style={fs & 2 ? 'italic' : undefined} text-decoration={deco} text-anchor={align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'}>
        {lines.map((l, i) => <tspan key={i} x={x} y={y0 + (i + 0.8) * lh}>{l || ' '}</tspan>)}
      </text>
    </g>
  );
}

/** The label's own font, as a formatted label's text starts. */
function baseRun(s: Style, edge?: boolean): RunStyle {
  const fs = num(s, 'fontStyle', 0);
  return { bold: (fs & 1) !== 0, italic: (fs & 2) !== 0, underline: (fs & 4) !== 0, strike: (fs & 8) !== 0, size: num(s, 'fontSize', edge ? 11 : 12), colour: hex(look(s, 'fontColor'), '#000000'), family: look(s, 'fontFamily') ?? 'Helvetica', shift: 0 };
}
const runFont = (st: RunStyle) => `${st.family}, Arial, sans-serif`;
const measureRun = (t: string, st: RunStyle) => measure(t, st.size, st.bold, runFont(st));
/** Formatted lines drawn from the top left of a box `w` wide (their alignment within it). */
function RichLines({ lines, x, y, w }: { lines: ReturnType<typeof layoutRich>['lines']; x: number; y: number; w: number }) {
  return (
    <>
      {lines.map((ln, i) => {
        const room = w - ln.x0;
        const lx = x + ln.x0 + (ln.align === 'center' ? (room - ln.w) / 2 : ln.align === 'right' ? room - ln.w : 0);
        return ln.segs.filter((g) => g.text).map((g, k) => {
          const deco = [g.st.underline && 'underline', g.st.strike && 'line-through'].filter(Boolean).join(' ') || undefined;
          const dy = g.st.shift === 1 ? -ln.h * 0.3 : g.st.shift === -1 ? ln.h * 0.15 : 0;
          return <text key={`${i}-${k}`} x={lx + g.x} y={y + ln.y + ln.base + dy} font-size={g.st.size} font-family={runFont(g.st)} font-weight={g.st.bold ? 'bold' : undefined} font-style={g.st.italic ? 'italic' : undefined}
            text-decoration={deco} fill={g.st.colour} xml:space="preserve" style={{ whiteSpace: 'pre' }}>{g.text}</text>;
        });
      })}
    </>
  );
}
/** A formatted label (html=1): its HTML read, laid out (wrapped when whiteSpace=wrap) and placed as a plain one is. */
export function RichLabel({ s, r, raw, edge, at }: { s: Style; r: Rect; raw: string; edge?: boolean; at?: P }) {
  const base = baseRun(s, edge);
  const blocks = parseHtml(raw, base);
  const align = look(s, 'align') ?? 'center', va = look(s, 'verticalAlign') ?? 'middle';
  const bg = hex(look(s, 'labelBackgroundColor'), edge ? '#ffffff' : 'none'), border = hex(look(s, 'labelBorderColor'), 'none');
  if (at) {
    // On a connector: centred on its point, not wrapped
    const lay = layoutRich(blocks, Infinity, align, measureRun);
    const x = at.x - lay.w / 2, y = at.y - lay.h / 2;
    return <g class="dg-text" pointer-events="none">{(bg !== 'none' || border !== 'none') && <rect x={x - 2} y={y} width={lay.w + 4} height={lay.h} fill={bg} stroke={border} />}<RichLines lines={lay.lines} x={x} y={y} w={lay.w} /></g>;
  }
  const box = labelBox(s, r);
  const sp = num(s, 'spacing', 2);
  const ix = box.x + sp + num(s, 'spacingLeft', 0), iy = box.y + sp + num(s, 'spacingTop', 0);
  const iw = box.w - 2 * sp - num(s, 'spacingLeft', 0) - num(s, 'spacingRight', 0), ih = box.h - 2 * sp - num(s, 'spacingTop', 0) - num(s, 'spacingBottom', 0);
  const lay = layoutRich(blocks, look(s, 'whiteSpace') === 'wrap' ? iw : Infinity, align, measureRun);
  const y0 = va === 'top' ? iy : va === 'bottom' ? iy + ih - lay.h : iy + (ih - lay.h) / 2;
  const tw = Math.max(lay.w, 0);
  const bx = align === 'left' ? ix : align === 'right' ? ix + iw - tw : ix + (iw - tw) / 2;
  const clipped = look(s, 'overflow') === 'hidden';
  const cid = clipped ? `dg-clip-${Math.round(r.x)}-${Math.round(r.y)}-${Math.round(r.w)}-${Math.round(r.h)}` : undefined;
  return (
    <g class="dg-text" pointer-events="none" opacity={opacity(s, 'textOpacity')} clip-path={cid ? `url(#${cid})` : undefined}>
      {cid && <defs><clipPath id={cid}><rect x={r.x} y={r.y} width={r.w} height={r.h} /></clipPath></defs>}
      {(bg !== 'none' || border !== 'none') && <rect x={bx - 1} y={y0} width={tw + 2} height={lay.h} fill={bg} stroke={border} />}
      <RichLines lines={lay.lines} x={ix} y={y0} w={iw} />
    </g>
  );
}

/* ─── Shapes ─── */

type Pt = [number, number];
/** A shape's pieces in its own frame (0,0 to w,h): filled and lined, lined only, or a shade. */
export interface Part { d: string; kind: 'body' | 'line' | 'shade'; alpha?: number; fill?: string }
const f2 = (v: number) => Math.round(v * 100) / 100;
/** A closed (or open) polygon; rounded corners (arcSize / 2) when r > 0. */
function poly(pts: Pt[], close = true, r = 0): string {
  if (!r || pts.length < 3) return `M${pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(' L')}${close ? ' Z' : ''}`;
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n]!;
  const toward = (a: Pt, b: Pt, d: number): Pt => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [a[0] + ((b[0] - a[0]) * d) / l, a[1] + ((b[1] - a[1]) * d) / l]; };
  const seg = (i: number) => Math.hypot(at(i + 1)[0] - at(i)[0], at(i + 1)[1] - at(i)[1]);
  let d = '';
  const first = close ? 0 : 1, last = close ? n : n - 1;
  if (!close) d = `M${f2(pts[0]![0])},${f2(pts[0]![1])}`;
  for (let i = first; i < last; i++) {
    const c = at(i), k = Math.min(r, seg(i - 1) / 2, seg(i) / 2);
    const a = toward(c, at(i - 1), k), b = toward(c, at(i + 1), k);
    d += `${d ? ' L' : 'M'}${f2(a[0])},${f2(a[1])} Q${f2(c[0])},${f2(c[1])} ${f2(b[0])},${f2(b[1])}`;
  }
  if (!close) d += ` L${f2(pts[n - 1]![0])},${f2(pts[n - 1]![1])}`;
  return d + (close ? ' Z' : '');
}
const ellipsePath = (x: number, y: number, w: number, h: number) => `M${f2(x)},${f2(y + h / 2)} A${f2(w / 2)},${f2(h / 2)} 0 1 1 ${f2(x + w)},${f2(y + h / 2)} A${f2(w / 2)},${f2(h / 2)} 0 1 1 ${f2(x)},${f2(y + h / 2)} Z`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The built-in shapes Konium draws (others: from a stencil library, drawn as their box). */
export const BUILT_IN = new Set(['rectangle', 'label', 'text', 'edgeLabel', 'group', 'ellipse', 'doubleEllipse', 'rhombus', 'triangle', 'hexagon', 'parallelogram', 'trapezoid', 'step', 'process', 'cylinder', 'cylinder3', 'cloud',
  'document', 'internalStorage', 'cube', 'tape', 'note', 'card', 'callout', 'umlActor', 'xor', 'or', 'dataStorage', 'swimlane', 'offPageConnector', 'delay', 'manualInput', 'display', 'loopLimit',
  'singleArrow', 'doubleArrow', 'cross', 'corner', 'tee', 'line', 'image', 'partialRectangle', 'tableRow', 'table', 'waypoint']);

/** A built-in shape's pieces (null: not built in). */
export function outline(shape: string, w: number, h: number, s: Style): Part[] | null {
  const rr = on(s, 'rounded') ? num(s, 'arcSize', 20) / 2 : 0;
  const body = (d: string, fill?: string): Part => ({ d, kind: 'body', ...(fill ? { fill } : {}) });
  const line = (d: string): Part => ({ d, kind: 'line' });
  const P = (pts: Pt[]) => body(poly(pts, true, rr));
  const fixed = on(s, 'fixedSize');
  /** The shape's size: a fraction of the side (or, fixedSize, a length) */
  const size = (def: number, fixedDef: number, along: number, max = along) => (fixed ? clamp(num(s, 'size', fixedDef), 0, max) : along * clamp(num(s, 'size', def), 0, 1));
  const dark = (key: string, def: number) => num(s, key, def);
  switch (shape) {
    case 'rectangle': case 'label': case 'tableRow': case 'table': {
      const r = on(s, 'rounded') ? (on(s, 'absoluteArcSize') ? Math.min(w / 2, h / 2, num(s, 'arcSize', 20) / 2) : Math.min(w, h) * (num(s, 'arcSize', 15) / 100)) : 0;
      return [body(r ? `M${r},0 H${f2(w - r)} Q${w},0 ${w},${r} V${f2(h - r)} Q${w},${h} ${f2(w - r)},${h} H${r} Q0,${h} 0,${f2(h - r)} V${r} Q0,0 ${r},0 Z` : `M0,0 H${f2(w)} V${f2(h)} H0 Z`)];
    }
    case 'ellipse': return [body(ellipsePath(0, 0, w, h))];
    case 'doubleEllipse': { const m = num(s, 'margin', Math.min(3 + num(s, 'strokeWidth', 1), Math.min(w / 5, h / 5))); return [body(ellipsePath(0, 0, w, h)), line(ellipsePath(m, m, w - 2 * m, h - 2 * m))]; }
    case 'rhombus': return [P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])];
    case 'triangle': return [P([[0, 0], [w, h / 2], [0, h]])];
    case 'hexagon': { const k = size(0.25, 20, w, w / 2); return [P([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]])]; }
    case 'parallelogram': { const k = size(0.2, 20, w); return [P([[0, h], [k, 0], [w, 0], [w - k, h]])]; }
    case 'trapezoid': { const k = size(0.2, 20, w, w / 2); return [P([[0, h], [k, 0], [w - k, 0], [w, h]])]; }
    case 'step': { const k = size(0.2, 20, w); return [P([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]])]; }
    case 'process': { const k = size(0.1, 20, w, w / 2); return [...outline('rectangle', w, h, s)!, line(`M${f2(k)},0 V${f2(h)} M${f2(w - k)},0 V${f2(h)}`)]; }
    case 'cylinder': case 'cylinder3': {
      const k = shape === 'cylinder3' ? Math.min(h / 2, num(s, 'size', 15)) : Math.min(40, Math.round(h / 5));
      return [body(`M0,${f2(k)} C0,${f2(-k / 3)} ${f2(w)},${f2(-k / 3)} ${f2(w)},${f2(k)} V${f2(h - k)} C${f2(w)},${f2(h + k / 3)} 0,${f2(h + k / 3)} 0,${f2(h - k)} Z`), line(`M0,${f2(k)} C0,${f2(2 * k)} ${f2(w)},${f2(2 * k)} ${f2(w)},${f2(k)}`)];
    }
    case 'cloud': {
      const X = (f: number) => f2(f * w), Y = (f: number) => f2(f * h);
      return [body(`M${X(0.25)},${Y(0.25)} C${X(0.05)},${Y(0.25)} 0,${Y(0.5)} ${X(0.16)},${Y(0.55)} C0,${Y(0.66)} ${X(0.18)},${Y(0.9)} ${X(0.31)},${Y(0.8)} C${X(0.4)},${f2(h)} ${X(0.7)},${f2(h)} ${X(0.8)},${Y(0.8)} C${f2(w)},${Y(0.8)} ${f2(w)},${Y(0.6)} ${X(0.875)},${Y(0.5)} C${f2(w)},${Y(0.3)} ${X(0.8)},${Y(0.1)} ${X(0.625)},${Y(0.2)} C${X(0.5)},${Y(0.05)} ${X(0.3)},${Y(0.05)} ${X(0.25)},${Y(0.25)} Z`)];
    }
    case 'document': {
      const dy = h * clamp(num(s, 'size', 0.3), 0, 1), fy = 1.4;
      return [body(`M0,0 H${f2(w)} V${f2(h - dy / 2)} Q${f2((w * 3) / 4)},${f2(h - dy * fy)} ${f2(w / 2)},${f2(h - dy / 2)} Q${f2(w / 4)},${f2(h - dy * (1 - fy))} 0,${f2(h - dy / 2)} Z`)];
    }
    case 'tape': {
      const dy = h * clamp(num(s, 'size', 0.4), 0, 1), fy = 1.4;
      return [body(`M0,${f2(dy / 2)} Q${f2(w / 4)},${f2(dy * fy)} ${f2(w / 2)},${f2(dy / 2)} Q${f2((w * 3) / 4)},${f2(dy * (1 - fy))} ${f2(w)},${f2(dy / 2)} V${f2(h - dy / 2)} Q${f2((w * 3) / 4)},${f2(h - dy * fy)} ${f2(w / 2)},${f2(h - dy / 2)} Q${f2(w / 4)},${f2(h - dy * (1 - fy))} 0,${f2(h - dy / 2)} Z`)];
    }
    case 'internalStorage': {
      const dx = clamp(num(s, 'dx', num(s, 'size', 10)), 0, w), dy = clamp(num(s, 'dy', num(s, 'size', 10)), 0, h);
      return [...outline('rectangle', w, h, s)!, line(`M${f2(dx)},0 V${f2(h)} M0,${f2(dy)} H${f2(w)}`)];
    }
    case 'cube': {
      const k = clamp(num(s, 'size', 20), 0, Math.min(w, h));
      return [body(poly([[k, 0], [w, 0], [w, h - k], [w - k, h], [0, h], [0, k]])),
        { d: poly([[0, k], [k, 0], [w, 0], [w - k, k]]), kind: 'shade', alpha: dark('darkOpacity', 0) }, { d: poly([[w - k, k], [w, 0], [w, h - k], [w - k, h]]), kind: 'shade', alpha: dark('darkOpacity2', 0) },
        line(`M0,${f2(k)} H${f2(w - k)} L${f2(w)},0 M${f2(w - k)},${f2(k)} V${f2(h)}`)];
    }
    case 'note': {
      const k = clamp(num(s, 'size', 30), 0, Math.min(w, h));
      return [body(poly([[0, 0], [w - k, 0], [w, k], [w, h], [0, h]], true, rr)), { d: poly([[w - k, 0], [w - k, k], [w, k]]), kind: 'shade', alpha: dark('darkOpacity', 0) }, line(`M${f2(w - k)},0 V${f2(k)} H${f2(w)}`)];
    }
    case 'card': { const k = clamp(num(s, 'size', 30), 0, Math.min(w, h)); return [P([[k, 0], [w, 0], [w, h], [0, h], [0, k]])]; }
    case 'callout': {
      const k = clamp(num(s, 'size', 30), 0, h), dx = w * clamp(num(s, 'position', 0.5), 0, 1), dx2 = w * clamp(num(s, 'position2', 0.5), 0, 1), base = clamp(num(s, 'base', 20), 0, w);
      return [P([[0, 0], [w, 0], [w, h - k], [Math.min(w, dx + base), h - k], [dx2, h], [Math.max(0, dx), h - k], [0, h - k]])];
    }
    case 'umlActor':
      return [body(ellipsePath(w / 4, 0, w / 2, h / 4)), line(`M${f2(w / 2)},${f2(h / 4)} V${f2((2 * h) / 3)} M0,${f2(h / 3)} H${f2(w)} M${f2(w / 2)},${f2((2 * h) / 3)} L0,${f2(h)} M${f2(w / 2)},${f2((2 * h) / 3)} L${f2(w)},${f2(h)}`)];
    case 'xor': return [body(`M0,0 Q${f2(w)},0 ${f2(w)},${f2(h / 2)} Q${f2(w)},${f2(h)} 0,${f2(h)} Q${f2(w / 2)},${f2(h / 2)} 0,0 Z`)];
    case 'or': return [body(`M0,0 Q${f2(w)},0 ${f2(w)},${f2(h / 2)} Q${f2(w)},${f2(h)} 0,${f2(h)} Z`)];
    case 'dataStorage': { const k = size(0.1, 20, w); return [body(`M${f2(k)},0 H${f2(w)} Q${f2(w - 2 * k)},${f2(h / 2)} ${f2(w)},${f2(h)} H${f2(k)} Q${f2(-k)},${f2(h / 2)} ${f2(k)},0 Z`)]; }
    case 'offPageConnector': { const k = h * clamp(num(s, 'size', 3 / 8), 0, 1); return [P([[0, 0], [w, 0], [w, h - k], [w / 2, h], [0, h - k]])]; }
    case 'delay': return [body(`M0,0 H${f2(w / 2)} Q${f2(w)},0 ${f2(w)},${f2(h / 2)} Q${f2(w)},${f2(h)} ${f2(w / 2)},${f2(h)} H0 Z`)];
    case 'manualInput': { const k = clamp(num(s, 'size', 30), 0, h); return [P([[0, k], [w, 0], [w, h], [0, h]])]; }
    case 'display': { const k = w * clamp(num(s, 'size', 0.25), 0, 1); return [body(`M0,${f2(h / 2)} L${f2(k)},0 H${f2(w - k)} Q${f2(w)},0 ${f2(w)},${f2(h / 2)} Q${f2(w)},${f2(h)} ${f2(w - k)},${f2(h)} H${f2(k)} Z`)]; }
    case 'loopLimit': { const k = clamp(num(s, 'size', 20), 0, Math.min(w / 2, h)); return [P([[k, 0], [w - k, 0], [w, k], [w, h], [0, h], [0, k]])]; }
    case 'singleArrow': case 'doubleArrow': {
      const aw = h * clamp(num(s, 'arrowWidth', 0.3), 0, 1), as = w * clamp(num(s, 'arrowSize', 0.2), 0, 1), t = (h - aw) / 2, b = t + aw;
      return [P(shape === 'singleArrow' ? [[0, t], [w - as, t], [w - as, 0], [w, h / 2], [w - as, h], [w - as, b], [0, b]]
        : [[0, h / 2], [as, 0], [as, t], [w - as, t], [w - as, 0], [w, h / 2], [w - as, h], [w - as, b], [as, b], [as, h]])];
    }
    case 'cross': {
      const m = Math.min(w, h), k = clamp(m * num(s, 'size', 0.2), 0, m), t = (h - k) / 2, b = t + k, l = (w - k) / 2, r = l + k;
      return [P([[0, t], [l, t], [l, 0], [r, 0], [r, t], [w, t], [w, b], [r, b], [r, h], [l, h], [l, b], [0, b]])];
    }
    case 'corner': { const dx = clamp(num(s, 'dx', 20), 0, w), dy = clamp(num(s, 'dy', 20), 0, h); return [P([[0, 0], [w, 0], [w, dy], [dx, dy], [dx, h], [0, h]])]; }
    case 'tee': { const dx = clamp(num(s, 'dx', 20), 0, w), dy = clamp(num(s, 'dy', 20), 0, h); return [P([[0, 0], [w, 0], [w, dy], [(w + dx) / 2, dy], [(w + dx) / 2, h], [(w - dx) / 2, h], [(w - dx) / 2, dy], [0, dy]])]; }
    case 'line': return [line(`M0,${f2(h / 2)} H${f2(w)}`)];
    default: return null;
  }
}

/** A stencil drawn in a w × h box: its background filled and lined, then its foreground's steps, in the shape's colours unless it sets its own. */
export function stencilBody(st: Stencil, w: number, h: number, fill: string, stroke: string, sw: number, dash?: string): ComponentChildren[] {
  const t = fitStencil(st, 0, 0, w, h), k = Math.min(t.sx, t.sy);
  const out: ComponentChildren[] = [];
  let state = { fill, stroke, sw: st.strokewidth === 'inherit' ? sw : st.strokewidth * k, dash, font: '#000000', size: 12 };
  const saved: (typeof state)[] = [];
  let pending: string[] = [];
  const paint = (f: boolean, l: boolean) => {
    if (!pending.length) return;
    out.push(<path key={out.length} d={pending.join(' ')} fill={f ? state.fill : 'none'} stroke={l ? state.stroke : 'none'} stroke-width={state.sw} stroke-dasharray={state.dash} stroke-linejoin="round" stroke-linecap="round" />);
    pending = [];
  };
  const run = (ops: Stencil['background'], background: boolean) => {
    for (const o of ops) {
      if (o.k === 'path') pending.push(o.d(t));
      else if (o.k === 'paint') paint(o.fill, o.stroke);
      else if (o.k === 'strokecolor') state.stroke = o.c === 'none' ? 'none' : o.c;
      else if (o.k === 'fillcolor') state.fill = o.c === 'none' ? 'none' : o.c;
      else if (o.k === 'fontcolor') state.font = o.c;
      else if (o.k === 'strokewidth') state.sw = o.fixed ? o.w : o.w * k;
      else if (o.k === 'dashed') state.dash = o.on ? `${3 * state.sw} ${3 * state.sw}` : undefined;
      else if (o.k === 'fontsize') state.size = o.n;
      else if (o.k === 'save') saved.push({ ...state });
      else if (o.k === 'restore') state = saved.pop() ?? state;
      else if (o.k === 'text') out.push(<text key={out.length} x={f2(t.ox + o.x * t.sx)} y={f2(t.oy + o.y * t.sy)} font-size={state.size * k} font-family="Helvetica, Arial, sans-serif" fill={state.font} text-anchor={o.align === 'left' ? 'start' : o.align === 'right' ? 'end' : 'middle'} dominant-baseline={o.valign === 'top' ? 'hanging' : o.valign === 'bottom' ? 'auto' : 'central'}>{o.s}</text>);
    }
    if (background) paint(true, true); else pending = [];
  };
  run(st.background, true);
  run(st.foreground, false);
  return out;
}

/** The fill a shape takes: its colour, or its gradient (defined with it). */
function paint(s: Style, fill: string, id: string): { fill: string; def: ComponentChildren } {
  const g = hex(look(s, 'gradientColor'), 'none');
  if (fill === 'none' || g === 'none') return { fill, def: null };
  const dir = look(s, 'gradientDirection') ?? 'south';
  if (dir === 'radial') return { fill: `url(#${id})`, def: <radialGradient id={id}><stop offset="0" stop-color={fill} /><stop offset="1" stop-color={g} /></radialGradient> };
  const [x1, y1, x2, y2] = dir === 'north' ? [0, 1, 0, 0] : dir === 'east' ? [0, 0, 1, 0] : dir === 'west' ? [1, 0, 0, 0] : [0, 0, 0, 1];
  return { fill: `url(#${id})`, def: <linearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2}><stop offset="0" stop-color={fill} /><stop offset="1" stop-color={g} /></linearGradient> };
}

/** The shadow every view defines once (offset 2, 3; soft; a quarter black). */
export const shadowId = (uid: string) => `dg-shadow-${uid}`;
export const ShadowDef = ({ uid }: { uid: string }) => (
  <filter id={shadowId(uid)} x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="2" dy="3" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.25" /></filter>
);

/** A vertex: its shape (turned by its direction, flipped, rotated), its label. `uid` keeps its gradient's id apart. */
export function ShapeView({ c, r, uid, shadow = false, label = true }: { c: Pick<Cell, 'id' | 'style' | 'value'> & Partial<Cell>; r: Rect; uid: string; shadow?: boolean; label?: boolean }) {
  const s = c.style;
  const shape = s.shape();
  const text = label ? labelText(c as Cell) : '';
  const rot = num(s, 'rotation', 0);
  const turnAll = rot ? `rotate(${rot} ${f2(r.x + r.w / 2)} ${f2(r.y + r.h / 2)})` : undefined;
  if (shape === 'waypoint') return null;
  const textOnly = shape === 'text' || shape === 'edgeLabel';
  const sw = num(s, 'strokeWidth', 1);
  const fill0 = hex(look(s, 'fillColor'), textOnly || shape === 'group' ? 'none' : '#ffffff');
  const stroke = hex(look(s, 'strokeColor'), textOnly || shape === 'group' ? 'none' : '#000000');
  const gid = `dg-g-${uid}-${c.id}`;
  const { fill, def } = paint(s, fill0, gid);
  const filter = shadow || on(s, 'shadow') ? `url(#${shadowId(uid)})` : undefined;
  const lineProps = { stroke, 'stroke-width': sw, 'stroke-dasharray': dashes(s, sw), 'stroke-opacity': opacity(s, 'strokeOpacity'), 'stroke-linejoin': 'round' as const };
  let body: ComponentChildren = null;
  if (shape === 'image') {
    // A picture in the file (data:) is drawn; one from the web isn't fetched: its box
    const src = (look(s, 'image') ?? '').replace(/,(?=[A-Za-z0-9+/]+=*$)/, ';base64,').replace(/^data:image\/([a-z+]+);base64;base64,/, 'data:image/$1;base64,');
    body = /^data:image\//.test(src) ? <image href={src} x={r.x} y={r.y} width={r.w} height={r.h} preserveAspectRatio="xMidYMid meet" /> : <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#f4f4f4" stroke="#bbbbbb" stroke-dasharray="4 3" />;
  } else if (shape === 'partialRectangle') {
    const side = (k: string) => look(s, k) !== '0';
    const { x, y, w, h } = r;
    body = <g>{fill !== 'none' && <rect x={x} y={y} width={w} height={h} fill={fill} stroke="none" />}{stroke !== 'none' && <path d={`${side('top') ? `M${x},${y} H${x + w}` : ''}${side('right') ? `M${x + w},${y} V${y + h}` : ''}${side('bottom') ? `M${x},${y + h} H${x + w}` : ''}${side('left') ? `M${x},${y} V${y + h}` : ''}`} fill="none" {...lineProps} />}</g>;
  } else if (shape === 'swimlane') {
    const head = num(s, 'startSize', 23), across = look(s, 'horizontal') !== '0';
    const { x, y, w, h } = r;
    const swFill = hex(look(s, 'swimlaneFillColor'), 'none');
    const rr = on(s, 'rounded') ? Math.min(w, h) * (num(s, 'arcSize', 15) / 100) : 0;
    body = (
      <g {...lineProps}>
        <rect x={x} y={y} width={w} height={h} rx={rr} fill={swFill} />
        {head > 0 && (across ? <rect x={x} y={y} width={w} height={Math.min(head, h)} rx={rr} fill={fill} /> : <rect x={x} y={y} width={Math.min(head, w)} height={h} rx={rr} fill={fill} />)}
        {head > 0 && look(s, 'swimlaneLine') !== '0' && <path d={across ? `M${x},${y + head} H${x + w}` : `M${x + head},${y} V${y + h}`} fill="none" />}
      </g>
    );
  } else if (!textOnly && shape !== 'group') {
    const dir = look(s, 'direction') ?? 'east';
    const turn = dir === 'south' ? 90 : dir === 'west' ? 180 : dir === 'north' ? 270 : 0;
    const swap = turn % 180 !== 0;
    const w = swap ? r.h : r.w, h = swap ? r.w : r.h;
    const st = shape.startsWith('stencil(') ? readStencil(shape) : null;
    const parts = st ? [] : outline(shape, w, h, s);
    if (st) {
      let t = `translate(${f2(r.x + r.w / 2)} ${f2(r.y + r.h / 2)})`;
      if (on(s, 'flipH')) t += ' scale(-1 1)';
      if (on(s, 'flipV')) t += ' scale(1 -1)';
      if (turn) t += ` rotate(${turn})`;
      t += ` translate(${f2(-w / 2)} ${f2(-h / 2)})`;
      body = <g transform={t}>{stencilBody(st, w, h, fill, stroke, sw, dashes(s, sw))}</g>;
    } else if (!parts) {
      // A stencil Konium doesn't draw yet: its box, dashed
      body = <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} stroke="#888888" stroke-dasharray="4 3" />;
    } else {
      let t = `translate(${f2(r.x + r.w / 2)} ${f2(r.y + r.h / 2)})`;
      if (on(s, 'flipH')) t += ' scale(-1 1)';
      if (on(s, 'flipV')) t += ' scale(1 -1)';
      if (turn) t += ` rotate(${turn})`;
      t += ` translate(${f2(-w / 2)} ${f2(-h / 2)})`;
      body = (
        <g transform={t}>
          {parts.map((p, i) => p.kind === 'shade'
            ? (p.alpha ? <path key={i} d={p.d} fill="#000000" fill-opacity={p.alpha} stroke="none" /> : null)
            : <path key={i} d={p.d} fill={p.kind === 'line' ? 'none' : p.fill ?? fill} fill-opacity={p.kind === 'body' ? opacity(s, 'fillOpacity') : undefined} {...lineProps} />)}
        </g>
      );
    }
  } else if (shape === 'group' && (fill !== 'none' || stroke !== 'none')) body = <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} {...lineProps} />;
  return (
    <g transform={turnAll} opacity={opacity(s, 'opacity')}>
      {def && <defs>{def}</defs>}
      {body && <g filter={filter}>{body}</g>}
      <Label s={s} r={r} text={text} raw={label ? labelSource(c as Cell) : undefined} />
    </g>
  );
}

/* ─── Connectors ─── */

/** The arrow heads, drawn pointing along +x with the tip at 0,0; `back`: how far the line stops short of the tip. */
export const MARKERS = ['none', 'classic', 'classicThin', 'block', 'blockThin', 'open', 'openThin', 'oval', 'diamond', 'diamondThin', 'box', 'circle', 'circlePlus', 'halfCircle', 'dash', 'cross',
  'async', 'openAsync', 'doubleBlock', 'ERone', 'ERmandOne', 'ERmany', 'ERoneToMany', 'ERzeroToOne', 'ERzeroToMany'] as const;
const NO_FILL = new Set(['open', 'openThin', 'openAsync', 'dash', 'cross', 'halfCircle', 'ERone', 'ERmandOne', 'ERmany', 'ERoneToMany', 'ERzeroToOne', 'ERzeroToMany']);
function marker(kind: string, size: number, sw: number, filled: boolean, colour: string): { el: ComponentChildren; back: number } {
  const L = size + sw, eo = sw * 1.118;
  const thin = /Thin$/.test(kind);
  const hw = L / (thin ? 3 : 2);
  const fill = filled && !NO_FILL.has(kind) ? colour : 'none';
  const p = { fill, stroke: colour, 'stroke-width': sw, 'stroke-linejoin': 'miter' as const };
  const ln = { fill: 'none', stroke: colour, 'stroke-width': sw };
  const tip = -eo;
  switch (kind) {
    case 'classic': case 'classicThin': return { el: <path d={`M${tip},0 L${tip - L},${-hw} L${tip - 0.75 * L},0 L${tip - L},${hw} Z`} {...p} />, back: 0.75 * L + eo };
    case 'block': case 'blockThin': return { el: <path d={`M${tip},0 L${tip - L},${-hw} L${tip - L},${hw} Z`} {...p} />, back: L + eo };
    case 'open': case 'openThin': return { el: <path d={`M${tip - L},${-hw} L${tip},0 L${tip - L},${hw}`} {...ln} />, back: eo };
    case 'oval': return { el: <circle cx={-size / 2} cy={0} r={size / 2} {...p} />, back: size };
    case 'diamond': case 'diamondThin': { const k = L / (kind === 'diamond' ? 2 : 3.4); return { el: <path d={`M${tip},0 L${tip - L / 2},${-k} L${tip - L},0 L${tip - L / 2},${k} Z`} {...p} />, back: L + eo }; }
    case 'box': return { el: <rect x={-L} y={-L / 2} width={L} height={L} {...p} />, back: L };
    case 'circle': return { el: <circle cx={-L / 2} cy={0} r={L / 2} {...p} />, back: L };
    case 'circlePlus': return { el: <g><circle cx={-L / 2} cy={0} r={L / 2} fill="none" stroke={colour} stroke-width={sw} /><path d={`M${-L},0 H0 M${-L / 2},${-L / 2} V${L / 2}`} {...ln} /></g>, back: L };
    case 'halfCircle': return { el: <path d={`M${-L / 2},${-L / 2} A${L / 2},${L / 2} 0 0 0 ${-L / 2},${L / 2}`} {...ln} />, back: 0 };
    case 'dash': return { el: <path d={`M${-L / 2},${hw} L${L / 2 - L / 2},${-hw}`} {...ln} />, back: 0 };
    case 'cross': return { el: <path d={`M${-L},${-hw} L0,${hw} M${-L},${hw} L0,${-hw}`} {...ln} />, back: 0 };
    case 'async': return { el: <path d={`M${tip},0 L${tip - L},${-hw} L${tip - L},0 Z`} {...p} />, back: L + eo };
    case 'openAsync': return { el: <path d={`M${tip - L},${-hw} L${tip},0`} {...ln} />, back: eo };
    case 'doubleBlock': return { el: <path d={`M${tip},0 L${tip - L},${-hw} L${tip - L},${hw} Z M${tip - L},0 L${tip - 2 * L},${-hw} L${tip - 2 * L},${hw} Z`} {...p} />, back: 2 * L + eo };
    case 'ERone': return { el: <path d={`M${-L},${-L / 2} V${L / 2}`} {...ln} />, back: 0 };
    case 'ERmandOne': return { el: <path d={`M${-L},${-L / 2} V${L / 2} M${-1.5 * L},${-L / 2} V${L / 2}`} {...ln} />, back: 0 };
    case 'ERmany': return { el: <path d={`M0,${-L / 2} L${-L},0 L0,${L / 2}`} {...ln} />, back: 0 };
    case 'ERoneToMany': return { el: <path d={`M0,${-L / 2} L${-L},0 L0,${L / 2} M${-1.5 * L},${-L / 2} V${L / 2}`} {...ln} />, back: 0 };
    case 'ERzeroToOne': return { el: <g><path d={`M${-L},${-L / 2} V${L / 2}`} {...ln} /><circle cx={-1.8 * L} cy={0} r={L / 2.5} fill="#ffffff" stroke={colour} stroke-width={sw} /></g>, back: 0 };
    case 'ERzeroToMany': return { el: <g><path d={`M0,${-L / 2} L${-L},0 L0,${L / 2}`} {...ln} /><circle cx={-1.6 * L} cy={0} r={L / 2.5} fill="#ffffff" stroke={colour} stroke-width={sw} /></g>, back: 0 };
    default: return { el: null, back: 0 };
  }
}
/** A marker at a route's end, and the route stopped short of it. */
function endOf(route: P[], atStart: boolean, kind: string, size: number, sw: number, filled: boolean, colour: string): { el: ComponentChildren; route: P[] } {
  if (kind === 'none' || route.length < 2) return { el: null, route };
  const n = route.length;
  const tip = atStart ? route[0]! : route[n - 1]!, from = atStart ? route[1]! : route[n - 2]!;
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const { el, back } = marker(kind, size, sw, filled, colour);
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const k = len ? Math.min(back, len) / len : 0;
  const cut = { x: tip.x + (from.x - tip.x) * k, y: tip.y + (from.y - tip.y) * k };
  const out = [...route];
  out[atStart ? 0 : n - 1] = cut;
  return { el: el ? <g transform={`translate(${f2(tip.x)} ${f2(tip.y)}) rotate(${f2((a * 180) / Math.PI)})`}>{el}</g> : null, route: out };
}
/** A route's path with its line jumps (jumpStyle arc, gap, sharp or line, jumpSize) over the points it crosses. */
function jumpPath(route: P[], s: Style, at: P[]): string {
  const kind = look(s, 'jumpStyle') ?? 'none', js = num(s, 'jumpSize', 6);
  let d = `M${f2(route[0]!.x)},${f2(route[0]!.y)}`;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!, b = route[i + 1]!, L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, n = { x: u.y, y: -u.x };
    // Up (or to the right) whichever way the line runs, as the editors draw them
    const up = n.y > 0 || (n.y === 0 && n.x < 0) ? { x: -n.x, y: -n.y } : n;
    const on = at.map((c) => ({ c, t: (c.x - a.x) * u.x + (c.y - a.y) * u.y })).filter((q) => q.t > js && q.t < L - js && Math.abs((q.c.x - a.x) * n.x + (q.c.y - a.y) * n.y) < 0.5).sort((p, q) => p.t - q.t);
    let last = -Infinity;
    for (const { c, t } of on) {
      if (t - js < last) continue;
      const p0 = { x: c.x - u.x * js, y: c.y - u.y * js }, p1 = { x: c.x + u.x * js, y: c.y + u.y * js };
      d += ` L${f2(p0.x)},${f2(p0.y)}`;
      const sweep = up.x * u.y - up.y * u.x > 0 ? 1 : 0;
      if (kind === 'gap') d += ` M${f2(p1.x)},${f2(p1.y)}`;
      else if (kind === 'sharp') d += ` L${f2(c.x + up.x * js)},${f2(c.y + up.y * js)} L${f2(p1.x)},${f2(p1.y)}`;
      else if (kind === 'line') d += ` L${f2(p0.x + up.x * js)},${f2(p0.y + up.y * js)} L${f2(p1.x + up.x * js)},${f2(p1.y + up.y * js)} L${f2(p1.x)},${f2(p1.y)}`;
      else d += ` A${js},${js} 0 0 ${sweep} ${f2(p1.x)},${f2(p1.y)}`;
      last = t + js;
    }
    d += ` L${f2(b.x)},${f2(b.y)}`;
  }
  return d;
}
/** A route's path: straight, rounded at its corners (rounded=1) or curved. */
function routePath(route: P[], s: Style, jumps: P[] = []): string {
  if (jumps.length && (look(s, 'jumpStyle') ?? 'none') !== 'none' && !on(s, 'curved')) return jumpPath(route, s, jumps);
  if (on(s, 'curved') && route.length > 2) {
    return `M${route[0]!.x},${route[0]!.y} ${route.slice(1, -1).map((q, i) => { const nx = route[i + 2]!; const last = i === route.length - 3; return `Q${q.x},${q.y} ${last ? nx.x : (q.x + nx.x) / 2},${last ? nx.y : (q.y + nx.y) / 2}`; }).join(' ')}`;
  }
  if (on(s, 'rounded') && route.length > 2) return poly(route.map((q) => [q.x, q.y] as Pt), false, num(s, 'arcSize', 20) / 2);
  return `M${route.map((q) => `${f2(q.x)},${f2(q.y)}`).join(' L')}`;
}
/** A line offset to one side of a route (positive: left of the way it runs), its corners mitred. */
function offsetRoute(route: P[], d: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < route.length; i++) {
    const a = route[Math.max(0, i - 1)]!, b = route[i]!, c = route[Math.min(route.length - 1, i + 1)]!;
    const n1 = norm(i === 0 ? b : a, i === 0 ? c : b), n2 = norm(b, i === route.length - 1 ? b : c);
    const nn = i === 0 ? n1 : i === route.length - 1 ? n1 : { x: n1.x + n2.x, y: n1.y + n2.y };
    const l = Math.hypot(nn.x, nn.y) || 1;
    const cos = (nn.x / l) * n1.x + (nn.y / l) * n1.y || 1;
    out.push({ x: b.x + (nn.x / l) * (d / cos), y: b.y + (nn.y / l) * (d / cos) });
  }
  return out;
}
function norm(a: P, b: P): P { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: -dy / l, y: dx / l }; }

/** A connector: its line (or flex arrow, or link), its markers, its label. */
export function EdgeView({ c, route, uid, shadow = false, jumps }: { c: Pick<Cell, 'id' | 'style' | 'value' | 'rect'> & Partial<Cell>; route: P[]; uid: string; shadow?: boolean; jumps?: P[] }) {
  if (route.length < 2) return null;
  const s = c.style;
  const colour = hex(look(s, 'strokeColor'), '#000000'), sw = num(s, 'strokeWidth', 1);
  const filter = shadow || on(s, 'shadow') ? `url(#${shadowId(uid)})` : undefined;
  const text = labelText(c as Cell);
  const shape = s.shape();
  let line: ComponentChildren, marks: ComponentChildren = null;
  if (shape === 'flexArrow') {
    const w = num(s, 'width', 10), a = w / 2;
    const headW = (w + num(s, 'endWidth', 20)) / 2, headL = num(s, 'endSize', 7) * 3;
    const sHeadW = (w + num(s, 'startWidth', 20)) / 2, sHeadL = num(s, 'startSize', 7) * 3;
    const endHead = (look(s, 'endArrow') ?? 'classic') !== 'none', startHead = (look(s, 'startArrow') ?? 'none') !== 'none';
    const cut = (r: P[], atStart: boolean, k: number) => { const n = r.length, tip = atStart ? r[0]! : r[n - 1]!, from = atStart ? r[1]! : r[n - 2]!, l = Math.hypot(tip.x - from.x, tip.y - from.y) || 1, t = Math.min(k, l) / l; const o = [...r]; o[atStart ? 0 : n - 1] = { x: tip.x + (from.x - tip.x) * t, y: tip.y + (from.y - tip.y) * t }; return o; };
    let core = route;
    if (endHead) core = cut(core, false, headL);
    if (startHead) core = cut(core, true, sHeadL);
    const left = offsetRoute(core, a), right = offsetRoute(core, -a);
    const head = (tip: P, base: P, hwid: number): P[] => { const nn = norm(base, tip); return [{ x: base.x + nn.x * hwid, y: base.y + nn.y * hwid }, tip, { x: base.x - nn.x * hwid, y: base.y - nn.y * hwid }]; };
    const n = core.length;
    const pts: P[] = [...left, ...(endHead ? head(route[route.length - 1]!, core[n - 1]!, headW) : []), ...[...right].reverse(), ...(startHead ? head(route[0]!, core[0]!, sHeadW).reverse() : [])];
    const fill = hex(look(s, 'fillColor'), '#ffffff');
    line = <path d={`M${pts.map((q) => `${f2(q.x)},${f2(q.y)}`).join(' L')} Z`} fill={fill} stroke={colour} stroke-width={sw} stroke-dasharray={dashes(s, sw)} stroke-linejoin="round" />;
  } else if (shape === 'link') {
    const w = num(s, 'width', 4) / 2;
    const one = (r: P[]) => `M${r.map((q) => `${f2(q.x)},${f2(q.y)}`).join(' L')}`;
    line = <path d={`${one(offsetRoute(route, w))} ${one(offsetRoute(route, -w))}`} fill="none" stroke={colour} stroke-width={sw} stroke-dasharray={dashes(s, sw)} />;
  } else {
    const e = endOf(route, false, look(s, 'endArrow') ?? 'classic', num(s, 'endSize', 6), sw, look(s, 'endFill') !== '0', colour);
    const b = endOf(e.route, true, look(s, 'startArrow') ?? 'none', num(s, 'startSize', 6), sw, look(s, 'startFill') !== '0', colour);
    line = <path d={routePath(b.route, s, jumps)} fill="none" stroke={colour} stroke-width={sw} stroke-dasharray={dashes(s, sw)} stroke-linejoin="round" />;
    marks = <>{e.el}{b.el}</>;
  }
  const at = text ? labelPoint(route, c.rect.x || 0, c.rect.y || 0) : null;
  const size = num(s, 'fontSize', 11);
  return (
    <g opacity={opacity(s, 'opacity')}>
      <g filter={filter}>{line}{marks}</g>
      {at && <EdgeText at={{ x: at.x + (c.offset?.x ?? 0), y: at.y + (c.offset?.y ?? 0) }} text={text} s={s} size={size} raw={labelSource(c as Cell)} />}
    </g>
  );
}

/** An edge's label at a point: centred, on its background (white unless the style says otherwise). */
export function EdgeText({ at, text, s, size, raw }: { at: P; text: string; s: Style; size: number; raw?: string }) {
  if (raw !== undefined && look(s, 'html') === '1' && /[<&]/.test(raw)) return <RichLabel s={s} r={{ x: at.x, y: at.y, w: 0, h: 0 }} raw={raw} edge at={at} />;
  const lines = text.split('\n');
  const fs = num(s, 'fontStyle', 0), bold = (fs & 1) !== 0, family = fontOf(s);
  const w = Math.max(...lines.map((l) => measure(l, size, bold, family))) + 4, lh = size * 1.2;
  const bg = hex(look(s, 'labelBackgroundColor'), '#ffffff');
  return (
    <g pointer-events="none" class="dg-text">
      {bg !== 'none' && <rect x={at.x - w / 2} y={at.y - (lines.length * lh) / 2} width={w} height={lines.length * lh} fill={bg} stroke={hex(look(s, 'labelBorderColor'), 'none')} />}
      <text font-size={size} font-family={family} font-weight={bold ? 'bold' : undefined} font-style={fs & 2 ? 'italic' : undefined} fill={hex(look(s, 'fontColor'), '#000000')} text-anchor="middle">
        {lines.map((l, i) => <tspan key={i} x={at.x} y={at.y - (lines.length * lh) / 2 + (i + 0.8) * lh}>{l}</tspan>)}
      </text>
    </g>
  );
}

/** A style string as a cell to draw (the palette's pictures). */
export const sample = (style: string, value = '', id = 's'): Pick<Cell, 'id' | 'style' | 'value' | 'rect'> => ({ id, style: Style.parse(style), value, rect: { x: 0, y: 0, w: 0, h: 0 } });
