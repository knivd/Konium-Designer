/**
 * Requirements document › Export: this document's requirements, or every requirements document's
 * in the project, as an Excel workbook, a CSV file, or the compliance report (HTML).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { Project } from '../state';
import type { ReqSource } from '../requirementsData';
import { saveExport, type ExportFormat } from '../reqTransfer';

export function ReqExportDialog({ project, sources, here }: { project: Project | null; sources: ReqSource[]; here: string }) {
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [all, setAll] = useState(false);
  const [state, setState] = useState('');
  const chosen = all ? sources : sources.filter((s) => s.name.toLowerCase() === here.toLowerCase());
  const run = async () => {
    setState('Saving…');
    try { if (await saveExport(project, chosen, format)) closeDialog(); else setState(''); } catch (e) { setState((e as Error).message); }
  };
  const radio = (v: ExportFormat, label: string) => <label><input type="radio" name="rq-format" checked={format === v} onChange={() => setFormat(v)} />{label}</label>;
  return (
    <Dialog title="Export Requirements" width={520} onClose={closeDialog}
      footer={<><button class="btn default" disabled={!chosen.length} onClick={() => void run()}>Export</button><span class="small rq-dlg-state">{state}</span><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="rq-dlg">
        <fieldset><legend>As</legend>
          {radio('xlsx', 'An Excel workbook (.xlsx)')}
          {radio('csv', 'A CSV file (.csv)')}
          {radio('html', 'The compliance report (.html): the counts, what needs attention, each requirement with its evidence')}
        </fieldset>
        {sources.length > 1 && (
          <fieldset><legend>Requirements</legend>
            <label><input type="radio" name="rq-scope" checked={!all} onChange={() => setAll(false)} />This document's ({here})</label>
            <label><input type="radio" name="rq-scope" checked={all} onChange={() => setAll(true)} />Every requirements document's in the project ({sources.length})</label>
          </fieldset>
        )}
        <p class="small muted">Each requirement's verification is as it stands now: where it follows a check against the design, by what the design measures now.</p>
      </div>
    </Dialog>
  );
}
