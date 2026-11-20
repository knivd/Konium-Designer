import { beforeEach, describe, expect, it } from 'vitest';
import { ADVISE, type AdviseInput } from '../src/ai/jobs';
import { adviceText, designDigest, findingRefs } from '../src/ai/advise';
import { demoFiles } from '../src/formats/synthetic/demo';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: readSchDoc(f.bytes, f.name) }));
const compiled = compileProject(sheets);

describe('AI design adviser (26.085)', () => {
  it('writes the design as text: parts with their pins and nets, a resistor\'s pins plainly, the nets with their pins, nothing on the sheets\' looks', () => {
    const d = designDigest('Demo', sheets, compiled);
    const lines = d.text.split('\n');
    expect(lines[0]).toBe('Design "Demo": 3 sheets (Demo.SchDoc, Symbols.SchDoc, Child.SchDoc), 6 parts, 19 nets.');
    expect(lines).toContain('U1: LDO 3V3; lib LDO SOT-223; fp SOT-223');
    expect(lines).toContain('  1 GND PWR=GND | 2 VOUT O=+3V3 | 3 VIN I=VIN | 4 TAB P=+3V3');
    expect(lines).toContain('R1: 1k; lib Res; fp 0805');
    expect(lines).toContain('  1=+3V3 | 2=NetD1_A');
    expect(lines).toContain('VIN: C1-1, J1-1, U1-3');
    expect(lines).toContain('GND [2 sheets]: C1-2, C2-2, D1-K, J1-2, U1-1');
    expect(lines).toContain('NetD1_A (unnamed): D1-A, R1-2');
    expect(lines.find((l) => l.startsWith('On no pin'))).toContain('VBAT');
    expect(d).toMatchObject({ parts: 6, nets: 19, pins: 14 });
    expect(d.text).not.toMatch(/LOCATION|mil\b|\d{6,}/);
    // A pin on no net: nc
    const lost = designDigest('Demo', sheets, { ...compiled, nets: compiled.nets.filter((n) => n.name !== 'VIN') });
    expect(lost.text).toContain('  1 GND PWR=GND | 2 VOUT O=+3V3 | 3 VIN I=nc | 4 TAB P=+3V3');
    // One sheet of a project says its nets may go on
    expect(designDigest('Demo.SchDoc', sheets.slice(0, 1), compileProject(sheets.slice(0, 1)), 'sheet').text.split('\n')[0]).toContain('one sheet of its project (nets may go on to other sheets)');
    // Where a finding's parts and nets are, to show them
    expect(findingRefs({ parts: ['u1', 'X9'], nets: ['vin'] }, d).length).toBe(d.partRefs.get('U1')!.length + d.netRefs.get('VIN')!.length);
    expect(d.partRefs.get('U1')![0]!.sheet).toBe('Demo.SchDoc');
  });
  it('asks with what to look at and what was dismissed; a text job that thinks a little', () => {
    const input: AdviseInput = { design: 'Design "X": …', focus: 'the power supply', dismissed: ['No reverse-polarity protection'] };
    const m = ADVISE.messages(input);
    expect(ADVISE).toMatchObject({ kind: 'advise', role: 'text', effort: 'medium' });
    expect(m[0]!.content).toContain('decoupling capacitors');
    expect(m[1]!.content).toBe('Look especially at: the power supply\n\nThe designer dismissed these before (not problems, or known): don\'t report them again.\n- No reverse-polarity protection\n\nDesign "X": …');
    expect(ADVISE.messages({ design: 'D', focus: '', dismissed: [] })[1]!.content).toBe('D');
    expect(ADVISE.size(input)).toBe(input.design.length + input.focus.length);
  });
  it('takes the answer: severities in the model\'s words, each title once, the worst first', () => {
    const a = ADVISE.check({ summary: 'A 3.3 V regulator from a 2-pin header.', findings: [
      { severity: 'Suggestion', title: 'No reverse-polarity protection', detail: 'J1 has no key.', fix: 'Add a Schottky diode.', parts: 'J1, U1', nets: ['VIN'] },
      { severity: 'critical', title: 'LDO output capacitor too small', detail: 'Needs 10 µF.', fix: '', parts: ['C2'], nets: [] },
      { severity: 'warn', title: 'C1 voltage rating unknown', parts: ['C1'] },
      { severity: 'error', title: 'LDO output capacitor too small' },
      { title: '' },
    ] }, ADVISE.blank);
    expect(a.summary).toBe('A 3.3 V regulator from a 2-pin header.');
    expect(a.findings.map((f) => [f.severity, f.title, f.parts, f.nets])).toEqual([
      ['error', 'LDO output capacitor too small', ['C2'], []], ['warning', 'C1 voltage rating unknown', ['C1'], []], ['suggestion', 'No reverse-polarity protection', ['J1', 'U1'], ['VIN']]]);
    expect(ADVISE.check({ summary: 'Fine as it is.', findings: [] }, ADVISE.blank)).toEqual({ summary: 'Fine as it is.', findings: [] });
    expect(() => ADVISE.check({ verdict: 'ok' }, ADVISE.blank)).toThrow(/No review came back/);
    expect(adviceText('Demo', a)).toBe([
      'AI design review: Demo', '', 'A 3.3 V regulator from a 2-pin header.', '',
      '1. [Error] LDO output capacitor too small (C2)\n   Needs 10 µF.',
      '2. [Warning] C1 voltage rating unknown (C1)',
      '3. [Suggestion] No reverse-polarity protection (J1, U1, VIN)\n   J1 has no key.\n   Fix: Add a Schottky diode.'].join('\n'));
  });

  describe('the service', () => {
    const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '2', DAILY_BUDGET_USD: '1' };
    const MODELS = [{ id: '~google/gemini-flash-latest', name: 'Gemini Flash', created: 200, pricing: { prompt: '0.0000005', completion: '0.000003' }, architecture: { input_modalities: ['text', 'image'] } }];
    const sqlite = (): Sql => {
      const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
        { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
      const db = new DatabaseSync(':memory:');
      return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
    };
    let store: StoreLogic;
    const fetchFn = (async (url: string) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: MODELS }))
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"summary": "Fine.", "findings": []}' } }], usage: { prompt_tokens: 4000, completion_tokens: 900, cost: 0.003 } })))) as typeof fetch;
    const req = (path: string, body?: object) => new Request(`https://konium.app/api/ai${path}`, body ? { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) } : { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    const now = Date.parse('2026-11-02T12:00:00Z');
    beforeEach(() => { store = new StoreLogic(sqlite()); resetModelCache(); });
    it('runs a check as one of the day\'s jobs, and keeps nothing of the design', async () => {
      const cfg = await (await handle(req('/config'), env, store, fetchFn, now)).json() as { jobs: string[] };
      expect(cfg.jobs).toContain('advise');
      const input: AdviseInput = { design: designDigest('Demo', sheets, compiled).text, focus: '', dismissed: [] };
      const r = await handle(req('/job', { job: 'advise', input, cacheKey: `${'b'.repeat(64)}:demo` }), env, store, fetchFn, now);
      expect(await r.json()).toMatchObject({ answer: { summary: 'Fine.', findings: [] }, allowance: { counted: 'jobs', jobs: 2, left: 1 } });
      // Nothing to share or keep: a design is the designer's own
      expect((await handle(req('/accept', { job: 'advise', cacheKey: `${'b'.repeat(64)}:demo`, answer: { summary: 'x', findings: [] } }), env, store, fetchFn, now)).status).toBe(400);
      expect(store.cached(`advise@1:${'b'.repeat(64)}:demo`)).toBeNull();
    });
  });
});
