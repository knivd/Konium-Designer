/**
 * How this copy of Konium is running and how to get or update it:
 * - served from konium.app in a browser tab: it can be installed (the browser's own install, where
 *   it offers one) or downloaded as the single file it is, to run from disk without a connection;
 * - installed, or opened from a downloaded file: nothing to get, only updates.
 * A newer version is noticed by asking for version.json (no cookies, no referrer, nothing about
 * the user or their files); a served copy then just reloads, a downloaded file is fetched again.
 */
import { signal } from '@preact/signals';
import { OFFLINE_NOTE, mayConnect, sealedOffline } from './network';

declare const __APP_VERSION__: string | undefined;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.000';
/** Where Konium lives on the web: the website, with the app itself at app/ (from 26.169). */
export const SITE = 'https://konium.app/';
/** Where the source is published (the website says the same: website/site.mjs, SOURCE). */
export const SOURCE_URL = 'https://github.com/knivd/konium-designer';
/** Konium Designer's licence and its copyright line, as the source's files carry them. */
export const LICENCE_NAME = 'GNU General Public License, version 3 or later';
export const COPYRIGHT = 'Copyright (C) 2026 Konstantin Dimitrov';
/** The website's download page (a downloaded copy's way to a newer one). */
export const DOWNLOAD_PAGE = `${SITE}download/`;

const hasWindow = typeof window !== 'undefined';
/** Served over http(s) (a tab or the installed app), as opposed to a file opened from disk. */
export const served = hasWindow && (location.protocol === 'http:' || location.protocol === 'https:');
export const fromFile = hasWindow && location.protocol === 'file:';
/**
 * Served, the website's own folder: the one above the app's when the app is at …/app/ (konium.app/app/),
 * else the page's own (a copy served from a folder of its own, the dev server). The version number,
 * What's New and the manifest are the website's, read from there.
 */
export const siteBase = (href: string = hasWindow ? location.href : SITE): string => new URL(/\/app\/(index\.html)?$/i.test(new URL(href).pathname) ? '../' : './', href).href;

/** Running as an installed app (its own window), not in a browser tab. */
export function installed(): boolean {
  if (!hasWindow) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || ['standalone', 'window-controls-overlay', 'minimal-ui'].some((m) => matchMedia?.(`(display-mode: ${m})`).matches);
}

export const online = signal(hasWindow ? navigator.onLine : false);
/** The browser's offer to install (Chromium keeps it for a later click). */
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
export const installOffer = signal<InstallPrompt | null>(null);
/** A newer version than this one, when one has been seen. */
export const latest = signal<{ version: string; notes?: string } | null>(null);

if (hasWindow) {
  addEventListener('online', () => { online.value = true; });
  addEventListener('offline', () => { online.value = false; });
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installOffer.value = e as InstallPrompt; });
  addEventListener('appinstalled', () => { installOffer.value = null; });
}

/** "Get Konium" belongs on screen: a browser tab, online, not already the installed app. */
export const canGet = (): boolean => served && online.value && !installed();

export async function install(): Promise<boolean> {
  const p = installOffer.value;
  if (!p) return false;
  await p.prompt();
  const { outcome } = await p.userChoice;
  if (outcome === 'accepted') installOffer.value = null;
  return outcome === 'accepted';
}

/** The website's visit counting, left out of a downloaded copy (which never contacts anyone). */
export const withoutSiteAnalytics = (html: string): string => html.replace(/[ \t]*<!-- Visit counts[\s\S]*?-->\s*<script[^>]*umami[^>]*><\/script>[ \t]*\r?\n?/i, '').replace(/[ \t]*<script[^>]*umami[^>]*><\/script>[ \t]*\r?\n?/gi, '');

/** Save this very page (one self-contained file) to run from disk. */
export async function downloadCopy(): Promise<void> {
  const url = new URL('./index.html', location.href);
  // Offline: the copy the service worker keeps (no connection), else not at all
  let page: string | null = null;
  if (!mayConnect('download') || sealedOffline()) {
    try { const hit = typeof caches !== 'undefined' ? await caches.match(url.href) : undefined; if (hit?.ok) page = await hit.text(); } catch { /* not kept */ }
    if (page === null) throw new Error(OFFLINE_NOTE);
  } else {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    page = await res.text();
  }
  const blob = new Blob([withoutSiteAnalytics(page)], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Konium-${APP_VERSION}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 26.033 → 26033: compares release numbers. */
export const versionNumber = (v: string): number => {
  const [y, b] = v.split('.');
  return Number(y) * 1000 + Number(b ?? 0);
};

/** Ask for the published version; a newer one goes to `latest`. Quietly does nothing offline or on failure. */
export async function checkForUpdate(): Promise<void> {
  if (!hasWindow || !online.value || !(served || fromFile) || !mayConnect('updates')) return;
  try {
    const url = `${served ? siteBase() : SITE}version.json`;
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
    const v = (await res.json()) as { version?: unknown; notes?: unknown };
    if (typeof v.version === 'string' && versionNumber(v.version) > versionNumber(APP_VERSION)) {
      latest.value = { version: v.version, notes: typeof v.notes === 'string' ? v.notes : undefined };
    }
  } catch { /* offline, blocked or not published: nothing to say */ }
}

/** Take the newer version: a served copy reloads (the page comes from the network first); a file copy goes to the website's download page. */
export function update(): void {
  // Served: the new service worker fetched and installed first (it takes over at once), then the page again
  if (served) {
    const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
    void (sw ? sw.getRegistration().then((r) => r?.update()).catch(() => undefined) : Promise.resolve()).finally(() => location.reload());
    return;
  }
  open(DOWNLOAD_PAGE, '_blank', 'noopener,noreferrer');
}
