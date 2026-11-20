/**
 * The Mixed Sim text editor: a netlist (.nsx), model (.mdl) or subcircuit (.ckt) as text, line
 * numbers in the gutter, SPICE's cards in colour. Edit › Find (Ctrl+F) opens the find bar (F3 the
 * next; every match marked until Clear Browser Marks, Ctrl+Shift+C), Replace (Ctrl+H) one or
 * all, Find Next Selected (Ctrl+Shift+F); Edit › Undo, Cut, Copy, Paste, Clear and Select All act
 * on the text. Tools › Indent / Unindent (Tab, Shift+Tab on a selection), Change Case, Word Wrap,
 * Show Code Templates; Window › Split Vertically / Horizontally (two views of the one text).
 * Preferences › Text Editors set tabs, auto indent, the margin, line numbers, the font and colours.
 * A netlist runs from Simulate › Run Simulation.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { commands } from '../core/commands';
import { settings, settingsChanged } from '../core/settings';
import { CODE_TEMPLATES, caseEdit, indentEdit, indentOf, matches, replaceAll, wordAt, type CaseChange, type TextEdit } from '../core/textOps';
import { activeScope, notify, tick, type OpenDoc } from './state';
import type { SimTextDocument } from '../sim/simText';
import { isNetlistName } from '../sim/simText';
import { setTextTarget, type SplitMode } from './textTarget';
import { showDialog } from './dialogs';
import { ChooseListDialog } from './dialogs/ChooseList';

/** One line coloured: a dot card, a comment, a device (its letter) — the rest as it is. */
function highlight(line: string): preact.ComponentChildren {
  if (/^\s*\*/.test(line)) return <span class="st-comment">{line}</span>;
  const m = /^(\s*)(\.[A-Za-z]+)(.*)$/.exec(line);
  if (m) return <>{m[1]}<span class="st-card">{m[2]}</span>{rest(m[3]!)}</>;
  const d = /^(\s*)([A-Za-z][^\s]*)(.*)$/.exec(line);
  if (d) return <>{d[1]}<span class="st-device">{d[2]}</span>{rest(d[3]!)}</>;
  return line;
}
function rest(s: string): preact.ComponentChildren {
  const c = s.indexOf(';');
  return c >= 0 ? <>{s.slice(0, c)}<span class="st-comment">{s.slice(c)}</span></> : s;
}
/** A line with the browser marks (every match of the last find) as highlighted runs. */
function marked(line: string, what: string | null): preact.ComponentChildren {
  if (!what) return line;
  const at = matches(line, what);
  if (!at.length) return line;
  const out: preact.ComponentChildren[] = [];
  let from = 0;
  at.forEach((i, k) => { out.push(line.slice(from, i), <mark key={k}>{line.slice(i, i + what.length)}</mark>); from = i + what.length; });
  out.push(line.slice(from));
  return out;
}

/** Replace a range as typing would (so Undo takes it back), then select what the edit says. */
function applyEdit(a: HTMLTextAreaElement, e: TextEdit): void {
  a.focus();
  a.setSelectionRange(e.from, e.to);
  if (e.text) document.execCommand('insertText', false, e.text);
  else if (e.to > e.from) document.execCommand('delete');
  a.setSelectionRange(e.selStart, e.selEnd);
}

interface PaneProps {
  text: string; lines: string[]; marks: string | null; wrap: 'none' | 'window' | 'margin'; label: string;
  onInput: (v: string) => void; onKey: (e: KeyboardEvent, a: HTMLTextAreaElement) => void; onFocus: (a: HTMLTextAreaElement) => void; mount: (a: HTMLTextAreaElement | null) => void;
}

/** One view of the text: the gutter, the marks under the text, the coloured text, and the text area on top. */
function Pane({ text, lines, marks, wrap, label, onInput, onKey, onFocus, mount }: PaneProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const shade = useRef<HTMLPreElement>(null);
  const under = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [sb, setSb] = useState(0);
  useEffect(() => { mount(area.current); return () => mount(null); }, []);
  const sync = () => {
    const a = area.current;
    if (!a) return;
    for (const p of [shade.current, under.current]) if (p) { p.scrollTop = a.scrollTop; p.scrollLeft = a.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = a.scrollTop;
  };
  // Wrapped lines: each gutter number as tall as its line; the scroll bar's width for At Margin
  useLayoutEffect(() => {
    const a = area.current;
    if (a) { const w = a.offsetWidth - a.clientWidth; if (w !== sb) setSb(w); }
    const g = gutter.current, s = shade.current;
    if (g && s) for (let i = 0; i < g.children.length; i++) {
      const h = wrap === 'none' ? '' : `${(s.children[i] as HTMLElement | undefined)?.offsetHeight ?? 0}px`;
      (g.children[i] as HTMLElement).style.height = h;
    }
    sync();
  });
  const margin = settings.textMargin;
  const width = wrap === 'margin' ? { width: `min(100%, calc(${margin}ch + 16px + ${sb}px))`, right: 'auto' } : undefined;
  const marginLine = settings.textShowMargin ? { backgroundImage: `linear-gradient(to right, transparent calc(8px + ${margin}ch), var(--st-margin) calc(8px + ${margin}ch), var(--st-margin) calc(9px + ${margin}ch), transparent calc(9px + ${margin}ch))` } : undefined;
  const wrapCls = wrap === 'none' ? '' : ' wrap';
  return (
    <div class="st-pane">
      {settings.textLineNumbers && <div class="st-gutter" ref={gutter} aria-hidden="true">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>}
      <div class="st-editor">
        <pre class={`st-under${wrapCls}`} ref={under} aria-hidden="true" style={{ ...width, ...marginLine }}>{lines.map((l, i) => <div key={i}>{marked(l, marks)}</div>)}</pre>
        <pre class={`st-shade${wrapCls}`} ref={shade} aria-hidden="true" style={width}>{lines.map((l, i) => <div key={i}>{highlight(l)}</div>)}</pre>
        <textarea ref={area} class={`st-area${wrapCls}`} value={text} spellcheck={false} wrap={wrap === 'none' ? 'off' : 'soft'} aria-label={label} style={width}
          onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} onScroll={sync} onFocus={() => area.current && onFocus(area.current)}
          onKeyDown={(e) => area.current && onKey(e, area.current)} />
      </div>
    </div>
  );
}

export function SimTextView({ od }: { od: OpenDoc }) {
  void tick.value;
  const doc = od.doc as SimTextDocument;
  const [text, setText] = useState(doc.text);
  const [, setLook] = useState(0);
  const [find, setFind] = useState<string | null>(null);
  const [replaceBy, setReplaceBy] = useState('');
  /** The bar finds text, replaces it, or (Edit › Goto Line Number) takes a line number. */
  const [mode, setMode] = useState<'find' | 'replace' | 'line'>('find');
  const [marks, setMarks] = useState<string | null>(null);
  const [split, setSplit] = useState<SplitMode>('none');
  const findBox = useRef<HTMLInputElement>(null);
  const areas = useRef<(HTMLTextAreaElement | null)[]>([null, null]);
  const focused = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { setText(doc.text); }, [doc, doc.text]);
  // Preferences › Text Editors and Tools › Word Wrap: drawn again
  useEffect(() => settingsChanged.on((p) => { if (Object.keys(p).some((k) => k.startsWith('text'))) setLook((n) => n + 1); }), []);
  const lines = useMemo(() => text.split('\n'), [text]);
  /** The view the commands act on: the one last focused. */
  const cur = (): HTMLTextAreaElement | null => (focused.current?.isConnected ? focused.current : areas.current.find((a) => a?.isConnected) ?? null);
  const lineHeight = Math.round(settings.textFontSize * 4 / 3);

  const findNext = (what = find ?? '') => {
    const a = cur();
    if (!a || !what) return false;
    const low = a.value.toLowerCase(), w = what.toLowerCase();
    let at = low.indexOf(w, a.selectionEnd);
    if (at < 0) at = low.indexOf(w);
    setMarks(what);
    if (at < 0) { notify(`“${what}” not found`); return false; }
    a.focus();
    a.setSelectionRange(at, at + what.length);
    // Bring it into view: the line's place in the text
    const line = a.value.slice(0, at).split('\n').length - 1;
    if (settings.textWordWrap === 'none') a.scrollTop = Math.max(0, line * lineHeight - a.clientHeight / 2);
    else { a.blur(); a.focus(); }
    return true;
  };
  const toLine = (n: number) => {
    const a = cur();
    if (!a || !Number.isFinite(n) || n < 1) return;
    const k = Math.min(lines.length, Math.floor(n));
    const start = lines.slice(0, k - 1).reduce((s, l) => s + l.length + 1, 0);
    a.focus();
    a.setSelectionRange(start, start + (lines[k - 1]?.length ?? 0));
    a.scrollTop = Math.max(0, (k - 1) * lineHeight - a.clientHeight / 2);
  };
  const openBar = (m: 'find' | 'replace' | 'line') => {
    const a = cur();
    const sel = a && a.selectionEnd > a.selectionStart && !a.value.slice(a.selectionStart, a.selectionEnd).includes('\n') ? a.value.slice(a.selectionStart, a.selectionEnd) : null;
    setMode(m); setFind((f) => (m === 'line' ? '' : sel ?? f ?? ''));
    setTimeout(() => findBox.current?.select(), 0);
  };
  /** Replace: the selection when it is what is looked for, then on to the next. */
  const replaceOne = () => {
    const a = cur(), w = find ?? '';
    if (!a || !w) return;
    if (a.value.slice(a.selectionStart, a.selectionEnd).toLowerCase() === w.toLowerCase()) {
      applyEdit(a, { from: a.selectionStart, to: a.selectionEnd, text: replaceBy, selStart: a.selectionStart + replaceBy.length, selEnd: a.selectionStart + replaceBy.length });
    }
    findNext(w);
  };
  const replaceEvery = () => {
    const a = cur(), w = find ?? '';
    if (!a || !w) return;
    const r = replaceAll(a.value, w, replaceBy);
    if (!r.count) { notify(`“${w}” not found`); return; }
    applyEdit(a, { from: 0, to: a.value.length, text: r.text, selStart: 0, selEnd: 0 });
    notify(`${r.count} replaced`);
  };
  const edit = (f: (a: HTMLTextAreaElement) => TextEdit | null) => { const a = cur(); const e = a && f(a); if (a && e) applyEdit(a, e); };
  const indent = (out: boolean) => edit((a) => indentEdit(a.value, a.selectionStart, a.selectionEnd, out, settings.textTabWidth, settings.textUseTabs));
  const changeCaseOf = (what: 'selection' | 'word', how: CaseChange) => edit((a) => caseEdit(a.value, a.selectionStart, a.selectionEnd, what, how));
  const findNextSelected = () => {
    const a = cur();
    if (!a) return;
    let [s, e] = [a.selectionStart, a.selectionEnd];
    if (e <= s) [s, e] = wordAt(a.value, s);
    const w = a.value.slice(s, e);
    if (!w || w.includes('\n')) return;
    setFind(w); setMode('find');
    a.setSelectionRange(e, e);
    findNext(w);
  };
  const templates = () => {
    const a = cur();
    if (!a) return;
    const [s, e] = [a.selectionStart, a.selectionEnd];
    showDialog(ChooseListDialog, {
      title: 'Code Templates', header: 'Template', items: CODE_TEMPLATES.map(([n]) => n),
      onOk: (i: number) => {
        const t = CODE_TEMPLATES[i]?.[1];
        if (t === undefined) return;
        // A card starts its own line
        const lineStart = s > 0 ? a.value.lastIndexOf('\n', s - 1) + 1 : 0;
        const pre = a.value.slice(lineStart, s).trim() ? '\n' : '';
        setTimeout(() => applyEdit(a, { from: s, to: e, text: pre + t, selStart: s + pre.length + t.length, selEnd: s + pre.length + t.length }), 0);
      },
    });
  };
  const exec = (cmd: string) => { cur()?.focus(); document.execCommand(cmd); };

  useEffect(() => {
    setTextTarget({
      undo: () => exec('undo'), redo: () => exec('redo'), cut: () => exec('cut'), copy: () => exec('copy'),
      paste: () => { void navigator.clipboard?.readText?.().then((t) => { cur()?.focus(); document.execCommand('insertText', false, t); }).catch(() => {}); },
      selectAll: () => { const a = cur(); a?.focus(); a?.select(); },
      find: () => openBar('find'),
      findNext: () => { findNext(); },
      gotoLine: () => openBar('line'),
      replace: () => openBar('replace'),
      findNextSelected,
      clear: () => { const a = cur(); if (a && a.selectionEnd > a.selectionStart) { a.focus(); document.execCommand('delete'); } },
      clearMarks: () => setMarks(null),
      hasMarks: () => !!marks,
      indent,
      changeCase: changeCaseOf,
      templates,
      split: (m) => setSplit(m),
      splitMode: () => split,
    });
    return () => setTextTarget(null);
  });

  const [overwrite, setOverwrite] = useState(false);
  const onInput = (v: string) => {
    setText(v);
    doc.text = v;
    if (!doc.dirty) { doc.dirty = true; tick.value++; }
  };
  const onKey = (e: KeyboardEvent, a: HTMLTextAreaElement) => {
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    // Text Editors › General › Insert Mode / Overwrite with Insert key: Insert switches; overwriting, a character typed replaces the one after the cursor
    if (e.key === 'Insert' && !ctrl && !e.shiftKey && !e.altKey && settings.textInsertKey) { e.preventDefault(); setOverwrite((o) => !o); return; }
    if (overwrite && settings.textInsertKey && e.key.length === 1 && !ctrl && !e.altKey && a.selectionStart === a.selectionEnd) {
      const next = a.value[a.selectionStart];
      if (next !== undefined && next !== '\n') a.setSelectionRange(a.selectionStart, a.selectionStart + 1);
    }
    if (ctrl && e.shiftKey && k === 'f') { e.preventDefault(); findNextSelected(); return; }
    if (ctrl && e.shiftKey && k === 'c') { e.preventDefault(); setMarks(null); return; }
    if (ctrl && k === 'f') { e.preventDefault(); openBar('find'); return; }
    if (ctrl && k === 'h') { e.preventDefault(); openBar('replace'); return; }
    if (ctrl && k === 'g') { e.preventDefault(); openBar('line'); return; }
    if (e.key === 'F3') { e.preventDefault(); findNext(); return; }
    if (ctrl && k === 's') { e.preventDefault(); commands.run('file.save', activeScope.value); return; }
    if (e.key === 'Tab' && !ctrl) {
      e.preventDefault();
      const multi = a.value.slice(a.selectionStart, a.selectionEnd).includes('\n');
      if (e.shiftKey || multi) { indent(e.shiftKey); return; }
      const col = a.selectionStart - (a.selectionStart > 0 ? a.value.lastIndexOf('\n', a.selectionStart - 1) + 1 : 0);
      document.execCommand('insertText', false, settings.textUseTabs ? '\t' : ' '.repeat(settings.textTabWidth - (col % settings.textTabWidth)));
      return;
    }
    if (e.key === 'Enter' && !ctrl && !e.shiftKey && !e.altKey && settings.textAutoIndent) {
      e.preventDefault();
      document.execCommand('insertText', false, `\n${indentOf(a.value, a.selectionStart)}`);
    }
  };
  const netlist = isNetlistName(od.name);
  const wrap = settings.textWordWrap;
  const look: Record<string, string> = {
    '--st-lh': `${lineHeight}px`, '--st-size': `${settings.textFontSize}px`, '--st-tab': String(settings.textTabWidth),
    ...(settings.textFont.trim() ? { '--st-font': `${settings.textFont.trim()}, monospace` } : {}),
    ...(settings.textColours === 'custom' ? { '--st-back': settings.textBack, '--st-plain': settings.textPlain, '--st-comment': settings.textComment, '--st-card': settings.textCard, '--st-device': settings.textDevice } : {}),
  };
  const pane = (i: number) => (
    <Pane key={i} text={text} lines={lines} marks={marks} wrap={wrap} label={i ? 'Netlist text (second view)' : 'Netlist text'} onInput={onInput} onKey={onKey}
      onFocus={(a) => { focused.current = a; }} mount={(a) => { areas.current[i] = a; }} />
  );
  const go = () => { if (mode === 'line') { toLine(Number(find)); setFind(null); } else findNext(); };
  return (
    <div class="simtext" style={look} aria-label={`${od.name}: ${netlist ? 'simulation netlist' : 'simulation model'}`}>
      {find !== null && (
        <div class="st-find" role="search">
          <label>{mode === 'line' ? 'Line Number' : 'Find'} <input ref={findBox} value={find} aria-label={mode === 'line' ? 'Line number' : 'Text to find'} inputMode={mode === 'line' ? 'numeric' : undefined}
            onInput={(e) => setFind((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); go(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFind(null); cur()?.focus(); }
            }} /></label>
          {mode === 'replace' && <label>Replace With <input value={replaceBy} aria-label="Replace with" onInput={(e) => setReplaceBy((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFind(null); cur()?.focus(); } }} /></label>}
          <button class="btn" onClick={go}>{mode === 'line' ? 'Go' : 'Find Next'}</button>
          {mode === 'replace' && <><button class="btn" onClick={replaceOne}>Replace</button><button class="btn" onClick={replaceEvery}>Replace All</button></>}
          <button class="btn" onClick={() => { setFind(null); cur()?.focus(); }}>Close</button>
        </div>
      )}
      <div class={`st-body${split === 'none' ? '' : ` split-${split}`}`}>
        {pane(0)}
        {split !== 'none' && pane(1)}
      </div>
      <div class="st-status muted small">{settings.textInsertKey ? <span class="st-mode" title="Insert switches">{overwrite ? 'Overwrite' : 'Insert'} · </span> : null}{lines.length} lines{marks ? ` — “${marks}” marked (Ctrl+Shift+C clears)` : ''}{netlist ? ' — Simulate › Run Simulation runs it' : ''}</div>
    </div>
  );
}
