/** Minimal SchDoc record builder for Konium's synthetic files. */
import { joinSchRecords } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { SR, setSchCoord } from '../../model/sch';
import { toBgr } from '../../model/common';
import { SCH_UNIT } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { uniqueId } from '../../model/schEdit';
import { identity, transformBag } from '../../model/schTransform';

export const C = { wire: toBgr(0x1d4f91), body: toBgr(0x6b2f2a), fill: toBgr(0xf4f1e2), pin: toBgr(0x22252a), text: toBgr(0x1d3557) };

export class SchBuilder {
  bags: PropertyBag[] = [];
  wireColour = C.wire;
  constructor() {
    this.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
  }
  /** Adds a record; returns its object index (what OWNERINDEX refers to). */
  add(props: Record<string, string | number | boolean>, pts: Record<string, Vec2> = {}): number {
    const bag = PropertyBag.from(props);
    for (const [k, p] of Object.entries(pts)) {
      setSchCoord(bag, `${k}.X`, p.x * SCH_UNIT);
      setSchCoord(bag, `${k}.Y`, p.y * SCH_UNIT);
    }
    this.bags.push(bag);
    this.bags[0]!.setRaw('WEIGHT', String(this.bags.length - 1));
    return this.bags.length - 2;
  }
  wire(...pts: [number, number][]): void {
    const bag = PropertyBag.from({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: this.wireColour, LOCATIONCOUNT: pts.length });
    pts.forEach(([x, y], i) => { setSchCoord(bag, `X${i + 1}`, x * SCH_UNIT); setSchCoord(bag, `Y${i + 1}`, y * SCH_UNIT); });
    bag.setRaw('UNIQUEID', uniqueId());
    this.bags.push(bag);
  }
  /**
   * A library part placed (its records from partRecords): moved to `at` (and turned by quarter
   * turns), its children owned by their new indices; the component's object index.
   */
  placePart(items: { bag: PropertyBag; owner: number }[], at: [number, number], o: { designator?: string; quarter?: number; /** Turned over top to bottom. */ flip?: boolean } = {}): number {
    const x = { ...identity(), quarter: o.quarter ?? 0, mirrorY: !!o.flip, d: { x: at[0] * SCH_UNIT, y: at[1] * SCH_UNIT } };
    const idx: number[] = [];
    items.forEach((it, i) => {
      const src = it.bag.clone();
      if (i === 0 && !src.has('LOCATION.X')) { setSchCoord(src, 'LOCATION.X', 0); setSchCoord(src, 'LOCATION.Y', 0); }
      const b = transformBag(src, x);
      if (i === 0 && o.quarter) b.set('ORIENTATION', String(o.quarter));
      if (it.owner >= 0 && i > 0) b.set('OWNERINDEX', String(idx[it.owner]));
      if (o.designator && b.int('RECORD', -1) === SR.DESIGNATOR) b.set('TEXT', o.designator);
      this.bags.push(b);
      this.bags[0]!.setRaw('WEIGHT', String(this.bags.length - 1));
      idx.push(this.bags.length - 2);
    });
    return idx[0]!;
  }
  bytes(): Uint8Array {
    return joinSchRecords(this.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag })));
  }
}
