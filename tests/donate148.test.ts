import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DONATE_FACTS, DONATE_TEXT, donateMessages, fitNote } from '../src/ai/donate';
import { ASK_AFTER, AFTER_GIVING_DAYS, REST_DAYS, countStart, dayNote, donateAsk, donateCount, gaveFromAsk, showDonateAsk } from '../src/platform/donate';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';
import { settings } from '../src/core/settings';

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

const DAY = 86_400_000;
const memory = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); }, key: () => null, length: 0 };

describe('the donation ask (26.148)', () => {
  beforeEach(() => { memory.clear(); Object.assign(globalThis, { localStorage: fakeStorage }); donateAsk.value = null; });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  it('its own words pass its own rules; notes that break them are turned down', () => {
    expect(fitNote(DONATE_TEXT)).toBe(DONATE_TEXT);
    const ok = 'Konium Designer is free, with no adverts and nothing locked away. It keeps going thanks to voluntary donations, so if it helps your projects, any amount is warmly welcome.';
    expect(fitNote(`"${ok}"`)).toBe(ok);
    expect(fitNote(ok.replace('any amount', '5 pounds'))).toBeNull();           // figures
    expect(fitNote(`${ok} See ko-fi.com/konium.`)).toBeNull();                  // links
    expect(fitNote(ok.replace(', so', ' — so'))).toBeNull();                    // long dashes
    expect(fitNote(ok.replace('Konium Designer', 'This program'))).toBeNull();  // the name
    expect(fitNote(`${ok} ${ok} ${ok}`)).toBeNull();                            // too long
    expect(fitNote('Konium Designer needs you! Donate today!')).toBeNull();      // too short, two exclamation marks
    expect(fitNote(ok.replace('warmly welcome', 'something you must give'))).toBeNull();
    expect(fitNote(`**${ok}**`)).toBeNull();                                    // markup
    expect(fitNote(42)).toBeNull();
  });
  it('the request to the model holds the facts and the rules, and nothing about the user', () => {
    const m = donateMessages('2026-11-08');
    const all = m.map((x) => x.content).join('\n');
    for (const f of DONATE_FACTS) expect(all).toContain(f);
    expect(all).toContain('2026-11-08');
    expect(all).toMatch(/no dashes/);
    expect(m.map((x) => x.role)).toEqual(['system', 'user']);
  });
  it(`asks only after ${ASK_AFTER} starts, one start in a hundred, then rests`, () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    for (let i = 0; i < ASK_AFTER; i++) expect(countStart(now, 0)).toBe(false);
    expect(donateCount().starts).toBe(ASK_AFTER);
    expect(countStart(now, 0.5)).toBe(false);          // the other 99 in a hundred
    expect(countStart(now, 0.009)).toBe(true);         // the one
    memory.set('konium.donate', JSON.stringify({ starts: 100, asked: now }));
    expect(countStart(now + (REST_DAYS - 1) * DAY, 0)).toBe(false);
    expect(countStart(now + (REST_DAYS + 1) * DAY, 0)).toBe(true);
    gaveFromAsk(now);
    expect(REST_DAYS).toBe(5);
    expect(AFTER_GIVING_DAYS).toBe(180);
    expect(countStart(now + (AFTER_GIVING_DAYS - 1) * DAY, 0)).toBe(false);   // after "I've chipped in"
    expect(countStart(now + (AFTER_GIVING_DAYS + 1) * DAY, 0)).toBe(true);
  });
  it('offline, the note isn\'t asked for and the ask keeps its own words; online, it is, whatever the update setting (26.149)', async () => {
    const was = { offline: settings.offline, checkUpdates: settings.checkUpdates };
    let asked = 0;
    const fetchFn = (async () => { asked++; return new Response(JSON.stringify({ text: 'x' })); }) as typeof fetch;
    try {
      settings.offline = true;
      expect(await dayNote(fetchFn)).toBeNull();
      expect(asked).toBe(0);
      settings.offline = false; settings.checkUpdates = false;
      expect(await dayNote(fetchFn)).toBeNull();      // asked, but 'x' isn't fit to show
      expect(asked).toBe(1);
      const fine = (async () => new Response(JSON.stringify({ text: DONATE_TEXT }))) as typeof fetch;
      expect(await dayNote(fine)).toBe(DONATE_TEXT);
      settings.offline = true;
      await showDonateAsk(Date.parse('2026-11-08T12:00:00Z'));
      expect(donateAsk.value).toEqual({ text: DONATE_TEXT });
      expect(donateCount().asked).toBe(Date.parse('2026-11-08T12:00:00Z'));
    } finally { Object.assign(settings, was); }
  });
});

describe('the AI service\'s donation note (26.148)', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', DAILY_BUDGET_USD: '1' };
  const MODELS = [{ id: 'qwen/qwen3.8-flash', name: 'Qwen: Qwen3.8 Flash', created: 300, pricing: { prompt: '0.00000005', completion: '0.0000004' }, architecture: { input_modalities: ['text'] } }];
  let store: StoreLogic;
  let chats: { model: string; messages: { content: string }[]; temperature: number }[];
  let answer = '';
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
    chats.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 300, completion_tokens: 60, cost: 0.00004 } }));
  }) as typeof fetch;
  const get = (ip = '1.2.3.4') => new Request('https://konium.app/api/ai/donate-note', { headers: { 'CF-Connecting-IP': ip } });
  const now = Date.parse('2026-11-08T12:00:00Z');
  beforeEach(() => { store = new StoreLogic(sqlite()); chats = []; resetModelCache(); });

  it('writes the day\'s note once on the cheap model, then gives everyone the same', async () => {
    answer = 'Konium Designer is a free side project with no adverts. It runs on voluntary donations, so if it has helped you, a gift of any size would be lovely.';
    const r = await handle(get(), env, store, fetchFn, now);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: answer, day: '2026-11-08' });
    expect(chats).toHaveLength(1);
    expect(chats[0]!.model).toBe('qwen/qwen3.8-flash');
    expect(chats[0]!.messages[1]!.content).toContain('2026-11-08');
    expect(JSON.stringify(chats[0])).not.toContain('1.2.3.4');
    const again = await handle(get('5.6.7.8'), env, store, fetchFn, now + 3_600_000);
    expect(await again.json()).toEqual({ text: answer, day: '2026-11-08' });
    expect(chats).toHaveLength(1);
    expect(store.spent('2026-11-08')).toBeCloseTo(0.00004);
    // A new day, a new note
    await handle(get(), env, store, fetchFn, now + DAY);
    expect(chats).toHaveLength(2);
  });
  it('a note that breaks the rules isn\'t kept or given; tries are limited', async () => {
    answer = 'Donate now! Visit https://ko-fi.com/konium — every 5 pounds counts!';
    expect((await handle(get(), env, store, fetchFn, now)).status).toBe(502);
    expect(store.cached('donate@1:2026-11-08')).toBeNull();
    expect((await handle(get(), env, store, fetchFn, now)).status).toBe(502);
    expect((await handle(get(), env, store, fetchFn, now)).status).toBe(429);   // two tries each a day
    expect(chats).toHaveLength(2);
  });
  it('without its key the service says so and asks no model', async () => {
    expect((await handle(get(), {}, store, fetchFn, now)).status).toBe(503);
    expect(chats).toHaveLength(0);
  });
});
