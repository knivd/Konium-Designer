/**
 * Konium Designer's built-in help (Help › User Guide, Help › Scripting Reference): books of
 * chapters of sections of blocks. Text is plain with three inline marks: `code`, **bold** and
 * [words](#section-id) (a link to a section in any book).
 */
import type { ApiOf, RunOn } from '../scripting/reference';
import type { Feature } from '../core/release';

export type Block =
  /** A paragraph. */
  | { p: string }
  /** A bulleted list. */
  | { list: string[] }
  /** Numbered steps. */
  | { steps: string[] }
  /** A tip or warning set apart. */
  | { note: string }
  /** A script (Scripting Reference): tested by running it. */
  | { code: string; run?: RunOn }
  /** A table; with codeCol its first column is code. */
  | { table: string[][]; head: string[]; codeCol?: boolean }
  /** A scripting API table (Scripting Reference): tested against the runtime. */
  | { api: ApiOf; rows: [string, string, string][] }
  /** Keys and what they do (a two-column table, the keys shown as keys). */
  | { keys: [string, string][] }
  /** A picture (src/help/pictures/<img>.webp, made by tests/tools/helpPictures.py): what it shows, said in full. */
  | { img: string; alt: string; caption?: string };

export interface Section {
  id: string; title: string; blocks: Block[];
  /** The feature it describes: left out of the book until that feature is switched on (core/release.ts). */
  feature?: Feature;
}
export interface Chapter { id: string; title: string; sections: Section[] }
export interface Book { id: 'guide' | 'scripting'; title: string; chapters: Chapter[] }
