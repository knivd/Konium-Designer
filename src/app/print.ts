/**
 * File › Page Setup, Print Preview, Print and Smart PDF: each document drawn as SVG from the
 * same display list the screen uses, laid on pages of the chosen paper and orientation, Fit
 * Document or at a scale, in colour, grey or black and white — then the browser's print, whose
 * "Save as PDF" makes the PDF.
 */
import type { BBox } from '../core/geom';
import type { Editor } from '../editors/Editor';
import { SchEditor } from '../editors/sch/SchEditor';
import { sceneToSvg } from '../render/svgExport';
import { printJobPages } from '../render/pcbPrint';
import { jobFor } from '../model/printouts';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { notify, type OpenDoc } from './state';
import { NO_SCRIPT } from '../core/reportHtml';

export const PAPERS: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], Letter: [279.4, 215.9], Legal: [355.6, 215.9], Tabloid: [431.8, 279.4] };

export interface PageSetup {
  paper: keyof typeof PAPERS | string;
  orientation: 'landscape' | 'portrait';
  /** Fit Document, or a scale (1 = 1:1 in real size). */
  fit: boolean;
  scale: number;
  colours: 'colour' | 'grey' | 'mono';
  /** Margins in mm. */
  margin: number;
}
export const pageSetup: PageSetup = { paper: 'A4', orientation: 'landscape', fit: true, scale: 1, colours: 'colour', margin: 10 };

/** What a page shows: the sheet (schematic) or everything (board, library). */
function pageBox(ed: Editor): BBox {
  if (ed instanceof SchEditor && !ed.libraryMode) return { minX: 0, minY: 0, maxX: ed.doc.sheet.width, maxY: ed.doc.sheet.height };
  const b = ed.fitBounds();
  const m = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.03;
  return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
}

/** One document as an SVG page body (sized by CSS to the printable area). */
export function documentSvg(ed: Editor, setup: PageSetup = pageSetup): string {
  const box = pageBox(ed);
  // About 0.1 mm hairlines at Fit Document on the paper
  const [pw] = paperMm(setup);
  const minStroke = ((box.maxX - box.minX) / Math.max(1, pw - 2 * setup.margin)) * 0.12;
  return sceneToSvg(ed.scene(), box, { minStroke, colours: setup.colours, skip: (k) => k === 'masked' });
}

export function paperMm(s: PageSetup): [number, number] {
  const [a, b] = PAPERS[s.paper] ?? PAPERS.A4!;
  return s.orientation === 'landscape' ? [a, b] : [b, a];
}

/** Real size of the drawing in mm (internal units: 10 000 per mil). */
const mmOf = (units: number) => (units / 10_000) * 0.0254;

/** A page to print: an SVG of the drawing and the area it covers (board units, 10 000 per mil). */
export interface Page { name: string; svg: string; box: BBox }

/** The pages of the open documents: a board prints its PCB Prints job (printouts), anything else its view. */
export function documentPages(list: { name: string; ed: Editor }[], s: PageSetup = pageSetup): Page[] {
  return list.flatMap(({ name, ed }) => {
    if (ed instanceof PcbEditor && !(ed instanceof PcbLibEditor)) return printJobPages(ed.doc, jobFor(ed.doc, 'pcb'), s.colours).map((p) => ({ ...p, name: `${name} - ${p.name}` }));
    return [{ name, svg: documentSvg(ed, s), box: pageBox(ed) }];
  });
}

export function pagesHtml(list: { name: string; ed: Editor }[], s: PageSetup = pageSetup): string {
  return svgPagesHtml(documentPages(list, s), s);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pages laid on paper: Fit Document fills the printable area, a scaled print is the real size times the scale. */
export function svgPagesHtml(pages: Page[], s: PageSetup = pageSetup): string {
  const [pw, ph] = paperMm(s);
  const html = pages.map(({ name, svg, box }) => {
    const size = s.fit ? `width:${pw - 2 * s.margin}mm;height:${ph - 2 * s.margin}mm`
      : `width:${mmOf(box.maxX - box.minX) * s.scale}mm;height:${mmOf(box.maxY - box.minY) * s.scale}mm`;
    return `<section class="page" title="${esc(name)}"><div class="art" style="${size}">${svg}</div></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8">${NO_SCRIPT}<title>${esc([...new Set(pages.map((x) => x.name))].join(', '))}</title><style>
@page { size: ${pw}mm ${ph}mm; margin: ${s.margin}mm; }
html, body { margin: 0; background: #fff; }
.page { page-break-after: always; break-after: page; display: flex; align-items: center; justify-content: center; width: ${pw - 2 * s.margin}mm; height: ${ph - 2 * s.margin}mm; overflow: hidden; }
.page:last-child { page-break-after: auto; break-after: auto; }
.art svg { display: block; width: 100%; height: 100%; }
</style></head><body>${html}</body></html>`;
}

/** Print pages through a hidden frame (the browser's dialog offers printers and Save as PDF). */
export function printPages(pages: Page[], s: PageSetup = pageSetup): void {
  if (!pages.length) { notify('Nothing to print', 'error'); return; }
  printHtml(svgPagesHtml(pages, s));
}

/** Print through a hidden frame (no pop-up), the browser's dialog offering printers and Save as PDF. */
export function printDocs(list: OpenDoc[], s: PageSetup = pageSetup): void {
  const eds = list.filter((d) => d.editor).map((d) => ({ name: d.name, ed: d.editor! }));
  if (!eds.length) { notify('Nothing to print', 'error'); return; }
  printHtml(pagesHtml(eds, s));
}

/** Print an HTML page through a hidden frame (reports, the Messages list). */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const w = frame.contentWindow!;
  w.document.open(); w.document.write(html); w.document.close();
  const done = () => setTimeout(() => frame.remove(), 1000);
  w.addEventListener('afterprint', done);
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) { notify(`Print failed: ${(e as Error).message}`, 'error'); } done(); }, 250);
}
