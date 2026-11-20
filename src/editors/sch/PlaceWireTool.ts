import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { addRecords, wireBag } from '../../model/schEdit';
import { settings } from '../../core/settings';
import { SCH_UNIT } from '../../core/units';
import { afterWire } from '../../model/wireTidy';
import { CORNER_MODES, cornerLabel, cornerPath, type CornerMode } from '../corner';
import type { SchEditor } from './SchEditor';
import { capture, defaultHides, defaultItems, lay, schKind, setSchDefault, storedDefault, withDefault, type SchDefault } from '../../model/schDefaults';

/**
 * Place › Wire (P, W). Click to start, click to add corners, right-click or Esc to finish the
 * current wire (a second right-click leaves the tool). Space flips the corner, Shift+Space
 * cycles 90° / 45° / any angle, Backspace removes the last corner.
 */
export class PlaceWireTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = settings.schWireCorner;
  private flip = false;
  /** Tab's change, for this placing. */
  private mine: SchDefault | undefined;

  constructor(private ed: SchEditor, private bus = false) { this.id = bus ? 'place-bus' : 'place-wire'; }

  hint(): string {
    const what = this.bus ? 'bus' : 'wire';
    return this.pts.length
      ? `Placing ${what} (${cornerLabel(this.mode, this.flip)}). Click for a corner, right-click to finish, Shift+Space for corner mode`
      : `Click to start a ${what} (Tab for its properties)`;
  }

  private preview(): Vec2[] {
    if (!this.pts.length || !this.hover) return this.pts;
    return [...this.pts, ...cornerPath(this.pts.at(-1)!, this.hover, this.mode, this.flip)];
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.world]; return; }
    const next = cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip);
    this.pts.push(...next);
    this.pts = dedupe(this.pts);
  }

  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  /** Right click: finish current wire; if nothing in progress, leave the tool. */
  cancel(): boolean {
    if (this.pts.length >= 2) { this.commit(); return true; }
    if (this.pts.length === 1) { this.pts = []; return true; }
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'Shift+Space': this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; return true;
      case 'Backspace': if (this.pts.length > 1) this.pts.pop(); else this.pts = []; return true;
      case 'Escape': return this.cancel();
      case 'Enter': return this.cancel();
      case 'Tab': {
        // The wire's (or bus's) properties: this one and those after it take them, and they are the default from now on unless Permanent is on
        const edit = this.ed.placeProps, kind = schKind(this.bus ? 'Bus' : 'Wire');
        if (!edit || !kind) return false;
        edit(defaultItems(this.ed.doc, kind, this.mine ?? storedDefault(kind.name))[0]!.bag, (b) => {
          this.mine = capture(this.ed.doc, kind, [b]);
          if (!settings.schDefaultsPermanent) setSchDefault(kind.name, this.mine, true);
        }, defaultHides(kind));
        return true;
      }
    }
    return false;
  }

  private commit(): void {
    const pts = dedupe(this.pts);
    this.pts = [];
    if (pts.length < 2) return;
    // The wire or bus as Preferences › Default Primitives has it (or as Tab left it for this placing)
    const doc = this.ed.doc, fresh = wireBag(pts, { bus: this.bus }), bag = this.mine ? lay(doc, fresh, this.mine) : withDefault(doc, fresh);
    const step = Math.max(this.ed.gridSize(), 10 * SCH_UNIT);
    this.ed.undo.transact(this.bus ? 'Place bus' : 'Place wire', (tx) => {
      tx.add(addRecords(doc, [bag]));
      afterWire(doc, bag.get('UNIQUEID') ?? '', {
        breakAtJunctions: settings.schBreakAtAutoJunctions, optimize: settings.schOptimizeWires,
        autoEntries: settings.schAutoSheetEntries, convertCross: settings.schConvertCrossJunctions, step, grid: this.ed.gridSize(),
      }, (c) => tx.add(c));
    });
  }

  overlay(): ToolOverlay | null {
    const pts = this.preview();
    if (pts.length < 2) return null;
    const w = this.bus ? mil(30) : mil(10);
    const segments = [];
    for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1]!, b: pts[i]!, width: w, color: 0x1d4f91 });
    return { segments };
  }

  deactivate(): void { if (this.pts.length >= 2) this.commit(); }
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && last.x === p.x && last.y === p.y) continue;
    // merge collinear runs
    if (out.length >= 2) {
      const a = out.at(-2)!, b = last!;
      if ((b.x - a.x) * (p.y - b.y) === (b.y - a.y) * (p.x - b.x)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}
