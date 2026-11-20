import { useMemo, useState } from 'preact/hooks';
import { FootprintPreview } from './FootprintPreview';
import { PACKAGE_FAMILIES, type LandPad, type MmRange, type PackageFamily, type PackageRead, type Variant } from '../../ai/jobs';
import { buildFootprint, calcMissing, footprintName, mirrorLand, rotateLand, type PadSource } from '../../ai/footprint';
import type { Density } from '../../model/ipcFootprint';
import { decodePrim } from '../../formats/altium/pcbdoc';
import { storageFor } from '../../formats/altium/pcblib';
import type { PcbPrim } from '../../model/pcb';
import type { PcbRawRecord } from '../../formats/altium/framing';
import type { Measured } from '../../ai/snap';

/**
 * A variant's footprint as the designer is shaping it: the drawing as read (and edited), where the
 * pads come from, the density, and the name (null: IPC-7351's for pads worked out, else the package's).
 */
export interface Draft {
  read: PackageRead; source: PadSource; density: Density; name: string | null; packageName: string;
  /** As the AI read it, and with its pads measured from the drawing (null: not measured), and which is in use. */
  original: PackageRead; measured: Measured | null; useMeasured: boolean;
  /** The model's checking of the footprint against the drawing (null: not checked). */
  review?: Review | null;
}

/**
 * Rounds the model checked the footprint, whether it then matched, what it found (still, or last
 * put right), how many times it put it right, and whether the last version went unchecked (the
 * rounds ran out on a putting right).
 */
export interface Review { rounds: number; ok: boolean; problems: string[]; fixed: number; unchecked: boolean }

/** The checking's outcome as checks: a note when it matched, a warning for each thing it still finds. */
export function reviewChecks(d: Draft): { level: 'note' | 'warning'; text: string }[] {
  const r = d.review;
  if (!r) return [];
  const fixed = r.fixed ? `, after putting it right ${r.fixed === 1 ? 'once' : `${r.fixed} times`}` : '';
  if (r.ok) return [{ level: 'note', text: `Checked by the model against the drawing: it matches (round ${r.rounds}${fixed})` }];
  if (r.unchecked) return [{ level: 'warning', text: `The model put the footprint right ${r.fixed === 1 ? 'once' : `${r.fixed} times`} in ${r.rounds} round${r.rounds === 1 ? '' : 's'} of checking; the last version wasn't checked again (more rounds: Preferences › System › AI)` },
    ...r.problems.map((p) => ({ level: 'note' as const, text: `Put right: ${p}` }))];
  if (!r.problems.length) return [{ level: 'warning', text: `Checked by the model against the drawing for ${r.rounds} round${r.rounds === 1 ? '' : 's'}${fixed}, without a verdict` }];
  return r.problems.map((p, i) => ({ level: 'warning' as const, text: i ? p : `The model's check (${r.rounds} round${r.rounds === 1 ? '' : 's'}${fixed}) still finds: ${p}` }));
}

export function newDraft(v: Variant, read: PackageRead, measured: Measured | null = null): Draft {
  // No land pattern read: worked out from the dimensions, unless there's no family to work them out for (pads by hand then)
  const source: PadSource = read.land.length || read.family === 'OTHER' ? 'datasheet' : 'calc';
  return { read: measured?.read ?? read, source, density: 'N', name: null, packageName: footprintName(v, read), original: read, measured, useMeasured: !!measured };
}

/** The footprint a draft makes (null with the reason when it can't make one yet). */
export function draftFootprint(d: Draft, template?: PcbRawRecord) {
  if (d.source === 'calc' && calcMissing(d.read).length && d.read.family === 'OTHER') return { error: 'Choose the package family, or give the land pattern\'s pads' };
  if (d.source === 'datasheet' && !d.read.land.length) return { error: 'No land pattern was read: add its pads (Add Pad), or choose the package family to work them out from the dimensions' };
  const name = d.name ?? (d.source === 'calc' && d.read.family !== 'DIP' ? '' : d.packageName);
  try { return { built: buildFootprint(d.read, { source: d.source, density: d.density, name }, template) }; } catch (e) { return { error: (e as Error).message }; }
}

const RANGES: [keyof PackageRead, string][] = [
  ['bodyD', 'Body length (D)'], ['bodyE', 'Body width (E1)'], ['height', 'Height (A)'], ['span', 'Lead span (E)'], ['span2', 'Lead span, other sides'],
  ['term', 'Foot length (L)'], ['leadW', 'Lead width (b)'], ['ball', 'Ball diameter'],
];
const showRange = (k: keyof PackageRead, f: PackageFamily) =>
  k === 'span2' ? ['QFP', 'QFN', 'PLCC'].includes(f) : k === 'ball' ? f === 'BGA' : k === 'span' || k === 'term' || k === 'leadW' ? f !== 'BGA' : true;

/**
 * The review of one variant's footprint: the dimensions read (editable, min and max in mm), where
 * the pads come from (the datasheet's land pattern, or worked out by IPC-7351B), the pads
 * themselves when they're the datasheet's (editable; mirror and turn for a drawing read the other
 * way round), the checks, and the footprint drawn beside the datasheet's page.
 */
export function PackageReview({ draft, onChange, prims, checks, error, name }: {
  draft: Draft; onChange: (d: Draft) => void; prims: PcbPrim[]; checks: { level: string; text: string }[]; error?: string; name: string;
}) {
  const r = draft.read;
  const set = (patch: Partial<PackageRead>) => onChange({ ...draft, read: { ...r, ...patch } });
  const missing = calcMissing(r);
  const range = (k: keyof PackageRead, label: string) => {
    const v = r[k] as MmRange | null;
    const one = (which: 'min' | 'max') => <input type="number" step={0.01} min={0} aria-label={`${label} ${which}`} value={v ? v[which] : ''} placeholder="?"
      onChange={(e) => {
        const x = Number((e.target as HTMLInputElement).value);
        const t = (e.target as HTMLInputElement).value.trim();
        if (!t) { set({ [k]: null } as Partial<PackageRead>); return; }
        if (!(x > 0)) return;
        const other = v ? v[which === 'min' ? 'max' : 'min'] : x;
        set({ [k]: which === 'min' ? { min: x, max: Math.max(x, other) } : { min: Math.min(x, other), max: x } } as Partial<PackageRead>);
      }} />;
    return <label key={k} class="do-row ipc-range"><span>{label}</span>{one('min')}<span class="muted">–</span>{one('max')}</label>;
  };
  const int = (label: string, value: number, put: (n: number) => void) => (
    <label class="do-row"><span>{label}</span><input type="number" min={0} step={1} aria-label={label} value={value || ''} placeholder="?"
      onChange={(e) => { const n = Math.round(Number((e.target as HTMLInputElement).value)); if (n >= 0) put(n); }} /></label>
  );
  const padCell = (i: number, k: 'name' | 'x' | 'y' | 'w' | 'h' | 'hole') => {
    const p = r.land[i]!;
    const change = (e: Event) => {
        const t = (e.target as HTMLInputElement).value;
        const land = r.land.slice();
        if (k === 'name') land[i] = { ...p, name: t.trim() };
        else { const n = Number(t); if (!Number.isFinite(n) || (k !== 'x' && k !== 'y' && n < 0)) return; land[i] = { ...p, [k]: n }; }
        set({ land });
    };
    return <td>{k === 'name'
      ? <input type="text" aria-label={`Pad ${i + 1} name`} value={p.name} onChange={change} />
      : <input type="number" step={0.01} aria-label={`Pad ${i + 1} ${k}`} value={p[k]} onChange={change} />}</td>;
  };
  return (
    <div class="ai-review">
      <div class="ai-review-form">
        <fieldset><legend>Package</legend>
          <label class="do-row"><span>Family</span><select aria-label="Family" value={r.family} onChange={(e) => set({ family: (e.target as HTMLSelectElement).value as PackageFamily })}>
            {PACKAGE_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          {int('Pins', r.pins, (n) => set({ pins: n }))}
          <label class="do-row"><span>Pitch (e)</span><input type="number" step={0.01} min={0} aria-label="Pitch" value={r.pitch ?? ''} placeholder="?"
            onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); set({ pitch: n > 0 ? n : null }); }} /></label>
          {['QFP', 'QFN', 'PLCC'].includes(r.family) && int('Pins on each left / right side', r.pinsSide, (n) => set({ pinsSide: n }))}
          {r.family === 'BGA' && <>{int('Rows', r.rows, (n) => set({ rows: n }))}{int('Columns', r.cols, (n) => set({ cols: n }))}</>}
        </fieldset>
        <fieldset><legend>Dimensions (mm, min – max)</legend>
          {RANGES.filter(([k]) => showRange(k, r.family)).map(([k, l]) => range(k, l))}
          {['SON', 'QFN', 'SOT223', 'DPAK'].includes(r.family) && <>
            <label class="do-row ipc-range"><span>{r.family === 'SON' || r.family === 'QFN' ? 'Exposed pad (E2 × D2)' : 'Tab (width × length)'}</span>
              <input type="number" step={0.01} min={0} aria-label="Tab width" value={r.tab ? r.tab.w.max : ''} placeholder="?" onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); set({ tab: n > 0 ? { w: { min: n, max: n }, l: r.tab?.l ?? { min: n, max: n } } : null }); }} />
              <span class="muted">×</span>
              <input type="number" step={0.01} min={0} aria-label="Tab length" value={r.tab ? r.tab.l.max : ''} placeholder="?" onChange={(e) => { const n = Number((e.target as HTMLInputElement).value); if (n > 0) set({ tab: { w: r.tab?.w ?? { min: n, max: n }, l: { min: n, max: n } } }); }} />
            </label></>}
        </fieldset>
        <fieldset><legend>Pads</legend>
          <label class="do-check"><input type="radio" name="ai-src" checked={draft.source === 'datasheet'} onChange={() => onChange({ ...draft, source: 'datasheet' })} />
            The datasheet's land pattern{r.land.length ? ` (${r.land.length} pads)` : ' (none read: add the pads)'}</label>
          <label class="do-check" title={missing.length ? `Missing: ${missing.join(', ')}` : ''}><input type="radio" name="ai-src" checked={draft.source === 'calc'} disabled={r.family === 'OTHER'} onChange={() => onChange({ ...draft, source: 'calc' })} />
            Worked out from the dimensions ({r.family === 'DIP' ? 'IPC-7251' : 'IPC-7351B'}){missing.length && r.family !== 'OTHER' ? ` — typical values for ${missing.join(', ')}` : ''}</label>
          <div class="out-radios">{([['M', 'Most'], ['N', 'Nominal'], ['L', 'Least']] as [Density, string][]).map(([v, t]) =>
            <label key={v}><input type="radio" name="ai-density" checked={draft.density === v} onChange={() => onChange({ ...draft, density: v })} />{t}</label>)}</div>
          {draft.source === 'datasheet' && <>
            {draft.measured && <label class="do-check" title="The pads' places measured in the drawing itself (the AI reads which pads there are and their sizes well, their places less so); off: as the AI worked them out">
              <input type="checkbox" checked={draft.useMeasured} onChange={(e) => { const on = (e.target as HTMLInputElement).checked; onChange({ ...draft, useMeasured: on, read: on ? draft.measured!.read : draft.original }); }} />
              Pads where the drawing has them ({draft.measured.moved} of {draft.measured.total} measured{draft.measured.vector ? ' on its lines' : ''})</label>}
            <div class="sync-buttons">
              <button class="btn" disabled={!r.land.length} title="Turn the land pattern over left to right (a drawing seen from below)" onClick={() => onChange({ ...draft, read: mirrorLand(r) })}>Mirror</button>
              <button class="btn" disabled={!r.land.length} title="Turn the land pattern a quarter anticlockwise" onClick={() => onChange({ ...draft, read: rotateLand(r) })}>Rotate</button>
              <button class="btn" title="A pad after the last one, a pitch on" onClick={() => set({ land: [...r.land, nextPad(r)] })}>Add Pad</button>
            </div>
            {r.land.length > 0 && <div class="ai-pads"><table class="ai-variants">
              <thead><tr><th>Pad</th><th>X</th><th>Y</th><th>W</th><th>H</th><th>Hole</th><th /></tr></thead>
              <tbody>{r.land.map((_, i) => <tr key={i}>{padCell(i, 'name')}{padCell(i, 'x')}{padCell(i, 'y')}{padCell(i, 'w')}{padCell(i, 'h')}{padCell(i, 'hole')}
                <td><button class="btn ai-del" title="Remove this pad" aria-label={`Remove pad ${i + 1}`} onClick={() => set({ land: r.land.filter((__, j) => j !== i) })}>×</button></td></tr>)}</tbody>
            </table></div>}
          </>}
        </fieldset>
        <fieldset><legend>Footprint</legend>
          <label class="do-row"><span>Footprint name</span><input type="text" aria-label="Footprint name" value={draft.name ?? name} onInput={(e) => onChange({ ...draft, name: (e.target as HTMLInputElement).value })} /></label>
        </fieldset>
      </div>
      <div class="ai-review-side">
        <FootprintPreview prims={prims} size={330} />
        {error && <p class="ai-error">{error}</p>}
        <ul class="ai-checks">{checks.map((c, i) => <li key={i} class={c.level}>{c.level === 'error' ? '✖ ' : c.level === 'warning' ? '⚠ ' : 'ℹ '}{c.text}</li>)}</ul>
        {r.dimensions.length > 0 && <details class="ai-dims"><summary class="small">Dimensions read ({r.dimensions.length})</summary><ul class="small">{r.dimensions.map((d, i) => <li key={i}>{d}</li>)}</ul></details>}
      </div>
    </div>
  );
}

/** A pad added by hand: the last one's size, a pitch below it (or a square millimetre at the origin), numbered on. */
export function nextPad(r: PackageRead): LandPad {
  const last = r.land.at(-1);
  if (!last) return { name: '1', x: 0, y: 0, w: 1, h: 1, shape: 'rect', hole: 0, slot: 0, plated: true };
  const n = /^(.*?)(\d+)$/.exec(last.name);
  return { ...last, name: n ? `${n[1]}${Number(n[2]) + 1}` : `${r.land.length + 1}`, y: +(last.y - (r.pitch ?? Math.max(last.h, last.w) * 2)).toFixed(4) };
}

/** The primitives of footprint records, to draw. */
export function usePrims(records: PcbRawRecord[] | undefined): PcbPrim[] {
  // The 3D body left out: drawn filled, it hides the pads
  return useMemo(() => (records ?? []).map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).filter((p): p is PcbPrim => !!p && p.kind !== 'body'), [records]);
}

/** A footprint's pad names (designators), as its records have them. */
export const padNames = (records: PcbRawRecord[]) =>
  records.map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).flatMap((p) => (p?.kind === 'pad' ? [p.name] : []));

/** A small state holder for a draft being edited (kept by the dialog per variant). */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  const put = (k: number, d: Draft) => setDrafts((m) => new Map(m).set(k, d));
  return { drafts, put, reset: () => setDrafts(new Map()) };
}
