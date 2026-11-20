import { PcbEditor, primKey } from './PcbEditor';
import { commitMove } from './PcbMoveTool';
import { placement } from '../../formats/altium/pcbTransform';
import type { Vec2 } from '../../core/geom';
import type { HitItem, PropSection } from '../Editor';
import { Scene, rgba } from '../../render/Scene';
import { formatCoord, mil } from '../../core/units';
import { embeddedModels, linkedModels, type ModelFiles } from '../../render/gl3d/stepBodies';
import { footprintDoc, uniqueFootprintName, type FootprintEntry, type PcbLibDocument } from '../../model/pcbLib';
import type { Change } from '../../core/undo';
import type { PcbRawRecord } from '../../formats/altium/framing';
import type { Scope } from '../../core/commands';

/**
 * The PCB Library editor: the PCB editor on one footprint at a time (origin at the footprint
 * origin, no board). The PCB Library panel switches footprints; adding, deleting and
 * renaming footprints are undoable like any edit.
 */
export class PcbLibEditor extends PcbEditor {
  override readonly scope: Scope = 'pcblib';
  current = 0;

  constructor(readonly lib: PcbLibDocument) {
    super(lib.footprints[0]?.doc ?? footprintDoc('PCBCOMPONENT_1', []));
    if (!lib.footprints.length) lib.footprints.push({ name: 'PCBCOMPONENT_1', description: '', height: '0mil', doc: this.doc });
  }

  get entry(): FootprintEntry { return this.lib.footprints[this.current]!; }
  /** A library keeps its models in Library/Models. */
  override modelFiles(): ModelFiles { return this.lib.lib ? embeddedModels(this.lib.lib.cfb.root, 'Library/Models') : new Map(); }
  override linkedModelNames(): Map<string, string> { return this.lib.lib ? linkedModels(this.lib.lib.cfb.root, 'Library/ModelsNoEmbed') : new Map(); }

  override title(): string { return this.lib.name; }

  showFootprint(i: number): void {
    const e = this.lib.footprints[i];
    if (!e) return;
    // A tool working on the footprint shown (the primitives it holds) ends first
    if ((i !== this.current || e.doc !== this.doc) && this.tool !== this.selectTool) this.setTool(null);
    this.current = i;
    this.doc = e.doc;
    this.selection.clear();
    this.violations = [];
    this.invalidate();
    this.fitObjects();
  }

  /** No online DRC in the library: pads of one footprint are No Net and may sit close together. */
  override onlineDrc(): void { if (this.violations.length) { this.violations = []; this.invalidateOverlay(); } }

  override fitObjects(): void {
    if (this.view3d) { this.view3d.fit(); return; }
    this.scene();
    if (!this.items.length) { this.viewport?.fitBox({ minX: -mil(250), minY: -mil(250), maxX: mil(250), maxY: mil(250) }); return; }
    super.fitObjects();
  }
  override fit(): void { this.fitObjects(); }

  /** Altium marks the footprint origin with a cross. */
  protected override build(scene: Scene, emit: (it: HitItem) => void): void {
    super.build(scene, emit);
    const g = scene.group('origin', 900);
    const c = rgba(0xd0d0d0, 0.8), d = mil(25);
    scene.segment(g, { x: -d, y: 0 }, { x: d, y: 0 }, 0, c, 1);
    scene.segment(g, { x: 0, y: -d }, { x: 0, y: d }, 0, c, 1);
  }

  /* ── footprint list edits (undoable) ── */
  private structural(label: string, apply: () => void, revert: () => void): void {
    const lib = this.lib;
    const change: Change = { apply() { apply(); lib.version++; }, revert() { revert(); lib.version++; } };
    this.undo.transact(label, (tx) => tx.add(change));
  }

  /** Tools › New Blank Footprint. */
  newFootprint(): void {
    const name = uniqueFootprintName(this.lib);
    const e: FootprintEntry = { name, description: '', height: '0mil', doc: footprintDoc(name, []) };
    const at = this.lib.footprints.length;
    this.structural(`New footprint ${name}`, () => { this.lib.footprints.splice(at, 0, e); this.showFootprint(at); },
      () => { this.lib.footprints.splice(at, 1); this.showFootprint(Math.min(this.current, this.lib.footprints.length - 1)); });
  }

  /** Edit › Paste Component: a copied footprint joins this library (renamed if the name is taken), shown. */
  insertFootprint(name: string, description: string, height: string, records: PcbRawRecord[]): void {
    const taken = new Set(this.lib.footprints.map((f) => f.name.toLowerCase()));
    let n = name;
    for (let i = 1; taken.has(n.toLowerCase()); i++) n = `${name}_${i}`;
    const e: FootprintEntry = { name: n, description, height, doc: footprintDoc(n, records.map((r) => ({ tag: r.tag, subs: r.subs.map((x) => x.slice()) }))) };
    const at = this.current + 1;
    this.structural(`Paste footprint ${n}`, () => { this.lib.footprints.splice(at, 0, e); this.showFootprint(at); },
      () => { this.lib.footprints.splice(at, 1); this.showFootprint(Math.min(this.current, this.lib.footprints.length - 1)); });
  }

  deleteFootprint(i = this.current): void {
    const e = this.lib.footprints[i];
    if (!e || this.lib.footprints.length < 2) return;
    this.structural(`Delete footprint ${e.name}`, () => {
      this.lib.footprints.splice(i, 1);
      if (e.storage) this.lib.removed.push(e.storage);
      this.showFootprint(Math.min(i, this.lib.footprints.length - 1));
    }, () => {
      this.lib.footprints.splice(i, 0, e);
      if (e.storage) this.lib.removed.splice(this.lib.removed.lastIndexOf(e.storage), 1);
      this.showFootprint(i);
    });
  }

  /** Footprint properties: Name, Height, Description. */
  setFootprintProps(i: number, p: { name: string; height: string; description: string }): void {
    const e = this.lib.footprints[i];
    if (!e) return;
    const before = { name: e.name, height: e.height, description: e.description };
    if (before.name === p.name && before.height === p.height && before.description === p.description) return;
    this.structural(`Footprint ${p.name}`, () => { Object.assign(e, p); e.doc.name = p.name; }, () => { Object.assign(e, before); e.doc.name = before.name; });
  }

  /**
   * Edit › Set Reference: the footprint's origin moves to `p` — every primitive shifts by −p,
   * one undo step — so a placed component is held there.
   */
  setReference(p: Vec2): boolean {
    if (!p.x && !p.y) return false;
    const keep = this.selection;
    this.selection = new Set(this.doc.prims.map(primKey));
    const set = this.moveSet();
    if (set.prims.length || set.components.length || set.polygons.length) commitMove(this, set, placement({ x: 0, y: 0 }, 0, { x: -p.x, y: -p.y }), 0, 'move', 'Set reference');
    this.selection = keep;
    this.invalidate();
    return true;
  }
  /** Set Reference › Pin 1: pad 1 (else the lowest-numbered pad). */
  pin1(): Vec2 | null {
    const pads = this.doc.prims.filter((p): p is Extract<typeof p, { kind: 'pad' }> => p.kind === 'pad');
    const one = pads.find((p) => p.name === '1') ?? [...pads].sort((a, b) => (parseInt(a.name, 10) || 1e9) - (parseInt(b.name, 10) || 1e9) || a.name.localeCompare(b.name))[0];
    return one ? one.at : null;
  }
  /** Set Reference › Center: the middle of everything the footprint draws. */
  centre(): Vec2 | null {
    const b = this.boundsOf(this.doc.prims.map(primKey));
    return b.minX <= b.maxX ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
  }

  override documentProperties(): PropSection[] {
    const e = this.entry, u = this.units();
    const pads = e.doc.prims.filter((p) => p.kind === 'pad').length;
    return [
      { title: 'Footprint', rows: [
        { label: 'Name', value: e.name, edit: (v) => { if (v.trim()) this.setFootprintProps(this.current, { ...e, name: v.trim() }); } },
        { label: 'Height', value: e.height, edit: (v) => this.setFootprintProps(this.current, { ...e, height: v.trim() || '0mil' }) },
        { label: 'Description', value: e.description, edit: (v) => this.setFootprintProps(this.current, { ...e, description: v }) },
        { label: 'Pads', value: String(pads) },
        { label: 'Primitives', value: String(e.doc.prims.length) },
      ] },
      { title: 'Library', rows: [
        { label: 'Footprints', value: String(this.lib.footprints.length) },
        { label: 'Units', value: u },
        { label: 'Snap grid', value: formatCoord(this.gridSize(), u) },
      ] },
    ];
  }
}
