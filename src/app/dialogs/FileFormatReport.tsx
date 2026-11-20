/**
 * The File Format Change Report: shown on opening a board saved by an older or a newer version
 * of the format than Konium works in (AD17's, Release 17.1) — for a newer one, what its program
 * said an older one can't keep; for an older one, what changed since. Preferences › PCB Editor ›
 * General › File Format Change Report turns it off for either.
 */
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { KONIUM_FORMAT, type ChangeReport } from '../../formats/altium/fileVersion';

export function FileFormatReportDialog({ boards }: { boards: { name: string; report: ChangeReport }[] }) {
  return (
    <Dialog title="File Format Change Report" width={620} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }} class="ffreport"
      footer={<><span class="muted small">Preferences › PCB Editor › General › File Format Change Report</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>OK</button></>}>
      <div class="ffr-body">
        {boards.map(({ name, report: r }) => (
          <section key={name}>
            <h3>{name}</h3>
            <p>{r.kind === 'newer'
              ? `Saved by ${r.savedBy}, a newer version of the format than Konium Designer's (${KONIUM_FORMAT}). What that version said an older one may not keep:`
              : `Saved by ${r.savedBy}, an older version of the format than Konium Designer's (${KONIUM_FORMAT}). What changed since${r.notes.length ? ':' : ': nothing that affects this board.'}`}</p>
            {r.notes.length > 0 && <ul>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
