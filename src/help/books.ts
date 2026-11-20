/** The help books (Help › User Guide, Help › Scripting Reference), and finding a section in them. */
import type { Block, Book, Chapter, Section } from './types';
import { BOOK_TITLES } from './titles';
import { GUIDE_CHAPTERS } from './guide';
import { REFERENCE } from '../scripting/reference';
import { featureOn } from '../core/release';

export type BookId = Book['id'];

export const BOOKS: Record<BookId, Book> = {
  // (a section on a feature not yet switched on is left out until it is)
  guide: { id: 'guide', title: BOOK_TITLES.guide, chapters: GUIDE_CHAPTERS.map((c) => (c.sections.some((s) => s.feature && !featureOn(s.feature)) ? { ...c, sections: c.sections.filter((s) => !s.feature || featureOn(s.feature)) } : c)) },
  scripting: { id: 'scripting', title: BOOK_TITLES.scripting, chapters: [{ id: 'scripting', title: BOOK_TITLES.scripting, sections: REFERENCE }] },
};

export interface Found { book: Book; chapter: Chapter; section: Section }

/** Where a section is, in any book. */
export function findSection(id: string): Found | null {
  for (const book of Object.values(BOOKS)) for (const chapter of book.chapters) for (const section of chapter.sections) if (section.id === id) return { book, chapter, section };
  return null;
}

/** A block's words (for searching). */
export function blockText(b: Block): string[] {
  if ('p' in b) return [b.p];
  if ('note' in b) return [b.note];
  if ('list' in b) return b.list;
  if ('steps' in b) return b.steps;
  if ('code' in b) return [b.code];
  if ('table' in b) return [...b.head, ...b.table.flat()];
  if ('keys' in b) return b.keys.flat();
  if ('img' in b) return [b.alt, b.caption ?? ''];
  return b.rows.flat();
}

/** A section's words, its title first. */
export function sectionWords(s: Section): string { return [s.title, ...s.blocks.flatMap(blockText)].join('\n'); }

/** Plain text of inline marks: `code` → code, **bold** → bold, [words](#id) → words. */
export const plain = (t: string): string => t.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\(#[^)]+\)/g, '$1');

/** Sections with every word searched for: the title's matches first. */
export function searchBook(book: Book, q: string): Found[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: (Found & { score: number })[] = [];
  for (const chapter of book.chapters) for (const section of chapter.sections) {
    const text = plain(sectionWords(section)).toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    const title = section.title.toLowerCase();
    hits.push({ book, chapter, section, score: words.filter((w) => title.includes(w)).length });
  }
  return hits.sort((a, b) => b.score - a.score);
}
