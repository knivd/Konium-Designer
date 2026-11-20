/**
 * The enclosure's solids, made with manifold-3d (src/platform/manifold.ts) from its settings and
 * the board: the base and the top, each a closed solid ready to print, in place (the top on the
 * base). See enclosure.ts for what they are and where things go.
 */
import type { CrossSection, Manifold, ManifoldToplevel, Vec2, Vec3 } from 'manifold-3d';
import { strokeText } from '../formats/gerber/stroke';
import { blindBottom, bossDia, keyholeLayout, layoutOf, pinRadius, screwOf, snapPlaces, ventCells, type BoardFacts, type EnclosureSpec, type Face, type Layout, type Opening, type Side } from './enclosure';

/** A solid as triangles over shared corners (mm). */
export interface SolidMesh { pos: Float32Array; idx: Uint32Array; volume: number }
/** Parts of their own beside the base and the top (buttons), in place. */
export interface Extra { name: string; mesh: SolidMesh }
/**
 * Text or a logo in a colour of its own, a part of the base or the top printed in another filament:
 * raised, what stands out; cut in, the cut filled flush. In place.
 */
export interface Inlay { name: string; on: 'base' | 'top'; colour: string; raised: boolean; mesh: SolidMesh }
export interface Built { g: Layout; base: SolidMesh; top: SolidMesh; extras: Extra[]; inlays: Inlay[]; notes: string[] }

const SIDES: Side[] = ['S', 'E', 'N', 'W'];
/** Turning a wall's opening (made in x along, y up, z out) onto its wall. */
const TURN: Record<Side, number> = { S: 0, E: 90, N: 180, W: 270 };
const E = 0.01;

/** A rounded rectangle's outline (counter-clockwise), n points to each corner. */
function rrectPts(hx: number, hy: number, r: number, n = 16): Vec2[] {
  const k = Math.max(0.01, Math.min(r, hx - 0.005, hy - 0.005));
  const out: Vec2[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * (Math.PI / 2); out.push([cx + Math.cos(a) * k, cy + Math.sin(a) * k]); } };
  corner(hx - k, -hy + k, -Math.PI / 2); corner(hx - k, hy - k, 0); corner(-hx + k, hy - k, Math.PI / 2); corner(-hx + k, -hy + k, Math.PI);
  return out;
}

export function buildEnclosure(M: ManifoldToplevel, s: EnclosureSpec, b: BoardFacts): Built {
  const g = layoutOf(s, b);
  const notes = [...g.notes];
  const live: { delete(): void }[] = [];
  /** Kept to be freed at the end (manifold's objects live in WebAssembly memory). */
  const k = <T extends { delete(): void }>(x: T): T => { live.push(x); return x; };
  const { Manifold: Mf, CrossSection: CS } = M;
  try {
    const rrect = (hx: number, hy: number, r: number): CrossSection => k(CS.ofPolygons([rrectPts(hx, hy, r)]));
    const prism = (cs: CrossSection, z0: number, z1: number): Manifold => k(k(Mf.extrude(cs, z1 - z0)).translate([0, 0, z0]));
    const cyl = (x: number, y: number, z0: number, z1: number, r0: number, r1 = r0, seg = 40): Manifold => k(k(Mf.cylinder(z1 - z0, r0, r1, seg)).translate([x, y, z0]));
    const union = (ms: Manifold[]): Manifold | null => (ms.length ? k(Mf.union(ms)) : null);
    const minus = (a: Manifold, ms: (Manifold | null)[]): Manifold => { const c = ms.filter((x): x is Manifold => !!x); return c.length ? k(Mf.difference([a, ...c])) : a; };
    const plus = (a: Manifold, ms: (Manifold | null)[]): Manifold => { const c = ms.filter((x): x is Manifold => !!x); return c.length ? k(Mf.union([a, ...c])) : a; };

    /* The outside: the rounded box, its top and bottom edges rounded or chamfered; else a small chamfer on the faces that lie on the bed */
    const H = g.height, e = g.edge, bc = Math.max(0, Math.min(s.print.bedChamfer, 1.5));
    const profile = (atTop: boolean): [number, number][] => {
      const at = (z: number) => (atTop ? H - z : z);
      if (e > 0 && s.edge === 'round') return Array.from({ length: 7 }, (_, i) => { const f = (i / 6) * (Math.PI / 2); return [at(e - e * Math.cos(f)), e - e * Math.sin(f)] as [number, number]; });
      if (e > 0) return [[at(0), e], [at(e), 0]];
      if (bc > 0) return [[at(0), bc], [at(bc), 0]];
      return [[at(0), 0]];
    };
    const pts: Vec3[] = [];
    for (const [z, inset] of [...profile(false), ...profile(true)]) for (const [x, y] of rrectPts(g.ox - inset, g.oy - inset, g.ro - inset)) pts.push([x, y, z]);
    const outside = k(Mf.hull(pts));
    const cavity = prism(rrect(g.ix, g.iy, g.ri), g.floorTop, g.rim);
    const shell = k(outside.subtract(cavity));
    const [top0, base0] = shell.splitByPlane([0, 0, 1], g.joint).map((m) => k(m)) as [Manifold, Manifold];
    let base = base0, top = top0;
    const inl: { name: string; on: 'base' | 'top'; colour: string; raised: boolean; m: Manifold }[] = [];

    /* The joint */
    const fit = s.fit;
    const screwsAt = g.screws?.at ?? [];
    const bossR = g.screws ? g.screws.boss / 2 : 0;
    const cornerScrews = s.fix === 'screws' && s.screw.at === 'corners';
    const notch = cornerScrews ? screwsAt.map((p) => cyl(p.x, p.y, -1, H + 1, bossR + fit)) : [];
    let lipH = s.lipHeight, lipW = s.lipWidth;
    if (g.flatLid) {
      // The lid's lip inside the walls, round the bosses
      lipH = Math.max(0.5, Math.min(lipH, g.rim - g.boardTop - 0.5));
      const lw = Math.min(lipW, g.ix - b.w / 2 + 0.2);
      if (lw < lipW - 1e-6) notes.push(`The lid's lip is ${lw.toFixed(1)} mm thick, as much as the room beside the board allows`);
      lipW = Math.max(0.6, lw);
      const ring = k(rrect(g.ix - fit, g.iy - fit, g.ri - fit).subtract(rrect(g.ix - fit - lipW, g.iy - fit - lipW, g.ri - fit - lipW)));
      top = plus(top, [minus(prism(ring, g.rim - lipH, g.rim + E), notch)]);
    } else {
      // A lap joint in the walls: the base's inner half rises into the top, whose outer half comes down over it
      lipW = Math.max(0.6, Math.min(lipW, s.wall - fit - 0.8));
      lipH = Math.max(0.5, Math.min(lipH, g.rim - g.joint - 0.6));
      const ring = k(rrect(g.ix + lipW, g.iy + lipW, g.ri + lipW).subtract(rrect(g.ix, g.iy, g.ri)));
      base = plus(base, [minus(prism(ring, g.joint - E, g.joint + lipH), notch)]);
      top = minus(top, [prism(rrect(g.ix + lipW + fit, g.iy + lipW + fit, g.ri + lipW + fit), g.joint - E, g.joint + lipH + fit)]);
    }

    /* Snap catches: bumps on the lip's outside, grooves in the wall facing it, the lip slit either side of each bump so it can flex */
    if (s.fix === 'snaps') {
      const p = s.print.material === 'PLA' ? 0.45 : 0.6, len = 8;
      let n = 0;
      for (const side of SIDES) {
        const f = g.sides[side];
        for (const u of snapPlaces(s, g, side)) {
          n++;
          // The lip's outside face: the flat lid's lip is inside the walls; the base's lip in the wall's inner half
          const off = g.flatLid ? -fit : lipW, z = g.flatLid ? g.rim - lipH * 0.45 : g.joint + lipH * 0.55;
          const at = (o: number) => [f.m.x + f.d.x * u + f.n.x * o, f.m.y + f.d.y * u + f.n.y * o] as const;
          const rod = (r: number, l: number) => { const [x, y] = at(off); return k(k(k(k(Mf.cylinder(l, r, r, 24, true)).rotate([0, 90, 0])).rotate([0, 0, TURN[side]])).translate([x, y, z])); };
          const slit = (du: number) => {
            const [x, y] = [f.m.x + f.d.x * (u + du), f.m.y + f.d.y * (u + du)];
            const inner = g.flatLid ? -fit - lipW - 0.5 : -0.5, outer = g.flatLid ? -fit + 0.5 : lipW + 0.5;
            const z0 = g.flatLid ? g.rim - lipH - 1 : g.joint, z1 = g.flatLid ? g.rim : g.joint + lipH + 1;
            const sq = k(CS.square([0.8, outer - inner]));
            // Across the lip at that point along the wall: x along it, y inwards (so the turn onto the wall is a rotation)
            return k(k(prism(k(sq.translate([-0.4, -outer])), z0, z1).rotate([0, 0, TURN[side]])).translate([x, y, 0]));
          };
          const bump = rod(p, len), groove = rod(p + 0.15, len + 1);
          if (g.flatLid) { top = minus(plus(top, [bump]), [slit(-len / 2 - 1), slit(len / 2 + 1)]); base = minus(base, [groove]); }
          else { base = minus(plus(base, [bump]), [slit(-len / 2 - 1), slit(len / 2 + 1)]); top = minus(top, [groove]); }
        }
      }
      if (!n) notes.push('No snap catches: the walls have no room for them beside the openings');
    }

    /* The board on its standoffs (with their holes), or on ledges under its corners */
    const hc = Math.max(0, Math.min(0.6, s.print.holeComp ?? 0));
    const holeFor = (x: number, y: number, size: number, into: string, zTop: number, zBottom: number, nutTop?: number): Manifold[] => {
      const k0 = screwOf(size), kk = { ...k0, pilot: k0.pilot + hc, clear: k0.clear + hc, insert: k0.insert + hc, nutAF: k0.nutAF + hc };
      if (into === 'insert') return [cyl(x, y, Math.max(zBottom, zTop - kk.insertL - 0.5), zTop + E, kk.insert / 2, kk.insert / 2, 32)];
      if (into === 'nut') return [cyl(x, y, -E, zTop + E, kk.clear / 2, kk.clear / 2, 32), cyl(x, y, -E, nutTop ?? kk.nutH + 0.3, kk.nutAF / Math.sqrt(3) + 0.15, kk.nutAF / Math.sqrt(3) + 0.15, 6)];
      return [cyl(x, y, zBottom, zTop + E, kk.pilot / 2, kk.pilot / 2, 32)];
    };
    // A blind hole's bottom: clear of the recesses for feet under the floor
    const blind = blindBottom(s);
    // Screws coming down through the board need a hole, not a pin
    const mountInto = s.mount.into === 'pin' && s.fix === 'screws' && s.screw.at === 'board' ? 'pilot' : s.mount.into;
    for (const p of g.standoffs) {
      const r = (s.mount.dia ?? bossDia(p.size, mountInto)) / 2;
      // Joined to the wall where they meet it, not through it
      const post = cyl(p.x, p.y, g.floorTop - E, g.boardBottom, r), foot = cyl(p.x, p.y, g.floorTop - E, g.floorTop + 1.2, r + 1.2, r);
      base = plus(base, [k(Mf.intersection([k(Mf.union([post, foot])), outside]))]);
      if (mountInto === 'pin') {
        const pr = pinRadius(p.d, s.print.holeComp), tip = g.boardTop + 0.8;
        base = plus(base, [cyl(p.x, p.y, g.boardBottom - E, tip, pr, pr, 24), cyl(p.x, p.y, tip - E, tip + 0.6, pr, pr * 0.6, 24)]);
      } else base = minus(base, holeFor(p.x, p.y, p.size, mountInto, g.boardBottom, blind, s.fix === 'screws' && s.screw.at === 'board' ? g.screws?.nutTop : undefined));
    }
    if (g.ledges.length) {
      const L = 4;
      base = plus(base, [k(Mf.intersection([k(Mf.union(g.ledges.map((c) => {
        const x0 = c.x > 0 ? c.x - L : -g.ox, x1 = c.x > 0 ? g.ox : c.x + L, y0 = c.y > 0 ? c.y - L : -g.oy, y1 = c.y > 0 ? g.oy : c.y + L;
        return prism(k(k(CS.square([x1 - x0, y1 - y0])).translate([x0, y0])), g.floorTop - E, g.boardBottom);
      }))), outside]))]);
    }
    // Posts from the top onto the board (a little short of it, so they hold without pressing); over a locating pin, hollow round its tip
    if (g.clamps.length) {
      top = plus(top, g.clamps.map((p) => cyl(p.x, p.y, g.boardTop + 0.2, g.rim + E, p.r)));
      if (mountInto === 'pin') top = minus(top, g.standoffs.map((p) => cyl(p.x, p.y, g.boardTop, g.boardTop + 1.4 + fit + 0.4, pinRadius(p.d, s.print.holeComp) + fit, pinRadius(p.d, s.print.holeComp) + fit, 24)));
    }

    /* The top's screws */
    if (g.screws) {
      const k0 = screwOf(g.screws.size), kk = { ...k0, clear: k0.clear + hc };
      const head = s.screw.head === 'countersunk' ? [(p: { x: number; y: number }) => cyl(p.x, p.y, H - (kk.head - kk.clear) / 2 - 0.1, H + E, kk.clear / 2, kk.head / 2 + 0.1, 32)] : [];
      if (cornerScrews) {
        const bosses = screwsAt.map((p) => cyl(p.x, p.y, g.floorTop - E, g.joint, bossR));
        base = plus(base, [k(Mf.intersection([union(bosses)!, outside]))]);
        base = minus(base, screwsAt.flatMap((p) => holeFor(p.x, p.y, g.screws!.size, s.screw.into, g.joint, g.floorTop + 0.6, g.screws!.nutTop)));
        if (!g.flatLid) top = plus(top, [k(Mf.intersection([union(screwsAt.map((p) => cyl(p.x, p.y, g.joint + E, g.rim + E, bossR)))!, outside]))]);
      } else {
        // Down through the board: posts from the top onto it round the screws
        top = plus(top, screwsAt.map((p) => cyl(p.x, p.y, g.boardTop, g.rim + E, g.screws!.boss / 2)));
      }
      top = minus(top, screwsAt.flatMap((p) => [cyl(p.x, p.y, Math.min(g.joint, g.boardTop) - 1, H + 1, kk.clear / 2, kk.clear / 2, 32), ...head.map((h) => h(p))]));
    }

    /* Openings */
    const shape = (o: Opening, wall: boolean): CrossSection => {
      const w = Math.max(0.2, o.w), h = Math.max(0.2, o.h);
      if (o.shape === 'circle') {
        const r = w / 2, c = k(CS.circle(r, 48));
        // A wall's round hole, printed standing: its top drawn to a point at 45°
        return wall && s.print.teardrops ? k(CS.hull([c, k(k(CS.square([0.02, 0.02], true)).translate([0, r * Math.SQRT2]))])) : c;
      }
      if (o.shape === 'slot') {
        const r = Math.min(w, h) / 2, d = (Math.max(w, h) - 2 * r) / 2, along = w >= h;
        return k(CS.hull([k(k(CS.circle(r, 40)).translate(along ? [-d, 0] : [0, -d])), k(k(CS.circle(r, 40)).translate(along ? [d, 0] : [0, d]))]));
      }
      if (o.shape === 'rounded') { const r = Math.min(2, Math.min(w, h) / 2 - 0.05); return r > 0.05 ? k(k(CS.square([w - 2 * r, h - 2 * r], true)).offset(r, 'Round', 2, 48)) : k(CS.square([w, h], true)); }
      return k(CS.square([w, h], true));
    };
    /** A shape made in x along, y up, z out from the wall's inside, put on its wall. */
    const onWall = (side: Side, m: Manifold): Manifold => {
      const f = g.sides[side];
      return k(k(k(m.rotate([90, 0, 0])).rotate([0, 0, TURN[side]])).translate([f.m.x, f.m.y, g.boardTop]));
    };
    const cutBase: Manifold[] = [], cutTop: Manifold[] = [], fill: Manifold[] = [];
    const jointV = g.joint - g.boardTop;
    const line = s.print.nozzle * 1.125;
    for (const o of s.openings) {
      if (!o.on) continue;
      // A recess: from the face's outside in, as deep as asked
      if (o.depth && o.depth > 0) {
        const thick = o.face === 'top' ? s.top : o.face === 'bottom' ? s.floor : s.wall, d = Math.min(o.depth, thick);
        const cs = k(shape(o, false).translate([o.x, o.y]));
        if (o.face === 'top') cutTop.push(prism(cs, H - d, H + 1));
        else if (o.face === 'bottom') cutBase.push(prism(cs, -1, d));
        else { const r = onWall(o.face as Side, k(k(Mf.extrude(cs, d + 1)).translate([0, 0, s.wall - d]))); cutTop.push(r); cutBase.push(r); }
        if (thick - d < 2 * line - 1e-6) notes.push(`${o.name || 'A recess'} leaves ${Math.max(0, thick - d).toFixed(1)} mm of the ${FACE_NAME[o.face].toLowerCase()}${o.face === 'top' || o.face === 'bottom' ? '' : ' wall'}: under two lines of the nozzle`);
        continue;
      }
      // A round hole's countersink (90°) or counterbore, from the face's outside in
      const sk = o.shape === 'circle' && o.sink && o.sink.d > o.w ? o.sink : null;
      const thick = o.face === 'top' ? s.top : o.face === 'bottom' ? s.floor : s.wall;
      const sinkDepth = sk ? Math.min(thick, sk.kind === 'cs' ? (sk.d - o.w) / 2 : sk.depth) : 0;
      if (sk && thick - sinkDepth < 2 * line - 1e-6) notes.push(`${o.name || 'A hole'}'s ${sk.kind === 'cs' ? 'countersink' : 'counterbore'} leaves under two lines of the nozzle round the hole`);
      if (o.face === 'top' || o.face === 'bottom') {
        const cs = k(shape(o, false).translate([o.x, o.y]));
        if (o.face === 'top') cutTop.push(prism(cs, g.rim - E, H + 1)); else cutBase.push(prism(cs, -1, g.floorTop + E));
        if (sk) {
          const r1 = sk.d / 2 + hc / 2, r0 = sk.kind === 'cs' ? Math.max(o.w / 2, r1 - sinkDepth) : r1;
          if (o.face === 'top') cutTop.push(cyl(o.x, o.y, H - sinkDepth, H + 1, r0, sk.kind === 'cs' ? r1 + 1 : r1, 48));
          else cutBase.push(cyl(o.x, o.y, -1, sinkDepth, sk.kind === 'cs' ? r1 + 1 : r1, r0, 48));
        }
        continue;
      }
      if (sk) {
        const r1 = sk.d / 2 + hc / 2, r0 = sk.kind === 'cs' ? Math.max(o.w / 2, r1 - sinkDepth) : r1;
        const c = onWall(o.face as Side, k(k(Mf.cylinder(sinkDepth + 1, r0, sk.kind === 'cs' ? r1 + 1 : r1, 48)).translate([o.x, o.y, s.wall - sinkDepth])));
        cutTop.push(c); cutBase.push(c);
      }
      const cs = k(shape(o, true).translate([o.x, o.y]));
      if (Math.abs(o.x) + o.w / 2 > g.sides[o.face as Side].len / 2 + 0.01) notes.push(`${o.name || 'An opening'} reaches into the ${FACE_NAME[o.face].toLowerCase()} wall's rounded corner`);
      // Through the wall, and the lid's lip inside it
      const reachIn = g.flatLid ? fit + lipW + 1 : 1;
      const through = (c: CrossSection) => onWall(o.face as Side, k(k(Mf.extrude(c, s.wall + 1 + reachIn)).translate([0, 0, -reachIn])));
      const cut = through(cs);
      cutTop.push(cut);
      // Its top: a teardrop's point, else its half height
      const top1 = o.y + (o.shape === 'circle' ? (o.w / 2) * (s.print.teardrops ? Math.SQRT2 : 1) : o.h / 2);
      if (o.open && top1 < jointV) {
        // In the base, up to the joint (and through the base's lip above it); the top fills the slot above the opening
        const slot = k(k(CS.square([o.w, (g.flatLid ? jointV : jointV + lipH) + 1 - o.y])).translate([o.x - o.w / 2, o.y]));
        cutBase.push(through(k(cs.add(slot))));
        const fz0 = top1 + fit, fz1 = jointV + E;
        if (fz1 - fz0 > 0.3 && o.w - 2 * fit > 0.3) {
          const f = k(k(CS.square([o.w - 2 * fit, fz1 - fz0])).translate([o.x - o.w / 2 + fit, fz0]));
          fill.push(k(Mf.intersection([onWall(o.face as Side, k(Mf.extrude(f, s.wall + 1))), outside])));
        }
      } else cutBase.push(cut);
    }
    if (fill.length) top = plus(top, fill);
    base = minus(base, cutBase);
    top = minus(top, cutTop);

    /* Something on a face: a shape in its coordinates made solid between two depths, measured out from the face's outside (negative: into it) */
    const onFace = (face: Face, cs: CrossSection, d0: number, d1: number): Manifold => {
      if (face === 'top') return prism(cs, H + d0, H + d1);
      // The bottom's shapes are made seen from below: turned over to the board's x
      if (face === 'bottom') return prism(k(cs.mirror([1, 0])), -d1, -d0);
      return onWall(face, k(k(Mf.extrude(cs, d1 - d0)).translate([0, 0, s.wall + d0])));
    };
    /** A cut through a face (a wall, the top, or the floor). */
    const reach = g.flatLid ? fit + lipW + 1 : 1;
    const through = (face: Face, cs: CrossSection): Manifold => face === 'top' ? prism(cs, g.rim - E, H + 1) : face === 'bottom' ? prism(cs, -1, g.floorTop + E) : onWall(face, k(k(Mf.extrude(cs, s.wall + 1 + reach)).translate([0, 0, -reach])));
    const toBase = (face: Face) => face !== 'top';
    const toTop = (face: Face) => face !== 'bottom';

    /* Vents (enclosure.ts ventCells) */
    for (const v of s.vents) {
      if (!v.on || v.w <= 0 || v.h <= 0) continue;
      const vc = ventCells(v, s);
      const cells: CrossSection[] = vc.cells.map((c) => {
        if (vc.kind === 'slot') return k(CS.hull([k(k(CS.circle(vc.r, 24)).translate([c.x, c.y])), k(k(CS.circle(vc.r, 24)).translate([c.x2!, c.y2!]))]));
        if (vc.kind === 'hex') return k(k(vc.pointUp ? k(k(CS.circle(vc.r, 6)).rotate(30)) : k(CS.circle(vc.r, 6))).translate([c.x, c.y]));
        const o = k(CS.circle(vc.r, 32));
        return k((vc.teardrop ? k(CS.hull([o, k(k(CS.square([0.02, 0.02], true)).translate([0, vc.r * Math.SQRT2]))])) : o).translate([c.x, c.y]));
      });
      if (!cells.length) { notes.push(`${v.name || 'A vent patch'} is too small for its ${v.pattern === 'slots' ? 'slots' : v.pattern === 'holes' ? 'holes' : 'hexagons'}`); continue; }
      const cut = through(v.face, k(CS.union(cells)));
      if (toBase(v.face)) base = minus(base, [cut]);
      if (toTop(v.face)) top = minus(top, [cut]);
    }

    /* Text, in the single-line font (its strokes given width), or a logo: cut in, standing out, or cut through */
    for (const l of s.labels) {
      if (!l.on || (!l.logo && !l.text.trim())) continue;
      const size = Math.max(1, l.size), sw = Math.max(s.print.nozzle * 2, size * 0.14);
      // Made seen from outside (the bottom's from below: onFace turns it over)
      const px = l.face === 'bottom' ? -l.x : l.x;
      let cs: CrossSection | null = null;
      if (l.logo) {
        // In the order drawn: dark shapes add, white ones take away what is under them
        for (const sh of l.logo.shapes) {
          const c = k(CS.ofPolygons(sh.rings.map((r) => r.map(([x, y]) => [x * size + px, y * size + l.y] as Vec2)), sh.evenOdd ? 'EvenOdd' : 'NonZero'));
          cs = sh.knock ? (cs ? k(cs.subtract(c)) : null) : cs ? k(cs.add(c)) : c;
        }
      } else {
        const lines = strokeText(l.text, { x: 0, y: 0 }, size);
        if (!lines.length) continue;
        const xs = lines.flat().map((p) => p.x), ys = lines.flat().map((p) => p.y);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const dots: CrossSection[] = [];
        for (const ln of lines) {
          const pts = ln.map((p) => [p.x - cx + px, p.y - cy + l.y] as Vec2);
          if (pts.length === 1) dots.push(k(k(CS.circle(sw / 2, 12)).translate(pts[0]!)));
          for (let i = 1; i < pts.length; i++) dots.push(k(CS.hull([k(k(CS.circle(sw / 2, 12)).translate(pts[i - 1]!)), k(k(CS.circle(sw / 2, 12)).translate(pts[i]!))])));
        }
        cs = k(CS.union(dots));
      }
      if (!cs || cs.isEmpty()) continue;
      const name = l.logo ? l.text || l.logo.name : l.text;
      if (l.through) {
        const cut = through(l.face, l.face === 'bottom' ? k(cs.mirror([1, 0])) : cs);
        if (toBase(l.face)) base = minus(base, [cut]);
        if (toTop(l.face)) top = minus(top, [cut]);
        if (l.logo ? l.logo.shapes.some((sh) => sh.rings.length > 1 || sh.knock) : /[ABDOPQR04689abdegopq@&%]/.test(l.text)) notes.push(`"${name}" is cut through: the islands inside it fall out`);
      } else {
        const d = Math.max(0.2, l.depth);
        const solid = l.raised ? onFace(l.face, cs, -E, d) : onFace(l.face, cs, -d, 1);
        if (l.colour) {
          // In a colour of its own: what stands out kept apart (on a wall, either side of the joint); a cut filled flush, with what it takes out of each part
          const own = (on: 'base' | 'top', m: Manifold, raised: boolean) => { if (!m.isEmpty()) inl.push({ name, on, colour: l.colour!, raised, m }); };
          if (l.raised) {
            if (l.face === 'top') own('top', solid, true);
            else if (l.face === 'bottom') own('base', solid, true);
            else { const [up, down] = solid.splitByPlane([0, 0, 1], g.joint).map((m) => k(m)) as [Manifold, Manifold]; own('top', up, true); own('base', down, true); }
          } else {
            if (toTop(l.face)) { own('top', k(Mf.intersection([top, solid])), false); top = minus(top, [solid]); }
            if (toBase(l.face)) { own('base', k(Mf.intersection([base, solid])), false); base = minus(base, [solid]); }
          }
        } else if (l.face === 'top') top = l.raised ? plus(top, [solid]) : minus(top, [solid]);
        else if (l.face === 'bottom') base = l.raised ? plus(base, [solid]) : minus(base, [solid]);
        else if (l.raised) {
          // On a wall, either side of the joint to the part there
          const [up, down] = solid.splitByPlane([0, 0, 1], g.joint).map((m) => k(m)) as [Manifold, Manifold];
          top = plus(top, [up]); base = plus(base, [down]);
        } else { top = minus(top, [solid]); base = minus(base, [solid]); }
        // Faces printed on the bed: the top's (turned over) and the base's underside
        if (l.raised && (l.face === 'top' || l.face === 'bottom')) notes.push(`"${name}" stands out of a face that lies on the print bed: it needs support there, or cut it in instead`);
        if (l.depth < 2 * s.print.layer - 1e-6) notes.push(`"${name}" is ${l.depth} mm deep: two layers (${(2 * s.print.layer).toFixed(2)} mm) or more shows`);
      }
      if (!l.logo && (size < 3 || sw < s.print.nozzle * 2 - 1e-6)) notes.push(`"${l.text}" is small for printing: 3 mm high or more reads well`);
    }

    /*
     * Protrusions: a shape on a face made solid out from it (outside) or into the box (inside), with
     * a hole down its middle from its end to the face if asked; on a wall, either side of the joint
     * to the part there. Inside, what runs into the board or its parts is noted.
     */
    for (const a of s.adds) {
      if (!a.on) continue;
      const ht = Math.max(0.2, a.height), cs = k(shape({ ...a, depth: undefined } as Opening, false).translate([a.x, a.y]));
      const hole = a.hole > 0 ? k(k(CS.circle(a.hole / 2 + hc / 2, 32)).translate([a.x, a.y])) : null;
      const inner = a.side === 'in';
      let solid: Manifold, bore: Manifold | null = null;
      if (a.face === 'top') {
        const z0 = inner ? H - s.top - ht : H - E, z1 = inner ? H - s.top + E : H + ht;
        solid = prism(cs, z0, z1);
        if (hole) bore = inner ? prism(hole, z0 - 1, H - s.top) : prism(hole, H, z1 + 1);
      } else if (a.face === 'bottom') {
        const z0 = inner ? g.floorTop - E : -ht, z1 = inner ? g.floorTop + ht : E;
        solid = prism(cs, z0, z1);
        if (hole) bore = inner ? prism(hole, g.floorTop, z1 + 1) : prism(hole, z0 - 1, 0);
      } else {
        const z0 = inner ? -ht : s.wall - E, z1 = inner ? E : s.wall + ht;
        solid = onWall(a.face, k(k(Mf.extrude(cs, z1 - z0)).translate([0, 0, z0])));
        if (hole) bore = onWall(a.face, k(k(Mf.extrude(hole, ht + 1)).translate([0, 0, inner ? z0 - 1 : s.wall])));
      }
      const name = a.name || 'A protrusion';
      if (a.face === 'top') { top = plus(top, [solid]); if (bore) top = minus(top, [bore]); }
      else if (a.face === 'bottom') { base = plus(base, [solid]); if (bore) base = minus(base, [bore]); }
      else {
        const [up, down] = solid.splitByPlane([0, 0, 1], g.joint).map((m) => k(m)) as [Manifold, Manifold];
        top = plus(top, [up]); base = plus(base, [down]);
        if (bore) { top = minus(top, [bore]); base = minus(base, [bore]); }
      }
      // Where it reaches: the board and its parts inside; the bed outside
      const x0 = a.x - a.w / 2, x1 = a.x + a.w / 2, h2 = (a.shape === 'circle' ? a.w : a.h) / 2, y0 = a.y - h2, y1 = a.y + h2;
      const onBoard = x1 > -b.w / 2 && x0 < b.w / 2 && y1 > -b.h / 2 && y0 < b.h / 2;
      if (inner && a.face === 'bottom' && onBoard && g.floorTop + ht > g.boardBottom - b.bottom - 0.2) notes.push(`${name} runs into the board or the parts under it: ${(g.boardBottom - b.bottom - g.floorTop - 0.2).toFixed(1)} mm high or less there`);
      if (inner && a.face === 'top') {
        const z = H - s.top - ht;
        const hit = b.parts.find((q) => x1 > q.x0 && x0 < q.x1 && y1 > q.y0 && y0 < q.y1 && z < g.boardTop + q.z1 + 0.2);
        if (hit) notes.push(`${name} runs into ${hit.name}`);
        else if (onBoard && z < g.boardTop + 0.2) notes.push(`${name} runs into the board`);
      }
      if (inner && a.face !== 'top' && a.face !== 'bottom' && ht > s.clearance - 0.2 && a.y + h2 > -b.thickness && a.y - h2 < 0) notes.push(`${name} runs into the board's edge: ${Math.max(0, s.clearance - 0.2).toFixed(1)} mm deep or less at the board's height`);
      if (!inner && (a.face === 'top' || a.face === 'bottom')) notes.push(`${name} stands out of a face that lies on the print bed: it needs support there`);
    }

    /* A seal between the base and the top: a groove round the base's rim (in the walls' middle; beside the base's lip for two shells), with a gasket printed in TPU as a part of its own */
    const extras: { name: string; mesh: Manifold }[] = [];
    if (s.seal.kind !== 'none') {
      // The groove [est: a face seal's usual proportions]: 1.3 times a cord's width, 0.3 mm over a gasket's; 0.7 of either deep, so it is pressed by 30%
      const z = Math.max(0.8, s.seal.size);
      const gw = s.seal.kind === 'cord' ? z * 1.3 : z + 0.3, gd = z * 0.7;
      // Where the top sits on the base: the walls' top under a flat lid; the shoulder outside the base's lip for two shells
      const from = g.flatLid ? 0 : lipW + fit, room = s.wall - from, c = from + room / 2;
      const zj = g.flatLid ? g.rim : g.joint;
      const need = gw + 4 * line + from;
      if (room < gw + 4 * line - 1e-6) notes.push(`No seal: its groove (${gw.toFixed(1)} mm wide) needs walls ${need.toFixed(1)} mm thick`);
      else if (zj - gd < g.floorTop + 0.6) notes.push('No seal: the base is too low for its groove');
      else {
        const ring = (a: number, b: number) => k(rrect(g.ix + a, g.iy + a, g.ri + a).subtract(rrect(g.ix + b, g.iy + b, Math.max(0.01, g.ri + b))));
        base = minus(base, [prism(ring(c + gw / 2, c - gw / 2), zj - gd, zj + E)]);
        if (s.seal.kind === 'gasket') extras.push({ name: 'Gasket', mesh: prism(ring(c + z / 2, c - z / 2), zj - gd, zj - gd + z) });
        // A screw through the groove breaks the seal
        const sd = (p: { x: number; y: number }) => {
          const hx = g.ix + c - (g.ri + c), hy = g.iy + c - (g.ri + c), qx = Math.abs(p.x) - hx, qy = Math.abs(p.y) - hy;
          return Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - (g.ri + c));
        };
        const hole = g.screws ? screwOf(g.screws.size).clear / 2 + hc / 2 : 0;
        if (screwsAt.some((p) => sd(p) < hole + gw / 2 + line)) notes.push('The seal\'s groove runs into the screws: thicker walls, or the screws through the board\'s holes');
        if (s.fix !== 'screws') notes.push('A seal needs screws to press the top down on it (Closing: Screws)');
        // Openings in the walls that reach the groove's height leave a gap in it
        const gap = s.openings.filter((o) => o.on && !(o.depth && o.depth > 0) && o.face !== 'top' && o.face !== 'bottom' && (o.open || o.y + (o.shape === 'circle' ? o.w : o.h) / 2 > zj - gd - g.boardTop));
        if (gap.length) notes.push(`The seal is broken where ${gap.map((o) => o.name || 'an opening').join(', ')} ${gap.length === 1 ? 'reaches' : 'reach'} the joint`);
        if (s.seal.kind === 'gasket') notes.push(`The gasket: print it in TPU; it stands ${(z - gd).toFixed(1)} mm out of its groove to be pressed`);
      }
    }

    /* Recesses for rubber feet under the base's corners */
    if (s.feet > 0) {
      const r = s.feet / 2 + 0.2, inset = r + 2.5, depth = Math.min(0.8, s.floor - 0.6);
      const feetAt = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: sx * (g.ox - inset), y: sy * (g.oy - inset) })));
      if ((s.mount.into === 'nut' && g.standoffs.some((p) => feetAt.some((f) => Math.hypot(p.x - f.x, p.y - f.y) < r + 4))) || (s.fix === 'screws' && s.screw.into === 'nut' && (g.screws?.at ?? []).some((p) => feetAt.some((f) => Math.hypot(p.x - f.x, p.y - f.y) < r + 4)))) notes.push('A recess for a foot meets a nut pocket: smaller feet, or no nuts there');
      if (g.ox > inset + r && g.oy > inset + r && depth > 0.2) base = minus(base, [-1, 1].flatMap((sx) => [-1, 1].map((sy) => cyl(sx * (g.ox - inset), sy * (g.oy - inset), -1, depth, r, r, 40))));
      else notes.push('No recesses for feet: the box is too small for them, or its floor too thin');
    }

    /*
     * Keyholes: the screw's head goes in by the entry hole and slides along the slot towards the
     * back wall, held behind a lip of the floor; a housing round each keeps the inside closed. Its
     * room comes from the floor and the space under the board.
     */
    if (s.keyholes > 0) {
      const kh = keyholeLayout(Math.max(4, s.keyholes), g);
      const lip = Math.min(1.2, s.floor - 0.2), roof = Math.max(0.8, 4 * s.print.layer);
      const hh = Math.min(4, g.boardBottom - g.floorTop - 0.6 - b.bottom), room = g.floorTop + hh - roof - lip;
      const pill = (x: number, y: number, r: number) => k(CS.hull([k(k(CS.circle(r, 40)).translate([x, y])), k(k(CS.circle(r, 40)).translate([x, y + kh.travel]))]));
      const wall = kh.r + 1.6;
      if (room < 2 - 1e-6) notes.push(`No keyholes: ${Math.max(0, room).toFixed(1)} mm of room for the screw heads under the board; 2 mm or more is needed (taller standoffs, or a thicker floor)`);
      else if (kh.at.some((p) => Math.abs(p.x) + wall > g.ix || p.y + kh.travel + wall > g.iy || p.y - wall < -g.iy)) notes.push('No keyholes: the floor is too small for them');
      else {
        base = plus(base, kh.at.map((p) => prism(pill(p.x, p.y, wall), g.floorTop - E, g.floorTop + hh)));
        base = minus(base, kh.at.flatMap((p) => [
          cyl(p.x, p.y, -1, g.floorTop + hh - roof, kh.r, kh.r, 40),
          prism(pill(p.x, p.y, kh.slot / 2), -1, lip + E),
          prism(pill(p.x, p.y, kh.r), lip, g.floorTop + hh - roof),
        ]));
        for (const p of kh.at) for (const q of g.standoffs) {
          const r = (s.mount.dia ?? bossDia(q.size, s.mount.into === 'pin' ? 'pin' : s.mount.into)) / 2 + 1.2;
          const dy = Math.max(p.y - q.y, 0, q.y - p.y - kh.travel);
          if (Math.hypot(q.x - p.x, dy) < wall + r) { notes.push(`A keyhole runs into the standoff at ${q.x.toFixed(1)}, ${q.y.toFixed(1)}`); break; }
        }
        notes.push(`Keyholes: ${kh.at.length === 1 ? 'one' : 'two'} for screw heads up to ${Math.max(4, s.keyholes)} mm across, ${room.toFixed(1)} mm high; hang the box with its back wall up${kh.at.length === 2 ? `, the screws ${(2 * kh.at[1]!.x).toFixed(1)} mm apart` : ''}`);
      }
    }

    /* Ears: flanges at the base's foot, each with a screw hole */
    if (s.ears.sides !== 'none') {
      const hole = Math.max(2, s.ears.hole), L = hole + 6, t = Math.max(s.floor, 2.5);
      const ew = s.ears.sides === 'EW', along = ew ? g.oy : g.ox;
      const span = Math.min(2 * (along - g.ro), hole + 10);
      if (span < hole + 3) notes.push('No ears: the sides are too short for them');
      else for (const sg of [-1, 1]) {
        const out = (ew ? g.ox : g.oy);
        const ear = k(rrect(L / 2 + 1, span / 2, 3).translate(ew ? [sg * (out + L / 2 - 1), 0] : [0, sg * (out + L / 2 - 1)]));
        const c = ew ? [sg * (out + L / 2), 0] : [0, sg * (out + L / 2)];
        base = minus(plus(base, [prism(ear, 0, t)]), [cyl(c[0]!, c[1]!, -1, t + 1, hole / 2, hole / 2, 32)]);
      }
    }

    /* Tubes down to LEDs, buttons onto switches (parts of their own) */
    for (const o of s.openings) {
      if (!o.on || !o.extra || o.face !== 'top' || o.shape !== 'circle' || (o.depth ?? 0) > 0) continue;
      const p = b.parts.find((q) => q.name === o.part);
      if (!p) { notes.push(`${o.name}: no part under it for its ${o.extra}`); continue; }
      const R = o.w / 2, partTop = g.boardTop + p.z1;
      if (o.extra === 'tube') {
        const z0 = partTop + 0.5;
        if (z0 >= g.rim - 0.5) continue;
        top = minus(plus(top, [cyl(o.x, o.y, z0, g.rim + E, R + Math.max(1.2, s.print.nozzle * 3))]), [cyl(o.x, o.y, z0 - 1, H + 1, R, R, 40)]);
      } else {
        // The cap through the top (standing 1.5 mm out of it), a flange under the top that widens at 45° (it prints cap down without support), a stem down to the switch
        const cap = R - 0.25, fl = R + 1.5, zf = g.rim - 0.2, zb = partTop + 0.2;
        if (zf - 1.75 - 0.6 <= zb) { notes.push(`${o.name}: no room for a button between the top and the switch`); continue; }
        const stem = Math.max(1, Math.min(cap, 2));
        const btn = union([cyl(o.x, o.y, zf - E, H + 1.5, cap, cap, 40), cyl(o.x, o.y, zf - 1.75, zf, fl, cap, 40), cyl(o.x, o.y, zf - 1.75 - 0.6, zf - 1.75 + E, fl, fl, 40), cyl(o.x, o.y, zb, zf - 1.75 - 0.6 + E, stem, stem, 32)])!;
        extras.push({ name: `${o.name} button`, mesh: btn });
      }
    }

    /* Checks: what would run into what, and what prints badly */
    if (s.wall < 2 * line - 1e-6) notes.push(`Walls ${s.wall} mm thick are under two lines of a ${s.print.nozzle} mm nozzle`);
    const covered = (name: string) => s.openings.some((o) => o.on && o.part === name && !(o.depth && o.depth > 0));
    for (const p of b.parts) {
      const z = g.boardTop + p.z1;
      if (z > g.rim + 1e-6) notes.push(`${p.name} stands ${(z - g.rim).toFixed(1)} mm taller than the room above the board${covered(p.name) ? ' (through its opening)' : ''}`);
      // The lid's lip, inside the walls
      if (g.flatLid && z > g.rim - lipH && !covered(p.name)) {
        const inner = { x: g.ix - fit - lipW, y: g.iy - fit - lipW };
        if (p.x0 < -inner.x || p.x1 > inner.x || p.y0 < -inner.y || p.y1 > inner.y) notes.push(`${p.name} runs into the lid's lip: give it an opening, lower the lip, or more room above`);
      }
      // Posts that come down through the board's holes
      if (s.fix === 'screws' && s.screw.at === 'board') for (const q of screwsAt) {
        const r = g.screws!.boss / 2;
        if (q.x + r > p.x0 && q.x - r < p.x1 && q.y + r > p.y0 && q.y - r < p.y1) notes.push(`The post down to the hole at ${q.x.toFixed(1)}, ${q.y.toFixed(1)} runs into ${p.name}`);
      }
    }
    for (const o of s.openings) {
      if (!o.on || o.face === 'top' || o.face === 'bottom' || o.open || (o.depth ?? 0) > 0) continue;
      // A flat top bridges; a round one without its point overhangs
      if ((o.shape === 'rect' || o.shape === 'rounded' || (o.shape === 'slot' && o.w > o.h)) && o.w > 20) notes.push(`${o.name}'s top bridges ${o.w.toFixed(0)} mm as it prints: keep it under 20 mm, or open it to the joint`);
      if (o.shape === 'circle' && !s.print.teardrops && o.w > 8) notes.push(`${o.name} is round, ${o.w.toFixed(0)} mm across, without a teardrop top: it may sag as it prints`);
    }

    const mesh = (m: Manifold): SolidMesh => {
      const ms = m.getMesh();
      const np = ms.numProp, pos = new Float32Array((ms.vertProperties.length / np) * 3);
      for (let i = 0, j = 0; i < ms.vertProperties.length; i += np, j += 3) { pos[j] = ms.vertProperties[i]!; pos[j + 1] = ms.vertProperties[i + 1]!; pos[j + 2] = ms.vertProperties[i + 2]!; }
      return { pos, idx: Uint32Array.from(ms.triVerts), volume: m.volume() };
    };
    for (const [name, m] of [['base', base], ['top', top], ...extras.map((x) => [x.name, x.mesh] as const), ...inl.map((x) => [`"${x.name}" in its colour`, x.m] as const)] as const) if (m.status() !== 'NoError') notes.push(`The ${name} isn't a sound solid (${m.status()})`);
    return { g, base: mesh(base), top: mesh(top), extras: extras.map((x) => ({ name: x.name, mesh: mesh(x.mesh) })), inlays: inl.map((x) => ({ name: x.name, on: x.on, colour: x.colour, raised: x.raised, mesh: mesh(x.m) })), notes };
  } finally {
    for (const x of live) { try { x.delete(); } catch { /* freed already */ } }
  }
}

/** A face's name. */
export const FACE_NAME: Record<Face, string> = { S: 'Front', E: 'Right', N: 'Back', W: 'Left', top: 'Top', bottom: 'Bottom' };

/** A solid cut by a plane across it (the half beyond `at` kept), to look inside. */
export function sectionMesh(M: ManifoldToplevel, m: SolidMesh, axis: 'x' | 'y', at: number): SolidMesh {
  const mf = M.Manifold.ofMesh(new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(m.pos), triVerts: Uint32Array.from(m.idx) }));
  const cut = mf.trimByPlane(axis === 'x' ? [1, 0, 0] : [0, 1, 0], at);
  try {
    const ms = cut.getMesh();
    const pos = new Float32Array((ms.vertProperties.length / ms.numProp) * 3);
    for (let i = 0, j = 0; i < ms.vertProperties.length; i += ms.numProp, j += 3) { pos[j] = ms.vertProperties[i]!; pos[j + 1] = ms.vertProperties[i + 1]!; pos[j + 2] = ms.vertProperties[i + 2]!; }
    return { pos, idx: Uint32Array.from(ms.triVerts), volume: cut.volume() };
  } finally { cut.delete(); mf.delete(); }
}

/** A solid moved (each corner by f; f must keep it the same way out, as turns and shifts do). */
export function movedMesh(m: SolidMesh, f: (x: number, y: number, z: number) => [number, number, number]): SolidMesh {
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < m.pos.length; i += 3) { const q = f(m.pos[i]!, m.pos[i + 1]!, m.pos[i + 2]!); pos[i] = q[0]; pos[i + 1] = q[1]; pos[i + 2] = q[2]; }
  return { ...m, pos };
}

/** Solids' extent along x and z. */
function extent(...ms: SolidMesh[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const m of ms) for (let i = 0; i < m.pos.length; i += 3) { x0 = Math.min(x0, m.pos[i]!); x1 = Math.max(x1, m.pos[i]!); z0 = Math.min(z0, m.pos[i + 2]!); z1 = Math.max(z1, m.pos[i + 2]!); }
  return { x0, x1, z0, z1 };
}
/** A part on the print plate, with the text and logos in their own colours that print with it (moved as it is). */
export interface PlatePart { name: string; mesh: SolidMesh; inlays: Omit<Inlay, 'on'>[] }

/** The parts as they print, side by side on the bed, 8 mm apart: the base as it stands; the top and any parts of their own turned over (their tops on the bed). Each lowest point on the bed; text in its own colour goes with its part. */
export function printPlate(b: Built): PlatePart[] {
  const own = (on: 'base' | 'top') => (b.inlays ?? []).filter((x) => x.on === on);
  const moved = (list: Inlay[], f: (x: number, y: number, z: number) => [number, number, number]) => list.map((x) => ({ name: x.name, colour: x.colour, raised: x.raised, mesh: movedMesh(x.mesh, f) }));
  const be = extent(b.base, ...own('base').map((x) => x.mesh));
  const down = (px: number, py: number, pz: number): [number, number, number] => [px, py, pz - be.z0];
  const out: PlatePart[] = [{ name: 'Base', mesh: Math.abs(be.z0) > 1e-6 ? movedMesh(b.base, down) : b.base, inlays: moved(own('base'), down) }];
  let x = be.x1 + 8;
  for (const [name, m, list] of [['Top', b.top, own('top')] as const, ...b.extras.map((e) => [e.name, e.mesh, [] as Inlay[]] as const)]) {
    const e = extent(m, ...list.map((q) => q.mesh)), at = x;
    const f = (px: number, py: number, pz: number): [number, number, number] => [px - e.x0 + at, -py, e.z1 - pz];
    out.push({ name, mesh: movedMesh(m, f), inlays: moved(list, f) });
    x += e.x1 - e.x0 + 8;
  }
  return out;
}
