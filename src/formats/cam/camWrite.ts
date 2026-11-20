/**
 * File › Export › Gerber and Save Drill from the CAM editor: each layer written again — as it
 * came when nothing was changed, else regenerated from its objects: RS-274X in millimetres
 * (format 4.6, leading zeros left out) with its X2 file attributes, aperture macros and apertures
 * as the file defined them (or as the editor added them), polarity, regions, and step-and-repeat
 * blocks (%SR%) for the blocks the layer keeps; Excellon in millimetres with its tools, hits, G85
 * slots, G84 canned circles, M97 / M98 drilled text and routed paths (G00, M15, G01 / G02 / G03,
 * M16; G32 / G33 circles; G41 / G42 cutter compensation).
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM, type DrillLayer, type DrillRoute, type GerberLayer, type GerberObject } from '../gerber/gerberRead';
import type { CamLayer } from './camDoc';
import { objectOrder } from './camModel';

/** An aperture's definition in millimetres (the file's own when it was millimetres already). */
function apertureDef(g: GerberLayer, code: number): string {
  const a = g.apertures.get(code)!;
  if (g.units === 'mm') return a.def;
  const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(a.def);
  if (!m) return a.def;
  // Standard apertures in inches → mm; a macro's parameters are its own units (kept, with the macro in inches: written MOIN-free by scaling)
  if (a.shape === 'M') return a.def;
  const args = (m[3] ?? '').split('X').filter((s) => s !== '').map(Number);
  const conv = a.shape === 'P' ? args.map((v, i) => (i === 0 || i === 3 ? v * 25.4 : v)) : args.map((v) => v * 25.4);
  return `ADD${m[1]}${m[2]},${conv.map((v) => +v.toFixed(6)).join('X')}`;
}

/** Whether the layer is written from its objects rather than as its file came. */
export const regenerated = (l: CamLayer): boolean => !!l.edited || !!l.erased?.length;

/**
 * A Gerber layer as RS-274X text (the objects not erased), and the order a reader gets them back in
 * (object indices; a step-and-repeat block's repeats name the object they repeat).
 */
export function writeGerberOrdered(l: CamLayer): { text: string; order: number[] } {
  const g = l.data as GerberLayer;
  const erased = new Set(l.erased ?? []);
  const out: string[] = ['G04 Written by Konium Designer\'s CAM editor*'];
  const order: number[] = [];
  for (const [k, v] of Object.entries(g.attributes)) out.push(`%TF${k},${v}*%`);
  // A macro in inches keeps inches: the whole file then is in inches with the same 4.6 format
  const inches = g.units === 'in' && [...g.apertures.values()].some((a) => a.shape === 'M');
  const scale = inches ? 25.4 : 1;
  const c6 = (c: number) => Math.round((c / UNITS_PER_MM / scale) * 1e6);
  const at = (p: Vec2) => `X${c6(p.x)}Y${c6(p.y)}`;
  out.push(`%FSLAX46Y46*%`, `%MO${inches ? 'IN' : 'MM'}*%`);
  if (g.negative) out.push('%IPNEG*%');
  for (const [name, body] of g.macros) out.push(`%AM${name}*\n${body.join('*\n')}*%`);
  for (const code of [...g.apertures.keys()].sort((a, b) => a - b)) out.push(`%${inches ? g.apertures.get(code)!.def : apertureDef(g, code)}*%`);
  out.push('G01*', 'G75*');
  let dark = true, ap = -1;
  const pol = (d: boolean) => { if (d !== dark) { out.push(d ? '%LPD*%' : '%LPC*%'); dark = d; } };
  const use = (code: number) => { if (code !== ap) { out.push(`D${code}*`); ap = code; } };
  const emit = (o: GerberObject) => {
    pol(o.dark);
    if (o.kind === 'draw') { use(o.ap); out.push(`${at(o.a)}D02*`, `${at(o.b)}D01*`); }
    else if (o.kind === 'arc') { use(o.ap); out.push(`${at(o.a)}D02*`, `${o.cw ? 'G02' : 'G03'}${at(o.b)}I${c6(o.c.x - o.a.x)}J${c6(o.c.y - o.a.y)}D01*`, 'G01*'); }
    else if (o.kind === 'flash') {
      use(o.ap);
      const tr = [o.mirror ? `%LM${o.mirror}*%` : '', o.rot ? `%LR${o.rot}*%` : '', o.scale && o.scale !== 1 ? `%LS${o.scale}*%` : ''].filter(Boolean);
      out.push(...tr, `${at(o.at)}D03*`);
      if (tr.length) out.push(...(o.mirror ? ['%LMN*%'] : []), ...(o.rot ? ['%LR0*%'] : []), ...(o.scale && o.scale !== 1 ? ['%LS1*%'] : []));
    } else {
      out.push('G36*');
      for (const c of o.contours) { out.push(`${at(c[0]!)}D02*`); for (const p of c.slice(1)) out.push(`${at(p)}D01*`); out.push(`${at(c[0]!)}D01*`); }
      out.push('G37*');
    }
  };
  const steps = new Map((g.steps ?? []).map((s) => [s.id, s]));
  const written = new Set<number>();
  for (const i of objectOrder(l)) {
    const o = g.objects[i]!;
    if (erased.has(i) || o.srCopy || written.has(i)) continue;
    const st = o.sr ? steps.get(o.sr) : undefined;
    if (!st) { emit(o); order.push(i); continue; }
    // The block: its objects (the first copy) once, inside %SR%; the reader repeats them
    const base = g.objects.map((x, k) => [x, k] as const).filter(([x, k]) => x.sr === st.id && !x.srCopy && !erased.has(k));
    const mm = (c: number) => +(c / UNITS_PER_MM / scale).toFixed(6);
    out.push(`%SRX${st.nx}Y${st.ny}I${mm(st.dx)}J${mm(st.dy)}*%`);
    for (const [x, k] of base) { emit(x); written.add(k); order.push(k); }
    out.push('%SRX1Y1I0J0*%');
    for (let a = 0; a < st.nx; a++) for (let b = 0; b < st.ny; b++) if (a || b) for (const [, k] of base) order.push(k);
  }
  out.push('M02*');
  return { text: `${out.join('\n')}\n`, order };
}

/** A Gerber layer as RS-274X text: its file as it came when unchanged. */
export function writeGerberLayer(l: CamLayer): string { return regenerated(l) ? writeGerberOrdered(l).text : l.text; }

/** Excellon numbers: millimetres with a point. */
const c3 = (c: number) => (c / UNITS_PER_MM).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');

/** A routed path's moves: G01 lines and G02 / G03 arcs (by radius; arcs past a half turn split in two). */
function routeMoves(r: DrillRoute): string[] {
  const xy = (p: Vec2) => `X${c3(p.x)}Y${c3(p.y)}`;
  const arcAt = new Map((r.arcs ?? []).map((a) => [a.i, a]));
  const out: string[] = [];
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1]!, b = r.path[i]!, arc = arcAt.get(i - 1);
    if (!arc) { out.push(`G01${xy(b)}`); continue; }
    const rad = Math.hypot(a.x - arc.c.x, a.y - arc.c.y);
    let s = Math.atan2(a.y - arc.c.y, a.x - arc.c.x), e = Math.atan2(b.y - arc.c.y, b.x - arc.c.x);
    if (arc.cw) { while (e >= s) e -= 2 * Math.PI; } else { while (e <= s) e += 2 * Math.PI; }
    const g = arc.cw ? 'G02' : 'G03';
    if (Math.abs(e - s) > Math.PI + 1e-9) {
      const m = (s + e) / 2, mid = { x: arc.c.x + rad * Math.cos(m), y: arc.c.y + rad * Math.sin(m) };
      out.push(`${g}${xy(mid)}A${c3(rad)}`);
    }
    out.push(`${g}${xy(b)}A${c3(rad)}`);
  }
  return out;
}

/** A drill layer as Excellon text (the hits not erased), and the order a reader gets the hits back in. */
export function writeDrillOrdered(l: CamLayer): { text: string; order: number[] } {
  const d = l.data as DrillLayer;
  const erased = new Set(l.erased ?? []);
  const order: number[] = [];
  const out = ['M48', ';Written by Konium Designer\'s CAM editor', ...(d.plated === false ? [';TYPE=NON_PLATED'] : d.plated ? [';TYPE=PLATED'] : []), 'METRIC,LZ,000.000'];
  const tools = [...d.tools.keys()].sort((a, b) => a - b);
  for (const t of tools) out.push(`T${String(t).padStart(2, '0')}C${c3(d.tools.get(t)!)}`);
  out.push('%', 'G90', 'G05');
  const xy = (p: Vec2) => `X${c3(p.x)}Y${c3(p.y)}`;
  // Drilled text: written once as M97 / M98 (its hits are the reader's to make again)
  const textGroups = new Map<number, { text: string; at: Vec2; vertical?: boolean }>();
  for (const [k, g] of l.groups ?? []) if (g.kind === 'drilltext') textGroups.set(k, g);
  for (const t of tools) {
    const hits = d.hits.map((h, i) => [h, i] as const).filter(([h, i]) => h.tool === t && !erased.has(i) && !(h.grp && textGroups.has(h.grp)));
    const routes = d.routes.filter((r) => r.tool === t && (r.path.length > 1 || r.circle));
    const texts = [...textGroups].filter(([k]) => d.hits.some((h, i) => h.grp === k && h.tool === t && !erased.has(i)));
    if (!hits.length && !routes.length && !texts.length) continue;
    out.push(`T${String(t).padStart(2, '0')}`);
    for (const [h, i] of hits) {
      out.push(h.slot ? `${xy(h.at)}G85${xy(h.slot)}` : h.circle ? `${xy(h.at)}G84X${c3(h.circle)}` : xy(h.at));
      order.push(i);
    }
    for (const [, g] of texts) out.push(`${xy(g.at)}M9${g.vertical ? 8 : 7},${g.text}`);
    for (const r of routes) {
      if (r.circle) { out.push(`G00${xy(r.circle.c)}`, `${r.circle.cw ? 'G32' : 'G33'}${xy(r.circle.c)}A${c3(r.circle.r)}`, 'G05'); continue; }
      // Rout mode (G00 to the start), cutter compensation, tool down (M15), the moves, tool up (M16), back to drilling (G05)
      out.push(`G00${xy(r.path[0]!)}`, ...(r.comp ? [r.comp === 'L' ? 'G41' : 'G42'] : []), 'M15', ...routeMoves(r), 'M16', ...(r.comp ? ['G40'] : []), 'G05');
    }
  }
  out.push('M30');
  return { text: `${out.join('\n')}\n`, order };
}

/** A drill layer as Excellon text: its file as it came when unchanged. */
export function writeDrillLayer(l: CamLayer): string { return regenerated(l) ? writeDrillOrdered(l).text : l.text; }

export const writeCamLayer = (l: CamLayer): string => (l.data.kind === 'gerber' ? writeGerberLayer(l) : writeDrillLayer(l));
