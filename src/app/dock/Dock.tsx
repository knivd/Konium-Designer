import { Component, type ComponentChildren } from 'preact';
import { settings } from '../../core/settings';
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Icon } from '../icons';
import { active, activeScope } from '../state';
import { openMenuAt } from '../MenuBar';
import type { AccelNode } from '../../core/keymap';
import type { Scope } from '../../core/commands';
import {
  activate, canDock, frontOf, drop, findGroup, moveFloat, raiseFloat, resizeSlide, resizeSplit, resizeZone, setAutoHide, setNoDock, toggleFloat, vertical, ZONE_DEFAULT,
  type DropTarget, type Group, type Rect, type Side,
} from './layout';
import { panelAvailable, panelMeta, panelTitle } from './panels';
import { failing, hidePanel, layout, setLayout, slideOut } from './store';
import { renderPanel } from './views';

/**
 * A panel whose drawing fails shows the failure in its own place, and the rest of Konium (the
 * documents open, the other panels) stays as it is, to be saved. Another document in front, or
 * Try Again, draws the panel anew.
 */
class PanelGuard extends Component<{ children: ComponentChildren; title: string }, { error: Error | null; at: string | undefined }> {
  override state = { error: null as Error | null, at: undefined as string | undefined };
  override componentDidCatch(error: Error): void { this.setState({ error, at: active.peek()?.id }); console.error(error); }
  override render() {
    const e = this.state.error;
    if (!e || this.state.at !== active.value?.id) return this.props.children;
    return (
      <div class="panel-crash" role="alert">
        <p><b>The {this.props.title} panel hit an error.</b> Your documents are as they were: save your work, then try the panel again.</p>
        <pre>{e.message}</pre>
        <button onClick={() => this.setState({ error: null })}>Try Again</button>
      </div>
    );
  }
}

/** A panel's content, drawn inside its guard (so choosing what to draw is guarded too). */
function PanelBody({ id }: { id: string }) {
  if (failing.value === id) throw new Error('This panel was made to fail, to test what a failing panel does');
  return renderPanel(id);
}

/**
 * Altium's panel docking: groups of tabbed panels on the four edges of the window, floating
 * groups, auto-hide strips. Drag a title bar (the whole group) or a tab (one panel): an
 * outline shows where it will go — onto another group's title or tabs to join it, near an
 * edge of the window to dock there, over the top or bottom of a docked group to split it,
 * anywhere else (or with Ctrl held) to float. Double-click a title bar to float or re-dock.
 */

const EDGE = 26;

/** The group last clicked into: its title bar is drawn active, as Altium's is. */
const focused = signal<string | null>(null);
const drag = signal<{ preview: Rect | null } | null>(null);

const visiblePanels = (g: Group, scope: Scope) => g.panels.filter((p) => panelAvailable(p, scope));
const shown = (g: Group, scope: Scope) => frontOf(g, scope, visiblePanels(g, scope));

/* ─── Drag and drop ─────────────────────────────────────────────────────────────────── */

function rectOf(el: Element): Rect { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }

function targetAt(x: number, y: number, ctrl: boolean, panels: string[], from: string, size: { w: number; h: number; offX: number; offY: number }): { target: DropTarget | null; preview: Rect | null } {
  const l = layout.value;
  const float: DropTarget = { kind: 'float', rect: { x: x - size.offX, y: y - size.offY, w: size.w, h: size.h } };
  const floatHere = { target: float, preview: (float as { rect: Rect }).rect };
  if (ctrl) return floatHere;
  const whole = findGroup(l, from)?.g.panels.length === panels.length;
  const els = document.elementsFromPoint(x, y);
  const groupEl = (el: Element) => el.closest<HTMLElement>('[data-dock-group]');
  const sideOf = (gid: string): Side | undefined => findGroup(l, gid)?.side;
  const allowed = (gid: string) => { const s = sideOf(gid); return !s || canDock(l, panels, s); };
  // Onto a title bar or tab strip: join that group as tabs
  const head = els.find((el) => el instanceof HTMLElement && el.closest('[data-dock-head], [data-dock-tabs]'));
  if (head) {
    const gEl = groupEl(head);
    const gid = gEl?.dataset.dockGroup;
    // Onto a tab strip: between two tabs (its own group's too: the tabs reordered), a bar shows where
    const strip = (head as HTMLElement).closest<HTMLElement>('[data-dock-tabs]');
    if (gEl && gid && strip && (gid !== from || !whole)) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('[role=tab]')];
      const i = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return x < r.left + r.width / 2; });
      const sr = rectOf(strip), edge = i >= 0 ? tabs[i]!.getBoundingClientRect().left : (tabs.at(-1)?.getBoundingClientRect().right ?? sr.x);
      const before = i >= 0 ? tabs[i]!.dataset.panelId : undefined;
      const bar = { x: edge - 2, y: sr.y, w: 4, h: sr.h };
      if (gid === from) return { target: before && panels.includes(before) ? null : { kind: 'join', group: gid, before: before ?? '' }, preview: bar };
      if (allowed(gid)) return { target: { kind: 'join', group: gid, before }, preview: bar };
    }
    if (gEl && gid) {
      if (gid === from) return { target: null, preview: whole ? null : rectOf(gEl) };
      if (allowed(gid)) return { target: { kind: 'join', group: gid }, preview: rectOf(gEl) };
    }
  }
  // Near an edge of the workspace: dock on that edge
  const ws = document.querySelector('.workspace'), mid = document.querySelector('.ws-mid');
  if (ws && mid) {
    const w = rectOf(ws), m = rectOf(mid);
    const zone = (s: Side) => { const z = l.zones[s]; return z.groups.some((g) => !g.autoHide) ? z.size : ZONE_DEFAULT[s]; };
    const edges: [Side, boolean, Rect][] = [
      ['left', x < w.x + EDGE, { x: w.x, y: m.y, w: zone('left'), h: m.h }],
      ['right', x > w.x + w.w - EDGE, { x: w.x + w.w - zone('right'), y: m.y, w: zone('right'), h: m.h }],
      ['bottom', y > w.y + w.h - EDGE, { x: w.x, y: w.y + w.h - zone('bottom'), w: w.w, h: zone('bottom') }],
      ['top', y < w.y + EDGE, { x: w.x, y: w.y, w: w.w, h: zone('top') }],
    ];
    for (const [side, near, r] of edges) if (near && canDock(l, panels, side)) return { target: { kind: 'edge', side, outer: false }, preview: r };
  }
  // Over a docked group's body: top / bottom (left / right) part splits it, the middle joins it
  const body = els.map(groupEl).find((g) => g?.dataset.dockMode === 'dock');
  if (body?.dataset.dockGroup) {
    const gid = body.dataset.dockGroup, side = body.dataset.dockSide as Side;
    const r = rectOf(body);
    if (gid === from && whole) return { target: null, preview: null };
    if (canDock(l, panels, side)) {
      if (vertical(side)) {
        if (y < r.y + r.h * 0.35) return { target: { kind: 'split', group: gid, after: false }, preview: { ...r, h: r.h / 2 } };
        if (y > r.y + r.h * 0.65) return { target: { kind: 'split', group: gid, after: true }, preview: { ...r, y: r.y + r.h / 2, h: r.h / 2 } };
      } else {
        if (x < r.x + r.w * 0.35) return { target: { kind: 'split', group: gid, after: false }, preview: { ...r, w: r.w / 2 } };
        if (x > r.x + r.w * 0.65) return { target: { kind: 'split', group: gid, after: true }, preview: { ...r, x: r.x + r.w / 2, w: r.w / 2 } };
      }
      if (gid !== from) return { target: { kind: 'join', group: gid }, preview: r };
    }
  }
  return floatHere;
}

/** Press on a title bar or tab: a click if the pointer stays put, a drag once it moves. */
function pressToDrag(e: PointerEvent, panels: string[], from: string, groupEl: HTMLElement | null, onClick?: () => void): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button.panel-btn')) return;
  const start = { x: e.clientX, y: e.clientY };
  const box = groupEl ? rectOf(groupEl) : { x: start.x, y: start.y, w: 280, h: 400 };
  const whole = findGroup(layout.value, from)?.g.panels.length === panels.length;
  const size = { w: Math.max(200, whole ? box.w : Math.min(box.w, 300)), h: Math.max(160, whole ? box.h : Math.min(box.h, 420)), offX: Math.min(start.x - box.x, 120), offY: 10 };
  let dragging = false;
  let target: DropTarget | null = null;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
    dragging = true;
    document.body.classList.add('dock-dragging');
    const t = targetAt(ev.clientX, ev.clientY, ev.ctrlKey, panels, from, size);
    target = t.target;
    drag.value = { preview: t.preview };
  };
  const end = (apply: boolean) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('keydown', key, true);
    document.body.classList.remove('dock-dragging');
    drag.value = null;
    if (dragging && apply && target) {
      if (target.kind === 'float') target.rect = clampRect(target.rect);
      setLayout(drop(layout.value, panels, target));
      slideOut.value = null;
    } else if (!dragging && apply) onClick?.();
  };
  const up = () => end(true);
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('keydown', key, true);
}

/** Keep a floating panel on screen: its title bar reachable, no taller or wider than the window. */
function clampRect(r: Rect): Rect {
  const W = window.innerWidth, H = window.innerHeight;
  const w = Math.min(r.w, W - 20), y = Math.min(Math.max(r.y, 0), H - 60);
  const h = Math.max(120, Math.min(r.h, H - y - 8));
  return { x: Math.min(Math.max(r.x, 40 - w), W - 60), y, w, h };
}

/* ─── Menus ─────────────────────────────────────────────────────────────────────────── */

/** Right-click on a title bar or tab: Close 'X', Allow Dock ▸ Horizontally / Vertically. */
export function panelContextMenu(id: string, scope: Scope): AccelNode {
  const t = panelTitle(id, scope);
  const nd = layout.value.noDock[id] ?? {};
  return { key: '', label: t, children: [
    { key: 'C', label: `Close '${t}'`, accelAt: 0, action: () => hidePanel(id) },
    { key: 'A', label: 'Allow Dock', accelAt: 0, children: [
      { key: 'H', label: 'Horizontally', accelAt: 0, checked: !nd.h, action: () => setLayout(setNoDock(layout.value, id, 'h', !nd.h)) },
      { key: 'V', label: 'Vertically', accelAt: 0, checked: !nd.v, action: () => setLayout(setNoDock(layout.value, id, 'v', !nd.v)) },
    ] },
  ] };
}

/** The ▼ button: the group's panels (the one in front ticked), then Close. */
function groupMenu(g: Group, scope: Scope): AccelNode {
  const vis = visiblePanels(g, scope), front = shown(g, scope);
  return { key: '', label: 'Panels', children: [
    ...vis.map((p): AccelNode => ({ key: '', label: panelTitle(p, scope), checked: p === front, action: () => setLayout(activate(layout.value, p, scope, !!panelMeta(p)?.when)) })),
    ...(front ? [{ key: 'C', label: `Close '${panelTitle(front, scope)}'`, accelAt: 0, separatorBefore: true, action: () => hidePanel(front) } as AccelNode] : []),
  ] };
}

/* ─── Views ─────────────────────────────────────────────────────────────────────────── */

function GroupView({ g, mode, side }: { g: Group; mode: 'dock' | 'float' | 'slide'; side?: Side }) {
  const scope = activeScope.value;
  const vis = visiblePanels(g, scope);
  const front = shown(g, scope);
  const ref = useRef<HTMLElement>(null);
  if (!front) return null;
  const title = panelTitle(front, scope);
  const press = () => {
    focused.value = g.id;
    if (mode === 'float') setLayout(raiseFloat(layout.value, g.id));
  };
  const onHeadDown = (e: PointerEvent) => pressToDrag(e, [...g.panels], g.id, ref.current);
  const onTabDown = (p: string) => (e: PointerEvent) => pressToDrag(e, [p], g.id, ref.current, () => { setLayout(activate(layout.value, p, scope, !!panelMeta(p)?.when)); });
  const pin = () => {
    if (mode === 'slide') { setLayout(setAutoHide(layout.value, g.id, false)); slideOut.value = null; }
    else { setLayout(setAutoHide(layout.value, g.id, true)); slideOut.value = null; }
  };
  const menu = (e: MouseEvent) => { const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(groupMenu(g, scope), b.left, b.bottom + 1); };
  const float = () => { if (ref.current) { setLayout(toggleFloat(layout.value, g.id, clampRect(rectOf(ref.current)))); slideOut.value = null; } };
  return (
    <section ref={ref} class={`dock-group gm-${mode}${focused.value === g.id ? ' focused' : ''}`} data-dock-group={g.id} data-dock-mode={mode} data-dock-side={side}
      onPointerDownCapture={press as unknown as (e: Event) => void}>
      <header class="panel-head" data-dock-head data-ctx="panel" data-panel={title} data-panel-id={front} data-side={side ?? 'float'}
        onPointerDown={onHeadDown as unknown as (e: Event) => void} onDblClick={(e) => { if (!(e.target as HTMLElement).closest('button')) float(); }}>
        <h2 class="panel-title">{title}</h2>
        <button class="panel-btn" title="Panel menu" aria-label={`${title} menu`} onMouseDown={(e) => { e.preventDefault(); menu(e); }}><Icon name="menu" size={12} /></button>
        {mode !== 'float' && (
          <button class={`panel-btn${mode === 'slide' ? ' unpinned' : ''}`} title={mode === 'slide' ? 'Dock (pin open)' : 'Auto-hide'} aria-label={mode === 'slide' ? `Pin ${title}` : `Auto-hide ${title}`} onClick={pin}>
            <Icon name="pin" size={12} />
          </button>
        )}
        <button class="panel-btn" title="Close" aria-label={`Close ${title}`} onClick={() => hidePanel(front)}><Icon name="close" size={12} /></button>
      </header>
      <div class="dock-body"><PanelGuard key={front} title={title}><PanelBody id={front} /></PanelGuard></div>
      {vis.length > 1 && (
        <div class="dock-tabs" role="tablist" data-dock-tabs>
          {vis.map((p) => {
            const t = panelTitle(p, scope);
            return <button key={p} role="tab" aria-selected={p === front} data-ctx="panel" data-panel={t} data-panel-id={p} data-side={side ?? 'float'}
              onPointerDown={onTabDown(p) as unknown as (e: Event) => void}>{t}</button>;
          })}
        </div>
      )}
    </section>
  );
}

/** Drag on a zone's inner edge: its width (or height). */
/** A slide-out being resized: it stays out while the pointer is beyond it. */
let slideResizing = false;

/** The edge of a docked zone (or of a pinned-off group's slide-out, `slide` its id): drag to resize. */
function ZoneResize({ side, slide }: { side: Side; slide?: string }) {
  const down = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const zoneEl = (e.currentTarget as HTMLElement).parentElement!;
    const start = side === 'left' || side === 'right' ? e.clientX : e.clientY;
    const size0 = vertical(side) ? zoneEl.getBoundingClientRect().width : zoneEl.getBoundingClientRect().height;
    const sign = side === 'left' || side === 'top' ? 1 : -1;
    const max = (side === 'left' || side === 'right' ? window.innerWidth : window.innerHeight) * 0.7;
    let size = Math.round(size0);
    if (slide) { slideResizing = true; clearTimeout(slideTimer); }
    const move = (ev: PointerEvent) => {
      const at = side === 'left' || side === 'right' ? ev.clientX : ev.clientY;
      size = Math.round(Math.min(max, Math.max(120, size0 + sign * (at - start))));
      if (vertical(side)) zoneEl.style.width = `${size}px`; else zoneEl.style.height = `${size}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      slideResizing = false;
      setLayout(slide ? resizeSlide(layout.value, slide, size) : resizeZone(layout.value, side, size));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => setLayout(slide ? resizeSlide(layout.value, slide, layout.value.zones[side].size) : resizeZone(layout.value, side, ZONE_DEFAULT[side]));
  return <div class={`dock-zone-resize zr-${side}`} role="separator" aria-label="Resize panels" title="Drag to resize, double-click to reset"
    onPointerDown={down as unknown as (e: Event) => void} onDblClick={reset} />;
}

/** Drag between two stacked groups: how they share the zone. */
function Splitter({ side, i }: { side: Side; i: number }) {
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const a = el.previousElementSibling as HTMLElement, b = el.nextElementSibling as HTMLElement;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const v = vertical(side);
    const total = v ? ra.height + rb.height : ra.width + rb.width;
    const origin = v ? ra.top : ra.left;
    let frac = (v ? ra.height : ra.width) / total;
    const move = (ev: PointerEvent) => {
      frac = Math.min(0.9, Math.max(0.1, ((v ? ev.clientY : ev.clientX) - origin) / total));
      a.style.flexGrow = String(frac); b.style.flexGrow = String(1 - frac);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); a.style.flexGrow = ''; b.style.flexGrow = ''; setLayout(resizeSplit(layout.value, side, i, frac)); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div class={`dock-split ${vertical(side) ? 'split-v' : 'split-h'}`} role="separator" onPointerDown={down as unknown as (e: Event) => void} />;
}

function ZoneView({ side }: { side: Side }) {
  const scope = activeScope.value;
  const z = layout.value.zones[side];
  const groups = z.groups.filter((g) => !g.autoHide && visiblePanels(g, scope).length);
  if (!groups.length) return null;
  const style = vertical(side) ? { width: `${z.size}px` } : { height: `${z.size}px` };
  const parts: ComponentChildren[] = [];
  groups.forEach((g, i) => {
    if (i) parts.push(<Splitter key={`s${g.id}`} side={side} i={i - 1} />);
    parts.push(<div key={g.id} class="dock-cell" style={{ flexGrow: g.weight }}><GroupView g={g} mode="dock" side={side} /></div>);
  });
  return (
    <div class={`dock-zone zone-${side}`} style={style} data-dock-zone={side}>
      {parts}
      <ZoneResize side={side} />
    </div>
  );
}

let slideTimer = 0;
const slideSoon = (id: string | null, ms: number) => { clearTimeout(slideTimer); slideTimer = window.setTimeout(() => { slideOut.value = id; }, ms); };

/** Auto-hidden groups on an edge: their panels as tabs; pointing at one slides the group out. */
function Strip({ side }: { side: Side }) {
  const scope = activeScope.value;
  const groups = layout.value.zones[side].groups.filter((g) => g.autoHide && visiblePanels(g, scope).length);
  if (!groups.length) return null;
  return (
    <nav class={`dock-strip strip-${side}`} aria-label={`${side} panels (auto-hide)`}>
      {groups.map((g) => (
        <div key={g.id} class="dock-strip-group" data-dock-group={g.id} data-dock-mode="strip">
          {visiblePanels(g, scope).map((p) => {
            const t = panelTitle(p, scope);
            const open = () => { setLayout(activate(layout.value, p, scope, !!panelMeta(p)?.when)); slideSoon(g.id, 0); };
            return (
              <button key={p} class={`strip-tab${slideOut.value === g.id && shown(g, scope) === p ? ' on' : ''}`} title={`Show ${t}`} data-ctx="panel" data-panel={t} data-panel-id={p} data-side={side}
                onMouseEnter={() => { if (slideOut.value !== g.id || shown(g, scope) !== p) { clearTimeout(slideTimer); slideTimer = window.setTimeout(open, settings.popupDelay); } else clearTimeout(slideTimer); }}
                onMouseLeave={() => { if (slideOut.value !== g.id) clearTimeout(slideTimer); else slideSoon(null, settings.popupHideDelay); }}
                onClick={open}><span>{t}</span></button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** The auto-hidden group pointed at, over the edge of the document. */
function SlideOut({ sides }: { sides: Side[] }) {
  const id = slideOut.value;
  const ref = useRef<HTMLDivElement>(null);
  const f = id ? findGroup(layout.value, id) : undefined;
  const mine = !!f?.side && !!f.g.autoHide && sides.includes(f.side);
  useEffect(() => {
    if (!mine) return;
    // A press anywhere else tucks the panel away again
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('.dock-strip, .menu-popup, .dlg-backdrop')) return;
      slideOut.value = null;
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [id, mine]);
  if (!mine || !f?.side) return null;
  const size = f.g.slideSize ?? layout.value.zones[f.side].size;
  const style = vertical(f.side) ? { width: `${size}px` } : { height: `${size}px` };
  const keep = () => clearTimeout(slideTimer);
  const leave = () => { if (!slideResizing && !ref.current?.contains(document.activeElement)) slideSoon(null, settings.popupHideDelay); };
  return (
    <div ref={ref} class={`dock-slide slide-${f.side}${settings.popupAnimation ? ' animate' : ''}`} style={{ ...style, '--slide-ms': `${Math.round(420 - 36 * settings.popupAnimationSpeed)}ms` }} onMouseEnter={keep} onMouseLeave={leave}>
      <GroupView g={f.g} mode="slide" side={f.side} />
      <ZoneResize side={f.side} slide={f.g.id} />
    </div>
  );
}

const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

function FloatView({ g }: { g: Group & { rect: Rect } }) {
  const ref = useRef<HTMLDivElement>(null);
  const r = g.rect;
  const resize = (h: (typeof HANDLES)[number]) => (e: PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = ref.current!;
    const s = { x: e.clientX, y: e.clientY }, r0 = { ...g.rect };
    let nr = r0;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
      nr = { ...r0 };
      if (h.includes('e')) nr.w = Math.max(160, r0.w + dx);
      if (h.includes('s')) nr.h = Math.max(100, r0.h + dy);
      if (h.includes('w')) { nr.w = Math.max(160, r0.w - dx); nr.x = r0.x + r0.w - nr.w; }
      if (h.includes('n')) { nr.h = Math.max(100, r0.h - dy); nr.y = r0.y + r0.h - nr.h; }
      Object.assign(el.style, { left: `${nr.x}px`, top: `${nr.y}px`, width: `${nr.w}px`, height: `${nr.h}px` });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setLayout(moveFloat(layout.value, g.id, nr)); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} class="dock-float" style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }}>
      <GroupView g={g} mode="float" />
      {HANDLES.map((h) => <div key={h} class={`fh fh-${h}`} onPointerDown={resize(h) as unknown as (e: Event) => void} />)}
    </div>
  );
}

/** Every docked zone around the document area, the floating panels, the drag outline. */
export function Workspace({ children }: { children: ComponentChildren }) {
  void layout.value;
  const scope = activeScope.value;
  const l = layout.value;
  const floats = l.floatHidden ? [] : l.floating.filter((g) => visiblePanels(g, scope).length);
  const p = drag.value?.preview;
  useEffect(() => {
    // Clicking into the document takes the active look off the panels
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.dock-group')) focused.value = null; };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  return (
    <div class="workspace">
      <Strip side="top" />
      <ZoneView side="top" />
      <div class="ws-mid">
        <Strip side="left" />
        <ZoneView side="left" />
        <main class="centre">{children}</main>
        <ZoneView side="right" />
        <Strip side="right" />
        <SlideOut sides={['left', 'right']} />
      </div>
      <ZoneView side="bottom" />
      <Strip side="bottom" />
      <SlideOut sides={['top', 'bottom']} />
      {floats.map((g) => <FloatView key={g.id} g={g} />)}
      {p && <div class="dock-preview" style={{ left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` }} />}
    </div>
  );
}

/** Shift+F5: from the document to the top floating panel and back. */
export function switchFloatingFocus(): void {
  const panels = [...document.querySelectorAll<HTMLElement>('.dock-float .dock-group')];
  const inPanel = panels.some((p) => p.contains(document.activeElement));
  if (inPanel || !panels.length) { document.querySelector<HTMLElement>('.viewport')?.focus(); return; }
  const top = panels.at(-1)!;
  const target = top.querySelector<HTMLElement>('input, select, textarea, button:not(.panel-btn), [tabindex]') ?? top;
  if (!target.hasAttribute('tabindex') && target === top) top.tabIndex = -1;
  target.focus();
}
