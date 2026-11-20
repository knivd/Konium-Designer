/**
 * The CAM editor's File › Setup (General, Import/Export) [est: CAMtastic's options]: how loaded files
 * that don't say are read (Gerber's and Excellon's units, digits and zeros; DXF's units), whether
 * loaded layers are sorted into the stack, how the editor draws at first. Kept in this browser.
 */
import type { ReadDefaults } from '../formats/gerber/gerberRead';

export interface CamPrefs {
  sortOnLoad: boolean;
  fill: boolean;
  translucent: boolean;
  showOrigin: boolean;
  gerberUnits: 'in' | 'mm'; gerberInt: number; gerberDec: number; gerberZeros: 'L' | 'T';
  drillUnits: 'in' | 'mm'; drillInt: number; drillDec: number; drillZeros: 'L' | 'T';
  dxfUnits: 'mm' | 'in' | 'mil';
  dxfWidth: number;
}

const KEY = 'konium.camPrefs';
export const DEFAULT_CAM_PREFS: CamPrefs = {
  sortOnLoad: true, fill: true, translucent: false, showOrigin: false,
  gerberUnits: 'in', gerberInt: 2, gerberDec: 4, gerberZeros: 'L',
  drillUnits: 'in', drillInt: 2, drillDec: 4, drillZeros: 'L',
  dxfUnits: 'mm', dxfWidth: 39370, // 0.1 mm
};

let prefs: CamPrefs = (() => {
  try { const raw = globalThis.localStorage?.getItem(KEY); return raw ? { ...DEFAULT_CAM_PREFS, ...(JSON.parse(raw) as Partial<CamPrefs>) } : { ...DEFAULT_CAM_PREFS }; } catch { return { ...DEFAULT_CAM_PREFS }; }
})();

export const camPrefs = (): CamPrefs => prefs;
export function setCamPrefs(p: Partial<CamPrefs>): void {
  prefs = { ...prefs, ...p };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage off: kept for this session */ }
}

/** What files that don't say are read as. */
export function readDefaults(): { gerber: ReadDefaults; drill: ReadDefaults } {
  const p = prefs;
  return { gerber: { units: p.gerberUnits, int: p.gerberInt, dec: p.gerberDec, omit: p.gerberZeros }, drill: { units: p.drillUnits, int: p.drillInt, dec: p.drillDec, omit: p.drillZeros } };
}
