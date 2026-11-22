import { describe, expect, it } from 'vitest';
import { BOOKS, blockText } from '../src/help/books';
import { CONTEXT } from '../src/help/context';
import { MENUS } from '../src/app/commands';
import { commands } from '../src/core/commands';
import type { AccelNode } from '../src/core/keymap';
import { PANELS } from '../src/app/dock/panels';

const all = Object.values(BOOKS).flatMap((b) => b.chapters.flatMap((c) => c.sections.map((s) => ({ book: b, chapter: c, section: s }))));
const texts = all.flatMap(({ section }) => [section.title, ...section.blocks.flatMap(blockText)]);
const ids = new Set(all.map((x) => x.section.id));
const fs = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; statSync(p: string): { size: number } };
const PICTURES = 'src/help/pictures';
const pictureFiles = fs.readdirSync(PICTURES).filter((f) => f.endsWith('.webp'));

/** Captions that follow what is open (a project's kind and name): their fixed start. */
const CAPTIONS: Record<string, string[]> = { 'tools.erc': ['Compile PCB Project', 'Compile Integrated Library'] };
/** Every menu path in the menu bars, as lists of the labels each level can show (its own, or its command's, which a document's name may follow). */
function menuPaths(): string[][][] {
  const out: string[][][] = [];
  const walk = (n: AccelNode, path: string[][]) => {
    const own = n.label.replace(/\t.*$/, '').trim();
    const cmd = n.command ? commands.get(n.command)?.label?.replace(/&/g, '').trim() : undefined;
    const p = [...path, [own, ...(cmd && cmd !== own ? [cmd] : []), ...(n.command ? CAPTIONS[n.command] ?? [] : [])]];
    out.push(p);
    for (const c of n.children ?? []) walk(c, p);
  };
  for (const m of MENUS) if (m.inMenuBar) walk(m, []);
  return out;
}
/** A named path matches a menu path level by level: the same label, or one a document's name follows ("<project>" in the text standing for it). */
const matches = (named: string, actual: string[][]) => {
  const n = named.split(' › ');
  return actual.length === n.length && n.every((x, i) => actual[i]!.some((a) => {
    const w = x.replace(/<[^>]*>/g, '').trim();
    return a === x || (w.length > 2 && a.startsWith(w)) || (x.includes('<') && w.startsWith(a)) || w.startsWith(`${a.replace(/\.\.\.$/, '')} `);
  }));
};
const TOPS = ['File', 'Edit', 'View', 'Project', 'Place', 'Design', 'Tools', 'Route', 'Reports', 'Window', 'Help', 'Simulate', 'Autoroute'];

describe('the help (26.147)', () => {
  it('section and chapter ids are unique across the books; every link goes to one', () => {
    expect(ids.size).toBe(all.length);
    const chapters = Object.values(BOOKS).flatMap((b) => b.chapters.map((c) => c.id));
    expect(new Set(chapters).size).toBe(chapters.length);
    const links = texts.flatMap((t) => [...t.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!));
    expect(links.filter((l) => !ids.has(l) && !chapters.includes(l))).toEqual([]);
  });
  it('every picture is there and every picture is used; together they stay small', () => {
    const used = all.flatMap(({ section }) => section.blocks.flatMap((b) => ('img' in b ? [b.img] : [])));
    const files = pictureFiles.map((f) => f.slice(0, -5));
    expect(used.filter((u) => !files.includes(u))).toEqual([]);
    expect(files.filter((f) => !used.includes(f))).toEqual([]);
    for (const { section } of all) for (const b of section.blocks) if ('img' in b) expect(b.alt.length, b.img).toBeGreaterThan(40);
    const bytes = pictureFiles.reduce((n, f) => n + fs.statSync(`${PICTURES}/${f}`).size, 0);
    // (98 pictures at 26.175, the analysis tools' among them: about 27 KB each; 111 at 26.209, with the panels' tabs at the window's edges in most of them)
    expect(bytes).toBeLessThan(3_200_000);
  });
  it('the house rules: no long dashes, none of the names the app never uses', () => {
    const bad = texts.filter((t) => /[–—]|\bAltium\b|\bProtel\b|\bAD\b|\bKD\b/.test(t));
    expect(bad).toEqual([]);
  });
  it('every menu path it names (bold, with ›) is in the menus', () => {
    const paths = menuPaths();
    const named = [...new Set(texts.flatMap((t) => [...t.matchAll(/\*\*([^*]+›[^*]+)\*\*/g)].map((m) => m[1]!.trim())))];
    const menus = named.filter((p) => TOPS.includes(p.split(' › ')[0]!));
    expect(menus.filter((p) => !paths.some((a) => matches(p, a)))).toEqual([]);
  });
  it('F1 goes to sections that exist, for panels that exist', () => {
    const panels = new Set(PANELS.map((p) => p.id));
    for (const [k, v] of Object.entries(CONTEXT)) {
      expect(ids.has(v), `${k} → ${v}`).toBe(true);
      if (k.startsWith('panel:')) expect(panels.has(k.slice(6).split('@')[0]!), k).toBe(true);
    }
  });
});
