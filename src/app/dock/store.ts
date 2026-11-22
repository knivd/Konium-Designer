/**
 * The live panel layout: one signal, remembered per browser profile, plus the calls the rest
 * of the app uses — show, close, toggle a panel; Desktop Layouts (Default, Startup, load, save).
 */
import { signal } from '@preact/signals';
import { formerValue } from '../../core/former';
import { readLocal, writeLocal } from '../../core/storage';
import { settings } from '../../core/settings';
import type { Scope } from '../../core/commands';
import { activate, allGroups, closePanel, emptyLayout, findPanel, frontOf, isOpen, openPanel, rearranged, sanitiseLayout, toggleFloatHidden, tuckPanel, type Layout } from './layout';
import { DEFAULT_LEFT, KNOWN_PANELS, MAIN_GROUP, arrangement, defaultRight, panelAvailable, panelMeta } from './panels';
import { featureOn } from '../../core/release';

const KEY = 'layout.v1';
/**
 * The desktop's revision. 2 (26.209): the first arrangement is Projects, the Storage Manager and the Inspector on the
 * left, and Libraries, Requirements, Calculators and the Clipboard behind tabs on the right edge (panels.ts). A desktop
 * kept by an earlier build is brought to it the first time it is read, for those panels and no others; after that it is
 * whoever uses it who arranges it. (Read here, before the layout is: what the layout's own reading needs has to be set
 * up above it.)
 */
const REV_KEY = 'layout.rev', REV = 2;
const keptRev = Number(readLocal(REV_KEY)) || 1;
function upToDate(l: Layout): Layout {
  if (keptRev >= REV) return l;
  const out = structuredClone(rearranged(l, arrangement()));
  // (a tool's panel that was closed while it shared Libraries' group opens in the tools' own group the next time)
  const beside = findPanel(out, 'libraries')?.g.id, mine = arrangement().right;
  for (const [p, at] of Object.entries(out.last)) if (at.group && at.group === beside && !mine.includes(p)) delete out.last[p];
  return out;
}
/** The Parts tab joins the right edge, after Libraries, the first time the parts library is switched on (once). */
const PARTS_KEY = 'layout.parts';
const partsDue = featureOn('partsLibrary') && readLocal(PARTS_KEY) !== '1';
const withParts = (l: Layout): Layout => (partsDue ? tuckPanel(l, 'parts', 'right', 'libraries') : l);

export function defaultLayout(): Layout {
  const l = emptyLayout();
  l.zones.left.groups.push({ id: MAIN_GROUP, panels: [...DEFAULT_LEFT], active: 'projects', weight: 1 });
  // Behind tabs on the right edge: Libraries, as Altium starts, and Konium's own beside it
  l.zones.right.groups.push({ id: 'g2', panels: defaultRight(), active: 'libraries', weight: 1, autoHide: true });
  l.seq = 2;
  return l;
}

function load(): Layout {
  try {
    const raw = readLocal(KEY);
    if (raw) {
      const l = sanitiseLayout(JSON.parse(raw), KNOWN_PANELS, defaultLayout());
      // Layouts saved before tabs were remembered per editor: an editor panel (SCH / PCB
      // Inspector, Filter …) left in front gives way to the group's first tab (Projects)
      for (const { g } of allGroups(l)) if (!g.front && !g.activeIn && panelMeta(g.active)?.when) g.active = g.panels[0]!;
      const now = withParts(upToDate(l));
      // (kept as brought up to date, whatever Autosave desktop says: the next start reads it as of this revision)
      if (now !== l) writeLocal(KEY, JSON.stringify(now));
      marks();
      return now;
    }
  } catch { /* fall through */ }
  marks();
  return defaultLayout();
}
/** The revision read, and Parts given its tab, noted for the next start. */
function marks(): void {
  if (keptRev < REV) writeLocal(REV_KEY, String(REV));
  if (partsDue) writeLocal(PARTS_KEY, '1');
}

/** The editor kind panels are shown in now (set by the app). */
let scopeNow: () => string = () => 'global';
export function setScopeSource(f: () => string): void { scopeNow = f; }

export const layout = signal<Layout>(load());
/** A panel made to fail, by its id (for the smoke test, through ?debug: what a panel that fails does to the rest). */
export const failing = signal<string | null>(null);
/** The layout as it was when Konium started (Desktop Layouts › Startup). */
const startup = structuredClone(layout.value);
/** The auto-hidden group slid out over the document, if any. */
export const slideOut = signal<string | null>(null);

export function setLayout(l: Layout): void {
  if (l === layout.value) return;
  layout.value = l;
  // System › View › Autosave desktop: off, the layout last kept is the one the next session starts with
  if (settings.autosaveDesktop) writeLocal(KEY, JSON.stringify(l));
}

/** Show a panel: open it where it was (or its first place) and bring its tab to the front. */
export function showPanel(id: string): void {
  const m = panelMeta(id);
  if (!m) return;
  setLayout(openPanel(layout.value, id, m.place, scopeNow(), !!m.when));
  const f = findPanel(layout.value, id);
  if (f?.g.autoHide) slideOut.value = f.g.id;
}

export function hidePanel(id: string): void {
  const f = findPanel(layout.value, id);
  if (f && slideOut.value === f.g.id && f.g.panels.length === 1) slideOut.value = null;
  setLayout(closePanel(layout.value, id));
}

export const panelOpen = (id: string) => isOpen(layout.value, id);

/** On screen now: open, available in this editor, its tab in front and not tucked away. */
export function panelShowing(id: string, scope: Scope): boolean {
  const f = findPanel(layout.value, id);
  if (!f || !panelAvailable(id, scope)) return false;
  if (f.float && layout.value.floatHidden) return false;
  if (f.g.autoHide && slideOut.value !== f.g.id) return false;
  return frontOf(f.g, scope, f.g.panels.filter((p) => panelAvailable(p, scope))) === id;
}

/** View › Workspace Panels, F11, F12 …: hide a panel that is showing, otherwise show it. */
export function togglePanel(id: string, scope: Scope): void {
  if (panelShowing(id, scope)) hidePanel(id); else showPanel(id);
}

/** Bring a panel's tab to the front without opening a closed one. */
export function frontPanel(id: string): void { setLayout(activate(layout.value, id, scopeNow(), !!panelMeta(id)?.when)); }

/** F4: hide or show every floating panel. */
export function toggleFloating(): void { setLayout(toggleFloatHidden(layout.value)); }

/**
 * System › View › Remember window for each document kind: the panels as they were last arranged
 * for each kind of document (schematic, board, library …), put back when a document of that
 * kind comes to the front. The Home page and the like leave the layout as it is.
 */
const KINDS_KEY = 'layout.kinds.v1';
const perKind: Record<string, Layout> = (() => {
  try {
    const kept = JSON.parse(readLocal(KINDS_KEY) ?? '{}') as Record<string, Layout>;
    if (keptRev >= REV && !partsDue) return kept;
    // (the desktops kept for each kind of document are brought up to date with the main one)
    const now = Object.fromEntries(Object.entries(kept).map(([k, l]) => [k, withParts(upToDate(sanitiseLayout(l, KNOWN_PANELS, defaultLayout())))]));
    if (Object.keys(now).length) writeLocal(KINDS_KEY, JSON.stringify(now));
    return now;
  } catch { return {}; }
})();
let lastKind: string | null = null;
const KINDS = new Set(['sch', 'pcb', 'schlib', 'pcblib', 'cam', 'outjob', 'bom', 'draftsman', 'harness', 'mbs', 'text', 'simview', 'simtext', 'step', 'diagram', 'enclosure']);
export function kindShown(scope: string): void {
  if (!KINDS.has(scope)) return;
  if (!settings.layoutPerKind) { lastKind = scope; return; }
  if (scope === lastKind) return;
  if (lastKind) perKind[lastKind] = structuredClone(layout.value);
  const next = perKind[scope];
  lastKind = scope;
  if (next) { slideOut.value = null; setLayout(sanitiseLayout(structuredClone(next), KNOWN_PANELS, layout.value)); }
  if (settings.autosaveDesktop) writeLocal(KINDS_KEY, JSON.stringify(perKind));
}
/** Forget the layouts kept per kind (a Desktop Layout put back sets them all). */
function forgetKinds(): void { for (const k of Object.keys(perKind)) delete perKind[k]; writeLocal(KINDS_KEY, '{}'); }

export type DesktopLayout = 'default' | 'startup';
export function restoreLayout(which: DesktopLayout): void {
  forgetKinds();
  slideOut.value = null;
  setLayout(structuredClone(which === 'default' ? defaultLayout() : startup));
}

export function layoutJson(): string {
  return JSON.stringify({ konium: 'layout', version: 1, layout: layout.value }, null, 2);
}

export function loadLayoutJson(text: string): void {
  const parsed = JSON.parse(text) as Record<string, unknown> & { konium?: string; vibium?: string; layout?: unknown };
  // Files saved under the earlier names say so
  if ((parsed.konium ?? formerValue(parsed) ?? parsed.vibium) !== 'layout' || !parsed.layout) throw new Error('not a Konium Designer layout file');
  slideOut.value = null;
  forgetKinds();
  setLayout(sanitiseLayout(parsed.layout, KNOWN_PANELS, layout.value));
}
