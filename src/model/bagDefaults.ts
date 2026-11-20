/**
 * Preferences › PCB Editor › Defaults for the kinds that aren't one record: Component (its
 * designator and comment strings), Coordinate, Dimension and Polygon — each a set of AD's
 * properties the next one placed starts from (Polygon: the pour's; Dimension: the line, text,
 * arrow and extension lines' sizes). AD17's own values are the starting point; what is changed is
 * kept in this browser beside the record defaults (model/pcbDefaults) [est: AD's .DFT keeps them].
 */
/** The dimension kinds with a set of their own (26.185): each starts from Dimension's and keeps what it changes. */
export const DIMENSION_KINDS = ['Angular Dimension', 'Baseline Dimension', 'Centre Dimension', 'Datum Dimension', 'Leader Dimension', 'Linear Diameter Dimension', 'Linear Dimension', 'Radial Diameter Dimension', 'Radial Dimension'] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];
export type BagKind = 'Component' | 'Coordinate' | 'Dimension' | 'Polygon' | DimensionKind | 'Component Body' | 'Drill Table' | 'Layer Stack Table' | 'Keepout Arc' | 'Keepout Track';
export interface BagField { key: string; label: string; def: string; kind: 'len' | 'bool' | 'int' | 'choice'; choices?: [string, string][] }

const BASE_FIELDS: Record<'Component' | 'Coordinate' | 'Dimension' | 'Polygon', BagField[]> = {
  Component: [
    { key: 'DESIGNATORHEIGHT', label: 'Designator Height', def: '60mil', kind: 'len' }, { key: 'DESIGNATORWIDTH', label: 'Designator Width', def: '10mil', kind: 'len' },
    { key: 'COMMENTHEIGHT', label: 'Comment Height', def: '60mil', kind: 'len' }, { key: 'COMMENTWIDTH', label: 'Comment Width', def: '10mil', kind: 'len' },
    { key: 'NAMEON', label: 'Show Designator', def: 'TRUE', kind: 'bool' }, { key: 'COMMENTON', label: 'Show Comment', def: 'FALSE', kind: 'bool' },
  ],
  Coordinate: [
    { key: 'LINEWIDTH', label: 'Line Width', def: '10mil', kind: 'len' }, { key: 'TEXTHEIGHT', label: 'Text Height', def: '40mil', kind: 'len' },
    { key: 'SIZE', label: 'Size', def: '40mil', kind: 'len' },
    { key: 'UNITSTYLE', label: 'Unit Style', def: 'Board', kind: 'choice', choices: [['Board', 'As the board measures'], ['Mils', 'Mils'], ['Millimeters', 'Millimetres']] },
  ],
  Dimension: [
    { key: 'LINEWIDTH', label: 'Line Width', def: '10mil', kind: 'len' }, { key: 'TEXTHEIGHT', label: 'Text Height', def: '60mil', kind: 'len' },
    { key: 'TEXTWIDTH', label: 'Text Width', def: '6mil', kind: 'len' }, { key: 'TEXTGAP', label: 'Text Gap', def: '10mil', kind: 'len' },
    { key: 'ARROWSIZE', label: 'Arrow Size', def: '60mil', kind: 'len' }, { key: 'ARROWLINEWIDTH', label: 'Arrow Line Width', def: '10mil', kind: 'len' },
    { key: 'ARROWLENGTH', label: 'Arrow Length', def: '100mil', kind: 'len' },
    { key: 'ARROWPOSITION', label: 'Arrow Position', def: 'Inside', kind: 'choice', choices: [['Inside', 'Inside'], ['Outside', 'Outside']] },
    { key: 'EXTENSIONOFFSET', label: 'Extension Offset', def: '10mil', kind: 'len' }, { key: 'EXTENSIONLINEWIDTH', label: 'Extension Line Width', def: '10mil', kind: 'len' },
    { key: 'EXTENSIONPICKGAP', label: 'Extension Pick Gap', def: '10mil', kind: 'len' }, { key: 'TEXTPRECISION', label: 'Precision', def: '2', kind: 'int' },
  ],
  Polygon: [
    { key: 'HATCHSTYLE', label: 'Fill Mode / Hatch', def: 'Solid', kind: 'choice', choices: [['Solid', 'Solid (Copper Regions)'], ['90Degree', 'Hatched 90 degrees'], ['45Degree', 'Hatched 45 degrees'], ['Horizontal', 'Hatched horizontal'], ['Vertical', 'Hatched vertical'], ['None', 'None (Outlines Only)']] },
    { key: 'GRIDSIZE', label: 'Grid Size', def: '20mil', kind: 'len' }, { key: 'TRACKWIDTH', label: 'Track Width', def: '8mil', kind: 'len' },
    { key: 'MINPRIMLENGTH', label: 'Min Prim Length', def: '3mil', kind: 'len' }, { key: 'ARCRESOLUTION', label: 'Arc Approximation', def: '0.5mil', kind: 'len' },
    { key: 'POUROVER', label: 'Pour Over All Same Net Objects', def: 'TRUE', kind: 'bool' }, { key: 'REMOVEDEAD', label: 'Remove Dead Copper', def: 'TRUE', kind: 'bool' },
    { key: 'REMOVENECKS', label: 'Remove Necks', def: 'FALSE', kind: 'bool' }, { key: 'NECKWIDTHTHRESHOLD', label: 'Neck Width', def: '5mil', kind: 'len' },
  ],
};
/** A keepout's line: 0 leaves it as it was before it had a default of its own (a track the routing width, an arc the arc default's). */
const KEEPOUT_LINE: BagField[] = [{ key: 'LINEWIDTH', label: 'Line Width (0: as a track or arc placed)', def: '0mil', kind: 'len' }];
const TABLE_TEXT: BagField[] = [{ key: 'TEXTHEIGHT', label: 'Text Height', def: '60mil', kind: 'len' }];
export const BAG_FIELDS: Record<BagKind, BagField[]> = {
  ...BASE_FIELDS,
  ...(Object.fromEntries(DIMENSION_KINDS.map((k) => [k, BASE_FIELDS.Dimension])) as Record<DimensionKind, BagField[]>),
  'Component Body': [
    { key: 'OVERALL', label: 'Overall Height', def: '1mm', kind: 'len' }, { key: 'STANDOFF', label: 'Standoff Height', def: '0mil', kind: 'len' },
    { key: 'SIDE', label: 'Board Side', def: 'Top', kind: 'choice', choices: [['Top', 'Top Side'], ['Bottom', 'Bottom Side']] },
    { key: 'OPACITY', label: 'Opacity (%)', def: '100', kind: 'int' },
  ],
  'Drill Table': TABLE_TEXT,
  'Layer Stack Table': TABLE_TEXT,
  'Keepout Arc': KEEPOUT_LINE,
  'Keepout Track': KEEPOUT_LINE,
};
export const BAG_KINDS = Object.keys(BAG_FIELDS) as BagKind[];
const isDimensionKind = (k: BagKind): k is DimensionKind => (DIMENSION_KINDS as readonly string[]).includes(k);

const KEY = 'konium.pcbBagDefaults';
let saved: Partial<Record<BagKind, Record<string, string>>> | null = null;
function load(): Partial<Record<BagKind, Record<string, string>>> {
  if (saved) return saved;
  saved = {};
  try { const raw = globalThis.localStorage?.getItem(KEY); if (raw) saved = JSON.parse(raw) as typeof saved; } catch { /* AD17's values */ }
  return saved!;
}
function store(): void { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(saved ?? {})); } catch { /* not kept */ } }

/** The kind's defaults: AD17's, with what was changed. */
export function bagDefaults(kind: BagKind): Record<string, string> {
  const own = load()[kind] ?? {};
  // (a dimension kind starts from what Dimension has, changed or not)
  const base = isDimensionKind(kind) ? bagDefaults('Dimension') : null;
  return Object.fromEntries(BAG_FIELDS[kind].map((f) => [f.key, own[f.key] ?? base?.[f.key] ?? f.def]));
}
/** Only what differs from AD17's (what a new object takes over its own defaults). */
export function changedBagDefaults(kind: BagKind): Record<string, string> { return { ...(load()[kind] ?? {}) }; }
export function setBagDefaults(kind: BagKind, values: Record<string, string>): void {
  const s = load();
  // (a dimension kind keeps what it has otherwise than Dimension)
  const base = isDimensionKind(kind) ? bagDefaults('Dimension') : null;
  const changed = Object.fromEntries(BAG_FIELDS[kind].filter((f) => values[f.key] !== undefined && values[f.key] !== (base?.[f.key] ?? f.def)).map((f) => [f.key, values[f.key]!]));
  if (Object.keys(changed).length) s[kind] = changed; else delete s[kind];
  store();
}
export function resetBagDefaults(kind?: BagKind): void { const s = load(); if (kind) delete s[kind]; else for (const k of BAG_KINDS) delete s[k]; store(); }
export const hasBagDefaults = (kind: BagKind): boolean => !!load()[kind];
/** For Save As / Load. */
export function exportBagDefaults(): Record<string, Record<string, string>> { return { ...load() } as Record<string, Record<string, string>>; }
export function importBagDefaults(o: Record<string, Record<string, string>> | undefined): number {
  if (!o) return 0;
  let n = 0;
  for (const k of BAG_KINDS) if (o[k] && typeof o[k] === 'object') { setBagDefaults(k, { ...bagDefaults(k), ...o[k] }); n++; }
  return n;
}
/** Forget what was read (tests: storage swapped). */
export function reloadBagDefaults(): void { saved = null; }
