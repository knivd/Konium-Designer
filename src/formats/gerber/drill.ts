/**
 * File › Fabrication Outputs › NC Drill Files: Excellon, as Altium writes it (M48 header with
 * ;FILE_FORMAT and ;TYPE comments, one tool per hole size, T01… blocks, M30), optionally split
 * into plated and non-plated files, with the .DRR drill report. Slotted holes go to their own
 * file as G85 drilled slots, and blind / buried vias to a file per layer pair they span
 * [est: the file names of slots and of the other layer pairs].
 */
import { locale } from '../../core/locale';
import type { Vec2 } from '../../core/geom';
import type { PcbDocument } from '../../model/pcb';
import { layerName, type LayerId } from '../../model/layers';
import { PAD_STACK, get } from '../altium/pcbLayouts';
import type { OutputFile, Units } from './gerber';
import { offsetOutline } from '../../model/outlineOps';

export interface DrillSetup {
  units: Units;
  intDigits: number;
  decDigits: number;
  /** Which zeros are left out of coordinates. */
  zeros: 'leading' | 'trailing' | 'none';
  relative: boolean;
  separatePlated: boolean;
  /** Optimise change location commands (on, as AD): a coordinate the same as the last hit's is left out. */
  optimise?: boolean;
  /** Use drilled slot command (G85): off (AD's default), a slot is routed from end to end (G00, M15, G01, M16, G05) [est]. */
  g85?: boolean;
  /** Generate Board Edge Rout Paths: the board shape (and its cutouts) routed by a tool of `routTool`, its centre off the board [est: file name]. */
  edgeRout?: boolean;
  routTool?: number;
}

/** AD's Rout Tool Dia (2 mm [est]). */
export const ROUT_TOOL = 787_402;
export const defaultDrillSetup = (): DrillSetup => ({ units: 'in', intDigits: 2, decDigits: 5, zeros: 'leading', relative: true, separatePlated: false, optimise: true, g85: false, edgeRout: false, routTool: ROUT_TOOL });

interface Hole {
  at: Vec2; size: number; plated: boolean;
  /** A slot: the centres of its two ends. */
  slot?: { a: Vec2; b: Vec2 };
  /** The copper layers it is drilled between (a blind or buried via); the whole stack when absent. */
  span?: [LayerId, LayerId];
}

const UNITS_PER_INCH = 10_000_000;
const toUnit = (c: number, u: Units) => (u === 'in' ? c / UNITS_PER_INCH : (c * 25.4) / UNITS_PER_INCH);
const mil = (c: number) => `${+(c / 10_000).toFixed(3)}mil (${+((c * 25.4) / UNITS_PER_INCH).toFixed(4)}mm)`;

export function holes(doc: PcbDocument): Hole[] {
  const out: Hole[] = [];
  const stack = doc.board.copperStack, first = stack[0], last = stack.at(-1);
  for (const p of doc.prims) {
    if (p.kind === 'pad' && p.hole > 0) {
      // A slot (Pad dialog › Hole: Slot): its length end to end, turned with the pad [est: angle sense]
      const st = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[5];
      const len = st && st.length > PAD_STACK.slotRotation + 8 && st[PAD_STACK.holeShape] === 2 ? get(st, { off: PAD_STACK.slotLength, t: 'i32' }) ?? 0 : 0;
      if (len > p.hole) {
        const a = ((p.rotation + (get(st!, { off: PAD_STACK.slotRotation, t: 'f64' }) ?? 0)) * Math.PI) / 180, h = (len - p.hole) / 2;
        const d = { x: Math.round(Math.cos(a) * h), y: Math.round(Math.sin(a) * h) };
        out.push({ at: p.at, size: p.hole, plated: p.plated, slot: { a: { x: p.at.x - d.x, y: p.at.y - d.y }, b: { x: p.at.x + d.x, y: p.at.y + d.y } } });
      } else out.push({ at: p.at, size: p.hole, plated: p.plated });
    } else if (p.kind === 'via' && p.hole > 0) {
      const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const full = a < 0 || b < 0 || (stack[lo] === first && stack[hi] === last);
      out.push({ at: p.at, size: p.hole, plated: true, ...(full ? {} : { span: [stack[lo]!, stack[hi]!] as [LayerId, LayerId] }) });
    }
  }
  return out;
}

/** A coordinate in the file's units and format. */
function numOf(s: DrillSetup): (c: number) => string {
  return (c) => {
    const v = Math.round(toUnit(c, s.units) * 10 ** s.decDigits);
    const neg = v < 0, abs = String(Math.abs(v));
    let d = abs;
    if (s.zeros !== 'leading') d = abs.padStart(s.intDigits + s.decDigits, '0');
    if (s.zeros === 'trailing') d = d.replace(/0+$/, '') || '0';
    return (neg ? '-' : '') + d;
  };
}
/** M48 … % with a tool per size. */
function header(s: DrillSetup, type: string, sizes: number[]): string[] {
  const lines = ['M48', ';Layer_Color=9474304', `;FILE_FORMAT=${s.intDigits}:${s.decDigits}`,
    `${s.units === 'in' ? 'INCH' : 'METRIC'},${s.zeros === 'leading' ? 'TZ' : 'LZ'}`, `;TYPE=${type}`];
  sizes.forEach((size, i) => lines.push(`T${i + 1}F00S00C${toUnit(size, s.units).toFixed(s.units === 'in' ? 5 : 4)}`));
  lines.push('%');
  return lines;
}

function excellon(doc: PcbDocument, list: Hole[], s: DrillSetup, type: string): { text: string; tools: { size: number; count: number }[] } {
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const sizes = [...new Set(list.map((h) => h.size))].sort((a, b) => a - b);
  const num = numOf(s);
  const lines = header(s, type, sizes);
  const tools: { size: number; count: number }[] = [];
  const xy = (p: Vec2) => `X${num(p.x - origin.x)}Y${num(p.y - origin.y)}`;
  // Optimise change location commands: X or Y left out when it is the last hit's
  let last: [string, string] | null = null;
  const hit = (p: Vec2) => {
    const X = num(p.x - origin.x), Y = num(p.y - origin.y);
    const sx = last?.[0] === X, sy = last?.[1] === Y;
    last = [X, Y];
    return s.optimise === false || sx === sy ? `X${X}Y${Y}` : sx ? `Y${Y}` : `X${X}`;
  };
  sizes.forEach((size, i) => {
    const at = list.filter((h) => h.size === size).sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    lines.push(`T${String(i + 1).padStart(2, '0')}`);
    last = null;
    for (const h of at) {
      if (!h.slot) { lines.push(hit(h.at)); continue; }
      // A slot: drilled from one end to the other (G85), or routed
      if (s.g85) lines.push(`${xy(h.slot.a)}G85${xy(h.slot.b)}`);
      else lines.push(`G00${xy(h.slot.a)}`, 'M15', `G01${xy(h.slot.b)}`, 'M16', 'G05');
      last = null;
    }
    tools.push({ size, count: at.length });
  });
  lines.push('M30', '');
  return { text: lines.join('\r\n'), tools };
}

/**
 * Generate Board Edge Rout Paths: the board shape routed with the tool's centre outside it, each
 * board cutout from inside the cutout (one too small for the tool is left out) [est: AD's order].
 */
export function edgeRoutPaths(doc: PcbDocument, tool: number): { paths: Vec2[][]; skipped: number } {
  const r = tool / 2, paths: Vec2[][] = [];
  let skipped = 0;
  if (doc.board.outline.length > 2) { const o = offsetOutline(doc.board.outline, r)[0]; if (o) paths.push(o); }
  for (const p of doc.prims) {
    if (p.kind !== 'region' || !p.boardCutout || p.outline.length < 3) continue;
    const inner = offsetOutline(p.outline, -r);
    if (inner.length) paths.push(...inner); else skipped++;
  }
  return { paths, skipped };
}
function edgeRout(doc: PcbDocument, s: DrillSetup, tool: number, paths: Vec2[][]): string {
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const num = numOf(s), xy = (p: Vec2) => `X${num(p.x - origin.x)}Y${num(p.y - origin.y)}`;
  const lines = [...header(s, 'NON_PLATED', [tool]), 'T01'];
  for (const path of paths) {
    lines.push(`G00${xy(path[0]!)}`, 'M15');
    for (const p of [...path.slice(1), path[0]!]) lines.push(`G01${xy(p)}`);
    lines.push('M16', 'G05');
  }
  lines.push('M30', '');
  return lines.join('\r\n');
}

export function drillFiles(doc: PcbDocument, s: DrillSetup): OutputFile[] {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const all = holes(doc);
  const stack = doc.board.copperStack;
  const lname = (l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);
  // One group per layer pair (the whole stack first), round holes then slots
  const spans = new Map<string, { span: [LayerId, LayerId] | null; list: Hole[] }>();
  for (const h of all) {
    const k = h.span ? `${stack.indexOf(h.span[0]) + 1}-${stack.indexOf(h.span[1]) + 1}` : '';
    const g = spans.get(k) ?? { span: h.span ?? null, list: [] };
    g.list.push(h);
    spans.set(k, g);
  }
  const sets: [string, string, Hole[], string, boolean][] = [];
  for (const [k, g] of [...spans].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0) || a[0].localeCompare(b[0]))) {
    const pair = g.span ? `${lname(g.span[0])} to ${lname(g.span[1])}` : `${lname(stack[0]!)} to ${lname(stack.at(-1)!)}`;
    for (const slots of [false, true]) {
      const list = g.list.filter((h) => !!h.slot === slots);
      const stem = `${base}${k ? `-${k}` : ''}${slots ? '-SlotHoles' : ''}`;
      if (s.separatePlated) sets.push([`${stem}-Plated.TXT`, 'PLATED', list.filter((h) => h.plated), pair, slots], [`${stem}-NonPlated.TXT`, 'NON_PLATED', list.filter((h) => !h.plated), pair, slots]);
      else sets.push([`${stem}.TXT`, list.every((h) => h.plated) ? 'PLATED' : 'MIXED', list, pair, slots]);
    }
  }
  const files: OutputFile[] = [];
  const rule = '-'.repeat(99);
  const rep = [rule, `NCDrill File Report For: ${doc.name}    ${new Date().toLocaleString(locale())}`, rule];
  let total = 0;
  for (const [name, type, list, pair, slots] of sets) {
    if (!list.length) continue;
    const { text, tools } = excellon(doc, list, s, type);
    files.push({ name, text });
    rep.push(`Layer Pair : ${pair}`, `ASCII ${slots ? 'SlotHoles' : 'RoundHoles'} File : ${name}`, '',
      'Tool     Hole Size                Hole Tolerance    Hole Type    Hole Count    Plated', rule);
    tools.forEach((t, i) => rep.push(`T${String(i + 1).padEnd(8)}${mil(t.size).padEnd(25)}${''.padEnd(18)}${(slots ? 'Slot' : 'Round').padEnd(13)}${String(t.count).padEnd(14)}${type === 'NON_PLATED' ? 'NPTH' : type === 'PLATED' ? 'PTH' : ''}`));
    const n = tools.reduce((a, t) => a + t.count, 0);
    total += n;
    rep.push(rule, `Totals${' '.repeat(50)}${n}`, '');
  }
  if (s.edgeRout) {
    const tool = s.routTool ?? ROUT_TOOL, { paths, skipped } = edgeRoutPaths(doc, tool);
    if (paths.length) {
      const name = `${base}-RoutPath.TXT`;
      files.push({ name, text: edgeRout(doc, s, tool, paths) });
      rep.push(`Board Edge Rout Paths`, `ASCII Rout File : ${name}`, `Tool T1 ${mil(tool)}, ${paths.length} path${paths.length === 1 ? '' : 's'}${skipped ? `, ${skipped} cutout${skipped === 1 ? '' : 's'} narrower than the tool left out` : ''}`, rule, '');
    }
  }
  rep.push(rule, `Total Processing Time (hh:mm:ss) : 00:00:00`, `Total holes : ${total}`, rule, '');
  files.push({ name: `${base}.DRR`, text: rep.join('\r\n') });
  return files;
}
