/**
 * The schematic library editor: one symbol at a time, drawn and edited with the schematic
 * tools (library mode: no sheet, graphics picked one by one), parts A, B … of a multi-part
 * package shown one at a time. Every edit is one undo step that also brings its symbol back on
 * screen, so undo works across components. Tools › New Component / Remove Component / Rename,
 * New Part / Remove Part, Goto (first, next, previous, last component and part).
 */
import { SchEditor } from './SchEditor';
import { settings } from '../../core/settings';
import { partLetter, SR, rederive, type SchDocument } from '../../model/sch';
import { newSymbol, symbolView, viewBags, type SchLibDocument } from '../../model/schLib';
import { setProps, uniqueId } from '../../model/schEdit';
import type { LibSymbol } from '../../formats/altium/schlib';
import type { Change } from '../../core/undo';
import type { Scope } from '../../core/commands';
import type { PropertyBag } from '../../formats/altium/props';
import type { PropSection } from '../Editor';

export class SchLibEditor extends SchEditor {
  override readonly scope: Scope = 'schlib';
  /** Index of the symbol shown. */
  current = 0;
  /** The view each component was last seen at (Remember last zoom for each component). */
  private zooms = new Map<LibSymbol, { cx: number; cy: number; scale: number }>();

  constructor(readonly lib: SchLibDocument) {
    super(SchLibEditor.viewOf(lib, lib.symbols[0] ?? null));
    this.libraryMode = true;
    // Each edit remembers its symbol: undo / redo show it again before changing it
    const transact = this.undo.transact.bind(this.undo);
    this.undo.transact = (label, fn) => transact(label, (tx) => {
      let first = true;
      const sym = this.symbol;
      fn({ add: (c) => { if (first && sym) { first = false; tx.add(this.showChange(sym)); } tx.add(c); } });
    });
  }

  private static viewOf(lib: SchLibDocument, sym: LibSymbol | null): SchDocument {
    if (!sym) { const s = newSymbol('Component_1'); lib.symbols.push(s); sym = s; }
    let v = lib.views.get(sym);
    if (!v) {
      v = symbolView(lib, sym);
      lib.views.set(sym, v);
    }
    const view = v;
    view.adopt = (b: PropertyBag) => adopt(view, b);
    view.onSheetChange = (sheet) => syncFonts(lib, sheet, view);
    return view;
  }

  get symbol(): LibSymbol | undefined { return this.lib.symbols[this.current]; }
  /** A symbol's editable view (made now if it hasn't been shown yet; it is then saved from the view). */
  viewFor(sym: LibSymbol): SchDocument { return SchLibEditor.viewOf(this.lib, sym); }
  /** A symbol to read: its view if it has one, else a throwaway one (an untouched symbol keeps its bytes). */
  peek(sym: LibSymbol): SchDocument { return this.lib.views.get(sym) ?? symbolView(this.lib, sym); }
  /**
   * Edits to several symbols as one undo step (Model Manager, Parameter Manager): `build` makes
   * the changes for each symbol's view.
   */
  editSymbols(label: string, edits: { sym: LibSymbol; build: (view: SchDocument) => (Change | null)[] }[]): number {
    let n = 0;
    this.undo.transact(label, (tx) => {
      for (const { sym, build } of edits) {
        const view = this.viewFor(sym);
        for (const c of build(view)) if (c) { tx.add(c); n++; }
      }
    });
    this.invalidate();
    this.changed.emit();
    return n;
  }
  override title(): string { return this.lib.name; }
  /** The component record of the symbol shown (object 1 of its view). */
  get component(): Extract<SchDocument['objects'][number], { kind: 'component' }> | undefined {
    const o = this.doc.objects.find((x) => x.kind === 'component');
    return o?.kind === 'component' ? o : undefined;
  }
  get part(): number { return this.component?.partId ?? 1; }
  get partCount(): number { return Math.max(1, (this.component?.partCount ?? 2) - 1); }

  /** Show symbol i (Library panel click, Tools › Goto). */
  showSymbol(sym: LibSymbol | number): void {
    const i = typeof sym === 'number' ? sym : this.lib.symbols.indexOf(sym);
    const s = this.lib.symbols[i];
    if (!s) return;
    const changed = i !== this.current || this.doc !== this.lib.views.get(s);
    // A tool working on the symbol shown (its preview records, the objects it holds) ends first
    if (changed && this.tool !== this.selectTool) this.setTool(null);
    const was = this.symbol, vp = this.viewport;
    if (changed && was && vp) this.zooms.set(was, vp.view);
    this.current = i;
    this.doc = SchLibEditor.viewOf(this.lib, s);
    if (changed) {
      this.selection.clear();
      this.invalidate();
      // Preferences › Library AutoZoom: keep the view, put back this component's last, or centre it
      const z = settings.schLibZoom, kept = this.zooms.get(s);
      if (!vp || !vp.laidOut) this.fit();
      else if (z === 'remember' && kept) vp.view = kept;
      else if (z === 'centre') {
        const b = this.fitBounds();
        vp.centreOn({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      } else if (z === 'remember') this.fit();
      this.changed.emit();
    }
  }
  private showChange(sym: LibSymbol): Change {
    return { apply: () => this.showSymbol(sym), revert: () => this.showSymbol(sym) };
  }

  /** Tools › Goto › Next / Previous Part, or a part by number: which part's graphics are shown. */
  showPart(n: number): void {
    const c = this.component;
    const bag = c && this.doc.records[c.index + 1]?.bag;
    if (!bag || n < 1 || n > this.partCount) return;
    if (this.tool !== this.selectTool) { this.setTool(null); if (this.component !== c) return this.showPart(n); }
    bag.set('CURRENTPARTID', String(n));
    rederive(this.doc);
    this.selection.clear();
    this.invalidate();
    this.changed.emit();
  }

  /* ── display modes (Tools › Mode): Normal and its alternates ── */
  get modeCount(): number {
    const c = this.component, b = c && this.doc.records[c.index + 1]?.bag;
    return Math.max(1, b?.int('DISPLAYMODECOUNT', 1) ?? 1);
  }
  get mode(): number { return this.component?.displayMode ?? 0; }
  /** Show display mode n (0 = Normal), as Previous / Next / Normal do. */
  showMode(n: number): void {
    const c = this.component;
    const bag = c && this.doc.records[c.index + 1]?.bag;
    if (!bag || n < 0 || n >= this.modeCount || n === this.mode) return;
    if (this.tool !== this.selectTool) { this.setTool(null); if (this.component !== c) return this.showMode(n); }
    if (n) bag.set('DISPLAYMODE', String(n)); else bag.delete('DISPLAYMODE');
    rederive(this.doc);
    this.selection.clear();
    this.invalidate();
    this.changed.emit();
  }
  /** Tools › Mode › Add: a new, empty alternate, shown. */
  addMode(): void {
    const c = this.component;
    if (!c) return;
    const n = this.modeCount;
    this.undo.transact(`Add display mode ${n}`, (tx) => tx.add(setProps(this.doc, c.index, { DISPLAYMODECOUNT: String(n + 1), DISPLAYMODE: String(n) })));
  }
  /** Tools › Mode › Remove: the alternate shown and its graphics go (Normal stays); later ones move down. */
  removeMode(): boolean {
    const c = this.component, m = this.mode;
    if (!c || m === 0) return false;
    const doc = this.doc;
    const gone = new Set(doc.objects.filter((o) => o.owner === c.index && o.ownerDisplayMode === m).map((o) => o.index));
    this.rewrite(`Remove display mode ${m}`, gone, (b) => {
      if (b.int('RECORD', -1) === SR.COMPONENT) {
        b.set('DISPLAYMODECOUNT', String(this.modeCount - 1));
        if (m - 1) b.set('DISPLAYMODE', String(m - 1)); else b.delete('DISPLAYMODE');
        return;
      }
      const d = b.int('OWNERPARTDISPLAYMODE');
      if (d > m) b.set('OWNERPARTDISPLAYMODE', String(d - 1));
    });
    return true;
  }

  /** Drop some objects and adjust the rest (owners re-pointed), as one undo step. */
  private rewrite(label: string, removed: Set<number>, adjust: (b: PropertyBag) => void): void {
    const doc = this.doc;
    const before = doc.records.map((r) => ({ ...r, bag: r.bag?.clone() }));
    const after = doc.records.filter((_r, i) => !removed.has(i - 1)).map((r) => ({ ...r, bag: r.bag?.clone() }));
    const shift = (idx: number) => idx - [...removed].filter((r) => r < idx).length;
    for (const r of after.slice(1)) {
      const b = r.bag;
      if (!b) continue;
      if (b.has('OWNERINDEX')) b.setRaw(b.keys().find((k) => k.toUpperCase() === 'OWNERINDEX')!, String(shift(b.int('OWNERINDEX'))));
      adjust(b);
    }
    this.undo.transact(label, (tx) => tx.add({
      apply: () => { doc.records = after.map((r) => ({ ...r, bag: r.bag?.clone() })); rederive(doc); },
      revert: () => { doc.records = before.map((r) => ({ ...r, bag: r.bag?.clone() })); rederive(doc); },
    }));
  }

  /* ── library edits (undoable) ── */
  private symbolsChange(next: LibSymbol[], show: LibSymbol | undefined): Change {
    const before = this.lib.symbols.slice(), was = this.symbol;
    return {
      apply: () => { this.lib.symbols.splice(0, this.lib.symbols.length, ...next); if (show) this.showSymbol(show); },
      revert: () => { this.lib.symbols.splice(0, this.lib.symbols.length, ...before); if (was) this.showSymbol(was); },
    };
  }

  /** Tools › New Component: a blank symbol named as asked (made unique). */
  newComponent(name: string): void {
    const ref = this.uniqueName(name.trim() || 'Component_1');
    const s = newSymbol(ref);
    const next = [...this.lib.symbols];
    next.splice(this.current + 1, 0, s);
    this.undo.transact(`New component ${ref}`, (tx) => tx.add(this.symbolsChange(next, s)));
  }

  /** Tools › Copy Component (Edit › Duplicate in the panel): a copy with a new name. */
  duplicateComponent(): void {
    const sym = this.symbol;
    if (!sym) return;
    const v = SchLibEditor.viewOf(this.lib, sym);
    const ref = this.uniqueName(`${sym.libRef}_1`);
    const copy: LibSymbol = { libRef: ref, description: sym.description, parts: sym.parts, storage: '', bags: [] };
    copy.bags = viewBags(v);
    for (const b of copy.bags) if (b.has('UNIQUEID')) b.setRaw(b.keys().find((k) => k.toUpperCase() === 'UNIQUEID')!, uniqueId());
    copy.bags[0]!.set('LIBREFERENCE', ref);
    copy.bags[0]!.set('DESIGNITEMID', ref);
    const next = [...this.lib.symbols];
    next.splice(this.current + 1, 0, copy);
    this.undo.transact(`Copy component ${sym.libRef}`, (tx) => tx.add(this.symbolsChange(next, copy)));
  }

  /** Tools › Copy Component (into this library) and Edit › Paste: symbols added after the one shown, renamed if taken. */
  insertSymbols(syms: LibSymbol[], label = 'Add components'): LibSymbol[] {
    const next = [...this.lib.symbols];
    const added: LibSymbol[] = [];
    for (const s of syms) {
      const taken = new Set([...next, ...added].map((x) => x.libRef.toLowerCase()));
      let ref = s.libRef;
      if (taken.has(ref.toLowerCase())) { let n = 1; const m = /^(.*?)_?(\d+)$/.exec(ref); const stem = m ? m[1]! : ref; while (taken.has(`${stem}_${n}`.toLowerCase())) n++; ref = `${stem}_${n}`; }
      const bags = s.bags.map((b) => b.clone());
      if (bags[0]) { bags[0].set('LIBREFERENCE', ref); if (ref !== s.libRef) bags[0].set('DESIGNITEMID', ref); }
      for (const b of bags) if (b.has('UNIQUEID')) b.setRaw(b.keys().find((k) => k.toUpperCase() === 'UNIQUEID')!, uniqueId());
      added.push({ libRef: ref, description: s.description, parts: s.parts, storage: '', bags });
    }
    next.splice(this.current + 1, 0, ...added);
    this.undo.transact(label, (tx) => tx.add(this.symbolsChange(next, added[0])));
    return added;
  }

  /** Tools › Move Component (from here) and Remove Duplicates: these symbols go; the library keeps at least one. */
  removeSymbols(syms: LibSymbol[], label: string): boolean {
    const gone = new Set(syms);
    const next = this.lib.symbols.filter((s) => !gone.has(s));
    if (!next.length || next.length === this.lib.symbols.length) return false;
    this.undo.transact(label, (tx) => tx.add(this.symbolsChange(next, next[Math.min(this.current, next.length - 1)])));
    return true;
  }

  /** Tools › Remove Component: the library keeps at least one. */
  removeComponent(): boolean {
    const sym = this.symbol;
    if (!sym || this.lib.symbols.length < 2) return false;
    const next = this.lib.symbols.filter((s) => s !== sym);
    this.undo.transact(`Remove component ${sym.libRef}`, (tx) => tx.add(this.symbolsChange(next, next[Math.min(this.current, next.length - 1)])));
    return true;
  }

  /** Tools › Rename Component: Symbol Reference (and Design Item ID) of the shown symbol. */
  renameComponent(name: string): boolean {
    const c = this.component, sym = this.symbol;
    const ref = name.trim();
    if (!c || !sym || !ref || ref === sym.libRef) return false;
    if (this.lib.symbols.some((s) => s !== sym && s.libRef.toLowerCase() === ref.toLowerCase())) return false;
    const old = sym.libRef;
    const rename: Change = { apply: () => { sym.libRef = ref; }, revert: () => { sym.libRef = old; } };
    this.undo.transact(`Rename ${old} to ${ref}`, (tx) => {
      tx.add(setProps(this.doc, c.index, { LIBREFERENCE: ref, DESIGNITEMID: ref }));
      tx.add(rename);
    });
    return true;
  }

  /** Tools › New Part: one more part in the package, shown. */
  newPart(): void {
    const c = this.component;
    if (!c) return;
    const parts = this.partCount + 1;
    this.undo.transact('New part', (tx) => tx.add(setProps(this.doc, c.index, { PARTCOUNT: String(parts + 1), CURRENTPARTID: String(parts) })));
  }

  /** Tools › Remove Part: the shown part's graphics and pins go; later parts move down one. */
  removePart(): boolean {
    const c = this.component;
    if (!c || this.partCount < 2) return false;
    const part = this.part, doc = this.doc;
    const before = doc.records.map((r) => ({ ...r, bag: r.bag?.clone() }));
    const after = doc.records
      .filter((_r, i) => { const o = doc.objects[i - 1]; return !(o && o.owner === c.index && o.ownerPartId === part); })
      .map((r) => ({ ...r, bag: r.bag?.clone() }));
    // Renumber what follows: later parts down one, owners re-pointed after the removal
    const removed = new Set(doc.objects.filter((o) => o.owner === c.index && o.ownerPartId === part).map((o) => o.index));
    const shift = (idx: number) => idx - [...removed].filter((r) => r < idx).length;
    for (const r of after) {
      const b = r.bag;
      if (!b) continue;
      if (b.int('RECORD', -1) === SR.COMPONENT) { b.set('PARTCOUNT', String(this.partCount)); b.set('CURRENTPARTID', String(Math.max(1, part - 1))); continue; }
      const p = b.int('OWNERPARTID', -1);
      if (p > part) b.set('OWNERPARTID', String(p - 1));
      if (b.has('OWNERINDEX')) b.setRaw(b.keys().find((k) => k.toUpperCase() === 'OWNERINDEX')!, String(shift(b.int('OWNERINDEX'))));
    }
    this.undo.transact(`Remove part ${part}`, (tx) => tx.add({
      apply: () => { doc.records = after.map((r) => ({ ...r, bag: r.bag?.clone() })); rederive(doc); },
      revert: () => { doc.records = before.map((r) => ({ ...r, bag: r.bag?.clone() })); rederive(doc); },
    }));
    return true;
  }

  /** Properties panel with nothing selected: the library and the component shown. */
  override documentProperties(): PropSection[] {
    const c = this.component, bag = c ? this.doc.records[c.index + 1]?.bag : undefined;
    const pins = this.doc.objects.filter((o) => o.kind === 'pin');
    const set = (label: string, props: Record<string, string | null>) => { if (c) this.undo.transact(label, (tx) => tx.add(setProps(this.doc, c.index, props))); };
    return [
      { title: 'Component', rows: [
        { label: 'Symbol Reference', value: this.symbol?.libRef ?? '', edit: (v) => { this.renameComponent(v); } },
        { label: 'Description', value: bag?.get('COMPONENTDESCRIPTION') ?? '', edit: (v) => set('Component description', { COMPONENTDESCRIPTION: v || null }) },
        { label: 'Parts', value: `${partLetter(this.part)} of ${this.partCount}` },
        { label: 'Pins', value: String(pins.length) },
      ] },
      { title: 'Library', rows: [
        { label: 'Components', value: String(this.lib.symbols.length) },
        { label: 'Snap grid', value: `${this.doc.sheet.snapGrid / 10_000}mil` },
      ] },
    ];
  }

  uniqueName(base: string): string {
    const taken = new Set(this.lib.symbols.map((s) => s.libRef.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    const m = /^(.*?)(\d+)$/.exec(base);
    let stem = m ? m[1]! : `${base}_`, n = m ? Number(m[2]) : 1;
    while (taken.has(`${stem}${n}`.toLowerCase())) n++;
    if (!stem) stem = 'Component_';
    return `${stem}${n}`;
  }
}

const FONT_KEY = /^(FONTIDCOUNT|SIZE\d+|FONTNAME\d+|BOLD\d+|ITALIC\d+|UNDERLINE\d+|STRIKEOUT\d+|ROTATION\d+)$/i;

/** A font added in one symbol's view goes into the library's header (the font table all symbols share) and the other views. */
function syncFonts(lib: SchLibDocument, sheet: PropertyBag, from: SchDocument): void {
  const fonts = sheet.keys().filter((k) => FONT_KEY.test(k)).map((k): [string, string] => [k, sheet.getRaw(k)!]);
  lib.header.replaceGroup((k) => FONT_KEY.test(k), fonts);
  for (const v of lib.views.values()) {
    if (v === from) continue;
    const rec = v.records[1];
    if (rec?.bag) { const b = rec.bag.clone(); b.replaceGroup((k) => FONT_KEY.test(k), fonts); rec.bag = b; rederive(v); }
  }
}

const nests = (b: PropertyBag) => [SR.IMPLEMENTATION, SR.MAP_DEFINER_LIST, SR.MAP_DEFINER, SR.IMPL_PARAMS].includes(b.int('RECORD', -1) as never);

/** A record placed in a symbol joins its component, on the part shown. */
function adopt(view: SchDocument, b: PropertyBag): void {
  const rec = b.int('RECORD', -1);
  if (rec === SR.COMPONENT || rec === SR.SHEET || rec === SR.HEADER) return;
  const comp = view.objects.find((o) => o.kind === 'component');
  if (!comp || comp.kind !== 'component') return;
  if (!b.has('OWNERINDEX')) b.set('OWNERINDEX', String(comp.index));
  // Graphics and pins belong to the part shown; the component's texts and models to all of them
  if (rec === SR.DESIGNATOR || rec === SR.PARAMETER || nests(b) || rec === SR.IMPLEMENTATION_LIST) return;
  if (b.int('OWNERPARTID', -2) !== comp.partId) b.set('OWNERPARTID', String(comp.partId));
  if (comp.displayMode && !b.has('OWNERPARTDISPLAYMODE')) b.set('OWNERPARTDISPLAYMODE', String(comp.displayMode));
}
