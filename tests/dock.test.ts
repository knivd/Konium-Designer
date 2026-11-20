import { describe, expect, it } from 'vitest';
import { activate, closePanel, drop, emptyLayout, findPanel, frontOf, isOpen, openPanel, resizeSlide, resizeSplit, sanitiseLayout, setAutoHide, setNoDock, canDock, toggleFloat, type Layout } from '../src/app/dock/layout';

function base(): Layout {
  const l = emptyLayout();
  l.zones.left.groups.push({ id: 'g1', panels: ['projects', 'navigator', 'inspector'], active: 'projects', weight: 1 });
  l.zones.bottom.groups.push({ id: 'g2', panels: ['messages'], active: 'messages', weight: 1 });
  l.seq = 2;
  return l;
}
const known = new Set(['projects', 'navigator', 'inspector', 'messages', 'filter', 'list']);

describe('panel layout (docking)', () => {
  it('closing takes a panel out; opening puts it back where it was', () => {
    let l = closePanel(base(), 'navigator');
    expect(isOpen(l, 'navigator')).toBe(false);
    expect(l.zones.left.groups[0]!.panels).toEqual(['projects', 'inspector']);
    l = openPanel(l, 'navigator', { side: 'right' });
    expect(findPanel(l, 'navigator')!.g.id).toBe('g1');
    expect(findPanel(l, 'navigator')!.g.active).toBe('navigator');
    // A panel whose group has gone comes back on the same edge
    l = closePanel(closePanel(l, 'messages'), 'navigator');
    l = openPanel(l, 'messages', { side: 'left' });
    expect(findPanel(l, 'messages')!.side).toBe('bottom');
  });

  it('a tab dropped on a tab strip goes where it is dropped: its own group reordered, or another joined there', () => {
    let l = drop(base(), ['inspector'], { kind: 'join', group: 'g1', before: 'projects' });
    expect(l.zones.left.groups[0]!.panels).toEqual(['inspector', 'projects', 'navigator']);
    l = drop(l, ['inspector'], { kind: 'join', group: 'g1', before: '' });
    expect(l.zones.left.groups[0]!.panels).toEqual(['projects', 'navigator', 'inspector']);
    l = drop(l, ['messages'], { kind: 'join', group: 'g1', before: 'navigator' });
    expect(l.zones.left.groups[0]!.panels).toEqual(['projects', 'messages', 'navigator', 'inspector']);
    expect(drop(l, ['messages'], { kind: 'join', group: 'g1', before: 'messages' })).toBe(l);
  });

  it('a dragged tab docks on an edge, joins a group or floats; empty groups go', () => {
    let l = drop(base(), ['inspector'], { kind: 'edge', side: 'right', outer: false });
    expect(l.zones.right.groups.map((g) => g.panels)).toEqual([['inspector']]);
    l = drop(l, ['messages'], { kind: 'join', group: l.zones.right.groups[0]!.id });
    expect(l.zones.right.groups[0]!.panels).toEqual(['inspector', 'messages']);
    expect(l.zones.bottom.groups).toHaveLength(0);
    l = drop(l, ['projects', 'navigator'], { kind: 'float', rect: { x: 50, y: 60, w: 300, h: 400 } });
    expect(l.floating.map((g) => g.panels)).toEqual([['projects', 'navigator']]);
    expect(l.zones.left.groups).toHaveLength(0);
    l = drop(l, ['navigator'], { kind: 'split', group: l.zones.right.groups[0]!.id, after: true });
    expect(l.zones.right.groups.map((g) => g.panels)).toEqual([['inspector', 'messages'], ['navigator']]);
    expect(l.zones.right.groups[0]!.weight).toBeCloseTo(0.5);
    l = resizeSplit(l, 'right', 0, 0.7);
    expect(l.zones.right.groups[0]!.weight / (l.zones.right.groups[0]!.weight + l.zones.right.groups[1]!.weight)).toBeCloseTo(0.7);
  });

  it('auto-hide, float and back, Allow Dock', () => {
    let l = setAutoHide(base(), 'g1', true);
    expect(l.zones.left.groups[0]!.autoHide).toBe(true);
    // Pinned off, the slide-out is resized on its own (the zone keeps its size) and the size is stored
    l = resizeSlide(l, 'g1', 420);
    expect([l.zones.left.groups[0]!.slideSize, l.zones.left.size]).toEqual([420, base().zones.left.size]);
    expect(sanitiseLayout(JSON.parse(JSON.stringify(l)), known, base()).zones.left.groups[0]!.slideSize).toBe(420);
    l = toggleFloat(setAutoHide(l, 'g1', false), 'g1', { x: 10, y: 10, w: 200, h: 300 });
    expect(l.floating[0]!.panels).toEqual(['projects', 'navigator', 'inspector']);
    l = toggleFloat(l, 'g1', { x: 0, y: 0, w: 0, h: 0 });
    expect(l.zones.left.groups[0]!.id).toBe('g1');
    l = setNoDock(l, 'inspector', 'v', true);
    expect(canDock(l, ['inspector'], 'left')).toBe(false);
    expect(canDock(l, ['inspector'], 'bottom')).toBe(true);
    l = activate(l, 'inspector');
    expect(l.zones.left.groups[0]!.active).toBe('inspector');
  });

  it('a stored layout is cleaned: unknown and repeated panels dropped', () => {
    const raw = JSON.parse(JSON.stringify(base())) as Layout;
    raw.zones.left.groups[0]!.panels.push('gone', 'messages');
    raw.floating.push({ id: 'g1', panels: ['filter'], active: 'x', weight: -1, rect: { x: 1, y: 2, w: 3, h: 4 } });
    const l = sanitiseLayout(raw, known, base());
    expect(l.zones.left.groups[0]!.panels).toEqual(['projects', 'navigator', 'inspector', 'messages']);
    expect(l.zones.bottom.groups).toHaveLength(0);
    expect(l.floating[0]!.active).toBe('filter');
    expect(l.floating[0]!.id).not.toBe('g1');
    expect(sanitiseLayout({ v: 2 }, known, base())).toEqual(base());
  });

  it('the tab in front is remembered per editor kind', () => {
    const g = () => l.zones.left.groups[0]!;
    // The PCB Inspector brought up on a board: a schematic shows what was chosen there (Projects)
    let l = activate(base(), 'projects', 'sch');
    l = activate(l, 'inspector', 'pcb', true);
    expect(frontOf(g(), 'pcb', g().panels)).toBe('inspector');
    expect(frontOf(g(), 'sch', g().panels)).toBe('projects');
    // …or the first tab where nothing was chosen yet
    expect(frontOf(g(), 'pcblib', g().panels)).toBe('projects');
    // A general panel chosen anywhere shows everywhere
    l = activate(l, 'navigator', 'pcb');
    expect(frontOf(g(), 'sch', g().panels)).toBe('navigator');
    // The SCH Inspector chosen on a schematic, Projects then chosen on a board: Projects on both
    l = activate(activate(l, 'inspector', 'sch', true), 'projects', 'pcb');
    expect(frontOf(g(), 'sch', g().panels)).toBe('projects');
    expect(frontOf(g(), 'global', ['projects', 'navigator'])).toBe('projects');
    // Kept through a save, dropped with its panel
    l = activate(l, 'inspector', 'pcb', true);
    const again = sanitiseLayout(JSON.parse(JSON.stringify(l)), known, base());
    expect(again.zones.left.groups[0]!.activeIn).toBe('pcb');
    expect(again.zones.left.groups[0]!.front).toEqual({ sch: 'inspector', pcb: 'inspector' });
    l = closePanel(l, 'inspector');
    expect(g().front).toEqual({});
    expect(g().activeIn).toBeUndefined();
  });
});
