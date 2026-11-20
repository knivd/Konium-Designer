/**
 * Document windows: a document moved to a window of its own (Window › Open In New Window, or its
 * tab dragged out of the window), as the desktop software lets a document go to another monitor.
 * The window is a second browser window run by this one: the same documents, project, undo and
 * clipboard, so cross selection, cross probing and Update PCB work between them as within one.
 * It has its own tabs, menus, layer bar and status bar; the panels stay in the main window and
 * show the active document, the one last clicked in either window. Menus, dialogs and popups open
 * in the window they were asked for in. Closing it brings its documents back to the main window.
 */
import { createContext, options, render, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import { computed, effect, signal } from '@preact/signals';
import { HELP, HOME, activeId, docs, helpOpen, homeOpen, notify, toast, type OpenDoc } from './state';

export interface DocWin { id: string; win: Window; root: HTMLElement; off: () => void }

/** The window a component is drawn in (the main one unless it is in a document window). */
export const WinCtx = createContext<Window>(typeof window !== 'undefined' ? window : (undefined as unknown as Window));
export const useWin = (): Window => useContext(WinCtx);
/** The window an event happened in, or a node is in. */
export function winOf(x: Event | Node | null | undefined): Window {
  const n = x && 'nodeType' in x ? x : (x as Event | null | undefined)?.target as Node | null | undefined;
  const d = n ? (n.nodeType === 9 ? (n as Document) : n.ownerDocument) : null;
  return (d?.defaultView ?? window) as Window;
}

export const docWins = signal<DocWin[]>([]);
/** The document window each document is in, by document id ('' or none: the main window). */
export const docPlace = signal<ReadonlyMap<string, string>>(new Map());
/** The window of the last key or button press: menus, dialogs, popups and notices open there. */
export const uiWin = signal<Window>(typeof window !== 'undefined' ? window : (undefined as unknown as Window));
/** Every window: the main one first. */
export const allWindows = (): Window[] => [window, ...docWins.value.map((w) => w.win).filter((w) => !w.closed)];
export const placeOf = (docId: string): string => docPlace.value.get(docId) ?? '';
/** The document window a document is in (none: the main window). */
export const docWinOf = (docId: string): DocWin | undefined => { const id = docPlace.value.get(docId); return id ? docWins.value.find((w) => w.id === id) : undefined; };
/** The id of the window a Window is (''  for the main one). */
export const idOfWin = (w: Window): string => docWins.value.find((x) => x.win === w)?.id ?? '';

/* ─── What each window shows ─────────────────────────────────────────────────────────── */

/** The document each window showed last (by window id, '' the main one). */
const lastShown = signal<ReadonlyMap<string, string>>(new Map());
effect(() => {
  const a = activeId.value;
  if (!a) return;
  const w = a === HOME || a === HELP ? '' : placeOf(a);
  if (lastShown.peek().get(w) !== a) lastShown.value = new Map(lastShown.peek()).set(w, a);
});
const showable = (id: string, w: string): boolean =>
  id === HOME ? w === '' && homeOpen.value : id === HELP ? w === '' && !!helpOpen.value : docs.value.some((d) => d.id === id && !d.hidden && !d.forCompare && placeOf(d.id) === w);
/** The documents in a window, in tab order. */
export const docsIn = (w: string): OpenDoc[] => docs.value.filter((d) => placeOf(d.id) === w);
/** What a window shows: the active document when it is there, else the one it showed last, else its last tab. */
export function shownIn(w: string): string | null {
  const a = activeId.value;
  if (a && showable(a, w)) return a;
  const last = lastShown.value.get(w);
  if (last && showable(last, w)) return last;
  const tabs = docsIn(w).filter((d) => !d.hidden && !d.forCompare);
  return tabs.at(-1)?.id ?? (w === '' ? (homeOpen.value ? HOME : helpOpen.value ? HELP : null) : null);
}
/** The main window's shown document (or Home / help). */
export const mainShown = computed(() => shownIn(''));
// A document in a window of its own made active from the main window (the Projects panel, a message, cross
// probing): that window comes to the front
effect(() => {
  const a = activeId.value;
  const w = a ? docWinOf(a) : undefined;
  if (w && uiWin.peek() !== w.win) { try { w.win.focus(); } catch { /* the browser decides */ } }
});
/** Make what a window shows the active document (a press in that window). */
export function activateWindow(w: string): void {
  const id = shownIn(w);
  if (id && activeId.peek() !== id) activeId.value = id;
}

/* ─── Opening and closing ────────────────────────────────────────────────────────────── */

let seq = 0;
/** Draws a document window's contents (set by the app: the satellite component and its input). */
let mountWindow: ((w: DocWin) => () => void) | null = null;
export function setWindowMounter(f: (w: DocWin) => () => void): void { mountWindow = f; }

/** The page's look in another window: its styles, theme and fonts. */
function copyLook(win: Window): void {
  const d = win.document;
  for (const el of document.head.querySelectorAll('style, link[rel="stylesheet"]')) d.head.append(d.importNode(el, true));
  for (const a of [...document.documentElement.attributes]) if (a.name !== 'data-away') d.documentElement.setAttribute(a.name, a.value);
  for (const a of [...document.body.attributes]) d.body.setAttribute(a.name, a.value);
  for (const f of fontCopies) { try { const face = new (win as unknown as { FontFace: typeof FontFace }).FontFace(f.family, f.data, f.descriptors); d.fonts.add(face); void face.load().catch(() => undefined); } catch { /* a font this window won't take */ } }
}
/** Board fonts added to the page (boardOpened), added to each document window too. */
const fontCopies: { family: string; data: ArrayBuffer; descriptors: FontFaceDescriptors }[] = [];
export function shareFont(family: string, data: ArrayBuffer, descriptors: FontFaceDescriptors): void {
  fontCopies.push({ family, data, descriptors });
  for (const w of docWins.value) { try { const face = new (w.win as unknown as { FontFace: typeof FontFace }).FontFace(family, data, descriptors); w.win.document.fonts.add(face); void face.load().catch(() => undefined); } catch { /* as above */ } }
}
// The theme and the like follow in every window
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  new MutationObserver((ms) => {
    for (const m of ms) {
      const name = m.attributeName;
      if (!name || name === 'data-away') continue;
      const v = document.documentElement.getAttribute(name);
      for (const w of docWins.value) { try { if (v === null) w.win.document.documentElement.removeAttribute(name); else w.win.document.documentElement.setAttribute(name, v); } catch { /* closing */ } }
    }
  }).observe(document.documentElement, { attributes: true });
}

/**
 * Window › Open In New Window, or a tab dragged out of the window: the document moves to a new
 * window of its own (at a screen position, when dragged there). False when the browser blocked it.
 */
export function openDocWindow(od: OpenDoc, at?: { x: number; y: number }): boolean {
  if (!mountWindow) return false;
  const id = `w${++seq}`;
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  const w = Math.round(s.availWidth * 0.6), h = Math.round(s.availHeight * 0.7);
  const pos = at ? `,left=${Math.round(at.x - 80)},top=${Math.round(at.y - 12)}` : '';
  const win = window.open('', `konium-${Date.now().toString(36)}-${id}`, `popup,width=${w},height=${h}${pos}`);
  if (!win) { notify('The browser blocked the new window: allow pop-ups for Konium Designer', 'error'); return false; }
  let root: HTMLElement;
  try {
    win.document.title = `${od.name} — Konium Designer`;
    copyLook(win);
    root = win.document.createElement('div');
    root.id = 'app';
    win.document.body.append(root);
  } catch { win.close(); notify('This browser kept the new window apart: the document stays here', 'error'); return false; }
  const dw: DocWin = { id, win, root, off: () => undefined };
  docWins.value = [...docWins.value, dw];
  docPlace.value = new Map(docPlace.value).set(od.id, id);
  activeId.value = od.id;
  const unmount = mountWindow(dw);
  // Closed by its own close button (or the main window reloading): its documents come back
  const gone = () => closeDocWindow(id, false);
  win.addEventListener('pagehide', gone);
  const poll = setInterval(() => { if (win.closed) gone(); }, 1000);
  dw.off = () => { clearInterval(poll); try { win.removeEventListener('pagehide', gone); } catch { /* closed */ } unmount(); };
  return true;
}

/** A document window closes: its documents come back to the main window, as they are. */
export function closeDocWindow(id: string, closeIt = true): void {
  const dw = docWins.value.find((w) => w.id === id);
  if (!dw) return;
  docWins.value = docWins.value.filter((w) => w !== dw);
  const m = new Map(docPlace.value);
  for (const [k, v] of m) if (v === id) m.delete(k);
  docPlace.value = m;
  try { dw.off(); } catch { /* the window went first */ }
  if (uiWin.peek() === dw.win) uiWin.value = window;
  if (closeIt) { try { dw.win.close(); } catch { /* gone */ } }
}

/** Move a document to a window ('' the main one); a document window left empty closes. */
export function moveDoc(od: OpenDoc, to: string): void {
  const from = placeOf(od.id);
  if (from === to) return;
  const m = new Map(docPlace.value);
  if (to) m.set(od.id, to); else m.delete(od.id);
  docPlace.value = m;
  activeId.value = od.id;
  if (from && !docsIn(from).length) closeDocWindow(from);
  const w = to ? docWins.value.find((x) => x.id === to)?.win : window;
  try { w?.focus(); } catch { /* the browser decides */ }
}

// A closed document leaves its window; a document window left with none closes
effect(() => {
  const ids = new Set(docs.value.map((d) => d.id));
  const stale = [...docPlace.peek().keys()].filter((k) => !ids.has(k));
  if (stale.length) { const m = new Map(docPlace.peek()); for (const k of stale) m.delete(k); docPlace.value = m; }
  for (const w of docWins.peek()) if (!docs.value.some((d) => placeOf(d.id) === w.id)) queueMicrotask(() => closeDocWindow(w.id));
});
// The main window going (reload, close): its document windows can't live on without it
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const w of docWins.peek()) { try { w.win.close(); } catch { /* gone */ } } });

/* ─── Which window things open in ────────────────────────────────────────────────────── */

/**
 * The window a passing thing (a menu, a popup, a notice, Preferences) belongs to: the one in use
 * when it opened, while that window is still open; else the main window.
 */
export function ownerOf(w: Window | null | undefined): Window {
  return w && w !== window && docWins.value.some((x) => x.win === w && !w.closed) ? w : window;
}
const owners = new Map<string, Window>();
export const ownersTick = signal(0);
/** Keep the window a flag-shown overlay opened in (Preferences, the shortcut sheet). */
export function trackOwner(name: string, open: () => boolean): void {
  effect(() => {
    const on = open();
    if (on && !owners.has(name)) { owners.set(name, uiWin.peek()); ownersTick.value++; }
    else if (!on && owners.delete(name)) ownersTick.value++;
  });
}
/** Whether an overlay tracked by name is drawn in this window. */
export function shownHere(name: string, here: Window): boolean { void ownersTick.value; void docWins.value; return ownerOf(owners.get(name)) === here; }

/** The notice at the bottom: in the window in use when it was given. */
export const toastWin = signal<Window | null>(null);
effect(() => { if (toast.value) toastWin.value = uiWin.peek(); });

/** Menus, dialogs and the like draw in whichever window is drawing them. */
export function Here({ name, children }: { name: string; children: ComponentChildren }) {
  return shownHere(name, useWin()) ? <>{children}</> : null;
}

/*
 * Effects run after the next frame of a window that is being drawn: the main window may be
 * covered or minimised while a document window is in use (its frames stop there).
 */
if (typeof window !== 'undefined') {
  const drawn = (): Window => {
    const u = uiWin.peek();
    for (const w of [u, window, ...docWins.peek().map((x) => x.win)]) { try { if (w && !w.closed && w.document.visibilityState === 'visible') return w; } catch { /* closing */ } }
    return window;
  };
  options.requestAnimationFrame = (cb: () => void) => {
    const w = drawn();
    let done = false;
    const go = () => { if (done) return; done = true; w.setTimeout(cb); };
    w.requestAnimationFrame(go);
    w.setTimeout(go, 100);
  };
}

/** Render a tree into another window's root (with its window in context). */
export function renderIn(dw: DocWin, node: ComponentChildren): () => void {
  render(<WinCtx.Provider value={dw.win}>{node}</WinCtx.Provider>, dw.root);
  return () => { try { render(null, dw.root); } catch { /* the window went first */ } };
}
