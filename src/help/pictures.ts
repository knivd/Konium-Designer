/**
 * The help's pictures: WebP files in src/help/pictures/ (made by tests/tools/helpPictures.py from
 * the demo project), built into the app so the help is whole offline. Each is read when first shown.
 */
const FILES = import.meta.glob('./pictures/*.webp', { query: '?inline', import: 'default' }) as Record<string, () => Promise<string>>;

const idOf = (path: string) => path.slice('./pictures/'.length, -'.webp'.length);
export const PICTURE_IDS: string[] = Object.keys(FILES).map(idOf);
const byId = new Map(Object.entries(FILES).map(([k, f]) => [idOf(k), f]));

/** A picture as a data URL (null: there is no such picture). */
export async function pictureUrl(id: string): Promise<string | null> {
  const f = byId.get(id);
  return f ? f() : null;
}
