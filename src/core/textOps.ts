/**
 * The text editor's edits as plain functions of the text and the selection: Tools › Change Case
 * (the selection, or the word at the caret), Indent / Unindent of the lines a selection touches,
 * Edit › Replace (one, or all), the word at the caret (Find Next Selected), every match of a
 * find (the browser marks), Tools › Show Code Templates' SPICE cards, and Tools › Import Editor
 * Settings from › Visual Studio (a .vssettings file's text editor font and colours).
 */
import { descendants, parseXml } from '../formats/xml';

export type CaseChange = 'upper' | 'lower' | 'capitalise';
/** An edit: replace text[from, to) with `text`, then select [selStart, selEnd) of the result. */
export interface TextEdit { from: number; to: number; text: string; selStart: number; selEnd: number }

const WORD = /[A-Za-z0-9_$]/;

export function changeCase(s: string, how: CaseChange): string {
  if (how === 'upper') return s.toUpperCase();
  if (how === 'lower') return s.toLowerCase();
  return s.toLowerCase().replace(/(^|[^A-Za-z0-9_'])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

/** The word at (or just before) the caret: [start, end), empty when there is none. */
export function wordAt(text: string, pos: number): [number, number] {
  let a = pos, b = pos;
  if (!(a < text.length && WORD.test(text[a]!)) && a > 0 && WORD.test(text[a - 1]!)) { a--; b = a; }
  while (a > 0 && WORD.test(text[a - 1]!)) a--;
  while (b < text.length && WORD.test(text[b]!)) b++;
  return [a, b];
}

/** Tools › Change Case on the selection (a word when nothing is selected) or on the word at the caret. */
export function caseEdit(text: string, start: number, end: number, what: 'selection' | 'word', how: CaseChange): TextEdit | null {
  const [a, b] = what === 'selection' && end > start ? [start, end] : wordAt(text, start);
  if (b <= a) return null;
  const out = changeCase(text.slice(a, b), how);
  return { from: a, to: b, text: out, selStart: what === 'word' ? start : a, selEnd: what === 'word' ? end : a + out.length };
}

/** The lines a selection touches: [start of the first, end of the last) — a selection ending at a line's start leaves that line out. */
export function lineSpan(text: string, start: number, end: number): [number, number] {
  const a = (start > 0 ? text.lastIndexOf('\n', start - 1) + 1 : 0);
  let e = end > start && text[end - 1] === '\n' ? end - 1 : end;
  if (e < a) e = a;
  const nl = text.indexOf('\n', e);
  return [a, nl < 0 ? text.length : nl];
}

/** Tools › Indent / Unindent: each line the selection touches one level in or out (a tab, or tab-width spaces). */
export function indentEdit(text: string, start: number, end: number, out: boolean, tabWidth: number, useTabs: boolean): TextEdit | null {
  const [a, b] = lineSpan(text, start, end);
  const lines = text.slice(a, b).split('\n');
  const unit = useTabs ? '\t' : ' '.repeat(tabWidth);
  let shiftFirst = 0;
  const next = lines.map((l, i) => {
    if (!out) { if (i === 0) shiftFirst = unit.length; return l.length || lines.length === 1 ? unit + l : l; }
    let n = 0;
    if (l.startsWith('\t')) n = 1;
    else while (n < tabWidth && l[n] === ' ') n++;
    if (i === 0) shiftFirst = -n;
    return l.slice(n);
  });
  const repl = next.join('\n');
  if (repl === text.slice(a, b)) return null;
  // The selection keeps the same text selected (whole lines when it spanned several)
  const multi = lines.length > 1 || end > start;
  return multi ? { from: a, to: b, text: repl, selStart: a, selEnd: a + repl.length }
    : { from: a, to: b, text: repl, selStart: Math.max(a, start + shiftFirst), selEnd: Math.max(a, end + shiftFirst) };
}

/** Every match of `what` (ignoring case unless asked): their starts — the first `limit` (marking them shows no more). */
export function matches(text: string, what: string, matchCase = false, limit = 10_000): number[] {
  if (!what) return [];
  const t = matchCase ? text : text.toLowerCase(), w = matchCase ? what : what.toLowerCase();
  const out: number[] = [];
  for (let i = t.indexOf(w); i >= 0 && out.length < limit; i = t.indexOf(w, i + w.length)) out.push(i);
  return out;
}

/** Edit › Replace › Replace All: the text with every match replaced, and how many there were. */
export function replaceAll(text: string, what: string, by: string, matchCase = false): { text: string; count: number } {
  const at = matches(text, what, matchCase, Infinity);
  if (!at.length) return { text, count: 0 };
  let out = '', from = 0;
  for (const i of at) { out += text.slice(from, i) + by; from = i + what.length; }
  return { text: out + text.slice(from), count: at.length };
}

/** Enter with Auto Indent: the new line starts with the current line's leading white space. */
export function indentOf(text: string, pos: number): string {
  const a = (pos > 0 ? text.lastIndexOf('\n', pos - 1) + 1 : 0);
  return /^[ \t]*/.exec(text.slice(a, pos))![0];
}

/** Tools › Show Code Templates: SPICE's cards and sources as Konium's netlists use them [est: AD's own list is for scripts]. */
export const CODE_TEMPLATES: [name: string, text: string][] = [
  ['.OP — operating point', '.OP'],
  ['.TRAN — transient', '.TRAN 1u 1m'],
  ['.AC — small signal', '.AC DEC 100 1 1MEG'],
  ['.DC — DC sweep', '.DC V1 0 5 0.1'],
  ['.TF — transfer function', '.TF V(OUT) V1'],
  ['.NOISE — noise', '.NOISE V(OUT) V1 DEC 100 1 1MEG'],
  ['.PZ — poles and zeros', '.PZ IN 0 OUT 0 VOL PZ'],
  ['.FOUR — Fourier', '.FOUR 1k V(OUT)'],
  ['.STEP — parameter sweep', '.STEP R1 1k 10k 1k'],
  ['.TEMP — temperatures', '.TEMP 27'],
  ['.PARAM — parameter', '.PARAM RVAL=1k'],
  ['.IC — initial condition', '.IC V(OUT)=0'],
  ['.NODESET — node set', '.NODESET V(OUT)=0'],
  ['.OPTIONS — options', '.OPTIONS RELTOL=0.001'],
  ['.MODEL — diode', '.MODEL DMOD D(IS=1e-14 N=1)'],
  ['.MODEL — NPN transistor', '.MODEL QNPN NPN(IS=1e-14 BF=100)'],
  ['.MODEL — N-channel MOSFET', '.MODEL MNMOS NMOS(LEVEL=1 VTO=0.7 KP=110u)'],
  ['.SUBCKT … .ENDS — subcircuit', '.SUBCKT NAME IN OUT\n\n.ENDS NAME'],
  ['.INCLUDE — another file', '.INCLUDE "models.mdl"'],
  ['V — sine source', 'V1 IN 0 DC 0 SIN(0 1 1k)'],
  ['V — pulse source', 'V1 IN 0 PULSE(0 5 0 1n 1n 0.5m 1m)'],
  ['V — AC source', 'V1 IN 0 DC 0 AC 1'],
  ['R — resistor', 'R1 IN OUT 1k'],
  ['C — capacitor', 'C1 OUT 0 100n'],
  ['L — inductor', 'L1 IN OUT 10u'],
  ['* — comment', '* '],
  ['.END', '.END'],
];

/** What Import Editor Settings from › Visual Studio takes: the font and the colours of the text kinds Konium colours. */
export interface EditorLook { font?: string; size?: number; back?: string; plain?: string; comment?: string; card?: string; device?: string }

/** A Visual Studio colour (0x00BBGGRR, decimal or hex) as #rrggbb; Automatic and the like give nothing. */
function vsColour(v: string | null): string | undefined {
  if (!v) return undefined;
  const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n > 0xffffff) return undefined; // 0x01000000 and up: automatic / system colours
  const r = n & 0xff, g = (n >> 8) & 0xff, b = (n >> 16) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** A .vssettings file's Text Editor category: FontName, FontSize and the Plain Text, Comment, Keyword and Identifier items. */
export function readVsSettings(xml: string): EditorLook {
  if (!/<UserSettings[\s>]/.test(xml)) throw new Error('not a Visual Studio settings file');
  const doc = parseXml(xml);
  const TEXT_EDITOR = '{A27B4E24-A735-4D1D-B8E7-9716E1E3D8E0}';
  const cats = descendants(doc, 'Category').filter((c) => (c.attrs.GUID ?? '').toUpperCase() === TEXT_EDITOR || /^Text Editor/i.test(c.attrs.FontsAndColorsCategory ?? '') || /^Text Editor/i.test(c.attrs.name ?? ''));
  const out: EditorLook = {};
  for (const cat of cats) {
    const font = cat.attrs.FontName;
    if (font && !out.font) out.font = font;
    const size = Number(cat.attrs.FontSize);
    if (size > 0 && !out.size) out.size = Math.round(size * 96 / 72); // points → px
    for (const it of descendants(cat, 'Item')) {
      const name = (it.attrs.Name ?? '').toLowerCase();
      const fg = vsColour(it.attrs.Foreground ?? null), bg = vsColour(it.attrs.Background ?? null);
      if (name === 'plain text') { out.plain ??= fg; out.back ??= bg; }
      else if (name === 'comment') out.comment ??= fg;
      else if (name === 'keyword') out.card ??= fg;
      else if (name === 'identifier') out.device ??= fg;
    }
  }
  if (!out.font && !out.plain && !out.comment && !out.card) throw new Error('the file has no Text Editor fonts and colours');
  return out;
}
