import { beforeEach, describe, expect, it } from 'vitest';
import { ASK, FIND, PART, citations, withSources, type PartInput } from '../src/ai/jobs';
import { aroundOf, datasheetUrlOf, designDigest, mpnOf, wantsDatasheet } from '../src/ai/advise';
import { matchFile, pagesForCheck } from '../src/ai/partSheets';
import { demoFiles } from '../src/formats/synthetic/demo';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: readSchDoc(f.bytes, f.name) }));
const digest = designDigest('Demo', sheets, compileProject(sheets));
const info = (designator: string, value: string, params: Record<string, string> = {}, libRef = '', electrical = 0) =>
  ({ designator, value, libRef, footprint: '', description: '', params, pins: [{ number: '1', name: 'X', electrical, net: null }], block: '' });

describe('AI adviser in depth: datasheets (26.086)', () => {
  it('which parts want their datasheets, their part numbers and the addresses their parameters give', () => {
    expect(wantsDatasheet(digest.list.find((p) => p.designator === 'U1')!)).toBe(true);
    expect(wantsDatasheet(digest.list.find((p) => p.designator === 'R1')!)).toBe(false);
    expect(wantsDatasheet(digest.list.find((p) => p.designator === 'J1')!)).toBe(false);
    expect(wantsDatasheet(info('J3', 'USB-C', { 'Manufacturer Part Number': 'GCT USB4105-GF-A' }))).toBe(true);
    expect(wantsDatasheet(info('Y1', '16MHz', {}, '', 4))).toBe(true);
    expect(mpnOf(info('U1', 'LDO 3V3', { 'Manufacturer Part Number': 'TPS7A0233PDBVR' }))).toBe('TPS7A0233PDBVR');
    expect(mpnOf(info('U2', 'ATmega328P-AU'))).toBe('ATmega328P-AU');
    expect(mpnOf(info('U3', '3.3V regulator', {}, 'LDO SOT-223'))).toBe('');
    expect(mpnOf(info('U4', '=Value', { MPN: '*' }, 'MCP2551-I/SN'))).toBe('MCP2551-I/SN');
    expect(datasheetUrlOf(info('U1', '', { ComponentLink1URL: 'https://www.ti.com/product/TPS7A02', Datasheet: 'https://www.ti.com/lit/ds/symlink/tps7a02.pdf' }))).toBe('https://www.ti.com/lit/ds/symlink/tps7a02.pdf');
    expect(datasheetUrlOf(info('U1', '', { HelpURL: 'https://example.com/part' }))).toBe('https://example.com/part');
    expect(datasheetUrlOf(info('U1', '', { Notes: 'see the datasheet' }))).toBe('');
    // What is round U1: its nets and the other pins on them, with their values
    expect(aroundOf(digest.list.find((p) => p.designator === 'U1')!, digest).split('\n')).toEqual([
      'GND: C1-2 (10µF); C2-2 (22µF); D1-K (Green); J1-2 GND (Power in)', '+3V3: C2-1 (22µF); R1-1 (1k)', 'VIN: C1-1 (10µF); J1-1 VIN (Power in)']);
  });
  it('a datasheet given as a file is matched to the part it names; a family matches its packing variants', () => {
    expect(matchFile('tps7a02.pdf', 'TPS7A02 nA-IQ 200-mA LDO', ['ATMEGA328P-AU', 'TPS7A0233PDBVR'])).toBe('TPS7A0233PDBVR');
    expect(matchFile('ATmega328P_Datasheet.pdf', '', ['ATMEGA328P-AU', 'TPS7A0233PDBVR'])).toBe('ATMEGA328P-AU');
    expect(matchFile('scan.pdf', 'Something else', ['ATMEGA328P-AU'])).toBeNull();
    expect(matchFile('stm32f103rb.pdf', '', ['STM32F103C8T6', 'STM32F103RBT6'])).toBe('STM32F103RBT6');
  });
  it('picks the pages a part\'s check needs within its budget: the first page, pins, ratings, the application circuit', () => {
    const pages = [
      { page: 1, text: 'TPS7A02 200-mA LDO. Features …' }, { page: 2, text: 'Table of contents' }, { page: 3, text: 'Pin Configuration and Functions. IN, OUT, EN, GND' },
      { page: 4, text: 'Absolute Maximum Ratings: IN −0.3 to 6.5 V. Recommended Operating Conditions: 1.5 to 6 V' }, { page: 5, text: 'Electrical Characteristics' + ' x'.repeat(4000) },
      { page: 12, text: 'Typical Application. Input capacitor 1 µF, output capacitor 1 µF' }, { page: 20, text: 'Layout Guidelines: place the capacitors close' },
      { page: 30, text: 'Package Outline, Tape and Reel' }, { page: 31, text: 'IMPORTANT NOTICE' },
    ];
    const got = pagesForCheck(pages, 9000);
    expect(got.pages.map((p) => p.page)).toEqual([1, 3, 4, 5, 12, 20]);
    expect(got.circuit).toEqual([12]);
    expect(got.pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(9000);
    // Short of room: the ratings and the application circuit before the rest
    expect(pagesForCheck(pages, 200).pages.map((p) => p.page)).toEqual([1, 4, 12]);
  });
  it('finding a datasheet: a web search, addresses a PDF first, those the search found too', () => {
    const m = FIND.messages({ mpn: 'TPS7A0233PDBVR', maker: 'Texas Instruments', description: 'LDO' });
    expect(FIND.web).toBe(5);
    expect(m[1]!.content).toBe('TPS7A0233PDBVR datasheet Texas Instruments (LDO)');
    expect(FIND.check({ url: '', page: 'https://www.ti.com/product/TPS7A02', maker: 'TI', sources: ['https://www.ti.com/lit/ds/symlink/tps7a02.pdf', 'javascript:alert(1)'] }, FIND.blank))
      .toEqual({ urls: ['https://www.ti.com/lit/ds/symlink/tps7a02.pdf', 'https://www.ti.com/product/TPS7A02'], maker: 'TI', title: '' });
    expect(() => FIND.check({ url: 'none' }, FIND.blank)).toThrow(/No datasheet was found/);
    // The pages a search's answer cites, with the answer
    expect(citations([{ type: 'url_citation', url_citation: { url: 'https://a.example/x.pdf' } }, { url_citation: { url: 'ftp://b' } }, {}])).toEqual(['https://a.example/x.pdf']);
    expect(withSources('{"url": ""}', ['https://a.example/x.pdf'])).toEqual({ url: '', sources: ['https://a.example/x.pdf'] });
    expect(withSources('No luck.', ['https://a.example/x.pdf'])).toEqual({ sources: ['https://a.example/x.pdf'] });
    expect(() => withSources('No luck.', [])).toThrow();
  });
  it('a part checked against its datasheet: the part, its nets, the pages and pictures; facts, findings with their pages', () => {
    const input: PartInput = { part: 'U1: TPS7A02 …', around: 'VIN: C1-1 (10µF)', datasheet: { source: 'https://www.ti.com/lit/ds/symlink/tps7a02.pdf', pageCount: 40, pages: [{ page: 3, text: 'Pin functions' }] }, pictures: [{ page: 12, url: 'data:image/jpeg;base64,AA', label: 'the datasheet\'s application circuit' }], focus: '' };
    const m = PART.messages(input);
    const text = (m[1]!.content as { type: string; text?: string }[]).map((x) => x.text ?? '').join('\n');
    expect(text).toContain('Its datasheet (https://www.ti.com/lit/ds/symlink/tps7a02.pdf, 40 pages; these pages picked):\n=== Page 3 ===\nPin functions');
    expect(text).toContain('On its nets:\nVIN: C1-1 (10µF)');
    expect(PART.roleOf!(input)).toBe('vision');
    expect(PART.check({ facts: 'VIN 1.5–6 V', findings: [{ severity: 'warning', title: 'EN floating', parts: ['U1'], pages: [15, 99, 'x'] }] }, input))
      .toEqual({ facts: 'VIN 1.5–6 V', findings: [{ severity: 'warning', title: 'EN floating', detail: '', fix: '', parts: ['U1'], nets: [], pages: [15] }] });
    expect(() => PART.check({}, input)).toThrow(/No check came back/);
  });
  it('a question: the design, what the datasheets say, the review and what was asked before', () => {
    const m = ASK.messages({ design: 'Design "X"', facts: 'U1: VIN 1.5–6 V', review: '1. [Warning] EN floating', history: [{ q: 'Why?', a: 'Because.' }], question: 'What value for C3?' });
    expect(m[1]!.content).toBe('Design "X"\n\nWhat the parts\' datasheets say:\nU1: VIN 1.5–6 V\n\nYour review:\n1. [Warning] EN floating\n\nAsked before:\nQ: Why?\nA: Because.\n\nThe question: What value for C3?');
    expect(ASK.check({ answer: '1 µF X7R.', parts: ['C3'] }, ASK.blank)).toEqual({ answer: '1 µF X7R.', parts: ['C3'], nets: [] });
    expect(() => ASK.check({ answer: '' }, ASK.blank)).toThrow(/No answer came back/);
  });

  describe('the service', () => {
    const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '1', DAILY_BUDGET_USD: '1' };
    const MODELS = [{ id: '~google/gemini-flash-latest', name: 'Gemini Flash', created: 200, pricing: { prompt: '0.0000005', completion: '0.000003' }, architecture: { input_modalities: ['text', 'image'] } }];
    const sqlite = (): Sql => {
      const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
        { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
      const db = new DatabaseSync(':memory:');
      return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
    };
    let store: StoreLogic;
    let asked: Record<string, unknown> | null = null;
    const PDF = new TextEncoder().encode('%PDF-1.4\n…');
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
      if (url.includes('openrouter.ai')) {
        asked = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"url": "", "page": "https://maker.example/p/TPS7A02"}', annotations: [{ type: 'url_citation', url_citation: { url: 'https://maker.example/ds/tps7a02.pdf' } }] } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.008 } }));
      }
      if (url === 'https://maker.example/ds/tps7a02.pdf') return new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } });
      if (url === 'https://maker.example/p/TPS7A02') return new Response('<html><a href="/other.pdf">x</a> <a href="/ds/tps7a02.pdf">Datasheet</a></html>', { headers: { 'Content-Type': 'text/html' } });
      if (url === 'https://maker.example/other.pdf') return new Response('<html>not one</html>');
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const req = (path: string, body?: object, ip = '1.2.3.4') => new Request(`https://konium.app/api/ai${path}`, body ? { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify(body) } : { headers: { 'CF-Connecting-IP': ip } });
    const now = Date.parse('2026-11-02T12:00:00Z');
    beforeEach(() => { store = new StoreLogic(sqlite()); resetModelCache(); asked = null; });
    it('finds a datasheet with a web search, the pages it cites with the answer; details have five times the jobs\' allowance', async () => {
      const r = await handle(req('/job', { job: 'datasheet', input: { mpn: 'TPS7A0233PDBVR', maker: '', description: 'LDO' } }), env, store, fetchFn, now);
      const j = await r.json() as { answer: unknown; sources: string[]; allowance: unknown };
      expect(asked).toMatchObject({ plugins: [{ id: 'web', max_results: 5 }] });
      expect(j).toMatchObject({ answer: { urls: ['https://maker.example/ds/tps7a02.pdf', 'https://maker.example/p/TPS7A02'] }, sources: ['https://maker.example/ds/tps7a02.pdf'], allowance: { counted: 'detail', jobs: 5, left: 4 } });
      // A part's check is a detail too, and doesn't search
      const part = await handle(req('/job', { job: 'part', input: { ...PART.blank, part: 'U1', datasheet: { source: 'x', pageCount: 3, pages: [{ page: 1, text: 'p' }] } } }), env, store, fetchFn, now);
      expect(asked).not.toHaveProperty('plugins');
      expect(part.status).toBe(200);
    });
    it('fetches a datasheet for the app: a PDF as it is, a product page\'s best PDF one step on, nothing else', async () => {
      const pdf = await handle(req('/fetch?url=' + encodeURIComponent('https://maker.example/ds/tps7a02.pdf')), env, store, fetchFn, now);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
      expect(pdf.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(PDF);
      const page = await handle(req(`/fetch?mpn=TPS7A0233PDBVR&url=${encodeURIComponent('https://maker.example/p/TPS7A02')}`), env, store, fetchFn, now);
      expect(page.status).toBe(200);
      expect(page.headers.get('X-Source-Url')).toBe('https://maker.example/ds/tps7a02.pdf');
      expect((await handle(req('/fetch?url=' + encodeURIComponent('https://maker.example/other.pdf')), env, store, fetchFn, now)).status).toBe(415);
      expect((await handle(req('/fetch?url=' + encodeURIComponent('http://192.168.1.1/x.pdf')), env, store, fetchFn, now)).status).toBe(400);
      expect((await handle(req('/fetch?url=' + encodeURIComponent('file:///etc/passwd')), env, store, fetchFn, now)).status).toBe(400);
      expect((await handle(req('/fetch?url=' + encodeURIComponent('https://maker.example/gone.pdf')), env, store, fetchFn, now)).status).toBe(502);
      // A hundred a day each
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('s|9.9.9.9')));
      const client = [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
      for (let i = 0; i < 100; i++) store.take('2026-11-02', client, 'fetch', 100);
      expect((await handle(req('/fetch?url=' + encodeURIComponent('https://maker.example/ds/tps7a02.pdf'), undefined, '9.9.9.9'), env, store, fetchFn, now)).status).toBe(429);
    });
  });
});
