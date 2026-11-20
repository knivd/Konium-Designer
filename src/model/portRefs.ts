/**
 * Reports › Port Cross References: beside each port, where the other end of its connection is —
 * flat designs: the other sheets' ports of the same name; hierarchical: the sheet entries that
 * stand for the port. Each reference reads Sheet[Zone] (or the sheet number, or X,Y), as
 * Preferences › Schematic › Port Cross References say [est: the exact text Altium writes].
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import type { SchSheet, SchDocument } from './sch';
import { entryPoint, sheetHierarchy } from './schHierarchy';
import { docParam } from './schParams';

/** The reference zone a point falls in: column number from the left, row letter from the top. */
export function zoneOf(sh: SchSheet, p: Vec2): string {
  const m = sh.margin, nx = Math.max(1, sh.zonesX), ny = Math.max(1, sh.zonesY);
  const zw = (sh.width - 2 * m) / nx, zh = (sh.height - 2 * m) / ny;
  const col = Math.min(nx, Math.max(1, Math.floor((p.x - m) / zw) + 1));
  const row = Math.min(ny, Math.max(1, Math.floor((sh.height - m - p.y) / zh) + 1));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return sh.zoneStyle === 1 ? `${letters[ny - row] ?? ''}${nx - col + 1}` : `${col}${letters[row - 1] ?? ''}`;
}

export interface PortRefOptions { sheetStyle: 'name' | 'number'; location: 'zone' | 'xy' }

export function portReferences(sheets: { name: string; doc: SchDocument }[], opts: PortRefOptions): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  const label = (s: { name: string; doc: SchDocument }, p: Vec2) => {
    const sheet = opts.sheetStyle === 'number' ? docParam(s.doc, 'SheetNumber')?.value ?? s.name.replace(/\.schdoc$/i, '') : s.name.replace(/\.schdoc$/i, '');
    const where = opts.location === 'xy' ? `${Math.round(p.x / SCH_UNIT)},${Math.round(p.y / SCH_UNIT)}` : zoneOf(s.doc.sheet, p);
    return `${sheet}[${where}]`;
  };
  const anyEntries = sheets.some((s) => s.doc.objects.some((o) => o.kind === 'sheetentry'));
  const hierarchy = anyEntries ? sheetHierarchy(sheets) : null;
  for (const s of sheets) {
    const refs = new Map<number, string>();
    for (const o of s.doc.objects) {
      if (o.kind !== 'port' || !o.name) continue;
      const list: string[] = [];
      if (hierarchy) {
        for (const u of hierarchy.parents.get(s.name.toLowerCase()) ?? []) {
          const ps = sheets.find((x) => x.name === u.sheet);
          const e = ps?.doc.objects.find((x) => x.kind === 'sheetentry' && x.owner === u.index && x.name === o.name);
          const at = e && ps ? entryPoint(ps.doc, e) : null;
          if (ps && at) list.push(label(ps, at));
        }
      } else {
        for (const t of sheets) {
          if (t === s) continue;
          for (const q of t.doc.objects) if (q.kind === 'port' && q.name === o.name) list.push(label(t, q.at));
        }
      }
      if (list.length) refs.set(o.index, [...new Set(list)].join(', '));
    }
    out.set(s.name, refs);
  }
  return out;
}
