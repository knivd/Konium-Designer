/**
 * The enclosure designer's tools and features: what each tool puts on a face where it is clicked
 * (an opening, a pocket, vents, a protrusion, text or a logo), and how each feature is named and
 * drawn in the Features list. Features found from the board belong to the template; the rest are
 * the user's own.
 */
import { newAdd, type Add, type AddKind, type EnclosureSpec, type Face, type Label, type Layout, type Opening, type Vent } from '../model/enclosure';
import { FACE_NAME } from '../model/enclosureSolid';

export type ItemList = 'openings' | 'vents' | 'labels' | 'adds';
export type Pick = { list: ItemList; i: number } | null;
export type Item = Opening | Vent | Label | Add;

export type ToolId = 'select' | 'hole' | 'cutout' | 'slot' | 'pocket' | 'vents' | AddKind | 'text' | 'logo';
export interface Tool { id: ToolId; label: string; icon: string; title: string; group: 'pick' | 'cut' | 'add' | 'mark' }
export const TOOLS: Tool[] = [
  { id: 'select', label: 'Select', icon: 'encSelect', title: 'Pick and move what is on the box (Esc)', group: 'pick' },
  { id: 'hole', label: 'Hole', icon: 'encHole', title: 'A round hole through a face, where you click; countersunk or counterbored if you like', group: 'cut' },
  { id: 'cutout', label: 'Cut-out', icon: 'encCutout', title: 'A rounded rectangle cut through a face, where you click', group: 'cut' },
  { id: 'slot', label: 'Slot', icon: 'encSlot', title: 'A slot through a face, where you click', group: 'cut' },
  { id: 'pocket', label: 'Pocket', icon: 'encPocket', title: 'A recess into a face from outside, where you click (a sticker, a bezel, a finger grip)', group: 'cut' },
  { id: 'vents', label: 'Vents', icon: 'encVents', title: 'A patch of vents (slots, holes or honeycomb), where you click', group: 'cut' },
  { id: 'boss', label: 'Boss', icon: 'encBoss', title: 'A boss with a screw hole, standing from a face (inside unless you click its outside in 3D)', group: 'add' },
  { id: 'pin', label: 'Pin', icon: 'encPin', title: 'A pin standing from a face', group: 'add' },
  { id: 'block', label: 'Block', icon: 'encBlock', title: 'A block standing out of a face (outside unless you click its inside in 3D)', group: 'add' },
  { id: 'rib', label: 'Rib', icon: 'encRib', title: 'A thin rib inside, to stiffen a face or hold something in place', group: 'add' },
  { id: 'text', label: 'Text', icon: 'encText', title: 'Text cut into a face, where you click', group: 'mark' },
  { id: 'logo', label: 'Logo', icon: 'encLogo', title: 'A drawing (SVG) on a face, where you click: cut in, raised or cut through', group: 'mark' },
];
/** Which side a protrusion takes when placed in the face view (in 3D, the side clicked). */
const SIDE: Record<AddKind, 'out' | 'in'> = { boss: 'in', pin: 'in', block: 'out', rib: 'in' };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** What a tool puts where it is clicked (null: the logo, which asks for its drawing first). */
export function makeItem(tool: ToolId, s: EnclosureSpec, g: Layout, face: Face, x: number, y: number, side?: 'out' | 'in'): { list: ItemList; item: Item } | null {
  const wall = face !== 'top' && face !== 'bottom';
  const n = (l: ItemList) => s[l].length + 1;
  const at = { face, x: r1(x), y: r1(y), on: true };
  switch (tool) {
    case 'hole': return { list: 'openings', item: { ...at, name: `Hole ${n('openings')}`, shape: 'circle', w: 3.2, h: 3.2 } };
    case 'cutout': return { list: 'openings', item: { ...at, name: `Cut-out ${n('openings')}`, shape: 'rounded', w: 12, h: 6 } };
    case 'slot': return { list: 'openings', item: { ...at, name: `Slot ${n('openings')}`, shape: 'slot', w: 10, h: 3 } };
    case 'pocket': return { list: 'openings', item: { ...at, name: `Pocket ${n('openings')}`, shape: 'rounded', w: wall ? 14 : 20, h: wall ? 6 : 12, depth: 0.6 } };
    case 'vents': {
      const half = wall ? (face === 'S' || face === 'N' ? g.ix : g.iy) : g.ix;
      return { list: 'vents', item: { ...at, name: `Vents ${n('vents')}`, pattern: wall ? 'slots' : 'honeycomb', w: Math.round(Math.min(30, 2 * half - 12)), h: Math.round(wall ? Math.max(4, Math.min(8, g.rim - g.boardTop - 2)) : Math.min(20, 2 * g.iy - 12)), size: wall ? 1.6 : 4 } };
    }
    case 'boss': case 'pin': case 'block': case 'rib': return { list: 'adds', item: newAdd(tool, face, r1(x), r1(y), side ?? SIDE[tool], n('adds')) };
    case 'text': return { list: 'labels', item: { ...at, text: 'TEXT', size: 5, depth: 0.6, raised: false } };
    default: return null;
  }
}

/** A feature's kind as the lists name it, and its icon. */
export function kindOf(list: ItemList, o: Item): { kind: string; icon: string } {
  if (list === 'vents') return { kind: 'Vents', icon: 'encVents' };
  if (list === 'labels') return (o as Label).logo ? { kind: 'Logo', icon: 'encLogo' } : { kind: 'Text', icon: 'encText' };
  if (list === 'adds') { const a = o as Add; return { kind: { boss: 'Boss', pin: 'Pin', block: 'Block', rib: 'Rib' }[a.kind], icon: { boss: 'encBoss', pin: 'encPin', block: 'encBlock', rib: 'encRib' }[a.kind] }; }
  const op = o as Opening;
  if (op.depth && op.depth > 0) return { kind: 'Pocket', icon: 'encPocket' };
  if (op.shape === 'circle') return { kind: 'Hole', icon: 'encHole' };
  if (op.shape === 'slot') return { kind: 'Slot', icon: 'encSlot' };
  return { kind: 'Cut-out', icon: 'encCutout' };
}

/** A feature's name as listed. */
export const nameOf = (list: ItemList, o: Item, i: number): string => (list === 'labels' ? (o as Label).text || `${kindOf(list, o).kind} ${i + 1}` : (o as { name: string }).name || `${kindOf(list, o).kind} ${i + 1}`);

/** Where a feature is: its face, and inside or outside for a protrusion. */
export const placeOf = (list: ItemList, o: Item): string => `${FACE_NAME[o.face]}${list === 'adds' ? ((o as Add).side === 'in' ? ' · in' : ' · out') : ''}`;

/** Every feature, in list order: those found from the board first, then the user's own. */
export function features(s: EnclosureSpec): { list: ItemList; i: number; item: Item; board: boolean }[] {
  const all: { list: ItemList; i: number; item: Item; board: boolean }[] = [];
  for (const list of ['openings', 'vents', 'adds', 'labels'] as ItemList[]) (s[list] as Item[]).forEach((item, i) => all.push({ list, i, item, board: list === 'openings' && !!(item as Opening).auto }));
  return [...all.filter((f) => f.board), ...all.filter((f) => !f.board)];
}

/** A copy a little to the side (the same face). */
export function duplicate(list: ItemList, o: Item, n: number): Item {
  const c = JSON.parse(JSON.stringify(o)) as Item & { name?: string; auto?: boolean; part?: string };
  c.x = r1(c.x + 5);
  if (list !== 'labels' && 'name' in c) c.name = `${kindOf(list, o).kind} ${n}`;
  delete c.auto; delete c.part;
  return c;
}

/** Copies in a row: count more, each this far on from the last (x along the face, y up it). */
export function repeat(list: ItemList, o: Item, count: number, dx: number, dy: number, n: number): Item[] {
  return Array.from({ length: Math.max(0, Math.min(100, Math.round(count))) }, (_, k) => {
    const c = duplicate(list, o, n + k);
    c.x = r1(o.x + dx * (k + 1)); c.y = r1(o.y + dy * (k + 1));
    return c;
  });
}

/** A copy mirrored across the face's middle (x turned about 0). */
export function mirrored(list: ItemList, o: Item, n: number): Item {
  const c = duplicate(list, o, n);
  c.x = r1(-o.x);
  return c;
}
