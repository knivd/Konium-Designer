/**
 * Multi-channel designs: a child sheet used more than once — by several sheet symbols, or by
 * one symbol named Repeat(Name, First, Last) — is compiled once per channel, as its own
 * instance: its own nets, its parts with channel designators. Each channel is a room (the
 * symbol's designator, or Name1 … NameN for Repeat; nested channels joined by the Room Level
 * Separator); its parts take designators by the Project Options › Multi-Channel format
 * ($Component_$RoomName by default), its local nets the room name after theirs [est: net names].
 */
import type { HierNode, Hierarchy, SymbolRef } from './schHierarchy';

export interface ChannelInstance {
  /** Room names from the top channel down ([] outside channels). */
  rooms: string[];
  /** Unique ID path of the channel (its symbols' IDs). */
  uids: string[];
  /** 1-based channel number at the deepest level (for $ChannelIndex / $ChannelAlpha). */
  index: number;
}

/** One compiled instance of a sheet: the sheet, its channel, the instance it sits under and the symbol that places it. */
export interface SheetInstance extends ChannelInstance { sheet: string; key: string; parent: string | null; via?: SymbolRef }

export const REPEAT = /^Repeat\(\s*([^,()]+?)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/i;
/** A sheet entry named Repeat(X) on a Repeat symbol: port X of each channel, as its own bus member X1 … Xn. */
export const repeatEntryName = (n: string): string => /^Repeat\(\s*(.+?)\s*\)$/i.exec(n)?.[1] ?? n;
export const isRepeatEntry = (n: string): boolean => /^Repeat\(/i.test(n.trim());

export const roomName = (i: ChannelInstance, sep = '_') => i.rooms.join(sep);

/** Every instance to compile, from the sheet tree (a sheet outside channels is one instance keyed by its name). */
export function sheetInstances(h: Hierarchy, symbolUid: (s: SymbolRef) => string, sep = '_'): SheetInstance[] {
  const out = new Map<string, SheetInstance>();
  const walk = (n: HierNode, base: ChannelInstance, parent: string | null) => {
    let reps: ChannelInstance[] = [base];
    const via = n.via;
    if (via) {
      const rep = REPEAT.exec(via.designator.trim());
      const uid = symbolUid(via);
      if (rep) {
        const a = Number(rep[2]), b = Number(rep[3]);
        reps = [];
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) reps.push({ rooms: [...base.rooms, `${rep[1]}${i}`], uids: [...base.uids, `${uid}${i}`], index: i - Math.min(a, b) + 1 });
      } else if ((h.parents.get(n.sheet.toLowerCase())?.length ?? 0) > 1) {
        const k = h.parents.get(n.sheet.toLowerCase())!.findIndex((p) => p.sheet === via.sheet && p.index === via.index);
        reps = [{ rooms: [...base.rooms, via.designator || `CH${k + 1}`], uids: [...base.uids, uid], index: k + 1 }];
      }
    }
    for (const r of reps) {
      const key = r.rooms.length ? `${n.sheet}#${r.rooms.join(sep)}` : n.sheet;
      if (!out.has(key)) out.set(key, { ...r, sheet: n.sheet, key, parent, via });
      for (const c of n.children) walk(c, r, key);
    }
  };
  for (const r of h.roots) walk(r, { rooms: [], uids: [], index: 1 }, null);
  return [...out.values()];
}

const alpha = (n: number) => { let s = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };

/** A part's designator in a channel: Project Options › Multi-Channel › Designator Format. */
export function channelDesignator(fmt: string, designator: string, i: ChannelInstance, sep = '_'): string {
  if (!i.rooms.length) return designator;
  const m = /^(.*?)(\d*)$/.exec(designator)!;
  return (fmt || '$Component_$RoomName')
    .replace(/\$ComponentPrefix/g, m[1]!).replace(/\$ComponentIndex/g, m[2]!).replace(/\$Component/g, designator)
    .replace(/\$RoomName/g, roomName(i, sep)).replace(/\$ChannelPrefix/g, i.rooms.at(-1)!.replace(/\d+$/, ''))
    .replace(/\$ChannelIndex/g, String(i.index)).replace(/\$ChannelAlpha/g, alpha(i.index));
}
