/**
 * Harnesses: a harness connector bundles named signals (its harness entries); signal harnesses
 * carry the bundle to other connectors, to ports and sheet entries (which take the bundle down
 * or up the hierarchy). Records live in the Additional stream (see readSchDoc).
 *
 * Geometry [est]: LOCATION is the top-left corner, the body hangs XSIZE × YSIZE from it; SIDE
 * says which side the harness leaves from (1 right, 0 left) at PRIMARYCONNECTIONPOSITION down
 * from the top, where a pointed nub sticks out 50 mil; entries sit on the other side,
 * DISTANCEFROMTOP in 100 mil steps (+ _FRAC1), as sheet entries do.
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT, mil } from '../core/units';
import { PropertyBag } from '../formats/altium/props';
import { SR, setSchCoord, type SchDocument, type SchObject } from './sch';
import { entryDistanceProps } from './schHierarchy';
import { uniqueId } from './schEdit';

export type HarnessObject = SchObject & { kind: 'harness' };
export type HarnessEntryObject = SchObject & { kind: 'harnessentry' };
export const isHarness = (o: SchObject | undefined): o is HarnessObject => o?.kind === 'harness';

/** Default colours [est]: purple outline and text, lavender fill; navy signal harness. */
export const HARNESS_COLOUR = { line: 8388736, fill: 16770815, text: 8388736, signal: 8388608 } as const;
export const NUB = mil(50);

/** Where a signal harness meets the connector: the tip of its nub. */
export function harnessTip(h: HarnessObject): Vec2 {
  const right = h.side === 1;
  return { x: right ? h.at.x + h.w + NUB : h.at.x - NUB, y: h.at.y - h.primary };
}

/** Where wires meet a harness entry: on the connector's edge, opposite the harness side. */
export function harnessEntryPoint(h: HarnessObject, e: HarnessEntryObject): Vec2 {
  return { x: e.side === 1 ? h.at.x + h.w : h.at.x, y: h.at.y - e.distance };
}

/** Entry placement: along the side away from the harness, on the grid, clear of the corners. */
export function harnessSlot(h: SchObject, p: Vec2, grid: number): { side: number; distance: number } {
  const c = h as HarnessObject;
  const side = c.side === 1 ? 0 : 1;
  const g = Math.max(1, grid);
  const lo = Math.min(g, c.h / 2), hi = Math.max(lo, c.h - g);
  return { side, distance: Math.min(hi, Math.max(lo, Math.round((c.at.y - p.y) / g) * g)) };
}

/** The connector's harness type (its Harness Type text), '' when none. */
export function harnessType(doc: SchDocument, h: number): string {
  const t = doc.objects.find((o) => o.owner === h && o.kind === 'text' && o.role === 'harnesstype');
  return t?.kind === 'text' ? t.text : '';
}

/** Each harness type on the sheet and its connector's colours (Sheet Entries and Ports use Harness Color). */
export function harnessLooks(doc: SchDocument): Map<string, { line: number; fill: number }> {
  const out = new Map<string, { line: number; fill: number }>();
  for (const o of doc.objects) if (isHarness(o)) { const t = harnessType(doc, o.index).toLowerCase(); if (t && !out.has(t)) out.set(t, { line: o.color, fill: o.fill }); }
  return out;
}

/**
 * Place › Harness › Harness Connector: two corners; the harness leaves from the right, half way
 * down; the type shows below. Children own by position (0 = the connector).
 */
export function harnessConnectorItems(a: Vec2, c: Vec2, type = 'Harness', entries: string[] = []): { bag: PropertyBag; owner: number }[] {
  const left = Math.min(a.x, c.x), top = Math.max(a.y, c.y);
  const w = Math.max(4 * SCH_UNIT, Math.abs(c.x - a.x)), h = Math.max(4 * SCH_UNIT, Math.abs(c.y - a.y), (entries.length + 1) * 10 * SCH_UNIT);
  const con = PropertyBag.from({ RECORD: SR.HARNESS_CONNECTOR, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: HARNESS_COLOUR.line, AREACOLOR: HARNESS_COLOUR.fill, SIDE: 1 });
  setSchCoord(con, 'LOCATION.X', left); setSchCoord(con, 'LOCATION.Y', top);
  setSchCoord(con, 'XSIZE', w); setSchCoord(con, 'YSIZE', h);
  setSchCoord(con, 'PRIMARYCONNECTIONPOSITION', Math.round(h / 2 / (10 * SCH_UNIT)) * 10 * SCH_UNIT);
  con.set('UNIQUEID', uniqueId());
  const t = PropertyBag.from({ RECORD: SR.HARNESS_TYPE, OWNERINDEXADDITIONALLIST: true, OWNERPARTID: -1, COLOR: HARNESS_COLOUR.text, FONTID: 1, TEXT: type });
  setSchCoord(t, 'LOCATION.X', left); setSchCoord(t, 'LOCATION.Y', top - h - 10 * SCH_UNIT);
  const items = [{ bag: con, owner: -1 }, { bag: t, owner: 0 }];
  entries.forEach((n, i) => items.push({ bag: harnessEntryBag(n, 0, (i + 1) * 10 * SCH_UNIT), owner: 0 }));
  return items;
}

export function harnessEntryBag(name: string, side: number, distance: number): PropertyBag {
  const b = PropertyBag.from({ RECORD: SR.HARNESS_ENTRY, OWNERINDEXADDITIONALLIST: true, OWNERPARTID: -1, COLOR: HARNESS_COLOUR.line, AREACOLOR: HARNESS_COLOUR.fill,
    TEXTCOLOR: HARNESS_COLOUR.text, TEXTFONTID: 1, TEXTSTYLE: 'Full', NAME: name });
  if (side) b.set('SIDE', String(side));
  for (const [k, v] of Object.entries(entryDistanceProps(distance))) if (v !== null) b.setRaw(k, v);
  return b;
}

/** Place › Harness › Signal Harness: a thick line, a click per vertex. */
export function signalHarnessBag(pts: Vec2[]): PropertyBag {
  const b = PropertyBag.from({ RECORD: SR.SIGNAL_HARNESS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: HARNESS_COLOUR.signal, LOCATIONCOUNT: pts.length });
  pts.forEach((p, i) => { setSchCoord(b, `X${i + 1}`, p.x); setSchCoord(b, `Y${i + 1}`, p.y); });
  b.set('UNIQUEID', uniqueId());
  return b;
}

/** Harness definitions: each type's entry names, from the connectors that carry it (Problem Finder). */
export function harnessDefinitions(sheets: { name: string; doc: SchDocument }[]): Map<string, { entries: string[]; where: { sheet: string; index: number }[] }[]> {
  const out = new Map<string, { entries: string[]; where: { sheet: string; index: number }[] }[]>();
  for (const { name, doc } of sheets) {
    for (const o of doc.objects) {
      if (!isHarness(o)) continue;
      const type = harnessType(doc, o.index) || '(no type)';
      const entries = doc.objects.filter((e): e is HarnessEntryObject => e.kind === 'harnessentry' && e.owner === o.index).sort((a, b) => a.distance - b.distance).map((e) => e.name);
      const defs = out.get(type) ?? [];
      const same = defs.find((d) => d.entries.join('\n') === entries.join('\n'));
      if (same) same.where.push({ sheet: name, index: o.index }); else defs.push({ entries, where: [{ sheet: name, index: o.index }] });
      out.set(type, defs);
    }
  }
  return out;
}
