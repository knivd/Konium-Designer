import { describe, expect, it } from 'vitest';
import ht from '../public/.htaccess?raw';
import cf from '../public/_headers?raw';

describe('the website\'s headers (26.056)', () => {
  it('lets a copy opened from disk read version.json and whats-new.json on Apache / LiteSpeed (.htaccess) and Cloudflare Pages (_headers)', () => {
    expect(ht).toMatch(/<FilesMatch "\^\(version\|whats-new\)\\\.json\$">/);
    expect(ht).toMatch(/Header set Access-Control-Allow-Origin "\*"/);
    expect(ht).toMatch(/Header set Cache-Control "no-cache"/);
    for (const f of ['/version.json', '/whats-new.json']) expect(cf).toContain(`${f}\n  Access-Control-Allow-Origin: *`);
  });
  it('the app\'s page and its service worker are always asked for afresh (26.066: else an upload showed the last version for a while)', async () => {
    expect(ht).toMatch(/<FilesMatch "\^sw\\\.js\$">\s*Header set Cache-Control "no-cache"/);
    // The pages and the app (one file, its checksum published) sent as they are: no-transform keeps Cloudflare from adding its analytics script
    expect(ht).toMatch(/<FilesMatch "\\\.html\$">\s*Header set Cache-Control "no-cache, no-transform"/);
    for (const f of ['/', '/index.html', '/app/', '/app/index.html']) expect(cf).toContain(`${f}\n  Cache-Control: no-cache, no-transform`);
    for (const f of ['/', '/index.html', '/sw.js', '/app/', '/app/index.html', '/app/sw.js']) expect(cf).toContain(`${f}\n  Cache-Control: no-cache`);
    for (const { default: sw } of [await import('../public/sw.js?raw'), await import('../public/app/sw.js?raw')]) expect(sw).toMatch(/fetch\(req\.url, \{ cache: 'no-cache'/);
  });
});
