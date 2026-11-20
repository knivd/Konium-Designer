/**
 * A datasheet PDF in the browser (pdf.js, Apache 2.0): its pages' text, pictures of pages, its
 * fingerprint (SHA-256: the shared cache's key), and the pages worth sending when a model can't
 * take them all. pdf.js travels inside Konium compressed (vite.config.ts's virtual:pdfjs) and is
 * unpacked the first time a datasheet is opened, so it costs nothing until then and works offline.
 */
import type { PageText } from './jobs';
import type { Grey } from './snap';
import { pathSegments, type Seg } from './vector';

/** Part of a page: fractions of its width and height from the top left. */
export interface Crop { x0: number; y0: number; x1: number; y1: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfJs = any;
let lib: Promise<PdfJs> | null = null;

async function gunzipText(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** pdf.js: unpacked from Konium itself in a browser; the package's own build under Node (tests). */
export function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    if (typeof document === 'undefined') {
      const spec = 'pdfjs-dist/legacy/build/pdf.mjs';
      return await import(/* @vite-ignore */ spec);
    }
    const packed = await import('virtual:pdfjs');
    const url = async (b64: string) => URL.createObjectURL(new Blob([await gunzipText(b64)], { type: 'text/javascript' }));
    const [main, worker] = await Promise.all([url(packed.main), url(packed.worker)]);
    const m = await import(/* @vite-ignore */ main);
    m.GlobalWorkerOptions.workerSrc = worker;
    return m;
  })();
  return lib;
}

export interface Datasheet {
  name: string;
  pageCount: number;
  /** SHA-256 of the file, hex. */
  fingerprint: string;
  /** The title the PDF gives itself, if any. */
  title: string;
  text(page: number): Promise<string>;
  /** A picture of a page, or of part of it (`crop`, fractions of the page from the top left), as a data URL (PNG, or JPEG when asked), its longer side `px` pixels (browser only). */
  picture(page: number, px: number, type?: 'image/png' | 'image/jpeg', crop?: Crop): Promise<string>;
  /** The same in grey, as numbers (for measuring a drawing). */
  grey(page: number, px: number, crop?: Crop): Promise<Grey>;
  /** The lines the page draws there (its paths; curves in short pieces), in the pixels of the same picture: a vector drawing's exact edges. */
  segments(page: number, px: number, crop?: Crop): Promise<Seg[]>;
  /** How a page is drawn: its text, its paths, and how much of it pictures cover. */
  layout(page: number): Promise<PageLayout>;
  close(): void;
}

/** A page's make-up: characters of text, paths drawn (lines, curves, shapes), and the share of the page under pictures (0–1). */
export interface PageLayout { chars: number; paths: number; cover: number }

/**
 * A page that is mostly a drawing (a package outline, a land pattern): many paths for its text
 * (tables have about one per word), or largely a picture with little text [est: from datasheets'
 * package pages; a waveform figure counts too].
 */
export const isDrawing = (l: PageLayout) => (l.paths >= 400 && l.paths >= 2 * l.chars) || (l.cover >= 0.2 && l.chars < 600);

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function openDatasheet(bytes: Uint8Array, name: string): Promise<Datasheet> {
  const fp = await fingerprint(bytes);
  const m = await pdfjs();
  let doc: any, task: any;
  try {
    // pdf.js takes the buffer over: give it a copy
    task = m.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
    doc = await task.promise;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    throw new Error(/password/i.test(msg) ? `${name} is protected by a password` : `${name} isn't a PDF Konium Designer can read (${msg.slice(0, 120)})`);
  }
  const texts = new Map<number, string>();
  let closed = false;
  /** A page of a datasheet still open (pdf.js's own error after closing says nothing useful). */
  const pageOf = async (n: number) => {
    if (closed) throw new Error('The datasheet was closed: open it again');
    return await doc.getPage(n);
  };
  let title = '';
  try { const meta = await doc.getMetadata(); title = String(meta?.info?.Title ?? '').trim(); } catch { /* none */ }
  const text = async (n: number): Promise<string> => {
    const hit = texts.get(n);
    if (hit !== undefined) return hit;
    const page = await pageOf(n);
    const tc = await page.getTextContent();
    let out = '';
    for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof it.str !== 'string') continue;
      out += it.str + (it.hasEOL ? '\n' : it.str ? ' ' : '');
    }
    const clean = out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    texts.set(n, clean);
    return clean;
  };
  /** A page, or part of it, as a picture with its longer side `px` pixels (at most 12 × the page's size): its viewport and size. */
  const view = async (n: number, px: number, crop?: Crop) => {
    const page = await pageOf(n);
    const v1 = page.getViewport({ scale: 1 });
    const c = crop ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
    const w1 = (c.x1 - c.x0) * v1.width, h1 = (c.y1 - c.y0) * v1.height;
    const scale = Math.min(px / Math.max(w1, h1, 1), 12);
    const vp = page.getViewport({ scale, offsetX: -c.x0 * v1.width * scale, offsetY: -c.y0 * v1.height * scale });
    return { page, vp, w: Math.max(1, Math.ceil(w1 * scale)), h: Math.max(1, Math.ceil(h1 * scale)) };
  };
  /** A page, or part of it, drawn on a canvas with its longer side `px` pixels (white behind). */
  const render = async (n: number, px: number, crop?: Crop): Promise<HTMLCanvasElement> => {
    const { page, vp, w, h } = await view(n, px, crop);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    return canvas;
  };
  return {
    name, pageCount: doc.numPages, fingerprint: fp, title,
    text,
    async layout(n) {
      const page = await pageOf(n);
      const [ol, own] = await Promise.all([page.getOperatorList(), text(n)]);
      const O = m.OPS;
      const v = page.getViewport({ scale: 1 });
      const area = Math.max(1, v.width * v.height);
      // Pictures are painted into a unit square under the current matrix: their area is its determinant
      let paths = 0, cover = 0, det = 1;
      const stack: number[] = [];
      const fns: number[] = ol.fnArray, args: unknown[][] = ol.argsArray;
      const pictures = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat, O.paintInlineImageXObjectGroup].filter((x) => x !== undefined));
      for (let i = 0; i < fns.length; i++) {
        const fn = fns[i];
        if (fn === O.constructPath) paths++;
        else if (fn === O.save) stack.push(det);
        else if (fn === O.restore) det = stack.pop() ?? det;
        else if (fn === O.transform) { const a = args[i] as number[]; det *= a[0]! * a[3]! - a[1]! * a[2]!; }
        else if (fn === O.paintFormXObjectBegin) { stack.push(det); const a = args[i]?.[0] as number[] | null; if (a?.length === 6) det *= a[0]! * a[3]! - a[1]! * a[2]!; }
        else if (fn === O.paintFormXObjectEnd) det = stack.pop() ?? det;
        else if (pictures.has(fn)) cover += Math.abs(det) / area;
      }
      return { chars: own.length, paths, cover: Math.min(1, cover) };
    },
    async picture(n, px, type = 'image/png', crop) {
      const canvas = await render(n, px, crop);
      return type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
    },
    async grey(n, px, crop) {
      const canvas = await render(n, px, crop);
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const out = new Uint8Array(canvas.width * canvas.height);
      for (let i = 0; i < out.length; i++) out[i] = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) >> 8;
      return { width: canvas.width, height: canvas.height, data: out };
    },
    async segments(n, px, crop) {
      const { page, vp, w, h } = await view(n, px, crop);
      const ol = await page.getOperatorList();
      return pathSegments(ol.fnArray, ol.argsArray, m.OPS, vp.transform, w, h);
    },
    // (Closed through its loading task: pdf.js 6's document has no destroy of its own)
    close() { closed = true; void task.destroy(); },
  };
}

/** Every page's text, numbered; pages with little text looked at for drawings (marked `drawing`). */
export async function allText(d: Datasheet, drawings = true): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let n = 1; n <= d.pageCount; n++) {
    const text = await d.text(n);
    let drawing = false;
    if (drawings && text.length < 1500) { try { drawing = isDrawing(await d.layout(n)); } catch { /* text only */ } }
    out.push(drawing ? { page: n, text, drawing } : { page: n, text });
  }
  return out;
}

/** Package words: what makes a drawing page a package's [est]. */
const PACKAGE_WORDS = { test: (t: string) => /package|outline|dimension|mechanical|land pattern|footprint|pcb layout|board layout|pad layout/i.test(t) || /\b(SOT|SOD|SOIC|SOP|TSSOP|SSOP|MSOP|QFN|DFN|WSON|SON|LQFP|TQFP|QFP|BGA|CSP|DIP|SOJ|TSOP|PLCC|TO)[- ]?\d/.test(t) };

/**
 * Pictures worth adding to a survey: drawing pages with (almost) no text of their own (labels
 * drawn as lines, or a pasted picture) that name a package — or any such page of a short
 * datasheet (a connector's drawing) — package pages first, `max` of them.
 */
export function surveyPictures(pages: PageText[], max = 3): number[] {
  const quiet = pages.filter((p) => p.drawing && p.text.length < 300);
  const score = (p: PageText) => (PACKAGE_WORDS.test(p.text) ? 2 : 0) + pageScore(p.text);
  return quiet.map((p) => ({ n: p.page, s: score(p) })).filter((x) => x.s > 0 || pages.length <= 12)
    .sort((a, b) => b.s - a.s || a.n - b.n).slice(0, max).map((x) => x.n).sort((a, b) => a - b);
}

/**
 * The pages a variant's drawing job reads: its drawing and land pattern pages, each with the
 * page after it when that page's text goes on about the package (a dimension table, a land
 * pattern) and isn't another variant's drawing [est].
 */
export function packagePages(pages: PageText[], drawing: number[], land: number[], others: number[] = []): number[] {
  const byPage = new Map(pages.map((p) => [p.page, p]));
  const out = new Set<number>([...drawing, ...land].filter((n) => byPage.has(n)));
  for (const n of [...out]) {
    const next = byPage.get(n + 1);
    if (next && !out.has(n + 1) && !others.includes(n + 1) && PACKAGE_WORDS.test(next.text) && /\b(min|max|nom|typ)\b|±|symbol/i.test(next.text)) out.add(n + 1);
  }
  return [...out].sort((a, b) => a - b).slice(0, 6);
}

/** A PDF with (almost) no text: a scan, which needs pictures of its pages. */
export const hasText = (pages: PageText[]) => pages.reduce((s, p) => s + p.text.length, 0) >= pages.length * 40;

/* ─── Pages worth sending ────────────────────────────────────────────────────────────── */

/** What makes a page useful for finding the variants and their drawings, and how much [est]. */
const HINTS: [RegExp, number][] = [
  [/ordering (information|guide|code)|order(ing)? (number|code)|orderable|part number|device information|package option|product (selection|options)/i, 4],
  [/package (outline|dimension|drawing|information|data)|mechanical (data|drawing|information|dimension)|outline dimension|physical dimension|case outline|\bdimensions?\b/i, 3],
  [/land pattern|footprint|solder (pad|land|mask)|recommended (pcb|layout|pad|land|footprint|mounting)|board layout|pad layout/i, 3],
  [/pin (configuration|description|function|assignment|out|definition)|pinning|pin-?out|terminal (configuration|function)|ball map/i, 3],
  // Package names in capitals only ("to 5 V" isn't TO-5)
  [/\b(SOT|SOD|SOIC|SO|TSSOP|SSOP|MSOP|QFN|DFN|VQFN|WQFN|HVQFN|LQFP|TQFP|QFP|BGA|WLCSP|CSP|TO|DPAK|D2PAK|SON|WSON|USON|LGA|PDIP|DIP)[- ]?\d/, 2],
  [/marking|tape and reel|reel|packaging|package/i, 1],
];

export function pageScore(text: string): number {
  return HINTS.reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0);
}

/**
 * The pages to send, within `budget` characters: all of them when they fit, else the first two
 * (title, features: often the package list) and the pages that look like ordering, package,
 * land pattern and pin pages, best first, then the page after each of them (drawings run on),
 * in page order. Each page's text is cut at `perPage` characters.
 */
export function pickPages(pages: PageText[], budget: number, perPage = 12_000): PageText[] {
  const cut: PageText[] = pages.map((p) => ({ page: p.page, text: p.text.length > perPage ? `${p.text.slice(0, perPage)} …` : p.text, ...(p.drawing ? { drawing: true } : {}) }));
  const total = cut.reduce((s, p) => s + p.text.length, 0);
  if (total <= budget) return cut;
  const byPage = new Map(cut.map((p) => [p.page, p]));
  const chosen = new Set<number>();
  let used = 0;
  const take = (n: number) => {
    const p = byPage.get(n);
    if (!p || chosen.has(n) || used + p.text.length > budget) return;
    chosen.add(n); used += p.text.length;
  };
  take(cut[0]?.page ?? 1); take(cut[1]?.page ?? 2);
  const ranked = cut.map((p, i) => ({ n: p.page, s: pageScore(p.text) + (pages[i]!.drawing && pageScore(p.text) > 0 ? 2 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.n - b.n);
  // The pages that look useful first, then the page after each (drawings run on)
  for (const { n } of ranked) take(n);
  for (const { n } of ranked) take(n + 1);
  return cut.filter((p) => chosen.has(p.page));
}

/** How many characters of datasheet text a mode sends at most [est: a local model's context is often 8–32k tokens]. */
export const TEXT_BUDGET: Record<'konium' | 'key' | 'local', number> = { konium: 240_000, key: 240_000, local: 40_000 };
