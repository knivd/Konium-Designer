/**
 * Visio drawings (.vsdx, a ZIP of XML parts) read into a diagram: each page's shapes (their cells
 * from the shape, else its master) as shapes in place (pin, size, angle, flips), rectangles and
 * ellipses as such and any other outline as a stencil of its geometry rows (lines, arcs,
 * elliptical arcs, ellipses, splines and NURBS as lines), their fill, line, text and its font;
 * groups with their shapes; 1-D shapes as connectors (their ends, bends, arrows and the shapes
 * they are glued to); pictures (PNG, JPEG, GIF, BMP) embedded.
 */
import { charOf } from './codePoint';
import { unzipSync } from './inflate';
import { parseTree, xkids, type XNode } from './xmlTree';
import { stencilStyle } from './stencil';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;');
/** Text as a formatted (html=1) label shows it: its < > & written as such, its lines as line breaks. */
const asHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const labelFor = (text: string, style: string) => (/(^|;)html=1(;|$)/.test(style) ? asHtml(text) : text);
const at = (e: XNode | undefined, k: string) => e?.attrs.find(([n]) => n === k || n.endsWith(`:${k}`))?.[1];
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, x: string) => (x[0] === '#' ? charOf(x[1] === 'x' || x[1] === 'X' ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[x.toLowerCase()] ?? m));
const lname = (n: string) => n.replace(/^.*:/, '');
const kids = (e: XNode | undefined, name: string) => xkids(e).filter((k) => lname(k.name) === name);
const kid = (e: XNode | undefined, name: string) => kids(e, name)[0];

export const isVsdx = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && new TextDecoder('latin1').decode(bytes.subarray(0, 4000)).includes('visio/');

/** Visio's colour index (0 black, 1 white …), or a #rrggbb as written. */
const INDEX = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#e6e6e6', '#cdcdcd', '#b3b3b3', '#9a9a9a', '#808080', '#666666', '#4d4d4d', '#333333', '#1a1a1a'];
const colour = (v: string | undefined): string | undefined => (!v ? undefined : /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : /^\d+$/.test(v) ? INDEX[Number(v)] : undefined);

interface Sheet { e: XNode; base?: Sheet }
/** A cell's value: the shape's, else its master's. */
function cellV(s: Sheet | undefined, name: string): string | undefined {
  for (let x = s; x; x = x.base) { const c = kids(x.e, 'Cell').find((k) => at(k, 'N') === name); if (c) return at(c, 'V'); }
  return undefined;
}
const num = (s: Sheet | undefined, name: string, def = 0) => { const v = Number(cellV(s, name)); return Number.isFinite(v) && cellV(s, name) !== undefined ? v : def; };
/** A section's first row's cell (Character, Para): the shape's, else its master's. */
function rowV(s: Sheet | undefined, section: string, name: string): string | undefined {
  for (let x = s; x; x = x.base) {
    const sec = kids(x.e, 'Section').find((k) => at(k, 'N') === section);
    const row = kids(sec, 'Row')[0];
    const c = kids(row, 'Cell').find((k) => at(k, 'N') === name);
    if (c) return at(c, 'V');
  }
  return undefined;
}
/** The shape's Geometry sections (its own, else its master's). */
function geometry(s: Sheet | undefined): XNode[] {
  for (let x = s; x; x = x.base) { const g = kids(x.e, 'Section').filter((k) => at(k, 'N') === 'Geometry'); if (g.length) return g; }
  return [];
}
/** A shape's text: its Text element's words (fields and markers left out). */
function textOf(s: Sheet | undefined): string {
  for (let x = s; x; x = x.base) {
    const t = kid(x.e, 'Text');
    if (t) {
      const walk = (n: XNode): string => n.kids.map((k) => (typeof k === 'string' ? unent(k) : lname(k.name) === 'fld' ? walk(k) : '')).join('');
      return walk(t).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    }
  }
  return '';
}

type V2 = { x: number; y: number };
const f2 = (v: number) => Math.round(v * 100) / 100;
/** Geometry rows as an SVG path in a box w × h (inches, y up) drawn at 100 units an inch, y down. */
function rowsToPath(rows: XNode[], w: number, h: number): { d: string } {
  const K = 100;
  const P = (x: number, y: number) => `${f2(x * K)},${f2((h - y) * K)}`;
  let d = '', cur: V2 = { x: 0, y: 0 };
  const cv = (r: XNode, n: string) => { const c = kids(r, 'Cell').find((k) => at(k, 'N') === n); const v = Number(at(c, 'V')); return Number.isFinite(v) ? v : 0; };
  const cf = (r: XNode, n: string) => at(kids(r, 'Cell').find((k) => at(k, 'N') === n), 'F') ?? '';
  for (const r of rows) {
    const t = at(r, 'T') ?? '', rel = t.startsWith('Rel');
    const X = (n: string) => cv(r, n) * (rel ? w : 1), Y = (n: string) => cv(r, n) * (rel ? h : 1);
    if (at(r, 'Del') === '1') continue;
    if (t === 'MoveTo' || t === 'RelMoveTo') { cur = { x: X('X'), y: Y('Y') }; d += `M${P(cur.x, cur.y)} `; }
    else if (t === 'LineTo' || t === 'RelLineTo' || t === 'SplineStart' || t === 'SplineKnot') { cur = { x: X('X'), y: Y('Y') }; d += `L${P(cur.x, cur.y)} `; }
    else if (t === 'NURBSTo') { cur = { x: X('X'), y: Y('Y') }; d += `L${P(cur.x, cur.y)} `; }
    else if (t === 'PolylineTo') {
      // POLYLINE(xType, yType, x1, y1, …): its points (relative to the box when its type is 1)
      const m = /POLYLINE\(\s*([^)]*)\)/i.exec(cf(r, 'A'));
      if (m) {
        const v = m[1]!.split(',').map((x) => Number(x.trim()));
        const xr = v[0] === 1, yr = v[1] === 1;
        for (let i = 2; i + 1 < v.length; i += 2) d += `L${P(xr ? v[i]! * w : v[i]!, yr ? v[i + 1]! * h : v[i + 1]!)} `;
      }
      cur = { x: X('X'), y: Y('Y') }; d += `L${P(cur.x, cur.y)} `;
    } else if (t === 'RelCubBezTo') { const e = { x: X('X'), y: Y('Y') }; d += `C${P(cv(r, 'A') * w, cv(r, 'B') * h)} ${P(cv(r, 'C') * w, cv(r, 'D') * h)} ${P(e.x, e.y)} `; cur = e; }
    else if (t === 'RelQuadBezTo') { const e = { x: X('X'), y: Y('Y') }; d += `Q${P(cv(r, 'A') * w, cv(r, 'B') * h)} ${P(e.x, e.y)} `; cur = e; }
    else if (t === 'ArcTo') {
      // A circular arc to X, Y bowed by A (from the chord's middle, to its left)
      const e = { x: X('X'), y: Y('Y') }, bow = cv(r, 'A');
      const c = Math.hypot(e.x - cur.x, e.y - cur.y);
      if (Math.abs(bow) < 1e-9 || c < 1e-9) d += `L${P(e.x, e.y)} `;
      else {
        const rad = (c * c / 4 + bow * bow) / (2 * Math.abs(bow));
        const large = Math.abs(bow) > c / 2 ? 1 : 0;
        // Bowed left of the way it goes (y up) is clockwise once y points down
        d += `A${f2(rad * K)},${f2(rad * K)} 0 ${large} ${bow > 0 ? 0 : 1} ${P(e.x, e.y)} `;
      }
      cur = e;
    } else if (t === 'EllipticalArcTo' || t === 'RelEllipticalArcTo') {
      const e = { x: X('X'), y: Y('Y') }, m = { x: X('A'), y: Y('B') }, ang = cv(r, 'C'), ratio = cv(r, 'D') || 1;
      // In a frame where the ellipse is a circle: the circle through the three points
      const tf = (q: V2) => { const cs = Math.cos(-ang), sn = Math.sin(-ang); return { x: (q.x * cs - q.y * sn) / ratio, y: q.x * sn + q.y * cs }; };
      const a = tf(cur), b = tf(m), cc = tf(e);
      const den = 2 * (a.x * (b.y - cc.y) + b.x * (cc.y - a.y) + cc.x * (a.y - b.y));
      if (Math.abs(den) < 1e-12) d += `L${P(e.x, e.y)} `;
      else {
        const ux = ((a.x ** 2 + a.y ** 2) * (b.y - cc.y) + (b.x ** 2 + b.y ** 2) * (cc.y - a.y) + (cc.x ** 2 + cc.y ** 2) * (a.y - b.y)) / den;
        const uy = ((a.x ** 2 + a.y ** 2) * (cc.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - cc.x) + (cc.x ** 2 + cc.y ** 2) * (b.x - a.x)) / den;
        const R = Math.hypot(a.x - ux, a.y - uy);
        const cross = (b.x - a.x) * (cc.y - a.y) - (b.y - a.y) * (cc.x - a.x);
        // The arc through the middle point: past the half-way round when the middle is on the far side
        const ang1 = Math.atan2(a.y - uy, a.x - ux), ang3 = Math.atan2(cc.y - uy, cc.x - ux);
        const sweepCcw = cross > 0;
        let span = ang3 - ang1;
        if (sweepCcw) { while (span <= 0) span += 2 * Math.PI; } else { while (span >= 0) span -= 2 * Math.PI; }
        const large = Math.abs(span) > Math.PI ? 1 : 0;
        // Anticlockwise with y up is clockwise once y points down (sweep 1)
        d += `A${f2(R * ratio * K)},${f2(R * K)} ${f2((-ang * 180) / Math.PI)} ${large} ${sweepCcw ? 1 : 0} ${P(e.x, e.y)} `;
      }
      cur = e;
    } else if (t === 'Ellipse') {
      const cx = X('X'), cy = Y('Y'), ax = X('A'), ay = Y('B'), bx = X('C'), by = Y('D');
      const rx = Math.hypot(ax - cx, ay - cy), ry = Math.hypot(bx - cx, by - cy), rot = (-Math.atan2(ay - cy, ax - cx) * 180) / Math.PI;
      const ca = Math.cos(-rot * Math.PI / 180), sa = Math.sin(-rot * Math.PI / 180);
      const p1 = { x: cx - rx * ca, y: cy - rx * sa }, p2 = { x: cx + rx * ca, y: cy + rx * sa };
      d += `M${P(p1.x, p1.y)} A${f2(rx * K)},${f2(ry * K)} ${f2(rot)} 1 1 ${P(p2.x, p2.y)} A${f2(rx * K)},${f2(ry * K)} ${f2(rot)} 1 1 ${P(p1.x, p1.y)} Z `;
    }
  }
  return { d: d.trim() };
}

interface Out { cells: string[]; ids: Map<string, string>; n: number; notes: string[] }
const lineStyle = (s: Sheet): string => {
  const pat = num(s, 'LinePattern', 1), lc = colour(cellV(s, 'LineColor')) ?? '#000000', lw = num(s, 'LineWeight', 0.01) * 72;
  return `strokeColor=${pat === 0 ? 'none' : lc};strokeWidth=${f2(Math.max(0.25, lw))};${pat > 1 ? 'dashed=1;' : ''}`;
};
const fillStyle = (s: Sheet): string => {
  const pat = num(s, 'FillPattern', 1), fc = colour(cellV(s, 'FillForegnd')) ?? '#ffffff', tr = num(s, 'FillForegndTrans', 0);
  return `fillColor=${pat === 0 ? 'none' : fc};${tr > 0 ? `fillOpacity=${Math.round((1 - tr) * 100)};` : ''}`;
};
const textStyle = (s: Sheet): string => {
  const size = Number(rowV(s, 'Character', 'Size')), col = colour(rowV(s, 'Character', 'Color')), st = Number(rowV(s, 'Character', 'Style')) || 0;
  const ha = Number(rowV(s, 'Paragraph', 'HorzAlign') ?? 1), va = num(s, 'VerticalAlign', 1);
  return `fontSize=${Number.isFinite(size) && size > 0 ? f2(size * 72) : 12};${col ? `fontColor=${col};` : ''}${st & 7 ? `fontStyle=${(st & 1) | (st & 2) | (st & 4)};` : ''}align=${ha === 0 ? 'left' : ha === 2 ? 'right' : 'center'};verticalAlign=${va === 0 ? 'top' : va === 2 ? 'bottom' : 'middle'};`;
};

/** A 2-D shape (or group) as a cell; its children inside it. `frameH`: the height (inches) of the frame its pin is in (the page's, or its group's). */
function shape2d(o: Out, s: Sheet, parent: string, frameH: number, media: (rid: string) => string | null, master: (e: XNode, base?: Sheet) => Sheet): void {
  const id = `v${++o.n}`;
  o.ids.set(at(s.e, 'ID') ?? '', id);
  const w = num(s, 'Width', 1), h = num(s, 'Height', 1), px = num(s, 'PinX'), py = num(s, 'PinY'), lx = num(s, 'LocPinX', w / 2), ly = num(s, 'LocPinY', h / 2), ang = num(s, 'Angle');
  // The box's centre, the shape turned about its pin
  const cx = px + (w / 2 - lx) * Math.cos(ang) - (h / 2 - ly) * Math.sin(ang), cy = py + (w / 2 - lx) * Math.sin(ang) + (h / 2 - ly) * Math.cos(ang);
  const box = { x: f2((cx - w / 2) * 100), y: f2((frameH - cy - h / 2) * 100), w: f2(w * 100), h: f2(h * 100) };
  const text = textOf(s);
  const type = at(s.e, 'Type');
  const geo = geometry(s);
  const turn = ang ? `rotation=${f2(((-ang * 180) / Math.PI) % 360)};` : '';
  const flips = `${num(s, 'FlipX') ? 'flipH=1;' : ''}${num(s, 'FlipY') ? 'flipV=1;' : ''}`;
  let style: string;
  if (type === 'Group') style = 'group;';
  else if (type === 'Foreign') {
    const rid = at(kid(kid(s.e, 'ForeignData'), 'Rel'), 'id');
    const src = rid ? media(rid) : null;
    style = src ? `shape=image;image=${src};imageAspect=0;` : 'rounded=0;dashed=1;fillColor=none;';
    if (!src) o.notes.push(`Shape ${at(s.e, 'ID')}: an embedded object that isn't a picture, kept as its box`);
  } else if (!geo.length) style = 'text;html=1;whiteSpace=wrap;';
  else {
    const rows = geo.map((g) => ({ g, rows: kids(g, 'Row'), noFill: at(kids(g, 'Cell').find((k) => at(k, 'N') === 'NoFill'), 'V') === '1', noLine: at(kids(g, 'Cell').find((k) => at(k, 'N') === 'NoLine'), 'V') === '1' }));
    const one = rows.length === 1 ? rows[0]! : null;
    const ts = one?.rows.map((r) => at(r, 'T') ?? '') ?? [];
    const isRect = !!one && ts.length === 5 && ts[0]!.endsWith('MoveTo') && ts.slice(1).every((t) => t.endsWith('LineTo')) && (() => {
      const pts = one.rows.map((r) => { const c = (n: string) => Number(at(kids(r, 'Cell').find((k) => at(k, 'N') === n), 'V')); const rel = (at(r, 'T') ?? '').startsWith('Rel'); return [c('X') * (rel ? w : 1), c('Y') * (rel ? h : 1)]; });
      return pts.every(([x, y]) => (Math.abs(x!) < 1e-6 || Math.abs(x! - w) < 1e-6) && (Math.abs(y!) < 1e-6 || Math.abs(y! - h) < 1e-6));
    })();
    const isEllipse = !!one && ts.length === 1 && ts[0] === 'Ellipse';
    const rounding = num(s, 'Rounding');
    if (isRect) style = `rounded=${rounding > 0 ? 1 : 0};${rounding > 0 ? `absoluteArcSize=1;arcSize=${f2(rounding * 200)};` : ''}whiteSpace=wrap;html=1;`;
    else if (isEllipse) style = 'ellipse;whiteSpace=wrap;html=1;';
    else {
      // Any other outline: a stencil of its geometry, filled sections then lines
      const parts = rows.map((r) => ({ ...r, d: rowsToPath(r.rows, w, h).d })).filter((p) => p.d);
      const body = parts.map((p) => `${pathXml(p.d)}${p.noFill && p.noLine ? '' : p.noFill ? '<stroke/>' : p.noLine ? '<fill/>' : '<fillstroke/>'}`).join('');
      style = `shape=${stencilStyle(`<shape w="${f2(w * 100) || 1}" h="${f2(h * 100) || 1}" aspect="variable" strokewidth="inherit"><background/><foreground>${body}</foreground></shape>`)};whiteSpace=wrap;html=1;`;
    }
  }
  if (type !== 'Group') style += fillStyle(s) + lineStyle(s);
  style += textStyle(s) + turn + flips;
  o.cells.push(`<mxCell id="${id}" value="${esc(labelFor(text, style))}" style="${esc(style)}" vertex="1" parent="${parent}"><mxGeometry x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" as="geometry" /></mxCell>`);
  if (type === 'Group') {
    // The group's shapes: their pins in its frame (from its bottom left, y up)
    for (const k of kids(kid(s.e, 'Shapes'), 'Shape')) place(o, master(k, s), id, h, media, master);
  }
}
/** A shape of a page or group: a connector when it has ends, else a 2-D shape. */
function place(o: Out, s: Sheet, parent: string, frameH: number, media: (rid: string) => string | null, master: (e: XNode, base?: Sheet) => Sheet): void {
  if (cellV(s, 'BeginX') !== undefined && cellV(s, 'EndX') !== undefined && at(s.e, 'Type') !== 'Group') {
    const id = `e${++o.n}`;
    o.ids.set(at(s.e, 'ID') ?? '', id);
    const P = (x: number, y: number) => ({ x: f2(x * 100), y: f2((frameH - y) * 100) });
    const b = P(num(s, 'BeginX'), num(s, 'BeginY')), e = P(num(s, 'EndX'), num(s, 'EndY'));
    // Its bends: its geometry's points between the first and last, from its local frame to the page
    const w = num(s, 'Width', 1), h = num(s, 'Height', 0), px = num(s, 'PinX'), py = num(s, 'PinY'), lx = num(s, 'LocPinX', w / 2), ly = num(s, 'LocPinY', h / 2), ang = num(s, 'Angle');
    const pts: { x: number; y: number }[] = [];
    const rows = kids(geometry(s)[0], 'Row').filter((r) => /LineTo|MoveTo/.test(at(r, 'T') ?? ''));
    for (const r of rows.slice(1, -1)) {
      const rel = (at(r, 'T') ?? '').startsWith('Rel');
      const c = (n: string) => Number(at(kids(r, 'Cell').find((k) => at(k, 'N') === n), 'V')) || 0;
      const lxv = c('X') * (rel ? w : 1) - lx, lyv = c('Y') * (rel ? h : 1) - ly;
      pts.push(P(px + lxv * Math.cos(ang) - lyv * Math.sin(ang), py + lxv * Math.sin(ang) + lyv * Math.cos(ang)));
    }
    const arrow = (v: number) => (v ? (v >= 13 || v === 4 || v === 5 ? 'block' : 'classic') : 'none');
    const style = `endArrow=${arrow(num(s, 'EndArrow'))};startArrow=${arrow(num(s, 'BeginArrow'))};html=1;${lineStyle(s)}${textStyle(s)}`;
    const points = pts.length ? `<Array as="points">${pts.map((q) => `<mxPoint x="${q.x}" y="${q.y}" />`).join('')}</Array>` : '';
    o.cells.push(`<mxCell id="${id}" value="${esc(labelFor(textOf(s), style))}" style="${esc(style)}" edge="1" parent="${parent}" data-visio="${at(s.e, 'ID')}"><mxGeometry relative="1" as="geometry"><mxPoint x="${b.x}" y="${b.y}" as="sourcePoint" /><mxPoint x="${e.x}" y="${e.y}" as="targetPoint" />${points}</mxGeometry></mxCell>`);
    return;
  }
  shape2d(o, s, parent, frameH, media, master);
}

/** The XML of a stencil path from an SVG path (M, L, Q, C, A, Z). */
function pathXml(d: string): string {
  const out: string[] = [];
  const toks = d.match(/[MLQCAZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  let i = 0, cmd = '';
  const n = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[MLQCAZ]$/i.test(toks[i]!)) cmd = toks[i++]!.toUpperCase();
    if (cmd === 'Z') { out.push('<close/>'); cmd = ''; continue; }
    if (cmd === 'M') { out.push(`<move x="${n()}" y="${n()}"/>`); cmd = 'L'; }
    else if (cmd === 'L') out.push(`<line x="${n()}" y="${n()}"/>`);
    else if (cmd === 'Q') out.push(`<quad x1="${n()}" y1="${n()}" x2="${n()}" y2="${n()}"/>`);
    else if (cmd === 'C') out.push(`<curve x1="${n()}" y1="${n()}" x2="${n()}" y2="${n()}" x3="${n()}" y3="${n()}"/>`);
    else if (cmd === 'A') out.push(`<arc rx="${n()}" ry="${n()}" x-axis-rotation="${n()}" large-arc-flag="${n()}" sweep-flag="${n()}" x="${n()}" y="${n()}"/>`);
    else i++;
  }
  return `<path>${out.join('')}</path>`;
}

/** A .vsdx as a diagram's XML (an mxfile of its pages), and notes on what couldn't be kept. */
export function vsdxToDiagram(bytes: Uint8Array): { xml: string; notes: string[] } {
  const files = new Map(unzipSync(bytes).map((f) => [f.name.replace(/^\/+/, ''), f.bytes]));
  const xml = (path: string): XNode | undefined => { const b = files.get(path); return b ? parseTree(new TextDecoder().decode(b)).root : undefined; };
  const rels = (path: string) => {
    const dir = path.split('/').slice(0, -1).join('/'), base = path.split('/').pop()!;
    const r = xml(`${dir}/_rels/${base}.rels`);
    const out = new Map<string, string>();
    for (const x of kids(r, 'Relationship')) { const t = at(x, 'Target') ?? ''; out.set(at(x, 'Id') ?? '', t.startsWith('/') ? t.slice(1) : normalise(`${dir}/${t}`)); }
    return out;
  };
  const pagesPath = 'visio/pages/pages.xml';
  const pages = xml(pagesPath);
  if (!pages) throw new Error('This isn\'t a Visio drawing (no visio/pages/pages.xml)');
  const pageRels = rels(pagesPath);
  // Masters: each master's shapes by ID
  const masters = new Map<string, Map<string, XNode>>(), mtop = new Map<string, XNode>();
  const mpath = 'visio/masters/masters.xml', ms = xml(mpath), mrels = rels(mpath);
  for (const m of kids(ms, 'Master')) {
    const p = mrels.get(at(kid(m, 'Rel'), 'id') ?? '');
    const mc = p ? xml(p) : null;
    const byId = new Map<string, XNode>();
    const walk = (e: XNode | undefined) => { for (const s of kids(kid(e, 'Shapes'), 'Shape')) { byId.set(at(s, 'ID') ?? '', s); walk(s); } };
    walk(mc ?? undefined);
    masters.set(at(m, 'ID') ?? '', byId);
    const first = kids(kid(mc ?? undefined, 'Shapes'), 'Shape')[0];
    if (first) mtop.set(at(m, 'ID') ?? '', first);
  }
  const notes: string[] = [];
  const out: string[] = [];
  let pn = 0;
  for (const pg of kids(pages, 'Page')) {
    if (at(pg, 'Background') === '1') continue;
    const path = pageRels.get(at(kid(pg, 'Rel'), 'id') ?? '');
    const pc = path ? xml(path) : null;
    if (!pc || !path) continue;
    const prels = rels(path);
    const media = (rid: string): string | null => {
      const f = prels.get(rid); const b = f ? files.get(f) : undefined;
      const ext = (f ?? '').split('.').pop()!.toLowerCase(), mime = ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', bmp: 'bmp' } as Record<string, string>)[ext];
      if (!b || !mime) return null;
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return `data:image/${mime},${btoa(s)}`;
    };
    const sheet = { e: kid(pg, 'PageSheet') ?? { name: 'PageSheet', attrs: [], kids: [], empty: true } } as Sheet;
    const pw = num(sheet, 'PageWidth', 11.69), ph = num(sheet, 'PageHeight', 8.27);
    // A shape's sheet: its master's shape under it (an instance's top shape, or a group's shape by MasterShape)
    const master = (e: XNode, parentSheet?: Sheet): Sheet => {
      const mid = at(e, 'Master'), msid = at(e, 'MasterShape');
      let base: Sheet | undefined;
      if (mid && mtop.get(mid)) base = { e: mtop.get(mid)! };
      else if (msid && parentSheet) {
        // The parent's master: the master of the group this shape is in
        let x: Sheet | undefined = parentSheet, m: string | undefined;
        while (x && !m) { m = at(x.e, 'Master'); x = x.base; }
        const ms0 = m ? masters.get(m)?.get(msid) : undefined;
        if (ms0) base = { e: ms0 };
      }
      return { e, base };
    };
    const o: Out = { cells: [], ids: new Map(), n: 0, notes };
    for (const s of kids(kid(pc, 'Shapes'), 'Shape')) place(o, master(s), '1', ph, media, master);
    // Connectors glued to shapes: their ends on those shapes
    let cellsXml = o.cells.join('');
    for (const c of kids(kid(pc, 'Connects'), 'Connect')) {
      const from = o.ids.get(at(c, 'FromSheet') ?? ''), to = o.ids.get(at(c, 'ToSheet') ?? ''), end = at(c, 'FromCell');
      if (!from || !to || !from.startsWith('e') || (end !== 'BeginX' && end !== 'EndX')) continue;
      cellsXml = cellsXml.replace(`<mxCell id="${from}" `, `<mxCell id="${from}" ${end === 'BeginX' ? 'source' : 'target'}="${to}" `);
    }
    cellsXml = cellsXml.replace(/ data-visio="[^"]*"/g, '');
    const name = at(pg, 'NameU') ?? at(pg, 'Name') ?? `Page-${pn + 1}`;
    out.push(`<diagram id="vsdx-${++pn}" name="${esc(unent(at(pg, 'Name') ?? name))}"><mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="${Math.round(pw * 100)}" pageHeight="${Math.round(ph * 100)}"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cellsXml}</root></mxGraphModel></diagram>`);
  }
  if (!out.length) throw new Error('The Visio drawing has no pages Konium Designer can read');
  return { xml: `<mxfile host="Konium" agent="Konium Designer">${out.join('')}</mxfile>\n`, notes };
}
function normalise(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
