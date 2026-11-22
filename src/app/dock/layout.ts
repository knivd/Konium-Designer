/**
 * Workspace panel layout, as Altium Designer 17 arranges its panels: groups of tabbed panels
 * docked along the four edges of the window (several groups to an edge, stacked), floating
 * groups, and groups pinned open or set to auto-hide behind tabs on their edge. Closing a
 * panel takes it out of the layout entirely; reopening it puts it back where it was.
 *
 * Pure data and functions, no UI: every operation returns a new layout.
 */

export type Side = 'left' | 'right' | 'top' | 'bottom';
export const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];
export const vertical = (s: Side) => s === 'left' || s === 'right';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Group {
  id: string;
  /** Panel ids, in tab order. */
  panels: string[];
  /** The tab last brought to the front. */
  active: string;
  /**
   * The editor kind ('sch', 'pcb' …) `active` was chosen in, when it is an editor's own panel:
   * the PCB Inspector brought up on a board is not the SCH Inspector on the next schematic.
   */
  activeIn?: string;
  /** The tab last chosen in each editor kind, for when `active` belongs to another. */
  front?: Record<string, string>;
  /** Share of its zone (groups on one edge split the zone in proportion). */
  weight: number;
  /** Pin off: collapsed to tabs on the edge, sliding out when pointed at. */
  autoHide?: boolean;
  /** Pinned off: how far it slides out (px); the zone's size until it is dragged. */
  slideSize?: number;
}

export interface Zone {
  /** Width of a left/right zone, height of a top/bottom one (px). */
  size: number;
  groups: Group[];
}

export interface FloatGroup extends Group { rect: Rect }

/** Where a panel was before it was closed (or moved), to bring it back there. */
export interface Place {
  side?: Side;
  group?: string;
  index?: number;
  rect?: Rect;
  autoHide?: boolean;
}

export interface Layout {
  v: 1;
  zones: Record<Side, Zone>;
  floating: FloatGroup[];
  last: Record<string, Place>;
  /** Allow Dock ▸ Horizontally / Vertically switched off, per panel. */
  noDock: Record<string, { h?: boolean; v?: boolean }>;
  /** F4: floating panels hidden. */
  floatHidden?: boolean;
  seq: number;
}

export type DropTarget =
  | { kind: 'join'; group: string; index?: number; /** Put before this tab (dropped on a tab strip); at the end when absent. */ before?: string }
  | { kind: 'edge'; side: Side; outer: boolean }
  | { kind: 'split'; group: string; after: boolean }
  | { kind: 'float'; rect: Rect };

export const ZONE_DEFAULT: Record<Side, number> = { left: 300, right: 300, top: 160, bottom: 190 };
export const ZONE_MIN = 120;

const clone = (l: Layout): Layout => structuredClone(l);
const newId = (l: Layout) => `g${++l.seq}`;

export function emptyLayout(): Layout {
  return { v: 1, zones: { left: { size: ZONE_DEFAULT.left, groups: [] }, right: { size: ZONE_DEFAULT.right, groups: [] }, top: { size: ZONE_DEFAULT.top, groups: [] }, bottom: { size: ZONE_DEFAULT.bottom, groups: [] } },
    floating: [], last: {}, noDock: {}, seq: 0 };
}

/** Every group, docked and floating, with where it lives. */
export function allGroups(l: Layout): { g: Group; side?: Side; float?: FloatGroup }[] {
  const out: { g: Group; side?: Side; float?: FloatGroup }[] = [];
  for (const s of SIDES) for (const g of l.zones[s].groups) out.push({ g, side: s });
  for (const f of l.floating) out.push({ g: f, float: f });
  return out;
}

export function findGroup(l: Layout, id: string): { g: Group; side?: Side; float?: FloatGroup } | undefined {
  return allGroups(l).find((x) => x.g.id === id);
}

export function findPanel(l: Layout, panel: string): { g: Group; side?: Side; float?: FloatGroup } | undefined {
  return allGroups(l).find((x) => x.g.panels.includes(panel));
}

export const isOpen = (l: Layout, panel: string) => !!findPanel(l, panel);

/** The place a panel occupies now (for remembering it). */
function placeOf(l: Layout, panel: string): Place | undefined {
  const f = findPanel(l, panel);
  if (!f) return undefined;
  if (f.side) return { side: f.side, group: f.g.id, index: l.zones[f.side].groups.indexOf(f.g), autoHide: f.g.autoHide };
  return { group: f.g.id, rect: { ...f.float!.rect } };
}

/** Take panels out of their groups (dropping groups left empty). */
function detach(l: Layout, panels: string[]): void {
  for (const x of allGroups(l)) {
    const g = x.g;
    if (!panels.some((p) => g.panels.includes(p))) continue;
    g.panels = g.panels.filter((p) => !panels.includes(p));
    if (!g.panels.includes(g.active)) { g.active = g.panels[0] ?? ''; g.activeIn = undefined; }
    if (g.front) for (const [k, p] of Object.entries(g.front)) if (!g.panels.includes(p)) delete g.front[k];
  }
  for (const s of SIDES) l.zones[s].groups = l.zones[s].groups.filter((g) => g.panels.length);
  l.floating = l.floating.filter((g) => g.panels.length);
}

/** Close: the panel leaves the layout; where it was is remembered. */
export function closePanel(l0: Layout, panel: string): Layout {
  const l = clone(l0);
  const p = placeOf(l, panel);
  if (!p) return l0;
  l.last[panel] = p;
  detach(l, [panel]);
  return l;
}

/**
 * A panel put behind a tab at an edge, from wherever it stands (or from nowhere): into the side's
 * hidden group that holds `beside`, right after it; else into the side's first hidden group; else
 * into a hidden group of its own. One that is behind a tab on that side already is left there.
 */
export function tuckPanel(l0: Layout, panel: string, side: Side, beside?: string): Layout {
  const at = findPanel(l0, panel);
  if (at?.side === side && at.g.autoHide) return l0;
  const l = clone(l0);
  if (at) detach(l, [panel]);
  delete l.last[panel];
  const groups = l.zones[side].groups;
  const g = (beside ? groups.find((x) => x.autoHide && x.panels.includes(beside)) : undefined) ?? groups.find((x) => x.autoHide);
  if (!g) groups.push({ id: newId(l), panels: [panel], active: panel, weight: 1, autoHide: true });
  else if (beside && g.panels.includes(beside)) g.panels.splice(g.panels.indexOf(beside) + 1, 0, panel);
  else g.panels.push(panel);
  return l;
}

/** A first arrangement of the panels: those that stand as tabs beside `main`, and those behind tabs on the right edge. */
export interface Arrangement { main: string; left: string[]; right: string[]; /** The tabs the arrangement before had beside `main` and this one has not. */ gone: string[] }

/**
 * A desktop kept from before brought to a new first arrangement, for the panels the arrangement
 * names and no others: `right` behind tabs on the right edge, in their order; `gone` closed where
 * they still stand beside `main`; `left` as tabs beside `main` where they are not open anywhere.
 * What else is open (at the bottom, floating, pinned beside these) stays where it is.
 */
export function rearranged(l0: Layout, a: Arrangement): Layout {
  let l = l0;
  const [first, ...rest] = a.right;
  if (first) {
    l = tuckPanel(l, first, 'right');
    // (each put right after the first, the last of them first: they end in their order)
    for (const p of [...rest].reverse()) l = tuckPanel(l, p, 'right', first);
  }
  const m = findPanel(l, a.main);
  if (!m?.side) return l;
  for (const p of a.gone) if (findPanel(l, p)?.g.id === m.g.id) l = closePanel(l, p);
  const out = clone(l), g = findPanel(out, a.main)!.g;
  let at = g.panels.indexOf(a.main) + 1;
  for (const p of a.left) {
    if (p === a.main) continue;
    if (isOpen(out, p)) { if (g.panels.includes(p)) at = g.panels.indexOf(p) + 1; continue; }
    g.panels.splice(at++, 0, p);
  }
  return out;
}

/**
 * Show the panel's tab in its group (and the group, if F4 hid floating panels). `ctx` is the
 * editor kind it's shown in; `scoped` says the panel exists only in some editors (SCH / PCB
 * Inspector …), so it becomes that kind's choice without becoming the group's general one.
 */
export function activate(l0: Layout, panel: string, ctx?: string, scoped = false): Layout {
  const l = clone(l0);
  const f = findPanel(l, panel);
  if (!f) return l0;
  choose(f.g, panel, ctx, scoped);
  if (f.float) l.floatHidden = false;
  return l;
}

function choose(g: Group, panel: string, ctx: string | undefined, scoped: boolean): void {
  g.active = panel;
  g.activeIn = scoped && ctx ? ctx : undefined;
  if (ctx) g.front = { ...g.front, [ctx]: panel };
}

/**
 * The tab a group shows in this editor kind: the one last chosen, unless it was another
 * editor's own panel; then the one last chosen in this kind; else the first.
 */
export function frontOf(g: Group, ctx: string, visible: readonly string[]): string | undefined {
  if (visible.includes(g.active) && (!g.activeIn || g.activeIn === ctx)) return g.active;
  const own = g.front?.[ctx];
  return own && visible.includes(own) ? own : visible[0];
}

/** The group the tools' panels share (panels.ts): behind tabs on the right edge, apart from the panels that are there at first. */
export const TOOLS_GROUP = 'tools';

/**
 * Open a closed panel where it was last (its old group if that still exists, else a new group
 * on the same edge or floating where it floated), else at the default place given.
 */
export function openPanel(l0: Layout, panel: string, def: Place, ctx?: string, scoped = false): Layout {
  if (isOpen(l0, panel)) return activate(l0, panel, ctx, scoped);
  const l = clone(l0);
  const want = l.last[panel] ?? def;
  const into = want.group ? findGroup(l, want.group) : undefined;
  if (into) {
    into.g.panels.push(panel);
    choose(into.g, panel, ctx, scoped);
    if (into.float) l.floatHidden = false;
    return l;
  }
  // (a first place may name its group, one that is made when its first panel opens and joined by those that open after it:
  // a name of its own, never one of the numbered ids that groups are given as they are made)
  const named = want.group && !/^g\d+$/.test(want.group) ? want.group : undefined;
  const g: Group = { id: named ?? newId(l), panels: [panel], active: panel, weight: 1, autoHide: want.autoHide };
  choose(g, panel, ctx, scoped);
  if (want.side) {
    const z = l.zones[want.side];
    z.groups.splice(Math.min(want.index ?? z.groups.length, z.groups.length), 0, g);
  } else {
    l.floating.push({ ...g, rect: want.rect ?? { x: 160, y: 120, w: 300, h: 420 } });
    l.floatHidden = false;
  }
  return l;
}

/** Dock or float panels (a whole group dragged, or one tab) at a drop target. */
export function drop(l0: Layout, panels: string[], target: DropTarget): Layout {
  if (!panels.length) return l0;
  const l = clone(l0);
  const from = findPanel(l, panels[0]!);
  const wasActive = from?.g.active && panels.includes(from.g.active) ? from.g.active : panels[0]!;
  const autoHide = from?.g.autoHide;
  if (target.kind === 'join') {
    const into = findGroup(l, target.group);
    if (!into) return l0;
    // Within the group: its tabs reordered (dropped on its own tab strip)
    const reorder = target.before !== undefined || target.index !== undefined;
    if (panels.every((p) => into.g.panels.includes(p)) && (!reorder || panels.includes(target.before ?? ''))) return l0;
    detach(l, panels);
    const again = findGroup(l, target.group);
    if (!again) return l0;
    const b = target.before !== undefined ? again.g.panels.indexOf(target.before) : -1;
    const at = b >= 0 ? b : Math.min(target.index ?? again.g.panels.length, again.g.panels.length);
    again.g.panels.splice(at, 0, ...panels);
    again.g.active = wasActive;
    return l;
  }
  detach(l, panels);
  const g: Group = { id: newId(l), panels: [...panels], active: wasActive, weight: 1 };
  if (target.kind === 'float') {
    l.floating.push({ ...g, rect: { ...target.rect } });
    l.floatHidden = false;
    return l;
  }
  if (target.kind === 'edge') {
    const z = l.zones[target.side];
    // A new edge group shares the zone evenly with what is there
    g.weight = z.groups.length ? z.groups.reduce((s, x) => s + x.weight, 0) / z.groups.length : 1;
    if (target.outer) z.groups.unshift(g); else z.groups.push(g);
    g.autoHide = undefined;
    return l;
  }
  // split: above / below (left of / right of) a docked group, halving its share
  const next = findGroup(l, target.group);
  if (!next?.side) return l0;
  const z = l.zones[next.side];
  const i = z.groups.indexOf(next.g);
  next.g.weight /= 2;
  g.weight = next.g.weight;
  g.autoHide = next.g.autoHide ?? autoHide;
  z.groups.splice(target.after ? i + 1 : i, 0, g);
  return l;
}

/** Pin / unpin a docked group. */
export function setAutoHide(l0: Layout, group: string, on: boolean): Layout {
  const l = clone(l0);
  const f = findGroup(l, group);
  if (!f?.side) return l0;
  f.g.autoHide = on || undefined;
  return l;
}

/** Double-click on a title bar: docked → floating at its on-screen rect; floating → back to its last edge. */
export function toggleFloat(l0: Layout, group: string, rect: Rect): Layout {
  const l = clone(l0);
  const f = findGroup(l, group);
  if (!f) return l0;
  if (f.side) {
    for (const p of f.g.panels) l.last[`dock:${p}`] = { side: f.side, index: l.zones[f.side].groups.indexOf(f.g) };
    l.zones[f.side].groups = l.zones[f.side].groups.filter((g) => g !== f.g);
    l.floating.push({ ...f.g, autoHide: undefined, rect });
    l.floatHidden = false;
    return l;
  }
  const back = l.last[`dock:${f.g.active}`] ?? { side: 'left' as Side };
  l.floating = l.floating.filter((g) => g !== f.float);
  const { rect: _r, ...g } = f.float!;
  const z = l.zones[back.side ?? 'left'];
  z.groups.splice(Math.min(back.index ?? z.groups.length, z.groups.length), 0, g);
  return l;
}

export function resizeZone(l0: Layout, side: Side, size: number): Layout {
  const l = clone(l0);
  l.zones[side].size = Math.max(ZONE_MIN, Math.round(size));
  return l;
}

/** A pinned-off group's slide-out dragged to a size. */
export function resizeSlide(l0: Layout, group: string, size: number): Layout {
  const l = clone(l0);
  const f = findGroup(l, group);
  if (f) f.g.slideSize = Math.max(ZONE_MIN, Math.round(size));
  return l;
}

/** Splitter between groups i and i + 1 of a zone: their shares, as fractions of the pair. */
export function resizeSplit(l0: Layout, side: Side, i: number, frac: number): Layout {
  const l = clone(l0);
  const gs = l.zones[side].groups.filter((g) => !g.autoHide);
  const a = gs[i], b = gs[i + 1];
  if (!a || !b) return l0;
  const sum = a.weight + b.weight;
  const f = Math.min(0.9, Math.max(0.1, frac));
  a.weight = sum * f;
  b.weight = sum * (1 - f);
  return l;
}

export function moveFloat(l0: Layout, group: string, rect: Rect): Layout {
  const l = clone(l0);
  const f = l.floating.find((g) => g.id === group);
  if (!f) return l0;
  f.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(160, Math.round(rect.w)), h: Math.max(100, Math.round(rect.h)) };
  return l;
}

/** Bring a floating group to the front. */
export function raiseFloat(l0: Layout, group: string): Layout {
  const i = l0.floating.findIndex((g) => g.id === group);
  if (i < 0 || i === l0.floating.length - 1) return l0;
  const l = clone(l0);
  const [g] = l.floating.splice(i, 1);
  l.floating.push(g!);
  return l;
}

export function setNoDock(l0: Layout, panel: string, which: 'h' | 'v', off: boolean): Layout {
  const l = clone(l0);
  const nd = { ...(l.noDock[panel] ?? {}) };
  if (off) nd[which] = true; else delete nd[which];
  if (nd.h || nd.v) l.noDock[panel] = nd; else delete l.noDock[panel];
  return l;
}

/** Can these panels dock on this edge (Allow Dock ▸ Horizontally for top/bottom, Vertically for left/right)? */
export function canDock(l: Layout, panels: string[], side: Side): boolean {
  return panels.every((p) => !(vertical(side) ? l.noDock[p]?.v : l.noDock[p]?.h));
}

export function toggleFloatHidden(l0: Layout): Layout {
  return { ...l0, floatHidden: !l0.floatHidden };
}

/** A stored layout made safe: known panels once each, sane sizes; unknown panels dropped. */
export function sanitiseLayout(input: unknown, known: Set<string>, fallback: Layout): Layout {
  try {
    const l = input as Layout;
    if (!l || l.v !== 1 || !l.zones) return fallback;
    const out = emptyLayout();
    const seen = new Set<string>();
    const fixGroup = (g: Group): Group | null => {
      const panels = (Array.isArray(g.panels) ? g.panels : []).filter((p) => typeof p === 'string' && known.has(p) && !seen.has(p));
      panels.forEach((p) => seen.add(p));
      if (!panels.length) return null;
      const front = g.front && typeof g.front === 'object' ? Object.fromEntries(Object.entries(g.front).filter(([k, p]) => typeof k === 'string' && typeof p === 'string' && panels.includes(p))) : undefined;
      const keep = panels.includes(g.active);
      return { id: String(g.id), panels, active: keep ? g.active : panels[0]!, activeIn: keep && typeof g.activeIn === 'string' ? g.activeIn : undefined, front: front && Object.keys(front).length ? front : undefined,
        weight: Number(g.weight) > 0 ? Number(g.weight) : 1, autoHide: g.autoHide ? true : undefined,
        ...(g.autoHide && Number(g.slideSize) > 0 ? { slideSize: Math.max(ZONE_MIN, Math.min(1200, Math.round(Number(g.slideSize)))) } : {}) };
    };
    for (const s of SIDES) {
      const z = l.zones[s];
      if (!z) continue;
      out.zones[s].size = Math.max(ZONE_MIN, Math.min(1200, Number(z.size) || ZONE_DEFAULT[s]));
      out.zones[s].groups = (Array.isArray(z.groups) ? z.groups : []).map(fixGroup).filter((g): g is Group => !!g);
    }
    out.floating = [];
    for (const f of Array.isArray(l.floating) ? l.floating : []) {
      const g = fixGroup(f);
      if (!g) continue;
      const r = f.rect ?? { x: 100, y: 100, w: 300, h: 400 };
      out.floating.push({ ...g, autoHide: undefined, rect: { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Math.max(160, Number(r.w) || 300), h: Math.max(100, Number(r.h) || 400) } });
    }
    out.last = typeof l.last === 'object' && l.last ? structuredClone(l.last) : {};
    out.noDock = typeof l.noDock === 'object' && l.noDock ? structuredClone(l.noDock) : {};
    out.floatHidden = !!l.floatHidden;
    const ids = allGroups(out).map((x) => Number(x.g.id.slice(1)) || 0);
    out.seq = Math.max(Number(l.seq) || 0, ...ids, 0);
    // Group ids must be unique
    const used = new Set<string>();
    for (const x of allGroups(out)) { if (used.has(x.g.id)) x.g.id = `g${++out.seq}`; used.add(x.g.id); }
    return out;
  } catch {
    return fallback;
  }
}
