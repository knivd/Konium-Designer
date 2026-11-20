import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { OpenDoc } from '../state';

/** AD's Save As types for a schematic or a board: binary, or ASCII (its text format, one record a line). */
export function saveTypes(od: OpenDoc): { id: 'binary' | 'ascii'; label: string }[] {
  if (od.doc.kind === 'SchDoc') {
    // A sheet opened from an ASCII file is written as ASCII (its records are text)
    return od.doc.asciiEol !== null ? [{ id: 'ascii', label: 'Advanced Schematic ascii (*.SchDoc)' }]
      : [{ id: 'binary', label: 'Advanced Schematic binary (*.SchDoc)' }, { id: 'ascii', label: 'Advanced Schematic ascii (*.SchDoc)' }];
  }
  if (od.doc.kind === 'PcbDoc') return [{ id: 'binary', label: 'PCB Binary Files (*.PcbDoc)' }, { id: 'ascii', label: 'PCB ASCII File (*.PcbDoc)' }];
  return [];
}
/** The format a document is saved in now. */
export const savedFormat = (od: OpenDoc): 'binary' | 'ascii' =>
  od.format ?? (od.doc.kind === 'SchDoc' ? (od.doc.asciiEol !== null ? 'ascii' : 'binary') : od.doc.kind === 'PcbDoc' && od.doc.ascii ? 'ascii' : 'binary');

/** File › Save As for a schematic or a board: the type first (AD's Save as type), then where. */
export function SaveAsDialog({ od, onSave }: { od: OpenDoc; onSave: (format: 'binary' | 'ascii') => void }) {
  const types = saveTypes(od);
  const [fmt, setFmt] = useState(savedFormat(od));
  const ok = () => { closeDialog(); onSave(fmt); };
  return (
    <Dialog title={`Save [${od.name}] As...`} width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>Save...</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="fp-form">
        <label>Save as type<select value={fmt} autoFocus onChange={(e) => setFmt((e.target as HTMLSelectElement).value as 'binary' | 'ascii')}>
          {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select></label>
        <p class="small muted">Then where, and under what name.</p>
      </div>
    </Dialog>
  );
}
