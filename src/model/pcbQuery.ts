/**
 * Altium's query language on a board (PCB Filter, PCB List, Find Similar's Create Expression):
 * any property by its name without spaces (Width > 10mil, Layer = 'Top Layer', Net = 'GND'),
 * the Is… keywords for each object kind, InNet, InNetClass, InComponent, InComponentClass,
 * HasFootprint, OnLayer, InPolygon, InNamedPolygon, combined with And / Or / Not and brackets.
 * A bare number compared with a length is in the current unit.
 */
import { QueryError, fold, parseSchQuery, squash, testQuery, wild, type QueryHost, type Val } from './schQuery';
import { pcbObjects, pcbProps, PCB_OBJECT_KINDS, type PcbObj, type PcbProp, type PcbPropCtx } from './pcbProps';
import { L, layerName } from './layers';
import { NO_NET } from './pcb';
import { membersOf } from './pcbClasses';
import { netInPair, netInPairClass } from './diffPairs';

const IS: Record<string, string> = Object.fromEntries(PCB_OBJECT_KINDS.map((k) => [`is${squash(k)}`, k]));
IS.isstring = 'Text';
IS.isbody = 'Component Body';
IS.iscomponentbody = 'Component Body';
const EXTRA = new Set(['all', 'issmtpad', 'isthrupad', 'isthpad', 'iskeepout', 'isdesignator', 'iscomment', 'ontoplayer', 'onbottomlayer', 'onsignal', 'onsignallayer', 'ispolygonpour', 'isfree', 'islocked']);
const ALIASES: Record<string, string[]> = {
  name: ['designator'], pattern: ['footprint'], text: ['string'], holesize: ['holesize'], netname: ['net'], radius: ['radius'], padjumperid: ['jumperid'],
  x: ['x', 'xcenter', 'x1'], y: ['y', 'ycenter', 'y1'], xcenter: ['xcenter'], ycenter: ['ycenter'],
};

export const PCB_QUERY_KEYWORDS = ['All', ...PCB_OBJECT_KINDS.map((k) => `Is${k.replace(/\s+/g, '')}`), 'IsSMTPad', 'IsThruPad', 'IsKeepOut', 'IsDesignator', 'IsComment',
  'OnTopLayer', 'OnBottomLayer', "InNet('GND')", "InNetClass('Power')", "InComponent('U1')", "InComponentClass('Top Side Components')", "HasFootprint('0805')",
  "OnLayer('Top Layer')", 'InPolygon', "InNamedPolygon('GND_L1_P000')", "InDifferentialPair('USB_D')", "InDifferentialPairClass('All Differential Pairs')"];

export const PCB_EXAMPLES: [string, string][] = [
  ['All tracks', 'IsTrack'], ['All vias', 'IsVia'], ['Tracks narrower than 10mil', 'IsTrack And (Width < 10mil)'], ['Everything on GND', "InNet('GND')"],
  ['Pads of U1', "IsPad And InComponent('U1')"], ['Through-hole pads', 'IsThruPad'], ['SMD pads on the bottom', 'IsSMTPad And OnBottomLayer'],
  ['Components on the bottom', "IsComponent And (Layer = 'Bottom Layer')"], ['0805 parts', "IsComponent And (Footprint Like '*0805*')"],
  ['Vias with a hole under 12mil', 'IsVia And (HoleSize < 12mil)'], ['Locked objects', 'Locked = True'], ['Keepouts', 'IsKeepOut'],
];

/** The host a query asks about one object. */
function host(o: PcbObj, x: PcbPropCtx): QueryHost {
  const { doc } = x;
  let props: PcbProp[] | undefined;
  const p = o.prim;
  const lookup = (name: string): Val => {
    props ??= pcbProps(o, x);
    const want = [squash(name), ...(ALIASES[squash(name)] ?? [])];
    for (const w of want) {
      const q = props.find((r) => squash(r.name) === w);
      if (q) {
        if (q.type === 'bool') return /^true$/i.test(q.value);
        return { s: q.value, type: q.type === 'coord' || q.type === 'coordX' || q.type === 'coordY' ? 'coord' : q.type === 'angle' || q.type === 'number' ? 'num' : undefined, unit: x.units };
      }
    }
    return undefined;
  };
  const str = (v: Val) => (typeof v === 'object' ? v.s : typeof v === 'boolean' ? String(v) : '');
  const net = p && 'net' in p ? p.net : o.polygon !== undefined ? doc.polygons[o.polygon]!.net : NO_NET;
  const netName = net !== NO_NET ? doc.nets[net]?.name ?? '' : '';
  const comp = o.component !== undefined ? doc.components[o.component] : p && 'component' in p && p.component !== NO_NET ? doc.components[p.component] : undefined;
  const layer = p && 'layer' in p ? p.layer : p?.kind === 'via' ? L.MULTI : o.component !== undefined ? doc.components[o.component]!.layer : o.polygon !== undefined ? doc.polygons[o.polygon]!.layer : undefined;
  const lname = (l: number) => fold(x.layerLabel?.(l) ?? doc.board.layerNames.get(l) ?? layerName(l));
  const inClass = (kind: number, member: string, args: Val[]) => args.some((a) => {
    const c = doc.classes.find((k) => k.kind === kind && fold(k.name) === fold(str(a)));
    if (!c) throw new QueryError(`No class '${str(a)}' on the board`);
    return membersOf(doc, c).some((m) => fold(m) === fold(member));
  });
  const call = (name: string, args: Val[]): boolean => {
    const w = squash(name);
    if (w === 'all') return true;
    if (IS[w]) return o.kind === IS[w];
    switch (w) {
      case 'issmtpad': return p?.kind === 'pad' && p.hole === 0;
      case 'isthrupad': case 'isthpad': return p?.kind === 'pad' && p.hole > 0;
      case 'iskeepout': return !!p && 'keepout' in p && p.keepout;
      case 'isdesignator': return p?.kind === 'text' && p.isDesignator;
      case 'iscomment': return p?.kind === 'text' && p.isComment;
      case 'islocked': return lookup('Locked') === true;
      case 'isfree': return !!p && (!('component' in p) || p.component === NO_NET);
      case 'ispolygonpour': return o.polygon !== undefined;
      case 'ontoplayer': return layer === L.TOP || layer === L.MULTI;
      case 'onbottomlayer': return layer === L.BOTTOM || layer === L.MULTI;
      case 'onsignal': case 'onsignallayer': return layer !== undefined && ((layer >= L.TOP && layer <= L.BOTTOM) || layer === L.MULTI);
      case 'onlayer': return layer !== undefined && args.some((a) => wild(str(a)).test(lname(layer)) || fold(str(a)) === lname(layer) || layer === L.MULTI);
      case 'innet': return args.some((a) => wild(str(a)).test(netName));
      case 'innetclass': return net !== NO_NET && inClass(0, netName, args);
      case 'incomponent': return !!comp && args.some((a) => wild(str(a)).test(comp.designator));
      case 'incomponentclass': return !!comp && inClass(1, comp.designator, args);
      case 'hasfootprint': return !!comp && args.some((a) => wild(str(a)).test(comp.pattern));
      case 'indifferentialpair': return !!netName && args.some((a) => netInPair(doc, netName, str(a)));
      case 'indifferentialpairclass': return !!netName && args.some((a) => netInPairClass(doc, netName, str(a)));
      case 'inpolygon': return o.polygon !== undefined;
      case 'innamedpolygon': return o.polygon !== undefined && args.some((a) => wild(str(a)).test(doc.polygons[o.polygon!]!.name));
    }
    throw new QueryError(`Unknown keyword ${name}`);
  };
  return { lookup, call, isKeyword: (w) => !!IS[w] || EXTRA.has(w) };
}

/** The objects that pass a query; throws QueryError for a bad one. */
export function runPcbQuery(src: string, x: PcbPropCtx, objs: PcbObj[] = pcbObjects(x.doc)): PcbObj[] {
  const n = parseSchQuery(src);
  return objs.filter((o) => testQuery(n, host(o, x)));
}

/** A query for one object's chosen properties (Find Similar › Create Expression). */
export function pcbExpressionFor(pairs: { name: string; value: string; same: boolean }[]): string {
  const q = (v: string) => `'${v.replace(/'/g, '')}'`;
  return pairs.map((p) => {
    const key = p.name.replace(/[\s-]+/g, '');
    if (/^(true|false)$/i.test(p.value)) return `(${key} ${p.same ? '=' : '<>'} ${/^true$/i.test(p.value) ? 'True' : 'False'})`;
    return `(${key} ${p.same ? '=' : '<>'} ${q(p.value)})`;
  }).join(' And ') || 'All';
}
