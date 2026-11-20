import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { polygonName, setPolygonName } from '../../formats/altium/polygonProps';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { addPolygon, repour } from '../../model/pcbEdit';
import { writeVertices, layerFromName } from '../../formats/altium/pcbdoc';
import type { PropertyBag } from '../../formats/altium/props';
import { L, layerColour } from '../../model/layers';
import { settings } from '../../core/settings';
import { CORNER_MODES, baseMode, cornerLabel, cornerPath, type CornerMode } from '../corner';
import { tidyVertices } from './PcbGripTool';
import type { PcbEditor } from './PcbEditor';

/**
 * Place › Polygon Pour (P, G), after the Polygon Pour dialog: click the outline's vertices
 * (Shift+Space cycles the corner mode, Space flips it, Backspace takes the last vertex back);
 * right-click closes the outline and pours it. The tool stays for the next pour with the same
 * settings; right-click again (or Esc) leaves.
 */
export class PlacePolygonTool implements Tool {
  readonly id = 'place-polygon';
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = baseMode(settings.pcbTrackCorner);
  private flip = false;

  constructor(private ed: PcbEditor, private bag: PropertyBag) {}

  private get layer() { return layerFromName(this.bag.get('LAYER') ?? 'TOP') ?? L.TOP; }

  hint(): string {
    const o = this.ed.origin(), u = this.ed.units();
    const name = polygonName(this.bag) || 'polygon';
    if (!this.pts.length) return `Polygon Pour ${name} on ${this.ed.layerLabel(this.layer)}: click the first vertex`;
    const h = this.hover ?? this.pts.at(-1)!;
    return `${this.pts.length} vertices (${cornerLabel(this.mode, this.flip)}), cursor ${formatCoord(h.x - o.x, u)}, ${formatCoord(h.y - o.y, u)}. Click to add, right-click to close and pour, Backspace removes the last`;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.world]; return; }
    const path = cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip);
    for (const q of path) { const l = this.pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) this.pts.push(q); }
  }
  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  /** The outline as it would close now (with the corner to the cursor). */
  private outline(): Vec2[] {
    const pts = this.pts.slice();
    if (this.hover && pts.length) for (const q of cornerPath(pts.at(-1)!, this.hover, this.mode, this.flip)) { const l = pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) pts.push(q); }
    return pts;
  }

  cancel(): boolean {
    if (!this.pts.length) return false;
    this.commit();
    return true;
  }

  private commit(): void {
    const verts = tidyVertices(this.pts.map((p) => ({ p })));
    this.pts = [];
    if (verts.length < 3) return;
    const ed = this.ed, doc = ed.doc;
    const bag = this.bag.clone();
    const i = doc.polygons.length;
    bag.set('POURINDEX', String(i));
    writeVertices(bag, verts);
    ed.undo.transact(`Place polygon ${polygonName(bag)}`.trim(), (tx) => {
      tx.add(addPolygon(doc, bag));
      tx.add(repour(doc, i));
    });
    // The next pour gets the next automatic name
    // The next pour gets the next automatic name (a name typed in stays)
    const name = polygonName(this.bag);
    if (/_P\d{3}$/.test(name)) setPolygonName(this.bag, name.replace(/_P\d+$/, `_P${String(i + 1).padStart(3, '0')}`));
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'Shift+Space': this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; return true;
      case 'Backspace': this.pts.pop(); return true;
      case 'Enter': if (this.pts.length) { this.commit(); return true; } return false;
      case 'Escape': if (this.pts.length) { this.pts = []; return true; } return false;
    }
    return false;
  }

  overlay(): ToolOverlay | null {
    const pts = this.outline();
    if (pts.length < 2) return null;
    const c = layerColour(this.layer);
    const segments: NonNullable<ToolOverlay['segments']> = [];
    for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1]!, b: pts[i]!, width: 0, color: c });
    // The closing edge, as Altium shows it while placing
    if (pts.length > 2) segments.push({ a: pts.at(-1)!, b: pts[0]!, width: 0, color: (c & 0xfefefe) >> 1 });
    return { segments };
  }
}
