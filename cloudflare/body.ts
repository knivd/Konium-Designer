/**
 * A request's body read no further than it may be long. The Content-Length header is the
 * sender's word and may be missing or untrue, so the limit is kept while reading: nothing past
 * it is taken into memory, whatever the header says.
 */

/** The body's bytes, or null when it is longer than `most` (the rest is left unread). */
export async function bodyUpTo(req: Request, most: number): Promise<Uint8Array | null> {
  const said = req.headers.get('Content-Length');
  if (said !== null && !(Number(said) <= most)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > most) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The body as JSON, read no further than `most` bytes: 'long' when it is longer, 'bad' when it isn't JSON. */
export async function jsonUpTo<T>(req: Request, most: number): Promise<T | 'long' | 'bad'> {
  const bytes = await bodyUpTo(req, most);
  if (!bytes) return 'long';
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return 'bad'; }
}
