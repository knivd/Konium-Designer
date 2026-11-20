/**
 * A Draftsman document (.PCBDwf) open in its tab: its sheets one below another, each with its
 * views, tables and text drawn from the project's board. Click an item to pick it, drag it to
 * move it (to the document's grid); Delete removes it; Ctrl+Z / Ctrl+Y undo and redo. The bar
 * places new items (Board Assembly View, Board Fabrication View, Drill Table, Bill of Materials,
 * Layer Stack Table, Text, Title Block) in the middle of the sheet in view, adds or removes a
 * sheet, changes its size, zooms and prints. The side shows the picked item's properties (place,
 * scale, side, rotation, title, text), or the document's (its board and parameters).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { docs, notify, projects, tick, type OpenDoc } from './state';
import type { PcbDocument } from '../model/pcb';
import { readPcbDoc } from '../formats/altium/pcbdoc';
import {
  PLACE_LABELS, PX_PER_MM, SHEETS, addPage, draftPages, draftParameter, draftSourceBoard, itemLocation, itemRotation, itemScale, itemSide, itemType, moveItem,
  placeItem, redoDraft, removeItem, removePage, scaleText, setDraftParameter, setItemScale, setItemValues, setPageSize, undoDraft, type DraftDocument, type PlaceKind,
} from '../formats/altium/pcbdwf';
import { xkid, xnum, xstr, type XNode } from '../formats/xmlTree';
import { drawPage, printablePage, type DrawnItem } from '../render/draftDoc';
import { printPages } from './print';
import { winOf } from './docWindows';

const boardsRead = new WeakMap<Uint8Array, PcbDocument | null>();
/** The board a drawing shows: its source in the project (open or read from the project's files), else the project's board, else any open one. */
export function draftBoardOf(od: OpenDoc): PcbDocument | null {
  const d = od.doc as DraftDocument;
  const name = draftSourceBoard(d).toLowerCase();
  const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) ?? null : null;
  const open = (n?: string) => docs.value.find((x) => x.doc.kind === 'PcbDoc' && (x.projectId ?? null) === (od.projectId ?? null) && (!n || x.name.toLowerCase() === n))?.doc as PcbDocument | undefined;
  const fromFile = (n: string) => {
    const f = p?.files.get(n);
    if (!f) return null;
    let b = boardsRead.get(f.bytes);
    if (b === undefined) { try { b = readPcbDoc(f.bytes, f.name); } catch { b = null; } boardsRead.set(f.bytes, b); }
    return b;
  };
  if (name) { const b = open(name) ?? fromFile(name); if (b) return b; }
  const first = p?.prj.documents.map((x) => x.split(/[\\/]/).pop()!.toLowerCase()).find((n) => n.endsWith('.pcbdoc'));
  if (first) { const b = open(first) ?? fromFile(first); if (b) return b; }
  // A drawing in a project draws the project's board; a free one only the board it names
  return p ? open() ?? null : null;
}

const SCALES = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 4, 5, 10];
const fmm = (px: number) => +(px / PX_PER_MM).toFixed(2);

export function DraftView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as DraftDocument;
  const [rev, setRev] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [sel, setSel] = useState<{ page: number; node: XNode } | null>(null);
  const [front, setFront] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const board = draftBoardOf(od);
  const pages = draftPages(d);
  const when = useMemo(() => new Date(), [rev]);
  const drawn = useMemo(() => pages.map((p, i) => drawPage(d, p, { board, pageNo: i + 1, pages: pages.length, when, docName: d.name })), [rev, board?.prims, pages.length]);
  const changed = () => { d.dirty = true; setRev((r) => r + 1); tick.value++; };
  // Fit the first sheet's width at first
  useEffect(() => {
    if (zoom || !host.current || !pages.length) return;
    setZoom(Math.max(0.2, Math.min(2, (host.current.clientWidth - 40) / pages[0]!.w)));
  }, [pages.length]);
  const z = zoom || 0.8;
  const grid = xnum(xkid(d.root, 'DocumentOptions'), 'GridSize', PX_PER_MM) || PX_PER_MM;
  const snap = (v: number) => Math.round(v / grid) * grid;
  const selItem: DrawnItem | undefined = sel ? drawn[sel.page]?.items.find((x) => x.node === sel.node) : undefined;

  const place = (kind: PlaceKind) => {
    const pi = Math.min(front, pages.length - 1);
    const p = pages[pi];
    if (!p) { notify('Add a sheet first', 'error'); return; }
    const k = PX_PER_MM;
    const at = kind === 'titleBlock' ? { x: p.w - p.margin - 5 * k - 120 * k - 2 * k, y: p.h - p.margin - 5 * k - 36 * k - 2 * k } : { x: snap(p.w * 0.3), y: snap(p.h * 0.3) };
    const it = placeItem(d, p.node, kind, at.x, at.y, { board: board?.name ?? draftSourceBoard(d), scale: 1, side: 'Top', text: kind === 'text' ? 'Text' : undefined });
    setSel({ page: pi, node: it });
    changed();
  };
  const del = () => { if (!sel) return; removeItem(d, pages[sel.page]!.node, sel.node); setSel(null); changed(); };
  const undo = () => { const l = undoDraft(d); if (l) { setSel(null); changed(); } };
  const redo = () => { const l = redoDraft(d); if (l) { setSel(null); changed(); } };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape') setSel(null);
  };
  /** Dragging an item: the drawn group moves with the pointer, the move is one change on release. */
  const startDrag = (e: PointerEvent, pi: number, it: DrawnItem, idx: number) => {
    e.preventDefault(); e.stopPropagation();
    setSel({ page: pi, node: it.node }); setFront(pi);
    (host.current as HTMLElement | null)?.focus({ preventScroll: true });
    const g = host.current?.querySelector(`[data-page="${pi}"] g[data-item="${idx}"]`) as SVGGElement | null;
    const box = (e.currentTarget as HTMLElement);
    const window = winOf(e);
    const x0 = e.clientX, y0 = e.clientY, loc = itemLocation(it.node);
    let dx = 0, dy = 0;
    const move = (ev: PointerEvent) => {
      dx = snap(loc.x + (ev.clientX - x0) / z) - loc.x; dy = snap(loc.y + (ev.clientY - y0) / z) - loc.y;
      g?.setAttribute('transform', `translate(${dx} ${dy})`);
      box.style.transform = `translate(${dx * z}px, ${dy * z}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      box.style.transform = '';
      if (dx || dy) { moveItem(d, it.node, loc.x + dx, loc.y + dy); changed(); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const print = () => {
    const out = pages.map((p, i) => printablePage(d, p, { board, pageNo: i + 1, pages: pages.length, when: new Date(), docName: d.name }));
    const first = pages[0];
    const paper = first ? (Object.entries(SHEETS).find(([, [w, h]]) => Math.abs(w * PX_PER_MM - first.w) < 2 && Math.abs(h * PX_PER_MM - first.h) < 2)?.[0] ?? 'A3') : 'A3';
    printPages(out, { paper, orientation: 'landscape', fit: true, scale: 1, colours: 'mono', margin: 0 });
  };
  const fp = pages[Math.min(front, pages.length - 1)];
  return (
    <div class="draftdoc" aria-label={`Draftsman document ${d.name}`}>
      <div class="dd-bar" role="toolbar" aria-label="Draftsman">
        {(Object.keys(PLACE_LABELS) as PlaceKind[]).map((k) => <button key={k} class="btn" onClick={() => place(k)} title={`Place a ${PLACE_LABELS[k]} on sheet ${Math.min(front, pages.length - 1) + 1}`}>{PLACE_LABELS[k]}</button>)}
        <span class="dd-sep" />
        <label class="dd-size">Sheet {fp ? Math.min(front, pages.length - 1) + 1 : ''}
          <select aria-label="Sheet size" value={fp?.sizeName && SHEETS[fp.sizeName] ? fp.sizeName : ''} disabled={!fp} onChange={(e) => { if (fp) { setPageSize(d, fp.node, (e.target as HTMLSelectElement).value); changed(); } }}>
            {fp && !SHEETS[fp.sizeName] && <option value="">{fmm(fp.w)} × {fmm(fp.h)} mm</option>}
            {Object.keys(SHEETS).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button class="btn" onClick={() => { addPage(d, fp?.sizeName && SHEETS[fp.sizeName] ? fp.sizeName : 'A3'); setFront(pages.length); changed(); }}>Add Sheet</button>
        <button class="btn" disabled={pages.length < 2} onClick={() => { if (fp) { removePage(d, fp.node); setSel(null); setFront(0); changed(); } }}>Delete Sheet</button>
        <span class="dd-sep" />
        <button class="btn" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.1, z / 1.25))}>−</button>
        <button class="btn" onClick={() => host.current && fp && setZoom((host.current.clientWidth - 40) / fp.w)}>Fit</button>
        <button class="btn" aria-label="Zoom in" onClick={() => setZoom(Math.min(8, z * 1.25))}>+</button>
        <span class="spacer" />
        <button class="btn" disabled={!d.undo.length} onClick={undo} title="Ctrl+Z">Undo</button>
        <button class="btn" disabled={!d.redo.length} onClick={redo} title="Ctrl+Y">Redo</button>
        <button class="btn" onClick={print}>Print...</button>
      </div>
      <div class="dd-main">
        <div class="dd-pages" ref={host} tabIndex={0} onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)} onPointerDown={() => setSel(null)}>
          {!pages.length && <p class="panel-empty">No sheets: Add Sheet.</p>}
          {pages.map((p, pi) => (
            <div key={pi} class={`dd-page${front === pi ? ' front' : ''}`} data-page={pi} style={{ width: `${p.w * z}px`, height: `${p.h * z}px` }} onPointerDown={() => setFront(pi)}>
              <div class="dd-art" dangerouslySetInnerHTML={{ __html: drawn[pi]?.svg ?? '' }} />
              {drawn[pi]?.items.map((it, idx) => (
                <div key={idx} class={`dd-hit${sel?.node === it.node ? ' on' : ''}`} title={it.label} role="button" aria-label={it.label}
                  style={{ left: `${it.box.x * z}px`, top: `${it.box.y * z}px`, width: `${Math.max(6, it.box.w * z)}px`, height: `${Math.max(6, it.box.h * z)}px` }}
                  onPointerDown={(e) => startDrag(e as unknown as PointerEvent, pi, it, idx)} />
              ))}
            </div>
          ))}
        </div>
        <aside class="dd-props" aria-label="Properties">
          {sel && selItem ? <ItemProps d={d} it={selItem} onChange={changed} onDelete={del} /> : <DocProps d={d} board={board} onChange={changed} />}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, onCommit, area }: { label: string; value: string; onCommit: (v: string) => void; area?: boolean }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => { if (t !== value) onCommit(t); };
  return (
    <label class="dd-field">{label}
      {area ? <textarea rows={4} value={t} onInput={(e) => setT((e.target as HTMLTextAreaElement).value)} onBlur={commit} onKeyDown={(e) => e.stopPropagation()} />
        : <input type="text" value={t} onInput={(e) => setT((e.target as HTMLInputElement).value)} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); }} />}
    </label>
  );
}

function ItemProps({ d, it, onChange, onDelete }: { d: DraftDocument; it: DrawnItem; onChange: () => void; onDelete: () => void }) {
  const n = it.node;
  const loc = itemLocation(n);
  const type = itemType(n);
  const view = /^Board(Assembly|Fabrication)ViewData$/.test(type);
  const has = (p: string) => !!xkid(n, p);
  const set = (v: Record<string, string | number>, label: string) => { setItemValues(d, n, v, label); onChange(); };
  const s = itemScale(n);
  return (
    <div class="dd-propform">
      <h3>{it.label}</h3>
      <p class="muted small">{type}</p>
      <div class="dd-two">
        <Field label="X (mm)" value={String(fmm(loc.x))} onCommit={(v) => { const x = Number(v); if (Number.isFinite(x)) { moveItem(d, n, x * PX_PER_MM, loc.y); onChange(); } }} />
        <Field label="Y (mm)" value={String(fmm(loc.y))} onCommit={(v) => { const y = Number(v); if (Number.isFinite(y)) { moveItem(d, n, loc.x, y * PX_PER_MM); onChange(); } }} />
      </div>
      {view && (
        <>
          <label class="dd-field">Scale
            <select value={SCALES.find((x) => Math.abs(x - s) < 1e-6) !== undefined ? String(s) : 'custom'} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== 'custom') { setItemScale(d, n, Number(v)); onChange(); } }}>
              {SCALES.map((x) => <option key={x} value={String(x)}>{scaleText(x)}</option>)}
              {SCALES.every((x) => Math.abs(x - s) >= 1e-6) && <option value="custom">{scaleText(s)}</option>}
            </select>
          </label>
          {type === 'BoardAssemblyViewData' && (
            <label class="dd-field">View Side
              <select value={itemSide(n)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; set({ ViewSide: v, ViewSideV2: v === 'Bottom' ? 1 : 0 }, 'View Side'); }}>
                <option value="Top">Top</option><option value="Bottom">Bottom</option>
              </select>
            </label>
          )}
          {has('Rotation') && (
            <label class="dd-field">Rotation
              <select value={String(itemRotation(n))} onChange={(e) => { const r = Number((e.target as HTMLSelectElement).value); set({ Rotation: `Ccw${r}`, ...(has('RotationV2') ? { RotationV2: r / 90 } : {}) }, 'Rotation'); }}>
                {[0, 90, 180, 270].map((r) => <option key={r} value={String(r)}>{r}°</option>)}
              </select>
            </label>
          )}
        </>
      )}
      {has('ShowTitle') && <label class="dd-check"><input type="checkbox" checked={xstr(n, 'ShowTitle', 'true') !== 'false'} onChange={(e) => set({ ShowTitle: (e.target as HTMLInputElement).checked ? 'true' : 'false' }, 'Show Title')} />Show Title</label>}
      {has('Title') && <Field label="Title" value={xstr(n, 'Title')} onCommit={(v) => set({ Title: v }, 'Title')} />}
      {has('Text') && <Field label="Text" area value={xstr(n, 'Text')} onCommit={(v) => set({ Text: v }, 'Text')} />}
      {view && <p class="muted small">=ViewSide and =ViewScale in a title are the view's side and scale; =Title, =Revision and the rest the document's parameters.</p>}
      <button class="btn" onClick={onDelete}>Delete</button>
    </div>
  );
}

function DocProps({ d, board, onChange }: { d: DraftDocument; board: PcbDocument | null; onChange: () => void }) {
  return (
    <div class="dd-propform">
      <h3>Document</h3>
      <p class="small">Board: <b>{board?.name ?? '(none: open its PCB in the project)'}</b>{draftSourceBoard(d) && board && board.name.toLowerCase() !== draftSourceBoard(d).toLowerCase() ? ` (the drawing names ${draftSourceBoard(d)})` : ''}</p>
      {['Title', 'Revision', 'DrawnBy'].map((k) => <Field key={k} label={k === 'DrawnBy' ? 'Drawn by' : k} value={draftParameter(d, k)} onCommit={(v) => { setDraftParameter(d, k, v); onChange(); }} />)}
      <p class="muted small">Pick an item to change it; drag it to move it.</p>
    </div>
  );
}
