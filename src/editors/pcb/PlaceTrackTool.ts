import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord, parseLength } from '../../core/units';
import { changedBagDefaults } from '../../model/bagDefaults';
import { addPrimRecords, addTracks } from '../../model/pcbEdit';
import { encodeArc, type TrackFields } from '../../formats/altium/pcbdoc';
import { ARC, put } from '../../formats/altium/pcbLayouts';
import { styleCorners } from '../../model/hugStyle';
import { layerColour, layerName } from '../../model/layers';
import { settings } from '../../core/settings';
import { PCB_CORNER_MODES, arcKey, arcRadius, arcSegments, cornerLabel, cornerPath, isArcMode, type CornerMode } from '../corner';
import type { PcbEditor } from './PcbEditor';

/**
 * Place › Track (P, T) and Place › Line: manual track placement on the current layer, no router.
 * Click to start/commit corners, right-click finishes, Shift+Space cycles AD's corner modes (45°,
 * 45° with arc, 90°, 90° with arc, any angle), Space flips the corner, , and . shrink and grow the
 * arcs, * switches signal layer (committing what is placed so far), Backspace undoes the last
 * corner. Width comes from the Properties panel while the tool is active.
 */
/** An arc record a keepout or not as asked (as tracks are: flags 2), whatever the template was. */
const arcRecord = (r: ReturnType<typeof encodeArc>, keepout: boolean) => { put(r.subs[0]!, ARC.flags2, keepout ? 2 : 0); return r; };

export class PlaceTrackTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = settings.pcbTrackCorner;
  private flip = false;

  /** keepout: Place › Keepout › Track. */
  constructor(private ed: PcbEditor, private keepout = false) { this.id = keepout ? 'place-keepout-track' : 'place-track'; }
  /** The line's width: the routing width, or for a keepout the one Preferences › Defaults › Keepout Track gives (0: the routing width). */
  private get width(): number { const k = this.keepout ? parseLength(changedBagDefaults('Keepout Track').LINEWIDTH ?? '') : undefined; return k && k > 0 ? Math.round(k) : this.ed.trackWidth; }

  hint(): string {
    const l = layerName(this.ed.currentLayer), w = formatCoord(this.width, this.ed.units());
    return this.pts.length
      ? `Track on ${l}, ${w} wide (${cornerLabel(this.mode, this.flip)}${isArcMode(this.mode) ? `, radius ${formatCoord(arcRadius(this.width), this.ed.units())}: , . smaller, larger` : ''}). Click for a corner, right-click to finish, Shift+Space corner mode, * for next layer`
      : `Click to start a track on ${l}, ${w} wide`;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.world]; return; }
    this.pts.push(...cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip));
  }
  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  cancel(): boolean {
    if (this.pts.length >= 2) { this.commit(); return true; }
    if (this.pts.length === 1) { this.pts = []; return true; }
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'Shift+Space': this.mode = PCB_CORNER_MODES[(PCB_CORNER_MODES.indexOf(this.mode) + 1) % PCB_CORNER_MODES.length]!; return true;
      case ',': case '.': case '<': case '>': return isArcMode(this.mode) && arcKey(combo, this.width);
      case 'Backspace': if (this.pts.length > 1) this.pts.pop(); else this.pts = []; return true;
      case 'Escape': case 'Enter': return this.cancel();
      case '*': {
        const last = this.pts.at(-1);
        if (this.pts.length >= 2) this.commit();
        this.ed.nextSignalLayer();
        if (last) this.pts = [last]; // continue from the same point (via insertion comes with the router)
        return true;
      }
    }
    return false;
  }

  private commit(): void {
    const pts = this.pts;
    this.pts = [];
    if (pts.length < 2 || this.ed.currentLayer > 82) return; // extended mech layers need V7 encoding
    const segs: TrackFields[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      if (a.x !== b.x || a.y !== b.y) segs.push({ layer: this.ed.currentLayer, a, b, width: this.width });
    }
    if (!segs.length) return;
    const doc = this.ed.doc;
    // The arc corner modes: each corner an arc (as large as asked, as the legs allow)
    const styled = isArcMode(this.mode) ? styleCorners(segs, 'arcs', () => null, { radius: arcRadius(this.width) }) : { tracks: segs, arcs: [] };
    this.ed.undo.transact(this.keepout ? 'Place keepout track' : 'Place track', (tx) => {
      if (styled.tracks.length) tx.add(addTracks(doc, styled.tracks, this.keepout));
      if (styled.arcs.length) tx.add(addPrimRecords(doc, styled.arcs.map((a) => ({ storage: 'Arcs6', rec: arcRecord(encodeArc(a, doc.streams.get('Arcs6')?.records[0]), this.keepout) }))));
    });
  }

  overlay(): ToolOverlay | null {
    if (!this.pts.length || !this.hover) return null;
    const pts = [...this.pts, ...cornerPath(this.pts.at(-1)!, this.hover, this.mode, this.flip)];
    const segments = [];
    const color = layerColour(this.ed.currentLayer), width = this.width;
    const segs: TrackFields[] = [];
    for (let i = 1; i < pts.length; i++) if (pts[i - 1]!.x !== pts[i]!.x || pts[i - 1]!.y !== pts[i]!.y) segs.push({ layer: this.ed.currentLayer, a: pts[i - 1]!, b: pts[i]!, width });
    const styled = isArcMode(this.mode) ? styleCorners(segs, 'arcs', () => null, { radius: arcRadius(width) }) : { tracks: segs, arcs: [] };
    for (const t of styled.tracks) segments.push({ a: t.a, b: t.b, width, color });
    for (const a of styled.arcs) for (const [p, q] of arcSegments(a.c, a.r, a.start, a.end)) segments.push({ a: p, b: q, width, color });
    return { segments };
  }

  deactivate(): void { if (this.pts.length >= 2) this.commit(); }
}
