import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, units } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { DIM_FORMATS, DIM_UNITS, dimKindName, dimensionEdges, dimensionFromBag, layoutDimension, setDimension } from '../../model/dimensions';
import { formatCoord, parseLength, parseLengthIn, formatAltiumLength } from '../../core/units';
import { layerName, type LayerId } from '../../model/layers';
import { layerFromName, layerToName } from '../../formats/altium/pcbdoc';

const LENGTHS: [string, string][] = [
  ['EXTENSIONPICKGAP', 'Pick Gap'], ['EXTENSIONOFFSET', 'Offset'], ['EXTENSIONLINEWIDTH', 'Extension Width'], ['ARROWSIZE', 'Arrow Size'],
  ['ARROWLENGTH', 'Arrow Length'], ['ARROWLINEWIDTH', 'Arrow Line Width'], ['LINEWIDTH', 'Line Width'], ['TEXTHEIGHT', 'Text Height'],
  ['TEXTLINEWIDTH', 'Text Width'], ['TEXTGAP', 'Text Gap'],
];
const POSITIONS = ['Auto', 'Centre', 'Top', 'Bottom', 'Right', 'Left', 'Inside Right', 'Inside Left', 'Unidirectional', 'Manual'];
/** The value AD keeps for a position (Unidirectional is stored as UniDirectional, Centre as Center). */
const positionKey = (p: string) => (p === 'Unidirectional' ? 'UniDirectional' : p === 'Centre' ? 'Center' : p);
const positionShown = (k: string) => POSITIONS.find((p) => p.toLowerCase() === k.toLowerCase() || positionKey(p).toLowerCase() === k.toLowerCase()) ?? 'Auto';
/** The unit as the dialog shows it (the file keeps Millimeters, Centimeters). */
const unitShown = (u: string) => u.replace(/meters$/, 'metres');

/**
 * Double-click a dimension: AD17's dimension dialog (Linear Dimension, Radial Dimension …): the
 * lines and arrows, the text, the unit, precision and format, prefix and suffix, the layer and
 * lock. OK lays the dimension out again (one undo step).
 */
export function DimensionDialog({ ed, index }: { ed: PcbEditor; index: number }) {
  const d = ed.doc.dimensions[index]!;
  const [v, setV] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [k] of LENGTHS) o[k] = formatCoord(parseLength(d.bag.getRaw(k) ?? '10mil') ?? 0, units.value);
    for (const k of ['TEXTDIMENSIONUNIT', 'TEXTPRECISION', 'TEXTFORMAT', 'TEXTPREFIX', 'TEXTSUFFIX', 'TEXTPOSITION', 'ARROWPOSITION']) o[k] = d.bag.get(k) ?? '';
    o.LAYER = String(d.layer);
    o.LOCKED = d.bag.get('DIMENSIONLOCKED') ?? 'FALSE';
    return o;
  });
  const set = (k: string, x: string) => setV({ ...v, [k]: x });
  const layers: LayerId[] = [...new Set([d.layer, ...ed.layers()])];
  const ok = () => {
    const b = d.bag.clone();
    for (const [k, label] of LENGTHS) {
      const n = parseLengthIn(v[k]!, units.value);
      if (n === undefined || n < 0) { notify(`${label}: give a length`, 'error'); return false; }
      b.set(k, formatAltiumLength(Math.round(n)));
    }
    for (const k of ['TEXTDIMENSIONUNIT', 'TEXTPRECISION', 'TEXTFORMAT', 'TEXTPREFIX', 'TEXTSUFFIX', 'TEXTPOSITION', 'ARROWPOSITION']) b.set(k, k === 'TEXTPOSITION' ? positionKey(v[k]!) : v[k]!);
    const l = Number(v.LAYER);
    b.set('LAYER', layerToName(l)); b.set('DIMENSIONLAYER', layerToName(l));
    b.set('DIMENSIONLOCKED', v.LOCKED!);
    const laid = layoutDimension(dimensionFromBag(b, index, d.prefix), dimensionEdges(ed.doc.prims));
    closeDialog();
    ed.undo.transact(`Edit ${dimKindName(d.kind)} Dimension`, (tx) => tx.add(setDimension(ed.doc, index, laid)));
    ed.invalidate();
    return false;
  };
  const leader = d.kind === 4;
  // Angular values are degrees, formatted printf-style ('%d°' as AD17 writes it)
  const unitsList = d.kind === 2 ? ['Degrees'] : DIM_UNITS;
  const formats = d.kind === 2 ? ['None', '%d°'] : DIM_FORMATS;
  return (
    <Dialog title={`${dimKindName(d.kind)} Dimension`} width={620} onClose={closeDialog} onAccept={ok} class="dimdlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="out-cols">
        <fieldset><legend>Lines and Arrows</legend>
          {LENGTHS.filter(([k]) => !k.startsWith('TEXT')).map(([k, label]) => (
            <label key={k} class="do-row"><span>{label}</span><input type="text" value={v[k]} onChange={(e) => set(k, (e.target as HTMLInputElement).value)} /></label>
          ))}
          <label class="do-row"><span>Arrow Position</span><select value={v.ARROWPOSITION} onChange={(e) => set('ARROWPOSITION', (e.target as HTMLSelectElement).value)}>
            <option>Inside</option><option>Outside</option></select></label>
        </fieldset>
        <fieldset><legend>Text</legend>
          {LENGTHS.filter(([k]) => k.startsWith('TEXT')).map(([k, label]) => (
            <label key={k} class="do-row"><span>{label}</span><input type="text" value={v[k]} onChange={(e) => set(k, (e.target as HTMLInputElement).value)} /></label>
          ))}
          {leader
            ? <label class="do-row"><span>Text</span><input type="text" value={v.TEXTFORMAT} onInput={(e) => set('TEXTFORMAT', (e.target as HTMLInputElement).value)} /></label>
            : <>
              <label class="do-row"><span>Unit</span><select value={v.TEXTDIMENSIONUNIT} onChange={(e) => set('TEXTDIMENSIONUNIT', (e.target as HTMLSelectElement).value)}>{unitsList.map((u) => <option key={u} value={u}>{unitShown(u)}</option>)}</select></label>
              <label class="do-row"><span>Precision</span><select value={v.TEXTPRECISION} onChange={(e) => set('TEXTPRECISION', (e.target as HTMLSelectElement).value)}>{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={String(n)}>{n}</option>)}</select></label>
              <label class="do-row"><span>Format</span><select value={formats.includes(v.TEXTFORMAT!) ? v.TEXTFORMAT : d.kind === 2 ? '%d°' : /\(/.test(v.TEXTFORMAT!) ? '10 (mil)' : '10'} onChange={(e) => set('TEXTFORMAT', (e.target as HTMLSelectElement).value)}>{formats.map((f) => <option key={f}>{f}</option>)}</select></label>
              <label class="do-row"><span>Prefix</span><input type="text" value={v.TEXTPREFIX!.replace(/ÿ/g, '')} onInput={(e) => set('TEXTPREFIX', (e.target as HTMLInputElement).value)} /></label>
              <label class="do-row"><span>Suffix</span><input type="text" value={v.TEXTSUFFIX} onInput={(e) => set('TEXTSUFFIX', (e.target as HTMLInputElement).value)} /></label>
            </>}
          <label class="do-row"><span>Text Position</span><select value={positionShown(v.TEXTPOSITION!)} onChange={(e) => set('TEXTPOSITION', (e.target as HTMLSelectElement).value)}>{POSITIONS.map((p) => <option key={p}>{p}</option>)}</select></label>
        </fieldset>
      </div>
      <fieldset><legend>Properties</legend>
        <label class="do-row"><span>Layer</span><select value={v.LAYER} onChange={(e) => set('LAYER', (e.target as HTMLSelectElement).value)}>{layers.map((l) => <option key={l} value={String(l)}>{ed.doc.board.layerNames.get(l) ?? layerName(l)}</option>)}</select></label>
        <label class="out-check"><input type="checkbox" checked={v.LOCKED === 'TRUE'} onChange={() => set('LOCKED', v.LOCKED === 'TRUE' ? 'FALSE' : 'TRUE')} />Locked</label>
      </fieldset>
      <p class="muted small">{layerFromName(d.bag.get('LAYER') ?? '') === undefined ? 'The layer was not recognised; choose one.' : ''}</p>
    </Dialog>
  );
}
