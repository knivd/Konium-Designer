/**
 * Konium's AI connections (Preferences › System › AI), all off until switched on and every job
 * started by hand:
 * - the Konium service: jobs posted to konium.app/api/ai, whose Worker runs them on the models the
 *   developer chose and pays for, within a daily allowance (cloudflare/ai);
 * - your own key: OpenRouter (any model, one key), or any endpoint that speaks OpenAI's chat
 *   completions (OpenAI, Google's OpenAI-compatible endpoint, DeepSeek, Mistral, Groq …). The key
 *   stays in this browser (not in the settings, so never in an exported settings file) and goes
 *   only to that endpoint, straight from the browser;
 * - a local model: Ollama, LM Studio, llama.cpp's server, vLLM … on this computer or the network.
 * Each job asks for JSON and checks the answer (jobs.ts); what it cost is added to this month's
 * usage.
 */
import { OFFLINE_NOTE, mayConnect } from '../platform/network';
import { settings, updateSettings, type Settings } from '../core/settings';
import { JOBS, citations, parseJsonAnswer, withSources, type JobKind, type JobSpec, type Message, type Part } from './jobs';
import { CHEAP_MODEL, LATEST_ALIAS, OFFERED_FAMILIES, aliasKey, successor } from './models';

export type AiMode = 'off' | 'konium' | 'key' | 'local';
export type Role = 'text' | 'vision';

export interface ModelInfo {
  id: string;
  name: string;
  /** Takes pictures: true, false, or null when the endpoint doesn't say (a guess by name is in `visionGuess`). */
  vision: boolean | null;
  visionGuess?: boolean;
  /** US dollars per million tokens, when known. */
  priceIn?: number;
  priceOut?: number;
  context?: number;
  /** Konium service: the roles the developer chose it for. */
  roles?: Role[];
  /** Konium service: how much of the daily allowance one of its jobs uses (1 for the cheapest model; from 26.099). */
  weight?: number;
}

export interface Usage { in: number; out: number; cost: number | null }
export interface JobResult<O> { value: O; usage: Usage; model: string; cached?: { acceptedBy: number } }

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const LOCAL_PRESETS: [string, string][] = [['Ollama', 'http://localhost:11434/v1'], ['LM Studio', 'http://localhost:1234/v1'], ['llama.cpp', 'http://localhost:8080/v1']];

/** The Konium service: on konium.app itself the same site, elsewhere (a downloaded copy) konium.app. */
export function serviceUrl(): string {
  try {
    const own = globalThis.localStorage?.getItem('konium.aiService');
    if (own) return own.replace(/\/+$/, '');
  } catch { /* storage blocked */ }
  const host = globalThis.location?.host ?? '';
  return /(^|\.)konium\.app$/.test(host) ? `${globalThis.location.origin}/api/ai` : 'https://konium.app/api/ai';
}

/* ─── The key, kept in this browser only ─────────────────────────────────────────────── */

const KEY = 'konium.aiKey';
export function aiKey(): string { try { return globalThis.localStorage?.getItem(KEY) ?? ''; } catch { return ''; } }
export function setAiKey(k: string): void {
  try { if (k.trim()) globalThis.localStorage?.setItem(KEY, k.trim()); else globalThis.localStorage?.removeItem(KEY); } catch { /* storage blocked */ }
}

/* ─── Usage this month ───────────────────────────────────────────────────────────────── */

const USAGE = 'konium.aiUsage';
export interface MonthUsage { month: string; jobs: number; in: number; out: number; cost: number }
const thisMonth = () => new Date().toISOString().slice(0, 7);
export function monthUsage(): MonthUsage {
  try {
    const u = JSON.parse(globalThis.localStorage?.getItem(USAGE) ?? 'null') as MonthUsage | null;
    if (u && u.month === thisMonth()) return u;
  } catch { /* none yet */ }
  return { month: thisMonth(), jobs: 0, in: 0, out: 0, cost: 0 };
}
function addUsage(u: Usage): void {
  const m = monthUsage();
  m.jobs++; m.in += u.in; m.out += u.out; m.cost += u.cost ?? 0;
  try { globalThis.localStorage?.setItem(USAGE, JSON.stringify(m)); } catch { /* storage blocked */ }
}

/* ─── Endpoints ──────────────────────────────────────────────────────────────────────── */

export interface Connection { mode: AiMode; base: string; key: string; openrouter: boolean }
/** The settings a connection is made from (the applied ones, or the Preferences window's draft). */
export type AiSettings = Pick<Settings, 'aiMode' | 'aiProvider' | 'aiCustomBase' | 'aiLocalBase' | 'aiModels' | 'aiShareCache'>;

export function connection(mode: AiMode = settings.aiMode, s: AiSettings = settings): Connection {
  if (mode === 'key') {
    const openrouter = s.aiProvider === 'openrouter';
    return { mode, base: openrouter ? OPENROUTER : s.aiCustomBase.trim().replace(/\/+$/, ''), key: aiKey(), openrouter };
  }
  if (mode === 'local') return { mode, base: s.aiLocalBase.trim().replace(/\/+$/, ''), key: '', openrouter: false };
  return { mode, base: serviceUrl(), key: '', openrouter: false };
}

/** Where a job goes, in words, for the "what is sent" note. */
export function destination(c: Connection = connection()): string {
  if (c.mode === 'konium') return 'the Konium service (konium.app, then OpenRouter)';
  if (c.mode === 'key') return c.openrouter ? 'OpenRouter, with your key' : `${hostOf(c.base)}, with your key`;
  if (c.mode === 'local') return `your model at ${hostOf(c.base)}`;
  return 'nowhere (AI is off)';
}
const hostOf = (u: string) => { try { return new URL(u).host || u; } catch { return u || '(no address)'; } };

const headers = (c: Connection): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}),
  // OpenRouter's app attribution (no personal data)
  ...(c.openrouter ? { 'HTTP-Referer': 'https://konium.app', 'X-Title': 'Konium Designer' } : {}),
});

/** A failure in plain words: what to check (`gone`: the model asked for isn't there any more). */
export class AiError extends Error { gone = false; }

async function call(c: Connection, path: string, init: RequestInit = {}): Promise<Response> {
  if (!mayConnect('ai')) throw new AiError(OFFLINE_NOTE);
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, { ...init, headers: { ...headers(c), ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    if (c.mode === 'local') throw new AiError(`Can't reach ${c.base}. Is the model server running, and does it take requests from Konium Designer? Ollama: set OLLAMA_ORIGINS=* before starting it; LM Studio: switch on Enable CORS. From konium.app a model on another computer needs https (or use the downloaded Konium Designer).`);
    if (c.mode === 'konium') throw new AiError('Can\'t reach the Konium service: check the internet connection.');
    throw new AiError(`Can't reach ${hostOf(c.base)}: check the address and the internet connection.`);
  }
  return res;
}

async function failure(c: Connection, res: Response): Promise<AiError> {
  let detail = '';
  try {
    const body = await res.text();
    try { const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }; detail = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? body; } catch { detail = body; }
  } catch { /* no body */ }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (c.mode === 'konium') return new AiError(/^Not a job the service runs/.test(detail) ? NOT_YET : detail || `The Konium service answered ${res.status}`);
  if (res.status === 401 || res.status === 403) return new AiError(`The key was refused (${res.status})${detail ? `: ${detail}` : ''}`);
  if (res.status === 402) return new AiError(`No credit left on the key${detail ? `: ${detail}` : ''}`);
  if (res.status === 429) return new AiError(`Too many requests just now: try again shortly${detail ? ` (${detail})` : ''}`);
  const e = new AiError(`${hostOf(c.base)} answered ${res.status}${detail ? `: ${detail}` : ''}`);
  // A model retired (or never there): its successor is looked for
  e.gone = (res.status === 404 || res.status === 400) && /model|no endpoints/i.test(detail) && /not (a )?valid|not found|no endpoints|does ?n[o']t exist|unknown|invalid|not available|deprecated|retired|no longer/i.test(detail);
  return e;
}

/* ─── Models ─────────────────────────────────────────────────────────────────────────── */

/** Model names that usually take pictures [est: by name, for endpoints that don't say]. */
const VISION_NAMES = /(vision|[-_.]vl\b|vl[-_:]|llava|bakllava|gemma-?3|gemma3|qwen2\.5-?vl|qwen3-?vl|minicpm-?v|pixtral|moondream|llama-?4|llama3\.2-vision|granite.*vision|mistral-small-3|internvl|gpt-4o|gpt-4\.1|gpt-5|gemini|claude)/i;

export interface ServiceConfig {
  models: ModelInfo[]; defaults: Partial<Record<Role | 'model', string>>; allowance: { jobs: number; left: number; weighed?: boolean }; shareCache: boolean;
  /** The cheap text model, and the jobs it does whatever model is chosen (a service from before 26.142 doesn't say). */
  cheap?: ModelInfo; cheapJobs?: JobKind[];
  /** The jobs the service runs (a service from before 26.076 doesn't say). */
  jobs?: JobKind[];
}

/** The job tokens a job on this model takes from the Konium service's daily allowance (dearer models more; 1 when the service doesn't say). */
export const jobUnits = (m?: ModelInfo | null): number => Math.max(1, Math.round(m?.weight ?? 1));
/** "Free: 13 job tokens on Claude Opus (14 of 25 left today)". */
export const jobTokens = (n: number): string => `${n} job token${n === 1 ? '' : 's'}`;
export function allowanceNote(a: ServiceConfig['allowance'] | undefined, m?: ModelInfo | null): string {
  return `Free: ${jobTokens(jobUnits(m))}${m && a?.weighed ? ` on ${m.name}` : ''}${a ? ` (${a.left} of ${a.jobs} left today)` : ''}`;
}

/** Does the Konium service run this job? One deployed before the job was added doesn't; one that doesn't say is tried (and says so if it can't). */
export const serviceRuns = (cfg: Pick<ServiceConfig, 'jobs'>, kind: JobKind) => !cfg.jobs || cfg.jobs.includes(kind);
export const NOT_YET = 'The Konium service doesn\'t do this job yet (it runs an earlier Konium Designer\'s jobs): try again later, or use your own key or a local model (Preferences › System › AI)';

export async function serviceConfig(): Promise<ServiceConfig> {
  const c = connection('konium');
  const res = await call(c, '/config');
  if (!res.ok) throw await failure(c, res);
  return await res.json() as ServiceConfig;
}

export async function listModels(mode: AiMode = settings.aiMode, s: AiSettings = settings, all = false): Promise<ModelInfo[]> {
  if (mode === 'konium') return (await serviceConfig()).models;
  const c = connection(mode, s);
  if (!c.base) throw new AiError(mode === 'local' ? 'Give the model server\'s address' : 'Give the endpoint\'s address');
  const res = await call(c, '/models');
  if (!res.ok) throw await failure(c, res);
  const body = await res.json() as { data?: unknown[]; models?: unknown[] };
  const rows = (body.data ?? body.models ?? []) as Record<string, unknown>[];
  const out = rows.map((m): ModelInfo => {
    const id = String(m.id ?? m.name ?? m.model ?? '');
    const arch = m.architecture as { input_modalities?: string[] } | undefined;
    const pricing = m.pricing as { prompt?: string; completion?: string } | undefined;
    const perM = (x: string | undefined) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined; };
    const vision = arch?.input_modalities ? arch.input_modalities.includes('image') : null;
    return {
      id, name: String(m.name ?? id).replace(/^~\s*/, ''), vision, ...(vision === null ? { visionGuess: VISION_NAMES.test(id) } : {}),
      priceIn: perM(pricing?.prompt), priceOut: perM(pricing?.completion),
      context: typeof m.context_length === 'number' ? m.context_length : undefined,
    };
  }).filter((m) => m.id);
  // OpenRouter: the "latest" aliases (each a family's newest, never retired) of the families Konium offers, taking pictures, the cheapest first
  if (mode === 'key' && s.aiProvider === 'openrouter' && !all) {
    return out.filter((m) => LATEST_ALIAS.test(m.id) && OFFERED_FAMILIES.includes(aliasKey(m.id)) && m.vision)
      .sort((a, b) => (a.priceOut ?? 0) - (b.priceOut ?? 0) || (a.priceIn ?? 0) - (b.priceIn ?? 0) || a.id.localeCompare(b.id));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The model chosen for a mode: one model does every job, survey to footprint ('' for the service's
 * default). Choices from before 26.078 (one for text, one for drawings) count, the drawings one first.
 */
export function modelFor(mode: AiMode = settings.aiMode, chosen: Record<string, string> = settings.aiModels): string {
  return chosen[`${mode}:model`] || chosen[`${mode}:vision`] || chosen[`${mode}:text`] || '';
}
/** The choices with this mode's model set (its older per-role choices dropped). */
export function withModel(chosen: Record<string, string>, mode: AiMode, id: string): Record<string, string> {
  const out = Object.fromEntries(Object.entries(chosen).filter(([k]) => k !== `${mode}:text` && k !== `${mode}:vision`));
  if (id) out[`${mode}:model`] = id; else delete out[`${mode}:model`];
  return out;
}

/* ─── Running a job ──────────────────────────────────────────────────────────────────── */

export interface RunOptions {
  mode?: AiMode;
  model?: string;
  /** Konium service: the shared cache's key for this job's answer (the datasheet's fingerprint and what was asked). */
  cacheKey?: string;
  /** Read again even when the shared cache has an answer. */
  fresh?: boolean;
  signal?: AbortSignal;
  /** Settings to use instead of the applied ones (the Preferences window's draft). */
  cfg?: AiSettings;
}

export async function runJob<I, O>(spec: JobSpec<I, O>, input: I, o: RunOptions = {}): Promise<JobResult<O>> {
  const cfg = o.cfg ?? settings;
  const mode = o.mode ?? cfg.aiMode;
  if (mode === 'off') throw new AiError('AI is off: switch it on in Preferences › System › AI');
  const c = connection(mode, cfg);
  const role = spec.roleOf?.(input) ?? spec.role;
  // One model for every job (the service puts plain text work a cheap model does as well on its cheap text model)
  const model = o.model ?? modelFor(mode, cfg.aiModels);
  if (mode === 'konium') return serviceJob(c, spec, input, model, { ...o, cfg });
  // With an OpenRouter key too: on the cheap text model, the one chosen if that fails
  if (spec.cheap && role === 'text' && !o.model && mode === 'key' && c.openrouter) {
    try { return await cheapJob(c, spec, input, mode, cfg, o.signal); } catch (e) { if ((e as Error).name === 'AbortError' || o.signal?.aborted) throw e; }
  }
  if (!model) throw new AiError('Choose a model in Preferences › System › AI');
  if (mode === 'key' && !c.key) throw new AiError('Give your key in Preferences › System › AI');
  // Searching the web: OpenRouter's plugin (a local model or another endpoint has none)
  if (spec.web && !c.openrouter) throw new AiError('Searching the web needs the Konium service or an OpenRouter key');
  let used = model, got: { text: string; usage: Usage; sources?: string[] };
  try { got = await chat(c, model, spec.messages(input), spec.maxTokens, o.signal, spec.effort, spec.web); } catch (e) {
    // The model retired: the newest of its family in its place, kept as the choice from now on
    if (!(e instanceof AiError) || !e.gone) throw e;
    const list = await listModels(mode, cfg).catch(() => [] as ModelInfo[]);
    const next = successor(model, list, (m) => role !== 'vision' || m.vision !== false);
    if (!next || next.id === model) throw e;
    used = next.id;
    got = await chat(c, used, spec.messages(input), spec.maxTokens, o.signal, spec.effort, spec.web);
    if (cfg === settings) updateSettings({ aiModels: withModel(settings.aiModels, mode, used) });
  }
  const { text, usage } = got;
  addUsage(usage);
  let value: O;
  try { value = spec.check(spec.web ? withSources(text, got.sources ?? []) : parseJsonAnswer(text), input); } catch (e) {
    throw new AiError(`The model's answer couldn't be used (${(e as Error).message}): try again, or another model`);
  }
  return { value, usage, model: used };
}

/** One chat completion asking for JSON (a server that won't take response_format is asked again without it). */
export async function chat(c: Connection, model: string, messages: Message[], maxTokens: number, signal?: AbortSignal, effort: 'low' | 'medium' | 'high' = 'low', web = 0): Promise<{ text: string; usage: Usage; sources: string[] }> {
  const body = (json: boolean) => JSON.stringify({
    model, messages, max_tokens: maxTokens, temperature: 0,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    // OpenRouter: what it cost, and as much reasoning as the job asks (billed as output; little unless said); a web search first when asked
    ...(c.openrouter ? { usage: { include: true }, reasoning: { effort, exclude: true }, ...(web ? { plugins: [{ id: 'web', max_results: web }] } : {}) } : {}),
  });
  let res = await call(c, '/chat/completions', { method: 'POST', body: body(true), signal });
  if (res.status === 400) {
    const t = await res.clone().text().catch(() => '');
    if (/response_format|json_object|json_schema/i.test(t)) res = await call(c, '/chat/completions', { method: 'POST', body: body(false), signal });
  }
  if (!res.ok) throw await failure(c, res);
  const j = await res.json() as { choices?: { message?: { content?: string | Part[]; annotations?: unknown[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  const content = j.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
  if (!text) throw new AiError('The model gave no answer');
  const u = j.usage ?? {};
  return { text, usage: { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0, cost: typeof u.cost === 'number' ? u.cost : c.mode === 'local' ? 0 : null }, sources: citations(j.choices?.[0]?.message?.annotations) };
}

/** The cheap text model on OpenRouter for this mode: CHEAP_MODEL while listed, else its family's newest (null: none). */
export async function cheapModelInfo(mode: AiMode = settings.aiMode, cfg: AiSettings = settings): Promise<ModelInfo | null> {
  if (mode === 'konium') return (await serviceConfig()).cheap ?? null;
  const list = await listModels(mode, cfg, true);
  return successor(CHEAP_MODEL, list.filter((m) => !LATEST_ALIAS.test(m.id)));
}

/** A cheap job on the cheap text model (CHEAP_MODEL; once retired, its family's newest). */
let cheapNow = CHEAP_MODEL;
async function cheapJob<I, O>(c: Connection, spec: JobSpec<I, O>, input: I, mode: AiMode, cfg: AiSettings, signal?: AbortSignal): Promise<JobResult<O>> {
  let used = cheapNow, got: { text: string; usage: Usage; sources?: string[] };
  try { got = await chat(c, used, spec.messages(input), spec.maxTokens, signal, spec.effort); } catch (e) {
    if (!(e instanceof AiError) || !e.gone) throw e;
    const next = await cheapModelInfo(mode, cfg).catch(() => null);
    if (!next || next.id === used) throw e;
    used = next.id;
    got = await chat(c, used, spec.messages(input), spec.maxTokens, signal, spec.effort);
    // (Kept for this session: the next job goes straight to it)
    cheapNow = used;
  }
  addUsage(got.usage);
  return { value: spec.check(parseJsonAnswer(got.text), input), usage: got.usage, model: used };
}

async function serviceJob<I, O>(c: Connection, spec: JobSpec<I, O>, input: I, model: string, o: RunOptions): Promise<JobResult<O>> {
  const res = await call(c, '/job', {
    method: 'POST', signal: o.signal,
    body: JSON.stringify({ job: spec.kind, input, ...(model ? { model } : {}), ...(o.cacheKey && (o.cfg ?? settings).aiShareCache ? { cacheKey: o.cacheKey, fresh: !!o.fresh } : {}) }),
  });
  if (!res.ok) throw await failure(c, res);
  const j = await res.json() as { answer?: unknown; raw?: string; problem?: string; usage?: Usage; model?: string; cached?: { acceptedBy: number }; sources?: string[]; accept?: string };
  // The service's pass for keeping what is accepted of this reading (shareAccepted sends it back)
  if (o.cacheKey && typeof j.accept === 'string') { passes.set(`${spec.kind}:${o.cacheKey}`, j.accept); if (passes.size > 400) passes.delete(passes.keys().next().value!); }
  const usage = j.usage ?? { in: 0, out: 0, cost: null };
  if (!j.cached) addUsage({ ...usage, cost: 0 });
  // Checked here too: the app trusts no answer it hasn't looked at (and reads what the service couldn't, by its own rules)
  let value: O;
  try { value = spec.check(j.raw !== undefined ? (spec.web ? withSources(j.raw, j.sources ?? []) : parseJsonAnswer(j.raw)) : j.answer, input); } catch (e) {
    throw new AiError(`The model's answer couldn't be used (${(e as Error).message}): try again, or another model`);
  }
  return { value, usage, model: j.model ?? model, ...(j.cached ? { cached: j.cached } : {}) };
}

/** The service's passes for readings made in this session: only a reading the service made for this user may be kept for others. */
const passes = new Map<string, string>();

/**
 * Konium service: an answer the designer accepted, kept for others reading the same datasheet
 * (when sharing is on). Only what the service read for this user in this session goes (it gave
 * a pass with the reading); anything else stays here.
 */
export async function shareAccepted(kind: JobKind, cacheKey: string, value: unknown): Promise<void> {
  if (settings.aiMode !== 'konium' || !settings.aiShareCache) return;
  const pass = passes.get(`${kind}:${cacheKey}`);
  if (!pass) return;
  const c = connection('konium');
  try { await call(c, '/accept', { method: 'POST', body: JSON.stringify({ job: kind, cacheKey, answer: value, pass }) }); } catch { /* best effort */ }
}

/** A connection test: the smallest job, timed. */
export async function testConnection(mode: AiMode = settings.aiMode, cfg: AiSettings = settings): Promise<string> {
  const t = performance.now();
  const r = await runJob(JOBS.ping as JobSpec<Record<string, never>, unknown>, {}, { mode, cfg });
  return `${r.model || 'The service'} answered in ${((performance.now() - t) / 1000).toFixed(1)} s`;
}

/* ─── Size and cost before sending ───────────────────────────────────────────────────── */

/** Tokens for a job's input [est: about 3.5 characters a token; a page picture about 1,500 tokens]. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0, pictures = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const p of m.content) { if (p.type === 'text') chars += p.text.length; else pictures++; }
  }
  return Math.ceil(chars / 3.5) + pictures * 1500;
}

/** What a job may cost on a model with known prices (input, and half the answer allowance), in US dollars; null when unknown. */
export function estimateCost(tokensIn: number, maxOut: number, m?: ModelInfo): number | null {
  if (!m || m.priceIn === undefined || m.priceOut === undefined) return null;
  return (tokensIn * m.priceIn + (maxOut / 2) * m.priceOut) / 1e6;
}

export const money = (usd: number | null) => (usd === null ? 'unknown' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
