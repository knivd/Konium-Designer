/**
 * R15, Route › Auto Route › Import Specctra Session... (and a .ses opened or dropped with a board in
 * front): an autorouter's session read back onto the board as one step (formats/specctra/ses.ts).
 */
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import { applySession, readSession } from '../formats/specctra/ses';
import { log, notify } from './state';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function importSessionInto(e: PcbEditor, fileName: string, bytes: Uint8Array): void {
  try {
    const ses = readSession(new TextDecoder().decode(bytes));
    const r = applySession(e.doc, ses);
    if (!r.tracks && !r.vias) { notify(`${fileName}: no routes for this board in it`, 'error'); return; }
    e.undo.transact('Import Specctra Session', (tx) => tx.add(r.change));
    notify(`${fileName}: ${plural(r.tracks, 'track')} and ${plural(r.vias, 'via')} on ${plural(r.nets, 'net')} in place of the board's ${plural(r.removed, 'routed track and via')}; pours poured again`);
    log(fileName, [{ level: 'info', message: `Specctra session read: ${plural(r.tracks, 'track')}, ${plural(r.vias, 'via')}, ${plural(r.nets, 'net')} (Edit › Undo takes it back)` }, ...r.warnings.map((message) => ({ level: 'warn' as const, message }))], 'Specctra Session');
  } catch (err) {
    notify(`${fileName}: ${(err as Error).message}`, 'error');
  }
}
