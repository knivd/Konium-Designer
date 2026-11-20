import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQS, PACKAGE } from '../src/ai/jobs';
import { CHEAP_MODEL, familyOf } from '../src/ai/models';
import { runJob, type AiSettings } from '../src/ai/client';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

/** An in-memory SQLite stand-in, as the other service tests use. */
function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

const SPEC = { text: 'The board shall run from 5 V.', title: '' };
const ANSWER = JSON.stringify({ requirements: [{ title: 'Supply', text: 'The board shall run from 5 V.', type: 'electrical', priority: 'must', method: 'test' }] });
const model = (id: string, prompt: string, completion: string, image = false) => ({ id, name: id, created: 1, pricing: { prompt, completion }, architecture: { input_modalities: image ? ['text', 'image'] : ['text'] } });
const OFFERED = [model('~google/gemini-flash-latest', '0.00000075', '0.00000375', true), model('~anthropic/claude-opus-latest', '0.000005', '0.000025', true)];

describe('the requirements split on a cheap text model (26.142)', () => {
  it('the cheap model is Qwen Flash, followed by its family (not the omni ones)', () => {
    expect(CHEAP_MODEL).toBe('qwen/qwen3.8-flash');
    expect(familyOf('qwen/qwen3.9-flash')).toBe(familyOf(CHEAP_MODEL));
    expect(familyOf('qwen/qwen3.9-omni-flash')).not.toBe(familyOf(CHEAP_MODEL));
    expect(REQS.cheap).toBe(true);
    expect(PACKAGE.cheap).toBeFalsy();
  });
});

describe('the Konium service: a cheap job', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '25', DAILY_BUDGET_USD: '1', DEFAULT_MODEL: '~google/gemini-flash-latest' };
  let list: ReturnType<typeof model>[];
  let chats: string[];
  let failCheap = false;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: list }));
    const m = JSON.parse(String(init!.body)).model as string;
    chats.push(m);
    if (failCheap && m.startsWith('qwen/')) return new Response('{"error":{"message":"No endpoints found matching your data policy"}}', { status: 404 });
    return new Response(JSON.stringify({ choices: [{ message: { content: ANSWER } }], usage: { prompt_tokens: 40000, completion_tokens: 9000, cost: 0.01 } }));
  }) as typeof fetch;
  const post = (body: object) => new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
  const now = Date.parse('2026-11-08T12:00:00Z');
  let store: StoreLogic;
  beforeEach(() => {
    store = new StoreLogic(sqlite()); chats = []; failCheap = false; resetModelCache();
    list = [...OFFERED, model('qwen/qwen3.8-flash', '0.00000015', '0.00000047'), model('qwen/qwen3.8-omni-flash', '0.00000015', '0.00000047', true), model('qwen/qwen3.7-flash', '0.00000003', '0.00000013', true)];
  });

  it('runs on Qwen Flash whatever model is asked for, for one job token; the service says so', async () => {
    const r = await handle(post({ job: 'reqs', input: SPEC, model: '~anthropic/claude-opus-latest' }), env, store, fetchFn, now);
    expect(r.status).toBe(200);
    expect(chats).toEqual(['qwen/qwen3.8-flash']);
    const j = await r.json() as { model: string; allowance: { used: number }; answer: { requirements: unknown[] } };
    expect(j.model).toBe('qwen/qwen3.8-flash');
    expect(j.allowance.used).toBe(1);
    expect(j.answer.requirements).toHaveLength(1);
    const c = await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env, store, fetchFn, now)).json() as { cheap: { id: string; weight: number }; cheapJobs: string[] };
    expect(c.cheap).toMatchObject({ id: 'qwen/qwen3.8-flash', weight: 1 });
    expect(c.cheapJobs).toEqual(['reqs']);
  });
  it('a footprint\'s job stays on the model chosen', async () => {
    await handle(post({ job: 'ping', input: {}, model: '~anthropic/claude-opus-latest' }), env, store, fetchFn, now);
    expect(chats).toEqual(['~anthropic/claude-opus-latest']);
  });
  it('Qwen Flash retired: its family\'s newest; none of its family: the model chosen', async () => {
    list = [...OFFERED, model('qwen/qwen3.9-flash', '0.0000002', '0.0000006'), model('qwen/qwen3.9-omni-flash', '0.0000002', '0.0000006', true)];
    await handle(post({ job: 'reqs', input: SPEC }), env, store, fetchFn, now);
    expect(chats).toEqual(['qwen/qwen3.9-flash']);
    resetModelCache(); chats = [];
    list = [...OFFERED];
    await handle(post({ job: 'reqs', input: SPEC }), env, store, fetchFn, now);
    expect(chats).toEqual(['~google/gemini-flash-latest']);
  });
  it('Qwen Flash failing (no endpoint for the data policy): the job done on the model chosen', async () => {
    failCheap = true;
    const r = await handle(post({ job: 'reqs', input: SPEC, model: '~anthropic/claude-opus-latest' }), env, store, fetchFn, now);
    expect(r.status).toBe(200);
    expect(chats).toEqual(['qwen/qwen3.8-flash', '~anthropic/claude-opus-latest']);
    expect((await r.json() as { model: string }).model).toBe('~anthropic/claude-opus-latest');
  });
});

describe('your own OpenRouter key: a cheap job', () => {
  const keys = new Map<string, string>();
  let asked: string[];
  let gone = new Set<string>();
  let failing = new Set<string>();
  beforeEach(() => {
    asked = []; gone = new Set(); failing = new Set();
    vi.stubGlobal('localStorage', { getItem: (k: string) => keys.get(k) ?? null, setItem: (k: string, v: string) => void keys.set(k, v), removeItem: (k: string) => void keys.delete(k) });
    localStorage.setItem('konium.aiKey', 'sk-or-test');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [...OFFERED, model('qwen/qwen3.9-flash', '0.0000002', '0.0000006')] }));
      const m = JSON.parse(String(init!.body)).model as string;
      asked.push(m);
      if (gone.has(m)) return new Response(JSON.stringify({ error: { message: `No endpoints found for ${m}.` } }), { status: 404 });
      if (failing.has(m)) return new Response(JSON.stringify({ error: { message: 'Provider error' } }), { status: 502 });
      return new Response(JSON.stringify({ choices: [{ message: { content: ANSWER } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const cfg = (mode: 'key' | 'local'): AiSettings => ({ aiMode: mode, aiProvider: 'openrouter', aiCustomBase: '', aiLocalBase: 'http://localhost:1234/v1', aiModels: { 'key:model': '~anthropic/claude-opus-latest', 'local:model': 'my-local' }, aiShareCache: false });

  it('runs on Qwen Flash, not the model chosen for drawings; failing, on the one chosen', async () => {
    expect((await runJob(REQS, SPEC, { cfg: cfg('key') })).model).toBe('qwen/qwen3.8-flash');
    expect(asked).toEqual(['qwen/qwen3.8-flash']);
    asked = []; failing.add('qwen/qwen3.8-flash');
    expect((await runJob(REQS, SPEC, { cfg: cfg('key') })).model).toBe('~anthropic/claude-opus-latest');
    expect(asked[0]).toBe('qwen/qwen3.8-flash');
    expect(asked.at(-1)).toBe('~anthropic/claude-opus-latest');
  });
  it('a model on your computer does it itself', async () => {
    await runJob(REQS, SPEC, { cfg: cfg('local') });
    expect(asked).toEqual(['my-local']);
  });
  it('Qwen Flash retired: its family\'s newest, kept for the next job', async () => {
    gone.add('qwen/qwen3.8-flash');
    expect((await runJob(REQS, SPEC, { cfg: cfg('key') })).model).toBe('qwen/qwen3.9-flash');
    expect(asked).toEqual(['qwen/qwen3.8-flash', 'qwen/qwen3.9-flash']);
    asked = [];
    await runJob(REQS, SPEC, { cfg: cfg('key') });
    expect(asked).toEqual(['qwen/qwen3.9-flash']);
  });
});
