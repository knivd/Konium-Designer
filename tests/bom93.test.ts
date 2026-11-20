import { describe, expect, it } from 'vitest';
import { JOBS, MPN } from '../src/ai/jobs';
import { verifyPart } from '../src/platform/jlcSearch';
import { addChoice, bomLines, choiceBag, choiceOf, designKeys, lineChoices } from '../src/model/activeBom';
import { newBomDoc } from '../src/formats/altium/bomdoc';
import { mpnLine } from '../src/app/dialogs/BomAiFill';

const service = (rows: object[]) => (async () => new Response(JSON.stringify({ components: rows }), { status: 200 })) as unknown as typeof fetch;

describe('AI: a part number for each BOM line', () => {
  it('asks with what each line says; keeps answers for the lines asked about, LCSC numbers only in their form', () => {
    expect(JOBS.mpn).toBe(MPN);
    const input = { lines: [{ id: 'L1', designators: 'R1, R2', comment: '10k', description: 'Resistor', footprint: 'R0603', params: 'Tolerance=1%' }], prefer: 'jlcpcb' as const, focus: '' };
    const user = MPN.messages(input)[1]!.content as string;
    expect(user).toContain('assembled at JLCPCB');
    expect(user).toContain('id: L1\ndesignators: R1, R2\ncomment: 10k\ndescription: Resistor\nfootprint: R0603\nparameters: Tolerance=1%');
    const got = MPN.check({ parts: [
      { id: 'L1', manufacturer: 'Yageo', mpn: 'RC0603FR-07 10KL', lcsc: 'c98220', confidence: 'High', why: '10k 1% 0603' },
      { id: 'L1', mpn: 'again' }, { id: 'L9', mpn: 'not asked' }, { id: 'L1x', mpn: 'x' },
    ] }, input);
    expect(got.parts).toEqual([{ id: 'L1', manufacturer: 'Yageo', mpn: 'RC0603FR-0710KL', lcsc: 'C98220', confidence: 'high', why: '10k 1% 0603' }]);
    expect(() => MPN.check({ nothing: true }, input)).toThrow();
  });

  it('a suggestion is looked up at JLCPCB: by its LCSC number when that part is the one named, else by its part number', async () => {
    const r = { lcsc: 98220, mfr: 'RC0603FR-0710KL', package: '0603', stock: 100, price: '[{"qFrom":1,"price":0.001}]', is_basic: true };
    expect(await verifyPart('RC0603FR-0710KL', 'C98220', service([r]))).toMatchObject({ part: { lcsc: 'C98220' }, note: '' });
    // The LCSC number names another part: found by its part number instead, and said so
    const other = { ...r, lcsc: 5, mfr: 'SOMETHING' };
    let n = 0;
    const two = (async () => new Response(JSON.stringify({ components: n++ === 0 ? [{ ...other, lcsc: 98220 }] : [r] }), { status: 200 })) as unknown as typeof fetch;
    expect(await verifyPart('RC0603FR-0710KL', 'C98220', two)).toMatchObject({ part: { lcsc: 'C98220' }, note: 'C98220 is SOMETHING at JLCPCB, not RC0603FR-0710KL; found as C98220' });
    expect(await verifyPart('NOPE-1', '', service([r]))).toEqual({ part: null, note: 'not at JLCPCB' });
  });

  it('a line as the model sees it; a suggestion added to a line whose parameters name a part goes first, that part kept next', () => {
    const it0 = { Designator: 'U1', Comment: 'LDO', Description: 'Regulator', Footprint: 'SOT-23-5', LibRef: 'LDO', 'Manufacturer 1': 'Acme', 'Manufacturer Part Number 1': 'AC1117', Note: '*' };
    designKeys.set(it0, { library: 'L.SchLib', libRef: 'LDO' });
    const d = newBomDoc('B.BomDoc');
    const [line] = bomLines([it0], { group: [], columns: [] }, d);
    expect(mpnLine(line!, 'L1')).toEqual({ id: 'L1', designators: 'U1', comment: 'LDO', description: 'Regulator', footprint: 'SOT-23-5', params: 'Manufacturer 1=Acme; Manufacturer Part Number 1=AC1117' });
    addChoice(d, line!, choiceBag({ manufacturer: 'Other', mpn: 'XC6206', supplier: 'LCSC', spn: 'C5446', prices: [], currency: 'USD', lifecycle: '', url: '', description: '' }));
    expect(lineChoices(line!).map((c) => [c.mpn, c.from])).toEqual([['XC6206', 'choice'], ['AC1117', 'choice']]);
    expect(choiceOf(line!.item!.choices[1]!).manufacturer).toBe('Acme');
  });
});
