import { describe, expect, it } from 'vitest';
import { buildMail, headerWord, validEmail } from '../cloudflare/report/src/mime';
import { reportForm } from '../src/platform/report';
import { parseNews } from '../src/platform/whatsNew';

const LOG = import.meta.glob('../public/whats-new.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PICTURES = Object.keys(import.meta.glob('../public/whats-new/*.webp', { query: '?url', import: 'default', eager: true }));

describe('bug reports', () => {
  it('a report is a MIME email: text then attachments, headers safe', () => {
    const raw = buildMail({
      from: 'reports@konium.app', fromName: 'Konium bug report', to: 'someone@example.com', replyTo: 'me@example.org',
      subject: 'Crash on Ω\r\nBcc: x@y.z', text: 'It broke — badly', id: 'abc-123', date: new Date(Date.UTC(2026, 9, 28, 9, 0, 0)),
      files: [{ name: 'Board – 1.PcbDoc', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) }, { name: 'shot.png', type: 'image/png', bytes: new Uint8Array(100) }],
    });
    const [head, body] = raw.split('\r\n\r\n', 2) as [string, string];
    expect(head).toContain('From: "Konium bug report" <reports@konium.app>');
    expect(head).toContain('To: <someone@example.com>');
    expect(head).toContain('Reply-To: <me@example.org>');
    expect(head).not.toContain('Bcc:');                     // a line break in the subject can't add headers
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(head).toContain('Date: Wed, 28 Oct 2026 09:00:00 +0000');
    expect(body.length).toBeGreaterThan(0);
    expect(raw).toContain("filename*=UTF-8''Board%20%E2%80%93%201.PcbDoc");
    expect(raw).toContain('filename="shot.png"');
    expect(raw.trimEnd().endsWith('--')).toBe(true);
    expect(raw.split('\r\n').every((l) => l.length <= 998)).toBe(true);
    // The text part decodes back
    const part = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n--')[0]!.replace(/\r\n/g, '');
    expect(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0)))).toBe('It broke — badly');
  });
  it('addresses and header words', () => {
    expect(validEmail(' a.b@example.com ')).toBe('a.b@example.com');
    expect(validEmail('a b@example.com')).toBeUndefined();
    expect(validEmail('a@c')).toBeUndefined();
    expect(validEmail('x@y.z\r\nBcc: q@r.s')).toBeUndefined();
    expect(headerWord('plain')).toBe('plain');
    expect(headerWord('Ω')).toBe('=?UTF-8?B?zqk=?=');
  });
  it('the form carries the fields, the empty trap and the files', () => {
    const f = reportForm({ name: 'K', email: 'k@example.org', text: 'Hi', version: '26.046', diagnostics: 'd', files: [{ name: 'a.txt', type: 'text/plain', bytes: new Uint8Array([65]) }] });
    expect([f.get('text'), f.get('name'), f.get('email'), f.get('version'), f.get('diagnostics'), f.get('website')]).toEqual(['Hi', 'K', 'k@example.org', '26.046', 'd', '']);
    expect((f.getAll('file')[0] as File).name).toBe('a.txt');
  });
});

describe("What's New", () => {
  it('the published log reads, newest first, pictures resolved and only the site\'s own', () => {
    const r = parseNews({ releases: [
      { version: '26.044', date: '2026-10-27', title: 'Old', items: [{ text: 'a' }] },
      { version: '26.046', date: '2026-10-28', title: 'New', items: [{ text: 'b', image: 'whats-new/x.webp', alt: 'X' }, { text: 'c', image: 'javascript:alert(1)' }, { text: 'd', image: 'https://elsewhere.example/seen.png' }, { text: 'e', image: '//elsewhere.example/seen.png' }, { text: '' }, { nope: 1 }] },
      { version: 'bad', items: [] }, 'junk',
    ] }, 'https://konium.app/whats-new.json');
    expect(r.map((x) => x.version)).toEqual(['26.046', '26.044']);
    // (a picture at another site is not asked for: the log is the site's own, and so are its pictures)
    expect(r[0]!.items).toEqual([{ text: 'b', image: 'https://konium.app/whats-new/x.webp', alt: 'X' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]);
    expect(parseNews(null, 'https://konium.app/')).toEqual([]);
    // No dates: a release is known by its version
    expect(Object.keys(r[0]!)).toEqual(['version', 'title', 'items']);
  });
  it('the site\'s own log is well formed', () => {
    const raw = JSON.parse(LOG['../public/whats-new.json']!);
    const r = parseNews(raw, 'https://konium.app/whats-new.json');
    expect(r.length).toBe(raw.releases.length);
    for (const rel of r) for (const it of rel.items) if (it.image) expect(PICTURES).toContain(`../public/${it.image.replace('https://konium.app/', '')}`);
  });
});
