import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { crossProbe } from '../project';
import type { Project } from '../state';

/** Predefined Harness Connector: the harness types the project's connectors define. */
export function PickHarnessTypeDialog({ types, onOk }: { types: string[]; onOk: (t: string) => void }) {
  const [sel, setSel] = useState(0);
  const ok = (i = sel) => { const t = types[i]; closeDialog(); if (t) onOk(t); };
  return (
    <Dialog title="Choose Harness Type" width={380} height={360} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={() => ok()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid cols={[{ label: 'Harness Type', get: (t: string) => t }]} rows={types} sel={sel} onSel={setSel} onOpen={ok} />
    </Dialog>
  );
}

interface Row { type: string; entries: string; where: string; conflict: boolean; at: { sheet: string; index: number } }

/** Harness Definition Problem Finder: each harness type, its entries, and where definitions disagree. */
export function HarnessDefinitionsDialog({ defs, project }: { defs: Map<string, { entries: string[]; where: { sheet: string; index: number }[] }[]>; project: Project | null }) {
  const rows: Row[] = [];
  for (const [type, list] of defs) {
    for (const d of list) rows.push({ type, entries: d.entries.join(', ') || '(none)', where: [...new Set(d.where.map((w) => w.sheet))].join(', '), conflict: list.length > 1 || type === '(no type)', at: d.where[0]! });
  }
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const problems = rows.filter((r) => r.conflict).length;
  return (
    <Dialog title="Harness Definition Problem Finder" width={760} height={440} onClose={closeDialog}
      footer={<><span class="muted small">{rows.length ? `${problems} problem${problems === 1 ? '' : 's'}` : ''}</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <Grid cols={[{ label: 'Harness Type', width: '160px', get: (r: Row) => <span class={r.conflict ? 'error-text' : ''}>{r.type}</span> }, { label: 'Entries', get: (r) => r.entries },
        { label: 'Documents', width: '200px', get: (r) => r.where }]} rows={rows} sel={sel} onSel={setSel}
        onOpen={(i) => { const r = rows[i]; if (r) { closeDialog(); crossProbe([r.at], project); } }}
        empty="No harness connectors in the project" />
    </Dialog>
  );
}
