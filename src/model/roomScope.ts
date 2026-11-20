/**
 * The components a room holds by its scope (Where The First Object Matches), worked out with
 * the board's query language. Kept apart from rooms.ts, which the DRC imports.
 */
import type { PcbDocument } from './pcb';
import type { Room } from './rooms';
import { pcbObjects } from './pcbProps';
import { runPcbQuery } from './pcbQuery';

export function roomMembers(doc: PcbDocument, room: Room): number[] {
  if (/^\s*false\s*$/i.test(room.scope)) return [];
  try {
    const comps = pcbObjects(doc).filter((o) => o.kind === 'Component' && o.component !== undefined);
    return runPcbQuery(room.scope, { doc, units: 'mil', origin: doc.board.origin }, comps).map((o) => o.component!);
  } catch { return []; }
}
