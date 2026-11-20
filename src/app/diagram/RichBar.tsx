/**
 * The formatting bar over a formatted label being typed: bold, italic, underline, strikethrough,
 * text colour, larger and smaller, bulleted and numbered lists, alignment, clear formatting. Its
 * buttons keep the text's selection (they act on what is picked).
 */
const COLOURS = ['#000000', '#666666', '#b85450', '#d79b00', '#82b366', '#6c8ebf', '#9673a6', '#ffffff'];
const run = (cmd: string, arg?: string) => { document.execCommand(cmd, false, arg); };
/** The picked text a step larger or smaller (the editor's sizes 1 to 7). */
function size(step: number) {
  const cur = Number(document.queryCommandValue('fontSize')) || 3;
  run('fontSize', String(Math.max(1, Math.min(7, cur + step))));
}

export function RichBar({ at }: { at: { left: string; top: string } }) {
  const b = (label: string, glyph: preact.ComponentChildren, act: () => void, cls = '') => (
    <button type="button" class={`btn dg-tog${cls}`} title={label} aria-label={label} onMouseDown={(e) => { e.preventDefault(); act(); }}>{glyph}</button>
  );
  return (
    <div class="dg-rich-bar" role="toolbar" aria-label="Formatting" style={at} onMouseDown={(e) => e.preventDefault()}>
      {b('Bold (Ctrl+B)', 'B', () => run('bold'))}
      {b('Italic (Ctrl+I)', <i>I</i>, () => run('italic'))}
      {b('Underline (Ctrl+U)', <u>U</u>, () => run('underline'))}
      {b('Strikethrough', <s>S</s>, () => run('strikeThrough'))}
      <span class="dd-sep" />
      {COLOURS.map((c) => <button key={c} type="button" class="dg-chip" style={{ background: c }} title={`Text colour ${c}`} aria-label={`Text colour ${c}`} onMouseDown={(e) => { e.preventDefault(); run('foreColor', c); }} />)}
      <span class="dd-sep" />
      {b('Larger', 'A+', () => size(1))}
      {b('Smaller', 'A−', () => size(-1))}
      {b('Bulleted List', '•', () => run('insertUnorderedList'))}
      {b('Numbered List', '1.', () => run('insertOrderedList'))}
      <span class="dd-sep" />
      {b('Align Left', '⇤', () => run('justifyLeft'))}
      {b('Centre', '↔', () => run('justifyCenter'))}
      {b('Align Right', '⇥', () => run('justifyRight'))}
      {b('Clear Formatting', '⌫', () => run('removeFormat'))}
    </div>
  );
}
