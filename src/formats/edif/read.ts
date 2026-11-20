/**
 * EDIF 2 0 0 (the electronic design interchange format) read into a model of what Konium takes
 * from it: libraries (their distance unit from the technology's numberDefinition), cells and their
 * views — a view's interface (ports with direction and pin number, the symbol's figures, pins as
 * portImplementations with their connect locations, the texts it shows) and contents (pages, or
 * one page when it has none: instances with their transforms, designators and properties; nets
 * with the ports they join and the wires drawn for them; ports drawn on the page, off-page
 * connectors, comment graphics). The design names the top cell. Names keep the text a rename
 * gives them; strings their %nn% characters. Keywords are read in any case.
 *
 * As xDX Designer writes it (26.190, from a file of it): a display says whether its text is shown
 * (figureGroupOverride … (visible (false))); a net inside a net is a piece of that net, drawn
 * apart; a ground or supply symbol is an instance inside a portImplementation of the page, at
 * its connectLocation; a view of type GRAPHIC draws its symbol in its contents; and the
 * designators and pin numbers the design was given are in the cell's viewMap
 * (instanceBackAnnotate, portBackAnnotate), over the symbols' own "R?".
 */

export type Pt = { x: number; y: number };
export type EAtom = string | number;
export interface EList { k: string; items: ENode[] }
export type ENode = EAtom | EList | EStr;
/** A string as written (quoted), apart from an identifier. */
export class EStr { constructor(readonly s: string) {} }

const ends = (c: number) => c <= 32 || c === 40 || c === 41 || c === 34;

/** EDIF's %code code …% runs in strings: those characters. */
function unescape(s: string): string {
  return s.indexOf('%') < 0 ? s : s.replace(/%((?:\s*\d+)+)\s*%/g, (_, codes: string) => String.fromCharCode(...codes.trim().split(/\s+/).map(Number)));
}

export function parseEdif(text: string): EList {
  const n = text.length;
  const stack: EList[] = [];
  let root: EList | null = null;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40) {
      i++;
      while (i < n && text.charCodeAt(i) <= 32) i++;
      let j = i;
      while (j < n && !ends(text.charCodeAt(j))) j++;
      const node: EList = { k: text.slice(i, j).toLowerCase(), items: [] };
      i = j;
      if (stack.length) stack[stack.length - 1]!.items.push(node); else if (!root) root = node;
      stack.push(node);
    } else if (c === 41) {
      stack.pop(); i++;
      if (!stack.length && root) break;
    } else if (c === 34) {
      const e = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, e < 0 ? n : e);
      stack[stack.length - 1]?.items.push(new EStr(unescape(s)));
      i = e < 0 ? n : e + 1;
    } else if (c <= 32) i++;
    else {
      let j = i;
      while (j < n && !ends(text.charCodeAt(j))) j++;
      const t = text.slice(i, j);
      stack[stack.length - 1]?.items.push(/^[-+]?\d+$/.test(t) ? Number(t) : t);
      i = j;
    }
  }
  if (!root || root.k !== 'edif') throw new Error('not an EDIF file');
  return root;
}

export const isEList = (n: ENode | undefined): n is EList => typeof n === 'object' && n !== null && !(n instanceof EStr);
export const ekids = (n: EList | undefined, k: string): EList[] => (n ? n.items.filter((x): x is EList => isEList(x) && x.k === k) : []);
export const ekid = (n: EList | undefined, k: string): EList | undefined => n?.items.find((x): x is EList => isEList(x) && x.k === k);
/** The first string of a list (a quoted string, or a word). */
export function estr(n: EList | undefined): string | undefined {
  for (const x of n?.items ?? []) { if (x instanceof EStr) return x.s; if (typeof x === 'string') return x; if (typeof x === 'number') return String(x); if (isEList(x) && (x.k === 'string' || x.k === 'stringdisplay')) return estr(x); }
  return undefined;
}
/** A number: an integer or (e mantissa exponent). */
export function enumber(x: ENode | undefined): number {
  if (typeof x === 'number') return x;
  if (isEList(x) && x.k === 'e') return Number(x.items[0]) * 10 ** Number(x.items[1]);
  if (isEList(x) && (x.k === 'integer' || x.k === 'number')) return enumber(x.items[0]);
  return NaN;
}
const ept = (p: EList | undefined): Pt | undefined => (p && p.k === 'pt' ? { x: enumber(p.items[0]), y: enumber(p.items[1]) } : undefined);
const epts = (n: EList | undefined): Pt[] => ekids(n, 'pt').map((p) => ept(p)!);

/* ── The model ── */

/** How a text is shown: its figure group, where, turned and justified as EDIF says. */
export interface EDisplay { group: string; at?: Pt; justify?: string; orient?: string; /** False where the file says the text is not shown. */ visible?: boolean; /** The text's height in millimetres, where the file gives one (its own textHeight, else its figure group's). */ height?: number }
/** A name: its identifier, the text a rename gives it, and where it is shown. */
export interface EName { id: string; text: string; displays: EDisplay[] }
export type EShape =
  | { kind: 'path'; pts: Pt[] }
  | { kind: 'polygon'; pts: Pt[] }
  | { kind: 'rect'; a: Pt; b: Pt }
  | { kind: 'circle'; a: Pt; b: Pt }
  | { kind: 'arc'; a: Pt; m: Pt; b: Pt }
  | { kind: 'dot'; at: Pt };
export interface EFigure { group: string; shapes: EShape[] }
export interface EText { text: string; display: EDisplay[] }
export interface EPortImpl { name: string; /** An off-page connector's text (its rename). */ text?: string; figures: EFigure[]; connect?: Pt; displays: { kw: string; d: EDisplay }[]; nameDisplays: EDisplay[]; /** Symbols placed in it (a page's ground and supply symbols, as xDX Designer writes them). */ symbols: EInstance[] }
export interface ESymbol {
  figures: EFigure[]; pins: Map<string, EPortImpl>; texts: EText[];
  /** keywordDisplay (designator, cell …) and propertyDisplay: where the instance's texts go. */
  shows: { what: string; d: EDisplay }[];
  box?: { a: Pt; b: Pt };
}
export interface EPort { name: EName; dir: string; designator?: string; props: Map<string, string>; array?: number }
export interface EInstance {
  name: EName; cell: string; lib?: string; view: string; orient: string; at: Pt;
  designator?: string; designatorDisplays: EDisplay[];
  /** Where the instance shows its cell's name (a display on its cellRef's name). */
  cellDisplays: EDisplay[];
  props: Map<string, { value: string; displays: EDisplay[] }>;
  /** Per-instance pin numbers (portInstance designator, or the cell's portBackAnnotate). */
  pinNumbers: Map<string, string>;
  /** Per-instance, whether a pin's number is shown (where its portInstance says). */
  pinShown: Map<string, boolean>;
}
export interface EJoin { port: string; inst?: string; member?: number }
export interface ENet { name: EName; joined: EJoin[]; figures: EFigure[]; instances: EInstance[]; props: Map<string, string> }
export interface EPage {
  name: EName; size?: { a: Pt; b: Pt };
  instances: EInstance[]; nets: ENet[];
  ports: EPortImpl[]; offPage: EPortImpl[];
  comments: { figures: EFigure[]; texts: EText[] };
}
export interface EView { name: string; type: string; ports: EPort[]; symbol?: ESymbol; pages: EPage[]; props: Map<string, string>; /** Off-page connectors of the contents: identifier → text. */ offPage: Map<string, string> }
export interface ECell { name: EName; lib: string; type: string; views: EView[] }
export interface ELibrary { name: EName; external: boolean; mmPerUnit: number; cells: Map<string, ECell> }
export interface EdifDoc { name: string; program: string; libraries: Map<string, ELibrary>; design?: { cell: string; lib?: string }; warnings: string[] }

const lc = (s: string) => s.toLowerCase();

/** The library being read: millimetres per unit, and each figure group's text height in its units (its technology's). */
let unitNow = 0.254;
let groupHeights = new Map<string, number>();

function displayOf(d: EList): EDisplay {
  const fig = d.items[0];
  const over = isEList(fig) && fig.k === 'figuregroupoverride' ? fig : undefined;
  const group = typeof fig === 'string' ? fig : over ? String(over.items[0] ?? '') : '';
  const vis = ekid(over, 'visible');
  // Its own height (a figureGroupOverride's textHeight), else its group's
  const th = ekid(over, 'textheight');
  const h = (th ? enumber(th.items[0]) : 0) || groupHeights.get(lc(group)) || 0;
  return { group, at: ept(ekid(ekid(d, 'origin'), 'pt')), justify: estr(ekid(d, 'justify'))?.toUpperCase(), orient: estr(ekid(d, 'orientation'))?.toUpperCase(), ...(vis ? { visible: !ekid(vis, 'false') } : {}), ...(h > 0 ? { height: h * unitNow } : {}) };
}
const displays = (n: EList | undefined): EDisplay[] => ekids(n, 'display').map(displayOf);

/** An identifier, a (rename id "text"), or a (name id (display …)) — or either inside an (array …). */
export function nameOf(x: ENode | undefined): EName {
  if (typeof x === 'string' || typeof x === 'number') { const id = String(x); return { id, text: id.replace(/^&/, ''), displays: [] }; }
  if (x instanceof EStr) return { id: x.s, text: x.s, displays: [] };
  if (!isEList(x)) return { id: '', text: '', displays: [] };
  if (x.k === 'rename') {
    const inner = nameOf(x.items[0]);
    const s = x.items.slice(1).find((i) => i instanceof EStr || (isEList(i) && (i.k === 'stringdisplay' || i.k === 'string'))) as EStr | EList | undefined;
    const text = s instanceof EStr ? s.s : s ? estr(s) ?? inner.text : inner.text;
    const sd = isEList(s) && s.k === 'stringdisplay' ? displays(s) : [];
    return { id: inner.id, text, displays: [...inner.displays, ...sd] };
  }
  if (x.k === 'name') { const inner = nameOf(x.items[0]); return { ...inner, displays: [...inner.displays, ...displays(x)] }; }
  if (x.k === 'array') return nameOf(x.items[0]);
  return { id: '', text: '', displays: [] };
}

function shapesOf(f: EList): EShape[] {
  const out: EShape[] = [];
  for (const s of f.items) {
    if (!isEList(s)) continue;
    if (s.k === 'path') out.push({ kind: 'path', pts: epts(ekid(s, 'pointlist')) });
    else if (s.k === 'polygon') out.push({ kind: 'polygon', pts: epts(ekid(s, 'pointlist')) });
    else if (s.k === 'rectangle') { const p = epts(s); if (p.length === 2) out.push({ kind: 'rect', a: p[0]!, b: p[1]! }); }
    else if (s.k === 'circle') { const p = epts(s); if (p.length === 2) out.push({ kind: 'circle', a: p[0]!, b: p[1]! }); }
    else if (s.k === 'dot') { const p = ept(ekid(s, 'pt')); if (p) out.push({ kind: 'dot', at: p }); }
    else if (s.k === 'openshape' || s.k === 'shape') {
      // A curve: points and three-point arcs, run in order
      const curve = ekid(s, 'curve');
      let run: Pt[] = [];
      const flush = () => { if (run.length > 1) out.push({ kind: s.k === 'shape' ? 'polygon' : 'path', pts: run }); run = []; };
      for (const c of curve?.items ?? []) {
        if (!isEList(c)) continue;
        if (c.k === 'pt') run.push(ept(c)!);
        else if (c.k === 'arc') {
          const p = epts(c);
          if (p.length === 3) { if (run.length && (run[run.length - 1]!.x !== p[0]!.x || run[run.length - 1]!.y !== p[0]!.y)) run.push(p[0]!); flush(); out.push({ kind: 'arc', a: p[0]!, m: p[1]!, b: p[2]! }); run = [p[2]!]; }
        }
      }
      flush();
    }
  }
  return out;
}
const figuresOf = (n: EList | undefined): EFigure[] => ekids(n, 'figure').map((f) => ({ group: typeof f.items[0] === 'string' ? f.items[0] : '', shapes: shapesOf(f) }));
const textsOf = (n: EList | undefined): EText[] => ekids(n, 'annotate').flatMap((a) => {
  const sd = ekid(a, 'stringdisplay');
  if (!sd) return [];
  const s = sd.items.find((i) => i instanceof EStr) as EStr | undefined;
  return s ? [{ text: s.s, display: displays(sd) }] : [];
});

function propsOf(n: EList | undefined): Map<string, { value: string; displays: EDisplay[] }> {
  const out = new Map<string, { value: string; displays: EDisplay[] }>();
  for (const p of ekids(n, 'property')) {
    const name = nameOf(p.items[0]);
    let value = '';
    for (const x of p.items.slice(1)) {
      if (!isEList(x)) continue;
      if (x.k === 'string') { value = estr(x) ?? ''; const sd = ekid(x, 'stringdisplay'); if (sd) value = (sd.items.find((i) => i instanceof EStr) as EStr | undefined)?.s ?? value; }
      else if (x.k === 'integer' || x.k === 'number') value = String(enumber(x.items[0]));
      else if (x.k === 'boolean') value = ekid(x, 'true') ? 'True' : 'False';
    }
    out.set(name.text, { value, displays: [...name.displays, ...ekids(p, 'string').flatMap((s) => displays(ekid(s, 'stringdisplay')))] });
  }
  return out;
}
const flat = (m: Map<string, { value: string }>) => new Map([...m].map(([k, v]) => [k, v.value]));

function portImplOf(pi: EList): EPortImpl {
  const nm = nameOf(pi.items[0]);
  const connect = ekid(pi, 'connectlocation');
  const dot = connect ? shapesOf(ekid(connect, 'figure') ?? connect).find((s) => s.kind === 'dot') : undefined;
  return {
    name: nm.id, figures: figuresOf(pi), connect: dot?.kind === 'dot' ? dot.at : undefined, nameDisplays: nm.displays, symbols: ekids(pi, 'instance').map(instanceOf),
    displays: [...ekids(pi, 'keyworddisplay').flatMap((k) => displays(k).map((d) => ({ kw: lc(String(k.items[0] ?? '')), d }))), ...ekids(pi, 'propertydisplay').flatMap((k) => displays(k).map((d) => ({ kw: lc(String(k.items[0] ?? '')), d })))],
  };
}

function symbolOf(s: EList): ESymbol {
  const pins = new Map<string, EPortImpl>();
  for (const pi of ekids(s, 'portimplementation')) { const p = portImplOf(pi); pins.set(lc(p.name), p); }
  const shows = [...ekids(s, 'keyworddisplay'), ...ekids(s, 'propertydisplay')].flatMap((k) => displays(k).map((d) => ({ what: lc(nameOf(k.items[0]).text), d })));
  const bb = ekid(ekid(s, 'boundingbox'), 'rectangle');
  const bp = epts(bb);
  return { figures: [...figuresOf(s), ...ekids(s, 'commentgraphics').flatMap((c) => figuresOf(c))], pins, texts: [...textsOf(s), ...ekids(s, 'commentgraphics').flatMap((c) => textsOf(c))], shows, box: bp.length === 2 ? { a: bp[0]!, b: bp[1]! } : undefined };
}

function instanceOf(i: EList): EInstance {
  const name = nameOf(i.items[0]);
  const vr = ekid(i, 'viewref'), cr = ekid(vr, 'cellref'), lr = ekid(cr, 'libraryref');
  const t = ekid(i, 'transform');
  const des = ekid(i, 'designator');
  const pinNumbers = new Map<string, string>(), pinShown = new Map<string, boolean>();
  for (const p of ekids(i, 'portinstance')) {
    const dg = ekid(p, 'designator'), d = estr(dg), port = lc(nameOf(p.items[0]).id);
    if (d) pinNumbers.set(port, d);
    const ds = dg ? displays(ekid(dg, 'stringdisplay')) : [];
    if (ds.some((x) => x.visible !== undefined)) pinShown.set(port, ds.some((x) => x.visible !== false));
  }
  return {
    name, view: String(vr?.items[0] ?? ''), cell: lc(nameOf(cr?.items[0]).id), lib: lr ? lc(nameOf(lr.items[0]).id) : undefined,
    orient: (estr(ekid(t, 'orientation')) ?? 'R0').toUpperCase(), at: ept(ekid(ekid(t, 'origin'), 'pt')) ?? { x: 0, y: 0 },
    designator: des ? estr(des) : undefined, designatorDisplays: des ? displays(ekid(des, 'stringdisplay') ?? des) : [], cellDisplays: nameOf(cr?.items[0]).displays,
    props: propsOf(i), pinNumbers, pinShown,
  };
}

/** A net; a net inside it is a piece of the same net, drawn apart: its wires, symbols and joins are the outer net's. */
function netOf(n: EList, out: ENet[], into?: ENet): void {
  const joined: EJoin[] = [];
  for (const pr of ekids(ekid(n, 'joined'), 'portref')) {
    const port = nameOf(pr.items[0]);
    const inst = ekid(pr, 'instanceref');
    const member = ekid(pr, 'member');
    joined.push({ port: lc(member ? nameOf(member.items[0]).id : port.id), inst: inst ? lc(nameOf(inst.items[0]).id) : undefined, member: member ? enumber(member.items[1]) : undefined });
  }
  const name = nameOf(n.items[0]);
  if (into) {
    into.figures.push(...figuresOf(n)); into.instances.push(...ekids(n, 'instance').map(instanceOf));
    for (const j of joined) if (!into.joined.some((q) => q.port === j.port && q.inst === j.inst && q.member === j.member)) into.joined.push(j);
    // (where the piece shows a name, the net's name is shown: the piece's own is the tool's, "$1N5")
    into.name.displays.push(...name.displays);
    for (const sub of ekids(n, 'net')) netOf(sub, out, into);
    return;
  }
  const net: ENet = { name, joined, figures: figuresOf(n), instances: ekids(n, 'instance').map(instanceOf), props: flat(propsOf(n)) };
  out.push(net);
  for (const sub of ekids(n, 'net')) netOf(sub, out, net);
}

function pageOf(p: EList, name: EName, offText = new Map<string, string>()): EPage {
  const nets: ENet[] = [];
  for (const n of ekids(p, 'net')) netOf(n, nets);
  for (const b of ekids(p, 'netbundle')) for (const l of ekids(ekid(b, 'listofnets'), 'net')) netOf(l, nets);
  const size = epts(ekid(ekid(p, 'pagesize'), 'rectangle'));
  return {
    name, size: size.length === 2 ? { a: size[0]!, b: size[1]! } : undefined,
    instances: ekids(p, 'instance').map(instanceOf), nets,
    ports: ekids(p, 'portimplementation').map((pi) => { const r = portImplOf(pi); const t = offText.get(lc(r.name)); return t ? { ...r, text: t } : r; }),
    offPage: ekids(p, 'offpageconnector').map((o) => ({ name: nameOf(o.items[0]).id, figures: [], displays: [], nameDisplays: nameOf(o.items[0]).displays, symbols: [] })),
    comments: { figures: [...ekids(p, 'commentgraphics').flatMap((c) => figuresOf(c)), ...figuresOf(p)], texts: ekids(p, 'commentgraphics').flatMap((c) => textsOf(c)) },
  };
}

function viewOf(v: EList): EView {
  const iface = ekid(v, 'interface');
  const ports: EPort[] = [];
  for (const p of [...ekids(iface, 'port'), ...ekids(iface, 'portbundle').flatMap((b) => ekids(ekid(b, 'listofports'), 'port'))]) {
    const arr = isEList(p.items[0]) && p.items[0].k === 'array' ? enumber(p.items[0].items[1]) : undefined;
    ports.push({ name: nameOf(p.items[0]), dir: (estr(ekid(p, 'direction')) ?? '').toUpperCase(), designator: estr(ekid(p, 'designator')), props: flat(propsOf(p)), array: arr });
  }
  const contents = ekid(v, 'contents');
  // Off-page connectors (of the contents or a page): their texts, for the ports drawn for them
  const offText = new Map<string, string>();
  for (const o of [...ekids(contents, 'offpageconnector'), ...ekids(contents, 'page').flatMap((p) => ekids(p, 'offpageconnector'))]) { const n = nameOf(o.items[0]); offText.set(lc(n.id), n.text); }
  const pages = contents ? (ekids(contents, 'page').length ? ekids(contents, 'page').map((p) => pageOf(p, nameOf(p.items[0]), offText)) : [pageOf(contents, nameOf(v.items[0]), offText)]) : [];
  const sym = ekid(iface, 'symbol');
  const type = (estr(ekid(v, 'viewtype')) ?? '').toUpperCase();
  // A drawing with no interface (a ground or supply symbol of type GRAPHIC): its contents are its symbol
  const drawn = !sym && type === 'GRAPHIC' && contents && !ekids(contents, 'page').length && !ekids(contents, 'instance').length && !ekids(contents, 'net').length && ekids(contents, 'figure').length ? symbolOf(contents) : undefined;
  return { name: lc(nameOf(v.items[0]).id), type, ports, symbol: sym ? symbolOf(sym) : drawn, offPage: offText,
    pages: drawn ? [] : pages.filter((p) => p.instances.length || p.nets.length || p.ports.length || p.comments.figures.length || p.comments.texts.length), props: flat(propsOf(v)) };
}

/** The distance unit of a library: millimetres per EDIF unit (else 0.254: Capture's hundredths of an inch). */
function unitOf(lib: EList): number {
  for (const nd of ekids(ekid(lib, 'technology'), 'numberdefinition')) for (const s of ekids(nd, 'scale')) {
    if (!/distance/i.test(estr(ekid(s, 'unit')) ?? '')) continue;
    const edifUnits = enumber(s.items[0]), metres = enumber(s.items[1]);
    if (edifUnits > 0 && metres > 0) return (metres / edifUnits) * 1000;
  }
  return 0.254;
}

/**
 * A cell's viewMap: the designators, properties and pin numbers the design was given after it was
 * drawn (instanceBackAnnotate, portBackAnnotate), put on the instances they name.
 */
function backAnnotate(vm: EList, views: EView[]): void {
  const find = (ref: EList | undefined): EInstance[] => {
    if (!ref) return [];
    const id = lc(nameOf(ref.items[0]).id), vr = ekid(ref, 'viewref'), vn = vr ? lc(nameOf(vr.items[0]).id) : undefined;
    const out: EInstance[] = [];
    for (const v of views) {
      if (vn && v.name !== vn) continue;
      for (const p of v.pages) for (const i of [...p.instances, ...p.nets.flatMap((n) => n.instances), ...p.ports.flatMap((q) => q.symbols)]) if (lc(i.name.id) === id) out.push(i);
    }
    return out;
  };
  for (const b of ekids(vm, 'instancebackannotate')) for (const i of find(ekid(b, 'instanceref'))) {
    const d = estr(ekid(b, 'designator'));
    if (d) i.designator = d;
    for (const [k, v] of propsOf(b)) {
      const old = [...i.props.keys()].find((q) => lc(q) === lc(k));
      i.props.set(old ?? k, { value: v.value.trim() ? v.value : '', displays: old ? i.props.get(old)!.displays : v.displays });
    }
  }
  for (const b of ekids(vm, 'portbackannotate')) {
    const pr = ekid(b, 'portref'), d = estr(ekid(b, 'designator'));
    if (pr && d) for (const i of find(ekid(pr, 'instanceref'))) i.pinNumbers.set(lc(nameOf(pr.items[0]).id), d);
  }
}

export function readEdif(text: string): EdifDoc {
  const root = parseEdif(text);
  const warnings: string[] = [];
  const libraries = new Map<string, ELibrary>();
  for (const l of [...ekids(root, 'library'), ...ekids(root, 'external')]) {
    const name = nameOf(l.items[0]);
    const lib: ELibrary = { name, external: l.k === 'external', mmPerUnit: unitOf(l), cells: new Map() };
    unitNow = lib.mmPerUnit;
    groupHeights = new Map();
    for (const g of ekids(ekid(l, 'technology'), 'figuregroup')) { const h = enumber(ekid(g, 'textheight')?.items[0]); if (h > 0) groupHeights.set(lc(nameOf(g.items[0]).id), h); }
    for (const c of ekids(l, 'cell')) {
      const cn = nameOf(c.items[0]);
      const views = ekids(c, 'view').map(viewOf);
      for (const vm of ekids(c, 'viewmap')) backAnnotate(vm, views);
      lib.cells.set(lc(cn.id), { name: cn, lib: lc(name.id), type: (estr(ekid(c, 'celltype')) ?? 'GENERIC').toUpperCase(), views });
    }
    libraries.set(lc(name.id), lib);
  }
  const d = ekid(root, 'design');
  const cr = ekid(d, 'cellref');
  const written = ekid(ekid(root, 'status'), 'written');
  return {
    name: nameOf(root.items[0]).text, program: estr(ekid(written, 'program')) ?? '', libraries, warnings,
    design: cr ? { cell: lc(nameOf(cr.items[0]).id), lib: ekid(cr, 'libraryref') ? lc(nameOf(ekid(cr, 'libraryref')!.items[0]).id) : undefined } : undefined,
  };
}

/** Whether a file's first bytes are EDIF's. */
export const isEdifText = (head: string): boolean => /^\s*\(\s*edif\s/i.test(head);
