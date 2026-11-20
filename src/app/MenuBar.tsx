import { Logo } from './icons';
import { GYDEL_ICON } from './gydelIcon';
import { PLANNED_NOTE, plannedFeature } from '../core/release';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { commands, scopeIncludes, type Scope } from '../core/commands';
import type { AccelNode, ChainState } from '../core/keymap';
import { MENUS, SYSTEM_MENU, router, shortcutFor } from './commands';
import { parseCaption } from './menus';
import { activeScope, chain, docPath, mouse, navPath, prefsPage, showPrefs, type OpenDoc } from './state';
import { ColourIcon, Icon } from './icons';
import { iconFor } from './Toolbar';
import { settings, settingsChanged } from '../core/settings';
import { canGet, fromFile, latest, update } from '../platform/distribution';
import { allWindows, ownerOf, uiWin, useWin } from './docWindows';
import { signal } from '@preact/signals';
import type { Scope as MenuScope } from '../core/commands';

/** The window the open menu (or key chain) shows in: the one in use when it opened. */
const chainWin = signal<Window | null>(null);

/** Text with its accelerator letter underlined (Altium's & marker), as Windows menus draw it. */
export function Accel({ label, at, k }: { label: string; at?: number; k?: string }) {
  const i = at ?? (k ? label.toLowerCase().indexOf(k.toLowerCase()) : -1);
  if (i < 0 || i >= label.length) return <>{label}</>;
  return <>{label.slice(0, i)}<u>{label[i]}</u>{label.slice(i + 1)}</>;
}

/** scope: the menus of the document this window shows (a document window's own), else the active one's. */
export function MenuBar({ scope: own, od }: { scope?: MenuScope; od?: OpenDoc | null } = {}) {
  const scope = own ?? activeScope.value;
  const here = useWin();
  // Offline beside the menus follows Network Activity as it changes
  const [, redraw] = useState(0);
  useEffect(() => settingsChanged.on((p) => { if ('offline' in p) redraw((n) => n + 1); }), []);
  const roots = MENUS.filter((m) => m.inMenuBar && m.scopes.includes(scope) && (!m.when || m.when()));
  const open = chain.value && ownerOf(chainWin.value) === here ? chain.value : null;
  const path = od === undefined ? navPath.value : docPath(od);
  const barOpen = !!open && (isBarRoot(open.path[0]) || open.path[0]?.label === 'DXP');
  return (
    <nav class="menubar" aria-label="Main menu" data-ctx="toolbars">
      <button class={`brand${open?.path[0]?.label === 'DXP' ? ' open' : ''}`} title="Konium Designer" aria-label="Konium Designer menu: Preferences, Customise"
        onMouseDown={(e) => {
          e.preventDefault();
          if (open?.path[0]?.label === 'DXP') { router.cancelChain(); return; }
          const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openAt(SYSTEM_MENU(scope), b.left, b.bottom);
        }}
        onMouseEnter={(e) => {
          if (!barOpen || open?.path[0]?.label === 'DXP') return;
          const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openAt(SYSTEM_MENU(scope), b.left, b.bottom);
        }}>
        <Logo size={18} />
      </button>
      {roots.map((r) => {
        const isOpen = open?.path[0] === r && open.source === 'ui';
        return (
          <button
            key={r.label}
            class={`menubar-item${isOpen ? ' open' : ''}`}
            data-menu={r.label}
            onMouseDown={(e) => {
              e.preventDefault();
              if (isOpen) { router.cancelChain(); return; }
              const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openAt(r, b.left, b.bottom);
            }}
            onMouseEnter={(e) => {
              if (!barOpen || isOpen) return;
              const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openAt(r, b.left, b.bottom);
            }}
          >
            <Accel label={r.label} at={r.accelAt} k={r.alt} />
          </button>
        );
      })}
      <span class="navbar" title={path || 'No document open'}>
        <ColourIcon name="folder" size={14} />
        <span class="navbar-path">{path}</span>
      </span>
      <span class="menubar-spacer" />
      {latest.value && (
        <button class="menubar-chip update" title={`Konium Designer ${latest.value.version} is out${fromFile ? ': get it from konium.app' : ': reload to use it'}`} onClick={update}>
          Update to {latest.value.version}
        </button>
      )}
      {settings.offline && (
        <button class="menubar-chip offline" title="Network activity is off: Konium Designer makes no connections (Preferences › System › Network Activity)"
          onClick={() => { prefsPage.value = 'sys-network'; showPrefs.value = true; }}>Offline</button>
      )}
      {canGet() && (
        <button class="menubar-chip get" title="Install Konium Designer: a window of its own, without the browser's address bar and buttons, that runs without a connection (or download it as one file)" onClick={() => commands.run('help.getKonium', scope)}>
          <ColourIcon name="download" size={14} />Install
        </button>
      )}
      <a class="menubar-icon gydel" href="https://gydel.games" target="_blank" rel="noopener" title="Gydel: for your spare moments (gydel.games)" aria-label="Gydel: for your spare moments">
        <img src={GYDEL_ICON} width={16} height={16} alt="" />
      </a>
      <button class="menubar-icon support" title="Support Konium Designer" aria-label="Support Konium Designer" onClick={() => commands.run('help.support', scope)}>
        <ColourIcon name="tipJar" size={16} />
      </button>
      <button class="menubar-icon" title="Preferences (T, P)" aria-label="Preferences" onClick={() => commands.run('tools.preferences', scope)}>
        <Icon name="gear" />
      </button>
    </nav>
  );
}

const isBarRoot = (n: AccelNode | undefined) => !!n && MENUS.some((m) => m === n && m.inMenuBar);

function openAt(node: AccelNode, x: number, y: number): void {
  pendingAnchor = { x, y };
  anchors.clear();
  router.openChain(node, activeScope.value);
}

/** Open any menu (context, panels, toolbar dropdowns …) at a screen position. */
export function openMenuAt(node: AccelNode, x: number, y: number): void {
  router.cancelChain();
  openAt(node, Math.max(4, x), Math.max(4, y));
}

let pendingAnchor: { x: number; y: number } | null = null;
/** Where each cascaded level opens: the right edge of the item that opened it. */
const anchors = new Map<number, { x: number; y: number; left: number; leftwards?: boolean }>();

/**
 * Hover changes inside a cascade wait a moment while a submenu is open, as Windows menus do:
 * the pointer can cross other items on its way into the submenu (diagonally, or across the
 * menu when the submenu opened on the left) without it closing. Entering a deeper level
 * cancels the change.
 */
let pending: { depth: number; timer: number } | null = null;
const HOVER_DELAY = 300;
function later(depth: number, fn: () => void): void {
  if (pending) clearTimeout(pending.timer);
  pending = { depth, timer: window.setTimeout(() => { pending = null; fn(); }, HOVER_DELAY) };
}
function settle(depth: number): void {
  if (pending && depth > pending.depth) { clearTimeout(pending.timer); pending = null; }
}

/** Wire the router's chain events into the signal, anchoring at the menu or the mouse. */
export function bindChainPopup(): void {
  router.chain.on((st) => {
    if (!st) { chain.value = null; chainWin.value = null; pendingAnchor = null; anchors.clear(); if (pending) { clearTimeout(pending.timer); pending = null; } return; }
    // A level opened or closed within the same menu keeps its place; another menu (the pointer
    // moved along the bar to it) opens where it was asked to, under its own title
    const prev = chain.value;
    if (!prev) chainWin.value = uiWin.peek();
    const same = !!prev && prev.path[0] === st.path[0];
    const at = (same ? prev.at : null) ?? pendingAnchor ?? barAnchor(st) ?? { x: mouse.x + 8, y: mouse.y + 8 };
    pendingAnchor = null;
    chain.value = { ...st, at };
  });
}

const WIDTH = 240;

/** Alt+letter opens a menu bar menu under its title, as Windows does. */
function barAnchor(st: ChainState): { x: number; y: number } | null {
  if (st.source !== 'ui' || !isBarRoot(st.path[0])) return null;
  const el = ownerOf(chainWin.peek()).document.querySelector<HTMLElement>(`.menubar-item[data-menu="${st.path[0]!.label}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

export function ChainPopup() {
  const here = useWin();
  const st = chain.value && ownerOf(chainWin.value) === here ? chain.value : null;
  const hidden = !!st && st.source === 'key' && !settings.accelPopups;
  useEffect(() => {
    if (!st) return;
    // A press anywhere else, in any window, closes it
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.menu-popup, .menubar-item, .brand, .tbtn-drop')) router.cancelChain();
    };
    const wins = allWindows();
    for (const w of wins) w.addEventListener('mousedown', close);
    return () => { for (const w of wins) { try { w.removeEventListener('mousedown', close); } catch { /* closed */ } } };
  }, [st]);
  if (!st || hidden) return null;
  const fromMenuBar = isBarRoot(st.path[0]) || st.path[0]?.label === 'DXP';
  return <>{st.path.map((node, d) => <MenuLevel key={`${d}:${node.label}`} node={node} depth={d} st={st} fromMenuBar={fromMenuBar} />)}</>;
}

function levelAnchor(st: ChainState & { at: { x: number; y: number } }, depth: number, document: Document): { x: number; y: number; left: number; leftwards?: boolean } {
  if (depth === 0) return { x: st.at.x, y: st.at.y, left: st.at.x };
  const a = anchors.get(depth);
  if (a) return a;
  // A key chain stepped in: open beside that item of the level above
  const parent = document.querySelector(`.menu-popup[data-depth="${depth - 1}"]`);
  const label = st.path[depth]!.label;
  const item = parent ? [...parent.querySelectorAll<HTMLElement>('.menu-item')].find((el) => el.dataset.label === label) : undefined;
  if (item && parent) { const r = item.getBoundingClientRect(); const p = parent.getBoundingClientRect(); return { x: p.right - 2, y: r.top - 3, left: p.left }; }
  return { x: st.at.x + depth * 200, y: st.at.y, left: st.at.x };
}

function MenuLevel({ node, depth, st, fromMenuBar }: { node: AccelNode; depth: number; st: ChainState & { at: { x: number; y: number } }; fromMenuBar: boolean }) {
  const kids = node.children ?? [];
  const next = st.path[depth + 1];
  const window = useWin();
  const a = levelAnchor(st, depth, window.document);
  let left = a.x;
  if (depth && a.leftwards) left = Math.max(0, a.left - WIDTH + 4);
  else if (left + WIDTH > window.innerWidth) left = depth ? Math.max(0, a.left - WIDTH + 4) : Math.max(0, window.innerWidth - WIDTH - 4);
  const top = Math.max(0, a.y);
  const crumbs = st.path.slice(0, depth + 1).map((n) => n.label).join(' › ');
  const scope = st.scope;
  const ref = useRef<HTMLDivElement>(null);
  // Keep the whole menu on screen: up from the bottom edge. A submenu opens on its parent's right,
  // or on its left when there's no room — and once a cascade has turned left it carries on left,
  // so a level never lands on top of the menus before it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.top = `${top}px`;
    const r0 = el.getBoundingClientRect();
    const w = r0.width;
    let x: number, leftwards = false;
    if (!depth) x = a.x + w > window.innerWidth - 2 ? Math.max(0, window.innerWidth - 2 - w) : a.x;
    else {
      const onRight = a.x, onLeft = a.left - w + 4;
      const fitsRight = onRight + w <= window.innerWidth - 2, fitsLeft = onLeft >= 0;
      leftwards = a.leftwards ? fitsLeft || !fitsRight : !fitsRight && fitsLeft;
      x = leftwards ? Math.max(0, onLeft) : fitsRight ? onRight : Math.max(0, window.innerWidth - 2 - w);
    }
    el.style.left = `${x}px`;
    el.dataset.leftwards = leftwards ? '1' : '';
    if (r0.bottom > window.innerHeight - 2) el.style.top = `${Math.max(0, window.innerHeight - 2 - r0.height)}px`;
  });
  return (
    <div ref={ref} class="menu-popup" role="menu" aria-label={crumbs} data-depth={depth} style={{ left: `${left}px`, top: `${top}px` }}
      onMouseEnter={() => settle(depth)}>
      {depth === 0 && !fromMenuBar && st.path[0]!.key !== '' && <div class="menu-crumbs">{crumbs}</div>}
      {kids.map((c, i) => item(c, i, depth, scope, next, window.document))}
    </div>
  );
}

function item(c: AccelNode, i: number, depth: number, scope: Scope, next: AccelNode | undefined, document: Document) {
  const cmd = c.command ? commands.get(c.command) : undefined;
  // Commands of another editor (Move › Component on a schematic) aren't offered at all
  if (cmd && !scopeIncludes(cmd.scopes, scope)) return null;
  const live = c.children ? true : c.action ? !c.disabled : !!c.command && commands.isLive(c.command, scope);
  if (cmd?.dynamic && !live) return null;
  const cap = cmd?.caption?.();
  const shown = cap ? parseCaption(cap) : { label: c.label, accelAt: c.accelAt };
  const sc = c.command ? shortcutFor(c.command) : c.hint;
  const checked = c.checked ?? cmd?.checked?.();
  const icon = c.command ? iconFor(c.command) : undefined;
  const isOpen = !!c.children && next?.label === c.label;
  const openSub = (el: HTMLElement) => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    const pop = el.closest<HTMLElement>('.menu-popup')!, p = pop.getBoundingClientRect();
    router.truncate(depth + 1);
    anchors.set(depth + 1, { x: p.right - 2, y: r.top - 3, left: p.left, leftwards: pop.dataset.leftwards === '1' });
    router.openChild(c);
  };
  // Another submenu of this level is open: change over only if the pointer stays here
  const subOpen = () => !!document.querySelector(`.menu-popup[data-depth="${depth + 1}"]`);
  return (
    <>
      {c.separatorBefore && i > 0 && <div class="menu-sep" role="separator" />}
      <button
        role="menuitem"
        class={`menu-item${live ? '' : ' disabled'}${cmd?.planned ? ' planned' : ''}${isOpen ? ' open' : ''}`}
        data-label={c.label}
        aria-haspopup={c.children ? 'menu' : undefined}
        disabled={!live && !cmd?.planned}
        title={cmd?.planned ? PLANNED_NOTE : undefined}
        onMouseEnter={(e) => {
          const el = e.currentTarget as HTMLElement;
          settle(depth);
          if (c.children) { if (!isOpen) { if (subOpen()) later(depth, () => openSub(el)); else openSub(el); } else if (pending?.depth === depth) { clearTimeout(pending.timer); pending = null; } }
          else if (subOpen()) later(depth, () => router.truncate(depth + 1));
        }}
        onClick={(e) => {
          if (pending) { clearTimeout(pending.timer); pending = null; }
          if (c.children) { openSub(e.currentTarget as HTMLElement); return; }
          router.cancelChain();
          if (c.action) c.action();
          else if (c.command) { if (cmd?.planned) void cmd.run(); else commands.run(c.command, scope); }
        }}
      >
        <span class="menu-gutter">{checked ? <span class="menu-check">✓</span> : icon ? <ColourIcon name={icon} /> : null}</span>
        <span class="menu-label"><Accel label={shown.label} at={shown.accelAt} /></span>
        <span class="menu-meta">{c.children ? '▸' : cmd && c.command && plannedFeature(c.command) ? <span class="menu-planned">Planned</span> : sc ?? ''}</span>
      </button>
    </>
  );
}
