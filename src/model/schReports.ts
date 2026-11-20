/**
 * Reports › Report Single Pin Nets and Component Cross Reference, and Tools › Convert › Round
 * Coordinates' rounding of one record.
 */
import { SCH_UNIT } from '../core/units';
import type { PropertyBag } from '../formats/altium/props';
import { compileProject, natural, type CompileOptions, type SheetInput } from './compile';

/* ─── Reports ────────────────────────────────────────────────────────────────────────── */

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

export function singlePinNetsReport(name: string, sheets: SheetInput[], opts: CompileOptions = {}): string {
  const r = compileProject(sheets, opts);
  const nets = r.nets.filter((n) => n.pins.length === 1);
  const lines = [`Single Pin Nets Report For Project ${name}`, '', `${pad('Net', 32)}Pin`, `${'-'.repeat(31)} ${'-'.repeat(20)}`];
  for (const n of nets) lines.push(`${pad(n.name, 32)}${n.pins[0]!.designator}-${n.pins[0]!.pin}`);
  lines.push('', `${nets.length} single pin net${nets.length === 1 ? '' : 's'}`);
  return lines.join('\r\n');
}

export function crossReferenceReport(name: string, sheets: SheetInput[], opts: CompileOptions = {}): string {
  const r = compileProject(sheets, opts);
  const lines = [`Component Cross Reference Report For Project ${name}`, ''];
  for (const s of sheets) {
    const comps = r.components.filter((c) => c.refs.some((x) => x.sheet === s.name)).sort((a, b) => natural(a.designator, b.designator));
    if (!comps.length) continue;
    lines.push(`Schematic Sheet: ${s.name}`, `${pad('Designator', 14)}${pad('Comment', 24)}${pad('Footprint', 24)}Library Reference`);
    for (const c of comps) lines.push(`${pad(c.designator, 14)}${pad(c.comment, 24)}${pad(c.footprint, 24)}${c.libRef}`);
    lines.push('');
  }
  lines.push(`${r.components.length} components`);
  return lines.join('\r\n');
}

/* ─── Convert ────────────────────────────────────────────────────────────────────────── */

/** Whole 10 mil units: every X_FRAC-style remainder rounded away (DISTANCEFROMTOP keeps its own). */
export function roundBag(src: PropertyBag): PropertyBag | null {
  const b = src.clone();
  let changed = false;
  for (const k of Object.keys(src.toObject())) {
    if (!/_FRAC$/.test(k)) continue;
    const base = k.slice(0, -5);
    const v = b.int(base) * SCH_UNIT + b.int(k);
    b.set(base, String(Math.round(v / SCH_UNIT)));
    if (b.get(base) === '0') b.delete(base);
    b.delete(k);
    changed = true;
  }
  return changed ? b : null;
}

