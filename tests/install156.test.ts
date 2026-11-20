import { describe, expect, it } from 'vitest';
import { browserOf, ownInstall } from '../src/app/dialogs/GetKonium';

/** 26.156: where each browser's own Install is, when it hasn't offered one to Konium Designer. */

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
};

describe('installing: the browser\'s own Install (26.156)', () => {
  it('tells the browsers apart: Edge and Opera are Chrome underneath, Safari is not', () => {
    expect(Object.fromEntries(Object.entries(UA).map(([k, ua]) => [k, browserOf(ua)]))).toEqual({ chrome: 'chrome', edge: 'edge', android: 'android', safari: 'safari', firefox: 'firefox', opera: 'other' });
  });

  it('says where each one\'s Install is, and sends the rest to Chrome or Edge', () => {
    expect(ownInstall(UA.chrome)).toContain('⋮ menu › Cast, save and share › Install page as app');
    expect(ownInstall(UA.edge)).toContain('⋯ menu › Apps › Install this site as an app');
    expect(ownInstall(UA.safari)).toContain('File › Add to Dock');
    expect(ownInstall(UA.firefox)).toMatch(/^Open konium\.app\/app in Chrome or Edge/);
    // No dashes in what users read
    for (const ua of Object.values(UA)) expect(ownInstall(ua)).not.toMatch(/[–—]/);
  });
});
