/**
 * The CAM editor's small dialogs as one form: lengths (shown in the units in use, typed with or
 * without a unit), numbers, text, choices, ticks and lists of layers — so Array, Offset, Scale,
 * Spread/Reduce, Panelize, Venting, Teardrops and the rest ask in the same way [est: their layout].
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { formatCoord, parseLengthIn, type DisplayUnit } from '../../core/units';

export type CamField =
  | { key: string; label: string; kind: 'length'; value: number; min?: number }
  | { key: string; label: string; kind: 'number'; value: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; kind: 'text'; value: string; multiline?: boolean }
  | { key: string; label: string; kind: 'bool'; value: boolean }
  | { key: string; label: string; kind: 'select'; value: string; options: string[] }
  | { key: string; label: string; kind: 'layers'; value: string[]; options: string[] }
  | { key?: undefined; kind: 'note'; text: string };

export type CamValues = Record<string, number | string | boolean | string[]>;

/** Told of every CAM form answered (a macro being recorded): its title and the values given. */
export const camFormObservers = new Set<(title: string, v: CamValues) => void>();

export function CamFormDialog({ title, fields, units, onOk, width = 400, okLabel = 'OK', cls }: {
  title: string; fields: CamField[]; units: DisplayUnit; onOk: (v: CamValues) => void | string; width?: number; okLabel?: string; cls?: string;
}) {
  const fmt = (c: number) => formatCoord(c, units, units === 'mil' ? 3 : 4);
  const [vals, setVals] = useState<Record<string, string | boolean | string[]>>(() => {
    const v: Record<string, string | boolean | string[]> = {};
    for (const f of fields) {
      if (f.kind === 'note') continue;
      v[f.key] = f.kind === 'length' ? fmt(f.value) : f.kind === 'number' ? String(f.value) : f.kind === 'bool' ? f.value : f.kind === 'layers' ? [...f.value] : f.value;
    }
    return v;
  });
  const [err, setErr] = useState('');
  const set = (k: string, x: string | boolean | string[]) => setVals({ ...vals, [k]: x });
  const ok = () => {
    const out: CamValues = {};
    for (const f of fields) {
      if (f.kind === 'note') continue;
      const raw = vals[f.key]!;
      if (f.kind === 'length') {
        const c = parseLengthIn(raw as string, units);
        if (c === undefined || (f.min !== undefined && c < f.min)) { setErr(`${f.label}: not a length${f.min !== undefined ? ` of ${fmt(f.min)} or more` : ''}`); return; }
        out[f.key] = c;
      } else if (f.kind === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) { setErr(`${f.label}: a number${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}`); return; }
        out[f.key] = n;
      } else out[f.key] = raw;
    }
    const r = onOk(out);
    if (typeof r === 'string') { setErr(r); return; }
    for (const o of camFormObservers) o(title, out);
    closeDialog();
  };
  return (
    <Dialog title={title} width={width} class={`camform ${cls ?? ''}`} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="camform-err" role="alert">{err}</span><span class="spacer" /><button class="btn default" onClick={ok}>{okLabel}</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="camform-body">
        {fields.map((f, i) => {
          if (f.kind === 'note') return <p key={`n${i}`} class="muted">{f.text}</p>;
          const id = `cf-${f.key}`;
          if (f.kind === 'bool') return <label key={f.key} class="camform-check"><input type="checkbox" id={id} checked={vals[f.key] as boolean} onChange={(e) => set(f.key, (e.target as HTMLInputElement).checked)} />{f.label}</label>;
          if (f.kind === 'layers') {
            const on = new Set(vals[f.key] as string[]);
            return (
              <fieldset key={f.key} class="camform-layers"><legend>{f.label}</legend>
                {f.options.map((o) => <label key={o}><input type="checkbox" aria-label={o} checked={on.has(o)} onChange={(e) => { const n = new Set(on); if ((e.target as HTMLInputElement).checked) n.add(o); else n.delete(o); set(f.key, f.options.filter((x) => n.has(x))); }} />{o}</label>)}
              </fieldset>
            );
          }
          return (
            <label key={f.key} for={id}><span>{f.label}</span>
              {f.kind === 'select'
                ? <select id={id} value={vals[f.key] as string} onChange={(e) => set(f.key, (e.target as HTMLSelectElement).value)}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                : f.kind === 'text' && f.multiline
                  ? <textarea id={id} rows={8} value={vals[f.key] as string} onInput={(e) => set(f.key, (e.target as HTMLTextAreaElement).value)} />
                  : <input id={id} type="text" autofocus={i === 0} value={vals[f.key] as string} onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)} />}
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}
