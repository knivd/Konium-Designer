import { useMemo } from 'preact/hooks';
import { PIN_TYPES, type PinType, type PinsRead, type SymbolPin, type Variant } from '../../ai/jobs';
import { SIDES, buildSymbol, byNumber, sidesOf, type MadeSymbol, type Side } from '../../ai/symbol';
import { SymbolPreview } from './PlacePart';
import { settings } from '../../core/settings';

/**
 * A variant's schematic symbol as the designer is shaping it: the pins as read (and edited), the
 * side each goes on, the symbol's name, description, designator prefix and the footprint it links.
 */
export interface SymbolDraft { read: PinsRead; sides: Side[]; name: string; description: string; footprint: string }

export function newSymbolDraft(read: PinsRead, name: string, description: string, footprint = ''): SymbolDraft {
  return { read, sides: sidesOf(read), name, description, footprint };
}

/** The symbol a draft makes, its pins as long as Preferences › Schematic › Default Primitives says. */
export const draftSymbol = (d: SymbolDraft): MadeSymbol =>
  buildSymbol(d.read, { name: d.name.trim() || 'Component', description: d.description, footprint: d.footprint.trim() || null, sides: d.sides, pinLength: settings.schPinLength / 10 });

const TYPE_NAMES: Record<PinType, string> = { input: 'Input', output: 'Output', io: 'I/O', passive: 'Passive', power: 'Power', ground: 'Ground', oc: 'Open Collector', oe: 'Open Emitter', hiz: 'HiZ', nc: 'Not connected' };

/** What a designer should look at: the pin count against the variant's, pins and pads that don't meet, numbers twice. */
export function symbolChecks(d: SymbolDraft, v: Pick<Variant, 'pins'>, pads: string[] | null): { level: 'note' | 'warning' | 'error'; text: string }[] {
  const out: { level: 'note' | 'warning' | 'error'; text: string }[] = [];
  const nums = d.read.pins.map((p) => p.number);
  const twice = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (twice.length) out.push({ level: 'error', text: `Pin numbers used twice: ${twice.slice(0, 8).join(', ')}` });
  const counted = d.read.pins.filter((p) => !/^(EP|SH|SHIELD|MH|MP)\d*$/i.test(p.number)).length;
  if (v.pins && counted !== v.pins && counted !== v.pins + 1) out.push({ level: 'warning', text: `${counted} pins read for a ${v.pins}-pin package` });
  if (pads) {
    const have = new Set(pads.map((p) => p.toUpperCase()));
    const noPad = nums.filter((n) => !have.has(n.toUpperCase()));
    const want = new Set(nums.map((n) => n.toUpperCase()));
    const noPin = [...new Set(pads)].filter((p) => p && !want.has(p.toUpperCase()));
    if (noPad.length) out.push({ level: 'warning', text: `Pins with no pad in the footprint: ${noPad.sort(byNumber).slice(0, 10).join(', ')}${noPad.length > 10 ? ' …' : ''}` });
    if (noPin.length) out.push({ level: 'warning', text: `Pads with no pin in the symbol: ${noPin.sort(byNumber).slice(0, 10).join(', ')}${noPin.length > 10 ? ' …' : ''}` });
    if (!noPad.length && !noPin.length) out.push({ level: 'note', text: 'Every pin has its pad in the footprint, and every pad its pin' });
  }
  if (!d.name.trim()) out.push({ level: 'error', text: 'The symbol needs a name' });
  if (d.read.notes) out.push({ level: 'note', text: d.read.notes });
  return out;
}

/**
 * The review of a variant's symbol: its name, description, designator prefix and footprint; the
 * pins (number, name, active low, type, side), editable; the symbol drawn as it will be; the checks.
 */
export function SymbolReview({ draft, onChange, checks }: { draft: SymbolDraft; onChange: (d: SymbolDraft) => void; checks: { level: string; text: string }[] }) {
  const made = useMemo(() => draftSymbol(draft), [draft]);
  const r = draft.read;
  const setPin = (i: number, patch: Partial<SymbolPin>) => onChange({ ...draft, read: { ...r, pins: r.pins.map((p, j) => (j === i ? { ...p, ...patch } : p)) } });
  const setSide = (i: number, s: Side) => onChange({ ...draft, sides: draft.sides.map((x, j) => (j === i ? s : x)) });
  const field = (label: string, value: string, put: (v: string) => void) => (
    <label class="do-row"><span>{label}</span><input type="text" aria-label={label} value={value} onInput={(e) => put((e.target as HTMLInputElement).value)} /></label>
  );
  return (
    <div class="ai-symbol">
      <div class="ai-review">
        <div class="ai-review-form">
          <fieldset><legend>Symbol</legend>
            {field('Symbol name', draft.name, (name) => onChange({ ...draft, name }))}
            {field('Description', draft.description, (description) => onChange({ ...draft, description }))}
            {field('Designator prefix', r.prefix, (prefix) => onChange({ ...draft, read: { ...r, prefix: prefix.toUpperCase().replace(/[^A-Z]/g, '') } }))}
            {field('Footprint', draft.footprint, (footprint) => onChange({ ...draft, footprint }))}
          </fieldset>
        </div>
        <div class="ai-review-side">
          <div class="ai-symbol-preview"><SymbolPreview bags={made.bags} part={1} /></div>
          <ul class="ai-checks">{checks.map((c, i) => <li key={i} class={c.level}>{c.level === 'error' ? '✖ ' : c.level === 'warning' ? '⚠ ' : 'ℹ '}{c.text}</li>)}</ul>
        </div>
      </div>
      <fieldset><legend>Pins ({r.pins.length})</legend>
        <div class="sync-buttons">
          <button class="btn" title="Supplies on top, grounds below, inputs left, outputs right, the rest by group (a diode's anodes left, cathodes right)" onClick={() => onChange({ ...draft, sides: sidesOf({ ...r, kind: r.kind === 'connector' || r.kind === 'passive' ? 'ic' : r.kind }) })}>Sides by Function</button>
          <button class="btn" title="Pins in number order down the sides" onClick={() => onChange({ ...draft, sides: sidesOf({ ...r, kind: 'connector' }) })}>Sides by Number</button>
        </div>
        <div class="ai-pads ai-pins"><table class="ai-variants">
          <thead><tr><th>Pin</th><th>Name</th><th title="Active low: drawn with an overbar">Low</th><th>Type</th><th>Side</th><th>Group</th><th>Function</th></tr></thead>
          <tbody>{r.pins.map((p, i) => (
            <tr key={i}>
              <td><input type="text" aria-label={`Pin ${i + 1} number`} value={p.number} onInput={(e) => setPin(i, { number: (e.target as HTMLInputElement).value.trim() })} /></td>
              <td><input type="text" class="ai-pin-name" aria-label={`Pin ${i + 1} name`} value={p.name} onInput={(e) => setPin(i, { name: (e.target as HTMLInputElement).value })} /></td>
              <td class="al-center"><input type="checkbox" aria-label={`Pin ${i + 1} active low`} checked={p.activeLow} onChange={(e) => setPin(i, { activeLow: (e.target as HTMLInputElement).checked })} /></td>
              <td><select aria-label={`Pin ${i + 1} type`} value={p.type} onChange={(e) => setPin(i, { type: (e.target as HTMLSelectElement).value as PinType })}>
                {PIN_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}</select></td>
              <td><select aria-label={`Pin ${i + 1} side`} value={draft.sides[i]} onChange={(e) => setSide(i, (e.target as HTMLSelectElement).value as Side)}>
                {SIDES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</select></td>
              <td>{p.group}</td>
              <td class="small">{p.description}</td>
            </tr>))}</tbody>
        </table></div>
      </fieldset>
    </div>
  );
}
