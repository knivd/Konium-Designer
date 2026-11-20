/**
 * What's New on the Home page: Konium's feature log, kept on the website (whats-new.json with its
 * pictures in whats-new/), not in the app — every release adds to it. Read from beside the page
 * when Konium is served from the site (the website's folder, above the app's), from konium.app otherwise. Only text and pictures are
 * taken from it: nothing in it is run or shown as markup.
 */
import { signal } from '@preact/signals';
import { SITE, online, served, siteBase, versionNumber } from './distribution';
import { readLocal, writeLocal } from '../core/storage';
import { mayConnect, sealedOffline } from './network';
import { settings } from '../core/settings';

export interface NewsItem { text: string; image?: string; alt?: string; /** Where a cropped picture keeps its subject (Home's card): "x% y%" (else its top left). */ focus?: string }
/** sha256: the release's single file's SHA-256 (from 26.098), to check a downloaded copy against. */
export interface NewsRelease { version: string; title: string; sha256?: string; items: NewsItem[] }
export type NewsState = { state: 'loading' | 'offline' | 'failed' } | { state: 'off'; why: 'offline' | 'updates' } | { state: 'ok'; releases: NewsRelease[] };

export const news = signal<NewsState>({ state: 'loading' });

export const newsUrl = (): string => `${served ? siteBase() : SITE}whats-new.json`;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The log as published, checked: releases with a version, items with text, pictures only the site's own, over http(s). */
export function parseNews(raw: unknown, base: string): NewsRelease[] {
  const list = (raw as { releases?: unknown })?.releases;
  if (!Array.isArray(list)) return [];
  const out: NewsRelease[] = [];
  for (const r of list.slice(0, 500)) {
    const version = str((r as NewsRelease)?.version, 20);
    if (!version || !/^\d+\.\d+$/.test(version)) continue;
    const items: NewsItem[] = [];
    for (const i of Array.isArray((r as NewsRelease).items) ? (r as NewsRelease).items.slice(0, 50) : []) {
      const text = str(i?.text, 2000);
      if (!text) continue;
      const item: NewsItem = { text };
      const img = str(i?.image, 500);
      if (img) {
        try {
          const u = new URL(img, base);
          // (a picture is the site's own: the log names konium.app as the one place asked, whatever the log itself says)
          if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(base).origin) { item.image = u.href; item.alt = str(i?.alt, 300) ?? text.slice(0, 120); }
          const focus = str((i as NewsItem)?.focus, 20);
          if (focus && /^\d{1,3}% \d{1,3}%$/.test(focus)) item.focus = focus;
        } catch { /* not a picture's address */ }
      }
      items.push(item);
    }
    const sha256 = str((r as NewsRelease).sha256, 64)?.toLowerCase();
    out.push({ version, title: str((r as NewsRelease).title, 200) ?? '', ...(sha256 && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}), items });
  }
  return out.sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
}

let loading: Promise<void> | null = null;
/** Read the log (once a session, again after a failure when asked). */
export function loadNews(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    if (typeof window === 'undefined') return;
    // Switched off (Offline, or updates off): not asked for
    if (!mayConnect('updates')) { news.value = { state: 'off', why: settings.offline || sealedOffline() ? 'offline' : 'updates' }; loading = null; return; }
    if (!online.value && !served) { news.value = { state: 'offline' }; loading = null; return; }
    news.value = { state: 'loading' };
    try {
      const url = newsUrl();
      const res = await fetch(url, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(String(res.status));
      news.value = { state: 'ok', releases: parseNews(await res.json(), url) };
    } catch {
      news.value = { state: online.value ? 'failed' : 'offline' };
      loading = null;
    }
  })();
  return loading;
}

/** The newest release this browser has shown in What's New (newer ones are marked new). */
const SEEN = 'whatsNew.seen';
export const lastSeen = (): string => { try { return readLocal(SEEN) ?? ''; } catch { return ''; } };
export function markSeen(version: string): void { try { writeLocal(SEEN, version); } catch { /* not kept */ } }

