import { schStorage, storedFile, type StoredFile } from '../../formats/altium/schdoc';
import type { SchDocument } from '../../model/sch';

/**
 * Pictures embedded in a schematic (Place › Drawing Tools › Graphic with Embed Image): the
 * Storage stream keeps each file zlib-compressed. Decoding is asynchronous; `ready` runs once a
 * picture can be drawn, so the editor redraws. Linked (not embedded) pictures stay placeholders.
 */
type Entry = HTMLImageElement | 'pending' | 'failed';
const decoded = new WeakMap<SchDocument, Map<string, Entry>>();
const stores = new WeakMap<SchDocument, StoredFile[]>();

function mimeOf(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** zlib (RFC 1950) → bytes, with the browser's own decompressor. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decode(f: StoredFile): Promise<HTMLImageElement> {
  const bytes = await inflate(f.data);
  const type = mimeOf(bytes);
  if (!type) throw new Error(`${f.name}: not a picture the browser can show`);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const img = new Image();
  img.src = url;
  try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  return img;
}

/** The picture for an image record, or null while it decodes (or if it can't be shown). */
export function embeddedImage(doc: SchDocument, fileName: string, ready: () => void): HTMLImageElement | null {
  let m = decoded.get(doc);
  if (!m) { m = new Map(); decoded.set(doc, m); }
  const e = m.get(fileName);
  if (e) return typeof e === 'string' ? null : e;
  let files = stores.get(doc);
  if (!files) { files = schStorage(doc); stores.set(doc, files); }
  const f = storedFile(files, fileName);
  if (!f || typeof DecompressionStream === 'undefined' || typeof Image === 'undefined') { m.set(fileName, 'failed'); return null; }
  m.set(fileName, 'pending');
  decode(f).then((img) => { m.set(fileName, img); ready(); }, () => { m.set(fileName, 'failed'); });
  return null;
}

/**
 * Linked pictures (Place › Graphic, Embed Image off): the file picked this session, by its
 * FILENAME, so the sheet shows it; a linked picture from elsewhere stays a crossed box.
 */
const linked = new Map<string, Entry>();
export function linkImage(fileName: string, bytes: Uint8Array, ready: () => void): void {
  const type = mimeOf(bytes);
  if (!type || typeof Image === 'undefined') { linked.set(fileName.toLowerCase(), 'failed'); return; }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const img = new Image();
  linked.set(fileName.toLowerCase(), 'pending');
  img.onload = () => { linked.set(fileName.toLowerCase(), img); ready(); };
  img.onerror = () => linked.set(fileName.toLowerCase(), 'failed');
  img.src = url;
}
export function linkedImage(fileName: string): HTMLImageElement | null {
  const e = linked.get(fileName.toLowerCase()) ?? linked.get(fileName.split(/[\\/]/).pop()!.toLowerCase());
  return e && typeof e !== 'string' ? e : null;
}
/** The picture's own width / height, when known (Keep Aspect). */
export function imageAspect(fileName: string): number | null {
  const i = linkedImage(fileName);
  return i && i.naturalHeight ? i.naturalWidth / i.naturalHeight : null;
}
