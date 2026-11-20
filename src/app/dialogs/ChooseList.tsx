import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';

/** A one-column choice (Choose Alternate Part, harness types …): double-click or OK picks. */
export function ChooseListDialog({ title, header, items, initial = 0, onOk }: { title: string; header: string; items: string[]; initial?: number; onOk: (i: number) => void }) {
  const [sel, setSel] = useState(initial);
  const ok = (i = sel) => { closeDialog(); if (items[i] !== undefined) onOk(i); };
  return (
    <Dialog title={title} width={380} height={340} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={() => ok()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid cols={[{ label: header, get: (t: string) => t }]} rows={items} sel={sel} onSel={setSel} onOpen={ok} />
    </Dialog>
  );
}
