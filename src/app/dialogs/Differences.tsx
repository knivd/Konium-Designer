import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourIcon } from '../icons';
import { EcoDialog } from './Eco';
import { ReportDialog } from './Hierarchy';
import type { Difference, SchEcoItem } from '../../model/comparator';
import type { PcbEcoItem } from '../../model/pcbEco';
import type { Project } from '../state';
import type { SyncContext } from '../differences';
import { syncEco } from '../differences';

/**
 * Project › Show Differences, first step: AD17's Choose Documents To Compare — the project's
 * schematics against one of its boards; Advanced Mode lists the schematics too, so one sheet can
 * be compared with the board on its own.
 */
export function ChooseCompareDialog({ project, boards, sheets = [], onOk }: { project: Project; boards: string[]; sheets?: string[]; onOk: (board: string, sheet?: string) => void }) {
  const [board, setBoard] = useState(boards[0]!);
  const [advanced, setAdvanced] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const ok = () => { closeDialog(); onOk(board, advanced && sheet ? sheet : undefined); };
  return (
    <Dialog title="Choose Documents To Compare" width={480} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><label class="np-check" title="Compare one schematic with the board"><input type="checkbox" checked={advanced} onChange={() => setAdvanced(!advanced)} /> Advanced Mode</label><span class="spacer" />
        <button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="small">Compare {advanced && sheet ? sheet : `the schematics of ${project.name}`} with:</p>
      {advanced && <div class="vc-list cmp-list" role="listbox" aria-label="Schematic to compare">
        <div role="option" aria-selected={!sheet} class={`np-item cmp-doc${!sheet ? ' on' : ''}`} onClick={() => setSheet(null)}><ColourIcon name="prjpcb" size={16} /> {project.name} (all its schematics)</div>
        {sheets.map((s) => <div key={s} role="option" aria-selected={s === sheet} class={`np-item cmp-doc${s === sheet ? ' on' : ''}`} onClick={() => setSheet(s)}><ColourIcon name="schdoc" size={16} /> {s}</div>)}
      </div>}
      <div class="vc-list cmp-list" role="listbox" aria-label="Documents to compare">
        {!advanced && <div class="np-item"><ColourIcon name="prjpcb" size={16} /> {project.name}</div>}
        {boards.map((b) => (
          <div key={b} role="option" aria-selected={b === board} class={`np-item cmp-doc${b === board ? ' on' : ''}`} onClick={() => setBoard(b)} onDblClick={() => { setBoard(b); closeDialog(); onOk(b, advanced && sheet ? sheet : undefined); }}>
            <ColourIcon name="pcbdoc" size={16} /> {b}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

type Decision = 'none' | 'pcb' | 'sch';

/**
 * The comparison, as AD17's "Differences between …" dialog: each difference under its kind, in
 * the column of the document that has it; Update says which way it goes (No Change at first);
 * Change Order shows what that does. Create Engineering Change Order runs the chosen ones.
 */
export function DifferencesDialog({ ctx, diffs }: { ctx: SyncContext; diffs: Difference[] }) {
  const [dec, setDec] = useState<Decision[]>(() => diffs.map(() => 'none'));
  const schName = `Schematic Document [${ctx.p.name}]`, pcbName = `PCB Document [${ctx.board.name}]`;
  const can = (d: Difference, x: Decision) => x === 'none' || (x === 'pcb' ? !!d.toPcb : !!d.toSch);
  const setAll = (f: (d: Difference, now: Decision) => Decision) => setDec((ds) => ds.map((now, i) => { const x = f(diffs[i]!, now); return can(diffs[i]!, x) ? x : now; }));
  const chosen = diffs.flatMap((d, i): { toPcb?: PcbEcoItem; toSch?: SchEcoItem }[] => (dec[i] === 'pcb' && d.toPcb ? [{ toPcb: d.toPcb }] : dec[i] === 'sch' && d.toSch ? [{ toSch: d.toSch }] : []));
  const groups = [...new Set(diffs.map((d) => d.group))];
  const order = (d: Difference, x: Decision) => {
    if (x === 'pcb' && d.toPcb) return `${d.toPcb.action}  ${d.toPcb.object}`;
    if (x === 'sch' && d.toSch) return `${d.toSch.action}  ${d.toSch.object}`;
    return '';
  };
  const create = () => {
    const { changes, transact } = syncEco(ctx, chosen);
    closeDialog();
    showDialog(EcoDialog, { title: 'Engineering Change Order', changes, transact });
  };
  const report = () => {
    const lines = [`Differences between ${schName} and ${pcbName}`, ''];
    for (const g of groups) {
      const list = diffs.filter((d) => d.group === g);
      lines.push(`${g} (${list.length})`);
      for (const d of list) lines.push(`  ${(d.sch || '—').padEnd(40)}  ${(d.pcb || '—').padEnd(40)}`);
      lines.push('');
    }
    showDialog(ReportDialog, { title: 'Differences Report', name: `${ctx.p.name.replace(/\.[^.]+$/, '')} Differences.txt`, text: `${lines.join('\r\n')}\r\n`, project: ctx.p });
  };
  const arrow = (i: number, x: Decision, label: string, title: string) => {
    const d = diffs[i]!;
    return <button class={`cmp-dec${dec[i] === x ? ' on' : ''}`} disabled={!can(d, x)} title={title} aria-pressed={dec[i] === x}
      onClick={() => setDec((ds) => ds.map((v, k) => (k === i ? x : v)))}>{label}</button>;
  };
  return (
    <Dialog title={`Differences between ${schName} and ${pcbName}`} width={1060} height={620} onClose={closeDialog} class="cmp"
      footer={<>
        <button class="btn" onClick={report}>Report Differences...</button>
        <span class="muted small">{chosen.length} of {diffs.length} to change</span>
        <span class="spacer" />
        <button class="btn default" disabled={!chosen.length} onClick={create}>Create Engineering Change Order...</button>
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="cmp-tools">
        <button class="btn" onClick={() => setAll(() => 'sch')}>&lt;&lt; Update All in Schematic Document</button>
        <button class="btn" onClick={() => setAll(() => 'pcb')}>Update All in &gt;&gt; PCB Document</button>
        <button class="btn" onClick={() => setAll((_, now) => (now === 'pcb' ? 'sch' : now === 'sch' ? 'pcb' : 'none'))}>Reverse Direction For All</button>
        <button class="btn" onClick={() => setAll(() => 'none')}>Set No Action For All</button>
      </div>
      <div class="grid cmp-grid" style={{ '--cols': 'minmax(180px, 1fr) 96px minmax(180px, 1fr) minmax(200px, 1.2fr)' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>{schName}</span><span>Update</span><span>{pcbName}</span><span>Change Order</span></div>
        <div class="grid-body">
          {groups.map((g) => {
            const idx = diffs.map((d, i) => (d.group === g ? i : -1)).filter((i) => i >= 0);
            return (
              <div key={g}>
                <div class="grid-row eco-group"><span class="eco-group-name cmp-group">{g} ({idx.length})</span></div>
                {idx.map((i) => {
                  const d = diffs[i]!;
                  return (
                    <div key={i} class="grid-row">
                      <span title={d.sch}>{d.sch}</span>
                      <span class="cmp-decs">
                        {arrow(i, 'sch', '<<', d.toSch ? 'Update the schematic' : 'The schematic can\'t take this one')}
                        {arrow(i, 'none', '·', 'No Change')}
                        {arrow(i, 'pcb', '>>', d.toPcb ? 'Update the PCB' : 'Nothing to do on the PCB')}
                      </span>
                      <span title={d.pcb}>{d.pcb}</span>
                      <span class={dec[i] === 'none' ? 'muted' : ''}>{dec[i] === 'none' ? 'No Change' : order(d, dec[i]!)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
