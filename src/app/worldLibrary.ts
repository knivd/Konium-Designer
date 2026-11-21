/**
 * The world parts library as the app holds it (R21, step 2): who is signed in here, and a part
 * coming from the library to the shelf or going from the shelf to the library. The requests are
 * platform/libraryService.ts's; this keeps the views in step with them.
 */
import { signal } from '@preact/signals';
import { keptSession, publishPart, signOut, type FoundPart, type LibrarySession, type Published } from '../platform/libraryService';
import type { PartPackage } from '../model/partPackage';
import { APP_VERSION } from '../platform/distribution';
import { keepPart } from './partShelf';

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
