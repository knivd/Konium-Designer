/**
 * File › Fabrication Outputs › ODB++ Files: an ODB++ (v7) job as one .tgz — the matrix of
 * layers in stack order, the step's profile, each layer's features (standard symbols in
 * microns, surfaces for regions and shaped pads), the drill layer, the components on top and
 * bottom with their toeprints, and eda/data tying copper features to nets and packages.
 * Layer names are AD's in lower case with spaces as underscores [est: AD17's names].
 */
import type { Vec2 } from '../core/geom';
import { rotate } from '../core/geom';
import { L, layerName, type LayerId } from '../model/layers';
import type { PadStackLayer, PcbDocument, PcbPad } from '../model/pcb';
import { APP_VERSION } from '../platform/distribution';
import { holes } from './gerber/drill';
import { padOutline, plottableLayers } from './gerber/gerber';
import { layerFeatures, signedArea, type Tagged } from './features';
import { gzip, tar } from './tar';

const MM = 25.4 / 10_000_000;
const f6 = (c: number) => String(+(c * MM).toFixed(6));
const um = (c: number) => Math.max(1, Math.round(c * MM * 1000));
const odbName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_+\-.]+/g, '_').replace(/^_+|_+$/g, '') || 'layer';

/** The matrix TYPE of a board layer. */
function odbType(l: LayerId): string {
  if (l >= L.TOP && l <= L.BOTTOM) return 'SIGNAL';
  if (l >= L.PLANE1 && l <= L.PLANE16) return 'POWER_GROUND';
  if (l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER) return 'SOLDER_MASK';
  if (l === L.TOP_PASTE || l === L.BOTTOM_PASTE) return 'SOLDER_PASTE';
  if (l === L.TOP_OVERLAY || l === L.BOTTOM_OVERLAY) return 'SILK_SCREEN';
  return 'DOCUMENT';
}

/** Stack order: paste, silk, mask, copper top to bottom, mask, silk, paste; documents after. */
function ordered(doc: PcbDocument, layers: LayerId[]): LayerId[] {
  const rank = (l: LayerId): number => {
    const ci = doc.board.copperStack.indexOf(l);
    if (ci >= 0) return 10 + ci;
    const r: Partial<Record<number, number>> = { [L.TOP_PASTE]: 1, [L.TOP_OVERLAY]: 2, [L.TOP_SOLDER]: 3, [L.BOTTOM_SOLDER]: 100, [L.BOTTOM_OVERLAY]: 101, [L.BOTTOM_PASTE]: 102 };
    return r[l] ?? 200 + l;
  };
  return [...layers].sort((a, b) => rank(a) - rank(b));
}

class Symbols {
  names: string[] = [];
  private index = new Map<string, number>();
  get(name: string): number { let i = this.index.get(name); if (i === undefined) { i = this.names.length; this.names.push(name); this.index.set(name, i); } return i; }
  /** A standard symbol for a pad shape (null: draw it as a surface). */
  pad(st: PadStackLayer, grow = 0): number | null {
    const w = st.w + 2 * grow, h = st.h + 2 * grow;
    if (w <= 0 || h <= 0) return null;
    if (st.shape === 'round') return this.get(w === h ? `r${um(w)}` : `oval${um(w)}x${um(h)}`);
    if (st.shape === 'rect') return this.get(w === h ? `s${um(w)}` : `rect${um(w)}x${um(h)}`);
    if (st.shape === 'roundrect') return this.get(`rect${um(w)}x${um(h)}xr${um((Math.min(w, h) / 2) * (st.cornerPct / 100))}`);
    if (st.shape === 'octagon') return this.get(`oct${um(w)}x${um(h)}x${um(Math.min(w, h) / 2 * (1 - 1 / (1 + Math.SQRT2)))}`);
    return null;
  }
}

function surface(outline: Vec2[], holes: Vec2[][], o: Vec2): string[] {
  const ring = (p: Vec2[], hole: boolean) => {
    // Islands clockwise, holes counter-clockwise (ODB++'s convention)
    const q = (signedArea(p) < 0) === !hole ? p : [...p].reverse();
    return [`OB ${f6(q[0]!.x - o.x)} ${f6(q[0]!.y - o.y)} ${hole ? 'H' : 'I'}`, ...q.slice(1).map((v) => `OS ${f6(v.x - o.x)} ${f6(v.y - o.y)}`), `OS ${f6(q[0]!.x - o.x)} ${f6(q[0]!.y - o.y)}`, 'OE'];
  };
  return ['S P 0', ...ring(outline, false), ...holes.filter((h) => h.length >= 3).flatMap((h) => ring(h, true)), 'SE'];
}

/** A layer's features file; each feature's meta by its index (for eda/data). */
function featuresFile(items: Tagged[], o: Vec2, attrs: string[] = []): { text: string; metas: Tagged['m'][] } {
  const sym = new Symbols();
  const body: string[] = [];
  const metas: Tagged['m'][] = [];
  for (const { f, m } of items) {
    switch (f.t) {
      case 'line': body.push(`L ${f6(f.a.x - o.x)} ${f6(f.a.y - o.y)} ${f6(f.b.x - o.x)} ${f6(f.b.y - o.y)} ${sym.get(`r${um(f.w)}`)} P 0`); break;
      case 'arc': {
        const sweep = ((f.end - f.start) % 360 + 360) % 360 || 360;
        const p = (d: number) => ({ x: f.c.x + f.r * Math.cos((d * Math.PI) / 180), y: f.c.y + f.r * Math.sin((d * Math.PI) / 180) });
        const a = p(f.start), b = p(f.start + sweep);
        body.push(`A ${f6(a.x - o.x)} ${f6(a.y - o.y)} ${f6(b.x - o.x)} ${f6(b.y - o.y)} ${f6(f.c.x - o.x)} ${f6(f.c.y - o.y)} ${sym.get(`r${um(f.w)}`)} P 0 N`);
        break;
      }
      case 'dot': body.push(`P ${f6(f.at.x - o.x)} ${f6(f.at.y - o.y)} ${sym.get(`r${um(f.d)}`)} P 0 0`); break;
      case 'pad': {
        const s = sym.pad(f.st, f.grow);
        if (s === null) { body.push(...surface(padOutline(f.at, f.st, f.rot, f.grow), [], o)); break; }
        const rot = ((-f.rot % 360) + 360) % 360; // ODB++ turns clockwise
        body.push(`P ${f6(f.at.x - o.x)} ${f6(f.at.y - o.y)} ${s} P 0 ${rot ? `8 ${+rot.toFixed(3)}` : '0'}${m?.fn?.startsWith('SMDPad') ? ' ;0' : ''}`);
        break;
      }
      case 'surface': body.push(...surface(f.outline, f.holes, o)); break;
    }
    metas.push(m);
  }
  const text = ['UNITS=MM', '#', '#Feature symbol names', '#', ...sym.names.map((n, i) => `$${i} ${n}`), '#', '#Feature attribute names', '#', '@0 .smd', ...attrs, '#', '#Layer features', '#', ...body, ''].join('\n');
  return { text, metas };
}

export interface OdbOptions { when?: Date; layers?: LayerId[] }

/** The job's files (paths under <job>/). */
export function odbFiles(doc: PcbDocument, o: OdbOptions = {}): { name: string; text: string }[] {
  const when = o.when ?? new Date();
  const job = odbName(doc.name.replace(/\.pcbdoc$/i, ''));
  const origin = doc.board.origin;
  const lname = (l: LayerId) => odbName(doc.board.layerNames.get(l) ?? layerName(l));
  const layers = ordered(doc, (o.layers ?? plottableLayers(doc)).filter((l) => !(l >= L.MECH1 && l <= L.MECH16) || doc.prims.some((p) => 'layer' in p && p.layer === l && p.kind !== 'body')));
  const files: { name: string; text: string }[] = [];
  const put = (path: string, text: string) => files.push({ name: `${job}/${path}`, text });
  const stamp = `${when.getFullYear()}${String(when.getMonth() + 1).padStart(2, '0')}${String(when.getDate()).padStart(2, '0')}.${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}${String(when.getSeconds()).padStart(2, '0')}`;
  const top = doc.board.copperStack[0]!, bottom = doc.board.copperStack.at(-1)!;
  const n = doc.board.copperStack.length;
  const drill = `drill_1-${n}`;
  const hasTop = doc.components.some((c) => c.layer !== L.BOTTOM), hasBot = doc.components.some((c) => c.layer === L.BOTTOM);

  // Matrix
  const rows: string[][] = [];
  if (hasTop) rows.push(['CONTEXT=BOARD', 'TYPE=COMPONENT', 'NAME=comp_+_top', 'POLARITY=POSITIVE']);
  for (const l of layers) rows.push(['CONTEXT=' + (odbType(l) === 'DOCUMENT' ? 'MISC' : 'BOARD'), `TYPE=${odbType(l)}`, `NAME=${lname(l)}`, 'POLARITY=POSITIVE']);
  if (hasBot) rows.push(['CONTEXT=BOARD', 'TYPE=COMPONENT', 'NAME=comp_+_bot', 'POLARITY=POSITIVE']);
  const hl = holes(doc);
  if (hl.length) rows.push(['CONTEXT=BOARD', 'TYPE=DRILL', `NAME=${drill}`, 'POLARITY=POSITIVE', `START_NAME=${lname(top)}`, `END_NAME=${lname(bottom)}`]);
  put('matrix/matrix', ['STEP {', '   COL=1', '   NAME=PCB', '}', '', ...rows.flatMap((r, i) => ['LAYER {', `   ROW=${i + 1}`, ...r.map((x) => `   ${x}`), '   OLD_NAME=', '}', '']), ''].join('\n'));
  put('misc/info', [`JOB_NAME=${job}`, 'ODB_VERSION_MAJOR=7', 'ODB_VERSION_MINOR=0', 'ODB_SOURCE=Konium Designer', `CREATION_DATE=${stamp}`, `SAVE_DATE=${stamp}`, `SAVE_APP=Konium Designer ${APP_VERSION}`, 'SAVE_USER=', 'UNITS=MM', ''].join('\n'));
  put('steps/pcb/stephdr', ['UNITS=MM', 'X_DATUM=0', 'Y_DATUM=0', 'X_ORIGIN=0', 'Y_ORIGIN=0', 'TOP_ACTIVE=0', 'BOTTOM_ACTIVE=0', 'RIGHT_ACTIVE=0', 'LEFT_ACTIVE=0', 'AFFECTING_BOM=', 'AFFECTING_BOM_CHANGED=0', ''].join('\n'));

  // Profile
  const cutouts = doc.prims.filter((p) => p.kind === 'region' && p.boardCutout).map((p) => (p.kind === 'region' ? p.outline : []));
  put('steps/pcb/profile', ['UNITS=MM', '#', '#Num Features', '#', 'F 1', '#', '#Layer features', '#', ...(doc.board.outline.length >= 3 ? surface(doc.board.outline, cutouts, origin) : []), ''].join('\n'));

  // Layers
  const copperIndex = new Map<LayerId, number>();
  const copperMetas: { layer: number; metas: Tagged['m'][] }[] = [];
  for (const l of layers) {
    const ff = featuresFile(layerFeatures(doc, l), origin);
    put(`steps/pcb/layers/${lname(l)}/features`, ff.text);
    if (odbType(l) === 'SIGNAL' || odbType(l) === 'POWER_GROUND') {
      copperIndex.set(l, copperMetas.length);
      copperMetas.push({ layer: l, metas: ff.metas });
    }
  }
  if (hl.length) {
    const sym = new Symbols();
    const via = new Set(doc.prims.flatMap((p) => (p.kind === 'via' ? [`${p.at.x},${p.at.y}`] : [])));
    const body = hl.map((h) => `P ${f6(h.at.x - origin.x)} ${f6(h.at.y - origin.y)} ${sym.get(`r${um(h.size)}`)} P 0 0;0=${!h.plated ? 'non_plated' : via.has(`${h.at.x},${h.at.y}`) ? 'via' : 'plated'}`);
    put(`steps/pcb/layers/${drill}/features`, ['UNITS=MM', '#', ...sym.names.map((x, i) => `$${i} ${x}`), '#', '@0 .drill', '#', ...body, ''].join('\n'));
  }

  // Packages and components
  const pkgIndex = new Map<string, number>();
  const pkgLines: string[] = [];
  const compLines = { top: [] as string[], bot: [] as string[] };
  const compNum = { top: 0, bot: 0 };
  /** For eda/data: each component pad's toeprint (side, component number on its side, pin number). */
  const toeprint = new Map<PcbPad, { side: 'T' | 'B'; comp: number; pin: number }>();
  const pendingTop: { side: 'top' | 'bot'; line: string; pads: PcbPad[] }[] = [];
  doc.components.forEach((c, ci) => {
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === ci);
    const bottomSide = c.layer === L.BOTTOM;
    const local = (p: PcbPad) => { let v = rotate(p.at, -c.rotation, c.at); v = { x: v.x - c.at.x, y: v.y - c.at.y }; return bottomSide ? { x: -v.x, y: v.y } : v; };
    const name = c.pattern || `pkg_${c.designator}`;
    if (!pkgIndex.has(name)) {
      pkgIndex.set(name, pkgIndex.size);
      const pts = pads.map(local);
      const xs = pts.map((v) => v.x), ys = pts.map((v) => v.y);
      const m = 250_000;
      const box = pts.length ? [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m] : [-m, -m, m, m];
      let pitch = 0;
      if (pts.length > 1) { pitch = Infinity; for (let i = 0; i < pts.length; i++) for (let k = i + 1; k < pts.length; k++) pitch = Math.min(pitch, Math.hypot(pts[i]!.x - pts[k]!.x, pts[i]!.y - pts[k]!.y)); }
      pkgLines.push(`PKG ${odbName(name)} ${f6(pitch)} ${f6(box[0]!)} ${f6(box[1]!)} ${f6(box[2]!)} ${f6(box[3]!)}`, `RC ${f6(box[0]!)} ${f6(box[1]!)} ${f6(box[2]! - box[0]!)} ${f6(box[3]! - box[1]!)}`);
      pads.forEach((p, i) => {
        const q = pts[i]!;
        pkgLines.push(`PIN ${p.name || String(i + 1)} ${p.layer === L.MULTI ? 'T' : 'S'} ${f6(q.x)} ${f6(q.y)} 0 E ${p.layer === L.MULTI ? 'T' : 'S'}`, `RC ${f6(q.x - p.top.w / 2)} ${f6(q.y - p.top.h / 2)} ${f6(p.top.w)} ${f6(p.top.h)}`);
      });
    }
    const side = bottomSide ? 'bot' : 'top';
    const num = compNum[side]++;
    const comment = (doc.prims.find((p) => p.kind === 'text' && p.component === ci && p.isComment) as { text?: string } | undefined)?.text ?? name;
    const rot = ((-c.rotation % 360) + 360) % 360;
    pendingTop.push({ side, pads, line: `CMP ${pkgIndex.get(name)} ${f6(c.at.x - origin.x)} ${f6(c.at.y - origin.y)} ${+rot.toFixed(3)} ${bottomSide ? 'M' : 'N'} ${c.designator} ${odbName(comment)} ;` });
    pads.forEach((p, i) => toeprint.set(p, { side: bottomSide ? 'B' : 'T', comp: num, pin: i }));
  });

  // eda/data: nets and their subnets (toeprints, vias, traces), each with its copper features
  const lyr = copperMetas.map((x) => lname(x.layer));
  const netOrder = doc.nets.map((x) => x.index);
  const netNum = new Map<number, number>(netOrder.map((ni, i) => [ni, i]));
  const subnet = new Map<PcbPad, { net: number; sub: number }>();
  const eda: string[] = [`HDR Konium Designer ${APP_VERSION}`, 'UNITS=MM', `LYR ${lyr.join(' ')}`, '#'];
  // Each copper feature's id, by the primitive it draws (pads and vias) or its net (the rest)
  const byPrim = new Map<object, string[]>(), trcByNet = new Map<number, string[]>();
  copperMetas.forEach((cl, li) => cl.metas.forEach((m, fi) => {
    const prim = m?.prim;
    if (!prim) return;
    const id = `FID C ${li} ${fi}`;
    if (prim.kind === 'pad' || prim.kind === 'via') byPrim.set(prim, [...(byPrim.get(prim) ?? []), id]);
    else if ('net' in prim) trcByNet.set(prim.net, [...(trcByNet.get(prim.net) ?? []), id]);
  }));
  const padsByNet = new Map<number, PcbPad[]>(), viasByNet = new Map<number, object[]>();
  for (const p of doc.prims) {
    if (p.kind === 'pad') padsByNet.set(p.net, [...(padsByNet.get(p.net) ?? []), p]);
    else if (p.kind === 'via') viasByNet.set(p.net, [...(viasByNet.get(p.net) ?? []), p]);
  }
  for (const ni of netOrder) {
    const net = doc.nets[ni]!;
    eda.push(`NET ${odbName(net.name)}`);
    let sub = 0;
    for (const p of padsByNet.get(ni) ?? []) {
      const t = toeprint.get(p);
      eda.push(t ? `SNT TOP ${t.side} ${t.comp} ${t.pin}` : 'SNT PLN S 0 0', ...(byPrim.get(p) ?? []));
      subnet.set(p, { net: netNum.get(ni)!, sub: sub++ });
    }
    for (const v of viasByNet.get(ni) ?? []) { eda.push('SNT VIA', ...(byPrim.get(v) ?? [])); sub++; }
    const trc = trcByNet.get(ni);
    if (trc?.length) { eda.push('SNT TRC', ...trc); sub++; }
  }
  eda.push('#', ...pkgLines, '');
  put('steps/pcb/eda/data', eda.join('\n'));

  for (const c of pendingTop) {
    compLines[c.side].push(c.line);
    c.pads.forEach((p, i) => {
      const comp = doc.components[p.component]!;
      const s = subnet.get(p);
      const rot = ((-p.rotation % 360) + 360) % 360;
      compLines[c.side].push(`TOP ${i} ${f6(p.at.x - origin.x)} ${f6(p.at.y - origin.y)} ${+rot.toFixed(3)} ${comp.layer === L.BOTTOM ? 'M' : 'N'} ${s?.net ?? -1} ${s?.sub ?? -1} ${p.name || String(i + 1)}`);
    });
    compLines[c.side].push('#');
  }
  if (hasTop) put('steps/pcb/layers/comp_+_top/components', ['UNITS=MM', '#', ...compLines.top, ''].join('\n'));
  if (hasBot) put('steps/pcb/layers/comp_+_bot/components', ['UNITS=MM', '#', ...compLines.bot, ''].join('\n'));
  return files;
}

/** The job packed as <job>.tgz. */
export async function odbArchive(doc: PcbDocument, o: OdbOptions = {}): Promise<{ name: string; bytes: Uint8Array; files: string[] }> {
  const files = odbFiles(doc, o);
  const enc = new TextEncoder();
  const bytes = await gzip(tar(files.map((f) => ({ name: f.name, bytes: enc.encode(f.text) })), o.when));
  return { name: `${odbName(doc.name.replace(/\.pcbdoc$/i, ''))}.tgz`, bytes, files: files.map((f) => f.name) };
}

