/**
 * A diagram page drawn on its own, for export and print: the cells shown (all, or those picked)
 * as SVG with nothing of the editor's (no grid, handles or selection), then as SVG, a PNG at a
 * scale (the canvas drawing that SVG), or pages to print (Save as PDF in the print dialog).
 */
import { render } from 'preact';
import { attr, labelPoint, cells, drawOrder, edgeRoute, extent, labelSource, labelText, layers, layout, type Cell, type DiagramPage, type Rect } from '../../formats/drawio';
import { EdgeText, EdgeView, look, num, ShadowDef, ShapeView } from './render';
import { crossings } from './geometry';
import { pageLayout, pageSize } from './ops';
import { NO_SCRIPT } from '../../core/reportHtml';

export interface ExportOpts { border: number; transparent: boolean; only?: Set<string>; area?: Rect }

/** The cells to draw: on shown layers, and (when `only`) those picked and everything in them. */
function chosen(page: DiagramPage, only?: Set<string>): { list: Cell[]; keep: (c: Cell) => boolean } {
  const list = drawOrder(cells(page));
  const L = layout(list);
  const hidden = new Set(layers(page).filter((l) => !l.visible).map((l) => l.id));
  const layerOf = (c: Cell): string => { let x: Cell | undefined = c; for (let n = 0; x && n < 60; n++) { const par = L.byId.get(x.parent); if (!par || !par.parent) return x.id; x = par; } return ''; };
  const inside = (c: Cell) => { for (let x: Cell | undefined = c, n = 0; x && n < 60; x = L.byId.get(x.parent), n++) if (only!.has(x.id)) return true; return false; };
  const keep = (c: Cell) => (c.vertex || c.edge) && !hidden.has(layerOf(c)) && attr(c.node, 'visible') !== '0' && (!only || inside(c) || (!!c.relative && !!L.byId.get(c.parent) && inside(L.byId.get(c.parent)!)));
  return { list, keep };
}

/** The page (or the cells picked) as an SVG document, with a border round what is drawn. */
export function diagramSvg(page: DiagramPage, o: ExportOpts): { svg: string; w: number; h: number } {
  const { list, keep } = chosen(page, o.only);
  const L = layout(list);
  const shown = list.filter(keep);
  const box = o.area ?? extent(shown.filter((c) => !(c.vertex && c.relative)), L) ?? { x: 0, y: 0, w: 1, h: 1 };
  const b = { x: box.x - o.border, y: box.y - o.border, w: box.w + 2 * o.border, h: box.h + 2 * o.border };
  const bg = attr(page.model, 'background');
  const shadow = attr(page.model, 'shadow') === '1';
  const uid = 'x';
  const routes = new Map<string, ReturnType<typeof edgeRoute>>();
  const routeOf = (c: Cell) => { let r = routes.get(c.id); if (!r) { r = edgeRoute(c, L); routes.set(c.id, r); } return r; };
  const host = document.createElement('div');
  render(
    <svg xmlns="http://www.w3.org/2000/svg" width={Math.ceil(b.w)} height={Math.ceil(b.h)} viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`}>
      <defs><ShadowDef uid={uid} /></defs>
      {!o.transparent && <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={bg && bg !== 'none' ? bg : '#ffffff'} />}
      {shown.map((c) => {
        if (c.edge) {
          const route = routeOf(c);
          const before: ReturnType<typeof edgeRoute>[] = [];
          if ((look(c.style, 'jumpStyle') ?? 'none') !== 'none') for (const x of shown) { if (x.id === c.id) break; if (x.edge) before.push(routeOf(x)); }
          return <EdgeView key={c.id} c={c} route={route} uid={uid} shadow={shadow} jumps={before.length ? crossings(route, before) : undefined} />;
        }
        if (c.relative) {
          const par = L.byId.get(c.parent);
          if (!par?.edge) return null;
          const at = labelPoint(routeOf(par), c.rect.x, c.rect.y);
          return <EdgeText key={c.id} at={{ x: at.x + (c.offset?.x ?? 0), y: at.y + (c.offset?.y ?? 0) }} text={labelText(c)} s={c.style} size={num(c.style, 'fontSize', 11)} raw={labelSource(c)} />;
        }
        const r = L.abs.get(c.id);
        return r ? <ShapeView key={c.id} c={c} r={r} uid={uid} shadow={shadow} /> : null;
      })}
    </svg>, host);
  let svg = host.innerHTML;
  render(null, host);
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, w: b.w, h: b.h };
}

/** An SVG drawn as a PNG at a scale (its pixels × scale). */
export async function svgToPng(svg: string, w: number, h: number, scale: number): Promise<Uint8Array> {
  const img = new Image();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('The diagram couldn\'t be drawn as a picture')); img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
  const g = canvas.getContext('2d')!;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
  if (!blob) throw new Error('The picture couldn\'t be made');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The page's pages to print: in page view, each page of its paper with what is on it (empty ones
 * left out); else everything fitted on one page of its paper.
 */
export function printPagesHtml(page: DiagramPage, paged: boolean): string {
  const size = pageSize(page.model);
  const { list, keep } = chosen(page);
  const L = layout(list);
  const content = extent(list.filter((c) => keep(c) && !(c.vertex && c.relative)), L);
  const areas = paged ? pageLayout(size, content).filter((a) => !content || list.some((c) => { const r = c.vertex ? L.abs.get(c.id) : undefined; return keep(c) && !!r && r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y; })) : [content ?? { x: 0, y: 0, w: size.w, h: size.h }];
  // The paper in mm (its units are 1/100 inch), the way it is turned
  const mm = (v: number) => Math.round(v * 0.254 * 10) / 10;
  const pw = mm(size.w), ph = mm(size.h);
  const art = areas.map((a) => `<div class="page">${diagramSvg(page, { border: paged ? 0 : 10, transparent: false, area: a }).svg.replace(/^<\?xml[^>]*>\s*/, '')}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">${NO_SCRIPT}<title>Diagram</title><style>
@page { size: ${pw}mm ${ph}mm; margin: 0; }
html, body { margin: 0; background: #fff; }
.page { width: ${pw}mm; height: ${ph}mm; display: flex; align-items: center; justify-content: center; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.page svg { display: block; max-width: 100%; max-height: 100%; width: 100%; height: 100%; }
</style></head><body>${art}</body></html>`;
}

/** One SVG on a page its own size (in mm at 96 px to the inch), to print or save as PDF. */
export function pdfHtml(svg: string, w: number, h: number): string {
  const mm = (v: number) => Math.round(v * 0.2645833 * 10) / 10;
  return `<!doctype html><html><head><meta charset="utf-8">${NO_SCRIPT}<title>Diagram</title><style>
@page { size: ${mm(w)}mm ${mm(h)}mm; margin: 0; }
html, body { margin: 0; background: #fff; }
svg { display: block; width: ${mm(w)}mm; height: ${mm(h)}mm; }
</style></head><body>${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`;
}
