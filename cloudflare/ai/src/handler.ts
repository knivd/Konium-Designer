/**
 * The Konium AI service (konium.app/api/ai): runs Konium's own AI jobs (src/ai/jobs.ts) on models
 * the author chose, with the author's OpenRouter key, for anyone using Konium — within
 * limits, since the author pays:
 * - only Konium's jobs: the service builds the messages itself from the job's input and caps the
 *   answer's length, so it can't be used as a free chatbot;
 * - a daily allowance per user (known only by a salted hash of the IP address) and a daily budget
 *   for the whole service; OpenRouter's credit limit on the key is the hard monthly cap. The
 *   allowance is in job tokens (JOBS_PER_DAY a day, 25 unless set): a job on the cheapest model
 *   offered takes one, a dearer model's job as many as it costs times more (its weight, from
 *   OpenRouter's prices for a typical job), so a day's tokens cost about the same whichever model;
 * - models: those named in MODELS, or the frontier ones found in OpenRouter's list (the newest of
 *   each of the top families, priced under a ceiling), so a renamed model doesn't break the
 *   service; one model does a whole job, from the survey to the footprint;
 * - providers that train on what they're sent are excluded (OpenRouter's data_collection: deny);
 * - the shared cache: answers designers accepted, by the datasheet's fingerprint, served without
 *   asking a model again (and without using the allowance).
 *
 * GET  /config  the models, the defaults, today's allowance left, the jobs it runs
 * POST /job     { job, input, model?, cacheKey?, fresh? } → { answer, usage, model, allowance } or { answer, cached },
 *               or { raw, problem, usage, … } when the answer didn't pass this service's check (the app checks it
 *               itself, with its own rules, which may be newer than the service's)
 * POST /accept  { job, cacheKey, answer }: an answer the designer accepted, for the shared cache
 */
import { JOBS, citations, withSources, type JobKind, type JobSpec, type Message } from '../../../src/ai/jobs';
import { CHEAP_MODEL, LATEST_ALIAS, OFFERED_FAMILIES, aliasKey, successor } from '../../../src/ai/models';
import { donateMessages, fitNote } from '../../../src/ai/donate';
import type { Cached, Taken } from './store';
import { limitKey } from '../../limitKey';
import { bodyUpTo, jsonUpTo } from '../../body';

export interface AiEnv {
  OPENROUTER_KEY?: string;
  /** Mixed into the hash that stands for a user's IP address (a secret). */
  SALT?: string;
  /** The models offered, as JSON: [{ "id": "google/…", "label": "…", "roles": ["text", "vision"] }]; empty for the automatic choice. */
  MODELS?: string;
  JOBS_PER_DAY?: string;
  DAILY_BUDGET_USD?: string;
  /** The automatic choice's price ceiling, US dollars per million tokens. */
  MAX_PRICE_IN?: string;
  MAX_PRICE_OUT?: string;
  /** The default model (a "latest" alias, offered whatever its family and price; a model's id stands for its family's alias; else the first of the list). */
  DEFAULT_MODEL?: string;
  /** The families offered, by their aliases without ~ and -latest ("anthropic/claude-opus, google/gemini-flash"); empty: Konium's own choice. */
  FAMILIES?: string;
  /** The cheap text model for plain text jobs (a specification's requirements), whatever is chosen for drawings; empty: CHEAP_MODEL. Its family's newest once retired. */
  CHEAP_MODEL?: string;
}

/** The Durable Object's methods (StoreLogic's), called over RPC. */
export interface StoreApi {
  take(day: string, client: string, kind: string, limit: number, units?: number): Taken | Promise<Taken>;
  left(day: string, client: string, kind: string, limit: number): number | Promise<number>;
  spent(day: string): number | Promise<number>;
  spend(day: string, usd: number): void | Promise<void>;
  reserve(day: string, usd: number, budget: number): boolean | Promise<boolean>;
  settle(day: string, delta: number): void | Promise<void>;
  cached(key: string): Cached | null | Promise<Cached | null>;
  accept(key: string, client: string, answer: unknown, now: number): void | Promise<void>;
  prune(before: string): void | Promise<void>;
}

type Role = 'text' | 'vision';
/** weight: the allowance a job on it uses (1 for the cheapest offered; more for dearer ones). */
export interface ServiceModel { id: string; name: string; roles: Role[]; vision: boolean; priceIn?: number; priceOut?: number; weight: number }

/**
 * A typical job's tokens [est: a datasheet's pages or a design as text in, a structured answer out],
 * for weighing models: a model's weight is its typical job's cost over the cheapest offered model's,
 * rounded (at least 1). A model without prices weighs 1.
 */
const TYPICAL_IN = 20_000, TYPICAL_OUT = 4_000;
const typical = (m: Pick<ServiceModel, 'priceIn' | 'priceOut'>) => (m.priceIn === undefined || m.priceOut === undefined ? undefined : m.priceIn * TYPICAL_IN + m.priceOut * TYPICAL_OUT);
export function weighed<M extends Omit<ServiceModel, 'weight'>>(models: M[]): (M & { weight: number })[] {
  const costs = models.map(typical).filter((c): c is number => c !== undefined && c > 0);
  const base = costs.length ? Math.min(...costs) : 0;
  return models.map((m) => { const c = typical(m); return { ...m, weight: base > 0 && c !== undefined ? Math.max(1, Math.round(c / base)) : 1 }; });
}

const OPENROUTER = 'https://openrouter.ai/api/v1';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** The jobs the service runs, how many a user gets a day (by kind), and the cacheable ones. */
const COUNTED: Partial<Record<JobKind, 'jobs' | 'locate' | 'review' | 'detail' | 'ping'>> = {
  survey: 'jobs', locate: 'locate', package: 'jobs', review: 'review', pins: 'jobs', advise: 'jobs', board: 'jobs', datasheet: 'detail', part: 'detail', ask: 'detail', mpn: 'jobs', reqs: 'jobs', reqadvise: 'jobs', script: 'jobs', layout: 'jobs', routing: 'jobs', ping: 'ping',
};
const CACHEABLE: JobKind[] = ['survey', 'package', 'pins', 'datasheet'];
/**
 * Pings and accepts a day; locating drawings (a small job before each reading of one) has three per
 * job allowed, and so has a footprint's checking (a round or more after each); a design check's
 * details (finding each part's datasheet, checking the part against it, questions) five per job.
 */
const PINGS_PER_DAY = 10, ACCEPTS_PER_DAY = 50, LOCATES_PER_JOB = 3, REVIEWS_PER_JOB = 3, DETAILS_PER_JOB = 5;
/** Datasheets fetched for a user a day, and the largest (bytes). */
const FETCHES_PER_DAY = 100, MAX_PDF = 30_000_000;
/** Input limits: characters of text, and the whole request. */
const MAX_INPUT = 300_000, MAX_BODY = 8_000_000;

/**
 * The automatic choice: OpenRouter's "latest" aliases (~anthropic/claude-opus-latest: always the
 * family's newest model, so nothing offered ever retires) of the families offered (FAMILIES, else
 * Claude Opus, GPT Sol, Gemini Pro and Gemini Flash), taking pictures — every job may read drawings
 * — under the price ceiling, the cheapest first. One model does a whole job, survey to footprint.
 */
const families = (env: AiEnv) => (env.FAMILIES?.trim() ? env.FAMILIES.split(/[\s,]+/).filter(Boolean) : OFFERED_FAMILIES);
const offered = (m: OrModel, fam: string[], maxIn: number, maxOut: number) => LATEST_ALIAS.test(m.id) && fam.includes(aliasKey(m.id))
  && !!m.architecture?.input_modalities?.includes('image') && (perM(m.pricing?.prompt) ?? Infinity) <= maxIn && (perM(m.pricing?.completion) ?? Infinity) <= maxOut;

interface OrModel { id: string; name?: string; created?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { input_modalities?: string[] } }
let listCache: { at: number; list: OrModel[] } | null = null;

async function openRouterModels(fetchFn: typeof fetch, now: number): Promise<OrModel[]> {
  if (listCache && now - listCache.at < 3_600_000) return listCache.list;
  const res = await fetchFn(`${OPENROUTER}/models`);
  if (!res.ok) throw new Error(`OpenRouter's model list: ${res.status}`);
  const list = ((await res.json()) as { data?: OrModel[] }).data ?? [];
  listCache = { at: now, list };
  return list;
}
/** For tests: forget the model list. */
export function resetModelCache(): void { listCache = null; }

const perM = (x?: string) => { const n = Number(x); return Number.isFinite(n) ? n * 1e6 : undefined; };

export async function serviceModels(env: AiEnv, fetchFn: typeof fetch, now: number): Promise<ServiceModel[]> {
  return weighed(await listed(env, fetchFn, now));
}

async function listed(env: AiEnv, fetchFn: typeof fetch, now: number): Promise<Omit<ServiceModel, 'weight'>[]> {
  let list: OrModel[] = [];
  try { list = await openRouterModels(fetchFn, now); } catch { /* the named models are taken as they are */ }
  const byId = new Map(list.map((m) => [m.id, m]));
  const describe = (m: OrModel, roles: Role[], name?: string): Omit<ServiceModel, 'weight'> => {
    const vision = !!m.architecture?.input_modalities?.includes('image');
    // Names as shown: an alias's without its ~
    return { id: m.id, name: (name ?? m.name ?? m.id).replace(/^~\s*/, ''), roles: roles.filter((r) => r === 'text' || vision), vision, priceIn: perM(m.pricing?.prompt), priceOut: perM(m.pricing?.completion) };
  };
  if (env.MODELS?.trim()) {
    let named: { id: string; label?: string; roles?: Role[] }[] = [];
    try { named = JSON.parse(env.MODELS); } catch { /* none */ }
    // A named model OpenRouter no longer lists: the newest of its family in its place (its own name then)
    const out: Omit<ServiceModel, 'weight'>[] = [];
    for (const n of named) {
      if (!n?.id) continue;
      const m = !list.length ? null : byId.get(n.id) ?? successor(n.id, list, (x) => !n.roles?.includes('vision') || !!x.architecture?.input_modalities?.includes('image'));
      if (list.length && !m) continue;
      if (m && out.some((o) => o.id === m.id)) continue;
      out.push(describe(m ?? { id: n.id, architecture: { input_modalities: n.roles?.includes('vision') ? ['text', 'image'] : ['text'] } }, n.roles ?? ['text'], m && m.id !== n.id ? undefined : n.label));
    }
    return out;
  }
  const maxIn = Number(env.MAX_PRICE_IN ?? 10), maxOut = Number(env.MAX_PRICE_OUT ?? 50);
  const fam = families(env);
  const out = list.filter((m) => offered(m, fam, maxIn, maxOut))
    .sort((a, b) => (perM(a.pricing?.completion) ?? 0) - (perM(b.pricing?.completion) ?? 0) || (perM(a.pricing?.prompt) ?? 0) - (perM(b.pricing?.prompt) ?? 0) || a.id.localeCompare(b.id))
    .map((m) => describe(m, ['text', 'vision']));
  // The default named by the author, whatever its price: an alias taking pictures (a model's id stands for its family's alias)
  const named = env.DEFAULT_MODEL ? successor(env.DEFAULT_MODEL, list.filter((m) => LATEST_ALIAS.test(m.id) && offered(m, [aliasKey(m.id)], Infinity, Infinity))) : null;
  if (named && !out.some((o) => o.id === named.id)) out.unshift(describe(named, ['text', 'vision']));
  return out;
}

/**
 * The cheap text model (CHEAP_MODEL, or its family's newest once OpenRouter stops listing it), for
 * the jobs that say a cheap model does them as well: one job token each. Null when OpenRouter's
 * list can't be had or has none of its family (the job then runs on the model chosen).
 */
export async function cheapModel(env: AiEnv, fetchFn: typeof fetch, now: number): Promise<ServiceModel | null> {
  let list: OrModel[] = [];
  try { list = await openRouterModels(fetchFn, now); } catch { return null; }
  const m = successor(env.CHEAP_MODEL?.trim() || CHEAP_MODEL, list);
  if (!m) return null;
  return { id: m.id, name: (m.name ?? m.id).replace(/^~\s*/, ''), roles: ['text'], vision: !!m.architecture?.input_modalities?.includes('image'), priceIn: perM(m.pricing?.prompt), priceOut: perM(m.pricing?.completion), weight: 1 };
}
/** The jobs run on the cheap text model. */
const CHEAP_JOBS = (Object.keys(JOBS) as JobKind[]).filter((k) => (JOBS[k] as JobSpec<unknown, unknown>).cheap);

/** The default: DEFAULT_MODEL (or its successor), else the first of the list; the same for every job (`text` and `vision` for apps before 26.078). */
const defaults = (models: ServiceModel[], env: AiEnv = {}) => {
  const id = (env.DEFAULT_MODEL ? successor(env.DEFAULT_MODEL, models) : null)?.id ?? models[0]?.id;
  return { model: id, text: id, vision: id };
};

async function clientOf(req: Request, env: AiEnv): Promise<string> {
  // (an IPv6 address by its /64: one subscriber, however many addresses they use)
  const ip = limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT ?? ''}|${ip}`)));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KEY_FORMAT = /^[a-f0-9]{64}(:[\w.-]{1,80})?$/;
const jobsPerDay = (env: AiEnv) => Math.max(0, Math.round(Number(env.JOBS_PER_DAY ?? 25)));

export async function handle(req: Request, env: AiEnv, store: StoreApi, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const day = new Date(now).toISOString().slice(0, 10);
  const client = await clientOf(req, env);

  if (req.method === 'GET' && path.endsWith('/config')) {
    const models = env.OPENROUTER_KEY ? await serviceModels(env, fetchFn, now) : [];
    const cheap = env.OPENROUTER_KEY ? await cheapModel(env, fetchFn, now) : null;
    const limit = jobsPerDay(env);
    const shown = (m: ServiceModel) => ({ id: m.id, name: m.name, vision: m.vision, roles: m.roles, priceIn: m.priceIn, priceOut: m.priceOut, weight: m.weight });
    return reply({
      models: models.map(shown),
      // The cheap text model, and the jobs it does whatever model is chosen
      ...(cheap ? { cheap: shown(cheap), cheapJobs: CHEAP_JOBS } : {}),
      defaults: defaults(models, env),
      // In job tokens: each model's weight says how many one of its jobs takes
      allowance: { jobs: limit, left: await store.left(day, client, 'jobs', limit), weighed: true },
      shareCache: true,
      // What this deployment runs: an app newer than the service knows which of its jobs to offer
      jobs: Object.keys(COUNTED),
      ...(env.OPENROUTER_KEY ? {} : { notice: 'The Konium service isn\'t set up yet' }),
    });
  }
  if (req.method === 'GET' && path.endsWith('/fetch')) return fetchDatasheet(new URL(req.url), store, day, client, fetchFn);
  if (req.method === 'GET' && path.endsWith('/donate-note')) return donateNote(env, store, day, client, fetchFn, now);
  if (req.method !== 'POST') return reply({ error: 'Not here' }, 404);
  // Read no further than a job may be long, whatever its Content-Length says or leaves unsaid
  const read = await jsonUpTo<{ job?: string; input?: unknown; model?: string; cacheKey?: string; fresh?: boolean; answer?: unknown; pass?: unknown }>(req, MAX_BODY);
  if (read === 'long') return reply({ error: 'Too much to send at once' }, 413);
  if (read === 'bad' || !read || typeof read !== 'object') return reply({ error: 'Not a job' }, 400);
  const body = read;
  const kind = body.job as JobKind;
  const spec = JOBS[kind] as JobSpec<unknown, unknown> | undefined;
  if (!spec || !COUNTED[kind]) return reply({ error: 'Not a job the service runs' }, 400);

  if (path.endsWith('/accept')) {
    if (!CACHEABLE.includes(kind) || typeof body.cacheKey !== 'string' || !KEY_FORMAT.test(body.cacheKey)) return reply({ error: 'Nothing to keep' }, 400);
    if (JSON.stringify(body.answer ?? null).length > 64_000) return reply({ error: 'Too large to keep' }, 413);
    let value: unknown;
    try { value = spec.check(body.answer, spec.blank); } catch (e) { return reply({ error: `Not kept: ${(e as Error).message}` }, 400); }
    // Only what came of a job this service did for this user and this key is kept (acceptPass)
    if (!(await passAllows(env, kind, body.cacheKey, client, body.pass, JSON.stringify(value), now))) return reply({ error: 'Nothing to keep: the reading must be made here first' }, 403);
    if (!(await store.take(day, client, 'accept', ACCEPTS_PER_DAY)).ok) return reply({ error: 'Enough for today' }, 429);
    await store.accept(`${kind}@${spec.version}:${body.cacheKey}`, client, value, now);
    return reply({ ok: true });
  }
  if (!path.endsWith('/job')) return reply({ error: 'Not here' }, 404);
  if (!env.OPENROUTER_KEY) return reply({ error: 'The Konium service isn\'t set up yet: use your own key or a local model (Preferences › System › AI)' }, 503);
  const input = body.input;
  if (!input || typeof input !== 'object') return reply({ error: 'The job has no input' }, 400);
  let messages: Message[];
  try {
    if (spec.size(input as never) > MAX_INPUT) return reply({ error: 'Too much text for one job' }, 413);
    messages = spec.messages(input as never);
  } catch { return reply({ error: 'The job\'s input isn\'t right' }, 400); }

  // The shared cache first: no model, no allowance used
  const cacheKey = typeof body.cacheKey === 'string' && KEY_FORMAT.test(body.cacheKey) && CACHEABLE.includes(kind) ? `${kind}@${spec.version}:${body.cacheKey}` : null;
  if (cacheKey && !body.fresh) {
    const hit = await store.cached(cacheKey);
    if (hit) {
      try {
        const answer = spec.check(hit.answer, input);
        // (whoever is given it may say they stand by it too, as it is: a pass for this very answer)
        const stands = await acceptPass(env, kind, body.cacheKey!, client, now, await sha256(JSON.stringify(spec.check(answer, spec.blank))).catch(() => undefined));
        return reply({ answer, cached: { acceptedBy: hit.acceptedBy }, usage: { in: 0, out: 0, cost: 0 }, ...(stands ? { accept: stands } : {}) });
      } catch { /* not for this input: ask the model */ }
    }
  }

  const budget = Number(env.DAILY_BUDGET_USD ?? 1);
  if ((await store.spent(day)) >= budget) return reply({ error: OVER_BUDGET }, 503);
  const models = await serviceModels(env, fetchFn, now);
  const role = spec.roleOf?.(input as never) ?? spec.role;
  // A job with pictures on a model that takes them
  const fit = (m: ServiceModel) => m.roles.includes(role);
  // The one asked for (or its successor); else the default, for every job alike
  const prefer = defaults(models, env).model;
  // A model asked for that is no longer offered: its family's newest in its place
  const asked = typeof body.model === 'string' ? successor(body.model, models, fit) : null;
  const chosen = asked ?? models.find((m) => m.id === prefer && fit(m)) ?? models.find(fit);
  // Plain text work a cheap model does as well: on the cheap text model, whatever is chosen (the chosen one if that fails)
  const cheap = spec.cheap && role === 'text' ? await cheapModel(env, fetchFn, now) : null;
  const first = cheap ?? chosen;
  if (!first) return reply({ error: 'No model is available for this job just now' }, 503);
  let model: ServiceModel = first;

  // The allowance (finding a drawing on its page and checking the footprint made, steps of a footprint, have their own)
  const counted = COUNTED[kind]!;
  const limit = counted === 'ping' ? PINGS_PER_DAY : counted === 'locate' ? LOCATES_PER_JOB * jobsPerDay(env) : counted === 'review' ? REVIEWS_PER_JOB * jobsPerDay(env)
    : counted === 'detail' ? DETAILS_PER_JOB * jobsPerDay(env) : jobsPerDay(env);
  // A dearer model's job uses more of it (never more than a whole day's, so every model can do one)
  const units = counted === 'ping' ? 1 : Math.min(model.weight, limit);
  // The job's likely cost is set aside before the model is asked (on the dearer of the two models it may run on): jobs started
  // together each take their share of the day's budget, so no burst can run past it. Put right when the job has ended.
  const aside = Math.max(likelyCost(messages, model, spec.maxTokens), chosen ? likelyCost(messages, chosen, spec.maxTokens) : 0);
  if (!(await store.reserve(day, aside, budget))) return reply({ error: OVER_BUDGET }, 503);
  const taken = await store.take(day, client, counted, limit, units);
  if (!taken.ok) {
    await store.settle(day, -aside);
    return reply({ error: units > 1 && taken.left > 0
      ? `A job on ${model.name} takes ${units} job tokens and ${taken.left} ${taken.left === 1 ? 'is' : 'are'} left today: choose a cheaper model (Preferences › System › AI), try again tomorrow, or use your own key or a local model`
      : `Today's job tokens are used up (${limit} a day): try again tomorrow, or use your own key or a local model (Preferences › System › AI)` }, 429);
  }

  const ask = (json: boolean) => fetchFn(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENROUTER_KEY}`, 'HTTP-Referer': 'https://konium.app', 'X-Title': 'Konium Designer' },
    body: JSON.stringify({
      model: model.id, messages, max_tokens: spec.maxTokens, temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      usage: { include: true }, provider: { data_collection: 'deny' }, reasoning: { effort: spec.effort ?? 'low', exclude: true },
      // A job that searches the web first (finding a datasheet): OpenRouter's web plugin
      ...(spec.web ? { plugins: [{ id: 'web', max_results: spec.web }] } : {}),
    }),
  });
  const tryModel = async () => {
    let r = await ask(true);
    if (r.status === 400 && /response_format|json/i.test(await r.clone().text().catch(() => ''))) r = await ask(false);
    return r;
  };
  let res: Response;
  try {
    res = await tryModel();
    if (!res.ok && model === cheap && chosen) {
      console.log(`job ${kind} on ${model.id}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}; on ${chosen.id} instead`);
      model = chosen;
      res = await tryModel();
    }
  } catch (e) { await store.settle(day, -aside); throw e; }
  if (!res.ok) {
    await store.settle(day, -aside);
    console.log(`job ${kind} on ${model.id}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return reply({ error: `The model couldn't do the job just now (${res.status}): try again, or another model` }, 502);
  }
  const j = await res.json() as { choices?: { message?: { content?: string; annotations?: unknown[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  const u = j.usage ?? {};
  const tokensIn = u.prompt_tokens ?? 0, tokensOut = u.completion_tokens ?? 0;
  const cost = typeof u.cost === 'number' ? u.cost : (tokensIn * (model.priceIn ?? 1) + tokensOut * (model.priceOut ?? 5)) / 1e6;
  await store.settle(day, cost - aside);
  if (now % 97 === 0) await store.prune(new Date(now - 8 * 86_400_000).toISOString().slice(0, 10));
  const usage = { in: tokensIn, out: tokensOut, cost };
  const text = j.choices?.[0]?.message?.content ?? '';
  const allowance = { jobs: limit, left: taken.left, counted, used: units };
  // The pages a web search found, with the answer
  const sources = spec.web ? citations(j.choices?.[0]?.message?.annotations) : [];
  // What lets the user put what they accept of this reading into the shared cache (their corrections with it)
  const accept = cacheKey ? await acceptPass(env, kind, body.cacheKey!, client, now) : undefined;
  const more = { usage, model: model.id, allowance, ...(sources.length ? { sources } : {}), ...(accept ? { accept } : {}) };
  try {
    return reply({ answer: spec.check(withSources(text, sources), input), ...more });
  } catch (e) {
    // Paid for: the app has the last word (its checks may be newer than this service's)
    return reply({ raw: text.slice(0, 200_000), problem: (e as Error).message, ...more });
  }
}

const OVER_BUDGET = 'The Konium service has used today\'s budget: try again tomorrow, or use your own key or a local model (Preferences › System › AI)';

/** What a job is likely to cost at most, in dollars: its text at three characters a token, a picture at 1,500, the longest answer allowed. */
export function likelyCost(messages: Message[], model: ServiceModel, maxTokens: number): number {
  let chars = 0, pictures = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') { chars += m.content.length; continue; }
    for (const p of m.content as { type?: string; text?: string }[]) { if (p.type === 'text') chars += (p.text ?? '').length; else pictures++; }
  }
  return ((chars / 3 + pictures * 1500) * (model.priceIn ?? 1) + maxTokens * (model.priceOut ?? 5)) / 1e6;
}

/* ─── The shared cache: who may put an answer into it ─────────────────────────────────── */

async function hmacHex(key: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const sha256 = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** How long after a job its reading may be put into the cache. */
export const ACCEPT_MS = 24 * 3_600_000;
/**
 * The pass that lets a reading into the shared cache. The cache is written by its users, so what
 * goes into it is tied to work done here: a pass is given with a job's answer, to that user, for
 * that datasheet and question, for a day. One given with a job the model did lets the user keep
 * the reading as they corrected it; one given with an answer that came from the cache lets them
 * stand by that very answer and no other. Without a pass nothing is kept. (It bounds what a
 * stranger can put in to the jobs they are allowed; it does not make a reading true: the app
 * shows a cached reading as another user's, to be checked against the datasheet like any other.)
 */
async function acceptPass(env: AiEnv, kind: string, cacheKey: string, client: string, now: number, answerHash?: string): Promise<string | undefined> {
  if (!env.SALT) return undefined;
  const until = now + ACCEPT_MS, what = answerHash ? `h${answerHash}` : 'j';
  return `${until}.${what}.${await hmacHex(env.SALT, `accept|${kind}|${cacheKey}|${client}|${until}|${what}`)}`;
}
async function passAllows(env: AiEnv, kind: string, cacheKey: string, client: string, pass: unknown, answer: string, now: number): Promise<boolean> {
  const m = /^(\d{1,16})\.(j|h[0-9a-f]{64})\.([0-9a-f]{64})$/.exec(typeof pass === 'string' ? pass : '');
  if (!m || !env.SALT || !(Number(m[1]) > now)) return false;
  const want = await hmacHex(env.SALT, `accept|${kind}|${cacheKey}|${client}|${m[1]}|${m[2]}`);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[3]!.charCodeAt(i);
  if (diff !== 0) return false;
  return m[2] === 'j' || m[2] === `h${await sha256(answer)}`;
}

/** Tries at the day's donation note: each app's, and everyone's together (a note that fails the checks is tried again). */
const NOTE_TRIES_EACH = 2, NOTE_TRIES_ALL = 12;

/**
 * The day's wording of the app's now-and-then donation ask: written once a day by the cheap text
 * model from fixed facts (src/ai/donate.ts), checked by the app's own rules, then the same for
 * everyone that day. No allowance of the user's is used; nothing about them is sent to the model.
 */
async function donateNote(env: AiEnv, store: StoreApi, day: string, client: string, fetchFn: typeof fetch, now: number): Promise<Response> {
  const key = `donate@1:${day}`;
  const hit = await store.cached(key);
  const kept = hit ? fitNote(hit.answer) : null;
  if (kept) return reply({ text: kept, day });
  if (!env.OPENROUTER_KEY) return reply({ error: 'Not set up' }, 503);
  if ((await store.spent(day)) >= Number(env.DAILY_BUDGET_USD ?? 1)) return reply({ error: 'Not today' }, 503);
  if (!(await store.take(day, client, 'note', NOTE_TRIES_EACH)).ok || !(await store.take(day, 'everyone', 'note', NOTE_TRIES_ALL)).ok) return reply({ error: 'Not today' }, 429);
  const model = await cheapModel(env, fetchFn, now);
  if (!model) return reply({ error: 'No model just now' }, 503);
  let res: Response;
  try {
    res = await fetchFn(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENROUTER_KEY}`, 'HTTP-Referer': 'https://konium.app', 'X-Title': 'Konium Designer' },
      body: JSON.stringify({ model: model.id, messages: donateMessages(day), max_tokens: 300, temperature: 1, usage: { include: true }, provider: { data_collection: 'deny' }, reasoning: { effort: 'low', exclude: true } }),
    });
  } catch { return reply({ error: 'No answer just now' }, 502); }
  if (!res.ok) return reply({ error: `No answer just now (${res.status})` }, 502);
  const j = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  const u = j.usage ?? {};
  await store.spend(day, typeof u.cost === 'number' ? u.cost : ((u.prompt_tokens ?? 0) * (model.priceIn ?? 1) + (u.completion_tokens ?? 0) * (model.priceOut ?? 5)) / 1e6);
  const text = fitNote(j.choices?.[0]?.message?.content);
  if (!text) return reply({ error: 'Not fit to show' }, 502);
  await store.accept(key, 'service', text, now);
  return reply({ text, day });
}

/**
 * A datasheet fetched for the app (a maker's site doesn't let a page elsewhere read its files):
 * a PDF only, up to MAX_PDF, a hundred a day each. A web page instead (a product page): the PDF it
 * links that best fits the part number, one step on.
 */
async function fetchDatasheet(url: URL, store: StoreApi, day: string, client: string, fetchFn: typeof fetch): Promise<Response> {
  const target = url.searchParams.get('url') ?? '';
  const mpn = (url.searchParams.get('mpn') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let u: URL;
  try { u = new URL(target); } catch { return reply({ error: 'Not an address' }, 400); }
  if (!fetchable(u)) return reply({ error: 'Not an address it fetches' }, 400);
  if (!(await store.take(day, client, 'fetch', FETCHES_PER_DAY)).ok) return reply({ error: `Enough datasheets for today (${FETCHES_PER_DAY} a day)` }, 429);
  const get = async (first: string): Promise<{ status: number; bytes: Uint8Array | null; final: string }> => {
    let href = first;
    for (let hop = 0; ; hop++) {
      let r: Response;
      try {
        r = await fetchFn(href, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_MS), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KoniumDesigner/1.0; +https://konium.app)', Accept: 'application/pdf,text/html;q=0.8,*/*;q=0.5' } });
      } catch { return { status: 504, bytes: null, final: href }; }
      // A redirect is followed by hand, each step held to the same rule as the first address
      const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (to) {
        let next: URL;
        try { next = new URL(to, href); } catch { return { status: 502, bytes: null, final: href }; }
        if (hop >= MAX_HOPS || !fetchable(next)) return { status: 502, bytes: null, final: href };
        href = next.href;
        continue;
      }
      if (!r.ok) return { status: r.status, bytes: null, final: href };
      // Read no further than a datasheet may be long, whatever the site says of its length
      const bytes = await bodyUpTo(r as unknown as Request, MAX_PDF);
      return bytes ? { status: 200, bytes, final: href } : { status: 413, bytes: null, final: href };
    }
  };
  const isPdf = (b: Uint8Array | null) => !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  // (handed on as a file to keep, never as a page of konium.app's)
  const pdf = (b: Uint8Array, final: string) => new Response(b as unknown as BodyInit, { status: 200, headers: {
    ...CORS, 'Content-Type': 'application/pdf', 'Access-Control-Expose-Headers': 'X-Source-Url', 'X-Source-Url': final,
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store',
  } });
  let r = await get(u.href);
  if (!r.bytes) return reply({ error: r.status === 413 ? 'Too large a file' : r.status === 504 ? 'The site did not answer in time' : `The site answered ${r.status}` }, r.status === 413 ? 413 : 502);
  if (isPdf(r.bytes)) return pdf(r.bytes, r.final);
  // A web page: the PDF it links that fits best (the part number in its address, else "datasheet"), one step on
  const html = new TextDecoder().decode(r.bytes.slice(0, 2_000_000));
  const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+?\.pdf(?:\?[^"']*)?)["']/gi)].map((m) => { try { const l = new URL(m[1]!.replace(/&amp;/g, '&'), r.final); return fetchable(l) ? l.href : ''; } catch { return ''; } }).filter(Boolean);
  const score = (h: string) => { const k = h.toLowerCase().replace(/[^a-z0-9]/g, ''); return (mpn && k.includes(mpn.slice(0, Math.max(5, mpn.length - 4))) ? 4 : 0) + (/datasheet|\/ds\/|_ds|-ds/i.test(h) ? 2 : 0); };
  const best = [...new Set(links)].sort((a, b) => score(b) - score(a))[0];
  if (!best) return reply({ error: 'No PDF there' }, 415);
  r = await get(best);
  if (!isPdf(r.bytes)) return reply({ error: 'No PDF there' }, 415);
  return pdf(r.bytes!, r.final);
}

/** How long a site has to answer, and how many redirects are followed. */
const FETCH_MS = 20_000, MAX_HOPS = 5;
/**
 * An address a datasheet is fetched from: the web's own ports, a host with a name (no bare
 * number, which is how machines inside a network are reached), and not this service's own site.
 * Held to at every step: the address asked for, each redirect, and the PDF a page links.
 */
export function fetchable(u: URL): boolean {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.port !== '' || u.username !== '' || u.password !== '') return false;
  const h = u.hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;       // a name with a dot: no IPv6 literal, no single label
  if (/^[0-9.]+$/.test(h) || /^0x/i.test(h)) return false;                                               // no IPv4 literal in any spelling
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return false;
  if (/(^|\.)konium\.app$/.test(h)) return false;
  return true;
}
