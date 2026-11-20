/**
 * A diagram saved as a Visio drawing (.vsdx): each page a Visio page of its paper; each shape a
 * 2-D shape where it is (pin, size, angle) with its outline as geometry (rectangles and ellipses
 * as such, any other outline, stencils included, as lines through its curves), its fill, line,
 * text and font; each connector a 1-D shape along its route, its arrows, glued to the shapes it
 * joins. Groups are kept as their shapes; pictures as their box.
 */
import { attr, cells, drawOrder, edgeRoute, labelText, layers, layout, pageName, type Cell, type DiagramPage, type DrawioDocument } from '../../formats/drawio';
import { fitStencil, readStencil } from '../../formats/stencil';
import { zip } from '../../formats/zip';
import { hex, look, num, outline } from './render';
import { pageSize } from './ops';

type V = { x: number; y: number };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r6 = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** An SVG path's subpaths as points (curves and arcs as lines through them); closed ones end where they start. */
export function flattenPath(d: string): V[][] {
  const toks = d.match(/[MLHVQCAZmlhvqcaz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: V[][] = [];
  let cur: V = { x: 0, y: 0 }, start: V = cur, sub: V[] = [], i = 0, cmd = '';
  const n = () => Number(toks[i++]);
  const push = (q: V) => { sub.push(q); cur = q; };
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i]!)) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const o = rel ? cur : { x: 0, y: 0 };
    if (C === 'Z') { if (sub.length) { push({ ...start }); out.push(sub); sub = []; } cmd = ''; continue; }
    if (C === 'M') { if (sub.length > 1) out.push(sub); const q = { x: o.x + n(), y: o.y + n() }; sub = [q]; cur = start = q; cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') push({ x: o.x + n(), y: o.y + n() });
    else if (C === 'H') push({ x: (rel ? cur.x : 0) + n(), y: cur.y });
    else if (C === 'V') push({ x: cur.x, y: (rel ? cur.y : 0) + n() });
    else if (C === 'Q') { const a = cur, c = { x: o.x + n(), y: o.y + n() }, e = { x: o.x + n(), y: o.y + n() }; for (let k = 1; k <= 8; k++) { const t = k / 8; push({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * e.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * e.y }); } }
    else if (C === 'C') { const a = cur, c1 = { x: o.x + n(), y: o.y + n() }, c2 = { x: o.x + n(), y: o.y + n() }, e = { x: o.x + n(), y: o.y + n() }; for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; push({ x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * e.x, y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * e.y }); } }
    else if (C === 'A') { const rx = n(), ry = n(), rot = n(), large = n(), sweep = n(), e = { x: o.x + n(), y: o.y + n() }; for (const q of arcPoints(cur, e, rx, ry, rot, !!large, !!sweep)) push(q); }
    else i++;
  }
  if (sub.length > 1) out.push(sub);
  return out;
}
/** An SVG arc's points (endpoint form to centre form, then 16 steps). */
function arcPoints(a: V, b: V, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean): V[] {
  if (!rx || !ry || (a.x === b.x && a.y === b.y)) return [b];
  const phi = (rotDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (a.x - b.x) / 2, dy = (a.y - b.y) / 2;
  const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = large === sweep ? -1 : 1;
  const num0 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = sign * Math.sqrt(Math.max(0, num0 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cs * cx1 - sn * cy1 + (a.x + b.x) / 2, cy = sn * cx1 + cs * cy1 + (a.y + b.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const out: V[] = [];
  for (let s = 1; s <= 16; s++) { const t = t1 + (dt * s) / 16; out.push({ x: cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, y: cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs }); }
  out[out.length - 1] = b;
  return out;
}

interface Part { pts: V[][]; fill: boolean; line: boolean; ellipse?: boolean }
/** A shape's outline parts in its box (0,0 to w,h px), its direction and flips applied. */
function shapeParts(c: Cell, w: number, h: number): Part[] {
  const s = c.style, shape = s.shape();
  if (shape === 'text' || shape === 'edgeLabel' || shape === 'group' || shape === 'waypoint') return [];
  if (shape === 'ellipse') return [{ pts: [], fill: true, line: true, ellipse: true }];
  const dir = look(s, 'direction') ?? 'east';
  const turn = dir === 'south' ? 90 : dir === 'west' ? 180 : dir === 'north' ? 270 : 0;
  const swap = turn % 180 !== 0, lw = swap ? h : w, lh = swap ? w : h;
  const fH = look(s, 'flipH') === '1', fV = look(s, 'flipV') === '1';
  const map = (q: V): V => {
    // In the turned frame about its centre, onto the box, then flipped
    const a = (turn * Math.PI) / 180, dx = q.x - lw / 2, dy = q.y - lh / 2;
    let x = w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y = h / 2 + dx * Math.sin(a) + dy * Math.cos(a);
    if (fH) x = w - x; if (fV) y = h - y;
    return { x, y };
  };
  const out: Part[] = [];
  if (shape.startsWith('stencil(')) {
    const st = readStencil(shape);
    if (!st) return [{ pts: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 }]], fill: true, line: true }];
    const t = fitStencil(st, 0, 0, lw, lh);
    for (const [ops, bg] of [[st.background, true], [st.foreground, false]] as const) {
      let pending: V[][] = [];
      for (const o of ops) {
        if (o.k === 'path') pending.push(...flattenPath(o.d(t)).map((sp) => sp.map(map)));
        else if (o.k === 'paint') { if (pending.length) out.push({ pts: pending, fill: o.fill, line: o.stroke }); pending = []; }
      }
      if (bg && pending.length) out.push({ pts: pending, fill: true, line: true });
    }
    return out;
  }
  const parts = outline(shape, lw, lh, s);
  if (!parts) return [{ pts: [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 }]], fill: true, line: true }];
  for (const p of parts) if (p.kind !== 'shade') out.push({ pts: flattenPath(p.d).map((sp) => sp.map(map)), fill: p.kind === 'body', line: true });
  return out;
}

const cell = (n: string, v: string | number, u?: string) => `<Cell N="${n}" V="${typeof v === 'number' ? r6(v) : esc(v)}"${u ? ` U="${u}"` : ''}/>`;
/** Fill, line and text cells for a style. */
function looks(c: Cell, edge: boolean): string {
  const s = c.style;
  const fill = hex(look(s, 'fillColor'), edge ? 'none' : '#ffffff'), stroke = hex(look(s, 'strokeColor'), '#000000');
  const sw = num(s, 'strokeWidth', 1);
  let x = '';
  if (!edge) x += cell('FillForegnd', /^#[0-9a-f]{6}$/i.test(fill) ? fill.toUpperCase() : '#FFFFFF') + cell('FillPattern', fill === 'none' ? 0 : 1);
  x += cell('LineColor', /^#[0-9a-f]{6}$/i.test(stroke) ? stroke.toUpperCase() : '#000000') + cell('LinePattern', stroke === 'none' ? 0 : look(s, 'dashed') === '1' ? 2 : 1) + cell('LineWeight', sw / 72, 'PT');
  const va = look(s, 'verticalAlign') ?? 'middle';
  x += cell('VerticalAlign', va === 'top' ? 0 : va === 'bottom' ? 2 : 1);
  return x;
}
/** A shape's text box: in the shape (as Visio puts it), or beside it where the label goes (labelPosition, verticalLabelPosition); a connector's level whichever way it runs. */
function textBox(c: Cell, W: number, H: number, ang = 0): string {
  if (!labelText(c)) return '';
  if (c.edge) return cell('TxtAngle', -ang, 'RAD');
  const vp = look(c.style, 'verticalLabelPosition'), hp = look(c.style, 'labelPosition');
  if (vp !== 'bottom' && vp !== 'top' && hp !== 'left' && hp !== 'right') return '';
  const tw = Math.max(W, 1), th = Math.max(H, 0.3);
  const x = hp === 'left' ? -tw / 2 : hp === 'right' ? W + tw / 2 : W / 2, y = vp === 'bottom' ? -th / 2 : vp === 'top' ? H + th / 2 : H / 2;
  return cell('TxtPinX', x, 'IN') + cell('TxtPinY', y, 'IN') + cell('TxtWidth', tw, 'IN') + cell('TxtHeight', th, 'IN') + cell('TxtLocPinX', tw / 2, 'IN') + cell('TxtLocPinY', th / 2, 'IN');
}
function textXml(c: Cell): string {
  const t = labelText(c);
  if (!t) return '';
  const s = c.style, fs = num(s, 'fontStyle', 0), size = num(s, 'fontSize', c.edge ? 11 : 12), col = hex(look(s, 'fontColor'), '#000000'), al = look(s, 'align') ?? 'center';
  return `<Section N="Character"><Row IX="0">${cell('Size', size / 72, 'PT')}${cell('Color', /^#[0-9a-f]{6}$/i.test(col) ? col.toUpperCase() : '#000000')}${cell('Style', fs & 7)}</Row></Section>`
    + `<Section N="Paragraph"><Row IX="0">${cell('HorzAlign', al === 'left' ? 0 : al === 'right' ? 2 : 1)}</Row></Section><Text>${esc(t)}</Text>`;
}

/** A diagram as a .vsdx, and notes on what isn't kept as it is. */
export function diagramToVsdx(d: DrawioDocument): { bytes: Uint8Array; notes: string[] } {
  const notes: string[] = [];
  const pagesXml: string[] = [], pageFiles: { name: string; bytes: Uint8Array }[] = [], rels: string[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  const NS = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  d.pages.forEach((page: DiagramPage, pi) => {
    const list = drawOrder(cells(page));
    const L = layout(list);
    const hidden = new Set(layers(page).filter((l) => !l.visible).map((l) => l.id));
    const layerOf = (c: Cell): string => { let x: Cell | undefined = c; for (let k = 0; x && k < 60; k++) { const par = L.byId.get(x.parent); if (!par || !par.parent) return x.id; x = par; } return ''; };
    const size = pageSize(page.model), PH = size.h / 100;
    const ids = new Map<string, number>();
    let next = 1;
    const shapes: string[] = [], connects: string[] = [];
    const V2 = (q: V) => ({ x: q.x / 100, y: PH - q.y / 100 });
    for (const c of list) {
      if (!(c.vertex || c.edge) || (c.vertex && c.relative) || hidden.has(layerOf(c)) || attr(c.node, 'visible') === '0') continue;
      const id = next++;
      if (c.vertex) {
        const r = L.abs.get(c.id);
        if (!r) continue;
        ids.set(c.id, id);
        const W = r.w / 100, H = r.h / 100, ctr = V2({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
        const rot = num(c.style, 'rotation', 0);
        if (c.style.shape() === 'image') notes.push(`${labelText(c) || 'A picture'}: kept as its box`);
        const parts = shapeParts(c, r.w, r.h);
        const geo = parts.map((p, gi) => {
          if (p.ellipse) return `<Section N="Geometry" IX="${gi}">${cell('NoFill', 0)}${cell('NoLine', 0)}<Row T="Ellipse" IX="1">${cell('X', W / 2)}${cell('Y', H / 2)}${cell('A', W)}${cell('B', H / 2)}${cell('C', W / 2)}${cell('D', H)}</Row></Section>`;
          let ix = 1;
          const rows = p.pts.map((sp) => sp.map((q, k) => `<Row T="${k ? 'LineTo' : 'MoveTo'}" IX="${ix++}">${cell('X', q.x / 100)}${cell('Y', H - q.y / 100)}</Row>`).join('')).join('');
          return `<Section N="Geometry" IX="${gi}">${cell('NoFill', p.fill ? 0 : 1)}${cell('NoLine', p.line ? 0 : 1)}${rows}</Section>`;
        }).join('');
        shapes.push(`<Shape ID="${id}" NameU="Shape${id}" Name="Shape${id}" Type="Shape">${cell('PinX', ctr.x, 'IN')}${cell('PinY', ctr.y, 'IN')}${cell('Width', W, 'IN')}${cell('Height', H, 'IN')}${cell('LocPinX', W / 2, 'IN')}${cell('LocPinY', H / 2, 'IN')}${cell('Angle', (-rot * Math.PI) / 180, 'RAD')}${looks(c, false)}${textBox(c, W, H)}${geo}${textXml(c)}</Shape>`);
      } else {
        const route = edgeRoute(c, L).map(V2);
        if (route.length < 2) continue;
        const b = route[0]!, e = route[route.length - 1]!;
        const len = Math.hypot(e.x - b.x, e.y - b.y) || 0.0001, ang = Math.atan2(e.y - b.y, e.x - b.x);
        const loc = (q: V) => ({ x: (q.x - b.x) * Math.cos(-ang) - (q.y - b.y) * Math.sin(-ang), y: (q.x - b.x) * Math.sin(-ang) + (q.y - b.y) * Math.cos(-ang) });
        const rows = route.map((q, k) => { const l = loc(q); return `<Row T="${k ? 'LineTo' : 'MoveTo'}" IX="${k + 1}">${cell('X', l.x)}${cell('Y', l.y)}</Row>`; }).join('');
        const arrow = (k: string, def: string) => ((look(c.style, k) ?? def) === 'none' ? 0 : 4);
        shapes.push(`<Shape ID="${id}" NameU="Connector${id}" Name="Connector${id}" Type="Shape">${cell('PinX', (b.x + e.x) / 2, 'IN')}${cell('PinY', (b.y + e.y) / 2, 'IN')}${cell('Width', len, 'IN')}${cell('Height', 0, 'IN')}${cell('LocPinX', len / 2, 'IN')}${cell('LocPinY', 0, 'IN')}${cell('Angle', ang, 'RAD')}`
          + `${cell('BeginX', b.x, 'IN')}${cell('BeginY', b.y, 'IN')}${cell('EndX', e.x, 'IN')}${cell('EndY', e.y, 'IN')}${cell('ObjType', 2)}${cell('BeginArrow', arrow('startArrow', 'none'))}${cell('EndArrow', arrow('endArrow', 'classic'))}${looks(c, true)}${textBox(c, len, 0, ang)}`
          + `<Section N="Geometry" IX="0">${cell('NoFill', 1)}${cell('NoLine', 0)}${rows}</Section>${textXml(c)}</Shape>`);
        ids.set(c.id, id);
      }
    }
    // Connectors glued to the shapes they join
    for (const c of list) {
      if (!c.edge || !ids.has(c.id)) continue;
      const me = ids.get(c.id)!;
      if (c.source && ids.has(c.source) && L.byId.get(c.source)?.vertex) connects.push(`<Connect FromSheet="${me}" FromCell="BeginX" FromPart="9" ToSheet="${ids.get(c.source)}" ToCell="PinX" ToPart="3"/>`);
      if (c.target && ids.has(c.target) && L.byId.get(c.target)?.vertex) connects.push(`<Connect FromSheet="${me}" FromCell="EndX" FromPart="12" ToSheet="${ids.get(c.target)}" ToCell="PinX" ToPart="3"/>`);
    }
    const name = pageName(page, pi);
    pagesXml.push(`<Page ID="${pi}" NameU="${esc(name)}" Name="${esc(name)}"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0">${cell('PageWidth', size.w / 100, 'IN')}${cell('PageHeight', PH, 'IN')}${cell('PageScale', 1, 'IN')}${cell('DrawingScale', 1, 'IN')}${cell('DrawingSizeType', 0)}${cell('DrawingScaleType', 0)}</PageSheet><Rel r:id="rId${pi + 1}"/></Page>`);
    rels.push(`<Relationship Id="rId${pi + 1}" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page${pi + 1}.xml"/>`);
    pageFiles.push({ name: `visio/pages/page${pi + 1}.xml`, bytes: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<PageContents ${NS} xml:space="preserve"><Shapes>${shapes.join('')}</Shapes>${connects.length ? `<Connects>${connects.join('')}</Connects>` : ''}</PageContents>`) });
  });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const files = [
    { name: '[Content_Types].xml', bytes: enc(`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>${pageFiles.map((f) => `<Override PartName="/${f.name}" ContentType="application/vnd.ms-visio.page+xml"/>`).join('')}<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`) },
    { name: '_rels/.rels', bytes: enc(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`) },
    { name: 'docProps/app.xml', bytes: enc(`${head}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Konium Designer</Application></Properties>`) },
    { name: 'docProps/core.xml', bytes: enc(`${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(d.name.replace(/\.[^.]+$/, ''))}</dc:title></cp:coreProperties>`) },
    { name: 'visio/document.xml', bytes: enc(`${head}<VisioDocument ${NS} xml:space="preserve"><DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0"/><Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors><FaceNames><FaceName NameU="Arial" UnicodeRanges="-1610612033 1073750139 0 0" CharSets="1073742335 -65536" Panos="2 11 6 4 2 2 2 2 2 4" Flags="325"/></FaceNames><StyleSheets><StyleSheet ID="0" NameU="No Style" Name="No Style">${cell('LineWeight', 0.01041666666666667)}${cell('LineColor', '#000000')}${cell('LinePattern', 1)}${cell('FillForegnd', '#FFFFFF')}${cell('FillPattern', 1)}${cell('VerticalAlign', 1)}<Section N="Character"><Row IX="0">${cell('Font', 'Arial')}${cell('Color', '#000000')}${cell('Size', 0.1666666666666667)}</Row></Section><Section N="Paragraph"><Row IX="0">${cell('HorzAlign', 1)}</Row></Section></StyleSheet></StyleSheets></VisioDocument>`) },
    { name: 'visio/_rels/document.xml.rels', bytes: enc(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/></Relationships>`) },
    { name: 'visio/pages/pages.xml', bytes: enc(`${head}<Pages ${NS} xml:space="preserve">${pagesXml.join('')}</Pages>`) },
    { name: 'visio/pages/_rels/pages.xml.rels', bytes: enc(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`) },
    ...pageFiles,
  ];
  return { bytes: zip(files), notes };
}
