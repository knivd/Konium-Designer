/**
 * A PcbDoc made from parts (the importers': KiCad, IPC-2581, PADS, EasyEDA, Allegro …): its
 * board record, nets, components, polygon pours and primitives' records, linked models, rules
 * and classes, then its copper stack — layers, thicknesses, materials — as AD writes them.
 */
import { BinWriter } from '../bin';
import { cfbPut, newEntry, writeCfb, type CfbEntry } from '../cfb/cfb';
import { binToBytes } from '../text';
import { countHeader, joinBinaryRecords, joinTextRecords, type PcbRawRecord } from './framing';
import { PropertyBag } from './props';
import { joinRuleRecords, type PcbRule } from './rules';
import { readPcbDoc, withWideStrings } from './pcbdoc';
import { SIDE_STREAMS, carryPrimInfo, writePrimInfo } from './primInfo';
import { sealKept } from '../kicad/kept';
import { newBoardClasses, newBoardRules } from './newBoard';
import { addStackLayer, readStack, setStack } from '../../model/pcbStack';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';

export interface BoardParts {
  board: PropertyBag;
  nets: string[];
  /** More keys for a net's record, by its index (as another tool named it: model/kicadNet). */
  netKeys?: (Record<string, string> | undefined)[];
  comps: PropertyBag[];
  polygons?: PropertyBag[];
  pads?: PcbRawRecord[]; tracks?: PcbRawRecord[]; vias?: PcbRawRecord[]; fills?: PcbRawRecord[]; arcs?: PcbRawRecord[];
  texts?: PcbRawRecord[]; regions?: PcbRawRecord[]; bodies?: PcbRawRecord[];
  /** Linked models: file name (lower case) → model ID. */
  models?: Map<string, string>;
  /** AD's default rules and classes when not given. */
  rules?: PcbRule[]; classes?: PropertyBag[];
}

export function assemblePcbDoc(p: BoardParts, name: string): PcbDocument {
  const root = newEntry('Root Entry', 'root');
  const fh = new BinWriter(32).u32(19);
  for (const ch of 'PCB 5.0 Bi') fh.u8(ch.charCodeAt(0)).u8(0);
  cfbPut(root, 'FileHeader', fh.finish());
  const six = binToBytes('PCB 6.0 Binary File');
  cfbPut(root, 'FileHeaderSix', new BinWriter(32).u32(six.length).u8(six.length).bytes(six).f64(5.01).finish());
  const putText = (s: string, bags: PropertyBag[]) => { cfbPut(root, `${s}/Header`, countHeader(bags.length)); cfbPut(root, `${s}/Data`, joinTextRecords(bags)); };
  const putBin = (s: string, recs: PcbRawRecord[] = []) => { cfbPut(root, `${s}/Header`, countHeader(recs.length)); cfbPut(root, `${s}/Data`, joinBinaryRecords(recs)); };
  putText('Board6', [p.board]);
  putText('Nets6', p.nets.map((n, i) => PropertyBag.from({ NAME: n, VISIBLE: 'TRUE', ...p.netKeys?.[i] })));
  putText('Components6', p.comps);
  putText('Polygons6', p.polygons ?? []);
  putBin('Pads6', p.pads); putBin('Tracks6', p.tracks); putBin('Vias6', p.vias); putBin('Fills6', p.fills); putBin('Arcs6', p.arcs);
  putBin('Regions6', p.regions); putBin('ShapeBasedRegions6', []); putBin('ComponentBodies6', p.bodies);
  putModels(root, p.models ?? new Map());
  for (const st of ['Connections6', 'Coordinates6', 'DifferentialPairs6', 'Dimensions6', 'EmbeddedBoards6', 'EmbeddedFonts6', 'Embeddeds6', 'FromTos6', 'Models',
    'PadViaLibraryLinks', 'PinPairsSection', 'PrimitiveParameters', 'ShapeBasedComponentBodies6', 'SmartUnions', 'Textures', 'WaivedViolations', 'WideStrings6',
    'ExtendedPrimitiveInformation', 'UniqueIDPrimitiveInformation']) putBin(st);
  // Texts with their wide strings (what isn't in the 8-bit code page, Ω and the like, is kept there)
  const texts = withWideStrings(root, p.texts ?? []);
  texts.forEach((t, i) => carryPrimInfo(p.texts![i]!, t));
  putBin('Texts6', texts);
  // What the records carry beside them (a KiCad object kept whole, its fingerprint taken now the bytes are final)
  const side = new Map<string, { records: PcbRawRecord[] }>([['Arcs6', { records: p.arcs ?? [] }], ['Pads6', { records: p.pads ?? [] }], ['Vias6', { records: p.vias ?? [] }], ['Tracks6', { records: p.tracks ?? [] }],
    ['Texts6', { records: texts }], ['Fills6', { records: p.fills ?? [] }], ['Regions6', { records: p.regions ?? [] }], ['ComponentBodies6', { records: p.bodies ?? [] }]]);
  sealKept([...side.values()].flatMap((x) => x.records));
  writePrimInfo(root, side, new Set(SIDE_STREAMS), undefined);
  const rules = p.rules ?? newBoardRules();
  cfbPut(root, 'Rules6/Header', countHeader(rules.length));
  cfbPut(root, 'Rules6/Data', joinRuleRecords(rules));
  putText('Classes6', p.classes ?? newBoardClasses());
  const doc = readPcbDoc(writeCfb(root), name);
  // Texts are written again on saving (their wide strings with them)
  doc.dirty.add('Texts6');
  return doc;
}

/** Linked models: their listing in ModelsNoEmbed (found by name in the model folders). */
export function putModels(root: CfbEntry, models: Map<string, string>): void {
  const recs: Uint8Array[] = [];
  for (const [name, id] of models) {
    const bag = PropertyBag.from({ EMBED: 'FALSE', MODELSOURCE: 'FromFile', ID: id, ROTX: '0.000', ROTY: '0.000', ROTZ: '0.000', DZ: '0', CHECKSUM: '0', NAME: name });
    const all = bag.toBytes(), text = all[0] === 0x7c ? all.subarray(1) : all;
    const r = new Uint8Array(4 + text.length);
    new DataView(r.buffer).setUint32(0, text.length, true);
    r.set(text, 4);
    recs.push(r);
  }
  const data = new Uint8Array(recs.reduce((n, r) => n + r.length, 0));
  let o = 0;
  for (const r of recs) { data.set(r, o); o += r.length; }
  cfbPut(root, 'ModelsNoEmbed/Header', countHeader(recs.length));
  cfbPut(root, 'ModelsNoEmbed/Data', data);
}

export interface StackCopper { name?: string; /** Copper thickness (AD units). */ thickness?: number; /** An internal plane (negative), and its net. */ plane?: boolean; net?: string }
export interface StackDielectric { thickness?: number; material?: string; er?: number; prepreg?: boolean }

/**
 * The board's copper stack: as many inner layers as given past the top and bottom (Mid-Layer 1 …),
 * each copper's name and thickness and each dielectric's (between them, in order) thickness,
 * material, constant and kind (core or prepreg).
 */
export function applyStackLayers(doc: PcbDocument, copper: StackCopper[], diels: StackDielectric[]): void {
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const inner = Math.max(0, Math.min(30, copper.length - 2));
  let after = rows.findIndex((x) => x.layer === L.TOP);
  for (let i = 0; i < inner; i++) { const r = addStackLayer(rows, after, !!copper[i + 1]?.plane)!; rows = r.rows; after = r.index; }
  if (inner > 0) setStack(doc, rows).apply();
  rows = readStack(doc.board.bag!, doc.board.copperStack);
  let ci = 0, di = 0;
  rows = rows.map((x) => {
    if (x.kind === 'signal' || x.kind === 'plane') {
      const c = copper[ci++];
      const name = x.layer === L.TOP ? 'Top Layer' : x.layer === L.BOTTOM ? 'Bottom Layer' : c?.name || x.name;
      return { ...x, name, ...(c?.thickness ? { copper: Math.round(c.thickness) } : {}) };
    }
    if (x.kind === 'dielectric') {
      const d = diels[di++];
      if (!d) return x;
      return { ...x, ...(d.thickness ? { height: Math.round(d.thickness) } : {}), ...(d.material ? { dielMaterial: d.material } : {}), ...(d.er ? { dielConst: d.er } : {}),
        ...(d.prepreg !== undefined ? { dielType: d.prepreg ? 2 : 1 } : {}) };
    }
    return x;
  });
  setStack(doc, rows).apply();
  // Planes' nets
  const planes = rows.filter((r) => r.kind === 'plane');
  copper.filter((c) => c.plane).forEach((c, i) => {
    const r = planes[i];
    if (!r || r.layer === null || !c.net) return;
    doc.board.bag!.set(`PLANE${r.layer - L.PLANE1 + 1}NETNAME`, c.net);
  });
}
