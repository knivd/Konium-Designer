/**
 * The diagram's dialogs: Edit Diagram (the page's XML), Edit Data (a shape's ID and properties,
 * placeholders, its tooltip), Edit Link (a web address or another page) and Export (PNG, SVG or
 * PDF; scale, border, background, the selection only).
 */
import { useState } from 'preact/hooks';
import { RESERVED } from '../../formats/drawio';
import { Dialog } from '../Dialog';
import { closeDialog } from '../dialogs';

export function EditDiagramDialog({ xml, apply }: { xml: string; apply: (x: string) => boolean }) {
  const [text, setText] = useState(xml);
  const [bad, setBad] = useState(false);
  const ok = () => { if (apply(text)) { closeDialog(); return true; } setBad(true); return false; };
  return (
    <Dialog title="Edit Diagram" onClose={closeDialog} onAccept={ok} width={640}
      footer={<><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn default" onClick={ok}>OK</button></>}>
      <p class="small muted">This page as its XML: an mxGraphModel and the cells in its root.</p>
      <textarea class="dg-style-text dg-xml" aria-label="Diagram XML" rows={22} value={text} spellcheck={false} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); setBad(false); }} />
      {bad && <p class="error-text small">That isn't a page's XML (an mxGraphModel with a root): nothing was changed.</p>}
    </Dialog>
  );
}

export interface DataEdit { props: [string, string][]; placeholders: boolean; tooltip: string }
export function EditDataDialog({ id, props, placeholders, tooltip, apply }: { id: string; props: [string, string][]; placeholders: boolean; tooltip: string; apply: (e: DataEdit) => void }) {
  const [rows, setRows] = useState<[string, string][]>(props);
  const [ph, setPh] = useState(placeholders);
  const [tip, setTip] = useState(tooltip);
  const [name, setName] = useState('');
  const valid = /^[A-Za-z_][\w.-]*$/.test(name) && !rows.some(([k]) => k === name) && !RESERVED.has(name);
  const ok = () => { apply({ props: rows, placeholders: ph, tooltip: tip }); closeDialog(); };
  return (
    <Dialog title="Edit Data" onClose={closeDialog} onAccept={ok} width={460}
      footer={<><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn default" onClick={ok}>Apply</button></>}>
      <div class="dg-data">
        <label class="dg-num">ID<input aria-label="ID" value={id} readOnly /></label>
        <label class="dg-num">Tooltip<input aria-label="Tooltip" value={tip} onInput={(e) => setTip((e.target as HTMLInputElement).value)} /></label>
        <table class="dg-data-table">
          <tbody>
            {rows.map(([k, v], i) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td><input aria-label={k} value={v} onInput={(e) => setRows(rows.map((r, j) => (j === i ? [k, (e.target as HTMLInputElement).value] : r)))} /></td>
                <td><button class="btn" aria-label={`Delete ${k}`} title="Delete" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="dg-row">
          <input aria-label="New property name" placeholder="Property name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value.trim())} />
          <button class="btn" disabled={!valid} onClick={() => { setRows([...rows, [name, '']]); setName(''); }}>Add Property</button>
        </div>
        <label class="dg-check"><input type="checkbox" checked={ph} onChange={() => setPh(!ph)} />Placeholders: %name% in the label shows the property</label>
      </div>
    </Dialog>
  );
}

export function EditLinkDialog({ link, pages, apply }: { link: string; pages: { id: string; name: string }[]; apply: (url: string) => void }) {
  const page0 = /^data:page\/id,(.*)$/.exec(link)?.[1];
  const [kind, setKind] = useState<'url' | 'page'>(page0 !== undefined ? 'page' : 'url');
  const [url, setUrl] = useState(page0 !== undefined ? '' : link);
  const [pg, setPg] = useState(page0 ?? pages[0]?.id ?? '');
  const value = kind === 'page' ? (pg ? `data:page/id,${pg}` : '') : url.trim();
  const ok = () => { apply(value); closeDialog(); };
  return (
    <Dialog title="Edit Link" onClose={closeDialog} onAccept={ok} width={440}
      footer={<><button class="btn" onClick={() => { apply(''); closeDialog(); }}>Remove Link</button><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn default" onClick={ok}>Apply</button></>}>
      <div class="dg-data">
        <label class="dg-check"><input type="radio" name="dg-link" checked={kind === 'url'} onChange={() => setKind('url')} />Web address</label>
        <input aria-label="Web address" placeholder="https://" value={url} disabled={kind !== 'url'} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        <label class="dg-check"><input type="radio" name="dg-link" checked={kind === 'page'} disabled={!pages.length} onChange={() => setKind('page')} />A page of this diagram</label>
        <select aria-label="Page" value={pg} disabled={kind !== 'page'} onChange={(e) => setPg((e.target as HTMLSelectElement).value)}>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p class="small muted">Ctrl+click the shape to follow its link.</p>
      </div>
    </Dialog>
  );
}

export type ExportKind = 'png' | 'svg' | 'pdf';
export interface ExportChoice { kind: ExportKind; scale: number; border: number; transparent: boolean; selection: boolean }
export function ExportDialog({ kind, hasSelection, run }: { kind: ExportKind; hasSelection: boolean; run: (c: ExportChoice) => void }) {
  const [scale, setScale] = useState(1);
  const [border, setBorder] = useState(10);
  const [transparent, setTransparent] = useState(false);
  const [selection, setSelection] = useState(hasSelection);
  const ok = () => { run({ kind, scale, border, transparent, selection: selection && hasSelection }); closeDialog(); };
  return (
    <Dialog title={`Export as ${kind.toUpperCase()}`} onClose={closeDialog} onAccept={ok} width={380}
      footer={<><button class="btn" onClick={closeDialog}>Cancel</button><button class="btn default" onClick={ok}>Export</button></>}>
      <div class="dg-data">
        {kind === 'png' && <label class="dg-num">Zoom<select aria-label="Zoom" value={String(scale)} onChange={(e) => setScale(Number((e.target as HTMLSelectElement).value))}>
          {[1, 2, 3, 4].map((k) => <option key={k} value={String(k)}>{k * 100}%</option>)}
        </select></label>}
        <label class="dg-num">Border<input type="number" aria-label="Border" min={0} max={200} value={String(border)} onChange={(e) => setBorder(Math.max(0, Number((e.target as HTMLInputElement).value) || 0))} /><span class="muted">px</span></label>
        {kind !== 'pdf' && <label class="dg-check"><input type="checkbox" checked={transparent} onChange={() => setTransparent(!transparent)} />Transparent background</label>}
        <label class="dg-check"><input type="checkbox" checked={selection && hasSelection} disabled={!hasSelection} onChange={() => setSelection(!selection)} />Selection only</label>
        {kind === 'pdf' && <p class="small muted">The PDF is made by the print dialog: choose Save as PDF as its destination.</p>}
      </div>
    </Dialog>
  );
}
