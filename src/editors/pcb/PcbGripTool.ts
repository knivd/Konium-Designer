import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { repour, replaceRecords, setPolygon } from '../../model/pcbEdit';
import { writeVertices } from '../../formats/altium/pcbdoc';
import { TRACK, put } from '../../formats/altium/pcbLayouts';
import { transformRecord } from '../../formats/altium/pcbTransform';
import { NO_NET, type PcbPrim, type PcbTrack, type PcbVia, type PolyVertex } from '../../model/pcb';
import { isSignal, layerColour } from '../../model/layers';
import { hexToRgb, settings } from '../../core/settings';
import type { PcbEditor } from './PcbEditor';

/** Grip index offset of an edge's midpoint handle (dragging it adds a vertex there). */
export const EDGE_GRIP = 10_000;

/** Drop repeated and exactly collinear vertices (dragging a vertex onto a neighbour removes it). */
export function tidyVertices(vs: PolyVertex[]): PolyVertex[] {
  let out = vs.filter((v, i) => { const n = vs[(i + 1) % vs.length]!; return v.arc || n === v || v.p.x !== n.p.x || v.p.y !== n.p.y; });
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length]!, b = out[i]!, c = out[(i + 1) % out.length]!;
      if (a.arc || b.arc) continue;
      const cross = (b.p.x - a.p.x) * (c.p.y - a.p.y) - (b.p.y - a.p.y) * (c.p.x - a.p.x);
      if (cross === 0) { out = out.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return out;
}

/** A polygon's vertices with grip k moved to p (a vertex), or a vertex added (an edge midpoint). */
export function moveVertex(vs: PolyVertex[], k: number, p: Vec2): PolyVertex[] {
  const n = vs.length;
  if (k >= EDGE_GRIP) {
    const e = k - EDGE_GRIP;
    const out = vs.map((v, i) => (i === e ? { p: v.p } : v));
    out.splice(e + 1, 0, { p });
    return out;
  }
  // The edges either side of a moved vertex become straight
  return vs.map((v, i) => (i === k ? { p } : i === (k + n - 1) % n ? { p: v.p } : v));
}

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
/** Free tracks: not locked, not part of a component or a pour. */
const free = (p: PcbPrim): p is PcbTrack => p.kind === 'track' && !p.locked && p.component === NO_NET && p.polygon === NO_NET && !p.keepout;

/**
 * Dragging a handle of the selected object: a polygon pour's vertex or edge midpoint (Altium's
 * polygon editing handles; repours on release), or a track's end. Release keeps the change,
 * Esc or right-click puts it back.
 *
 * A track's end that other tracks of its net end on too is their joint, and the joint is what
 * moves: every segment that meets there stretches to it (as AD's vertex does; moving the one end
 * alone broke the track in two). A via on the joint goes with it, and so does everything that ends
 * on the via on its other layers. An end on a pad simply leaves the pad, alone.
 */
export class PcbGripTool implements Tool {
  readonly id = 'pcb-grip';
  private pos: Vec2;
  /** The other tracks that end on the dragged end, and which of their ends. */
  private joined: { t: PcbTrack; ends: ('a' | 'b')[] }[] = [];
  private via: PcbVia | null = null;

  constructor(private ed: PcbEditor, private target: { polygon: number } | { track: Extract<PcbPrim, { kind: 'track' }> }, private k: number, at: Vec2) {
    this.pos = at;
    if ('polygon' in target) return;
    const t = target.track, end = k === 0 ? t.a : t.b, prims = ed.doc.prims;
    const onLayer = (v: PcbVia) => { const st = ed.doc.board.copperStack.filter(isSignal), a = st.indexOf(v.layerStart), b = st.indexOf(v.layerEnd), l = st.indexOf(t.layer); return a < 0 || b < 0 || l < 0 || (l >= Math.min(a, b) && l <= Math.max(a, b)); };
    if (prims.some((p) => p.kind === 'pad' && same(p.at, end))) return;
    this.via = prims.find((p): p is PcbVia => p.kind === 'via' && !p.locked && p.net === t.net && same(p.at, end) && onLayer(p)) ?? null;
    for (const p of prims) {
      if (p === t || !free(p) || p.net !== t.net || (!this.via && p.layer !== t.layer)) continue;
      const ends = (['a', 'b'] as const).filter((e) => same(p[e], end));
      if (ends.length) this.joined.push({ t: p, ends: [...ends] });
    }
  }

  hint(): string {
    const o = this.ed.origin(), u = this.ed.units(), p = this.ed.snap(this.pos);
    const what = 'polygon' in this.target ? (this.k >= EDGE_GRIP ? 'Adding a vertex' : 'Moving a vertex')
      : this.via ? 'Moving the via and the tracks that end on it' : this.joined.length ? `Moving the joint of ${this.joined.length + 1} tracks` : 'Moving the track end';
    return `${what} to ${formatCoord(p.x - o.x, u)}, ${formatCoord(p.y - o.y, u)}. Release to keep, Esc to put it back`;
  }

  private vertices(): PolyVertex[] | null {
    if (!('polygon' in this.target)) return null;
    const poly = this.ed.doc.polygons[this.target.polygon];
    return poly ? moveVertex(poly.vertices, this.k, this.ed.snap(this.pos)) : null;
  }

  pointerMove(p: ToolPointer): void { this.pos = p.raw; }

  pointerUp(p: ToolPointer): void {
    this.pos = p.raw;
    const ed = this.ed, doc = ed.doc, at = ed.snap(this.pos);
    if ('polygon' in this.target) {
      const i = this.target.polygon, poly = doc.polygons[i];
      const vs = this.vertices();
      if (poly && vs) {
        const tidy = tidyVertices(vs);
        if (tidy.length >= 3 && JSON.stringify(tidy) !== JSON.stringify(poly.vertices)) {
          const bag = poly.bag.clone();
          writeVertices(bag, tidy);
          ed.undo.transact(this.k >= EDGE_GRIP ? 'Add polygon vertex' : 'Move polygon vertex', (tx) => {
            tx.add(setPolygon(doc, i, bag));
            if (settings.pcbRepourAfterModification) tx.add(repour(doc, i));
          });
          ed.select([`poly:${i}`]);
        }
      }
    } else {
      const t = this.target.track;
      const end = this.k === 0 ? t.a : t.b;
      if (at.x !== end.x || at.y !== end.y) {
        const edits: Parameters<typeof replaceRecords>[1] = [];
        // The dragged end, and with it the ends of the tracks joined to it there
        for (const { t: q, ends } of [{ t, ends: [this.k === 0 ? 'a' : 'b'] as ('a' | 'b')[] }, ...this.joined]) {
          const rec = doc.streams.get(q.src.storage)?.records[q.src.index];
          if (!rec) continue;
          const s = rec.subs[0]!.slice();
          if (ends.includes('a')) { put(s, TRACK.x1, at.x); put(s, TRACK.y1, at.y); }
          if (ends.includes('b')) { put(s, TRACK.x2, at.x); put(s, TRACK.y2, at.y); }
          edits.push({ storage: q.src.storage, index: q.src.index, after: { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] } });
        }
        const v = this.via, vrec = v ? doc.streams.get(v.src.storage)?.records[v.src.index] : undefined;
        if (v && vrec) edits.push({ storage: v.src.storage, index: v.src.index, after: transformRecord(vrec, (q) => ({ x: q.x + at.x - v.at.x, y: q.y + at.y - v.at.y }), 0, { storage: v.src.storage }) });
        ed.undo.transact('Move track end', (tx) => tx.add(replaceRecords(doc, edits)));
      }
    }
    ed.setTool(null);
  }

  key(combo: string): boolean { if (combo === 'Escape') { this.ed.setTool(null); return true; } return false; }
  cancel(): boolean { return false; }
  abort(): void { this.ed.setTool(null); }

  overlay(): ToolOverlay | null {
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const sel = hexToRgb(settings.selectionColour);
    if ('polygon' in this.target) {
      const vs = this.vertices();
      if (!vs) return null;
      const col = layerColour(this.ed.doc.polygons[this.target.polygon]!.layer);
      for (let i = 0; i < vs.length; i++) segments.push({ a: vs[i]!.p, b: vs[(i + 1) % vs.length]!.p, width: 0, color: i === this.k || (i + 1) % vs.length === this.k ? sel : col });
    } else {
      const t = this.target.track, at = this.ed.snap(this.pos);
      segments.push({ a: this.k === 0 ? at : t.a, b: this.k === 0 ? t.b : at, width: t.width, color: layerColour(t.layer) });
      for (const { t: q, ends } of this.joined) segments.push({ a: ends.includes('a') ? at : q.a, b: ends.includes('b') ? at : q.b, width: q.width, color: layerColour(q.layer) });
      if (this.via) return { segments, circles: [{ c: at, r: this.via.diameter / 2, color: hexToRgb(settings.pcbViaColour) }, { c: at, r: this.via.hole / 2, color: hexToRgb(settings.pcbHoleColour) }] };
    }
    return { segments };
  }
}
