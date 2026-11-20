/**
 * Models come and go on OpenRouter (and other endpoints): one a designer chose, or Konium's
 * service names, is retired and its successor arrives under a new id. A model's family is its id
 * without version numbers, dates, previews and route suffixes (google/gemini-3.8-flash and
 * google/gemini-3.9-flash are both google/gemini-#-flash; …-flash-lite is a family of its own); a
 * model no longer listed is replaced by the newest of its family that is, or the family's "latest"
 * alias (~google/gemini-flash-latest), so a choice carries on by itself. No imports: the service's
 * Worker uses this file as it is.
 */

/** Dates and route suffixes left out of an id (a dated snapshot, :batch, :free, -preview). */
function bare(id: string): string {
  return id.toLowerCase().trim()
    .replace(/:.*$/, '')
    .replace(/-(preview|exp|experimental|latest)(-\d+)*$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{4,8}$/, '');
}

/** A model's family: google/gemini-3.8-flash → google/gemini-#-flash. */
export function familyOf(id: string): string {
  return bare(id).replace(/\d+(\.\d+)*/g, '#');
}

/** OpenRouter's "latest" aliases: ~anthropic/claude-opus-latest, always the family's newest model. */
export const LATEST_ALIAS = /^~[\w.-]+\/[\w.-]+-latest$/;

/**
 * The families offered (their "latest" aliases): those that make a usable footprint of a hard
 * drawing, or come close, at a price for every day [est: a USB-C receptacle's datasheet, November
 * 2026 — Claude Opus and GPT Astra right, Gemini Pro, Gemini Flash, Claude Fable and GPT Sol close;
 * Fable and Astra left out for their price, the rest for falling short].
 */
export const OFFERED_FAMILIES = ['anthropic/claude-opus', 'openai/gpt-sol', 'google/gemini-pro', 'google/gemini-flash'];

/**
 * The cheap text model, for plain text work a cheap model does as well as a frontier one (a
 * specification split into requirements): never the model chosen for drawings. Followed to its
 * family's newest (qwen/qwen#-flash) once OpenRouter stops listing it, as every choice is
 * [est: Qwen3.8 Flash, November 2026: $0.15 in and $0.47 out a million tokens, against Gemini 3.8
 * Flash's $0.75 and $3.75; a 1M-token context].
 */
export const CHEAP_MODEL = 'qwen/qwen3.8-flash';

/** A model's id as shown: an alias without its ~. */
export const shownId = (id: string) => id.replace(/^~/, '');

/** The family an alias stands for, and a model's under it: anthropic/claude-opus-5.5 and ~anthropic/claude-opus-latest → anthropic/claude-opus. */
export function aliasKey(id: string): string {
  return familyOf(id).replace(/^~/, '').replace(/-#(?=-|$)/g, '').replace(/#/g, '');
}

/** A model's version numbers in order (gemini-3.8-flash → [3, 8]), for telling the newer of a family. */
export function versionOf(id: string): number[] {
  return (bare(id).match(/\d+(\.\d+)*/g) ?? []).flatMap((v) => v.split('.').map(Number));
}

/** Which is newer: positive when a is (by version, then by the date it was listed). */
export function compareModels(a: { id: string; created?: number }, b: { id: string; created?: number }): number {
  const va = versionOf(a.id), vb = versionOf(b.id);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d) return d;
  }
  // The same version: the one listed later
  return (a.created ?? 0) - (b.created ?? 0);
}

/**
 * The model to use for `id` from what is listed now: itself while listed, else the newest of its
 * family (not a :batch or other route), else null. `fits` narrows the candidates (pictures taken …).
 */
export function successor<T extends { id: string; created?: number }>(id: string, list: T[], fits: (m: T) => boolean = () => true): T | null {
  if (!id) return null;
  const same = list.find((m) => m.id === id);
  if (same) return fits(same) ? same : null;
  const fam = familyOf(id);
  const kin = list.filter((m) => !m.id.includes(':') && familyOf(m.id) === fam && fits(m));
  // None of its family listed: the family's "latest" alias (a list of aliases only: Claude Opus 5.5 → ~anthropic/claude-opus-latest)
  return kin.sort((a, b) => compareModels(b, a))[0] ?? list.find((m) => LATEST_ALIAS.test(m.id) && aliasKey(m.id) === aliasKey(id) && fits(m)) ?? null;
}

/**
 * Choices (by `mode:…` key) whose models are no longer listed, moved on to their successors — or,
 * `drop`, let go when there is none (the service's list is all there is): the new choices, or
 * null when none changed.
 */
export function followSuccessors<T extends { id: string; created?: number }>(choices: Record<string, string>, mode: string, list: T[], drop = false): Record<string, string> | null {
  if (!list.length) return null;
  let out: Record<string, string> | null = null;
  for (const [k, id] of Object.entries(choices)) {
    if (!k.startsWith(`${mode}:`) || !id || list.some((m) => m.id === id)) continue;
    const s = successor(id, list);
    if (s) (out ??= { ...choices })[k] = s.id;
    else if (drop) delete (out ??= { ...choices })[k];
  }
  return out;
}
