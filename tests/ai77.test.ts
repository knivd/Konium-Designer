import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareModels, familyOf, followSuccessors, successor, versionOf } from '../src/ai/models';
import { PING } from '../src/ai/jobs';
import { runJob, type AiSettings } from '../src/ai/client';
import { settings, updateSettings } from '../src/core/settings';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

describe('models retired: their successors take their place', () => {
  it('a family is the id without its versions, dates, previews and routes', () => {
    expect(familyOf('google/gemini-3.8-flash')).toBe('google/gemini-#-flash');
    expect(familyOf('google/gemini-3.9-flash-preview')).toBe('google/gemini-#-flash');
    expect(familyOf('google/gemini-3.5-flash-lite')).toBe('google/gemini-#-flash-lite');
    expect(familyOf('anthropic/claude-opus-5.5')).toBe(familyOf('anthropic/claude-opus-6'));
    expect(familyOf('openai/gpt-6.1-sol')).not.toBe(familyOf('openai/gpt-6.1-sol-pro'));
    expect(familyOf('qwen/qwen3.8-max-0902')).toBe(familyOf('qwen/qwen3.9-max'));
    expect(familyOf('openai/gpt-4o-2024-08-06')).toBe(familyOf('openai/gpt-4o'));
    expect(familyOf('deepseek/deepseek-v4.1-flash:batch')).toBe('deepseek/deepseek-v#-flash');
    expect(versionOf('google/gemini-3.10-flash')).toEqual([3, 10]);
    expect(compareModels({ id: 'google/gemini-3.10-flash' }, { id: 'google/gemini-3.9-flash' })).toBeGreaterThan(0);
  });
  it('a model still listed is itself; one gone, the newest of its family (no :batch routes); none, null', () => {
    const list = [{ id: 'google/gemini-3.9-flash', created: 2 }, { id: 'google/gemini-4.0-flash', created: 3 }, { id: 'google/gemini-4.1-flash:batch', created: 4 }, { id: 'google/gemini-4.0-flash-lite', created: 3 }];
    expect(successor('google/gemini-3.9-flash', list)!.id).toBe('google/gemini-3.9-flash');
    expect(successor('google/gemini-3.8-flash', list)!.id).toBe('google/gemini-4.0-flash');
    expect(successor('google/gemini-3.5-flash-lite', list)!.id).toBe('google/gemini-4.0-flash-lite');
    expect(successor('anthropic/claude-opus-5.5', list)).toBeNull();
    expect(successor('google/gemini-3.8-flash', list, (m) => m.created < 3)!.id).toBe('google/gemini-3.9-flash');
    // Choices moved on, for their own mode only
    expect(followSuccessors({ 'konium:vision': 'google/gemini-3.8-flash', 'key:text': 'google/gemini-3.8-flash', 'konium:text': 'google/gemini-3.9-flash' }, 'konium', list))
      .toEqual({ 'konium:vision': 'google/gemini-4.0-flash', 'key:text': 'google/gemini-3.8-flash', 'konium:text': 'google/gemini-3.9-flash' });
    expect(followSuccessors({ 'konium:text': 'google/gemini-3.9-flash' }, 'konium', list)).toBeNull();
  });
});

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

describe('the Konium service with models retired', () => {
  const MODELS = [
    { id: 'google/gemini-4.0-flash-lite', name: 'Flash-Lite 4.0', created: 500, pricing: { prompt: '0.0000003', completion: '0.0000025' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'google/gemini-4.0-flash', name: 'Flash 4.0', created: 510, pricing: { prompt: '0.0000008', completion: '0.000004' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'anthropic/claude-opus-6', name: 'Opus 6', created: 520, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', created: 530, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  let chats: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
    chats.push(JSON.parse(String(init!.body)).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 } }));
  }) as typeof fetch;
  const post = (body: object) => new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
  const env: AiEnv = { OPENROUTER_KEY: 'k', SALT: 's' };
  let store: StoreLogic;
  beforeEach(() => { store = new StoreLogic(sqlite()); chats = []; resetModelCache(); });

  it('a model a designer chose, now gone, runs as its successor: its family\'s alias, the service offering aliases only', async () => {
    await handle(post({ job: 'ping', input: {}, model: 'anthropic/claude-opus-5.5' }), env, store, fetchFn, Date.parse('2027-03-01T12:00:00Z'));
    expect(chats).toEqual(['~anthropic/claude-opus-latest']);
  });
  it('the author\'s named models (MODELS, DEFAULT_MODEL), now gone, are their successors', async () => {
    const r = await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...env, MODELS: '[{"id": "google/gemini-3.5-flash-lite", "label": "Cheap", "roles": ["text", "vision"]}, {"id": "gone/model-1"}]', DEFAULT_MODEL: 'anthropic/claude-opus-5.5' }, store, fetchFn, Date.parse('2027-03-01T12:00:00Z'));
    const c = await r.json() as { models: { id: string; name: string }[]; defaults: { vision: string } };
    expect(c.models.map((m) => [m.id, m.name])).toEqual([['google/gemini-4.0-flash-lite', 'Flash-Lite 4.0']]);
    resetModelCache();
    const r2 = await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), { ...env, DEFAULT_MODEL: 'anthropic/claude-opus-5.5' }, store, fetchFn, Date.parse('2027-03-01T12:00:00Z'));
    expect((await r2.json() as { defaults: { model: string } }).defaults.model).toBe('~anthropic/claude-opus-latest');
  });
});

describe('your own key with a model retired', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    localStorage.setItem('konium.aiKey', 'sk-or-test');
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('the job goes to the successor, and the choice moves on to it', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [
        { id: 'anthropic/claude-opus-6', name: 'Opus 6', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000002', completion: '0.00001' } },
        { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000002', completion: '0.00001' } }] }));
      const model = JSON.parse(String(init!.body)).model as string;
      asked.push(model);
      if (model === 'anthropic/claude-opus-5.5') return new Response(JSON.stringify({ error: { message: 'No endpoints found for anthropic/claude-opus-5.5.' } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    }));
    const was = { aiMode: settings.aiMode, aiModels: settings.aiModels };
    updateSettings({ aiMode: 'key', aiProvider: 'openrouter', aiModels: { 'key:text': 'anthropic/claude-opus-5.5' } });
    const r = await runJob(PING, {});
    // OpenRouter's list as offered: its aliases (26.080)
    expect(asked).toEqual(['anthropic/claude-opus-5.5', '~anthropic/claude-opus-latest']);
    expect(r.model).toBe('~anthropic/claude-opus-latest');
    expect(settings.aiModels['key:model']).toBe('~anthropic/claude-opus-latest');
    expect(settings.aiModels['key:text']).toBeUndefined();
    // Another failure isn't taken for a retired model
    const other: AiSettings = { aiMode: 'key', aiProvider: 'openrouter', aiCustomBase: '', aiLocalBase: '', aiModels: { 'key:text': 'x/y' }, aiShareCache: false };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limited' } }), { status: 429 })));
    await expect(runJob(PING, {}, { cfg: other })).rejects.toThrow(/Too many requests/);
    updateSettings(was);
  });
});

describe('one model for every job', () => {
  it('the choice for a mode (older per-role choices count, drawings first); setting it drops them', async () => {
    const { modelFor, withModel } = await import('../src/ai/client');
    expect(modelFor('konium', { 'konium:text': 'a/t', 'konium:vision': 'a/v' })).toBe('a/v');
    expect(modelFor('konium', { 'konium:model': 'a/m', 'konium:vision': 'a/v' })).toBe('a/m');
    expect(modelFor('key', { 'konium:model': 'a/m' })).toBe('');
    expect(withModel({ 'konium:text': 'a/t', 'konium:vision': 'a/v', 'key:text': 'k/t' }, 'konium', 'a/m')).toEqual({ 'konium:model': 'a/m', 'key:text': 'k/t' });
    expect(withModel({ 'konium:model': 'a/m' }, 'konium', '')).toEqual({});
  });
  it('the service\'s list is all there is: a choice with no successor there is let go', () => {
    expect(followSuccessors({ 'konium:vision': 'google/gemini-3.8-flash' }, 'konium', [{ id: 'anthropic/claude-opus-5.5' }], true)).toEqual({});
    expect(followSuccessors({ 'key:model': 'google/gemini-3.8-flash' }, 'key', [{ id: 'anthropic/claude-opus-5.5' }])).toBeNull();
  });
});
