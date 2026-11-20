import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { units } from '../state';
import { FootprintPreview } from './FootprintPreview';
import type { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { WIZARD_PATTERNS, wizardDefaults, wizardName, wizardRecords, type WizardPattern, type WizardSpec } from '../../model/footprintWizard';
import { decodePrim } from '../../formats/altium/pcbdoc';
import { storageFor } from '../../formats/altium/pcblib';
import { formatCoord, parseLength } from '../../core/units';
import type { PcbPrim } from '../../model/pcb';

type LenKey = 'padX' | 'padY' | 'hole' | 'pitch' | 'span' | 'outline';

/**
 * Tools › Component Wizard: choose the package, set its pads, spacing and outline, see it, and
 * Finish adds the footprint to the library (one undo step). The wizard's pages on one page.
 */
export function ComponentWizardDialog({ ed }: { ed: PcbLibEditor }) {
  const u = units.value;
  const [spec, setSpec] = useState<WizardSpec>(() => wizardDefaults('dip'));
  const [text, setText] = useState<Record<LenKey, string>>(() => lens(wizardDefaults('dip'), u));
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const pick = (p: WizardPattern) => { const d = wizardDefaults(p); setSpec(d); setText(lens(d, u)); setName(null); };
  const setLen = (k: LenKey, v: string) => {
    setText({ ...text, [k]: v });
    const n = parseLength(/^\s*[\d.]+\s*$/.test(v) ? `${v.trim()}${u}` : v);
    if (n !== undefined && n >= 0) setSpec({ ...spec, [k]: Math.round(n) });
  };
  const two = spec.pattern === 'res' || spec.pattern === 'cap' || spec.pattern === 'diode';
  const grid = spec.pattern === 'bga' || spec.pattern === 'pga';
  const thPattern = spec.pattern === 'dip' || spec.pattern === 'pga' || (two && !spec.smd);
  const s = useMemo<WizardSpec>(() => ({ ...spec, hole: thPattern ? spec.hole : 0 }), [spec, thPattern]);
  const template = ed.doc.streams.get('Pads6')?.records[0];
  const records = useMemo(() => wizardRecords(s, template), [s, template]);
  const prims = useMemo(() => records.map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).filter((p): p is PcbPrim => !!p), [records]);
  const finalName = (name ?? wizardName(s)).trim();
  const finish = () => { if (!finalName) return; closeDialog(); ed.insertFootprint(finalName, description, '0mil', records); };
  const num = (label: string, k: 'pins' | 'rows' | 'cols', step = 1) => (
    <label class="do-row"><span>{label}</span><input type="number" min={1} step={step} value={spec[k]} onInput={(e) => setSpec({ ...spec, [k]: Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1)) })} /></label>
  );
  const len = (label: string, k: LenKey, disabled = false) => (
    <label class="do-row"><span>{label} ({u})</span><input type="text" value={text[k]} disabled={disabled} onInput={(e) => setLen(k, (e.target as HTMLInputElement).value)} /></label>
  );
  return (
    <Dialog title="Component Wizard" width={760} height={520} onClose={closeDialog} onAccept={() => { finish(); return false; }} class="compwizard"
      footer={<><span class="muted small">{prims.filter((p) => p.kind === 'pad').length} pads</span><span class="spacer" />
        <button class="btn default" disabled={!finalName} onClick={finish}>Finish</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="cw-split">
        <div class="cw-form">
          <fieldset><legend>Component patterns</legend>
            <select size={9} value={spec.pattern} aria-label="Pattern" onChange={(e) => pick((e.target as HTMLSelectElement).value as WizardPattern)}>
              {WIZARD_PATTERNS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </fieldset>
          <fieldset><legend>Pads</legend>
            {two && <label class="do-check"><input type="checkbox" checked={spec.smd} onChange={(e) => setSpec({ ...spec, smd: (e.target as HTMLInputElement).checked })} />Surface mount</label>}
            {!two && !grid && num(spec.pattern === 'quad' || spec.pattern === 'lcc' ? 'Pins (all four sides)' : 'Pins', 'pins', spec.pattern === 'quad' || spec.pattern === 'lcc' ? 4 : 2)}
            {grid && <>{num('Rows', 'rows')}{num('Columns', 'cols')}</>}
            {len(grid ? 'Pad diameter' : 'Pad width (X)', 'padX')}
            {!grid && len('Pad height (Y)', 'padY')}
            {len('Hole size', 'hole', !thPattern)}
            {!two && len('Pitch', 'pitch')}
            {!grid && len(two ? 'Pad spacing' : 'Row spacing', 'span')}
            {len('Outline width', 'outline')}
          </fieldset>
          <fieldset><legend>Name</legend>
            <label class="do-row"><span>Name</span><input type="text" value={name ?? wizardName(s)} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label class="do-row"><span>Description</span><input type="text" value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} /></label>
          </fieldset>
        </div>
        <div class="cw-preview"><FootprintPreview prims={prims} size={320} /></div>
      </div>
    </Dialog>
  );
}

function lens(s: WizardSpec, u: 'mil' | 'mm'): Record<LenKey, string> {
  const f = (v: number) => formatCoord(v, u).replace(/[a-z]+$/, '');
  return { padX: f(s.padX), padY: f(s.padY), hole: f(s.hole), pitch: f(s.pitch), span: f(s.span), outline: f(s.outline) };
}
