/**
 * Formatted labels (html=1): the HTML a label is kept as, read into blocks of styled runs
 * (bold, italic, underline, strikethrough, colour, size, font, superscript and subscript, links;
 * paragraphs, headings, line breaks, bulleted and numbered lists, alignment), laid out in lines
 * (wrapped to a width) and drawn as SVG text, so they print and export as drawn. Also what the
 * label editor keeps of pasted or typed HTML (sanitise).
 */
import { charOf } from '../../formats/codePoint';

export interface RunStyle { bold: boolean; italic: boolean; underline: boolean; strike: boolean; size: number; colour: string; family: string; shift: 0 | 1 | -1; href?: string; mono?: boolean }
export interface Run { text: string; st: RunStyle }
export interface Block { runs: Run[]; align?: string; bullet?: string; indent: number; before: number; after: number }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, x: string) => (x[0] === '#' ? charOf(x[1] === 'x' || x[1] === 'X' ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : ENT[x.toLowerCase()] ?? m));

/** A tag's attributes. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z-:]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1]!.toLowerCase()] = unent(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}
/** A style attribute's declarations. */
function css(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of (style ?? '').split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
  return out;
}
/** A CSS length in px (em of the given size). */
function px(v: string | undefined, em: number): number | null {
  if (!v) return null;
  const m = /^(-?[\d.]+)\s*(px|pt|em|%)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'pt' ? (n * 4) / 3 : m[2] === 'em' ? n * em : m[2] === '%' ? (n / 100) * em : n;
}
const FONT_SIZES = [10, 13, 16, 18, 24, 32, 48];
const HEAD: Record<string, [number, number]> = { h1: [2, 0.67], h2: [1.5, 0.83], h3: [1.17, 1], h4: [1, 1.33], h5: [0.83, 1.67], h6: [0.67, 2.33] };
const BLOCK = /^(div|p|h[1-6]|li|ul|ol|blockquote|pre|tr|table|center|section|article|header|footer|hr)$/;

/** A label's HTML read into blocks of runs; `base`: the label's own font (its style's). */
export function parseHtml(html: string, base: RunStyle): Block[] {
  const blocks: Block[] = [];
  const stack: { tag: string; st: RunStyle; align?: string; list?: { ordered: boolean; n: number }; indent: number }[] = [{ tag: '', st: base, indent: 0 }];
  let cur: Block | null = null;
  let pendingAfter = 0;
  const top = () => stack[stack.length - 1]!;
  const open = (before = 0) => { cur = { runs: [], align: [...stack].reverse().find((x) => x.align)?.align, indent: top().indent, before: Math.max(before, pendingAfter), after: 0 }; pendingAfter = 0; blocks.push(cur); return cur; };
  const close = (after = 0) => { if (cur) { cur.after = Math.max(cur.after, after); pendingAfter = cur.after; } cur = null; };
  for (const tok of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? []) {
    if (tok.startsWith('<!--')) continue;
    if (tok[0] !== '<') {
      // Text: white space folded as HTML folds it (outside <pre>)
      const pre = stack.some((x) => x.tag === 'pre');
      let t = unent(tok);
      if (!pre) t = t.replace(/[ \t\r\n]+/g, ' ');
      if (!t || (!cur && !t.trim() && !pre)) continue;
      const b = cur ?? open();
      if (!b.runs.length && !pre) t = t.replace(/^ /, '');
      for (const [i, line] of (pre ? t.split('\n') : [t]).entries()) { if (i) { close(); open(); } if (line) cur!.runs.push({ text: line, st: top().st }); }
      continue;
    }
    const m = /^<\s*(\/)?\s*([a-zA-Z0-9]+)([^>]*)>$/.exec(tok);
    if (!m) continue;
    const end = !!m[1], tag = m[2]!.toLowerCase(), a = attrs(m[3] ?? ''), self = /\/\s*>$/.test(tok);
    if (tag === 'br') { const b = cur ?? open(); if (!b.runs.length) b.runs.push({ text: '', st: top().st }); close(); open(); continue; }
    if (end) {
      const i = stack.map((x) => x.tag).lastIndexOf(tag);
      if (i <= 0) continue;
      const was = stack[i]!;
      stack.length = i;
      if (BLOCK.test(tag)) close(HEAD[tag] ? HEAD[tag]![1] * was.st.size : tag === 'p' ? was.st.size : 0);
      continue;
    }
    const st: RunStyle = { ...top().st };
    const s = css(a.style);
    let align = s['text-align'] ?? a.align;
    let indent = top().indent;
    let list = top().list;
    if (tag === 'b' || tag === 'strong' || tag === 'th') st.bold = true;
    if (tag === 'i' || tag === 'em') st.italic = true;
    if (tag === 'u' || tag === 'ins') st.underline = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') st.strike = true;
    if (tag === 'sup') { st.shift = 1; st.size *= 0.75; }
    if (tag === 'sub') { st.shift = -1; st.size *= 0.75; }
    if (tag === 'code' || tag === 'pre' || tag === 'tt') { st.family = 'Courier New'; st.mono = true; }
    if (tag === 'a') { st.underline = true; st.colour = '#0000ee'; if (a.href) st.href = a.href; }
    if (tag === 'font') { if (a.color) st.colour = a.color; if (a.face) st.family = a.face.split(',')[0]!.replace(/['"]/g, '').trim(); if (a.size) st.size = FONT_SIZES[Math.max(1, Math.min(7, Number(a.size) || 3)) - 1]! * (base.size / 16) * 1.0 || st.size; }
    if (HEAD[tag]) { st.size = base.size * HEAD[tag]![0]; st.bold = true; }
    if (tag === 'center') align = 'center';
    if (s['font-weight']) st.bold = /bold|[6-9]00/.test(s['font-weight']);
    if (s['font-style']) st.italic = /italic|oblique/.test(s['font-style']);
    if (s['text-decoration'] || s['text-decoration-line']) { const td = s['text-decoration'] ?? s['text-decoration-line']!; st.underline = /underline/.test(td); st.strike = /line-through/.test(td); }
    if (s.color) st.colour = s.color;
    if (s['font-family']) st.family = s['font-family'].split(',')[0]!.replace(/['"]/g, '').trim();
    const fsz = px(s['font-size'], top().st.size); if (fsz) st.size = fsz;
    if (tag === 'ul' || tag === 'ol') { list = { ordered: tag === 'ol', n: 0 }; indent += 40; }
    const entry = { tag, st, ...(align ? { align } : {}), ...(list ? { list } : {}), indent };
    if (!self && tag !== 'img' && tag !== 'hr') stack.push(entry);
    if (BLOCK.test(tag)) {
      close();
      const mt = px(s['margin-top'], st.size), def = HEAD[tag] ? HEAD[tag]![1] * st.size : tag === 'p' ? st.size : 0;
      if (tag === 'ul' || tag === 'ol' || tag === 'table') { pendingAfter = Math.max(pendingAfter, tag === 'table' ? 0 : st.size); continue; }
      if (tag === 'hr') { open(); close(); continue; }
      const b = open(mt ?? def);
      if (tag === 'li' && list) { list.n++; b.bullet = list.ordered ? `${list.n}.` : '•'; }
      const mb = px(s['margin-bottom'], st.size); if (mb !== null) b.after = mb; else if (def) b.after = def;
    }
    if (tag === 'td' || tag === 'th') { const b = cur ?? open(); if (b.runs.length) b.runs.push({ text: '  ', st }); }
  }
  close();
  // Empty blocks left by markup alone: kept as empty lines only where a <br> made them
  return blocks.filter((b, i) => b.runs.length || i === blocks.length - 1 ? b.runs.length > 0 : false);
}

export interface Segment { x: number; text: string; st: RunStyle; w: number }
export interface Line { y: number; h: number; base: number; w: number; x0: number; segs: Segment[]; align: string }
/**
 * Blocks laid out in lines: words wrapped to `width` (Infinity: no wrapping), each line as tall as
 * its biggest font (1.2 ×), blocks spaced by their margins; x from the left of the box, y from its top.
 */
export function layoutRich(blocks: Block[], width: number, align: string, measure: (t: string, st: RunStyle) => number): { lines: Line[]; h: number; w: number } {
  const lines: Line[] = [];
  let y = 0, wmax = 0;
  blocks.forEach((b, bi) => {
    y += bi ? b.before : 0;
    const x0 = b.indent;
    const avail = width - x0;
    let line: Segment[] = [], lw = 0;
    const flush = () => {
      // The line's width without its trailing space
      const l = line[line.length - 1];
      if (l && l.x >= 0) { const t = l.text.trimEnd(); lw -= l.w - measure(t, l.st); l.w = measure(t, l.st); l.text = t; }
      const h = Math.max(...line.map((s) => s.st.size), b.runs[0]?.st.size ?? 12) * 1.2;
      lines.push({ y, h, base: h * 0.8, w: lw, x0, segs: line, align: b.align ?? align });
      wmax = Math.max(wmax, lw + x0);
      y += h; line = []; lw = 0;
    };
    if (b.bullet) line.push({ x: -18, text: b.bullet, st: b.runs[0]?.st ?? ({ size: 12 } as RunStyle), w: 0 });
    for (const r of b.runs) {
      // Words with the spaces after them
      for (const word of r.text.match(/[^ ]+ *| +/g) ?? (r.text === '' ? [''] : [])) {
        const ww = measure(word, r.st), bare = measure(word.trimEnd(), r.st);
        if (lw && isFinite(avail) && lw + bare > avail) flush();
        const last = line[line.length - 1];
        if (last && last.st === r.st && last.x >= 0) { last.text += word; last.w += ww; } else line.push({ x: lw, text: word, st: r.st, w: ww });
        lw += ww;
      }
    }
    flush();
  });
  return { lines, h: y, w: wmax };
}

/** An attribute's value written out: nothing in it can end the attribute or be read as a character reference. */
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The style declarations a label keeps, and what a value of one may be made of (so no url(), no escapes, no second declaration). */
const STYLE = /^(color|background-color|font-size|font-family|font-weight|font-style|text-decoration|text-align|margin-top|margin-bottom)$/;
const STYLE_VALUE = /^[\w\s#%.,()'-]{1,120}$/;

/**
 * HTML the label editor keeps: its formatting tags and styles only (no scripts, events or other
 * attributes). Every tag kept is written anew from what it may hold, and a '<' that is not one of
 * them is text (&lt;), so nothing left behind by a tag taken out can join up into a tag again.
 * Every value written is written as text (attr), so a character reference the reading here left
 * alone (one without its semicolon) is not read as one by the browser afterwards.
 */
export function sanitise(html: string): string {
  const keep = /^(b|strong|i|em|u|s|strike|del|ins|sub|sup|br|div|p|span|font|a|ul|ol|li|h[1-6]|code|pre|blockquote|hr|table|tbody|tr|td|th|center)$/;
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '').replace(/<\s*(\/)?\s*([a-zA-Z0-9]+)([^>]*)>|</g, (m, end: string | undefined, t: string | undefined, rest: string) => {
    if (m === '<' || !t) return '&lt;';
    const tag = t.toLowerCase();
    if (!keep.test(tag)) return '';
    if (end) return `</${tag}>`;
    const a = attrs(rest);
    const out: string[] = [];
    if (a.style) {
      const ok = Object.entries(css(a.style)).map(([k, v]) => [k, v.replace(/"/g, "'")] as const).filter(([k, v]) => STYLE.test(k) && STYLE_VALUE.test(v) && !/url\s*\(|expression/i.test(v));
      if (ok.length) out.push(`style="${attr(ok.map(([k, v]) => `${k}: ${v}`).join('; '))};"`);
    }
    if (tag === 'font') for (const k of ['color', 'size', 'face']) if (a[k] && STYLE_VALUE.test(a[k]!.replace(/"/g, "'"))) out.push(`${k}="${attr(a[k]!.replace(/"/g, "'"))}"`);
    if (tag === 'a' && a.href && /^(https?:|mailto:|#|data:page\/id,)/i.test(a.href)) out.push(`href="${attr(a.href)}"`);
    if (a.align && /^(left|center|right|justify)$/i.test(a.align)) out.push(`align="${a.align}"`);
    return `<${tag}${out.length ? ' ' + out.join(' ') : ''}${tag === 'br' || tag === 'hr' ? '' : ''}>`;
  });
}
