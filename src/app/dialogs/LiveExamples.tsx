/**
 * Live Simulation Examples: the circuits to start from, by kind. The one chosen opens as a new
 * schematic and runs, with its test points on the scopes.
 */
import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { LIVE_EXAMPLES } from '../liveExamples';

export function LiveExamplesDialog({ onOk }: { onOk: (id: string) => void }) {
  const groups = [...new Set(LIVE_EXAMPLES.map((e) => e.group))];
  const [group, setGroup] = useState(groups[0]!);
  const rows = LIVE_EXAMPLES.filter((e) => e.group === group);
  const [sel, setSel] = useState(0);
  const ex = rows[Math.min(sel, rows.length - 1)];
  const ok = (i = sel) => { const e = rows[i]; closeDialog(); if (e) onOk(e.id); };
  return (
    <Dialog title="Live Simulation Examples" width={640} height={420} class="liveex" onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={() => ok()}>Open and Run</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="liveex-cols">
        <Grid cols={[{ label: 'Kind', get: (g: string) => g }]} rows={groups} sel={groups.indexOf(group)} onSel={(i: number) => { setGroup(groups[i]!); setSel(0); }} />
        <Grid cols={[{ label: 'Circuit', get: (e: (typeof rows)[number]) => e.title }]} rows={rows} sel={sel} onSel={setSel} onOpen={ok} />
      </div>
      <p class="liveex-about">{ex ? ex.about.split('\n').map((line, i) => <span key={i}>{line}<br /></span>) : null}</p>
    </Dialog>
  );
}
