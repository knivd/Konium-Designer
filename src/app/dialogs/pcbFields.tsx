/**
 * Pieces the board objects' dialogs share (Track, Arc, Via, Pad, Fill, String …), as AD17 lays
 * them out: values in the current unit (a bare number is in it, "10mil" or "0.25mm" as typed),
 * coordinates from the board origin, net and layer lists, the mask expansion choosers, and the
 * edited copy of the object's record that OK puts back in one undo step.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { formatCoord, parseLength } from '../../core/units';
import type { LayerId } from '../../model/layers';
import { NO_NET, type PcbPrim } from '../../model/pcb';
import { replaceRecords } from '../../model/pcbEdit';
import type { PcbRawRecord } from '../../formats/altium/framing';
import { carryPrimInfo, masksOf, padExtrasOf, setMasks, type MaskExpansion, type Masks } from '../../formats/altium/primInfo';
import { get, put, type Field } from '../../formats/altium/pcbLayouts';

/** "[mm]" or "[mil]" after a dialog's title, as AD17 shows the unit. */
export const unitTitle = (ed: PcbEditor, name: string) => `${name} [${ed.units() === 'mil' ? 'mil' : 'mm'}]`;

export function fmtLen(ed: PcbEditor, c: number): string {
  const u = ed.units();
  return formatCoord(c, u, u === 'mil' ? 3 : 4);
}
export function parseLen(ed: PcbEditor, v: string): number | undefined {
  const t = v.trim();
  return parseLength(/^-?[0-9]*\.?[0-9]+$/.test(t) ? `${t}${ed.units()}` : t);
}

/**
 * Where a dialog's OK goes: by default the object's record on the board (one undo step); for a
 * default (Tab while placing, Preferences › Defaults) the record the next ones start from.
 */
export interface RecordTarget { rec: PcbRawRecord; apply(after: PcbRawRecord): void }

/** The edited copy of a primitive's record: read and write fields; `bump` redraws. */
export function useRecord(ed: PcbEditor, p: PcbPrim, target?: RecordTarget) {
  const rec = target?.rec ?? ed.doc.streams.get(p.src.storage)!.records[p.src.index]!;
  const [subs] = useState(() => rec.subs.map((s) => s.slice()));
  const [masks, setM] = useState<Masks>(() => masksOf(rec));
  const [, setRev] = useState(0);
  const bump = () => setRev((n) => n + 1);
  const at = (sub: number) => {
    const b = subs[sub]!;
    return { get: (f: Field) => get(b, f) ?? 0, set: (f: Field, v: number) => { put(b, f, v); bump(); }, bytes: b };
  };
  /** OK: the record replaced by the copy (and its mask expansions, when `withMasks`), one undo step. */
  const commit = (label: string, withMasks = false, extra?: (after: PcbRawRecord) => void) => {
    const after: PcbRawRecord = { tag: rec.tag, subs: subs.map((s) => s.slice()) };
    carryPrimInfo(rec, after);
    if (withMasks) setMasks(after, p.src.storage, masks);
    extra?.(after);
    if (target) { target.apply(after); return; }
    // Nothing changed: no undo step (and the document stays as saved)
    const same = after.subs.length === rec.subs.length && after.subs.every((s, i) => s.length === rec.subs[i]!.length && s.every((v, k) => v === rec.subs[i]![k]))
      && after.wide === rec.wide && (!withMasks || JSON.stringify(masks) === JSON.stringify(masksOf(rec))) && JSON.stringify(padExtrasOf(after)) === JSON.stringify(padExtrasOf(rec));
    if (same) return;
    ed.undo.transact(label, (tx) => tx.add(replaceRecords(ed.doc, [{ storage: p.src.storage, index: p.src.index, after }])));
    ed.invalidate();
  };
  return { rec, subs, at, bump, commit, masks, setMasks: (m: Masks) => setM(m), isDefault: !!target };
}

/** flags1 bit 2 clear = locked. */
export const lockedOf = (f1: number) => (f1 & 0x04) === 0;
export const withLocked = (f1: number, on: boolean) => (on ? f1 & ~0x04 : f1 | 0x04);

const MAX_LEN = 0x7fffffff;

/** A length in the current unit, applied when it parses (Enter or leaving the box). */
export function LenInput({ ed, value, onChange, id, disabled, min, label, class: cls }: {
  ed: PcbEditor; value: number; onChange: (c: number) => void; id?: string; disabled?: boolean; min?: number; label?: string; class?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  // (a length a board file cannot hold, past 32 bits of its units: about 5.4 m, is refused rather than wrapped round)
  const apply = (t: string) => { const c = parseLen(ed, t); if (c !== undefined && Math.abs(c) <= MAX_LEN && (min === undefined || c >= min)) onChange(c); else if (c !== undefined && Math.abs(c) > MAX_LEN) ed.status?.('That length is longer than a board file can hold: not changed'); setText(null); };
  return (
    <input type="text" id={id} class={cls ?? 'pd-val'} aria-label={label} disabled={disabled} value={text ?? fmtLen(ed, value)}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onBlur={(e) => apply((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { apply((e.target as HTMLInputElement).value); } }} />
  );
}

/** A coordinate shown from the board origin. */
export function CoordInput({ ed, value, axis, onChange, id, label }: { ed: PcbEditor; value: number; axis: 'x' | 'y'; onChange: (c: number) => void; id?: string; label?: string }) {
  const o = ed.origin()[axis];
  return <LenInput ed={ed} id={id} label={label} value={value - o} onChange={(c) => onChange(c + o)} />;
}

/** An angle in degrees, three decimals as AD17 shows them. */
export function AngleInput({ value, onChange, id, label }: { value: number; onChange: (a: number) => void; id?: string; label?: string }) {
  const [text, setText] = useState<string | null>(null);
  const apply = (t: string) => { const a = Number(t.replace(/°/g, '')); if (Number.isFinite(a)) onChange(a); setText(null); };
  return (
    <input type="text" id={id} class="pd-val" aria-label={label} value={text ?? value.toFixed(3)} onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onBlur={(e) => apply((e.target as HTMLInputElement).value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') apply((e.target as HTMLInputElement).value); }} />
  );
}

export function NetSelect({ ed, value, onChange, id, disabled }: { ed: PcbEditor; value: number; onChange: (n: number) => void; id?: string; disabled?: boolean }) {
  const nets = [...ed.doc.nets].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(Number((e.target as HTMLSelectElement).value))}>
      <option value={String(NO_NET)}>No Net</option>
      {nets.map((n) => <option key={n.index} value={String(n.index)}>{n.name}</option>)}
    </select>
  );
}

export function LayerSelect({ ed, value, layers, onChange, id, disabled }: { ed: PcbEditor; value: LayerId; layers: LayerId[]; onChange: (l: LayerId) => void; id?: string; disabled?: boolean }) {
  const list = layers.includes(value) ? layers : [value, ...layers];
  return (
    <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(Number((e.target as HTMLSelectElement).value))}>
      {list.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}
    </select>
  );
}

/**
 * Solder / Paste Mask Expansion of a track, arc, fill or region, drawn as AD17 draws it: the
 * setting as a link with a drop-down arrow (No Mask, Rule, or a value typed in Manual).
 */
export function MaskChooser({ ed, label, value, onChange, disabled }: { ed: PcbEditor; label: string; value: MaskExpansion; onChange: (m: MaskExpansion) => void; disabled?: boolean }) {
  const c = parseLength(value.value) ?? 0;
  return (
    <div class={`pd-mask${disabled ? ' off' : ''}`} title={disabled ? 'Not for this object yet' : undefined}>
      <span class="pd-label">{label}</span>
      <span class={`pd-mask-pick${value.mode === 'Manual' ? ' manual' : ''}`}>
        {value.mode === 'Manual'
          ? <LenInput ed={ed} class="pd-val pd-link-val" label={`${label} value`} value={c} onChange={(v) => onChange({ mode: 'Manual', value: `${+(v / 10000).toFixed(4)}mil` })} />
          : <span class="pd-link-val">{value.mode === 'Rule' ? 'Rule' : 'No Mask'}</span>}
        <span class="pd-arrow" aria-hidden="true">▾</span>
        <select aria-label={label} class="pd-drop" disabled={disabled} value={value.mode} onChange={(e) => onChange({ ...value, mode: (e.target as HTMLSelectElement).value as MaskExpansion['mode'] })}>
          <option value="None">No Mask</option><option value="Rule">Rule</option><option value="Manual">Manual</option>
        </select>
      </span>
    </div>
  );
}

/** A labelled row in a group box. */
export const Row = ({ label, children, for: f }: { label: string; children: ComponentChildren; for?: string }) => (
  <div class="pd-row"><label class="pd-label" for={f}>{label}</label><div class="pd-field">{children}</div></div>
);
export const Check = ({ label, checked, onChange, disabled, title }: { label: string; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; title?: string }) => (
  <label class="pd-check" title={title}><span>{label}</span><input type="checkbox" checked={checked} disabled={disabled || !onChange} onChange={(e) => onChange?.((e.target as HTMLInputElement).checked)} /></label>
);
