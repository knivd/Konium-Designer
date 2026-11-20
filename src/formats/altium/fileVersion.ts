/**
 * FileVersionInfo: the format versions the program that saved a board knew, each with a message
 * for a program newer than it (what changes reading an older file) and one for an older program
 * (what it can't keep). AD shows them on opening, as the File Format Change Report
 * (Preferences › PCB Editor › General): from a newer file, the messages of the versions past the
 * reader's; from an older one, the changes since. Konium reads boards as AD17 does (Release 17.1).
 */
import { cfbStream, type CfbEntry } from '../cfb/cfb';
import { splitTextRecords } from './framing';

export interface FormatVersion { version: string; forward: string; backward: string }

/** How many versions the format had by Release 17.1, the level Konium reads and writes. */
export const KONIUM_FORMAT_VERSIONS = 33;
export const KONIUM_FORMAT = 'Release 17.1';

/** A message or version name: character codes, comma-separated. */
const chars = (s: string | undefined): string => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => String.fromCharCode(Number(x) || 32)).join('');

export function formatVersions(root: CfbEntry): FormatVersion[] | null {
  const data = cfbStream(root, 'FileVersionInfo/Data');
  if (!data?.length) return null;
  const bag = splitTextRecords(data)[0];
  if (!bag) return null;
  const n = bag.int('COUNT');
  const out: FormatVersion[] = [];
  for (let i = 0; i < n; i++) out.push({ version: chars(bag.get(`VER${i}`)), forward: chars(bag.get(`FWDMSG${i}`)), backward: chars(bag.get(`BKMSG${i}`)) });
  return out;
}

/**
 * In Konium's own words, what changed in the format after each version a file may be older than
 * (the versions with something to say when an older board is read) [est: from the format's history].
 */
const SINCE: [index: number, what: string][] = [
  [0, 'Vias joining hatched and solid signal-layer pours now connect as the Polygon Connect Style rule says: repouring may change the copper.'],
  [15, 'Old-style violation objects are no longer kept.'],
  [17, 'Testpoint rules and settings become fabrication testpoint ones.'],
  [23, 'The air gap of a pour\'s connections comes from the Polygon Connect Style rule, no longer from the Clearance rule.'],
  [24, 'Silkscreen Over Component Pads rules become Silk To Solder Mask Clearance rules.'],
];

export interface ChangeReport { kind: 'older' | 'newer'; savedBy: string; notes: string[] }

/** What the File Format Change Report says of a board opened in Konium (null: same level, or nothing to say). */
export function changeReport(versions: FormatVersion[] | null): ChangeReport | null {
  if (!versions?.length) return null;
  const savedBy = versions.at(-1)!.version;
  if (versions.length > KONIUM_FORMAT_VERSIONS) {
    // Newer: what the saving program said an older one can't keep (its own words), for each version past Konium's
    const notes = versions.slice(KONIUM_FORMAT_VERSIONS).map((v) => plain(v.backward)).filter(Boolean);
    return notes.length ? { kind: 'newer', savedBy, notes } : null;
  }
  if (versions.length < KONIUM_FORMAT_VERSIONS) {
    const notes = SINCE.filter(([v]) => v >= versions.length).map(([, w]) => w);
    return { kind: 'older', savedBy, notes };
  }
  return null;
}

/** A message's text without its markup. */
export function plain(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
