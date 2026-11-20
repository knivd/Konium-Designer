/**
 * Reports › Harness Wire List: a harness's wires from its Wiring Diagram — the ends (connector
 * pin or splice), colour, cable, shield and twist — with each one's length along the Layout
 * Drawing's bundles, when the project has one; saved as CSV.
 */
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, type Project } from '../state';
import { saveFileAs } from '../../platform/fs';
import { deliverOutputs } from './Outputs';
import { wireListCsv, type WireRow } from '../../model/harness';

const swatch = (c: number) => `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;

export function HarnessWireListDialog({ name, layout, rows, project }: { name: string; layout: string; rows: WireRow[]; project: Project | null }) {
  const file = `${name.replace(/\.[^.]+$/, '')}.WireList.csv`;
  const save = async () => {
    const text = wireListCsv(rows);
    if (project?.dir) await deliverOutputs(project, name, 'Harness Wire List', [{ name: file, text }]);
    else { const h = await saveFileAs(file, new TextEncoder().encode(text)); if (h) notify(`Saved ${file}`); }
  };
  const total = rows.reduce((t, r) => t + (r.length ?? 0), 0);
  return (
    <Dialog title={`Harness Wire List — ${name}`} width={760} height={520} onClose={closeDialog} class="harness-wires"
      footer={<><button class="btn" onClick={() => void save()}>Save CSV...</button>
        <span class="hw-note">{layout ? `Lengths along the bundles of ${layout}` : 'No layout drawing in the project: no lengths'}{total ? ` · ${rows.length} wires, ${total.toFixed(1)} mm in all` : ''}</span>
        <span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="hw-scroll">
        <table class="sd-table hw-table" aria-label="Wires">
          <thead><tr><th>Wire</th><th>From</th><th>To</th><th>Colour</th><th>Cable</th><th>Shield</th><th>Twisted</th><th>Length (mm)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.wire + r.from + r.to}>
                <td>{r.wire}</td><td>{r.from}</td><td>{r.to}</td>
                <td><span class="hw-swatch" style={{ background: swatch(r.colour) }} /></td>
                <td>{r.cable}</td><td>{r.shield ? 'Yes' : ''}</td><td>{r.twisted ? 'Yes' : ''}</td>
                <td class="num">{r.length === undefined ? '' : r.length.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p class="hw-note">No wires in this wiring diagram.</p>}
      </div>
    </Dialog>
  );
}
