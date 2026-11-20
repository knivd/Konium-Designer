import { describe, expect, it } from 'vitest';
import { handle, resetModelCache, weighed, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';
import { allowanceNote, jobUnits } from '../src/ai/client';
import type { SurveyInput } from '../src/ai/jobs';

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

const m = (id: string, priceIn?: number, priceOut?: number) => ({ id, name: id, roles: ['text' as const, 'vision' as const], vision: true, priceIn, priceOut });

describe('the Konium AI service\'s job tokens, weighed by model (26.099; named, 25 a day, 26.100)', () => {
  it('a model weighs its typical job\'s cost over the cheapest offered model\'s, rounded, at least 1; one without prices weighs 1', () => {
    const w = weighed([m('flash', 0.3, 2.5), m('pro', 2, 12), m('opus', 5, 25), m('unknown')]);
    // A typical job: 20k tokens in, 4k out — flash 16, pro 88, opus 200 (millionths of a dollar per token × tokens)
    expect(w.map((x) => [x.id, x.weight])).toEqual([['flash', 1], ['pro', 6], ['opus', 13], ['unknown', 1]]);
  });

  it('the day\'s count takes a dearer job\'s units at once, and refuses one that doesn\'t fit what is left', () => {
    const s = new StoreLogic(sqlite());
    expect(s.take('2026-11-03', 'c', 'jobs', 20, 13)).toEqual({ ok: true, left: 7 });
    expect(s.take('2026-11-03', 'c', 'jobs', 20, 13)).toEqual({ ok: false, left: 7 });
    expect(s.take('2026-11-03', 'c', 'jobs', 20, 6)).toEqual({ ok: true, left: 1 });
    expect(s.take('2026-11-03', 'c', 'jobs', 20)).toEqual({ ok: true, left: 0 });
    expect(s.left('2026-11-03', 'c', 'jobs', 20)).toBe(0);
  });

  it('a job uses its model\'s weight (never more than a day\'s); the config gives each model\'s; too little left says which model and how much', async () => {
    resetModelCache();
    const list = [
      { id: '~google/gemini-flash-latest', name: 'Google: Gemini Flash Latest', created: 1, pricing: { prompt: '0.0000003', completion: '0.0000025' }, architecture: { input_modalities: ['text', 'image'] } },
      { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', created: 2, pricing: { prompt: '0.000005', completion: '0.000025' }, architecture: { input_modalities: ['text', 'image'] } },
    ];
    const survey = { maker: 'X', device: 'Y', description: 'Z', variants: [] };
    const fetchFn = (async (url: string) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: list }))
      : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(survey) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.001 } })))) as typeof fetch;
    const env: AiEnv = { OPENROUTER_KEY: 'k', SALT: 's', JOBS_PER_DAY: '20', DAILY_BUDGET_USD: '5', FAMILIES: 'google/gemini-flash, anthropic/claude-opus' };
    const store = new StoreLogic(sqlite());
    const now = Date.parse('2026-11-03T12:00:00Z');
    const input: SurveyInput = { pages: [{ page: 1, text: 'SOIC-8 package drawing', drawing: true }], pageCount: 1 };
    const job = (model: string) => handle(new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ job: 'survey', input, model }) }), env, store, fetchFn, now);

    const cfg = await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }), env, store, fetchFn, now)).json() as { models: { id: string; weight: number }[]; allowance: object };
    expect(cfg.models.map((x) => [x.id, x.weight])).toEqual([['~google/gemini-flash-latest', 1], ['~anthropic/claude-opus-latest', 13]]);
    expect(cfg.allowance).toEqual({ jobs: 20, left: 20, weighed: true });

    const a = await (await job('~anthropic/claude-opus-latest')).json() as { allowance: { left: number; used: number } };
    expect(a.allowance).toMatchObject({ left: 7, used: 13 });
    const b = await job('~anthropic/claude-opus-latest');
    expect(b.status).toBe(429);
    expect((await b.json() as { error: string }).error).toMatch(/^A job on Anthropic: Claude Opus Latest takes 13 job tokens and 7 are left today: choose a cheaper model/);
    const c = await (await job('~google/gemini-flash-latest')).json() as { allowance: { left: number; used: number } };
    expect(c.allowance).toMatchObject({ left: 6, used: 1 });
  });

  it('25 job tokens a day unless JOBS_PER_DAY says otherwise', async () => {
    resetModelCache();
    const fetchFn = (async () => new Response(JSON.stringify({ data: [{ id: '~google/gemini-flash-latest', name: 'Flash', created: 1, pricing: { prompt: '0.0000003', completion: '0.0000025' }, architecture: { input_modalities: ['text'] } }] }))) as unknown as typeof fetch;
    const env: AiEnv = { OPENROUTER_KEY: 'k', SALT: 's', DAILY_BUDGET_USD: '5', FAMILIES: 'google/gemini-flash' };
    const cfg = await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '8.8.8.8' } }), env, new StoreLogic(sqlite()), fetchFn, Date.parse('2026-11-04T09:00:00Z'))).json() as { allowance: { jobs: number } };
    expect(cfg.allowance.jobs).toBe(25);
  });

  it('the app says how much of the allowance a job takes on the chosen model', () => {
    expect(jobUnits({ id: 'a', name: 'A', vision: true, weight: 13 })).toBe(13);
    expect(jobUnits({ id: 'a', name: 'A', vision: true })).toBe(1);
    expect(allowanceNote({ jobs: 20, left: 14, weighed: true }, { id: 'o', name: 'Claude Opus', vision: true, weight: 13 })).toBe('Free: 13 job tokens on Claude Opus (14 of 20 left today)');
    expect(allowanceNote({ jobs: 20, left: 14 }, { id: 'f', name: 'Flash', vision: true })).toBe('Free: 1 job token (14 of 20 left today)');
  });
});
