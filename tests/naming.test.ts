import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PAGE = import.meta.glob(['../index.html', '../public/*.{js,webmanifest,json,html}', '../public/app/*.js'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * The names Altium and Protel appear nowhere in the app's own words, only in Help › About's
 * statement, the Home page's (what Konium is for, with the trademark line) and the page's
 * description for search results and link previews. They stay where files need them (format signatures and type names written into
 * documents, never shown) and in code comments and module paths.
 */
const ALLOWED: [file: RegExp, text: RegExp][] = [
  [/About\.tsx$/, /./],
  [/Home\.tsx$/, /Altium Designer|Altium projects|Altium Ltd/],
  // File format signatures and type names, written into or read from files
  [/./, /Protel for Windows - Sch|Protel_Advanced_PCB|PcbType=ProtelPcb|DefaultPcbProtel/],
  [/(outjob\.ts|outjobRun\.ts|OutJobView\.tsx)$/, /'Protel'|\bProtel\|/],
  // A netlist file's first line, looked for to tell the format (26.187)
  [/netlistRead\.ts$/, /PROTEL NETLIST 2/],
  // An old settings value, read and replaced
  [/settings\.ts$/, /'altium'/],
  // Words an AI-written note may not use (the donation ask's checks)
  [/ai\/donate\.ts$/, /^const BANNED = /],
];

/** Code without comments and without module paths. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
  .replace(/(from|import)\s*\(?\s*'[^']*'/g, '');

describe('naming', () => {
  it("no 'Altium' or 'Protel' in the app's own words", () => {
    const hits: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    for (const [f, src] of Object.entries(SOURCES)) {
      const lines = code(src).split('\n');
      lines.forEach((l, i) => {
        // A whole word (identifiers such as protelNetlist and module folders don't count)
        if (!/(^|[^A-Za-z0-9_/])(altium|protel)(?![A-Za-z0-9_/])/i.test(l)) return;
        if (ALLOWED.some(([fr, tr]) => fr.test(f) && tr.test(l))) return;
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });
  it('nor in the page, its manifest or the service worker', () => {
    expect(Object.keys(PAGE).length).toBeGreaterThanOrEqual(3);
    // The page's description (search results, link previews) says what Konium is for
    // and its content for search engines and language models (between seo:start and seo:end, and the title)
    const own = (t: string) => t.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/g, '').split('\n').filter((l) => !/<title>/.test(l)).join('\n');
    for (const [f, text] of Object.entries(PAGE)) expect(`${f}: ${/altium|protel/i.test(own(text))}`).toBe(`${f}: false`);
  });
});
