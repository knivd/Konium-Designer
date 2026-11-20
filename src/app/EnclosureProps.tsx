/**
 * The enclosure designer's Properties panel: with nothing picked, the box (its shape, closing,
 * the board's mounting, fixing it down, printing, the checks and what it comes to); with a
 * feature picked, that feature (where it is, its shape and size, what it is for) and what can be
 * done with it (duplicate, mirror, repeat, delete). Its controls: number fields with their units
 * inside, segmented choices, switches, colours (filaments' or any), laid out label beside value.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ColourIcon, Icon } from './icons';
import { FILAMENTS, FINISHES, bossDia, rgbOf, screwForHole, type Finish, type Looks, type Add, type BoardFacts, type Layout, type EnclosureSpec, type Face, type Fix, type Into, type Label, type Material, type Opening, type Seal, type Shape, type Vent } from '../model/enclosure';
import { FACE_NAME, type Built } from '../model/enclosureSolid';
import { kindOf, mirrored, nameOf, repeat, duplicate, type Item, type ItemList, type Pick } from './EnclosureTools';

/* ---- Controls ---- */

/** Sections left closed or open, kept while the app runs. */
const opened = new Map<string, boolean>();
export function Section({ id, title, badge, closed, children }: { id: string; title: string; badge?: ComponentChildren; closed?: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(opened.get(id) ?? !closed);
  const flip = () => { opened.set(id, !open); setOpen(!open); };
  return (
    <section class={`ex-sec${open ? '' : ' shut'}`} aria-label={title}>
      <button type="button" class="ex-sec-head" aria-expanded={open} onClick={flip}><span class="ex-chev" aria-hidden="true" />{title}{badge}</button>
      {open && <div class="ex-sec-body">{children}</div>}
    </section>
  );
}
export const Row = ({ label, title, children, wide }: { label: string; title?: string; children: ComponentChildren; wide?: boolean }) => (
  <div class={`ex-row${wide ? ' wide' : ''}`} title={title}><span class="ex-label">{label}</span><div class="ex-val">{children}</div></div>
);
/** A number with its unit inside the field; empty (when allowed) shows the placeholder. */
export function NumIn({ label, value, onChange, unit = 'mm', min = -1e6, step = 0.1, placeholder, disabled, title }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void; unit?: string; min?: number; step?: number; placeholder?: string; disabled?: boolean; title?: string }) {
  return (
    <span class={`ex-num${unit ? '' : ' bare'}`} title={title}>
      <input type="number" aria-label={label} step={step} min={min > -1e5 ? min : undefined} disabled={disabled} placeholder={placeholder} value={value === null || value === undefined ? '' : +value.toFixed(2)}
        onChange={(e) => { const t = (e.target as HTMLInputElement).value.trim(), n = Number(t); onChange(t === '' && placeholder !== undefined ? null : Number.isFinite(n) && t !== '' ? Math.max(min, n) : value ?? null); }} />
      {unit && <span class="ex-unit">{unit}</span>}
    </span>
  );
}
/** A number in a row of its own. */
export const NumRow = (p: Parameters<typeof NumIn>[0] & { rowLabel?: string }) => <Row label={p.rowLabel ?? p.label} title={p.title}><NumIn {...p} /></Row>;
/** One of a few choices, side by side. */
export function Seg<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: [T, string, string?][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <span class="ex-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, t, icon]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value} class={v === value ? 'on' : ''} disabled={disabled} title={icon ? t : undefined} aria-label={icon ? t : undefined} onClick={() => v !== value && onChange(v)}>
          {icon ? <Icon name={icon} /> : t}
        </button>
      ))}
    </span>
  );
}
export const SegRow = <T extends string | number>(p: Parameters<typeof Seg<T>>[0] & { title?: string }) => <Row label={p.label} title={p.title}><Seg {...p} /></Row>;
export function Sel<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select class="ex-select" aria-label={label} value={String(value)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; const o = options.find(([x]) => String(x) === v); if (o) onChange(o[0]); }}>
      {options.map(([v, t]) => <option key={String(v)} value={String(v)}>{t}</option>)}
    </select>
  );
}
export const SelRow = <T extends string | number>(p: Parameters<typeof Sel<T>>[0] & { title?: string }) => <Row label={p.label} title={p.title}><Sel {...p} /></Row>;
export const Switch = ({ label, checked, onChange, title, disabled }: { label: string; checked: boolean; onChange: () => void; title?: string; disabled?: boolean }) => (
  <label class="ex-switch-row" title={title}><span class="ex-label wrap">{label}</span>
    <span class="ex-switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} /><span class="ex-knob" aria-hidden="true" /></span>
  </label>
);

/** A colour: a swatch that opens the filaments' colours, with a picker for any other. */
export function ColourPick({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const document = ref.current?.ownerDocument ?? globalThis.document;
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const name = FILAMENTS.find((f) => f.colour === value)?.name ?? value.toUpperCase();
  return (
    <span class="ex-colour" ref={ref}>
      <button type="button" class="ex-swatch-btn" aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={name} onClick={() => setOpen(!open)}>
        <span class="ex-swatch" style={{ background: value }} /><span class="ex-swatch-name">{name}</span><span class="tbtn-arrow" aria-hidden="true" />
      </button>
      {open && (
        <div class="ex-palette" role="dialog" aria-label={`${label}: colours`}>
          <div class="ex-palette-grid">{FILAMENTS.map((f) => <button key={f.colour} type="button" class={`ex-swatch${f.colour === value ? ' on' : ''}`} style={{ background: f.colour }} title={f.name} aria-label={f.name} onClick={() => { onChange(f.colour); setOpen(false); }} />)}</div>
          <label class="ex-palette-own"><span>Any other</span><input type="color" aria-label={`${label}: any other colour`} value={value} onChange={(e) => onChange((e.target as HTMLInputElement).value.toLowerCase())} /></label>
        </div>
      )}
    </span>
  );
}
/** Black or white, whichever stands out against a colour. */
export const contrastOf = (c: string): string => { const [r, g, b] = rgbOf(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#1d1e20' : '#f1f1ee'; };

const FACES: Face[] = ['S', 'E', 'N', 'W', 'top', 'bottom'];
const SHAPES: [Shape, string, string][] = [['rect', 'Rectangle', 'encShapeRect'], ['rounded', 'Rounded rectangle', 'encShapeRounded'], ['circle', 'Circle', 'encShapeCircle'], ['slot', 'Slot', 'encShapeSlot']];
const INTO: [Into, string][] = [['pilot', 'Pilot hole'], ['insert', 'Heat-set insert'], ['nut', 'Nut']];
/** Plastics' densities (g/cm³), for the parts' weight. */
export const DENSITY: Record<Material, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07 };

/* ---- The box ---- */

export function BoxPanel({ s, set, facts, built, err }: { s: EnclosureSpec; set: (p: Partial<EnclosureSpec>) => void; facts: BoardFacts | null; built: Built | null; err: string }) {
  const g = built?.g;
  const autoAbove = facts ? Math.max(3, facts.top + 1.5) : 0, autoStand = facts ? Math.max(3, facts.bottom + 1) : 0;
  const autoDia = bossDia(facts?.holes.length ? screwForHole(facts.holes[0]!.d) : 3, s.mount.into);
  const grams = (v: number) => (v / 1000) * DENSITY[s.print.material];
  const metres = built ? [built.base, built.top, ...built.extras.map((x) => x.mesh), ...(built.inlays ?? []).map((x) => x.mesh)].reduce((t, m) => t + m.volume, 0) / (Math.PI * 0.875 * 0.875) / 1000 : 0;
  const colours = new Set([s.looks.base.colour, ...(built?.inlays ?? []).filter((x) => x.on === 'base').map((x) => x.colour)]).size;
  const coloursTop = new Set([s.looks.top.colour, ...(built?.inlays ?? []).filter((x) => x.on === 'top').map((x) => x.colour)]).size;
  const paintRow = (label: string, key: keyof Looks, title: string) => (
    <Row label={label} title={title}>
      <span class="ex-paint">
        <ColourPick label={`${label} colour`} value={s.looks[key].colour} onChange={(c) => set({ looks: { ...s.looks, [key]: { ...s.looks[key], colour: c } } })} />
        <Sel<Finish> label={`${label} finish`} value={s.looks[key].finish} options={FINISHES.map((f) => [f.id, f.name])} onChange={(v) => set({ looks: { ...s.looks, [key]: { ...s.looks[key], finish: v } } })} />
      </span>
    </Row>
  );
  const nButtons = built ? built.extras.filter((x) => x.name !== 'Gasket').length : 0, gasket = !!built?.extras.some((x) => x.name === 'Gasket');
  const notes = [...(built?.notes ?? []), ...(facts && !facts.holes.length && !s.mount.ledges ? ['The board has no mounting holes (2 to 6 mm, not on a net): no standoffs.'] : [])];
  return (
    <div class="ex-panel" aria-label="Enclosure settings">
      <header class="ex-panel-head"><ColourIcon name="enclosureDoc" size={20} /><div><b>Enclosure</b><span class="muted small">{facts ? `For ${s.board || 'the board'}: ${facts.w.toFixed(1)} × ${facts.h.toFixed(1)} mm` : 'No board'}</span></div></header>
      {err && <p class="small error ex-pad">{err}</p>}
      {g && built && facts && (
        <div class="ex-facts enc-sum" aria-label="Summary">
          <div><span>Box</span><b>{(2 * g.ox).toFixed(1)} × {(2 * g.oy).toFixed(1)} × {g.height.toFixed(1)} mm</b></div>
          <div><span>Base</span><b>{(built.base.volume / 1000).toFixed(1)} cm³ · {grams(built.base.volume).toFixed(0)} g</b></div>
          <div><span>Top</span><b>{(built.top.volume / 1000).toFixed(1)} cm³ · {grams(built.top.volume).toFixed(0)} g</b></div>
          <div><span>Filament</span><b>up to {metres.toFixed(1)} m of 1.75 mm, {s.print.material}</b></div>
          {g.screws && <div><span>Screws</span><b>{g.screws.at.length} × M{g.screws.size}{g.screws.length ? ` × ${g.screws.length} mm` : ''}</b></div>}
          {(colours > 1 || coloursTop > 1) && <div><span>Colours</span><b>{[colours > 1 ? `base ${colours}` : '', coloursTop > 1 ? `top ${coloursTop}` : ''].filter(Boolean).join(', ')} (a multi-colour print)</b></div>}
          {(nButtons > 0 || gasket) && <div><span>Parts</span><b>{[nButtons ? `${nButtons} button${nButtons === 1 ? '' : 's'}` : '', gasket ? 'a gasket' : ''].filter(Boolean).join(', ')}</b></div>}
        </div>
      )}
      {notes.length > 0 && (
        <Section id="checks" title="Checks" badge={<span class="ex-badge warn">{notes.length}</span>}>
          <ul class="ex-checks">{notes.map((n, i) => <li key={i} class="enc-note"><Icon name="encWarn" /><span>{n}</span></li>)}</ul>
        </Section>
      )}
      <Section id="box" title="Box">
        <SegRow label="Style" value={s.split === null ? 'lid' : 'split'} options={[['lid', 'Base and lid'], ['split', 'Two shells']]} onChange={(v) => set({ split: v === 'lid' ? null : 0 })}
          title="Base and lid: a flat lid on the walls, its lip inside them. Two shells: the walls split at a height, joined by a lap joint in their thickness" />
        {s.split !== null && <NumRow label="Joint" value={s.split} min={-50} onChange={(v) => set({ split: v ?? 0 })} title="The joint's height above the board's top (below it: negative)" />}
        <NumRow label="Wall" value={s.wall} min={0.8} onChange={(v) => set({ wall: v ?? 2 })} />
        <NumRow label="Floor" value={s.floor} min={0.8} onChange={(v) => set({ floor: v ?? 2 })} />
        <NumRow label="Top" value={s.top} min={0.8} onChange={(v) => set({ top: v ?? 2 })} />
        <NumRow label="Clearance" value={s.clearance} min={0} onChange={(v) => set({ clearance: v ?? 1 })} title="Between the board's edge and the walls" />
        <NumRow label="Room above" value={s.above} placeholder={`Auto ${autoAbove.toFixed(1)}`} min={0} onChange={(v) => set({ above: v })} title="Over the board's top: its tallest part and 1.5 mm, unless given" />
        <NumRow label="Corner radius" value={s.radius} min={0} onChange={(v) => set({ radius: v ?? 3 })} />
        <SegRow label="Edges" value={s.edge} options={[['none', 'Square'], ['round', 'Rounded'], ['chamfer', 'Chamfered']]} onChange={(v) => set({ edge: v })} title="The outside's top and bottom edges" />
        {s.edge !== 'none' && <NumRow label="Edge size" value={s.edgeSize} min={0} onChange={(v) => set({ edgeSize: v ?? 1.5 })} />}
      </Section>
      <Section id="closing" title="Closing">
        <SegRow<Fix> label="Fixing" value={s.fix} options={[['press', 'Press fit'], ['snaps', 'Snaps'], ['screws', 'Screws']]} onChange={(v) => set({ fix: v })} title="How the top stays on" />
        <NumRow label="Lip height" value={s.lipHeight} min={0} onChange={(v) => set({ lipHeight: v ?? 3 })} />
        <NumRow label="Lip width" value={s.lipWidth} min={0.6} onChange={(v) => set({ lipWidth: v ?? 1.2 })} />
        <NumRow label="Fit gap" value={s.fit} step={0.05} min={0} onChange={(v) => set({ fit: v ?? 0.2 })} title="Round the lip, and between parts that fit together" />
        {s.fix === 'snaps' && <NumRow label="Catches a side" value={s.snaps} placeholder="Auto" step={1} unit="" min={0} onChange={(v) => set({ snaps: v === null ? null : Math.round(v) })} title="Empty: by the side's length" />}
        {s.fix === 'screws' && <>
          <SegRow label="Screws" value={s.screw.size} options={[[2, 'M2'], [2.5, 'M2.5'], [3, 'M3'], [4, 'M4']]} onChange={(v) => set({ screw: { ...s.screw, size: v } })} />
          <SegRow label="Where" value={s.screw.at} options={[['corners', 'Corners'], ['board', "Board's holes"]]} onChange={(v) => set({ screw: { ...s.screw, at: v } })} title="In bosses in the box's corners, or down through the board's mounting holes into its standoffs" />
          {s.screw.at === 'corners' && <SelRow<Into> label="Into" value={s.screw.into} options={INTO} onChange={(v) => set({ screw: { ...s.screw, into: v } })} />}
          <SegRow label="Head" value={s.screw.head} options={[['countersunk', 'Countersunk'], ['pan', 'Pan head']]} onChange={(v) => set({ screw: { ...s.screw, head: v } })} />
        </>}
        <SelRow<Seal['kind']> label="Seal" value={s.seal.kind} options={[['none', 'None'], ['cord', 'Cord in a groove'], ['gasket', 'Printed gasket']]} onChange={(v) => set({ seal: { ...s.seal, kind: v } })}
          title="A groove round the base's rim where the top presses on it: for a rubber cord, or for a gasket printed in TPU (a part of its own). The screws press it" />
        {s.seal.kind !== 'none' && <NumRow label={s.seal.kind === 'cord' ? 'Cord' : 'Gasket width'} value={s.seal.size} min={0.8} onChange={(v) => set({ seal: { ...s.seal, size: v ?? 2 } })} title={s.seal.kind === 'cord' ? "The cord's diameter" : "The gasket's width and height"} />}
      </Section>
      <Section id="looks" title="Colours">
        {paintRow('Base', 'base', "The base's filament, and its surface in the view and pictures")}
        {paintRow('Top', 'top', "The top's filament, and its surface in the view and pictures")}
        {nButtons > 0 && paintRow('Buttons', 'buttons', 'The buttons (parts of their own)')}
        {gasket && paintRow('Gasket', 'gasket', 'The printed gasket (TPU)')}
      </Section>
      <Section id="board" title="Board">
        <NumRow label="Standoffs" value={s.standoff} placeholder={`Auto ${autoStand.toFixed(1)}`} min={0} onChange={(v) => set({ standoff: v })} title="The board's underside above the floor" />
        <NumRow label="Diameter" value={s.mount.dia} placeholder={`Auto ${autoDia.toFixed(1)}`} min={2} onChange={(v) => set({ mount: { ...s.mount, dia: v } })} title="The standoffs' diameter; empty: by the screw" />
        <SelRow<Into | 'pin'> label="Held by" value={s.mount.into} options={[...INTO, ['pin', 'Locating pin']]} onChange={(v) => set({ mount: { ...s.mount, into: v } })} />
        <Switch label="Ledges under its corners" checked={s.mount.ledges} onChange={() => set({ mount: { ...s.mount, ledges: !s.mount.ledges } })} title="When the board has no mounting holes" />
        <Switch label="Posts from the top" checked={s.mount.clamp} onChange={() => set({ mount: { ...s.mount, clamp: !s.mount.clamp } })} title="Holding the board down where nothing else does: over locating pins, beside ledges" />
      </Section>
      <Section id="mounting" title="Fixing the box" closed>
        <NumRow label="Feet" value={s.feet || null} placeholder="None" min={0} onChange={(v) => set({ feet: v ?? 0 })} title="Round recesses under the base's corners for stick-on rubber feet of this diameter" />
        <SegRow label="Ears" value={s.ears.sides} options={[['none', 'None'], ['EW', 'Left, right'], ['NS', 'Front, back']]} onChange={(v) => set({ ears: { ...s.ears, sides: v } })} title="Flanges at the base's foot with a screw hole each, to fix the box down" />
        {s.ears.sides !== 'none' && <NumRow label="Ear hole" value={s.ears.hole} min={2} onChange={(v) => set({ ears: { ...s.ears, hole: v ?? 4.5 } })} />}
        <NumRow label="Keyholes" value={s.keyholes || null} placeholder="None" min={4} onChange={(v) => set({ keyholes: v ?? 0 })} title="Keyhole slots in the floor for hanging the box on a wall, for screw heads this wide (the back wall goes up)" />
      </Section>
      <Section id="printing" title="Printing">
        <NumRow label="Nozzle" value={s.print.nozzle} min={0.1} step={0.05} onChange={(v) => set({ print: { ...s.print, nozzle: v ?? 0.4 } })} title="Bars between vents and the width of text's strokes follow it" />
        <NumRow label="Layer height" value={s.print.layer} min={0.04} step={0.04} onChange={(v) => set({ print: { ...s.print, layer: v ?? 0.2 } })} />
        <SegRow<Material> label="Material" value={s.print.material} options={[['PLA', 'PLA'], ['PETG', 'PETG'], ['ABS', 'ABS'], ['ASA', 'ASA']]} onChange={(v) => set({ print: { ...s.print, material: v } })} />
        <NumRow label="Bed chamfer" value={s.print.bedChamfer} step={0.1} min={0} onChange={(v) => set({ print: { ...s.print, bedChamfer: v ?? 0 } })} title="On the edges that lie on the bed, against the first layers squashing out" />
        <NumRow label="Hole allowance" value={s.print.holeComp} step={0.05} min={0} onChange={(v) => set({ print: { ...s.print, holeComp: v ?? 0 } })} title="Added to holes for screws, inserts and nuts (printed holes come out small); taken off pins" />
        <Switch label="Round wall holes as teardrops" checked={s.print.teardrops} onChange={() => set({ print: { ...s.print, teardrops: !s.print.teardrops } })} title="Their tops come to a point at 45°, so they print without support" />
      </Section>
    </div>
  );
}

/* ---- A feature ---- */

export function ItemPanel({ s, pick, facts, g, setItem, remove, append, done }: {
  s: EnclosureSpec; pick: NonNullable<Pick>; facts: BoardFacts | null; g: Layout | null;
  setItem: (list: ItemList, i: number, patch: Partial<Item>) => void;
  remove: (list: ItemList, i: number) => void;
  /** Features added (in one undo step); the first of them picked. */
  append: (list: ItemList, items: Item[]) => void;
  done: () => void;
}) {
  const { list, i } = pick;
  const o = (s[list] as Item[])[i];
  const [rep, setRep] = useState({ count: 3, dx: 10, dy: 0 });
  const [repOpen, setRepOpen] = useState(false);
  if (!o) return null;
  const k = kindOf(list, o);
  const set = (patch: Partial<Item>) => setItem(list, i, patch);
  const wall = o.face !== 'top' && o.face !== 'bottom';
  const xyTitle = (key: 'x' | 'y') => (!wall ? (key === 'x' ? 'Across the board, from its middle' : 'Up the board, from its middle') : key === 'x' ? 'Along the wall from its middle, left to right seen from outside' : "Above the board's top");
  const op = list === 'openings' ? (o as Opening) : null, vt = list === 'vents' ? (o as Vent) : null, lb = list === 'labels' ? (o as Label) : null, ad = list === 'adds' ? (o as Add) : null;
  const part = op?.part ? facts?.parts.find((p) => p.name === op.part) : undefined;
  const count = s[list].length;
  /** On a wall: halfway up the inside, from the floor to the top's underside (above the board's top). */
  const midUp = g ? Math.round(((g.floorTop + g.rim) / 2 - g.boardTop) * 10) / 10 : 0;
  return (
    <div class="ex-panel" aria-label={`${k.kind} settings`}>
      <header class="ex-panel-head">
        <Icon name={k.icon} />
        <div><b>{k.kind}</b><span class="muted small">{op?.auto ? `From the board${op.part ? `: ${op.part}` : ''}` : 'Added'}</span></div>
        <button type="button" class="ex-icon-btn" title="Back to the box (Esc)" aria-label="Back to the box" onClick={done}><Icon name="close" /></button>
      </header>
      <div class="ex-pad">
        {lb ? <Row label={lb.logo ? 'Name' : 'Text'}><input class="ex-text" aria-label={lb.logo ? 'Logo' : 'Text'} value={lb.text} onInput={(e) => set({ text: (e.target as HTMLInputElement).value } as Partial<Label>)} /></Row>
          : <Row label="Name"><input class="ex-text" aria-label="Name" value={(o as { name: string }).name} placeholder={nameOf(list, o, i)} onInput={(e) => set({ name: (e.target as HTMLInputElement).value } as Partial<Opening>)} /></Row>}
        <Switch label="On" checked={o.on} onChange={() => set({ on: !o.on })} title="Off: kept in the list, left out of the box" />
      </div>
      <Section id="item-place" title="Place">
        <SelRow<Face> label="Face" value={o.face} options={FACES.map((f) => [f, FACE_NAME[f]])} onChange={(v) => set({ face: v })} />
        {ad && <SegRow label="Side" value={ad.side} options={[['out', 'Outside'], ['in', 'Inside']]} onChange={(v) => set({ side: v } as Partial<Add>)} title="Standing out of the face, or into the box from its inside" />}
        <NumRow label="X" value={o.x} onChange={(v) => set({ x: v ?? 0 })} title={xyTitle('x')} />
        <NumRow label="Y" value={o.y} onChange={(v) => set({ y: v ?? 0 })} title={xyTitle('y')} />
      </Section>
      <Section id="item-shape" title={lb ? 'Lettering' : vt ? 'Pattern' : 'Shape'}>
        {(op || ad) && <SegRow<Shape> label="Shape" value={(op ?? ad)!.shape} options={SHAPES} onChange={(v) => set({ shape: v, ...(v === 'circle' ? { h: (op ?? ad)!.w } : {}) } as Partial<Opening>)} />}
        {(op || ad) && <NumRow label={(op ?? ad)!.shape === 'circle' ? 'Diameter' : 'Width'} value={(op ?? ad)!.w} min={0.2} onChange={(v) => set({ w: v ?? 1, ...((op ?? ad)!.shape === 'circle' ? { h: v ?? 1 } : {}) } as Partial<Opening>)} title={wall ? 'Along the wall' : 'Across'} />}
        {(op || ad) && (op ?? ad)!.shape !== 'circle' && <NumRow label="Height" rowLabel={wall ? 'Height' : 'Length'} value={(op ?? ad)!.h} min={0.2} onChange={(v) => set({ h: v ?? 1 } as Partial<Opening>)} title={wall ? 'Up the wall' : 'Up the board'} />}
        {op && <NumRow label="Depth" value={op.depth} placeholder="Through" min={0} onChange={(v) => set({ depth: v && v > 0 ? v : undefined } as Partial<Opening>)} title="Empty: through the face. A depth: a pocket that deep from the outside" />}
        {op && op.shape === 'circle' && !op.depth && <>
          <SegRow label="Screw head" value={op.sink?.kind ?? 'none'} options={[['none', 'None'], ['cs', 'Countersink'], ['cb', 'Counterbore']]}
            onChange={(v) => set({ sink: v === 'none' ? undefined : { kind: v, d: op.sink?.d ?? Math.round(op.w * 2 * 10) / 10, depth: op.sink?.depth ?? 1.6 } } as Partial<Opening>)} title="Room for a screw's head, from the outside: a 90° countersink or a flat counterbore" />
          {op.sink && <NumRow label="Head diameter" value={op.sink.d} min={op.w} onChange={(v) => set({ sink: { ...op.sink!, d: v ?? op.w * 2 } } as Partial<Opening>)} />}
          {op.sink?.kind === 'cb' && <NumRow label="Head depth" value={op.sink.depth} min={0.2} onChange={(v) => set({ sink: { ...op.sink!, depth: v ?? 1.6 } } as Partial<Opening>)} />}
        </>}
        {op && wall && !op.depth && <Switch label="Open to the joint" checked={!!op.open} onChange={() => set({ open: !op.open } as Partial<Opening>)} title="A slot up to the joint, so the board goes in with this part reaching into the wall; the top fills it above the opening" />}
        {op && op.face === 'top' && op.shape === 'circle' && part && <SelRow label="With it" value={op.extra ?? ''} options={[['', 'Just the hole'], ['tube', `A light tube to ${part.name}`], ['button', `A button onto ${part.name}`]]} onChange={(v) => set({ extra: (v || undefined) as Opening['extra'] } as Partial<Opening>)} />}
        {ad && <NumRow label="Height" rowLabel="Stands" value={ad.height} min={0.2} onChange={(v) => set({ height: v ?? 1 } as Partial<Add>)} title="How far it stands from the face" />}
        {ad && <NumRow label="Hole" value={ad.hole || null} placeholder="None" min={0} onChange={(v) => set({ hole: v ?? 0 } as Partial<Add>)} title="A hole down its middle from its end to the face, this wide (a pilot hole for a screw: 2.5 mm for M3)" />}
        {vt && <SegRow<Vent['pattern']> label="Pattern" value={vt.pattern} options={[['slots', 'Slots'], ['holes', 'Holes'], ['honeycomb', 'Honeycomb']]} onChange={(v) => set({ pattern: v } as Partial<Vent>)} />}
        {vt && <NumRow label="Width" value={vt.w} min={1} onChange={(v) => set({ w: v ?? 10 } as Partial<Vent>)} />}
        {vt && <NumRow label="Height" value={vt.h} min={1} onChange={(v) => set({ h: v ?? 10 } as Partial<Vent>)} />}
        {vt && <NumRow label="Size" value={vt.size} min={0.8} onChange={(v) => set({ size: v ?? 2 } as Partial<Vent>)} title="A slot's width, a hole's diameter, a hexagon's width across its flats" />}
        {vt && vt.pattern === 'slots' && <Switch label="Slots across" checked={!!vt.across} onChange={() => set({ across: !vt.across } as Partial<Vent>)} title="Across the patch rather than along it" />}
        {lb && <SegRow label="How" value={lb.through ? 'through' : lb.raised ? 'raised' : 'in'} options={[['in', 'Cut in'], ['raised', 'Raised'], ['through', 'Through']]} onChange={(v) => set({ raised: v === 'raised', through: v === 'through' || undefined } as Partial<Label>)} title="Cut into the face, standing out of it, or cut through it" />}
        {lb && <NumRow label={lb.logo ? 'Height' : 'Size'} value={lb.size} min={1} onChange={(v) => set({ size: v ?? 5 } as Partial<Label>)} title={lb.logo ? 'Its height; its width follows' : "Its capital letters' height"} />}
        {lb && !lb.through && <NumRow label="Depth" value={lb.depth} min={0.2} onChange={(v) => set({ depth: v ?? 0.6 } as Partial<Label>)} title="How deep it is cut, or how far it stands out" />}
        {lb && !lb.through && <SegRow label="Colour" value={lb.colour ? 'own' : 'face'} options={[['face', "The face's"], ['own', 'Its own']]}
          onChange={(v) => set({ colour: v === 'own' ? contrastOf(lb.face === 'top' ? s.looks.top.colour : s.looks.base.colour) : undefined } as Partial<Label>)}
          title="Its own colour: printed in a second filament. Raised, it stands out in that colour; cut in, the cut is filled flush with it" />}
        {lb && !lb.through && lb.colour && <Row label="Its colour"><ColourPick label="Its colour" value={lb.colour} onChange={(c) => set({ colour: c } as Partial<Label>)} /></Row>}
      </Section>
      <Section id="item-arrange" title="Arrange">
        <div class="ex-actions">
          <button type="button" class="ex-act" onClick={() => append(list, [duplicate(list, o, count + 1)])} title="A copy 5 mm along"><Icon name="encDuplicate" />Duplicate</button>
          <button type="button" class="ex-act" onClick={() => append(list, [mirrored(list, o, count + 1)])} title="A copy mirrored across the face's middle"><Icon name="encMirror" />Mirror</button>
          <button type="button" class={`ex-act${repOpen ? ' on' : ''}`} aria-expanded={repOpen} onClick={() => setRepOpen(!repOpen)} title="Copies in a row"><Icon name="encRepeat" />Repeat...</button>
          <button type="button" class="ex-act" onClick={() => set({ x: 0 })} title="In the middle of the face, left to right"><Icon name="encCentreX" />Centre across</button>
          <button type="button" class="ex-act" onClick={() => set({ y: wall ? midUp : 0 })} title={wall ? 'Halfway between the floor and the top, inside' : 'In the middle of the face, front to back'}><Icon name="encCentreY" />Centre up</button>
          <button type="button" class="ex-act danger" onClick={() => remove(list, i)} title="Delete (Del)"><Icon name="encDelete" />Delete</button>
        </div>
        {repOpen && (
          <div class="ex-repeat">
            <NumRow label="Copies" value={rep.count} unit="" step={1} min={1} onChange={(v) => setRep({ ...rep, count: Math.max(1, Math.round(v ?? 1)) })} />
            <NumRow label="Step X" value={rep.dx} onChange={(v) => setRep({ ...rep, dx: v ?? 0 })} title="Each copy this far on along the face" />
            <NumRow label="Step Y" value={rep.dy} onChange={(v) => setRep({ ...rep, dy: v ?? 0 })} title="Each copy this far on up the face" />
            <button type="button" class="btn default ex-make" onClick={() => { append(list, repeat(list, o, rep.count, rep.dx, rep.dy, count + 1)); setRepOpen(false); }}>Make {rep.count} {rep.count === 1 ? 'copy' : 'copies'}</button>
          </div>
        )}
      </Section>
    </div>
  );
}
