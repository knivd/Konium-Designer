import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '../src/core/settings';
import { CONNECTIONS, OFFLINE_POLICY, countsVisits, mayConnect } from '../src/platform/network';
import { parseNews } from '../src/platform/whatsNew';
import page from '../index.html?raw';
import sw from '../public/app/sw.js?raw';
import worker from '../cloudflare/report/src/index.ts?raw';

describe('connections (26.098)', () => {
  const saved = { offline: settings.offline, checkUpdates: settings.checkUpdates };
  afterEach(() => Object.assign(settings, saved));

  it('Offline stops every connection; updates off stops only updates, What\'s New and the visit count', () => {
    Object.assign(settings, { offline: false, checkUpdates: true });
    for (const c of CONNECTIONS) expect(mayConnect(c.use)).toBe(true);
    settings.checkUpdates = false;
    expect(mayConnect('updates')).toBe(false);
    for (const u of ['ai', 'parts', 'report', 'download'] as const) expect(mayConnect(u)).toBe(true);
    Object.assign(settings, { offline: true, checkUpdates: true });
    for (const u of ['updates', 'ai', 'parts', 'report', 'download'] as const) expect(mayConnect(u)).toBe(false);
  });

  it('Offline has the browser refuse everything from outside the page: every kind a page can load is named', () => {
    const said = new Map(OFFLINE_POLICY.split(';').map((d) => { const [name, ...v] = d.trim().split(/\s+/); return [name!, v] as const; }));
    for (const d of ['connect-src', 'img-src', 'font-src', 'media-src', 'frame-src', 'worker-src', 'child-src']) expect(said.get(d), d).toEqual(['data:', 'blob:']);
    // Scripts and styles: the page's own (inline, or made in memory) and no address
    expect(said.get('script-src')).toEqual(["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'data:', 'blob:']);
    expect(said.get('style-src')).toEqual(["'unsafe-inline'", 'data:', 'blob:']);
    for (const d of ['default-src', 'manifest-src', 'object-src', 'form-action']) expect(said.get(d), d).toEqual(["'none'"]);
    // No directive names an address, the site itself or everything
    expect(OFFLINE_POLICY).not.toMatch(/https?:|wss?:|'self'|\*/);
    // Every fetch directive there is has its say (26.200: scripts, styles, workers and the manifest were not named)
    for (const d of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src']) expect(said.has(d), d).toBe(true);
  });

  it('the visit count runs only at konium.app itself; the page carries no outside script', () => {
    expect(countsVisits('konium.app', true)).toBe(true);
    expect(countsVisits('localhost', true)).toBe(false);
    expect(countsVisits('konium.app', false)).toBe(false);
    expect(page).not.toMatch(/<script[^>]+src="https?:/);
  });

  it('the service worker keeps its version when told (Offline, or updates off), and keeps the flag', () => {
    expect(sw).toMatch(/if \(app && await pinned\(\)\) \{ const hit = await caches\.match\(scoped\('\.\/index\.html'\)\); if \(hit\) return hit; \}/);
    expect(sw).toMatch(/keys\.filter\(\(k\) => k\.startsWith\('konium-app-'\) && k !== CACHE\)/);
    expect(sw).toMatch(/const kept = \(await pinned\(\)\)/);
  });

  it("What's New carries a release's SHA-256 when it is one (64 hex digits), else none", () => {
    const h = 'af01b0d4e81f60dc74082d51b6d10e59578fef87218534891c40025201f181cd';
    const r = parseNews({ releases: [{ version: '26.098', title: 'A', sha256: h.toUpperCase(), items: [{ text: 'x' }] }, { version: '26.097', title: 'B', sha256: 'nope', items: [{ text: 'y' }] }] }, 'https://konium.app/whats-new.json');
    expect(r[0]).toEqual({ version: '26.098', title: 'A', sha256: h, items: [{ text: 'x' }] });
    expect(Object.keys(r[1]!)).toEqual(['version', 'title', 'items']);
  });

  it('a message to the author is mailed only, never filed with the reports, and needs an address', () => {
    expect(worker).toMatch(/repo && !contact \? fileReport/);
    expect(worker).toMatch(/if \(contact && !email\) return reply/);
  });
});
