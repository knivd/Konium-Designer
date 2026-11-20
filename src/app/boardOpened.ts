/**
 * A board opened from a file: the fonts it carries made available to its strings
 * (EmbeddedFonts6), and — unless Preferences says not to — the File Format Change Report for a
 * board from an older or a newer version of the format. Boards opened together share one report.
 */
import { settings } from '../core/settings';
import { changeReport, formatVersions, type ChangeReport } from '../formats/altium/fileVersion';
import { deflateFont, fontFile, readEmbeddedFonts, writeEmbeddedFonts } from '../formats/altium/embeddedFonts';
import type { PcbDocument } from '../model/pcb';
import { showDialog } from './dialogs';
import { FileFormatReportDialog } from './dialogs/FileFormatReport';
import { shareFont } from './docWindows';

const registered = new Set<string>();
/** The board's embedded fonts as page fonts, so its TrueType strings draw in them where they aren't installed. */
export function registerEmbeddedFonts(doc: PcbDocument): number {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !doc.cfb) return 0;
  let n = 0;
  for (const f of readEmbeddedFonts(doc.cfb.root)) {
    const id = `${f.family}|${f.bold}|${f.italic}`;
    if (registered.has(id)) continue;
    try {
      const data = fontFile(f) as unknown as ArrayBuffer, desc = { weight: f.bold ? '700' : '400', style: f.italic ? 'italic' : 'normal' };
      const face = new FontFace(f.family, data, desc);
      registered.add(id);
      document.fonts.add(face);
      void face.load().catch(() => { document.fonts.delete(face); registered.delete(id); });
      // (the document windows draw the board's text too)
      shareFont(f.family, data, desc);
      n++;
    } catch { /* a font the browser won't take */ }
  }
  return n;
}

let pending: { name: string; report: ChangeReport }[] = [];
/** The report this board calls for, if any (null: none, or turned off). */
export function boardReport(doc: PcbDocument): ChangeReport | null {
  const r = doc.cfb ? changeReport(formatVersions(doc.cfb.root)) : null;
  if (!r || (r.kind === 'older' ? settings.pcbNoReportOlder : settings.pcbNoReportNewer)) return null;
  return r;
}

export function boardOpened(name: string, doc: PcbDocument): void {
  registerEmbeddedFonts(doc);
  const r = boardReport(doc);
  if (!r) return;
  if (!pending.length) setTimeout(() => { const b = pending; pending = []; if (b.length) showDialog(FileFormatReportDialog, { boards: b }); }, 0);
  pending.push({ name, report: r });
}

/* ── Embedding fonts on save (Preferences › PCB Editor › True Type Fonts) ── */

interface LocalFont { family: string; style: string; fullName: string; blob(): Promise<Blob> }
type QueryFonts = () => Promise<LocalFont[]>;
const queryFonts = (): QueryFonts | undefined => (globalThis as unknown as { queryLocalFonts?: QueryFonts }).queryLocalFonts;

/** The TrueType fonts the board's strings use: family, bold, italic. */
export function usedFonts(doc: PcbDocument): { family: string; bold: boolean; italic: boolean }[] {
  const m = new Map<string, { family: string; bold: boolean; italic: boolean }>();
  for (const p of doc.prims) if (p.kind === 'text' && p.fontType === 1 && p.fontName) m.set(`${p.fontName.toLowerCase()}|${p.bold}|${p.italic}`, { family: p.fontName, bold: !!p.bold, italic: !!p.italic });
  return [...m.values()];
}

/** Ask the browser to let Konium read the fonts installed on this computer (a click, then the browser's question). */
export async function allowLocalFonts(): Promise<boolean> {
  const q = queryFonts();
  if (!q) return false;
  try { await q(); return true; } catch { return false; }
}

/**
 * Before a board is saved, with Embed TrueType fonts on: each font its strings use that it doesn't
 * carry yet is put in it, read from the fonts installed here (the browser has to have been allowed
 * to read them). The fonts it couldn't embed, by name.
 */
export async function embedUsedFonts(doc: PcbDocument): Promise<{ added: string[]; missing: string[] }> {
  if (!doc.cfb) return { added: [], missing: [] };
  const have = readEmbeddedFonts(doc.cfb.root);
  const style = (b: boolean, i: boolean) => (b && i ? 'Bold Italic' : b ? 'Bold' : i ? 'Italic' : 'Regular');
  const want = usedFonts(doc).filter((u) => !have.some((h) => h.family.toLowerCase() === u.family.toLowerCase() && h.bold === u.bold && h.italic === u.italic));
  if (!want.length) return { added: [], missing: [] };
  const name = (u: { family: string; bold: boolean; italic: boolean }) => `${u.family} ${style(u.bold, u.italic)}`;
  const q = queryFonts();
  const state = q ? await navigator.permissions?.query({ name: 'local-fonts' as PermissionName }).then((p) => p.state, () => 'prompt') : 'denied';
  if (!q || state !== 'granted') return { added: [], missing: want.map(name) };
  const local = await q().catch(() => [] as LocalFont[]);
  const added: string[] = [], missing: string[] = [];
  for (const u of want) {
    const f = local.find((x) => x.family.toLowerCase() === u.family.toLowerCase() && x.style === style(u.bold, u.italic));
    if (!f) { missing.push(name(u)); continue; }
    const ttf = new Uint8Array(await (await f.blob()).arrayBuffer());
    have.push({ name: f.fullName, family: f.family, style: f.style, bold: u.bold, italic: u.italic, flag: 1, zlib: await deflateFont(ttf) });
    added.push(name(u));
  }
  if (added.length) writeEmbeddedFonts(doc.cfb.root, have);
  return { added, missing };
}
