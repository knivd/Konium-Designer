/**
 * File › Assembly Outputs › Generates pick and place files: Altium's "Pick Place for <board>"
 * report, CSV or text, in mil or mm, columns chosen in the setup. Centre is the middle of the
 * component's pads; Ref is its reference point; Pad is pad 1.
 */
import { locale } from '../../core/locale';
import type { PcbDocument } from '../../model/pcb';
import { L } from '../../model/layers';
import type { OutputFile } from './gerber';

export const PNP_COLUMNS = ['Designator', 'Comment', 'Layer', 'Footprint', 'Center-X', 'Center-Y', 'Rotation', 'Description', 'Ref-X', 'Ref-Y', 'Pad-X', 'Pad-Y'] as const;
export type PnpColumn = (typeof PNP_COLUMNS)[number];

export interface PnpSetup { format: 'csv' | 'txt'; units: 'mil' | 'mm'; columns: PnpColumn[]; relative: boolean }
export const defaultPnpSetup = (): PnpSetup => ({ format: 'csv', units: 'mm', relative: true,
  columns: ['Designator', 'Comment', 'Layer', 'Footprint', 'Center-X', 'Center-Y', 'Rotation', 'Description'] });

/** `variant`: its name for the header and the designators it leaves unfitted (left out). */
export function pnpFile(doc: PcbDocument, s: PnpSetup, project = '', when = new Date(), variant?: { name: string; notFitted: Set<string> }): OutputFile {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const o = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const fmt = (c: number) => (s.units === 'mm' ? ((c * 25.4) / 10_000_000).toFixed(4) : (c / 10_000).toFixed(2));
  const unit = s.units === 'mm' ? '(mm)' : '(mil)';
  const head = (c: PnpColumn) => (/-[XY]$/.test(c) ? `${c}${unit}` : c);
  const rows = doc.components.filter((c) => !variant?.notFitted.has(c.designator)).map((c) => {
    const pads = doc.prims.filter((p) => p.kind === 'pad' && p.component === c.index) as { at: { x: number; y: number }; name: string }[];
    const xs = pads.map((p) => p.at.x), ys = pads.map((p) => p.at.y);
    const centre = pads.length ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 } : c.at;
    const pad1 = pads.find((p) => p.name === '1') ?? pads[0];
    const comment = (doc.prims.find((p) => p.kind === 'text' && p.component === c.index && p.isComment) as { text?: string } | undefined)?.text ?? '';
    const v: Record<PnpColumn, string> = {
      Designator: c.designator, Comment: comment, Layer: c.layer === L.BOTTOM ? 'BottomLayer' : 'TopLayer', Footprint: c.pattern,
      'Center-X': fmt(centre.x - o.x), 'Center-Y': fmt(centre.y - o.y), Rotation: String(+c.rotation.toFixed(2)),
      Description: c.bag.get('SOURCEDESCRIPTION') ?? '', 'Ref-X': fmt(c.at.x - o.x), 'Ref-Y': fmt(c.at.y - o.y),
      'Pad-X': fmt((pad1?.at.x ?? c.at.x) - o.x), 'Pad-Y': fmt((pad1?.at.y ?? c.at.y) - o.y),
    };
    return s.columns.map((k) => v[k]);
  }).sort((a, b) => a[0]!.localeCompare(b[0]!, 'en', { numeric: true }));
  const d = when;
  const pre = ['Pick and Place Locations', project || doc.name, '', '='.repeat(120), 'File Design Information:', '',
    `Date:       ${d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit' })}`,
    `Time:       ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`,
    'Revision:   Not in VersionControl', `Variant:    ${variant?.name || 'No variations'}`, `Units used: ${s.units}`, ''];
  const body = s.format === 'csv'
    ? [s.columns.map((c) => `"${head(c)}"`).join(','), ...rows.map((r) => r.map((x) => `"${x.replace(/"/g, '""')}"`).join(','))]
    : (() => {
      const all = [s.columns.map(head), ...rows];
      const w = s.columns.map((_, i) => all.reduce((m, r) => Math.max(m, r[i]!.length), 0) + 2);
      return all.map((r) => r.map((x, i) => x.padEnd(w[i]!)).join('').trimEnd());
    })();
  return { name: `Pick Place for ${base}.${s.format === 'csv' ? 'csv' : 'txt'}`, text: [...pre, ...body, ''].join('\r\n') };
}

export interface PnpPlace { x: number; y: number; centre: boolean; rot?: number; bottom?: boolean }

/**
 * Tools › Component Placement › Place From File reads a pick and place report back (Konium's or
 * Altium's, CSV or text): designator → position from the origin (Ref-X/Y when given, else
 * Center-X/Y, the middle of the pads), rotation and side. Plain numbers take the unit of the
 * column heading or of "Units used"; "12.5mm" or "500mil" carry their own.
 */
export function readPnp(text: string): Map<string, PnpPlace> {
  const lines = text.split(/\r?\n/);
  const out = new Map<string, PnpPlace>();
  const hi = lines.findIndex((l) => /designator/i.test(l) && /(center|ref|mid)-?\s*x/i.test(l));
  if (hi < 0) return out;
  const header = lines[hi]!;
  const csv = /^\s*"?designator"?\s*,/i.test(header) || header.split(',').length > 3;
  const csvCells = (l: string) => { const c: string[] = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]!; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { c.push(cur.trim()); cur = ''; } else cur += ch; } c.push(cur.trim()); return c; };
  // Text reports are fixed width: each column starts where its heading does
  const starts = csv ? [] : [...header.matchAll(/\S+/g)].map((m) => m.index!);
  const cells = (l: string) => (csv ? csvCells(l) : starts.map((s, i) => l.slice(s, starts[i + 1] ?? l.length).trim()));
  const head = cells(header).map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const unitsUsed = lines.slice(0, hi).find((l) => /units used/i.test(l)) ?? '';
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const unitOf = (i: number) => (/\(mm\)/.test(head[i] ?? '') ? 'mm' : /\(mil\)/.test(head[i] ?? '') ? 'mil' : /\bmm\b/i.test(unitsUsed) ? 'mm' : 'mil');
  const num = (s: string | undefined, unit: string): number | undefined => {
    const m = /^(-?[0-9]*\.?[0-9]+)\s*(mm|mil)?$/i.exec((s ?? '').trim());
    if (!m) return undefined;
    const v = Number(m[1]), u = (m[2] ?? unit).toLowerCase();
    return Math.round(u === 'mm' ? (v * 10_000_000) / 25.4 : v * 10_000);
  };
  const des = col('designator'), rx = col('ref-x', 'refx'), ry = col('ref-y', 'refy');
  const cx = col('center-x', 'centerx', 'mid-x', 'midx'), cy = col('center-y', 'centery', 'mid-y', 'midy');
  const rc = col('rotation'), lc = col('layer', 'tb');
  const useRef = rx >= 0 && ry >= 0;
  const xc = useRef ? rx : cx, yc = useRef ? ry : cy;
  if (des < 0 || xc < 0 || yc < 0) return out;
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim()) continue;
    const c = cells(l);
    const d = c[des], x = num(c[xc], unitOf(xc)), y = num(c[yc], unitOf(yc));
    if (!d || x === undefined || y === undefined) continue;
    const rot = rc >= 0 && c[rc] !== '' ? Number(c[rc]) : NaN;
    const side = lc >= 0 ? c[lc] ?? '' : '';
    out.set(d, { x, y, centre: !useRef, rot: Number.isFinite(rot) ? rot : undefined, bottom: side ? /^b/i.test(side) : undefined });
  }
  return out;
}
