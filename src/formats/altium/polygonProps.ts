/**
 * Polygons6 properties as AD writes them (checked against AD17–AD20 boards; AD17 refuses a board
 * whose NAME isn't in this form: "'…' is not a valid integer value"):
 * - NAME: comma-separated character codes ("103,110,100" = "gnd"), like a 3D body's IDENTIFIER;
 * - POUROVER: TRUE / FALSE, with POUROVERSTYLE 1 = Pour Over All Same Net Objects
 *   (0 Don't Pour Over, 2 Pour Over Same Net Polygons Only [est: 0 and 2]);
 * - AREATHRESHOLD: Remove Islands Less Than, in internal units squared (2500 sq. mils = 250000000000);
 * - SHELVED, RESTORELAYER, RESTORENET, IGNOREVIOLATIONS.
 * Boards Konium wrote before 26.026 (POUROVER=SameNet …, ISLANDAREATHRESHOLD in sq. mils, NAME in
 * plain text) still read.
 */
import { PropertyBag } from './props';
import { changedBagDefaults } from '../../model/bagDefaults';

const UNITS2_PER_SQMIL = 1e8;

/** "103,110,100" → "gnd"; anything else as it is. */
export const fromCharCodes = (v: string): string => (/^\d+(,\d+)*$/.test(v.trim()) ? String.fromCharCode(...v.trim().split(',').map(Number)) : v);
/** "gnd" → "103,110,100". */
export const toCharCodes = (s: string): string => [...s].map((c) => c.charCodeAt(0)).join(',');

export const polygonName = (b: PropertyBag): string => fromCharCodes(b.get('NAME') ?? '');
export function setPolygonName(b: PropertyBag, name: string): void { b.set('NAME', toCharCodes(name)); }

export type PourOver = 'SameNet' | 'SameNetPolygon' | 'None';
const STYLE: Record<PourOver, number> = { None: 0, SameNet: 1, SameNetPolygon: 2 };

export function pourOverOf(b: PropertyBag): PourOver {
  const v = (b.get('POUROVER') ?? '').trim().toLowerCase();
  if (v === 'samenetpolygon') return 'SameNetPolygon';
  if (v === 'samenet') return 'SameNet';
  if (v === 'none' || v === 'false') return 'None';
  const s = b.int('POUROVERSTYLE', 1);
  return s === 0 ? 'None' : s === 2 ? 'SameNetPolygon' : 'SameNet';
}
export function setPourOver(b: PropertyBag, p: PourOver): void {
  b.set('POUROVER', p === 'None' ? 'FALSE' : 'TRUE');
  b.set('POUROVERSTYLE', String(STYLE[p]));
}

/** Remove Islands Less Than, in sq. mils. */
export function islandAreaOf(b: PropertyBag): number {
  if (b.has('AREATHRESHOLD')) return b.float('AREATHRESHOLD', 0) / UNITS2_PER_SQMIL;
  return b.float('ISLANDAREATHRESHOLD', 2500);
}
export function setIslandArea(b: PropertyBag, sqMils: number): void {
  b.set('AREATHRESHOLD', (sqMils * UNITS2_PER_SQMIL).toFixed(6));
  b.delete('ISLANDAREATHRESHOLD');
}

/** A board read from an earlier Konium: its pour definitions put into AD's form (unchanged otherwise). */
export function adPolygonBag(b: PropertyBag): PropertyBag {
  const v = (b.get('POUROVER') ?? '').trim().toLowerCase();
  const plainName = b.has('NAME') && !/^\d+(,\d+)*$/.test((b.get('NAME') ?? '').trim());
  if (!(v === 'samenet' || v === 'samenetpolygon' || v === 'none') && !b.has('ISLANDAREATHRESHOLD') && !plainName && !b.has('AUTOGENERATENAME')) return b;
  const out = b.clone();
  if (v === 'samenet' || v === 'samenetpolygon' || v === 'none') setPourOver(out, pourOverOf(b));
  if (b.has('ISLANDAREATHRESHOLD')) setIslandArea(out, islandAreaOf(b));
  if (plainName) setPolygonName(out, b.get('NAME') ?? '');
  out.delete('AUTOGENERATENAME');
  return out;
}

/**
 * A new pour definition with AD17's keys (vertices are added by writeVertices): solid, pour
 * over all same-net objects, dead copper removed, 20 mil grid, 8 mil tracks.
 */
export function newPolygonProps(layerName: string, net: number, name: string, index: number, userDefaults = false): PropertyBag {
  const b = PropertyBag.from({
    SELECTION: 'FALSE', LAYER: layerName, LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0',
    PRIMITIVELOCK: 'TRUE', POLYGONTYPE: 'Polygon', POUROVER: 'TRUE', REMOVEDEAD: 'TRUE', GRIDSIZE: '20mil', TRACKWIDTH: '8mil', HATCHSTYLE: 'Solid',
    USEOCTAGONS: 'FALSE', MINPRIMLENGTH: '3mil', SHELVED: 'FALSE', RESTORELAYER: 'UNKNOWN', RESTORENET: '', REMOVEISLANDSBYAREA: 'FALSE',
    REMOVENECKS: 'FALSE', AREATHRESHOLD: (2500 * UNITS2_PER_SQMIL).toFixed(6), ARCRESOLUTION: '0.5mil', NECKWIDTHTHRESHOLD: '5mil', POUROVERSTYLE: '1',
    NAME: toCharCodes(name), POURINDEX: String(index), IGNOREVIOLATIONS: 'FALSE', NET: String(net),
  });
  // Preferences › Defaults › Polygon: what was changed from AD17's, for one placed (not one read from another tool's file)
  if (userDefaults) for (const [k, v] of Object.entries(changedBagDefaults('Polygon'))) b.set(k, v);
  return b;
}
