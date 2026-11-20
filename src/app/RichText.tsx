/**
 * A requirement's text, formatted as it is typed: bold, italic, underline, superscript and
 * subscript, bullet and numbered lists, tables (rows and columns added and removed where the
 * caret is), links, and pictures (pasted, dropped, or chosen), with Ctrl+B, Ctrl+I and Ctrl+U.
 * What is pasted keeps its formatting as far as the subset kept allows. The text is handed back
 * when the editor is left: as plain text alone when it has no formatting, else as HTML with its
 * pictures as the requirement's own files. Also: the same text shown (the panel, the review), its
 * links opening in a new tab, and the requirement's attached files (attach, open, save, remove).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  MAX_FILE, fileType, fromBase64, isRich, newFileId, opensInTab, sanitiseHtml, showPictures, sizeOf, sizeWords, textToHtml, htmlToText, toBase64, type ReqFile,
} from '../model/richText';
import { saveFileAs } from '../platform/fs';

/** The most a picture is across (its longest side, in pixels): larger ones are scaled down as they come in. */
const MAX_SIDE = 2000;

/** A picture file as a data: URL, scaled down when it is larger than MAX_SIDE. */
export async function pictureUrl(f: Blob): Promise<string> {
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(f.type) || typeof createImageBitmap !== 'function') return url;
  try {
    const bm = await createImageBitmap(f);
    const k = MAX_SIDE / Math.max(bm.width, bm.height);
    if (k >= 1) return url;
    const c = document.createElement('canvas');
    c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
    c.getContext('2d')!.drawImage(bm, 0, 0, c.width, c.height);
    return c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
  } catch { return url; }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

/**
 * The editor's content handed back: pictures already the requirement's files kept, pasted ones made
 * files, the rest cut to the subset kept. Plain text alone (html undefined) when there is no formatting.
 */
export function readBack(root: HTMLElement, files: ReqFile[]): { text: string; html?: string; files: ReqFile[] } {
  const clone = root.cloneNode(true) as HTMLElement;
  const kept = files.filter((f) => !f.inline);
  const inline: ReqFile[] = [];
  const ids = () => [...kept, ...inline, ...files].map((f) => f.id);
  for (const img of [...clone.querySelectorAll('img')]) {
    const id = img.getAttribute('data-kfile');
    const old = id ? files.find((f) => f.id === id) : undefined;
    if (old) { if (!inline.some((f) => f.id === old.id)) inline.push({ ...old, inline: true }); img.setAttribute('src', `kfile:${old.id}`); img.removeAttribute('data-kfile'); continue; }
    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(img.getAttribute('src') ?? '');
    if (!m) { img.remove(); continue; }
    const nid = newFileId(ids());
    inline.push({ id: nid, name: img.getAttribute('alt') || `Picture ${inline.length + 1}.${EXT[m[1]!] ?? 'png'}`, type: m[1]!, data: m[2]!.replace(/\s+/g, ''), inline: true });
    img.setAttribute('src', `kfile:${nid}`);
  }
  const html = sanitiseHtml(clone.innerHTML);
  const text = htmlToText(html);
  return isRich(html) ? { text, html, files: [...inline, ...kept] } : { text, files: kept };
}

type Cmd = 'bold' | 'italic' | 'underline' | 'superscript' | 'subscript' | 'insertUnorderedList' | 'insertOrderedList' | 'removeFormat';
const BUTTONS: [Cmd, string, string, string][] = [
  ['bold', 'B', 'Bold (Ctrl+B)', 'rt-b'], ['italic', 'I', 'Italic (Ctrl+I)', 'rt-i'], ['underline', 'U', 'Underline (Ctrl+U)', 'rt-u'],
  ['superscript', 'x²', 'Superscript', ''], ['subscript', 'x₂', 'Subscript', ''],
];

function ListIcon({ numbered }: { numbered?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {numbered
        ? <g fill="currentColor" font-size="5.5" font-family="sans-serif"><text x="0.5" y="5">1</text><text x="0.5" y="10">2</text><text x="0.5" y="15">3</text></g>
        : <g fill="currentColor"><circle cx="2.5" cy="3.5" r="1.3" /><circle cx="2.5" cy="8" r="1.3" /><circle cx="2.5" cy="12.5" r="1.3" /></g>}
      <path d="M6 3.5h9M6 8h9M6 12.5h9" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}
const TableIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" /><path d="M1.5 6.5h13M1.5 10h13M6 2.5v11M10.5 2.5v11" stroke="currentColor" stroke-width="0.8" /></svg>;
const LinkIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 9.5l2.5-3M6 6.2L4.4 7.8a2.4 2.4 0 003.4 3.4l1.3-1.3M10 9.8l1.6-1.6a2.4 2.4 0 00-3.4-3.4L6.9 6.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>;
const PictureIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" /><circle cx="5.5" cy="6" r="1.4" fill="currentColor" /><path d="M2 12.5l4-4 2.5 2.5 2-2 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>;
const ClearIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h8M7 3.5l-2 9" stroke="currentColor" stroke-width="1.4" /><path d="M9.5 9.5l4 4M13.5 9.5l-4 4" stroke="#c0392b" stroke-width="1.3" /></svg>;

/** The caret put at the start of an element. */
function caretIn(n: Element): void {
  const r = n.ownerDocument.createRange();
  r.selectNodeContents(n); r.collapse(true);
  const s = n.ownerDocument.getSelection();
  s?.removeAllRanges(); s?.addRange(r);
}

/** The cell the caret is in, and its row and table. */
function cellAt(root: HTMLElement): { td: HTMLTableCellElement; tr: HTMLTableRowElement; table: HTMLTableElement } | null {
  const s = (root.ownerDocument.defaultView ?? window).getSelection();
  let n: Node | null = s?.anchorNode ?? null;
  while (n && n !== root) {
    if ((n as Element | null)?.nodeType === 1 && /^(TD|TH)$/.test((n as Element).tagName)) { const td = n as HTMLTableCellElement; const tr = td.parentElement as HTMLTableRowElement; const table = td.closest('table') as HTMLTableElement; return table && root.contains(table) ? { td, tr, table } : null; }
    n = n.parentNode;
  }
  return null;
}

export function RichTextEditor({ id, text, html, files, label, placeholder, onCommit, onFiles }: {
  id: string; text: string; html?: string; files: ReqFile[]; label: string; placeholder: string;
  onCommit: (v: { text: string; html?: string; files: ReqFile[] }) => void;
  /** Files dropped that are not pictures: attached. */
  onFiles: (fs: File[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [inTable, setInTable] = useState(false);
  const [picked, setPicked] = useState<HTMLImageElement | null>(null);
  const pick = (img: HTMLImageElement | null) => { picked?.classList.remove('rt-picked'); img?.classList.add('rt-picked'); setPicked(img); };
  /** The picture picked shown at a width (in pixels; 0: as it is, up to the width of the text). */
  const widen = (w: number) => { if (!picked) return; if (w) picked.setAttribute('width', String(w)); else picked.removeAttribute('width'); commit(); };
  const [linking, setLinking] = useState<string | null>(null);
  const saved = useRef<Range | null>(null);
  const shown = useRef('');
  // The text shown afresh for another requirement, or when it changed elsewhere (undo, the panel)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const want = html ?? textToHtml(text);
    if (document.activeElement === el && shown.current === want) return;
    if (shown.current !== want || el.dataset.req !== id) { el.innerHTML = showPictures(want, files); shown.current = want; el.dataset.req = id; }
  }, [id, text, html, files]);
  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const v = readBack(el, filesRef.current);
    const was = html ?? textToHtml(text);
    if ((v.html ?? textToHtml(v.text)) === was && v.files.length === filesRef.current.length) return;
    shown.current = v.html ?? textToHtml(v.text);
    onCommit(v);
  };
  // (the document the editor is in: it may be a document window's)
  const doc = (): Document => ref.current?.ownerDocument ?? document;
  const run = (c: Cmd) => { ref.current?.focus(); doc().execCommand(c); };
  const insertHtml = (h: string) => { ref.current?.focus(); doc().execCommand('insertHTML', false, h); };
  const insertPictures = async (fs: File[]) => {
    const pics: string[] = [];
    for (const f of fs) {
      if (f.size > MAX_FILE) continue;
      pics.push(`<img src="${esc(await pictureUrl(f))}" alt="${esc(f.name && f.name !== 'image.png' ? f.name : '')}">`);
    }
    if (pics.length) { insertHtml(pics.join(' ')); commit(); }
  };
  const table = (op: 'add' | 'rowAfter' | 'colAfter' | 'delRow' | 'delCol') => {
    const el = ref.current;
    if (!el) return;
    if (op === 'add') {
      insertHtml('<table data-new="1"><tr><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td></tr></table><p><br></p>');
      const t = el.querySelector('table[data-new]');
      t?.removeAttribute('data-new');
      const first = t?.querySelector('th, td');
      if (first) caretIn(first);
      setInTable(!!first);
      return;
    }
    const at = cellAt(el);
    if (!at) return;
    const col = at.td.cellIndex;
    if (op === 'rowAfter') { const r = at.table.insertRow(at.tr.rowIndex + 1); for (let i = 0; i < at.tr.cells.length; i++) r.insertCell().innerHTML = '<br>'; }
    if (op === 'colAfter') for (const r of [...at.table.rows]) { const c = r.insertCell(Math.min(col + 1, r.cells.length)); c.innerHTML = '<br>'; if (r.cells[0]?.tagName === 'TH') { const th = document.createElement('th'); th.innerHTML = '<br>'; c.replaceWith(th); } }
    if (op === 'delRow') { if (at.table.rows.length <= 1) at.table.remove(); else at.tr.remove(); }
    if (op === 'delCol') { if (at.tr.cells.length <= 1) at.table.remove(); else for (const r of [...at.table.rows]) r.cells[Math.min(col, r.cells.length - 1)]?.remove(); }
    setInTable(!!cellAt(el));
    commit();
  };
  const startLink = () => {
    const s = doc().getSelection();
    saved.current = s && s.rangeCount && ref.current?.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
    const a = s?.anchorNode?.parentElement?.closest('a');
    setLinking(a?.getAttribute('href') ?? 'https://');
  };
  const applyLink = (href: string) => {
    setLinking(null);
    const el = ref.current;
    if (!el) return;
    el.focus();
    const s = doc().getSelection();
    if (saved.current && s) { s.removeAllRanges(); s.addRange(saved.current); }
    if (!/^(https?:\/\/\S+|mailto:\S+)$/i.test(href.trim())) { doc().execCommand('unlink'); commit(); return; }
    if (s && s.isCollapsed) doc().execCommand('insertHTML', false, `<a href="${esc(href.trim())}">${esc(href.trim())}</a>`);
    else doc().execCommand('createLink', false, href.trim());
    commit();
  };
  const btn = (title: string, on: () => void, body: preact.ComponentChildren, cls = '') => (
    <button type="button" class={`rt-btn ${cls}`} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={on}>{body}</button>
  );
  return (
    <div class="rt" onFocusOut={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) commit(); }}>
      <div class="rt-bar" role="toolbar" aria-label="Formatting">
        {BUTTONS.map(([c, t, title, cls]) => btn(title, () => run(c), t, cls))}
        <span class="rt-sep" />
        {btn('Bullet list', () => run('insertUnorderedList'), <ListIcon />)}
        {btn('Numbered list', () => run('insertOrderedList'), <ListIcon numbered />)}
        {btn('Insert a table', () => table('add'), <TableIcon />)}
        {btn('Link (a web or mail address)', startLink, <LinkIcon />)}
        <label class="rt-btn" title="Insert a picture" aria-label="Insert a picture" onMouseDown={(e) => e.preventDefault()}>
          <PictureIcon /><input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden aria-label="Picture to insert" onChange={(e) => { const i = e.target as HTMLInputElement; const fs = [...(i.files ?? [])]; i.value = ''; void insertPictures(fs); }} />
        </label>
        {btn('Clear the formatting of the selection', () => run('removeFormat'), <ClearIcon />)}
        {picked && ref.current?.contains(picked) && <>
          <span class="rt-sep" />
          <span class="rt-word muted">Picture</span>
          {btn('Picture small (200 pixels across)', () => widen(200), 'S', 'rt-word')}
          {btn('Picture medium (400 pixels across)', () => widen(400), 'M', 'rt-word')}
          {btn('Picture large (640 pixels across)', () => widen(640), 'L', 'rt-word')}
          {btn('Picture as it is (up to the width of the text)', () => widen(0), 'Full', 'rt-word')}
        </>}
        {inTable && <>
          <span class="rt-sep" />
          {btn('Add a row below', () => table('rowAfter'), '+Row', 'rt-word')}
          {btn('Add a column to the right', () => table('colAfter'), '+Col', 'rt-word')}
          {btn('Delete the row', () => table('delRow'), '−Row', 'rt-word')}
          {btn('Delete the column', () => table('delCol'), '−Col', 'rt-word')}
        </>}
      </div>
      {linking !== null && (
        <div class="rt-linkbar">
          <input aria-label="Link address" value={linking} autoFocus onInput={(e) => setLinking((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(linking); } if (e.key === 'Escape') { e.preventDefault(); setLinking(null); } }} />
          <button type="button" class="btn" onClick={() => applyLink(linking)}>Link</button>
          <button type="button" class="btn" onClick={() => applyLink('')} title="Remove the link from the selection">Unlink</button>
          <button type="button" class="btn" onClick={() => setLinking(null)}>Cancel</button>
        </div>
      )}
      <div ref={ref} class="rt-text rich" contentEditable role="textbox" aria-multiline="true" aria-label={label} data-placeholder={placeholder}
        onFocus={() => doc().execCommand('defaultParagraphSeparator', false, 'p')}
        onKeyUp={() => { setInTable(!!(ref.current && cellAt(ref.current))); if (picked && !ref.current?.contains(picked)) pick(null); }}
        onMouseUp={() => setInTable(!!(ref.current && cellAt(ref.current)))}
        onClick={(e) => pick((e.target as HTMLElement).tagName === 'IMG' ? e.target as HTMLImageElement : null)}
        onKeyDown={(e) => {
          if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); startLink(); return; }
          // Tab and Shift+Tab move between a table's cells (Tab in the last one adds a row)
          if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && ref.current) {
            const at = cellAt(ref.current);
            if (!at) return;
            e.preventDefault();
            const cells = [...at.table.querySelectorAll('th, td')];
            const i = cells.indexOf(at.td) + (e.shiftKey ? -1 : 1);
            if (i >= 0 && i < cells.length) { caretIn(cells[i]!); return; }
            if (!e.shiftKey) { const r = at.table.insertRow(-1); for (let k = 0; k < at.tr.cells.length; k++) r.insertCell().innerHTML = '<br>'; caretIn(r.cells[0]!); }
          }
        }}
        onPaste={(e) => {
          const dt = e.clipboardData;
          if (!dt) return;
          const h = dt.getData('text/html');
          const pics = [...dt.files].filter((f) => f.type.startsWith('image/'));
          // A picture alone (copied from a viewer or a web page): the picture itself, not its address
          if (pics.length && (!h || !htmlToText(sanitiseHtml(h)).replace(/\[[^\]]*\]/g, '').trim())) { e.preventDefault(); void insertPictures(pics); return; }
          if (h) { e.preventDefault(); insertHtml(sanitiseHtml(h)); return; }
          const t = dt.getData('text/plain');
          if (t) { e.preventDefault(); doc().execCommand('insertText', false, t); }
        }}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); }}
        onDrop={(e) => {
          const fs = [...(e.dataTransfer?.files ?? [])];
          if (!fs.length) return;
          e.preventDefault();
          const range = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
          if (range) { const s = doc().getSelection(); s?.removeAllRanges(); s?.addRange(range); }
          const pics = fs.filter((f) => f.type.startsWith('image/')), other = fs.filter((f) => !f.type.startsWith('image/'));
          if (pics.length) void insertPictures(pics);
          if (other.length) onFiles(other);
        }}
      />
    </div>
  );
}

/** The text as shown (not edited): its pictures, its links opening in a new tab. */
export function RichView({ text, html, files, class: cls = '' }: { text: string; html?: string; files?: ReqFile[]; class?: string }) {
  if (!html) return text ? <p class={cls} style={{ whiteSpace: 'pre-wrap' }}>{text}</p> : null;
  return (
    <div class={`rich ${cls}`} dangerouslySetInnerHTML={{ __html: showPictures(html, files) }}
      onClick={(e) => { const a = (e.target as HTMLElement).closest('a'); if (a) { e.preventDefault(); window.open(a.getAttribute('href') ?? '', '_blank', 'noopener'); } }} />
  );
}

/** A file opened in a new tab (a PDF, a picture, plain text), or saved where it can't be shown or shouldn't be opened as a page (opensInTab). */
export function openFile(f: ReqFile): void {
  if (!opensInTab(f)) { void saveFileAs(f.name, fromBase64(f.data)); return; }
  const url = URL.createObjectURL(new Blob([fromBase64(f.data) as Uint8Array<ArrayBuffer>], { type: fileType(f.type) }));
  const w = window.open(url, '_blank');
  if (!w) void saveFileAs(f.name, fromBase64(f.data));
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A file from the computer as a requirement's attachment (null: too large). */
export async function attachmentOf(f: File, taken: string[]): Promise<ReqFile | null> {
  if (f.size > MAX_FILE) return null;
  return { id: newFileId(taken), name: f.name, type: f.type || 'application/octet-stream', data: toBase64(new Uint8Array(await f.arrayBuffer())) };
}

/** The requirement's attached files: open, save, remove (when it can be changed), and attach more. */
export function Attachments({ files, onAttach, onRemove }: { files: ReqFile[]; onAttach?: (fs: File[]) => void; onRemove?: (id: string) => void }) {
  const att = files.filter((f) => !f.inline);
  const [over, setOver] = useState(false);
  return (
    <div class={`rq-files${over ? ' over' : ''}`}
      onDragOver={(e) => { if (onAttach && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const fs = [...(e.dataTransfer?.files ?? [])]; if (onAttach && fs.length) { e.preventDefault(); onAttach(fs); } }}>
      <div class="rq-files-head">
        <span>Attached files{att.length ? ` (${att.length})` : ''}</span>
        {onAttach && <label class="btn rq-attach">Attach…<input type="file" multiple hidden aria-label="Files to attach" onChange={(e) => { const i = e.target as HTMLInputElement; const fs = [...(i.files ?? [])]; i.value = ''; if (fs.length) onAttach(fs); }} /></label>}
      </div>
      {att.length ? (
        <ul>
          {att.map((f) => (
            <li key={f.id}>
              <button class="link" title={`Open ${f.name}`} onClick={() => openFile(f)}>{f.name}</button>
              <span class="muted small">{sizeWords(sizeOf(f))}</span>
              <button class="rq-file-btn" title={`Save ${f.name} as…`} aria-label={`Save ${f.name}`} onClick={() => void saveFileAs(f.name, fromBase64(f.data))}>Save</button>
              {onRemove && <button class="reqp-unlink" title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.id)}>×</button>}
            </li>
          ))}
        </ul>
      ) : onAttach ? <p class="small muted">None. Drop files here, or Attach… (drawings, datasheets, test reports; up to {sizeWords(MAX_FILE)} each, kept in the document).</p> : null}
    </div>
  );
}
/** A requirement's files in a word, as a paperclip: "2 pictures, 1 attached file". */
export function Clip({ files }: { files: ReqFile[] }) {
  const pics = files.filter((f) => f.inline).length, att = files.length - pics;
  const words = [pics ? `${pics} picture${pics === 1 ? '' : 's'}` : '', att ? `${att} attached file${att === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  return (
    <span class="rq-clip" title={words} aria-label={words}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5l-5 5a1.4 1.4 0 002 2l5.5-5.5a2.8 2.8 0 00-4-4L3.5 7.5a4.2 4.2 0 006 6l4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
      {att ? att : ''}
    </span>
  );
}
