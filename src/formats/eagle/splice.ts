/**
 * R13, an EAGLE board changed in places: written as EAGLE wrote it but for what changed. Its parts
 * moved or turned on their side take their new places (their smashed names and values with them); a
 * signal whose routes changed in Konium (rerouted, a track moved, added or taken away) has its
 * wires and vias written from Konium's, its pad references and polygons as they were; everything
 * else is EAGLE's, element for element, attribute for attribute. While the rest of the board (its
 * parts' footprints, pads and their nets, names and values, its outline, drawings, polygons, nets,
 * rules) is what the import made; a part turned over to the other side, or a route on a net with no
 * signal of its own, and the export writes the whole board from Konium's. EAGLE pours its polygons
 * itself: the copper Konium poured them with is not EAGLE's to keep.
 */
import { cfbStream } from '../cfb/cfb';
import { UNITS_PER_MM } from '../../core/units';
import { L } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { readJson } from '../kicad/padPrims';
import { parseTree, writeTree, xattr, xfrom, xkid, xkidsNamed, type XNode } from '../xmlTree';
import { EAGLE_SOURCE, eaglePartSig, eaglePlace, eagleRestSig, eagleRouteSigs, isRouteCopper } from './kept';

export interface EagleSpliced { bytes: Uint8Array; moved: number; rerouted: number }

const norm = (a: number) => ((a % 360) + 360) % 360;
const num = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
const setAttr = (e: XNode, k: string, v: string | undefined) => {
  const i = e.attrs.findIndex(([a]) => a === k);
  if (v === undefined) { if (i >= 0) e.attrs.splice(i, 1); return; }
  if (i >= 0) e.attrs[i]![1] = v; else e.attrs.push([k, v]);
};
/** EAGLE's rotation: spun, mirrored, the angle. */
const rotOf = (s: string | undefined) => { const m = /^(S?)(M?)R(-?[\d.]+)$/.exec(s ?? ''); return { spin: !!m?.[1], mirror: !!m?.[2], angle: m ? norm(Number(m[3])) : 0 }; };
const rotText = (spin: boolean, mirror: boolean, angle: number) => `${spin ? 'S' : ''}${mirror ? 'M' : ''}R${num(Math.round(norm(angle) * 1000) / 1000)}`;

/** The board as EAGLE wrote it, what changed in Konium written from Konium's; null when the board changed otherwise (or wasn't read from an EAGLE file). */
export function eagleSplice(doc: PcbDocument): EagleSpliced | null {
  const bag = doc.board.bag;
  const routes0 = bag?.get('EAGLEROUTES'), rest0 = bag?.get('EAGLEREST');
  if (!bag || !routes0 || !rest0) return null;
  const src = cfbStream(doc.cfb.root, `${EAGLE_SOURCE}/Data`);
  if (!src) return null;
  if (String(doc.components.length) !== bag.get('EAGLEPARTS') || eagleRestSig(doc) !== rest0) return null;
  const byComp = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if ('component' in p && p.component !== NO_NET && p.component >= 0) byComp.set(p.component, [...(byComp.get(p.component) ?? []), p]);
  for (let ci = 0; ci < doc.components.length; ci++) if (doc.components[ci]!.bag.get('EAGLEPART') !== eaglePartSig(doc, ci, byComp.get(ci) ?? [])) return null;
  const was = (readJson(routes0) ?? {}) as Record<string, string>;
  const now = eagleRouteSigs(doc);
  const changed = [...new Set([...Object.keys(was), ...now.keys()])].filter((k) => was[k] !== now.get(k));
  const moved = doc.components.filter((c) => c.bag.get('EAGLEPLACE') !== eaglePlace(c.bag));
  if (!changed.length && !moved.length) return { bytes: src, moved: 0, rerouted: 0 };

  const text = new TextDecoder().decode(src);
  const { prolog, root } = parseTree(text);
  const tail = text.slice(text.lastIndexOf('>') + 1);
  const board = xkid(xkid(root, 'drawing'), 'board');
  if (!board) return null;
  const elements = new Map(xkidsNamed(xkid(board, 'elements'), 'element').map((e) => [xattr(e, 'name') ?? '', e]));
  const signals = new Map(xkidsNamed(xkid(board, 'signals'), 'signal').map((e) => [xattr(e, 'name') ?? '', e]));
  const o = doc.board.origin;
  const mm = (v: number, o0: number) => (v - o0) / UNITS_PER_MM;
  const layers = new Map((bag.get('EAGLELAYERS') ?? '').split(',').filter(Boolean).map((e) => e.split(':').map(Number) as [number, number]));

  /* Parts moved: their places, turns and smashed texts */
  for (const c of moved) {
    const el = elements.get(c.designator);
    if (!el) return null;
    const r0 = rotOf(xattr(el, 'rot'));
    const mirror = c.layer === L.BOTTOM;
    if (mirror !== r0.mirror) return null;
    const a2 = mirror ? norm(180 - c.rotation) : norm(c.rotation);
    const x1 = Number(xattr(el, 'x') ?? 0), y1 = Number(xattr(el, 'y') ?? 0);
    const x2 = mm(c.at.x, o.x), y2 = mm(c.at.y, o.y);
    // The world's turn from the old place to the new (EAGLE's M·R(a): mirrored, the other way)
    const d = mirror ? r0.angle - a2 : a2 - r0.angle;
    const dr = (d * Math.PI) / 180, cs = Math.cos(dr), sn = Math.sin(dr);
    setAttr(el, 'x', num(x2)); setAttr(el, 'y', num(y2));
    setAttr(el, 'rot', a2 || mirror || r0.spin ? rotText(r0.spin, mirror, a2) : undefined);
    for (const at of xkidsNamed(el, 'attribute')) {
      const ax = xattr(at, 'x'), ay = xattr(at, 'y');
      if (ax === undefined || ay === undefined) continue;
      const rx = Number(ax) - x1, ry = Number(ay) - y1;
      setAttr(at, 'x', num(x2 + rx * cs - ry * sn)); setAttr(at, 'y', num(y2 + rx * sn + ry * cs));
      const t = rotOf(xattr(at, 'rot'));
      const ta = t.mirror ? t.angle - d : t.angle + d;
      setAttr(at, 'rot', norm(ta) || t.mirror || t.spin ? rotText(t.spin, t.mirror, ta) : undefined);
    }
  }

  /* Signals rerouted: their wires and vias from Konium's */
  const byNet = new Map<string, PcbPrim[]>();
  for (const p of doc.prims) {
    if (!isRouteCopper(p)) continue;
    const n = doc.nets[(p as { net: number }).net];
    const k = n?.bag.get('EAGLESIGNAL') ?? n?.name ?? '';
    byNet.set(k, [...(byNet.get(k) ?? []), p]);
  }
  for (const name of changed) {
    const sig = signals.get(name);
    if (!sig) return null;
    // Out: the signal's wires and vias (and the line breaks before them)
    const kids: (XNode | string)[] = [];
    for (const k of sig.kids) {
      if (typeof k !== 'string' && (k.name === 'wire' || k.name === 'via')) { if (typeof kids.at(-1) === 'string' && /^\s*$/.test(kids.at(-1) as string)) kids.pop(); continue; }
      kids.push(k);
    }
    // In: Konium's, before the signal's closing tag
    const end = typeof kids.at(-1) === 'string' && /^\s*$/.test(kids.at(-1) as string) ? kids.pop() as string : '\n';
    for (const p of byNet.get(name) ?? []) {
      let xml: string;
      if (p.kind === 'track' || p.kind === 'arc') {
        const n = layers.get(p.layer);
        if (n === undefined) return null;
        if (p.kind === 'track') xml = `<wire x1="${num(mm(p.a.x, o.x))}" y1="${num(mm(p.a.y, o.y))}" x2="${num(mm(p.b.x, o.x))}" y2="${num(mm(p.b.y, o.y))}" width="${num(p.width / UNITS_PER_MM)}" layer="${n}"/>`;
        else {
          const sweep = norm(p.end - p.start) || 360;
          const at = (a: number) => ({ x: p.c.x + p.r * Math.cos((a * Math.PI) / 180), y: p.c.y + p.r * Math.sin((a * Math.PI) / 180) });
          const s = at(p.start), e = at(p.start + sweep);
          xml = `<wire x1="${num(mm(s.x, o.x))}" y1="${num(mm(s.y, o.y))}" x2="${num(mm(e.x, o.x))}" y2="${num(mm(e.y, o.y))}" width="${num(p.width / UNITS_PER_MM)}" layer="${n}" curve="${num(sweep)}"/>`;
        }
      } else if (p.kind === 'via') {
        const a = layers.get(p.layerStart), b = layers.get(p.layerEnd);
        if (a === undefined || b === undefined) return null;
        xml = `<via x="${num(mm(p.at.x, o.x))}" y="${num(mm(p.at.y, o.y))}" extent="${Math.min(a, b)}-${Math.max(a, b)}" drill="${num(p.hole / UNITS_PER_MM)}" diameter="${num(p.diameter / UNITS_PER_MM)}"/>`;
      } else continue;
      kids.push('\n', xfrom(xml));
    }
    kids.push(end);
    sig.kids = kids;
    sig.empty = false;
  }
  return { bytes: new TextEncoder().encode(prolog + writeTree(root) + tail), moved: moved.length, rerouted: changed.length };
}
