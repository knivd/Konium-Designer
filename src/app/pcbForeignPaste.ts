/**
 * Edit › Paste on a board with nothing copied in Konium: what another application copied
 * (Preferences › PCB Editor › General › Paste from other applications) — a drawing (SVG: the
 * browser's stand-in for a metafile) as lines, or its text as a string, following the cursor.
 */
import { settings } from '../core/settings';
import { svgStrokes } from '../formats/svgStrokes';
import { placeDrawingTool, placeStringTool } from '../editors/pcb/PcbPlaceTools';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import { notify } from './state';

/** What the system clipboard holds: a drawing and/or text. */
async function readClipboard(): Promise<{ svg: string; text: string } | null> {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return null;
  let svg = '', text = '';
  try {
    for (const it of await cb.read()) {
      if (it.types.includes('image/svg+xml')) svg = await (await it.getType('image/svg+xml')).text();
      if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
    }
  } catch {
    try { text = await cb.readText(); } catch { return null; }
  }
  if (!svg && /<svg[\s>]/i.test(text)) svg = text;
  return { svg, text };
}

export async function pasteForeign(e: PcbEditor): Promise<void> {
  const got = await readClipboard();
  if (!got) { notify('Nothing to paste: copy something first (the browser gives no access to what other applications copied)'); return; }
  if (settings.pcbPasteFormat === 'Metafile' && got.svg) {
    const strokes = svgStrokes(got.svg);
    if (strokes.length) { e.setTool(placeDrawingTool(e, strokes)); return; }
  }
  const line = got.text.replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim())?.trim();
  if (!line || /<svg[\s>]/i.test(line)) { notify('Nothing to paste: the clipboard holds neither text nor a drawing'); return; }
  e.stringTemplate.text = line;
  e.setTool(placeStringTool(e));
}
