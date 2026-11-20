import { beforeEach, describe, expect, it } from 'vitest';
import { PINS, type PinsInput, type PinsRead, type SymbolPin } from '../src/ai/jobs';
import { buildSymbol, overbar, sidesOf } from '../src/ai/symbol';
import { draftSymbol, newSymbolDraft, symbolChecks } from '../src/app/dialogs/AiSymbol';
import { DEFAULTS, settings } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { readSchLib, writeSchLib } from '../src/formats/altium/schlib';
import { deriveObject, SR, type SchObject } from '../src/model/sch';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const pin = (number: string, name: string, type: SymbolPin['type'], group = '', activeLow = false): SymbolPin => ({ number, name, activeLow, type, group, description: '' });
/** An SPI flash in SOIC-8, with a thermal pad: the pins as a model would read them. */
const FLASH: PinsRead = {
  kind: 'ic', prefix: 'U', pages: [3], notes: '',
  pins: [pin('1', 'CS', 'input', 'SPI', true), pin('2', 'DO', 'output', 'SPI'), pin('3', 'WP', 'input', 'Control', true), pin('4', 'GND', 'ground', 'Power'),
    pin('5', 'DI', 'input', 'SPI'), pin('6', 'CLK', 'input', 'SPI'), pin('7', 'HOLD', 'input', 'Control', true), pin('8', 'VCC', 'power', 'Power'), pin('9', 'EP', 'ground', 'Power')],
};
const input: PinsInput = { device: 'W25Q', variant: { partNumbers: ['W25Q32JVSSIQ'], package: 'SOIC-8', pins: 8, pinout: 'A', leadForm: 'gull-wing' }, pages: [{ page: 3, text: 'Pin Description CS# DO WP# GND DI CLK HOLD# VCC' }], pictures: [], pageCount: 80 };
const pinsOf = (bags: ReturnType<typeof buildSymbol>['bags']) => bags.map((b, i) => deriveObject(b, i)).filter((o): o is SchObject & { kind: 'pin' } => o.kind === 'pin');

describe('AI symbol builder (26.083)', () => {
  it('asks for the variant\'s pins with its package, pin count, pinout and pages; pictures make it a drawing job', () => {
    const m = PINS.messages(input);
    const user = typeof m[1]!.content === 'string' ? m[1]!.content : (m[1]!.content as { text?: string }[]).map((p) => p.text ?? '').join('\n');
    expect(user).toContain('Variant: package "SOIC-8", 8 pins, pinout A, gull-wing');
    expect(user).toContain('Part numbers: W25Q32JVSSIQ');
    expect(user).toContain('=== Page 3 ===');
    expect(PINS.roleOf!(input)).toBe('text');
    expect(PINS.roleOf!({ ...input, pictures: [{ page: 3, url: PNG }] })).toBe('vision');
    // No pin table: the pins the package implies, said in notes
    expect(JSON.stringify(PINS.messages({ ...input, pages: [] }))).toContain('no pin table for this variant');
  });
  it('takes the answer: active-low marks off the names, types in the datasheet\'s words, each number once', () => {
    const r = PINS.check({ kind: 'IC', prefix: 'u1', pages: [3, 99], notes: 'pin 7 doubles as RESET#', pins: [
      { number: '1', name: '/CS', type: 'I' }, { number: '2', name: 'DO', type: 'O' }, { number: '3', name: 'WP#', type: 'input' },
      { number: '4', name: 'GND', type: 'Ground' }, { number: '5', name: 'IO0', type: 'I/O' }, { number: '6', name: 'RESET_N', type: 'Input' },
      { number: '7', name: 'INT', type: 'Open drain' }, { number: '8', name: 'VCC', type: 'Supply' }, { number: '8', name: 'VCC', type: 'P' },
      { number: ' 9 ', name: 'NC', type: 'Do not connect' }, { number: '10', name: 'XTAL', type: 'analogue' }, { number: '11', name: '~RST', activeLow: false, type: 'tri-state' },
    ] }, input);
    expect(r.kind).toBe('ic');
    expect(r.prefix).toBe('U');
    expect(r.pages).toEqual([3]);
    expect(r.notes).toBe('pin 7 doubles as RESET#');
    expect(r.pins.map((p) => [p.number, p.name, p.activeLow, p.type])).toEqual([
      ['1', 'CS', true, 'input'], ['2', 'DO', false, 'output'], ['3', 'WP', true, 'input'], ['4', 'GND', false, 'ground'], ['5', 'IO0', false, 'io'],
      ['6', 'RESET', true, 'input'], ['7', 'INT', false, 'oc'], ['8', 'VCC', false, 'power'], ['9', 'NC', false, 'nc'], ['10', 'XTAL', false, 'passive'], ['11', 'RST', true, 'hiz']]);
    // A connector, its prefix given; an unknown kind: other, prefix U
    expect(PINS.check({ kind: 'connector', prefix: 'J', pins: [{ number: '1', name: '1', type: 'passive' }] }, input)).toMatchObject({ kind: 'connector', prefix: 'J' });
    expect(PINS.check({ kind: 'gizmo', pins: [{ number: 'A1', name: '' }] }, input)).toMatchObject({ kind: 'other', prefix: 'U', pins: [{ number: 'A1', name: 'A1', type: 'passive' }] });
    expect(() => PINS.check({ pins: [] }, input)).toThrow(/No pins were read/);
  });
  it('sides: supplies on top, grounds below, inputs left, outputs right; the rest by group to the lighter side', () => {
    expect(sidesOf(FLASH)).toEqual(['left', 'right', 'left', 'bottom', 'left', 'left', 'left', 'top', 'bottom']);
    const io: PinsRead = { ...FLASH, pins: [pin('1', 'A', 'input'), pin('2', 'B', 'input'), pin('3', 'P0', 'io', 'Port 0'), pin('4', 'P1', 'io', 'Port 0'), pin('5', 'Q0', 'io', 'Port 1')] };
    // Two inputs left: the larger I/O group right, then the other to whichever side is lighter (left: 2, right: 2 → left)
    expect(sidesOf(io)).toEqual(['left', 'left', 'right', 'right', 'left']);
    // 26.084: a bi-colour LED's anodes left, cathodes right (by name, or as described); a MOSFET's gate left, drains right, sources below
    const led: PinsRead = { ...FLASH, kind: 'diode', prefix: 'D', pins: [pin('1', 'YG_A', 'passive', 'Yellow-green'), pin('2', 'YG_K', 'passive', 'Yellow-green'), pin('3', 'R_A', 'passive', 'Red'), { ...pin('4', 'RED2', 'passive', 'Red'), description: 'Red cathode' }] };
    expect(sidesOf(led)).toEqual(['left', 'right', 'left', 'right']);
    const fet: PinsRead = { ...FLASH, kind: 'transistor', prefix: 'Q', pins: ['S', 'S', 'S', 'G', 'D', 'D', 'D', 'D'].map((n, i) => pin(String(i + 1), n, 'passive')) };
    expect(sidesOf(fet)).toEqual(['bottom', 'bottom', 'bottom', 'left', 'right', 'right', 'right', 'right']);
    // The LED drawn: each colour's anode facing its cathode
    const ledPins = pinsOf(buildSymbol(led, { name: 'LED' }).bags);
    expect(ledPins.find((p) => p.designator === '1')!.at.y).toBe(ledPins.find((p) => p.designator === '2')!.at.y);
    expect(ledPins.find((p) => p.designator === '3')!.at.y).toBe(ledPins.find((p) => p.designator === '4')!.at.y);
    // A connector: number order down the left; more than 24 pins: half on the right
    const conn = (n: number): PinsRead => ({ kind: 'connector', prefix: 'J', pages: [], notes: '', pins: Array.from({ length: n }, (_, i) => pin(String(n - i), String(n - i), 'passive')) });
    expect(new Set(sidesOf(conn(10)))).toEqual(new Set(['left']));
    const big = conn(30), s = sidesOf(big);
    expect(big.pins.filter((_, i) => s[i] === 'left').map((p) => Number(p.number)).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
  it('the symbol: pins on a 100 mil grid round its body, overbars, the designator, comment and footprint; it goes into a library and back', () => {
    const made = buildSymbol(FLASH, { name: 'W25Q32JVSSIQ', description: 'Serial flash, SOIC-8', footprint: 'SOIC127P600X175-9N' });
    expect(made).toMatchObject({ libRef: 'W25Q32JVSSIQ', description: 'Serial flash, SOIC-8', parts: 1 });
    const pins = pinsOf(made.bags);
    expect(pins).toHaveLength(9);
    const at = new Map(pins.map((p) => [p.designator, p]));
    for (const p of pins) {
      expect(p.at.x % 1_000_000).toBe(0);
      expect(p.at.y % 1_000_000).toBe(0);
      expect(p.length).toBe(3_000_000);
    }
    // Inputs out to the left (orientation 2), the output right (0), VCC up (1), the grounds down (3)
    expect(at.get('1')!.orient).toBe(2);
    expect(at.get('2')!.orient).toBe(0);
    expect(at.get('8')!.orient).toBe(1);
    expect(at.get('4')!.orient).toBe(3);
    expect(at.get('9')!.orient).toBe(3);
    expect(at.get('1')!.name).toBe(overbar('CS'));
    expect(overbar('CS')).toBe('C\\S\\');
    expect(at.get('8')!.electrical).toBe(7);
    expect(at.get('2')!.electrical).toBe(2);
    // SPI pins together, Control after a gap: CS (1) at the top of the left side, WP (3) below the SPI group
    const left = pins.filter((p) => p.orient === 2).sort((a, b) => b.at.y - a.at.y).map((p) => p.designator);
    expect(left).toEqual(['1', '5', '6', '3', '7']);
    const ys = pins.filter((p) => p.orient === 2).map((p) => p.at.y).sort((a, b) => b - a);
    expect(ys[2]! - ys[3]!).toBe(2_000_000);
    const text = (rec: number, name?: string) => made.bags.find((b) => b.int('RECORD') === rec && (!name || b.get('NAME') === name))?.get('TEXT');
    expect(text(SR.DESIGNATOR)).toBe('U?');
    expect(text(SR.PARAMETER, 'Comment')).toBe('W25Q32JVSSIQ');
    expect(made.bags.find((b) => b.int('RECORD') === SR.IMPLEMENTATION)?.get('MODELNAME')).toBe('SOIC127P600X175-9N');
    // Into a library and back
    const lib = readSchLib(writeSchLib([made]), 'AI.SchLib');
    expect(lib.symbols.map((s) => s.libRef)).toEqual(['W25Q32JVSSIQ']);
    expect(pinsOf(lib.symbols[0]!.bags).map((p) => p.designator).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    // No footprint yet: an empty implementation list; pins as long as asked (26.084: Preferences' default pin length), prefix J
    const plain = buildSymbol({ kind: 'connector', prefix: 'J', pins: [pin('1', '1', 'passive'), pin('2', '2', 'passive')] }, { name: 'Header 2', pinLength: 20 });
    expect(plain.bags.some((b) => b.int('RECORD') === SR.IMPLEMENTATION)).toBe(false);
    expect(plain.bags.some((b) => b.int('RECORD') === SR.IMPLEMENTATION_LIST)).toBe(true);
    expect(pinsOf(plain.bags).map((p) => [p.length, p.showName])).toEqual([[2_000_000, false], [2_000_000, false]]);
  });
  it('takes its pins\' length from Preferences › Schematic › Default Primitives (AD: 300mil), as Place › Pin does', () => {
    const was = settings.schPinLength;
    try {
      expect(DEFAULTS.schPinLength).toBe(300);
      settings.schPinLength = 200;
      expect(pinsOf(draftSymbol(newSymbolDraft(FLASH, 'F', '')).bags).every((p) => p.length === 2_000_000)).toBe(true);
    } finally { settings.schPinLength = was; }
    expect(PAGES.find((p) => p.id === 'sch-primitives')!.sections.flatMap((x) => x.fields).find((f) => f.key === 'schPinLength')).toMatchObject({ label: 'Length', type: { kind: 'number', unit: 'mil', step: 10 } });
  });
  it('checks the symbol against its package and footprint: pins twice, the count, pins without pads and pads without pins', () => {
    const d = newSymbolDraft(FLASH, 'W25Q32JVSSIQ', 'Serial flash', 'SOIC-8');
    const v = { pins: 8 };
    expect(symbolChecks(d, v, ['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toEqual([{ level: 'note', text: 'Every pin has its pad in the footprint, and every pad its pin' }]);
    expect(symbolChecks(d, v, ['1', '2', '3', '4', '5', '6', '7', '8'])).toEqual([{ level: 'warning', text: 'Pins with no pad in the footprint: 9' }]);
    expect(symbolChecks(d, v, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'MH1'])).toEqual([{ level: 'warning', text: 'Pads with no pin in the symbol: 10, MH1' }]);
    expect(symbolChecks(d, { pins: 14 }, null)).toEqual([{ level: 'warning', text: '9 pins read for a 14-pin package' }]);
    const twice = { ...d, name: ' ', read: { ...FLASH, notes: 'Check pin 7', pins: [...FLASH.pins, pin('8', 'VCC', 'power')] } };
    expect(symbolChecks(twice, v, null)).toEqual([
      { level: 'error', text: 'Pin numbers used twice: 8' }, { level: 'warning', text: '10 pins read for a 8-pin package' },
      { level: 'error', text: 'The symbol needs a name' }, { level: 'note', text: 'Check pin 7' }]);
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
    const answer = { kind: 'ic', prefix: 'U', pins: [{ number: '1', name: 'CS#', type: 'input' }, { number: '2', name: 'VCC', type: 'power' }], pages: [3], notes: '' };
    let calls = 0;
    const fetchFn = (async (url: string) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: MODELS }))
      : (calls++, new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 3000, completion_tokens: 400, cost: 0.002 } }))))) as typeof fetch;
    const req = (path: string, body?: object) => new Request(`https://konium.app/api/ai${path}`, body ? { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) } : { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    const now = Date.parse('2026-11-02T12:00:00Z');
    beforeEach(() => { store = new StoreLogic(sqlite()); resetModelCache(); calls = 0; });
    it('says it reads pin tables, counts each as a job, and keeps the accepted ones for the next reader', async () => {
      const cfg = await (await handle(req('/config'), env, store, fetchFn, now)).json() as { jobs: string[] };
      expect(cfg.jobs).toContain('pins');
      const r = await handle(req('/job', { job: 'pins', input }), env, store, fetchFn, now);
      expect(await r.json()).toMatchObject({ answer: { prefix: 'U', pins: [{ number: '1', name: 'CS', activeLow: true }, { number: '2', type: 'power' }] }, allowance: { counted: 'jobs', jobs: 2, left: 1 } });
      // Accepted, then asked for again by someone else: the kept answer, no model run, no job counted
      const key = `${'a'.repeat(64)}:SOIC-8-8-A`;
      // (26.200: kept with the pass the reader's own job for that datasheet gave)
      const mine = await (await handle(req('/job', { job: 'pins', input, cacheKey: key }), env, store, fetchFn, now)).json() as { accept: string };
      expect((await handle(req('/accept', { job: 'pins', cacheKey: key, answer: { ...answer, pins: [{ number: '1', name: 'CS', activeLow: true, type: 'input' }] }, pass: mine.accept }), env, store, fetchFn, now)).status).toBe(200);
      const other = new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '5.6.7.8' }, body: JSON.stringify({ job: 'pins', input, cacheKey: key }) });
      const before = calls;
      const kept = await (await handle(other, env, store, fetchFn, now)).json() as { answer: PinsRead; cached?: unknown };
      expect(kept.cached).toBeTruthy();
      expect(kept.answer.pins).toHaveLength(1);
      expect(calls).toBe(before);
    });
  });
});
