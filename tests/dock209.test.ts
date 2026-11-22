/**
 * 26.209: the first arrangement of the panels. Docked on the left: Projects, the Storage Manager
 * and the Inspector. Behind tabs on the right edge: Libraries, Parts (once the parts library is
 * switched on), Requirements, Calculators and the Clipboard. A desktop kept by an earlier build
 * is brought to it the first time it is read, for those panels and no others, and is left alone
 * after that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePanel, emptyLayout, findPanel, isOpen, openPanel, rearranged, setAutoHide, tuckPanel, type Layout } from '../src/app/dock/layout';
import { arrangement, DEFAULT_LEFT, defaultRight, panelMeta } from '../src/app/dock/panels';

const place = (l: Layout, id: string) => { const f = findPanel(l, id); return f ? [f.side ?? 'floating', f.g.id, !!f.g.autoHide] : null; };

/** A desktop as an earlier build kept it: its first arrangement, with Calculators open in a group of its own on the right (as it stood once used) and Messages at the bottom. */
function earlier(): Layout {
  const l = emptyLayout();
  l.zones.left.groups.push({ id: 'g1', panels: ['projects', 'navigator', 'library', 'filter', 'inspector'], active: 'projects', weight: 1 });
  l.zones.right.groups.push({ id: 'g2', panels: ['libraries'], active: 'libraries', weight: 1, autoHide: true });
  l.zones.right.groups.push({ id: 'g3', panels: ['calculators'], active: 'calculators', weight: 1 });
  l.zones.bottom.groups.push({ id: 'g4', panels: ['messages'], active: 'messages', weight: 1 });
  l.seq = 4;
  return l;
}
const tabs = (l: Layout, side: 'left' | 'right' | 'bottom') => l.zones[side].groups.map((g) => [g.panels, !!g.autoHide]);
const RIGHT = ['libraries', 'parts', 'requirements', 'calculators', 'clipboard'];

describe('a panel put behind a tab at an edge (26.209)', () => {
  it('goes beside the panel named, from wherever it stood; the rest stays', () => {
    const l = tuckPanel(earlier(), 'calculators', 'right', 'libraries');
    expect(place(l, 'calculators')).toEqual(['right', 'g2', true]);
    expect(l.zones.right.groups.map((g) => [g.id, g.panels, !!g.autoHide])).toEqual([['g2', ['libraries', 'calculators'], true]]);
    expect(l.zones.right.groups[0]!.active).toBe('libraries');
    expect(place(l, 'projects')).toEqual(['left', 'g1', false]);
    // (right after the one named; one that is behind a tab there already is left where it is)
    const more = tuckPanel(l, 'requirements', 'right', 'libraries');
    expect(more.zones.right.groups[0]!.panels).toEqual(['libraries', 'requirements', 'calculators']);
    expect(tuckPanel(more, 'calculators', 'right', 'libraries')).toBe(more);
    // (the one it stood beside stays open: only the panel named is moved)
    const shared = earlier();
    shared.zones.right.groups[1]!.panels.push('scripts');
    const s = tuckPanel(shared, 'calculators', 'right', 'libraries');
    expect([place(s, 'scripts'), place(s, 'calculators')]).toEqual([['right', 'g3', false], ['right', 'g2', true]]);
  });

  it('from a floating window, from nowhere, and with no hidden group to join', () => {
    const floating = earlier();
    floating.zones.right.groups.pop();
    floating.floating.push({ id: 'g4', panels: ['calculators'], active: 'calculators', weight: 1, rect: { x: 10, y: 10, w: 300, h: 400 } });
    const f = tuckPanel(floating, 'calculators', 'right', 'libraries');
    expect([place(f, 'calculators'), f.floating.length]).toEqual([['right', 'g2', true], 0]);
    const absent = earlier();
    absent.zones.right.groups.pop();
    expect(place(tuckPanel(absent, 'calculators', 'right', 'libraries'), 'calculators')).toEqual(['right', 'g2', true]);
    // (Libraries pinned open, or closed: no hidden group on the right, so one is made for it)
    const pinned = earlier();
    pinned.zones.right.groups[0]!.autoHide = undefined;
    const p = tuckPanel(pinned, 'calculators', 'right', 'libraries');
    expect(place(p, 'calculators')![2]).toBe(true);
    expect(place(p, 'libraries')).toEqual(['right', 'g2', false]);
    expect(findPanel(p, 'calculators')!.g.panels).toEqual(['calculators']);
  });
});

describe('the first arrangement (26.209)', () => {
  it('names its panels, each a panel there is; the Clipboard opens on the right now', () => {
    expect(DEFAULT_LEFT).toEqual(['projects', 'storage', 'inspector']);
    // (Parts takes its place after Libraries once the parts library is switched on: it is planned in this release.
    // Outside a browser, as here, every feature is on)
    expect(defaultRight(false)).toEqual(['libraries', 'requirements', 'calculators', 'clipboard']);
    expect(defaultRight(true)).toEqual(RIGHT);
    expect(defaultRight()).toEqual(RIGHT);
    for (const p of [...DEFAULT_LEFT, ...defaultRight(), 'parts', ...arrangement().gone]) expect(panelMeta(p), p).toBeTruthy();
    for (const p of [...defaultRight(), 'parts']) expect(panelMeta(p)!.place, p).toMatchObject({ side: 'right', group: 'g2' });
  });

  it('a desktop kept from the arrangement before is brought to it; what else is open stays', () => {
    const l = rearranged(earlier(), arrangement());
    expect(tabs(l, 'left')).toEqual([[['projects', 'storage', 'inspector'], false]]);
    expect(tabs(l, 'right')).toEqual([[RIGHT, true]]);
    expect(tabs(l, 'bottom')).toEqual([[['messages'], false]]);
    expect(l.zones.left.groups[0]!.active).toBe('projects');
    // (brought there once more, nothing changes)
    expect(rearranged(l, arrangement())).toEqual(l);
  });

  it('a desktop arranged by hand keeps what the arrangement does not name', () => {
    // Navigator moved to the bottom beside Messages, the Storage Manager floating, Libraries pinned open with Scripts, Projects closed
    const own = earlier();
    own.zones.left.groups[0]!.panels = ['projects', 'filter', 'inspector', 'pcb'];
    own.zones.bottom.groups[0]!.panels.push('navigator');
    own.floating.push({ id: 'g5', panels: ['storage'], active: 'storage', weight: 1, rect: { x: 10, y: 10, w: 300, h: 400 } });
    own.zones.right.groups[0] = { id: 'g2', panels: ['libraries', 'scripts'], active: 'scripts', weight: 1 };
    const l = rearranged(own, arrangement());
    expect(tabs(l, 'left')).toEqual([[['projects', 'inspector', 'pcb'], false]]);       // (the Filter beside Projects goes; the PCB panel stays)
    expect(tabs(l, 'bottom')).toEqual([[['messages', 'navigator'], false]]);            // (Navigator where it was put)
    expect(l.floating.map((g) => g.panels)).toEqual([['storage']]);                      // (the Storage Manager open already: left there)
    expect(place(l, 'scripts')).toEqual(['right', 'g2', false]);
    for (const p of defaultRight()) expect(place(l, p)![2], p).toBe(true);
    expect(findPanel(l, 'libraries')!.g.panels).toEqual(RIGHT);
    // (with Projects closed, the left is left alone; the right edge still gets its tabs)
    const none = earlier();
    none.zones.left.groups = [];
    const n = rearranged(none, arrangement());
    expect([tabs(n, 'left'), isOpen(n, 'storage')]).toEqual([[], false]);
    expect(findPanel(n, 'clipboard')!.g.autoHide).toBe(true);
  });
});

describe('a tool\'s panel (26.209)', () => {
  it('opens behind a tab on the right edge in the tools\' own group, which the next tool joins; pinned open, it leaves Libraries behind its tab', () => {
    let l = rearranged(earlier(), arrangement());
    for (const p of ['liveSim', 'thermalAnalysis', 'smartRouter', 'scripts']) expect(panelMeta(p)!.place, p).toEqual({ side: 'right', group: 'tools', autoHide: true });
    l = openPanel(l, 'liveSim', panelMeta('liveSim')!.place, 'sch', true);
    expect(place(l, 'liveSim')).toEqual(['right', 'tools', true]);
    l = openPanel(l, 'scripts', panelMeta('scripts')!.place);
    expect(findPanel(l, 'scripts')!.g.panels).toEqual(['liveSim', 'scripts']);
    expect(findPanel(l, 'libraries')!.g.panels).toEqual(RIGHT);
    l = setAutoHide(l, 'tools', false);
    expect([place(l, 'liveSim'), place(l, 'libraries')]).toEqual([['right', 'tools', false], ['right', 'g2', true]]);
    // (closed and opened again, it is back where it was; with its group gone, in a group made for it)
    l = openPanel(closePanel(l, 'scripts'), 'scripts', panelMeta('scripts')!.place);
    expect(place(l, 'scripts')).toEqual(['right', 'tools', false]);
    l = openPanel(closePanel(closePanel(l, 'scripts'), 'liveSim'), 'scripts', panelMeta('scripts')!.place);
    expect(place(l, 'scripts')![0]).toBe('right');
  });
});

describe('the desktop as the program starts (26.209)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const stored = (kept: Map<string, string>) => vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });

  it('a first start: three tabs docked on the left, the rest behind tabs on the right edge', async () => {
    const kept = new Map<string, string>();
    stored(kept);
    vi.resetModules();
    const { layout, defaultLayout } = await import('../src/app/dock/store');
    expect(tabs(layout.value, 'left')).toEqual([[['projects', 'storage', 'inspector'], false]]);
    expect(tabs(layout.value, 'right')).toEqual([[RIGHT, true]]);
    expect(defaultLayout().zones.right.groups[0]!.active).toBe('libraries');
    expect(kept.get('konium.layout.rev')).toBe('2');
  });

  it('a desktop kept by an earlier build is brought to the arrangement once, and is left alone after that', async () => {
    const kept = new Map<string, string>([['konium.layout.v1', JSON.stringify(earlier())], ['konium.layout.kinds.v1', JSON.stringify({ pcb: earlier() })]]);
    stored(kept);
    vi.resetModules();
    const first = await import('../src/app/dock/store');
    expect(tabs(first.layout.value, 'left')).toEqual([[['projects', 'storage', 'inspector'], false]]);
    expect(tabs(first.layout.value, 'right')).toEqual([[RIGHT, true]]);
    expect(tabs(first.layout.value, 'bottom')).toEqual([[['messages'], false]]);
    // (kept as brought up to date, the desktops of each kind of document with it)
    expect(kept.get('konium.layout.rev')).toBe('2');
    expect(place(JSON.parse(kept.get('konium.layout.v1')!) as Layout, 'calculators')).toEqual(['right', 'g2', true]);
    expect(place((JSON.parse(kept.get('konium.layout.kinds.v1')!) as Record<string, Layout>).pcb!, 'calculators')).toEqual(['right', 'g2', true]);
    // Arranged again by whoever uses it (Calculators pinned open, Navigator back): the next start leaves it
    kept.set('konium.layout.v1', JSON.stringify(earlier()));
    vi.resetModules();
    const again = await import('../src/app/dock/store');
    expect(place(again.layout.value, 'calculators')).toEqual(['right', 'g3', false]);
    expect(place(again.layout.value, 'navigator')).toEqual(['left', 'g1', false]);
  });
});
