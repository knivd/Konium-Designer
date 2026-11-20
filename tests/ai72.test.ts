import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURVEY, parseJsonAnswer, variantFor, type Survey, type SurveyInput } from '../src/ai/jobs';
import { allText, hasText, openDatasheet, pageScore, pickPages } from '../src/ai/datasheet';
import { estimateCost, estimateTokens, monthUsage, runJob, testConnection, type AiSettings } from '../src/ai/client';
import { handle, resetModelCache, serviceModels, type AiEnv, ACCEPT_MS } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

/* ─── Helpers ──────────────────────────────────────────────────────────────────────── */

/** A small PDF: one page per text, each line in Helvetica. */
function pdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contents = pages.map((lines) => {
    const s = `BT /F1 10 Tf 14 TL 50 760 Td ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`;
    return add(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  const kids = contents.map((c) => add(`<< /Type /Page /Parent @P 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  const root = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${root} 0 R >>`);
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o.replace('@P', String(root))}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const SHEET = [
  ['LMV321, LMV358 Low-Voltage Rail-to-Rail Output Operational Amplifiers', 'Features: 2.7 V to 5.5 V'],
  ['Pin Configuration and Functions', 'D Package 8-Pin SOIC Top View', 'DGK Package 8-Pin VSSOP'],
  ['Electrical characteristics', 'Supply current 130 uA'],
  ['Ordering Information', 'LMV358DR SOIC (D) 8 pins', 'LMV358DGKR VSSOP (DGK) 8 pins'],
  ['Package Outline D0008A SOIC 4.9 x 3.9 mm', 'Dimensions in millimetres'],
  ['Example Board Layout D0008A', 'Land pattern example'],
];

const answer: Survey = {
  maker: 'Texas Instruments', device: 'LMV358', description: 'Dual op-amp',
  variants: [
    { partNumbers: ['LMV358DR', 'LMV358D'], package: 'SOIC (D)', pins: 8, leadForm: 'gull-wing', body: { length: 4.9, width: 3.9, height: 1.75 }, pitch: 1.27, thermalPad: false, pinout: 'A', drawingPages: [5], landPatternPages: [6], pinTablePages: [2], orderingPage: 4 },
    { partNumbers: ['LMV358DGKR'], package: 'VSSOP (DGK)', pins: 8, leadForm: 'gull-wing', body: { length: 3, width: 3, height: 1.1 }, pitch: 0.65, thermalPad: false, pinout: 'A', drawingPages: [], landPatternPages: [], pinTablePages: [2], orderingPage: 4 },
  ],
};
const input: SurveyInput = { pages: SHEET.map((l, i) => ({ page: i + 1, text: l.join('\n') })), pageCount: 6, partNumber: 'LMV358DGKR' };

/** Browser storage for the key and the month's usage. */
function storage(): Map<string, string> {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  return m;
}
const cfg = (o: Partial<AiSettings>): AiSettings => ({ aiMode: 'key', aiProvider: 'openrouter', aiCustomBase: '', aiLocalBase: 'http://localhost:11434/v1', aiModels: {}, aiShareCache: true, ...o });
const completion = (content: string, usage = { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0007 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

afterEach(() => { vi.unstubAllGlobals(); });

/* ─── Jobs ─────────────────────────────────────────────────────────────────────────── */

describe('AI jobs: what is asked and how answers are checked', () => {
  it('reads JSON wrapped in prose or code fences', () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here you are:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonAnswer('The answer is {"a":3}. Done.')).toEqual({ a: 3 });
    expect(() => parseJsonAnswer('no idea')).toThrow(/isn't JSON/);
  });
  it('the survey asks with page markers and the part number, and cleans the answer', () => {
    const m = SURVEY.messages(input);
    expect(m[0]!.role).toBe('system');
    expect(String(m[1]!.content)).toMatch(/=== Page 4 ===\nOrdering Information/);
    // The part number stays in Konium: told it, a model lists that variant alone
    expect(String(m[1]!.content)).not.toMatch(/LMV358DGKR\./);
    const v = SURVEY.check({
      ...answer,
      variants: [
        { ...answer.variants[0], pins: '8', pitch: '1,27', leadForm: 'Gull wing', drawingPages: [5, 5, 99, 0], orderingPage: '4', body: { length: '4.9', width: null, height: -1 } },
        { package: '', pins: 8 },
        { package: 'X', pins: 0 },
      ],
    }, input);
    // A variant without a package name or a pin count stays (the drawing tells): only one with nothing to know it by goes
    expect(v.variants).toHaveLength(3);
    expect(v.variants[1]).toMatchObject({ package: answer.device, pins: 8 });
    expect(v.variants[2]).toMatchObject({ package: 'X', pins: 0 });
    expect(v.variants[0]).toMatchObject({ pins: 8, pitch: 1.27, leadForm: 'gull-wing', drawingPages: [5], orderingPage: 4, body: { length: 4.9, width: null, height: null } });
    expect(() => SURVEY.check({ variants: [] }, input)).toThrow(/No package/);
  });
  it('the part number given picks its own variant', () => {
    expect(variantFor(answer, 'LMV358DGKR')).toBe(1);
    expect(variantFor(answer, 'lmv358-dr')).toBe(0);
    expect(variantFor(answer, 'LM7805')).toBe(-1);
  });
});

/* ─── Datasheets ───────────────────────────────────────────────────────────────────── */

describe('datasheets', () => {
  it('a PDF read in the browser: its pages, their text, its fingerprint', async () => {
    const d = await openDatasheet(pdf(SHEET), 'lmv358.pdf');
    expect(d.pageCount).toBe(6);
    expect(d.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const pages = await allText(d);
    expect(pages[3]!.text).toContain('LMV358DGKR VSSOP (DGK) 8 pins');
    expect(hasText(pages)).toBe(true);
    expect(hasText([{ page: 1, text: '' }, { page: 2, text: ' ' }])).toBe(false);
    d.close();
    await expect(openDatasheet(new TextEncoder().encode('not a pdf'), 'x.pdf')).rejects.toThrow(/isn't a PDF/);
  }, 60_000);
  it('when a model can\'t take every page: the first two and the ordering, package, land pattern and pin pages', () => {
    const filler = 'x'.repeat(5000);
    const pages = [...SHEET.map((l, i) => ({ page: i + 1, text: `${l.join('\n')} ${filler}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ page: 7 + i, text: `Typical characteristics ${filler}` }))];
    expect(pickPages(pages, 1e9)).toHaveLength(26);
    const few = pickPages(pages, 26_000).map((p) => p.page);
    expect(few).toEqual([1, 2, 4, 5, 6]);
    expect(pageScore('Ordering Information')).toBeGreaterThan(pageScore('Typical characteristics'));
  });
});

/* ─── Connections ──────────────────────────────────────────────────────────────────── */

describe('AI connections', () => {
  beforeEach(() => { storage(); });
  it('your own key: OpenRouter with the key, asking for JSON and what it cost; the answer checked, the month counted', async () => {
    localStorage.setItem('konium.aiKey', 'sk-or-test');
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { sent.push({ url, init }); return completion(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``); });
    const r = await runJob(SURVEY, input, { cfg: cfg({ aiModels: { 'key:text': 'google/gemini-x-flash-lite' } }) });
    expect(r.value.variants).toHaveLength(2);
    expect(r.usage).toEqual({ in: 1200, out: 300, cost: 0.0007 });
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const h = sent[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk-or-test');
    expect(h['HTTP-Referer']).toBe('https://konium.app');
    const body = JSON.parse(String(sent[0]!.init.body));
    expect(body).toMatchObject({ model: 'google/gemini-x-flash-lite', max_tokens: SURVEY.maxTokens, response_format: { type: 'json_object' }, usage: { include: true } });
    expect(monthUsage()).toMatchObject({ jobs: 1, in: 1200, out: 300, cost: 0.0007 });
  });
  it('a local model: no key; a server that refuses response_format is asked again without it', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:1234/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      const b = JSON.parse(String(init.body)); bodies.push(b);
      return b.response_format ? new Response('{"error":"response_format json_object is not supported"}', { status: 400 }) : completion(JSON.stringify(answer), { prompt_tokens: 10, completion_tokens: 5 } as never);
    });
    const r = await runJob(SURVEY, input, { cfg: cfg({ aiMode: 'local', aiLocalBase: 'http://localhost:1234/v1/', aiModels: { 'local:vision': 'qwen2.5-vl-7b' } }) });
    expect(bodies.map((b) => b.model)).toEqual(['qwen2.5-vl-7b', 'qwen2.5-vl-7b']);
    expect(r.usage.cost).toBe(0);
  });
  it('failures say what to check', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(runJob(SURVEY, input, { cfg: cfg({ aiMode: 'local', aiModels: { 'local:text': 'm' } }) })).rejects.toThrow(/OLLAMA_ORIGINS/);
    localStorage.setItem('konium.aiKey', 'bad');
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 }));
    await expect(runJob(SURVEY, input, { cfg: cfg({ aiModels: { 'key:text': 'm' } }) })).rejects.toThrow(/key was refused \(401\): No auth credentials found/);
    await expect(runJob(SURVEY, input, { cfg: cfg({}) })).rejects.toThrow(/Choose a model/);
    await expect(runJob(SURVEY, input, { cfg: cfg({ aiMode: 'off' }) })).rejects.toThrow(/AI is off/);
  });
  it('the Konium service: the job posted with the datasheet\'s fingerprint for the shared cache; its answer checked again here', async () => {
    let posted: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('https://konium.app/api/ai/job');
      posted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ answer, cached: { acceptedBy: 3 }, usage: { in: 0, out: 0, cost: 0 } }));
    });
    const r = await runJob(SURVEY, input, { cfg: cfg({ aiMode: 'konium' }), cacheKey: 'f'.repeat(64) });
    expect(posted).toMatchObject({ job: 'survey', cacheKey: 'f'.repeat(64), fresh: false });
    expect(r.cached).toEqual({ acceptedBy: 3 });
    // Sharing off: no fingerprint goes
    await runJob(SURVEY, input, { cfg: cfg({ aiMode: 'konium', aiShareCache: false }), cacheKey: 'f'.repeat(64) });
    expect(posted.cacheKey).toBeUndefined();
  });
  it('the connection test, and estimates before sending', async () => {
    vi.stubGlobal('fetch', async () => completion('{"ok": true}'));
    localStorage.setItem('konium.aiKey', 'k');
    expect(await testConnection('key', cfg({ aiModels: { 'key:text': 'deepseek/x' } }))).toMatch(/^deepseek\/x answered in/);
    const t = estimateTokens(SURVEY.messages(input));
    expect(t).toBeGreaterThan(100);
    expect(estimateCost(10_000, 4000, { id: 'm', name: 'm', vision: true, priceIn: 0.25, priceOut: 1.5 })).toBeCloseTo(0.0025 + 0.003, 6);
    expect(estimateCost(10_000, 4000, { id: 'm', name: 'm', vision: null })).toBeNull();
  });
});

/* ─── The Konium service (Worker) ──────────────────────────────────────────────────── */

function sqlite(): Sql {
  // Node's own SQLite, as a Durable Object's: a statement runs when given
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

const MODELS = [
  { id: 'google/gemini-3.1-flash-lite', name: 'Google: Gemini 3.1 Flash Lite', created: 300, pricing: { prompt: '0.00000025', completion: '0.0000015' }, architecture: { input_modalities: ['text', 'image', 'file'] } },
  { id: 'google/gemini-2.5-flash-lite', name: 'Google: Gemini 2.5 Flash Lite', created: 100, pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', created: 200, pricing: { prompt: '0.000000028', completion: '0.00000012' }, architecture: { input_modalities: ['text'] } },
  { id: 'deepseek/deepseek-v4.1-flash:batch', name: 'DeepSeek: V4.1 Flash (batch)', created: 210, pricing: { prompt: '0.00000002', completion: '0.0000001' }, architecture: { input_modalities: ['text'] } },
  { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: V4.1 Flash 1017', created: 220, pricing: { prompt: '0.00000015', completion: '0.0000006' }, architecture: { input_modalities: ['text'] } },
  { id: 'google/gemini-3.6-flash', name: 'Google: Gemini 3.6 Flash', created: 250, pricing: { prompt: '0.00000075', completion: '0.00000375' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'google/gemini-3.1-pro', name: 'Google: Gemini 3.1 Pro', created: 260, pricing: { prompt: '0.000002', completion: '0.000012' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', created: 240, pricing: { prompt: '0.000005', completion: '0.000025' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', created: 350, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: 'openai/gpt-6.1-astra-pro', name: 'OpenAI: GPT-6.1 Astra Pro', created: 360, pricing: { prompt: '0.00003', completion: '0.00018' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', created: 370, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: '~google/gemini-pro-latest', name: 'Google: Gemini Pro Latest', created: 380, pricing: { prompt: '0.000002', completion: '0.000012' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek: DeepSeek Flash Latest', created: 390, pricing: { prompt: '0.00000004', completion: '0.0000003' }, architecture: { input_modalities: ['text'] } },
  { id: '~openai/gpt-astra-pro-latest', name: 'OpenAI: GPT Astra Pro Latest', created: 395, pricing: { prompt: '0.00003', completion: '0.00018' }, architecture: { input_modalities: ['text', 'image'] } },
];

describe('the Konium AI service', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '2', DAILY_BUDGET_USD: '1' };
  let store: StoreLogic;
  let chats: Record<string, unknown>[];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
    chats.push(JSON.parse(String(init!.body)));
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-service');
    return completion(JSON.stringify(answer), { prompt_tokens: 40_000, completion_tokens: 2_000, cost: 0.013 });
  }) as typeof fetch;
  const post = (path: string, body: object, ip = '1.2.3.4') => new Request(`https://konium.app/api/ai${path}`, { method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const now = Date.parse('2026-10-30T12:00:00Z');
  beforeEach(() => { store = new StoreLogic(sqlite()); chats = []; resetModelCache(); });

  it('offers OpenRouter\'s "latest" aliases that take pictures, under the price ceiling, the cheapest first (26.083)', async () => {
    const models = await serviceModels(env, fetchFn, now);
    expect(models.map((m) => [m.id, m.roles.join('+')])).toEqual([['~google/gemini-pro-latest', 'text+vision'], ['~anthropic/claude-opus-latest', 'text+vision']]);
    resetModelCache();
    const named = await serviceModels({ ...env, MODELS: '[{"id":"google/gemini-2.5-flash-lite","label":"Cheapest","roles":["text","vision"]},{"id":"gone/model"}]' }, fetchFn, now);
    expect(named.map((m) => [m.id, m.name])).toEqual([['google/gemini-2.5-flash-lite', 'Cheapest']]);
    const res = await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env, store, fetchFn, now);
    const c = await res.json() as { defaults: Record<string, string>; allowance: { jobs: number; left: number } };
    // One model for every job: the first of the list
    expect(c.defaults).toEqual({ model: '~google/gemini-pro-latest', text: '~google/gemini-pro-latest', vision: '~google/gemini-pro-latest' });
    expect(c.allowance).toEqual({ jobs: 2, left: 2, weighed: true });
  });
  it('runs only Konium\'s jobs, with its own messages; counts the allowance and the day\'s spend', async () => {
    const r1 = await handle(post('/job', { job: 'survey', input, model: 'google/gemini-3.1-pro' }), env, store, fetchFn, now);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { answer: Survey; allowance: { left: number }; model: string };
    // A version asked for (a choice from before 26.080): its family's alias
    expect(b1.model).toBe('~google/gemini-pro-latest');
    expect(b1.answer.variants).toHaveLength(2);
    expect(b1.allowance.left).toBe(1);
    expect(chats[0]).toMatchObject({ max_tokens: SURVEY.maxTokens, provider: { data_collection: 'deny' }, messages: SURVEY.messages(input) });
    expect(store.spent('2026-10-30')).toBeCloseTo(0.013);
    // A model it doesn't offer: the default instead
    await handle(post('/job', { job: 'survey', input, model: 'openai/gpt-9-ultra' }), env, store, fetchFn, now);
    expect(chats[1]!.model).toBe('~google/gemini-pro-latest');
    // The allowance used up; another address still has its own
    const r3 = await handle(post('/job', { job: 'survey', input }), env, store, fetchFn, now);
    expect(r3.status).toBe(429);
    expect((await r3.json() as { error: string }).error).toMatch(/job tokens are used up \(2 a day\).*own key or a local model/);
    expect((await handle(post('/job', { job: 'survey', input }, '5.6.7.8'), env, store, fetchFn, now)).status).toBe(200);
    // Free chat isn't a job
    expect((await handle(post('/job', { job: 'chat', input: { text: 'write me a poem' } }), env, store, fetchFn, now)).status).toBe(400);
  });
  it('stops at the day\'s budget, and without a key', async () => {
    store.spend('2026-10-30', 1.2);
    const r = await handle(post('/job', { job: 'survey', input }), env, store, fetchFn, now);
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toMatch(/today's budget/);
    expect((await handle(post('/job', { job: 'survey', input }), {}, store, fetchFn, now)).status).toBe(503);
    expect(chats).toHaveLength(0);
  });
  it('the shared cache: an accepted answer served to the next reader without a model or the allowance; most accepts win', async () => {
    const key = 'a'.repeat(64);
    const accept = (body: object, ip?: string, at = now) => handle(post('/accept', { job: 'survey', cacheKey: key, ...body }, ip), env, store, fetchFn, at);
    // (26.200) Nothing is kept that didn't come of a job the service did for this user and this datasheet
    expect((await accept({ answer })).status).toBe(403);
    const first = await (await handle(post('/job', { job: 'survey', input, cacheKey: key }), env, store, fetchFn, now)).json() as { accept: string };
    expect(first.accept).toMatch(/^\d+\.j\.[0-9a-f]{64}$/);
    expect(chats).toHaveLength(1);
    chats.length = 0;
    // The pass is this user's, for this datasheet, for a day
    expect((await accept({ answer, pass: first.accept }, '8.8.8.8')).status).toBe(403);
    expect((await handle(post('/accept', { job: 'survey', cacheKey: 'b'.repeat(64), answer, pass: first.accept }), env, store, fetchFn, now)).status).toBe(403);
    expect((await accept({ answer, pass: first.accept }, undefined, now + ACCEPT_MS + 1)).status).toBe(403);
    expect((await accept({ answer, pass: first.accept.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status).toBe(403);
    expect((await accept({ answer, pass: first.accept })).status).toBe(200);
    const r = await handle(post('/job', { job: 'survey', input, cacheKey: key }, '9.9.9.9'), env, store, fetchFn, now);
    const b = await r.json() as { answer: Survey; cached: { acceptedBy: number }; accept: string };
    expect(b.cached).toEqual({ acceptedBy: 1 });
    expect(b.answer.device).toBe('LMV358');
    expect(chats).toHaveLength(0);
    expect(store.left('2026-10-30', 'x', 'jobs', 2)).toBe(2);
    // Whoever was given the kept answer may stand by it as it is, and by nothing else
    const other = { ...answer, device: 'WRONG' };
    expect(b.accept).toMatch(/^\d+\.h[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect((await accept({ answer: other, pass: b.accept }, '9.9.9.9')).status).toBe(403);
    expect((await accept({ answer: b.answer, pass: b.accept }, '9.9.9.9')).status).toBe(200);
    // One user's different answer (of a job of their own) doesn't beat two users' agreement
    const third = await (await handle(post('/job', { job: 'survey', input, cacheKey: key, fresh: true }, '3.3.3.3'), env, store, fetchFn, now)).json() as { accept: string };
    expect((await accept({ answer: other, pass: third.accept }, '3.3.3.3')).status).toBe(200);
    expect((store.cached(`survey@${SURVEY.version}:${key}`)!.answer as Survey).device).toBe('LMV358');
    expect(store.cached(`survey@${SURVEY.version}:${key}`)!.acceptedBy).toBe(2);
    // Read again: the model is asked
    chats.length = 0;
    await handle(post('/job', { job: 'survey', input, cacheKey: key, fresh: true }, '4.4.4.4'), env, store, fetchFn, now);
    expect(chats).toHaveLength(1);
    // Nonsense isn't kept
    expect((await accept({ answer: { variants: [] }, pass: first.accept })).status).toBe(400);
    expect((await handle(post('/accept', { job: 'survey', cacheKey: 'not-a-hash', answer, pass: first.accept }), env, store, fetchFn, now)).status).toBe(400);
  });
});
