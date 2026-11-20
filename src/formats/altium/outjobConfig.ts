/**
 * Output Job configuration records ↔ Konium's output setups, key for key as the AD17 OutJobs
 * read (PW-Sat2, NCAR, USB-C Explorer):
 * - GerberView: GerberUnit, NumberOfDecimals, LeadingAndTrailingZeroesMode, OriginPosition,
 *   Plot.Set / Mirror.Set (32-bit layer ids, "id~1"), or the older PlotXxxPlot / MirrorXxxPlot keys;
 *   PlotUsedDrillDrawingLayerPairs, PlotUsedDrillGuideLayerPairs, Mirror…Plots, DrillDrawingSymbol,
 *   DrillDrawingSymbolSize;
 * - DrillView: Units, NumberOfUnits, NumberOfDecimals, ZeroesMode, OriginPosition,
 *   GenerateSeparatePlatedNonPlatedFiles;
 * - PickPlaceView: Units, GenerateCSVFormat, GenerateTextFormat, Column#n (Name:…,Visible:…);
 * - PcbPrintView / PcbPrintOut / PcbPrintLayer: the print area, each printout and its layers
 *   (PrintOutIndex), drill symbols (DDSymbolKind, DDSymbolSize);
 * - the BOM's VisibleOrder and GroupOrder.
 * Symbol kinds other than GraphicsSymbol, and DDSymbolKind 1 and 2, are [est].
 */
import { L, mechLayer, type LayerId } from '../../model/layers';
import { defaultGerberSetup, plottableLayers, type GerberSetup } from '../gerber/gerber';
import { ROUT_TOOL, defaultDrillSetup, type DrillSetup } from '../gerber/drill';
import { PNP_COLUMNS, defaultPnpSetup, type PnpColumn, type PnpSetup } from '../gerber/pnp';
import { defaultDrillSymbols, type DrillSymbolKind, type DrillSymbols } from '../gerber/drillDrawing';
import { defaultBomSetup, type BomSetup } from '../../model/bom';
import { printout, type PrintJob, type PrintJobKind } from '../../model/printouts';
import { toV7 } from './pcbdoc';
import { fromV7 } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';

type Rec = Record<string, string>;
const T = (b: boolean) => (b ? 'True' : 'False');
const isT = (v: string | undefined) => /^true$/i.test(v ?? '');

/** The names printouts and Gerber keys give layers: TopLayer, MidLayer1, InternalPlane1, Mechanical1, KeepOutLayer … */
export function layerKey(l: LayerId): string {
  if (l === L.TOP) return 'TopLayer';
  if (l === L.BOTTOM) return 'BottomLayer';
  if (l > L.TOP && l < L.BOTTOM) return `MidLayer${l - 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `InternalPlane${l - L.PLANE1 + 1}`;
  if ((l >= L.MECH1 && l <= L.MECH16) || l > 1000) return `Mechanical${l > 1000 ? l - 1000 : l - L.MECH1 + 1}`;
  return ({ [L.TOP_OVERLAY]: 'TopOverlay', [L.BOTTOM_OVERLAY]: 'BottomOverlay', [L.TOP_PASTE]: 'TopPaste', [L.BOTTOM_PASTE]: 'BottomPaste',
    [L.TOP_SOLDER]: 'TopSolder', [L.BOTTOM_SOLDER]: 'BottomSolder', [L.DRILL_GUIDE]: 'DrillGuide', [L.KEEPOUT]: 'KeepOutLayer',
    [L.DRILL_DRAWING]: 'DrillDrawing', [L.MULTI]: 'MultiLayer' } as Record<number, string>)[l] ?? 'TopLayer';
}
export function layerOfKey(k: string): LayerId | undefined {
  const n = k.trim();
  const fixed: Record<string, LayerId> = { toplayer: L.TOP, bottomlayer: L.BOTTOM, topoverlay: L.TOP_OVERLAY, bottomoverlay: L.BOTTOM_OVERLAY, toppaste: L.TOP_PASTE,
    bottompaste: L.BOTTOM_PASTE, topsolder: L.TOP_SOLDER, bottomsolder: L.BOTTOM_SOLDER, drillguide: L.DRILL_GUIDE, keepoutlayer: L.KEEPOUT,
    drilldrawing: L.DRILL_DRAWING, multilayer: L.MULTI };
  const f = fixed[n.toLowerCase()];
  if (f !== undefined) return f;
  let m = /^MidLayer(\d+)$/i.exec(n); if (m) return 1 + Number(m[1]);
  m = /^InternalPlane(\d+)$/i.exec(n); if (m) return L.PLANE1 + Number(m[1]) - 1;
  m = /^Mechanical(\d+)$/i.exec(n); if (m) return mechLayer(Number(m[1]));
  return undefined;
}

/** "SerializeLayerHash.Version~2,ClassName~TLayerToBoolean,16973830~1,…" → the layers set. */
function layerHash(v: string | undefined): Set<LayerId> | null {
  if (v === undefined) return null;
  const out = new Set<LayerId>();
  for (const part of v.split(',')) { const m = /^(\d+)~1$/.exec(part.trim()); if (m) { const l = fromV7(Number(m[1])); if (l !== undefined) out.add(l); } }
  return out;
}
const hashOf = (ls: LayerId[]) => ['SerializeLayerHash.Version~2', 'ClassName~TLayerToBoolean', ...ls.map((l) => `${toV7(l)}~1`)].join(',');

const SYMBOL_KINDS: [DrillSymbolKind, string, number][] = [['graphic', 'GraphicsSymbol', 0], ['characters', 'Characters', 1], ['size', 'SizeOfHoleString', 2]];

export function gerberFromConfig(doc: PcbDocument, recs: Rec[]): GerberSetup {
  const s = defaultGerberSetup(doc);
  const r = recs.find((x) => x.Record === 'GerberView') ?? recs[0];
  if (!r) return s;
  s.units = /metric|mm/i.test(r.GerberUnit ?? '') ? 'mm' : 'in';
  s.intDigits = s.units === 'in' ? 2 : 4;
  s.decDigits = Number(r.NumberOfDecimals) || (s.units === 'in' ? 5 : 4);
  const z = r.LeadingAndTrailingZeroesMode ?? '';
  s.zeros = /trailing/i.test(z) && /suppress/i.test(z) ? 'trailing' : /keep/i.test(z) ? 'none' : 'leading';
  s.relative = !/absolute/i.test(r.OriginPosition ?? 'Relative');
  const plot = layerHash(r['Plot.Set']), mirror = layerHash(r['Mirror.Set']);
  const old = (prefix: string, l: LayerId) => isT(r[`${prefix}${layerKey(l)}Plot`]);
  const layers = new Set([...plottableLayers(doc), ...(plot ?? [])]);
  s.layers = [...layers].map((layer) => ({ layer, plot: plot ? plot.has(layer) : old('Plot', layer), mirror: mirror ? mirror.has(layer) : old('Mirror', layer) }));
  s.drillDrawing = isT(r.PlotUsedDrillDrawingLayerPairs); s.drillGuide = isT(r.PlotUsedDrillGuideLayerPairs);
  s.mirrorDrillDrawing = isT(r.MirrorDrillDrawingPlots); s.mirrorDrillGuide = isT(r.MirrorDrillGuidePlots);
  s.drill = { kind: SYMBOL_KINDS.find(([, n]) => n === r.DrillDrawingSymbol)?.[0] ?? 'graphic', size: Number(r.DrillDrawingSymbolSize) || defaultDrillSymbols().size };
  s.embedded = r.EmbeddedApertures === undefined || isT(r.EmbeddedApertures);
  s.unconnectedMidPads = isT(r.IncludeUnconnectedMidLayerPads);
  return s;
}

export function gerberToConfig(s: GerberSetup): Rec[] {
  const lay = (f: (l: GerberSetup['layers'][number]) => boolean) => hashOf(s.layers.filter(f).map((l) => l.layer));
  return [{
    'AddToAllLayerClasses.Set': ' ', 'AddToAllPlots.Set': hashOf([]), CentrePlots: 'False',
    DrillDrawingSymbol: SYMBOL_KINDS.find(([k]) => k === s.drill.kind)![1], DrillDrawingSymbolSize: String(s.drill.size),
    EmbeddedApertures: T(s.embedded !== false), FilmBorderSize: '10000000', FilmXSize: '200000000', FilmYSize: '160000000', FlashAllFills: 'False', FlashPadShapes: 'True',
    G54OnApertureChange: 'False', GenerateDRCRulesFile: 'True', GenerateReliefShapes: 'True', GerberUnit: s.units === 'in' ? 'Imperial' : 'Metric',
    IncludeUnconnectedMidLayerPads: T(!!s.unconnectedMidPads), 'LayerClassesMirror.Set': ' ', 'LayerClassesPlot.Set': ' ',
    LeadingAndTrailingZeroesMode: s.zeros === 'none' ? 'KeepLeadingAndTrailingZeroes' : s.zeros === 'trailing' ? 'SuppressTrailingZeroes' : 'SuppressLeadingZeroes',
    MaxApertureSize: '2500000', MinusApertureTolerance: '50', 'Mirror.Set': lay((l) => l.mirror), MirrorDrillDrawingPlots: T(s.mirrorDrillDrawing), MirrorDrillGuidePlots: T(s.mirrorDrillGuide),
    NoRegularPolygons: 'False', NumberOfDecimals: String(s.decDigits), OptimizeChangeLocationCommands: 'True', OriginPosition: s.relative ? 'Relative' : 'Absolute', Panelize: 'False',
    'Plot.Set': lay((l) => l.plot), PlotPositivePlaneLayers: 'False', PlotUsedDrillDrawingLayerPairs: T(s.drillDrawing), PlotUsedDrillGuideLayerPairs: T(s.drillGuide),
    PlusApertureTolerance: '50', Record: 'GerberView', SoftwareArcs: 'False', Sorted: 'False',
  }];
}

export function drillFromConfig(recs: Rec[]): DrillSetup {
  const s = defaultDrillSetup();
  const r = recs.find((x) => x.Record === 'DrillView') ?? recs[0];
  if (!r) return s;
  s.units = /metric|mm/i.test(r.Units ?? '') ? 'mm' : 'in';
  s.intDigits = Number(r.NumberOfUnits) || (s.units === 'in' ? 2 : 4);
  s.decDigits = Number(r.NumberOfDecimals) || (s.units === 'in' ? 5 : 4);
  const z = r.ZeroesMode ?? '';
  s.zeros = /keep/i.test(z) ? 'none' : /trailing/i.test(z) ? 'trailing' : 'leading';
  s.relative = !/absolute/i.test(r.OriginPosition ?? 'Relative');
  s.separatePlated = isT(r.GenerateSeparatePlatedNonPlatedFiles);
  s.optimise = r.OptimizeChangeLocationCommands === undefined || isT(r.OptimizeChangeLocationCommands);
  s.g85 = isT(r.GenerateDrilledSlotsG85);
  s.edgeRout = isT(r.GenerateBoardEdgeRout);
  if (Number(r.BoardEdgeRoutToolDia) > 0) s.routTool = Number(r.BoardEdgeRoutToolDia);
  return s;
}
export function drillToConfig(s: DrillSetup): Rec[] {
  return [{ BoardEdgeRoutToolDia: String(s.routTool ?? ROUT_TOOL), GenerateBoardEdgeRout: T(!!s.edgeRout), GenerateDrilledSlotsG85: T(!!s.g85), GenerateEIADrillFile: 'False',
    GenerateSeparatePlatedNonPlatedFiles: T(s.separatePlated), NumberOfDecimals: String(s.decDigits), NumberOfUnits: String(s.intDigits), OptimizeChangeLocationCommands: T(s.optimise !== false),
    OriginPosition: s.relative ? 'Relative' : 'Absolute', Record: 'DrillView', Units: s.units === 'in' ? 'Imperial' : 'Metric',
    ZeroesMode: s.zeros === 'none' ? 'KeepLeadingAndTrailingZeroes' : s.zeros === 'trailing' ? 'SuppressTrailingZeroes' : 'SuppressLeadingZeroes' }];
}

export function pnpFromConfig(recs: Rec[]): PnpSetup {
  const s = defaultPnpSetup();
  const r = recs.find((x) => x.Record === 'PickPlaceView') ?? recs[0];
  if (!r) return s;
  s.units = /metric/i.test(r.Units ?? '') ? 'mm' : 'mil';
  s.format = isT(r.GenerateCSVFormat) || !isT(r.GenerateTextFormat) ? 'csv' : 'txt';
  const cols: { name: string; pos: number; visible: boolean }[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (!/^Column#\d+$/.test(k)) continue;
    const f = Object.fromEntries(v.split(',').map((x) => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
    cols.push({ name: f.Name ?? '', pos: Number(f.Position) || 0, visible: isT(f.Visible) });
  }
  const known = cols.filter((c) => c.visible && (PNP_COLUMNS as readonly string[]).includes(c.name)).sort((a, b) => a.pos - b.pos).map((c) => c.name as PnpColumn);
  if (known.length) s.columns = known;
  return s;
}
export function pnpToConfig(s: PnpSetup): Rec[] {
  const r: Rec = { Record: 'PickPlaceView', Units: s.units === 'mm' ? 'Metric' : 'Imperial', GenerateCSVFormat: T(s.format === 'csv'), GenerateTextFormat: T(s.format === 'txt'),
    ShowUnits: 'False', Separator: '.', ExcludeFilterParam: 'False', IncludeVariations: 'False', Filter: ' ', FilterActive: 'False' };
  PNP_COLUMNS.forEach((c, i) => { const at = s.columns.indexOf(c); r[`Column#${i + 1}`] = `Name:${c},Fixed:True,Metric:${T(s.units === 'mm')},Visible:${T(at >= 0)},Sort:None,Position:${at >= 0 ? at : PNP_COLUMNS.length + i}`; });
  return [r];
}

export function printJobFromConfig(kind: PrintJobKind, title: string, recs: Rec[], fallback: PrintJob): PrintJob {
  const view = recs.find((r) => r.Record === 'PcbPrintView');
  const outs = recs.filter((r) => r.Record === 'PcbPrintOut').sort((a, b) => Number(a.Index) - Number(b.Index));
  if (!outs.length) return { ...fallback, title };
  let symbols: DrillSymbols = fallback.symbols;
  const printouts = outs.map((o) => {
    const idx = o.Index ?? '0';
    const layers = recs.filter((r) => r.Record === 'PcbPrintLayer' && (r.PrintOutIndex ?? '0') === idx);
    const dd = layers.find((r) => /drill/i.test(r.Layer ?? ''));
    if (dd) symbols = { kind: SYMBOL_KINDS.find(([, , n]) => n === Number(dd.DDSymbolKind))?.[0] ?? 'graphic', size: Number(dd.DDSymbolSize) || symbols.size };
    return printout(o.Name ?? `Printout ${Number(idx) + 1}`, layers.map((r) => layerOfKey(r.Layer ?? '')).filter((l): l is LayerId => l !== undefined), {
      top: isT(o.IncludeTopLayerComponents), bottom: isT(o.IncludeBottomLayerComponents), multi: isT(o.IncludeMultiLayerComponents),
      mirror: isT(o.Mirror), holes: isT(o.ShowHoles), padNumbers: isT(o.ShowPadNumbers), padNets: isT(o.ShowPadNets),
    });
  });
  return { kind, title, printouts, area: /sheet/i.test(view?.PrintArea ?? '') ? 'sheet' : 'extent', symbols };
}

export function printJobToConfig(job: PrintJob, pair: [LayerId, LayerId]): Rec[] {
  const recs: Rec[] = [{ DesignatorDisplayMode: 'Physical', PrintArea: job.area === 'sheet' ? 'EntireSheet' : 'DesignExtent', PrintAreaLowerLeftCornerX: '0', PrintAreaLowerLeftCornerY: '0',
    PrintAreaUpperRightCornerX: '0', PrintAreaUpperRightCornerY: '0', Record: 'PcbPrintView' }];
  const kind = String(SYMBOL_KINDS.find(([k]) => k === job.symbols.kind)![2]);
  job.printouts.forEach((po, i) => {
    recs.push({ IncludeBottomLayerComponents: T(po.bottom), IncludeMultiLayerComponents: T(po.multi), IncludeTopLayerComponents: T(po.top), Index: String(i), Mirror: T(po.mirror),
      Name: po.name, PadNumberFontSize: '14', Record: 'PcbPrintOut', ShowHoles: T(po.holes), ShowPadNets: T(po.padNets), ShowPadNumbers: T(po.padNumbers), SubstituteFonts: 'False' });
    for (const l of po.layers) {
      recs.push({ CArc: 'Full', CFill: 'Full', Comment: 'Full', Coordinate: 'Full', CPad: 'Full', CRegion: 'Full', CText: 'Full', CTrack: 'Full', CVia: 'Full',
        DDSymbolKind: kind, DDSymbolSize: String(job.symbols.size), DDSymbolSortKind: '0', Designator: 'Full', Dimension: 'Full',
        DLayer1: layerKey(pair[0]), DLayer2: layerKey(pair[1]), FArc: 'Full', FFill: 'Full', FPad: 'Full', FRegion: 'Full', FText: 'Full', FTrack: 'Full', FVia: 'Full',
        Layer: layerKey(l), Polygon: 'Full', PrintOutIndex: String(i), Record: 'PcbPrintLayer' });
    }
  });
  return recs;
}

/** The BOM's columns and grouping from VisibleOrder / GroupOrder ("Comment=100|Designator=633"). */
export function bomFromConfig(recs: Rec[]): BomSetup {
  const s = defaultBomSetup();
  // The BOM's configuration items are named, not "Record=…": General, GroupOrder, SortOrder, VisibleOrder
  const visible = recs.find((r) => 'Comment' in r && Object.values(r).every((v) => /^\d+$/.test(v)));
  const group = recs.find((r) => Object.values(r).every((v) => /^(true|false)$/i.test(v)) && !('OpenExported' in r));
  if (visible) s.columns = Object.keys(visible);
  if (group) s.group = Object.entries(group).filter(([, v]) => isT(v)).map(([k]) => k);
  return s;
}
