import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { addObjects, repour, retarget } from '../../model/pcbEdit';
import { decodePrim, layerFromName, parseWideStrings, readVertices, writeVertices } from '../../formats/altium/pcbdoc';
import { cfbStream } from '../../formats/cfb/cfb';
import { altiumFloat, placement, transformRecord, type PointMap } from '../../formats/altium/pcbTransform';
import { formatAltiumLength, parseLength } from '../../core/units';
import type { PcbRawRecord } from '../../formats/altium/framing';
import { NO_NET, type PcbPrim } from '../../model/pcb';
import { L, layerColour } from '../../model/layers';
import { settings } from '../../core/settings';
import type { PcbClip } from '../clipboard';
import { previewPrim } from './PcbMoveTool';
import type { PcbEditor } from './PcbEditor';

/**
 * Edit › Paste (Ctrl+V) and Rubber Stamp (Ctrl+R) on a board: the copied objects follow the
 * cursor by the copy's reference point; click places them (one undo step, pours repoured);
 * Space / Shift+Space turn by the rotation step; right-click or Esc ends. Nets are matched by
 * name; components come without their link to the schematic (as a fresh part).
 */
/** Placing new objects with the paste machinery (Place › Component): the next one after each click. */
export interface PcbPlaceOpts { id: string; what: string; next?: () => PcbClip }

export class PcbPasteTool implements Tool {
  readonly id: string;
  private pos: Vec2;
  private rot = 0;
  private preview: PcbPrim[] = [];

  constructor(private ed: PcbEditor, private clip: PcbClip, private stamp = false, private opts?: PcbPlaceOpts) {
    this.id = opts?.id ?? 'pcb-paste';
    this.pos = ed.cursor;
    this.setClip(clip);
  }

  private setClip(clip: PcbClip): void {
    this.clip = clip;
    const wide = this.ed.doc.cfb ? parseWideStrings(cfbStream(this.ed.doc.cfb.root, 'WideStrings6/Data')) : new Map<number, string>();
    const all = [...clip.records, ...clip.components.flatMap((c) => c.records)];
    this.preview = all.map((r, i) => decodePrim(r.storage, r.rec, i, wide)).filter((p): p is PcbPrim => !!p);
  }

  private count(): number { return this.clip.records.length + this.clip.components.length + this.clip.polygons.length; }
  hint(): string {
    if (this.opts) return `Place ${this.opts.what}: click to place, Space / Shift+Space rotate, right-click ends`;
    return `Paste ${this.count()} object${this.count() === 1 ? '' : 's'}: click to place${this.stamp ? ' (again and again)' : ''}, Space / Shift+Space rotate, right-click ends`;
  }

  private map(): PointMap {
    const at = this.ed.snap({ x: this.pos.x, y: this.pos.y });
    return placement(this.clip.ref, this.rot, { x: at.x - this.clip.ref.x, y: at.y - this.clip.ref.y });
  }

  pointerMove(p: ToolPointer): void { this.pos = p.raw; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    this.pos = p.raw;
    this.place();
    if (this.opts?.next) this.setClip(this.opts.next());
    if (!this.stamp) this.ed.setTool(null);
  }
  key(combo: string): boolean {
    const step = settings.pcbRotationStep || 90;
    if (combo === 'Space') { this.rot = (this.rot + step) % 360; return true; }
    if (combo === 'Shift+Space') { this.rot = (this.rot + 360 - step) % 360; return true; }
    return false;
  }

  private place(): void {
    const ed = this.ed, doc = ed.doc, map = this.map(), rot = this.rot;
    const byName = new Map(doc.nets.map((n) => [n.name, n.index]));
    const net = (n: number) => (n === NO_NET ? NO_NET : byName.get(this.clip.nets.get(n) ?? '') ?? NO_NET);
    const moved = (r: { storage: string; rec: PcbRawRecord }) => ({ storage: r.storage, rec: retarget(transformRecord(r.rec, map, rot, { storage: r.storage }), { net }) });
    const components = this.clip.components.map((c) => {
      const bag = c.bag.clone();
      const x = bag.get('X'), y = bag.get('Y');
      if (x && y) {
        const q = map({ x: lengthOf(x), y: lengthOf(y) });
        bag.set('X', fmtLen(q.x)); bag.set('Y', fmtLen(q.y));
      }
      bag.set('ROTATION', fmtAngle((Number(bag.get('ROTATION') ?? 0) + rot) % 360));
      bag.delete('SOURCEUNIQUEID'); bag.delete('UNIQUEID');
      return { bag, records: c.records.map(moved) };
    });
    const polygons = this.clip.polygons.map((b0) => {
      const b = b0.clone();
      b.set('NET', String(net(Number(b.get('NET') ?? NO_NET))));
      writeVertices(b, readVertices(b0).map((v) => ({ p: rnd(map(v.p)), arc: v.arc ? { c: map(v.arc.c), r: v.arc.r, sa: (v.arc.sa + rot) % 360, ea: (v.arc.ea + rot) % 360 } : undefined })));
      return b;
    });
    const firstPoly = doc.polygons.length;
    ed.undo.transact(this.opts ? `Place ${this.opts.what}` : `Paste ${this.count()} object${this.count() === 1 ? '' : 's'}`, (tx) => {
      tx.add(addObjects(doc, { records: this.clip.records.map(moved), components, polygons }));
      for (let i = 0; i < polygons.length; i++) tx.add(repour(doc, firstPoly + i));
    });
  }

  overlay(): ToolOverlay | null {
    const map = this.map();
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const circles: NonNullable<ToolOverlay['circles']> = [];
    for (const p of this.preview) if (!(p.kind === 'text' && p.hidden)) previewPrim(p, map, this.rot, segments, circles);
    for (const b of this.clip.polygons) {
      const o = readVertices(b).map((v) => map(v.p));
      const layer = layerFromName(b.get('LAYER') ?? 'TOP') ?? L.TOP;
      for (let k = 0; k < o.length; k++) segments.push({ a: o[k]!, b: o[(k + 1) % o.length]!, width: 0, color: layerColour(layer) });
    }
    return { segments, circles };
  }
}

const rnd = (v: Vec2): Vec2 => ({ x: Math.round(v.x), y: Math.round(v.y) });
const lengthOf = (s: string) => parseLength(s) ?? 0;
const fmtLen = (c: number) => formatAltiumLength(Math.round(c));
const fmtAngle = (a: number) => altiumFloat(a);
