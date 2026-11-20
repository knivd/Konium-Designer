import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { RULE_KINDS } from '../../formats/altium/rules';
import { ruleParameterValue, ruleSummary } from '../../model/schRules';

/**
 * Parameters › Add as Rule...: AD's Choose Design Rule Type and the rule's values, made into a
 * Rule parameter (its value the rule's properties, its description the rule's summary). On a
 * Parameter Set the rule goes with the net the directive sits on, on a component with that
 * component; Design › Update PCB Document adds it to the board (scoped InNet / InComponent).
 */
export function AddRuleDialog({ onOk }: { onOk: (text: string, description: string) => void }) {
  const kinds = RULE_KINDS.filter((k) => k.fields.length);
  const cats = [...new Set(kinds.map((k) => k.category))];
  const [kind, setKind] = useState(kinds.find((k) => k.kind === 'Width')?.kind ?? kinds[0]!.kind);
  const info = kinds.find((k) => k.kind === kind)!;
  const [values, setValues] = useState<Record<string, string>>({});
  const value = (key: string, def: string) => values[`${kind}.${key}`] ?? def;
  const text = () => ruleParameterValue({ RULEKIND: kind, ...Object.fromEntries(info.fields.map((f) => [f.key, value(f.key, f.def).trim()])) });
  const ok = () => { const t = text(); closeDialog(); onOk(t, ruleSummary(t)); };
  return (
    <Dialog title="Choose Design Rule Type" width={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="addrule"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="do-row"><span>Rule Type</span>
        <select value={kind} aria-label="Rule type" onChange={(e) => setKind((e.target as HTMLSelectElement).value)}>
          {cats.map((c) => <optgroup key={c} label={c}>{kinds.filter((k) => k.category === c).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</optgroup>)}
        </select></label>
      <fieldset><legend>Constraints</legend>
        {info.fields.map((f) => (
          <label key={f.key} class="do-row"><span>{f.label}</span>
            <input type="text" value={value(f.key, f.def)} aria-label={f.label} onKeyDown={(e) => e.stopPropagation()}
              onInput={(e) => setValues({ ...values, [`${kind}.${f.key}`]: (e.target as HTMLInputElement).value })} /></label>
        ))}
      </fieldset>
      <p class="small muted">{ruleSummary(text())}</p>
    </Dialog>
  );
}
