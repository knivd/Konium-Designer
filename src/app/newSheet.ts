import { settings } from '../core/settings';
import { SCH_UNIT_CODES, type DisplayUnit } from '../core/units';
import type { SchUnits } from '../model/schProps';
import { newSchDoc } from '../formats/altium/schdoc';
import { SHEET_SIZES } from '../model/schSpecial';
import type { SchDocument } from '../model/sch';

/** The DISPLAY_UNIT Preferences › Schematic › Defaults give an imperial or metric sheet. */
export function schUnitCode(metric: boolean): number {
  if (metric) return { mm: SCH_UNIT_CODES.mm, cm: SCH_UNIT_CODES.cm, m: SCH_UNIT_CODES.m, auto: SCH_UNIT_CODES.autoMetric }[settings.schMetricUnit];
  return { dxp: SCH_UNIT_CODES.dxp, mil: SCH_UNIT_CODES.mil, in: SCH_UNIT_CODES.in, auto: SCH_UNIT_CODES.autoImperial }[settings.schImperialUnit];
}
/** The unit a sheet shows lengths in: its DISPLAY_UNIT (absent, like any Altium integer, is 0: mils). */
export const sheetUnit = (doc: SchDocument): number => Math.max(0, doc.sheet.unit);
/** The units a schematic editor's fields use: its sheet's own (Document Options › Units: Dxp Defaults are plain 10 mil units); a library's, the editor's. */
export const schUnitsOf = (ed: { doc: SchDocument; libraryMode?: boolean }, editorUnit: DisplayUnit): SchUnits => (ed.libraryMode ? editorUnit : sheetUnit(ed.doc));

/**
 * File › New › Schematic and the sheets the commands make: Preferences › General › Default Blank Sheet Size, in the
 * unit system Preferences › Schematic › Default Units chooses (its imperial or metric unit).
 */
export const newSheet = (name: string): SchDocument => newSchDoc(name, Math.max(0, SHEET_SIZES.indexOf(settings.schDefaultSheet)), schUnitCode(settings.defaultUnits === 'mm'));
