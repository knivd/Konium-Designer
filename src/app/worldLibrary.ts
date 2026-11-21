/**
 * The world parts library as the app holds it (R21, step 2): who is signed in here, and a part
 * coming from the library to the shelf or going from the shelf to the library. The requests are
 * platform/libraryService.ts's; this keeps the views in step with them.
 */
import { signal } from '@preact/signals';
import { keptSession, libraryNote, publishPart, sayOfPart, signOut, type FoundPart, type LibrarySession, type Published } from '../platform/libraryService';
import { standingText, type LibraryEntry, type Verdict } from '../model/worldLibrary';
import { SR, bagOf, ownedBy, type SchDocument } from '../model/sch';
import { partSource } from '../model/schUpdate';
import { partKey } from '../model/partKey';
import { SHELF_SCH, type PartPackage } from '../model/partPackage';
import { APP_VERSION } from '../platform/distribution';
import { keepPart, shelf } from './partShelf';
import { compileChecks } from './compiled';
import { featureOn } from '../core/release';

/** The sign-in kept in this browser (null: none). */
export const librarySession = signal<LibrarySession | null>(keptSession());
/** After a request: what is kept now (a pass the service refused has been forgotten). */
export const syncSession = (): LibrarySession | null => (librarySession.value = keptSession());
export function leaveLibrary(): void { signOut(); librarySession.value = null; }

/** A part found in the library put on the shelf, with the library's note about it. True when it replaced one. */
export const keepFound = (f: FoundPart): boolean => keepPart(f.part);

/** A part of the shelf published; the copy on the shelf then carries the library's note. */
export async function publishFromShelf(p: PartPackage, o: { agreed: boolean; name?: string }, f: typeof fetch = fetch): Promise<Published> {
  try {
    const done = await publishPart(p, { ...o, app: APP_VERSION }, f);
    keepPart({ ...p, record: { ...p.record, library: done.entry } });
    return done;
  } finally { syncSession(); }
}

/**
 * What the library says of a part of the shelf now (step 3): the copy on the shelf takes the note
 * when it is of the revision it has, so that its standing and what has been said of it are up to
 * date. `newer`: the library has a later revision than the shelf (the copy is left as it is: the
 * later one is fetched by looking the number up). `gone`: the library no longer has it.
 */
export async function refreshNote(p: PartPackage, f: typeof fetch = fetch): Promise<{ entry: LibraryEntry | null; newer: boolean; changed: boolean }> {
  const noted = await libraryNote(p.record.mpn, f);
  if (!noted) return { entry: null, newer: false, changed: false };
  const had = p.record.library, same = !had || noted.entry.revision === had.revision;
  const changed = same && JSON.stringify(noted.entry) !== JSON.stringify(had ?? null);
  // (a part of the shelf that was never the library's is not made one by being asked about)
  if (had && changed) keepPart({ ...p, record: { ...p.record, library: noted.entry } });
  return { entry: noted.entry, newer: !!had && noted.entry.revision > had.revision, changed: !!had && changed };
}

/** A word about a part of the shelf sent to the library; the copy on the shelf then carries the note with it. */
export async function reviewFromShelf(p: PartPackage, verdict: Verdict, o: { note?: string; name?: string } = {}, f: typeof fetch = fetch): Promise<LibraryEntry> {
  const had = p.record.library;
  if (!had) throw new Error('This part is not in the world library');
  try {
    const done = await sayOfPart(had, verdict, o, f);
    keepPart({ ...p, record: { ...p.record, library: done.entry } });
    return done.entry;
  } finally { syncSession(); }
}

/**
 * What a compile says of the design's parts that came from the shelf and are the world library's
 * (step 3): one that is Unverified is named, with where it stands; one that people have found
 * something wrong with, whatever its standing, is named with the latest of it. The shelf's note
 * is what is gone by: nothing is asked of the library here (Check the World Library asks).
 */
export function libraryWarnings(sheets: { name: string; doc: SchDocument }[], parts: readonly PartPackage[] = shelf.value): { doc: string; level: 'warn'; message: string }[] {
  const noted = new Map(parts.flatMap((p) => (p.record.library ? [[partKey(p.record.mpn), p.record.library] as const] : [])));
  const out: { doc: string; level: 'warn'; message: string }[] = [];
  if (!noted.size) return out;
  for (const s of sheets) {
    const kids = ownedBy(s.doc);
    for (const o of s.doc.objects) {
      if (o.kind !== 'component' || partSource(s.doc, o.index)?.library !== SHELF_SCH) continue;
      const mpn = (kids.get(o.index) ?? []).map((k) => bagOf(s.doc, k)).find((b) => b?.int('RECORD', -1) === SR.PARAMETER && (b.get('NAME') ?? '').toLowerCase() === 'manufacturer part number')?.get('TEXT') ?? '';
      const e = noted.get(partKey(mpn)), wrong = e?.problems ?? [];
      if (!e) continue;
      if (e.status === 'unverified') out.push({ doc: s.name, level: 'warn', message: `${o.designator} (${e.mpn}) is an Unverified part of the world library (${standingText(e)}): check it against its datasheet` });
      else if (wrong.length) out.push({ doc: s.name, level: 'warn', message: `${o.designator} (${e.mpn}): ${wrong.length === 1 ? 'a problem has' : `${wrong.length} problems have`} been reported with this part in the world library: ${wrong.at(-1)!.note ?? ''}` });
    }
  }
  return out;
}
// (said at every compile while the parts library is on)
compileChecks.set('World Library', (sheets) => (featureOn('partsLibrary') ? libraryWarnings(sheets) : []));

