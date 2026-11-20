/**
 * A specification's text, for splitting into requirements: a text or Markdown file as it is, a
 * Word document's paragraphs (headings marked with #, list items with -, a table's rows with its
 * cells between |, pictures as numbered markers, the pictures with them), and a PDF's text page by
 * page.
 */
import { unzipEntries, xmlText } from '../formats/xlsxRead';

/** The file types read, as a file input takes them. */
export const SPEC_ACCEPT = '.txt,.md,.markdown,.text,.docx,.pdf';

/** A picture in a specification: its number in the text ([Picture 3]), and the file. */
export interface SpecPicture { n: number; name: string; type: string; bytes: Uint8Array }
export interface SpecDoc { text: string; pictures: SpecPicture[] }

const SHOWN: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

/** A paragraph's runs as text: tabs and breaks kept, each picture as its marker ([Picture 3]). */
function runsOf(xml: string, picture: (rid: string) => string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<a:blip\b[^>]*r:embed="([^"]+)"|<v:imagedata\b[^>]*r:id="([^"]+)"/g)]
    .map((m) => (m[1] !== undefined ? xmlText(m[1]) : m[2] || m[3] ? picture((m[2] || m[3])!) : m[0].startsWith('<w:tab') ? '\t' : '\n')).join('').replace(/(\[Picture \d+\])\1+/g, '$1');
}

/** A paragraph's text, a heading's (Heading 1, Title …) after its level of #, a list item's after -. */
function paragraph(xml: string, picture: (rid: string) => string): string {
  const text = runsOf(xml, picture).replace(/[ \t]+$/g, '');
  if (!text.trim()) return '';
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(xml)?.[1] ?? '';
  const h = /^(?:heading|berschrift|titre|titolo|kop|rubrik)\s*(\d)/i.exec(style.replace(/^\W*/, '')) ?? (/^title$/i.test(style) ? ['', '1'] : null);
  if (h) return `${'#'.repeat(Math.min(6, Number(h[1]) || 1))} ${text.trim()}`;
  if (/<w:numPr>/.test(xml) || /^list/i.test(style)) return `- ${text.trim()}`;
  return text;
}

/**
 * A Word document's text (word/document.xml), in order: paragraphs, tables row by row as Markdown
 * rows, and its pictures (PNG, JPEG, GIF, BMP, WebP) as numbered markers, with the pictures
 * themselves. Drawings in other forms (EMF, WMF, shapes) are marked [Drawing], not numbered.
 */
export async function docxDoc(bytes: Uint8Array): Promise<SpecDoc> {
  const entries = unzipEntries(bytes);
  const e = entries.find((x) => x.name === 'word/document.xml');
  if (!e) throw new Error('Not a Word document (.docx)');
  // A drawing's fallback for older Word (the same picture again, or an EMF of it) left out
  const xml = new TextDecoder().decode(await e.data()).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const relsEntry = entries.find((x) => x.name === 'word/_rels/document.xml.rels');
  const rels = new Map<string, string>();
  if (relsEntry) for (const m of new TextDecoder().decode(await relsEntry.data()).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1], target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target && !/TargetMode="External"/.test(m[0])) rels.set(id, target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/[^/]+\/\.\.\//g, '/'));
  }
  const pictures: SpecPicture[] = [];
  const byRid = new Map<string, number>();
  const want: { n: number; path: string }[] = [];
  const picture = (rid: string): string => {
    const path = rels.get(rid);
    const ext = path ? /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase() ?? '' : '';
    if (!path || !SHOWN[ext]) return '[Drawing]';
    let n = byRid.get(rid);
    if (!n) { n = byRid.size + 1; byRid.set(rid, n); want.push({ n, path }); }
    return `[Picture ${n}]`;
  };
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const out: string[] = [];
  for (const m of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)]
        .map((c) => [...c[0].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((p) => runsOf(p[0], picture).trim()).filter(Boolean).join(' ').replace(/\|/g, '/')));
      const kept = rows.filter((r) => r.some(Boolean));
      if (kept.length) out.push(kept.map((r) => `| ${r.join(' | ')} |`).join('\n'));
    } else {
      const p = paragraph(block, picture);
      if (p) out.push(p);
    }
  }
  for (const w of want) {
    const f = entries.find((x) => x.name === w.path);
    if (!f) continue;
    const ext = /\.([^.]+)$/.exec(w.path)![1]!.toLowerCase();
    pictures.push({ n: w.n, name: w.path.split('/').pop()!, type: SHOWN[ext]!, bytes: await f.data() });
  }
  return { text: out.join('\n\n'), pictures };
}

/** A Word document's text alone. */
export const docxText = async (bytes: Uint8Array): Promise<string> => (await docxDoc(bytes)).text;

/** A PDF's text, pages apart. */
export async function pdfText(bytes: Uint8Array, name: string): Promise<string> {
  const { openDatasheet, allText } = await import('./datasheet');
  const d = await openDatasheet(bytes, name);
  const pages = await allText(d, false);
  return pages.map((p) => p.text.trim()).filter(Boolean).join('\n\n');
}

/** A specification file's text, by its type, and a Word document's pictures. */
export async function specDoc(name: string, bytes: Uint8Array): Promise<SpecDoc> {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'docx') return docxDoc(bytes);
  if (ext === 'pdf') return { text: await pdfText(bytes, name), pictures: [] };
  if (ext === 'doc' || ext === 'rtf' || ext === 'odt') throw new Error(`A .${ext} file isn't read: save it as .docx, PDF or text`);
  const t = new TextDecoder().decode(bytes).replace(/^\ufeff/, '');
  if (t.includes('\u0000')) throw new Error('Not a text file');
  return { text: t.replace(/\r\n?/g, '\n'), pictures: [] };
}

/** The text of a specification file, by its type. */
export const specText = async (name: string, bytes: Uint8Array): Promise<string> => (await specDoc(name, bytes)).text;
