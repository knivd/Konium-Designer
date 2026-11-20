/**
 * Wire links in 3D (Place › Wire Link): each an insulated wire of its diameter along its path at
 * its height above the board surface on its side, rounded at every bend, dropping straight down
 * to its two pads, where a small blob of solder holds it. Millimetres from the board model's
 * centre, z up from the board's underside (as boardModel.ts builds the rest).
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM } from '../../core/units';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { WIRE_LINK_HEIGHT, wireLinks } from '../../model/wireLink';
import type { Mesh, RGBA } from './boardModel';

type V3 = [number, number, number];
/** The insulation's dark red and the solder's silver. */
export const WIRE_COLOURS = { insulation: [0.42, 0.05, 0.04, 1] as RGBA, solder: [0.8, 0.81, 0.83, 1] as RGBA };

class Tris {
  pos: number[] = []; nrm: number[] = []; idx: number[] = [];
  private v(p: V3, n: V3): number { this.pos.push(...p); this.nrm.push(...n); return this.pos.length / 3 - 1; }
  /** An open tube from a to b. */
  tube(a: V3, b: V3, r: number, sides = 12): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d);
    if (l < 1e-6 || r <= 0) return;
    const u: V3 = [d[0] / l, d[1] / l, d[2] / l];
    const ref: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cr = (x: V3, y: V3): V3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    let s1 = cr(u, ref); const k = Math.hypot(...s1); s1 = [s1[0] / k, s1[1] / k, s1[2] / k];
    const s2 = cr(u, s1);
    const base = this.pos.length / 3;
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
      const n: V3 = [c * s1[0] + s * s2[0], c * s1[1] + s * s2[1], c * s1[2] + s * s2[2]];
      this.v([a[0] + r * n[0], a[1] + r * n[1], a[2] + r * n[2]], n);
      this.v([b[0] + r * n[0], b[1] + r * n[1], b[2] + r * n[2]], n);
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides, a0 = base + 2 * i, b0 = a0 + 1, a1 = base + 2 * j, b1 = a1 + 1;
      this.idx.push(a0, a1, b1, a0, b1, b0);
    }
  }
  /** An ellipsoid about c (radius r across, rz up and down): a rounded bend, a blob of solder. */
  ball(c: V3, r: number, rz = r, rings = 6, sides = 12): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= rings; i++) {
      const ph = (i / rings) * Math.PI, sp = Math.sin(ph), cp = Math.cos(ph);
      for (let j = 0; j < sides; j++) {
        const t = (j / sides) * 2 * Math.PI, x = sp * Math.cos(t), y = sp * Math.sin(t);
        // The normal of an ellipsoid: the point's direction scaled back by its radii
        const n: V3 = [x / r, y / r, cp / rz], m = Math.hypot(...n) || 1;
        this.v([c[0] + r * x, c[1] + r * y, c[2] + rz * cp], [n[0] / m, n[1] / m, n[2] / m]);
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < sides; j++) {
      const a = base + i * sides + j, b = base + i * sides + ((j + 1) % sides), c2 = a + sides, d = b + sides;
      this.idx.push(a, b, d, a, d, c2);
    }
  }
  build(colour: RGBA): Mesh | null {
    return this.idx.length ? { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), uv: null, idx: new Uint32Array(this.idx), colour } : null;
  }
}

/**
 * The board's wire links as meshes (the insulation, then the solder): `centre` is the board
 * model's centre (board units), `thickness` the board's as the model has it (mm).
 */
export function wireLinkMeshes(doc: PcbDocument, centre: Vec2, thickness: number): Mesh[] {
  const links = wireLinks(doc);
  if (!links.length) return [];
  const wire = new Tris(), solder = new Tris();
  const mm = (v: Vec2): [number, number] => [(v.x - centre.x) / UNITS_PER_MM, (v.y - centre.y) / UNITS_PER_MM];
  const key = (v: Vec2) => `${Math.round(v.x)},${Math.round(v.y)}`;
  for (const w of links) {
    const bottom = w.side === L.BOTTOM, surface = bottom ? 0 : thickness, up = bottom ? -1 : 1;
    const r = w.width / 2 / UNITS_PER_MM, z = surface + up * (WIRE_LINK_HEIGHT / UNITS_PER_MM);
    const at = (v: Vec2, h = z): V3 => { const [x, y] = mm(v); return [x, y, h]; };
    // Along the path, each bend (and end) rounded
    const joints = new Map<string, Vec2>();
    for (const [a, b] of w.segs) { wire.tube(at(a), at(b), r); joints.set(key(a), a); joints.set(key(b), b); }
    for (const j of joints.values()) wire.ball(at(j), r);
    // Down to each pad, held by a blob of solder
    for (const e of w.ends) {
      const blob = Math.max(r * 1.6, 0.25), lift = Math.max(r, 0.15);
      wire.tube(at(e, surface + up * lift), at(e), r);
      solder.ball(at(e, surface), blob, lift * 1.2);
    }
  }
  return [wire.build(WIRE_COLOURS.insulation), solder.build(WIRE_COLOURS.solder)].filter((m): m is Mesh => !!m);
}
