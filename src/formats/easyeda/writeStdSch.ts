/**
 * AD schematics as EasyEDA Standard's (a schematic document, docType 5, its sheets docType 1, in
 * its JSON): a sheet per SchDoc (a multi-channel one a sheet for each channel, with that channel's
 * designators and nets, as AD flattens it). Parts are EasyEDA parts with their symbols as placed
 * (EasyEDA keeps them so): graphics, texts and pins (length, the way they point, dot, clock,
 * name and number and whether shown, electrical type), the designator and the comment, shown
 * parameters as text, the rest as the part's attributes, the footprint as its package; a part of a
 * multi-part package is named as EasyEDA names them (U1.1, U1.2). Nets join by name in EasyEDA:
 * every net is named as the project compiles it, so the names keep AD's connectivity whatever
 * the net identifier scope — net labels as labels, power ports as power and ground flags, ports,
 * sheet entries and off-sheet connectors as net ports, each with its net's name; wires, buses,
 * junctions (AD's own and its automatic ones), no-ERC marks, text, lines, polygons, rectangles,
 * ellipses, arcs, curves, text frames, sheet symbols (as drawn). EasyEDA's unit is AD's (10 mil),
 * Y down.
 */
import type { Vec2 } from '../../core/geom';
import { DIR_VECTORS, bagOf, componentKind, isShown, ownedBy, type SchFont, type SchObject } from '../../model/sch';
import { compileProject, type SheetInput } from '../../model/compile';
import { autoJunctions } from '../../model/schConnect';
import { entryPoint } from '../../model/schHierarchy';
import { specialResolver } from '../../model/schSpecial';
import { bezierPts, powerGlyph } from '../../editors/sch/powerPort';
import { fieldText, fmt, toBacktick } from './common';
import { easyedaLibId } from './writeStdPcb';

export interface StdSchInput { name: string; sheets: SheetInput[]; hierarchyMode?: number; channelFormat?: string; channelSeparator?: string; variables?: { name: string; value: string }[] }
export interface StdSchExport { json: Record<string, unknown>; bytes: Uint8Array; warnings: string[]; stats: { sheets: number; parts: number; nets: number }; /** Each part's id by its designator (the board's footprints take them). */ ids: Map<string, string> }

const U = 100_000;
const X = (v: number) => fmt(v / U), Y = (v: number) => fmt(-v / U);
const XY = (p: Vec2) => `${X(p.x)} ${Y(p.y)}`;
const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
const width = (w: number) => fmt(Math.max(0.5, w / U));
const STYLE = (s?: number) => String(Math.min(2, Math.max(0, s ?? 0)));
/** AD's font (points) as EasyEDA's size: its unit a 10 mil em, 1.43 points [est: as the import reads it]. */
const sizeOf = (fonts: SchFont[], id: number) => `${Math.max(4, Math.round((fonts[id - 1]?.size ?? 10) / 1.43))}pt`;
const fontName = (fonts: SchFont[], id: number) => fieldText(fonts[id - 1]?.name ?? 'Times New Roman');
const ANCHOR = ['start', 'middle', 'end'];
const BASELINE = ['', 'middle', 'hanging'];
/** AD's turn (anticlockwise quarters) as EasyEDA's text rotation (degrees, clockwise as SVG has it). */
const textRot = (orient: number) => String((360 - (orient & 3) * 90) % 360);
/** AD's electrical types as EasyEDA's: 0 none, 1 input, 2 output, 3 bidirectional, 4 power. */
const ELEC = [1, 3, 2, 0, 0, 0, 0, 4];
/** AD's power port styles as EasyEDA's flags. */
const FLAG = ['Bar', '+5V', 'VCC', 'VCC', 'gnD', 'GNd', 'GnD', '+5V', 'gnD', 'GnD', 'VCC'];

export function exportEasyedaSch(input: StdSchInput): StdSchExport {
  const warnings: string[] = [];
  const tally = new Map<string, number>();
  const note = (w: string) => tally.set(w, (tally.get(w) ?? 0) + 1);
  const sheets = input.sheets;
  const c = compileProject(sheets, { scope: input.hierarchyMode ?? 0, channelFormat: input.channelFormat, channelSeparator: input.channelSeparator, checkBounds: false });

  /* ── each net's name: as compiled, one name a net ── */
  const used = new Set<string>();
  const nameOf = new Map<(typeof c.nets)[number], string>();
  for (const n of c.nets) {
    const base = n.name.trim() || 'N';
    let nm = base;
    for (let k = 2; used.has(nm.toUpperCase()); k++) nm = `${base}_${k}`;
    used.add(nm.toUpperCase());
    nameOf.set(n, nm);
  }
  // Each object's net and part in each instance of its sheet ("instance|sheet:index")
  const key2 = (inst: string | undefined, r: { sheet: string; index: number }) => `${inst ?? r.sheet}|${r.sheet}:${r.index}`;
  const pagesOf = new Map<string, string[]>();
  const sawInst = (sheet: string, inst: string | undefined) => { const l = pagesOf.get(sheet) ?? []; const k = inst ?? sheet; if (!l.includes(k)) l.push(k); pagesOf.set(sheet, l); };
  const netAt = new Map<string, { name: string; auto: boolean; sheets: number }>();
  for (const n of c.nets) {
    const v = { name: nameOf.get(n)!, auto: n.auto, sheets: new Set(n.sheets).size };
    for (const ir of n.instRefs ?? n.refs.map((ref) => ({ ref, inst: ref.sheet }))) { sawInst(ir.ref.sheet, ir.inst); const k = key2(ir.inst, ir.ref); if (!netAt.has(k)) netAt.set(k, v); }
    for (const p of n.pins) { sawInst(p.ref.sheet, p.inst); const k = key2(p.inst, p.ref); if (!netAt.has(k)) netAt.set(k, v); }
  }
  const compAt = new Map<string, (typeof c.components)[number]>();
  const roomOf = new Map<string, string>();
  for (const comp of c.components) comp.refs.forEach((r, i) => {
    // Each part's own instance (a package's parts may lie on other sheets)
    const inst = comp.refInsts?.[i] || comp.inst;
    sawInst(r.sheet, inst);
    const k = key2(inst, r);
    if (!compAt.has(k)) compAt.set(k, comp);
    if (comp.channel && inst) roomOf.set(inst, comp.channel);
  });
  const pages: { s: SheetInput; inst: string; title: string }[] = [];
  for (const s of sheets) {
    const list = pagesOf.get(s.name) ?? [s.name];
    const stem = s.name.replace(/\.schdoc$/i, '');
    list.forEach((inst, k) => pages.push({ s, inst, title: list.length > 1 ? `${stem}_${roomOf.get(inst) ?? k + 1}` : stem }));
    if (list.length > 1) warnings.push(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} sheets with each channel's designators and nets`);
  }
  const vars = new Map((input.variables ?? []).map((v) => [v.name.toUpperCase(), v.value]));
  let nParts = 0;
  const ids = new Map<string, string>();

  const out = pages.map(({ s, inst, title }, si) => {
    const doc = s.doc, fonts = doc.sheet.fonts;
    const owned = ownedBy(doc);
    const ref = (o: SchObject) => key2(inst, { sheet: s.name, index: o.index });
    const resolve = specialResolver(doc, { docName: s.name, projectName: input.name, projectParams: vars }, true);
    const special = (t: string, owner = -1) => {
      const k = t.trim().toUpperCase();
      if (k === '=SHEETNUMBER') return String(si + 1);
      if (k === '=SHEETTOTAL') return String(pages.length);
      return resolve(t, owner);
    };
    const shapes: string[] = [];
    let n = 1;
    const id = () => `gge${n++}`;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (p: Vec2) => { const x = p.x / U, y = -p.y / U; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    const pts = (l: Vec2[]) => { for (const p of l) see(p); return l.map(XY).join(' '); };
    const netOf = (o: SchObject) => netAt.get(ref(o));

    /** A text EasyEDA draws: mark L (text), P (designator), N (name, the comment). */
    const text = (mark: string, at: Vec2, t: string, font: number, orient: number, justify: number, colour: number, shown = true) => {
      see(at);
      return ['T', mark, X(at.x), Y(at.y), textRot(orient), hex(colour), fontName(fonts, font), sizeOf(fonts, font), '', '', BASELINE[Math.floor(justify / 3) % 3]!, 'comment', fieldText(t), shown ? '1' : '0', ANCHOR[justify % 3]!, id(), '0', ''].join('~');
    };
    /** A drawing as EasyEDA's records (at the same places: a part's drawings are as placed). */
    const graphic = (o: SchObject): string[] => {
      switch (o.kind) {
        case 'polyline': return o.pts.length >= 2 ? [['PL', pts(o.pts), hex(o.color), width(o.width), STYLE(o.style), 'none', id(), '0'].join('~')] : [];
        case 'busentry': return [['PL', pts([o.a, o.b]), hex(o.color), width(o.width), '0', 'none', id(), '0'].join('~')];
        case 'polygon': return o.pts.length >= 3 ? [['PG', pts(o.pts), hex(o.color), width(o.width), '0', o.solid && !o.transparent ? hex(o.fill) : 'none', id(), '0'].join('~')] : [];
        case 'rect': {
          const a = { x: Math.min(o.a.x, o.b.x), y: Math.max(o.a.y, o.b.y) }, w = Math.abs(o.b.x - o.a.x), h = Math.abs(o.b.y - o.a.y);
          see(a); see({ x: a.x + w, y: a.y - h });
          return [['R', X(a.x), Y(a.y), o.r ? X(o.r) : '', o.r ? X(o.ry) : '', X(w), X(h), hex(o.color), width(o.width), '0', o.solid && !o.transparent ? hex(o.fill) : 'none', id(), '0'].join('~')];
        }
        case 'ellipse': see({ x: o.c.x - o.rx, y: o.c.y - o.ry }); see({ x: o.c.x + o.rx, y: o.c.y + o.ry });
          return [['E', X(o.c.x), Y(o.c.y), X(o.rx), X(o.ry), hex(o.color), width(o.width), '0', o.solid && !o.transparent ? hex(o.fill) : 'none', id(), '0'].join('~')];
        case 'arc': {
          const span = ((o.end - o.start) % 360 + 360) % 360;
          if (span < 1e-6 || span > 359.99) return [['E', X(o.c.x), Y(o.c.y), X(o.rx), X(o.ry), hex(o.color), width(o.width), '0', 'none', id(), '0'].join('~')];
          const at = (a: number) => ({ x: o.c.x + o.rx * Math.cos((a * Math.PI) / 180), y: o.c.y + o.ry * Math.sin((a * Math.PI) / 180) });
          const s0 = at(o.start), e0 = at(o.end);
          see(s0); see(e0); see(at(o.start + span / 2));
          // Anticlockwise on screen (AD's way) is SVG's sweep 0
          return [['A', `M ${XY(s0)} A ${X(o.rx)} ${X(o.ry)} 0 ${span > 180 ? 1 : 0} 0 ${XY(e0)}`, '', hex(o.color), width(o.width), '0', 'none', id(), '0'].join('~')];
        }
        case 'bezier': {
          if (o.pts.length < 4) return [];
          let d = `M ${pts([o.pts[0]!])}`;
          for (let i = 1; i + 2 < o.pts.length; i += 3) d += ` C ${pts([o.pts[i]!, o.pts[i + 1]!, o.pts[i + 2]!])}`;
          return [['PT', d, hex(o.color), width(o.width), '0', 'none', id(), '0', ''].join('~')];
        }
        case 'piechart': {
          const span = ((o.end - o.start) % 360 + 360) % 360 || 360;
          const ring: Vec2[] = [o.c];
          for (let i = 0; i <= 24; i++) { const a = ((o.start + (span * i) / 24) * Math.PI) / 180; ring.push({ x: o.c.x + o.r * Math.cos(a), y: o.c.y + o.r * Math.sin(a) }); }
          return [['PG', pts(ring), hex(o.color), width(o.width), '0', o.solid ? hex(o.fill) : 'none', id(), '0'].join('~')];
        }
        default: return [];
      }
    };
    /** A pin: its tip where wires join, its line to the body, its name inside, its number on it. */
    const pin = (o: SchObject & { kind: 'pin' }): string => {
      const d = DIR_VECTORS[o.orient & 3]!;
      const body = o.at, hot = { x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length };
      see(body); see(hot);
      const horiz = d.x !== 0;
      const L = horiz ? (body.x - hot.x) / U : -(body.y - hot.y) / U;
      // Into the body, along the pin; across it
      const inward = { x: -d.x, y: -d.y };
      const nameAt = { x: body.x + inward.x * 3 * U, y: body.y + inward.y * 3 * U - (horiz ? 2.5 * U : 0) };
      const numAt = { x: (body.x + hot.x) / 2 + (horiz ? 0 : -1 * U), y: (body.y + hot.y) / 2 + (horiz ? 1 * U : 0) };
      // EasyEDA's vertical pin text reads upwards (270°): its anchor at its lower end
      const nameAnchor = horiz ? (inward.x > 0 ? 'start' : 'end') : (inward.y > 0 ? 'start' : 'end');
      const rot = horiz ? '0' : '270';
      const dot = o.symbols.outerEdge === 1, clock = o.symbols.innerEdge === 3;
      const perp = { x: -d.y, y: d.x };
      const tri = [{ x: body.x + perp.x * 3 * U, y: body.y + perp.y * 3 * U }, { x: body.x + inward.x * 3 * U, y: body.y + inward.y * 3 * U }, { x: body.x - perp.x * 3 * U, y: body.y - perp.y * 3 * U }];
      const bub = { x: body.x + d.x * 3 * U, y: body.y + d.y * 3 * U };
      const hidden = o.hidden;
      return [
        ['P', hidden ? 'none' : 'show', String(ELEC[o.electrical] ?? 0), fieldText(o.designator), X(hot.x), Y(hot.y), String(((o.orient & 3) * 90) % 360), id(), '0'].join('~'),
        [X(hot.x), Y(hot.y)].join('~'),
        [`M ${X(hot.x)} ${Y(hot.y)} ${horiz ? 'h' : 'v'} ${fmt(L)}`, '#880000'].join('~'),
        [o.showName && o.name ? '1' : '0', X(nameAt.x), Y(nameAt.y), rot, fieldText(o.name), nameAnchor, '', '', '#0000FF'].join('~'),
        [o.showDesignator ? '1' : '0', X(numAt.x), Y(numAt.y), rot, fieldText(o.designator), 'middle', '', '', '#0000FF'].join('~'),
        [dot ? '1' : '0', X(bub.x), Y(bub.y)].join('~'),
        [clock ? '1' : '0', `M ${tri.map(XY).join(' L ')}`].join('~'),
      ].join('^^');
    };

    /* ── parts ── */
    for (const o of doc.objects) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const bag = bagOf(doc, o);
      const kids = (owned.get(o.index) ?? []).filter((k) => isShown(doc, k));
      const comp = compAt.get(ref(o));
      const des0 = comp?.designator || o.designator || 'U?';
      const multi = o.partCount > 2;
      const des = multi ? `${des0}.${o.partId}` : des0;
      const params = new Map<string, string>();
      let comment = '', footprint = '', link = '';
      for (const k of owned.get(o.index) ?? []) {
        const kb = bagOf(doc, k);
        if (k.kind === 'text' && k.role === 'parameter') {
          const nm = kb?.get('NAME') ?? '';
          const v = special(k.text, o.index);
          if (/^comment$/i.test(nm)) comment = v;
          else if (nm && v && !/^(designator)$/i.test(nm)) params.set(nm, v);
          if (/^(datasheet|helpurl|componentlink1url)$/i.test(nm)) link = v;
        }
        if (k.record === 45 && (kb?.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB' && (!footprint || kb?.bool('ISCURRENT'))) footprint = kb?.get('MODELNAME') ?? footprint;
      }
      const kind = bag ? componentKind(bag) : 0;
      const prefix = des0.replace(/[\d?].*$/, '') || 'U';
      const libRef = o.libRef || 'Part';
      const para = toBacktick([['package', kind === 2 ? 'NONE' : footprint], ['pre', `${prefix}?`], ['spicePre', prefix], ['name', libRef], ['spiceSymbolName', libRef],
        ...(link ? [['link', link] as [string, string]] : []), ...[...params].filter(([k]) => !/^(package|pre|spicePre|name|spiceSymbolName|link)$/.test(k))]);
      const uid = comp?.uniqueId || bag?.get('UNIQUEID') || `${s.name}:${o.index}`;
      const libId = easyedaLibId(o.partId > 1 && multi ? `${uid}.${o.partId}` : uid);
      if (!multi || o.partId <= 1) ids.set(des0, libId);
      const subs: string[] = [];
      let gotDes = false, gotCom = false;
      for (const k of kids) {
        switch (k.kind) {
          case 'pin': subs.push(pin(k)); if (k.hidden && bagOf(doc, k)?.get('HIDDENNETNAME')) note('Hidden power pins: EasyEDA joins no pins by name — a net label at each keeps its net'); break;
          case 'text':
            if (k.role === 'designator') { gotDes = true; subs.push(text('P', k.at, des, k.font, k.orient, k.justify, k.color, !k.hidden)); }
            else if (k.role === 'parameter') {
              const nm = bagOf(doc, k)?.get('NAME') ?? '';
              if (/^comment$/i.test(nm)) { gotCom = true; subs.push(text('N', k.at, comment, k.font, k.orient, k.justify, k.color, !k.hidden)); }
              else if (!k.hidden && k.text.trim()) subs.push(text('L', k.at, special(k.text, o.index), k.font, k.orient, k.justify, k.color));
            } else if (k.role === 'label' && k.text.trim()) subs.push(text('L', k.at, special(k.text, o.index), k.font, k.orient, k.justify, k.color));
            break;
          case 'image': note('Images left out'); break;
          case 'ieee': note('IEEE symbols left out'); break;
          default: subs.push(...graphic(k));
        }
      }
      if (!gotDes) subs.push(text('P', o.at, des, 1, 0, 0, 0x000080, false));
      if (!gotCom) subs.push(text('N', o.at, comment || libRef, 1, 0, 0, 0x000080, false));
      see(o.at);
      const head = ['LIB', X(o.at.x), Y(o.at.y), para, String(((o.orient & 3) * 90) % 360), '0', libId, footprint ? easyedaLibId(`fp:${footprint}`).slice(3).padEnd(32, '0') : '', easyedaLibId(`sym:${libRef}`).slice(3).padEnd(32, '0'), '0', '', 'yes', 'yes', '', '', ''].join('~');
      shapes.push([head, ...subs].join('#@$'));
      // A hidden pin's net: a label at its tip
      for (const k of kids) {
        if (k.kind !== 'pin' || !k.hidden) continue;
        const net = netOf(k);
        if (!net) continue;
        const d = DIR_VECTORS[k.orient & 3]!;
        shapes.push(netLabel({ x: k.at.x + d.x * k.length, y: k.at.y + d.y * k.length }, net.name, 0));
      }
      nParts++;
    }

    /** A net label: its point, its name, which way it reads. */
    function netLabel(at: Vec2, name: string, orient: number): string {
      see(at);
      const o = orient & 3;
      const off = [[2, -2.5], [-2.5, -2], [-2, -2.5], [2.5, 2]][o]!;
      return ['N', X(at.x), Y(at.y), String(o * 90), '#000080', fieldText(name), id(), 'start', fmt(at.x / U + off[0]!), fmt(-at.y / U + off[1]!), 'Times New Roman', '7pt', '0'].join('~');
    }
    /** A flag (power port or net port): its point, its name, which way its body lies (AD's orientation), its type, its drawing. */
    function flag(at: Vec2, name: string, dirOrient: number, type: string, drawing: string[], shown = true): string {
      see(at);
      const d = DIR_VECTORS[dirOrient & 3]!;
      const ground = /gnd/i.test(type);
      // EasyEDA's turn: from a ground hanging down, a supply standing up
      const rot = (((dirOrient & 3) - (type === 'netPort' ? 0 : ground ? 3 : 1)) * 90 % 360 + 360) % 360;
      const tAt = { x: at.x + d.x * 12 * U, y: at.y + d.y * 12 * U };
      return [
        ['F', `part_netLabel_${type}`, X(at.x), Y(at.y), String(rot), id(), '', '0'].join('~'),
        [X(at.x), Y(at.y)].join('~'),
        [fieldText(name), '#000000', X(tAt.x), Y(tAt.y), '0', d.x < 0 ? 'end' : d.x > 0 ? 'start' : 'middle', shown ? '1' : '0', 'Times New Roman', '9pt', `flag_${id()}`].join('~'),
        ...drawing,
      ].join('^^');
    }
    /** A port's drawing from its point: a box with a point (its height wide), `len` long, the way `orient` goes. */
    const portDrawing = (at: Vec2, orient: number, len: number, h: number): string[] => {
      const d = DIR_VECTORS[orient & 3]!, p = { x: -d.y, y: d.x };
      const q = (a: number, b: number) => ({ x: at.x + d.x * a + p.x * b, y: at.y + d.y * a + p.y * b });
      const l = Math.max(len, h);
      const ring = [q(0, 0), q(h / 2, h / 2), q(l, h / 2), q(l, -h / 2), q(h / 2, -h / 2), q(0, 0)];
      return [['PL', pts(ring), '#000000', '1', '0', 'transparent', id(), '0'].join('~')];
    };

    /* ── the sheet's own objects ── */
    const ends: Vec2[] = [];
    for (const o of doc.objects) if (o.kind === 'wire' && isShown(doc, o) && o.pts.length) ends.push(o.pts[0]!, o.pts[o.pts.length - 1]!);
    for (const o of doc.objects) if (o.kind === 'pin' && isShown(doc, o)) { const d = DIR_VECTORS[o.orient & 3]!; ends.push({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length }); }
    const touches = (p: Vec2) => ends.some((e) => Math.abs(e.x - p.x) < 2 && Math.abs(e.y - p.y) < 2);
    for (const o of doc.objects) {
      if (!isShown(doc, o)) continue;
      const ownerKind = o.owner >= 0 ? doc.objects[o.owner]?.kind : undefined;
      if (ownerKind === 'component') continue;
      switch (o.kind) {
        case 'wire': if (o.pts.length >= 2) shapes.push(['W', pts(o.pts), '#008800', '1', '0', 'none', id(), '0'].join('~')); break;
        case 'bus': if (o.pts.length >= 2) { shapes.push(['B', pts(o.pts), '#008800', '2', '0', 'none', id(), '0'].join('~')); note('Buses drawn as buses: their members join by their net labels'); } break;
        case 'junction': see(o.at); shapes.push(['J', X(o.at.x), Y(o.at.y), '2.5', '#CC0000', id(), '0'].join('~')); break;
        case 'noerc': see(o.at); shapes.push(['O', X(o.at.x), Y(o.at.y), id(), `M ${X(o.at.x - 4 * U)} ${Y(o.at.y - 4 * U)} L ${X(o.at.x + 4 * U)} ${Y(o.at.y + 4 * U)} M ${X(o.at.x + 4 * U)} ${Y(o.at.y - 4 * U)} L ${X(o.at.x - 4 * U)} ${Y(o.at.y + 4 * U)}`, '#FF0000', '0'].join('~')); break;
        case 'text':
          if (o.role === 'netlabel') { shapes.push(netLabel(o.at, netOf(o)?.name ?? o.text, o.orient)); break; }
          if (o.role === 'label' && o.owner < 0 && o.text.trim()) shapes.push(text('L', o.at, special(o.text), o.font, o.orient, o.justify, o.color));
          else if ((o.role === 'sheetname' || o.role === 'filename') && o.text.trim()) shapes.push(text('L', o.at, o.text, o.font, o.orient, o.justify, o.color));
          break;
        case 'power': {
          const net = netOf(o)?.name ?? o.text;
          const g = powerGlyph(o.style);
          const d = DIR_VECTORS[o.orient & 3]!, p = { x: -d.y, y: d.x };
          const q = ([a, b]: [number, number]) => ({ x: o.at.x + (d.x * a + p.x * b) * 10_000, y: o.at.y + (d.y * a + p.y * b) * 10_000 });
          const drawing = [
            ...g.lines.map((l) => ['PL', pts(l.map(q)), '#000000', '1', '0', 'transparent', id(), '0'].join('~')),
            ...(g.circles ?? []).map((cc) => { const cp = q(cc.c); see(cp); return ['E', X(cp.x), Y(cp.y), fmt(cc.r / 10), fmt(cc.r / 10), '#000000', '1', '0', 'none', id(), '0'].join('~'); }),
            ...(g.beziers ?? []).map((bz) => ['PL', pts(bezierPts(bz).map(q)), '#000000', '1', '0', 'transparent', id(), '0'].join('~')),
          ];
          shapes.push(flag(o.at, net, o.orient, FLAG[o.style] ?? 'VCC', drawing, o.showText));
          break;
        }
        case 'port': {
          const vertical = o.style >= 4;
          // A port on no net (a harness's): drawn, joining nothing
          if (!netOf(o)) {
            const len = o.width, d = vertical ? 1 : 0;
            shapes.push(...portDrawing(o.at, d, len, o.height));
            shapes.push(text('L', { x: o.at.x + (vertical ? 0 : o.height), y: o.at.y + (vertical ? o.height : -o.height / 3) }, o.name, o.font || 1, vertical ? 1 : 0, 0, o.textColor));
            note('Ports on no net (harness ports) drawn only');
            break;
          }
          const net = netOf(o)!.name;
          const far = vertical ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y };
          // Its point: the end a wire or pin meets (else its start)
          const atFar = touches(far) && !touches(o.at);
          const at = atFar ? far : o.at;
          const orient = vertical ? (atFar ? 3 : 1) : (atFar ? 2 : 0);
          shapes.push(flag(at, net, orient, 'netPort', portDrawing(at, orient, o.width, o.height)));
          break;
        }
        case 'sheetentry': {
          const at = entryPoint(doc, o);
          if (!at || !netOf(o)) break;
          const net = netOf(o)!.name;
          // Pointing out of its sheet symbol, from the edge
          const orient = o.side === 1 ? 0 : o.side === 2 ? 1 : o.side === 3 ? 3 : 2;
          shapes.push(flag(at, net, (orient + 2) % 4, 'netPort', portDrawing(at, (orient + 2) % 4, 60 * U / 10, 10 * U)));
          note('Sheet symbols drawn, their entries as net ports with their nets\' names (EasyEDA is flat)');
          break;
        }
        case 'sheetsymbol': {
          const a = o.at, b = { x: o.at.x + o.w, y: o.at.y - o.h };
          see(a); see(b);
          shapes.push(['R', X(a.x), Y(a.y), '', '', X(o.w), X(o.h), hex(o.color), width(o.width), '0', 'none', id(), '0'].join('~'));
          break;
        }
        case 'textframe': {
          const a = { x: Math.min(o.a.x, o.b.x), y: Math.max(o.a.y, o.b.y) }, w = Math.abs(o.b.x - o.a.x), h = Math.abs(o.b.y - o.a.y);
          if (o.border || o.solid) { see(a); see({ x: a.x + w, y: a.y - h }); shapes.push(['R', X(a.x), Y(a.y), '', '', X(w), X(h), hex(o.color), width(o.width), '0', o.solid ? hex(o.fill) : 'none', id(), '0'].join('~')); }
          const em = ((fonts[o.font - 1]?.size ?? 10) * 5 / 0.716) * 10_000;
          o.text.split(/~1|\r?\n/).forEach((line, i) => { if (line.trim()) shapes.push(text('L', { x: a.x + o.margin, y: a.y - o.margin - em * (i + 0.85) }, special(line), o.font, 0, 0, o.textColor)); });
          break;
        }
        case 'image': note('Images left out'); break;
        case 'harness': case 'harnessentry': case 'signalharness': note('Harnesses left out (their nets are kept by their names)'); break;
        case 'directive': case 'compilemask': case 'blanket': note('Directives left out'); break;
        case 'ieee': note('IEEE symbols left out'); break;
        case 'component': case 'pin': case 'meta': break;
        default: shapes.push(...graphic(o));
      }
    }
    // AD's automatic junctions, as dots
    for (const j of autoJunctions(doc)) { see(j.at); shapes.push(['J', X(j.at.x), Y(j.at.y), '2.5', '#CC0000', id(), '0'].join('~')); }
    // A net's name on each stretch of its wires nothing names (AD joins them by other ways — harnesses,
    // the hierarchy — EasyEDA by name alone), where it is named or goes on to other sheets
    const wires = doc.objects.filter((o): o is SchObject & { kind: 'wire' } => o.kind === 'wire' && isShown(doc, o) && o.pts.length >= 2);
    const segs = wires.flatMap((w, wi) => w.pts.slice(1).map((b, i) => ({ a: w.pts[i]!, b, wi })));
    const onSeg = (q: Vec2, g: { a: Vec2; b: Vec2 }) => {
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
      const u = L2 ? Math.max(0, Math.min(1, ((q.x - g.a.x) * dx + (q.y - g.a.y) * dy) / L2)) : 0;
      return Math.hypot(g.a.x + u * dx - q.x, g.a.y + u * dy - q.y) < 2;
    };
    const parent = wires.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i; };
    wires.forEach((w, wi) => { for (const e of [w.pts[0]!, w.pts[w.pts.length - 1]!]) for (const g of segs) if (g.wi !== wi && onSeg(e, g)) parent[find(wi)] = find(g.wi); });
    const namedIn = new Map<number, Set<string>>();
    const mark = (q: Vec2, nm: string) => { for (const g of segs) if (onSeg(q, g)) { const r = find(g.wi); const st = namedIn.get(r) ?? new Set(); st.add(nm); namedIn.set(r, st); } };
    for (const o of doc.objects) {
      if (!isShown(doc, o)) continue;
      const v = (o.kind === 'text' && o.role === 'netlabel') || o.kind === 'power' || o.kind === 'port' || o.kind === 'sheetentry' ? netOf(o) : undefined;
      if (!v) continue;
      if (o.kind === 'port') { mark(o.at, v.name); mark(o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }, v.name); }
      else if (o.kind === 'sheetentry') { const q = entryPoint(doc, o); if (q) mark(q, v.name); }
      else mark((o as { at: Vec2 }).at, v.name);
    }
    const done = new Set<number>();
    wires.forEach((w, wi) => {
      const r = find(wi);
      if (done.has(r)) return;
      done.add(r);
      const v = netOf(w);
      if (!v || (v.auto && v.sheets < 2) || namedIn.get(r)?.has(v.name)) return;
      shapes.push(netLabel(w.pts[0]!, v.name, 0));
    });

    if (!Number.isFinite(x0)) { x0 = 0; y0 = -100; x1 = 100; y1 = 0; }
    const uuid = easyedaLibId(`sheet:${title}`).slice(3) + easyedaLibId(`sheet2:${title}`).slice(3);
    return {
      docType: '1', title, description: '',
      dataStr: {
        head: { docType: '1', editorVersion: '6.5.34', newgId: true, c_para: { 'Prefix Start': '1' }, c_spiceCmd: 'null', hasIdFlag: true, uuid, x: '0', y: '0', importFlag: 0, transformList: '' },
        canvas: 'CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0',
        shape: shapes,
        BBox: { x: fmt(x0), y: fmt(y0), width: fmt(x1 - x0), height: fmt(y1 - y0) },
        colors: {},
      },
    };
  });
  const json = { editorVersion: '6.5.34', docType: '5', title: input.name, description: '', colors: {}, schematics: out };
  for (const [k, v] of tally) warnings.push(v > 1 ? `${k} (${v})` : k);
  return { json, bytes: new TextEncoder().encode(JSON.stringify(json)), warnings, stats: { sheets: out.length, parts: nParts, nets: c.nets.length }, ids };
}
