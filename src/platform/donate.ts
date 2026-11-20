/**
 * Now and then, a modest ask for a donation, only for someone who uses Konium Designer often:
 * after more than ASK_AFTER starts, at one start in a hundred, never again within REST_DAYS (nor
 * within AFTER_GIVING_DAYS of the user saying they have chipped in: opening the Ko-fi page proves
 * nothing, and Konium Designer can't see a donation). The starts are counted in this browser only and
 * go nowhere. Online, the words are the day's wording from konium.app (written there by a small AI
 * model from fixed facts and checked here by the same rules before it shows); offline, or when
 * there is no fit note, Konium Designer's own. The ask shows either way.
 */
import { signal } from '@preact/signals';
import { readLocal, writeLocal } from '../core/storage';
import { mayConnect } from './network';
import { serviceUrl } from '../ai/client';
import { DONATE_TEXT, fitNote } from '../ai/donate';

export const ASK_AFTER = 40;
export const ASK_CHANCE = 0.01;
export const REST_DAYS = 5;
export const AFTER_GIVING_DAYS = 180;
/** How long after the start the ask waits, so it never stands in the way of opening work. */
export const ASK_DELAY_MS = 60_000;
const DAY = 86_400_000;
const KEY = 'donate';

interface Counted { starts: number; asked?: number; gave?: number }

function load(): Counted {
  try {
    const j = JSON.parse(readLocal(KEY) ?? '{}') as Partial<Counted>;
    return { starts: Number.isFinite(j.starts) ? Math.max(0, Math.floor(j.starts!)) : 0, asked: Number(j.asked) || undefined, gave: Number(j.gave) || undefined };
  } catch { return { starts: 0 }; }
}
const save = (c: Counted) => writeLocal(KEY, JSON.stringify(c));

/** The ask on screen (its words), or nothing. */
export const donateAsk = signal<{ text: string } | null>(null);

/** One more start counted; true when this one asks. */
export function countStart(now = Date.now(), roll = Math.random()): boolean {
  const c = load();
  c.starts += 1;
  save(c);
  return c.starts > ASK_AFTER && roll < ASK_CHANCE
    && (!c.asked || now - c.asked > REST_DAYS * DAY) && (!c.gave || now - c.gave > AFTER_GIVING_DAYS * DAY);
}

/** The day's note from konium.app, checked; null offline, or when it isn't there or isn't fit. */
export async function dayNote(fetchFn: typeof fetch = fetch, timeout = 5000): Promise<string | null> {
  if (!mayConnect('donate') || globalThis.navigator?.onLine === false) return null;
  try {
    const r = await fetchFn(`${serviceUrl()}/donate-note`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return fitNote(((await r.json()) as { text?: unknown }).text);
  } catch { return null; }
}

/** Show the ask now (the day's words if there are any), and remember when. */
export async function showDonateAsk(now = Date.now()): Promise<void> {
  const text = (await dayNote()) ?? DONATE_TEXT;
  const c = load();
  c.asked = now;
  save(c);
  donateAsk.value = { text };
}

/** "I've chipped in": the user says so (nothing can check it), so no asking for AFTER_GIVING_DAYS. */
export function gaveFromAsk(now = Date.now()): void {
  const c = load();
  c.gave = now;
  save(c);
  donateAsk.value = null;
}

export const closeDonateAsk = (): void => { donateAsk.value = null; };

/** At start: counted, and once in a while the ask, a minute later. */
export function startDonate(): void {
  if (countStart()) globalThis.setTimeout(() => { void showDonateAsk(); }, ASK_DELAY_MS);
}

/** The count so far (for the tests and the debug hook). */
export const donateCount = (): Counted => load();
