import { schUnitsOf } from '../newSheet';
import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, units } from '../state';
import type { SchClip } from '../../editors/clipboard';
import type { SchEditor } from '../../editors/sch/SchEditor';
import { SchPasteTool } from '../../editors/sch/SchPasteTool';
import { CONVERTIBLE, DEFAULT_ARRAY, arrayClip, convertClip, pasteKind, type ArrayOpts, type PasteAs } from '../../model/smartPaste';
import { fmtCoord, parseCoord } from '../../model/schProps';
import { numIn } from './numIn';

const AS_LABEL: Record<PasteAs, string> = { themselves: 'Themselves', netlabels: 'Net Labels', ports: 'Ports', text: 'Text Strings' };
let lastArray: ArrayOpts = { ...DEFAULT_ARRAY };

/**
 * Edit › Smart Paste: the clipboard's objects by kind, each pasted as itself, converted, or
 * left out; then Paste Array (columns, rows, spacings, text increment). OK starts the paste:
 * the whole lot follows the cursor until clicked down, as a normal paste does.
 */
export function SmartPasteDialog({ ed, clip }: { ed: SchEditor; clip: SchClip }) {
  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of clip.items) if (it.owner < 0) { const k = pasteKind(it.bag); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m];
  }, [clip]);
  const [as, setAs] = useState<Map<string, PasteAs | null>>(new Map());
  const [arr, setArr] = useState<ArrayOpts>(lastArray);
  const u = schUnitsOf(ed, units.value);
  const [colSp, setColSp] = useState(fmtCoord(arr.colSpacing, u));
  const [rowSp, setRowSp] = useState(fmtCoord(arr.rowSpacing, u));
  const ok = () => {
    const opts: ArrayOpts = { ...arr, colSpacing: parseCoord(colSp, u) ?? arr.colSpacing, rowSpacing: parseCoord(rowSp, u) ?? arr.rowSpacing };
    lastArray = opts;
    const out = arrayClip(convertClip(clip, as), opts);
    closeDialog();
    if (!out.items.length) { notify('Nothing left to paste'); return; }
    ed.setTool(new SchPasteTool(ed, out));
  };
  const num = (k: 'cols' | 'rows' | 'primary' | 'secondary') => (
    <input type="number" value={String(arr[k])} disabled={!arr.on} aria-label={k} onInput={(e) => setArr({ ...arr, [k]: numIn(e, arr[k] as number) })} />
  );
  return (
    <Dialog title="Smart Paste" width={780} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="smartpaste"
      footer={<><span class="muted small">{clip.items.filter((i) => i.owner < 0).length} objects on the clipboard</span><span class="spacer" />
        <button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="sp-cols">
        <fieldset><legend>Choose the objects to paste</legend>
          <div class="sp-grid">
            <div class="sp-row cp-ghead"><span>Object</span><span>Count</span><span>Paste As</span></div>
            {kinds.map(([k, n]) => (
              <div key={k} class="sp-row">
                <span>{k}</span><span>{n}</span>
                <select value={as.get(k) === null ? 'skip' : as.get(k) ?? 'themselves'} aria-label={`${k} paste as`}
                  onChange={(e) => { const v = (e.target as HTMLSelectElement).value; const m = new Map(as); m.set(k, v === 'skip' ? null : v as PasteAs); setAs(m); }}>
                  {(CONVERTIBLE.has(k) ? (['themselves', 'netlabels', 'ports', 'text'] as PasteAs[]) : (['themselves'] as PasteAs[])).map((x) => <option key={x} value={x}>{AS_LABEL[x]}</option>)}
                  <option value="skip">(Don't paste)</option>
                </select>
              </div>
            ))}
          </div>
        </fieldset>
        <fieldset><legend>Paste Array</legend>
          <label class="do-check"><input type="checkbox" checked={arr.on} onChange={(e) => setArr({ ...arr, on: (e.target as HTMLInputElement).checked })} />Enable Paste Array</label>
          <div class="sp-arr">
            <span class="sp-h">Columns</span><label>Count{num('cols')}</label>
            <label>Spacing<input type="text" value={colSp} disabled={!arr.on} aria-label="Column spacing" onInput={(e) => setColSp((e.target as HTMLInputElement).value)} /></label>
            <span class="sp-h">Rows</span><label>Count{num('rows')}</label>
            <label>Spacing<input type="text" value={rowSp} disabled={!arr.on} aria-label="Row spacing" onInput={(e) => setRowSp((e.target as HTMLInputElement).value)} /></label>
            <span class="sp-h">Text Increment</span>
            <label>Direction<select value={arr.direction} disabled={!arr.on} onChange={(e) => setArr({ ...arr, direction: (e.target as HTMLSelectElement).value as ArrayOpts['direction'] })}>
              <option value="none">None</option><option value="horizontal">Horizontal First</option><option value="vertical">Vertical First</option></select></label>
            <label>Primary{num('primary')}</label><label>Secondary{num('secondary')}</label>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
