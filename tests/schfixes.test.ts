import { describe, expect, it } from 'vitest';
import { ruleFromParameter, ruleParameterText, ruleSummary } from '../src/model/schRules';

describe('PCB rules on a schematic (26.022)', () => {
  const text = 'UNIONINDEX{}0[]RULEKIND{}MaxMinImpedance[]NETSCOPE{}DifferentNets[]LAYERKIND{}SameLayer[]NAME{}Schematic Impedance Constraint[]MINIMUM{}49.00[]MAXIMUM{}51.00[]UNIT{}Imperial[]PcbType{}ProtelPcb';
  it('decodes the {} / [] escaped rule', () => {
    const r = ruleFromParameter(text);
    expect([r.get('RULEKIND'), r.get('NAME'), r.get('MINIMUM'), r.get('PcbType')]).toEqual(['MaxMinImpedance', 'Schematic Impedance Constraint', '49.00', 'ProtelPcb']);
  });
  it('shows the summary AD17 shows', () => {
    expect(ruleSummary(text)).toBe('Impedance Constraint [Min = 49.00   Max = 51.00   ]');
    expect(ruleSummary('RULEKIND{}Width[]MINLIMIT{}8mil[]MAXLIMIT{}12mil[]PREFEREDWIDTH{}10mil')).toBe('Width Constraint [Pref Width = 10mil   Min Width = 8mil   Max Width = 12mil   ]');
    expect(ruleSummary('PcbType{}ProtelPcb')).toBe('Undefined');
  });
  it('a Rule parameter shows its description first; other parameters show as usual', () => {
    expect(ruleParameterText('Rule', text, undefined)).toBe('Impedance Constraint [Min = 49.00   Max = 51.00   ]');
    expect(ruleParameterText('Rule', 'PcbType=ProtelPcb', 'Undefined')).toBe('Undefined');
    expect(ruleParameterText('Value', '10k', undefined)).toBeNull();
  });
});
