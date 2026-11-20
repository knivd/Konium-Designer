import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { savedWidths } from './columnResize';

/**
 * Desktop-style modal dialog: title bar you can drag, Esc cancels, Enter triggers the default
 * button (unless typing in a multi-line field), focus moves inside on open and returns after.
 * Every Konium dialog uses this so they behave the same way Altium's do.
 */
export interface DialogProps {
  title: string;
  onClose: () => void;
  /** Called on Enter. Return false to keep the dialog open. */
  onAccept?: () => void | boolean;
  footer?: ComponentChildren;
  width?: number;
  height?: number;
  class?: string;
  children: ComponentChildren;
}

export function Dialog({ title, onClose, onAccept, footer, width = 640, height, class: cls, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    const before = (el?.ownerDocument ?? document).activeElement as HTMLElement | null;
    const first = el?.querySelector<HTMLElement>('[autofocus]') ?? el?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button.default, .dlg-body button');
    (first ?? el)?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  // The handlers of the latest render (Enter accepts after the dialog has re-rendered)
  const latest = useRef({ onAccept, onClose });
  latest.current = { onAccept, onClose };
  const pending = useRef(false);
  const isTop = () => { const all = (ref.current?.ownerDocument ?? document).querySelectorAll('.dlg'); return !!ref.current?.isConnected && all[all.length - 1] === ref.current; };
  /** Once the field the key is in has handled it (at the field, after its own handlers): act unless it used the key. */
  const afterField = (e: KeyboardEvent, act: () => void) => {
    const t = e.target as HTMLElement;
    const h = (ev: Event) => { if (ev !== e) return; t.removeEventListener('keydown', h); if (!ev.defaultPrevented) act(); };
    t.addEventListener('keydown', h);
    setTimeout(() => t.removeEventListener('keydown', h), 0);
  };
  /**
   * Esc cancels, Enter is OK — unless the field the key is in used it itself (preventDefault: an
   * in-place edit's Esc, a shortcut being captured, a field's own Enter). Enter waits for the
   * dialog to re-render with what the field took (a value set when it loses focus). Only the top
   * dialog acts.
   */
  const onKeyCapture = (e: KeyboardEvent) => {
    if (!isTop() || pending.current) return;
    if (e.key === 'Escape') { afterField(e, () => { if (isTop()) latest.current.onClose(); }); return; }
    if (e.key !== 'Enter' || !onAccept || /^(TEXTAREA|BUTTON)$/.test((e.target as HTMLElement).tagName ?? '')) return;
    const field = e.target as HTMLElement;
    afterField(e, () => {
      pending.current = true;
      if (field !== ref.current && field.ownerDocument.activeElement === field) field.blur?.();
      setTimeout(() => {
        pending.current = false;
        if (!isTop()) return;
        if (latest.current.onAccept?.() !== false) latest.current.onClose();
        else if (field.isConnected) field.focus({ preventScroll: true });
      }, 0);
    });
  };
  // Other keys stay inside the dialog (no editor shortcut fires under it), nor does the browser's
  // own Save / Print / Open page
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && /^[spo]$/i.test(e.key)) e.preventDefault();
  };
  const drag = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const box = ref.current!.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    const head = e.currentTarget as HTMLElement;
    head.setPointerCapture(e.pointerId);
    const w = head.ownerDocument.defaultView ?? window;
    const move = (ev: PointerEvent) => setPos({
      x: Math.min(w.innerWidth - 80, Math.max(-box.width + 80, ev.clientX - dx)),
      y: Math.min(w.innerHeight - 30, Math.max(0, ev.clientY - dy)),
    });
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  };
  const style: Record<string, string> = { width: `min(${width}px, 96vw)` };
  if (height) style.height = `min(${height}px, 92vh)`;
  if (pos) { style.position = 'fixed'; style.left = `${pos.x}px`; style.top = `${pos.y}px`; }
  return (
    <div class="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}>
      <div ref={ref} class={`dlg${cls ? ` ${cls}` : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={style} onKeyDown={onKey} onKeyDownCapture={onKeyCapture}>
        <header class="dlg-title" onPointerDown={drag as unknown as (e: Event) => void}>
          <span class="dlg-icon" aria-hidden="true" />
          <span class="dlg-caption">{title}</span>
          <button class="dlg-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div class="dlg-body">{children}</div>
        {footer && <footer class="dlg-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Altium-style table: header row, click a row to select, double-click to act. */
export function Grid<T>({ cols, rows, sel, onSel, onOpen, empty, rowClass }: {
  cols: { label: string; width?: string; get: (r: T) => ComponentChildren; align?: 'right' | 'center' }[];
  rows: T[];
  sel?: number | null;
  onSel?: (i: number) => void;
  onOpen?: (i: number) => void;
  empty?: string;
  rowClass?: (r: T) => string;
}) {
  // Widths dragged to before (column header edges) win over the defaults
  const saved = savedWidths(cols.map((c) => c.label));
  const template = saved ? saved.map((w) => `${w}px`).join(' ') : cols.map((c) => c.width ?? 'minmax(60px, 1fr)').join(' ');
  // Long lists (a library of thousands of parts) draw only the rows in view, a fixed height each
  const virtual = rows.length > VIRTUAL_FROM;
  const body = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 800 });
  const measure = () => { const b = body.current; if (b) setView({ top: b.scrollTop, h: b.clientHeight || 800 }); };
  useEffect(() => { if (virtual) measure(); }, [virtual, rows.length]);
  // Keep the selected row in view (a pick from the editor, Next / Previous)
  useEffect(() => {
    const b = body.current;
    if (!virtual || !b || sel == null || sel < 0) return;
    const y = sel * ROW_H;
    if (y < b.scrollTop || y + ROW_H > b.scrollTop + b.clientHeight) { b.scrollTop = Math.max(0, y - b.clientHeight / 2); measure(); }
  }, [virtual, sel]);
  const first = virtual ? Math.max(0, Math.floor(view.top / ROW_H) - 20) : 0;
  const last = virtual ? Math.min(rows.length, Math.ceil((view.top + view.h) / ROW_H) + 20) : rows.length;
  return (
    <div class="grid" role="grid" aria-rowcount={rows.length} style={{ '--cols': template } as Record<string, string>}>
      <div class="grid-row grid-head" role="row">{cols.map((c) => <span key={c.label} role="columnheader" class={c.align ? `al-${c.align}` : ''}>{c.label}</span>)}</div>
      <div class={`grid-body${virtual ? ' virtual' : ''}`} ref={body} onScroll={virtual ? measure : undefined}>
        {!rows.length && empty && <p class="grid-empty">{empty}</p>}
        {virtual && first > 0 && <div style={{ height: `${first * ROW_H}px` }} />}
        {rows.slice(first, last).map((r, k) => {
          const i = first + k;
          return (
            <div key={i} role="row" aria-rowindex={i + 1} class={`grid-row${sel === i ? ' on' : ''}${rowClass ? ` ${rowClass(r)}` : ''}`}
              onMouseDown={() => onSel?.(i)} onDblClick={() => onOpen?.(i)}>
              {cols.map((c) => <span key={c.label} role="gridcell" class={c.align ? `al-${c.align}` : ''}>{c.get(r)}</span>)}
            </div>
          );
        })}
        {virtual && last < rows.length && <div style={{ height: `${(rows.length - last) * ROW_H}px` }} />}
      </div>
    </div>
  );
}
/** Rows past this many are drawn only where they show; each is then ROW_H px tall. */
const VIRTUAL_FROM = 300, ROW_H = 20;
