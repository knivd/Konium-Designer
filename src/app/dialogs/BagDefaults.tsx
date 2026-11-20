import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, units } from '../state';
import { formatAltiumLength, formatCoord, parseLength } from '../../core/units';
import { BAG_FIELDS, bagDefaults, setBagDefaults, type BagKind } from '../../model/bagDefaults';

/**
 * Preferences › PCB Editor › Defaults › Edit Values for a Component, Coordinate, Dimension or
 * Polygon: the properties the next one placed starts from, lengths in the unit in use.
 */
export function BagDefaultsDialog({ kind, onDone }: { kind: BagKind; onDone?: () => void }) {
  const u = units.value === 'mm' ? 'mm' : 'mil';
  const [v, setV] = useState<Record<string, string>>(() => {
    const d = bagDefaults(kind);
    return Object.fromEntries(BAG_FIELDS[kind].map((f) => [f.key, f.kind === 'len' ? formatCoord(Math.round(parseLength(d[f.key]) ?? 0), u).replace(/[a-z]+$/, '') : d[f.key]!]));
  });
  const ok = () => {
    const out: Record<string, string> = {};
    for (const f of BAG_FIELDS[kind]) {
      const x = (v[f.key] ?? '').trim();
      if (f.kind === 'len') {
        const c = parseLength(/^-?[\d.]+$/.test(x) ? `${x}${u}` : x);
        if (c === undefined || c < 0) { notify(`${f.label}: give a length`, 'error'); return; }
        out[f.key] = formatAltiumLength(Math.round(c));
      } else if (f.kind === 'int') {
        const n = Math.round(Number(x));
        if (!Number.isFinite(n) || n < 0) { notify(`${f.label}: give a whole number`, 'error'); return; }
        out[f.key] = String(n);
      } else out[f.key] = x;
    }
    setBagDefaults(kind, out);
    closeDialog();
    onDone?.();
  };
  return (
    <Dialog title={`${kind} Defaults`} width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="bagdefaults"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      {BAG_FIELDS[kind].map((f) => (
        <label key={f.key} class="do-row"><span>{f.label}{f.kind === 'len' ? ` (${u})` : ''}</span>
          {f.kind === 'bool' ? <input type="checkbox" aria-label={f.label} checked={v[f.key] === 'TRUE'} onChange={(e) => setV({ ...v, [f.key]: (e.target as HTMLInputElement).checked ? 'TRUE' : 'FALSE' })} />
            : f.kind === 'choice' ? <select aria-label={f.label} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: (e.target as HTMLSelectElement).value })}>{f.choices!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            : <input type="text" aria-label={f.label} value={v[f.key]} onKeyDown={(e) => e.stopPropagation()} onInput={(e) => setV({ ...v, [f.key]: (e.target as HTMLInputElement).value })} />}
        </label>
      ))}
    </Dialog>
  );
}
