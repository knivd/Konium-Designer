/**
 * Column widths in lists (panels and dialogs), as AD17's grids: drag the right edge of a column
 * header to size it. The columns are fixed at their widths as shown when the drag starts, so the
 * others stay put; the list scrolls sideways when the columns outgrow it (the header follows).
 * Grids with a header signature (their column names) remember the widths in the browser.
 */
const EDGE = 5;
const KEY = 'konium.cols.';

/** Header cells: a Grid's (dialogs, most panels) or the List panel's sort buttons. */
const HEAD = '.grid-head > span, .list-headrow > button';
const headCells = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>(':scope > .grid-head > span, :scope > .list-headrow > button')];
const signature = (grid: HTMLElement) => headCells(grid).map((s) => s.textContent?.trim() ?? '').join('|');

/** Widths remembered for a grid with these column names (px), or null. */
export function savedWidths(labels: string[]): number[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + labels.join('|')) ?? 'null') as number[] | null;
    return Array.isArray(v) && v.length === labels.length && v.every((n) => typeof n === 'number' && n > 0) ? v : null;
  } catch { return null; }
}
function save(grid: HTMLElement, widths: number[]): void {
  try { localStorage.setItem(KEY + signature(grid), JSON.stringify(widths.map((w) => Math.round(w)))); } catch { /* private mode */ }
}

const installed = new WeakSet<Document>();
/** Column edges draggable in a document's grids (the main window's, and each document window's); returns what undoes it. */
export function installColumnResize(document: Document | undefined = typeof window !== 'undefined' ? window.document : undefined): () => void {
  if (!document || installed.has(document)) return () => undefined;
  installed.add(document);
  const window = (document.defaultView ?? globalThis.window) as Window;
  const edgeOf = (e: MouseEvent): { cell: HTMLElement; grid: HTMLElement } | null => {
    const cell = (e.target as HTMLElement | null)?.closest?.(HEAD) as HTMLElement | null;
    const grid = cell?.parentElement?.parentElement;
    if (!cell || !(grid?.classList.contains('grid') || grid?.classList.contains('list-grid'))) return null;
    const r = cell.getBoundingClientRect();
    return r.right - e.clientX <= EDGE && e.clientX <= r.right + 1 ? { cell, grid } : null;
  };
  const hover = (e: MouseEvent) => {
    if (e.buttons) return;
    const head = (e.target as HTMLElement | null)?.closest?.('.grid-head, .list-headrow') as HTMLElement | null;
    if (head) head.style.cursor = edgeOf(e) ? 'col-resize' : '';
  };
  const press = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const hit = edgeOf(e);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    const cells = headCells(hit.grid);
    const k = cells.indexOf(hit.cell);
    const widths = cells.map((c) => c.getBoundingClientRect().width);
    const x0 = e.clientX, w0 = widths[k]!;
    const apply = () => hit.grid.style.setProperty('--cols', widths.map((w) => `${Math.round(w)}px`).join(' '));
    apply();
    const move = (m: MouseEvent) => { widths[k] = Math.max(24, w0 + m.clientX - x0); apply(); };
    const up = () => {
      window.removeEventListener('mousemove', move, true); window.removeEventListener('mouseup', up, true); save(hit.grid, widths);
      // The press was a resize, not a click on the header (the List panel sorts on a click)
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, true), 0);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };
  // The header scrolls sideways with the list
  const scroll = (e: Event) => {
    const body = e.target as HTMLElement;
    if (!body?.classList?.contains('grid-body')) return;
    const head = body.parentElement?.querySelector<HTMLElement>(':scope > .grid-head');
    if (head) head.scrollLeft = body.scrollLeft;
  };
  document.addEventListener('mousemove', hover, true);
  document.addEventListener('mousedown', press, true);
  document.addEventListener('scroll', scroll, true);
  return () => {
    installed.delete(document);
    try { document.removeEventListener('mousemove', hover, true); document.removeEventListener('mousedown', press, true); document.removeEventListener('scroll', scroll, true); } catch { /* closed */ }
  };
}
