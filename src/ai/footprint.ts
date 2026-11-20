/**
 * Component Builder: a footprint from a package's drawing as read (jobs.ts's PackageRead) —
 * the datasheet's own land pattern when it draws one, or the pads worked out from the package's
 * dimensions (IPC-7351B for surface mount, IPC-7251 for DIP [est: hole and pad sizes]) — with
 * the courtyard, silkscreen, assembly outline, 3D body and pin-1 mark as the IPC wizard draws
 * them, and the checks a designer should see before trusting it (pin count, pitch, overlapping
 * pads, values that look unconverted, dimensions the drawing didn't give).
 */
import type { LandPad, MmRange, PackageFamily, PackageRead, Variant } from './jobs';
import { ipcDefaults, ipcFootprint, ipcRecords, outlineFor, type Box, type Density, type IpcFamily, type IpcFootprint, type IpcPad, type IpcSpec, type Range } from '../model/ipcFootprint';
import type { PcbRawRecord } from '../formats/altium/framing';

/** Where the pads come from: the datasheet's land pattern, or worked out from the package's dimensions. */
export type PadSource = 'datasheet' | 'calc';
export interface Check { level: 'error' | 'warning' | 'note'; text: string }
export interface Built { fp: IpcFootprint; records: PcbRawRecord[]; checks: Check[]; spec?: IpcSpec }

const IPC: IpcFamily[] = ['CHIP', 'MOLDED', 'MELF', 'SOD', 'SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'SON', 'QFN', 'QFP', 'PLCC', 'BGA'];
const TWO_ROWS: PackageFamily[] = ['SOT23', 'SOIC', 'SOP', 'SOJ', 'SON', 'DIP'];
const QUAD: PackageFamily[] = ['QFP', 'QFN', 'PLCC'];
const LEADED: PackageFamily[] = ['SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'QFP', 'PLCC'];

const isIpc = (f: PackageFamily): f is IpcFamily => (IPC as string[]).includes(f);
const mid = (r: MmRange) => (r.min + r.max) / 2;
const f2 = (v: number) => +v.toFixed(2);

/** Can the pads be worked out from the dimensions read (and if not, what's missing)? */
export function calcMissing(r: PackageRead): string[] {
  const miss: string[] = [];
  if (r.family === 'OTHER') return ['a package family the pads can be worked out for'];
  if (r.family === 'BGA') {
    if (!r.pitch) miss.push('pitch');
    if (!r.ball) miss.push('ball diameter');
    if (!r.rows || !r.cols) miss.push('rows and columns');
    return miss;
  }
  if (r.family === 'DIP') {
    if (!r.pitch) miss.push('pitch');
    if (!r.pins) miss.push('pins');
    if (!r.span) miss.push('row spacing');
    return miss;
  }
  const twoTerm = ['CHIP', 'MOLDED', 'MELF', 'SOD'].includes(r.family);
  if (!twoTerm && !r.pitch) miss.push('pitch');
  if (!twoTerm && !r.pins) miss.push('pins');
  if (!r.span && !(['SON', 'QFN', 'CHIP'].includes(r.family) && (r.bodyE || r.bodyD))) miss.push('lead span');
  if (!r.term) miss.push('foot length');
  if (!r.leadW && !(r.family === 'CHIP' && r.bodyE)) miss.push('lead width');
  return miss;
}

/** The IPC-7351B spec of a package read (the family's typical values where the drawing gave none, listed in `assumed`). */
export function specOf(r: PackageRead, density: Density = 'N'): { spec: IpcSpec; assumed: string[] } {
  const fam: IpcFamily = isIpc(r.family) ? r.family : 'SOIC';
  const s = ipcDefaults(fam);
  const assumed: string[] = [];
  const take = (v: MmRange | null, d: Range, what: string): Range => { if (v) return { min: v.min, max: v.max }; assumed.push(what); return d; };
  s.density = density;
  if (r.pins) s.pins = r.pins; else if (!['CHIP', 'MOLDED', 'MELF', 'SOD', 'BGA'].includes(fam)) assumed.push('pins');
  if (r.pitch) s.pitch = r.pitch; else if (!['CHIP', 'MOLDED', 'MELF', 'SOD'].includes(fam)) assumed.push('pitch');
  const noLead = fam === 'SON' || fam === 'QFN';
  // A chip's terminals span its length and are as wide as it; a no-lead package's span is its body
  const span = r.span ?? (noLead ? r.bodyE : fam === 'CHIP' ? r.bodyD : null);
  s.bodyD = take(r.bodyD, s.bodyD, 'body length');
  s.bodyE = take(r.bodyE, s.bodyE, 'body width');
  s.span = take(span, s.span, 'lead span');
  if (QUAD.includes(fam)) s.span2 = r.span2 ? { ...r.span2 } : noLead && r.bodyD ? { ...r.bodyD } : { ...s.span };
  s.term = take(r.term, s.term, 'foot length');
  s.leadW = take(r.leadW ?? (fam === 'CHIP' ? r.bodyE : null), s.leadW, 'lead width');
  if (r.height) s.height = f2(r.height.max); else assumed.push('height');
  if (QUAD.includes(fam)) s.pinsSide = r.pinsSide || Math.round(s.pins / 4);
  // Exposed pad: a QFN's runs D2 across x (D along x), a SON's E2 across x (rows along y)
  if (r.tab) {
    if (fam === 'QFN') { s.tabW = f2(mid(r.tab.l)); s.tabL = f2(mid(r.tab.w)); } else { s.tabW = f2(mid(r.tab.w)); s.tabL = f2(mid(r.tab.l)); }
  } else if (fam === 'SON' || fam === 'QFN') { s.tabW = 0; s.tabL = 0; }
  else if (fam === 'SOT223' || fam === 'DPAK') assumed.push('tab size');
  if (fam === 'BGA') {
    if (r.ball) s.ball = f2(mid(r.ball)); else assumed.push('ball diameter');
    if (r.rows && r.cols) { s.rows = r.rows; s.cols = r.cols; s.pins = r.pins && r.pins < r.rows * r.cols ? r.pins : r.rows * r.cols; } else assumed.push('rows and columns');
  }
  return { spec: s, assumed };
}

/** A DIP's pads by IPC-7251 [est: Level B hole = lead + 0.3 mm, pad = hole + 0.7 mm]: pin 1 square, down the left, back up the right. */
function dipPads(r: PackageRead): IpcPad[] {
  const pins = Math.max(2, r.pins), per = Math.ceil(pins / 2), pitch = r.pitch ?? 2.54;
  const row = r.span ? mid(r.span) : 7.62, lead = r.leadW?.max ?? 0.56;
  const hole = Math.ceil((lead + 0.3) / 0.05 - 1e-9) * 0.05, pad = f2(hole + 0.7);
  const pads: IpcPad[] = [];
  for (let i = 0; i < pins; i++) {
    const left = i < per, k = left ? i : pins - 1 - i;
    pads.push({ name: String(i + 1), x: f2((left ? -1 : 1) * row / 2), y: f2(((per - 1) / 2 - k) * pitch), w: pad, h: pad, shape: i === 0 ? 'rect' : 'round', hole: f2(hole), plated: true });
  }
  return pads;
}

/** Distinct values (to 0.01 mm). */
const distinct = (v: number[]) => new Set(v.map((x) => Math.round(x * 100))).size;

/** The datasheet's pads, centred on their middle (the outline moved with them). */
function centred(r: PackageRead): { pads: IpcPad[]; outline: Box | null } {
  const land = r.land;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of land) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pads = land.map((p): IpcPad => ({
    name: p.name, x: +(p.x - cx).toFixed(4), y: +(p.y - cy).toFixed(4), w: p.w, h: p.h, shape: p.shape,
    ...(p.hole > 0 ? { hole: p.hole, plated: p.plated, ...(p.slot > p.hole ? { slot: p.slot } : {}) } : {}),
  }));
  const o = r.outline;
  return { pads, outline: o ? { w: o.w, h: o.h, x: +(o.x - cx).toFixed(4), y: +(o.y - cy).toFixed(4) } : null };
}

/** The body's outline for pads from the datasheet: the outline drawn with them, else the body across the rows of pads, else round the pads. */
function bodyFor(r: PackageRead, pads: IpcPad[], outline: Box | null): Box {
  if (outline) return outline;
  const D = r.bodyD?.max, E = r.bodyE?.max;
  if (D && E && r.family !== 'OTHER') {
    const named = pads.filter((p) => p.name);
    // Two rows of pads one above the other (few distinct y): the body's length runs along x
    if (TWO_ROWS.includes(r.family) && distinct(named.map((p) => p.y)) <= 3 && distinct(named.map((p) => p.x)) > 3) return { w: D, h: E };
    if (TWO_ROWS.includes(r.family)) return { w: E, h: D };
    return { w: D, h: E };
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pads) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  const m = 0.45;
  return { w: f2(x1 - x0 + 2 * m), h: f2(y1 - y0 + 2 * m), x: f2((x0 + x1) / 2), y: f2((y0 + y1) / 2) };
}

const COURTYARD: Record<Density, number> = { M: 0.5, N: 0.25, L: 0.1 };

/** The footprint from a package read: its pads from `source`, the rest drawn round them. */
export function buildFootprint(r: PackageRead, o: { source: PadSource; density?: Density; name: string; description?: string }, padTemplate?: PcbRawRecord): Built {
  const density = o.density ?? 'N';
  const checks: Check[] = [];
  let fp: IpcFootprint, spec: IpcSpec | undefined;
  if (o.source === 'datasheet' && r.land.length) {
    const { pads, outline } = centred(r);
    const body = bodyFor(r, pads, outline);
    const height = r.height?.max ?? 1;
    if (!r.height) checks.push({ level: 'note', text: 'Height not read: the 3D body is 1 mm high' });
    if (!outline && r.family === 'OTHER') checks.push({ level: 'note', text: 'No outline drawn with the land pattern: the silkscreen goes round the pads' });
    const { courtyard, silk, pin1 } = outlineFor(pads, body, COURTYARD[density], 0.15);
    fp = { name: o.name, description: o.description ?? '', pads, body, courtyard, silk, pin1, height: f2(height) };
  } else if (r.family === 'DIP') {
    const pads = dipPads(r);
    const body: Box = { w: r.bodyE?.max ?? (r.span ? mid(r.span) - 1.3 : 6.35), h: r.bodyD?.max ?? f2((Math.ceil(r.pins / 2)) * (r.pitch ?? 2.54)) };
    const { courtyard, silk, pin1 } = outlineFor(pads, body, COURTYARD[density], 0.15);
    fp = { name: o.name, description: o.description ?? '', pads, body, courtyard, silk, pin1, height: f2(r.height?.max ?? 5.33) };
    checks.push({ level: 'note', text: `Through-hole pads by IPC-7251 [est]: ${pads[0]!.hole} mm holes, ${pads[0]!.w} mm pads` });
  } else {
    const s = specOf(r, density);
    spec = s.spec;
    if (s.assumed.length) checks.push({ level: 'warning', text: `Not read from the drawing, the family's typical value used: ${s.assumed.join(', ')}` });
    const ipc = ipcFootprint(spec);
    fp = { ...ipc, name: o.name || ipc.name, description: o.description ?? ipc.description };
    if (ipc.land && ipc.land.G <= 0 && ['SOIC', 'SOP', 'SOJ', 'SON', 'SOT23', 'QFP', 'QFN', 'PLCC'].includes(spec.family)) checks.push({ level: 'error', text: 'The rows of pads meet in the middle: check the lead span and foot length' });
  }
  checks.push(...checkRead(r, fp.pads));
  const records = ipcRecords(fp, spec ?? { silk: 0.15, courtyardLine: 0.05 }, padTemplate);
  return { fp, records, checks, ...(spec ? { spec } : {}) };
}

/** What a designer should look at in a package read and the pads made from it. */
export function checkRead(r: PackageRead, pads: IpcPad[]): Check[] {
  const out: Check[] = [];
  if (r.standard) out.push({ level: 'warning', text: 'The datasheet has no drawing of this package: the dimensions are the standard package\'s — check them against the maker\'s drawing' });
  const names = pads.map((p) => p.name).filter(Boolean);
  // A name on several pads is a shield's or a mounting tab's: not a pin of its own
  const shared = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  // So is a shield's or mounting hole's own name (SH1, MH2, SHIELD …) when the pins don't count it
  const shield = (n: string) => /^(SH|SHIELD|SHELL|MH|MTG|MOUNT|EH)\d*$/i.test(n);
  const all = new Set(names.filter((n) => !shared.has(n)));
  const unique = r.pins && all.size !== r.pins ? new Set([...all].filter((n) => !shield(n))) : all;
  if (r.pins && unique.size && unique.size !== r.pins) {
    // One more than the pins, the extra the biggest pad, in the middle: the exposed pad
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pads) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const big = pads.reduce<IpcPad | null>((m, p) => (!m || p.w * p.h > m.w * m.h ? p : m), null);
    const extra = unique.size === r.pins + 1 && !!big?.name && pads.filter((p) => p.w * p.h >= big.w * big.h * 0.5).length === 1
      && Math.abs(big.x - (x0 + x1) / 2) <= 0.15 * (x1 - x0 + 1e-6) && Math.abs(big.y - (y0 + y1) / 2) <= 0.15 * (y1 - y0 + 1e-6);
    out.push(extra ? { level: 'note', text: `${unique.size} pads: ${r.pins} pins and the exposed pad` } : { level: 'warning', text: `${unique.size} numbered pads for ${r.pins} pins` });
  }
  if (shared.size) out.push({ level: 'note', text: `Pads sharing a name: ${[...shared].slice(0, 6).join(', ')} (shield or mounting pads)` });
  if (unique.size < all.size) out.push({ level: 'note', text: `${[...all].filter((n) => !unique.has(n)).slice(0, 6).join(', ')}: shield or mounting pads, not counted as pins` });
  // Copper of different pins overlapping
  const over: string[] = [];
  for (let i = 0; i < pads.length && over.length < 4; i++) for (let j = i + 1; j < pads.length && over.length < 4; j++) {
    const a = pads[i]!, b = pads[j]!;
    if (a.name && a.name === b.name) continue;
    if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-3 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-3) over.push(`${a.name || 'hole'} and ${b.name || 'hole'}`);
  }
  if (over.length) out.push({ level: 'error', text: `Pads overlap: ${over.join('; ')}` });
  if (r.pitch !== null && r.pitch < 0.25) out.push({ level: 'warning', text: `Pitch ${r.pitch} mm: inches left unconverted?` });
  if (r.pitch && r.land.length) {
    const step = rowPitch(r.land);
    if (step && Math.abs(step - r.pitch) > 0.02) out.push({ level: 'warning', text: `The land pattern's pads are ${f2(step)} mm apart, the drawing's pitch is ${r.pitch} mm` });
  }
  if (LEADED.includes(r.family) && r.span && r.bodyE && r.span.max < r.bodyE.min) out.push({ level: 'warning', text: 'The lead span is less than the body width: body and span read the wrong way round?' });
  if (r.term && r.span && r.term.max * 2 >= r.span.min) out.push({ level: 'warning', text: 'The feet are longer than half the span: check the foot length' });
  let ext = 0;
  for (const p of pads) ext = Math.max(ext, Math.abs(p.x) + p.w / 2, Math.abs(p.y) + p.h / 2);
  if (ext > 150) out.push({ level: 'error', text: `Pads ${Math.round(ext)} mm from the middle: units read wrongly?` });
  if (r.notes) out.push({ level: 'note', text: r.notes });
  return out;
}

/** The commonest spacing between neighbouring named pads in a line (the land pattern's pitch). */
function rowPitch(land: LandPad[]): number | null {
  const counts = new Map<number, number>();
  const named = land.filter((p) => p.name);
  for (const a of named) {
    let best = Infinity;
    for (const b of named) {
      if (a === b) continue;
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx < 0.01 || dy < 0.01) best = Math.min(best, dx + dy);
    }
    if (best < Infinity && best > 0) { const k = Math.round(best * 100); counts.set(k, (counts.get(k) ?? 0) + 1); }
  }
  let top = 0, n = 0;
  for (const [k, c] of counts) if (c > n) { n = c; top = k; }
  return n >= 2 ? top / 100 : null;
}

/** The land pattern turned over left to right (a drawing read as seen from below). */
export function mirrorLand(r: PackageRead): PackageRead {
  return { ...r, land: r.land.map((p) => ({ ...p, x: -p.x })), outline: r.outline ? { ...r.outline, x: -r.outline.x } : null };
}

/** The land pattern turned a quarter anticlockwise. */
export function rotateLand(r: PackageRead): PackageRead {
  return { ...r, land: r.land.map((p) => ({ ...p, x: -p.y, y: p.x, w: p.h, h: p.w })), outline: r.outline ? { x: -r.outline.y, y: r.outline.x, w: r.outline.h, h: r.outline.w } : null };
}

/** A footprint name from a package name: letters, digits and - _ . only. */
export function footprintName(v: Pick<Variant, 'package'>, r: PackageRead): string {
  const n = v.package.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return n || `${r.family}${r.pins || ''}`;
}
