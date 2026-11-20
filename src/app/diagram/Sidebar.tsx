/**
 * The Shapes panel: a search box, then each library's shapes as pictures (folded
 * by their headings). Click a shape to add it (joined to the selected shape);
 * drag it onto the page to place it there. Hovering shows it larger, with its name.
 */
import { useRef, useState } from 'preact/hooks';
import { searchLibraries, type Entry, type Library } from './library';
import { EdgeView, sample, ShapeView } from './render';

const folded = new Set<string>();

/** A library entry drawn to fit a box of `size` pixels. */
export function EntryPicture({ x, size, uid }: { x: Entry; size: number; uid: string }) {
  const pad = 2;
  const w = Math.max(x.w, 1), h = Math.max(x.h, 1);
  const k = Math.min((size - 2 * pad) / w, (size - 2 * pad) / h, 1.5);
  const vw = size / k, vh = size / k;
  const ox = (vw - w) / 2, oy = (vh - h) / 2;
  return (
    <svg class="dg-thumb" width={size} height={size} viewBox={`${-ox} ${-oy} ${vw} ${vh}`} aria-hidden="true">
      {x.edge
        ? <EdgeView c={{ ...sample(x.style, x.value ?? '', uid) }} route={[x.edge.from, ...(x.edge.points ?? []), x.edge.to]} uid={uid} />
        : <>
          <ShapeView c={sample(x.style, x.value ?? '', uid)} r={{ x: 0, y: 0, w: x.w, h: x.h }} uid={uid} />
          {x.kids?.map((kid, i) => <ShapeView key={i} c={sample(kid.style, kid.value, `${uid}-${i}`)} r={kid.rect} uid={uid} />)}
        </>}
    </svg>
  );
}

export function Sidebar({ libs, onPress }: { libs: Library[]; onPress: (x: Entry, e: PointerEvent) => void }) {
  const [q, setQ] = useState('');
  const [, redraw] = useState(0);
  const [hover, setHover] = useState<{ x: Entry; top: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const found = q.trim() ? searchLibraries(q, libs) : null;
  const enter = (x: Entry, e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const top = el.getBoundingClientRect().top - (el.closest('.dg-sidebar')?.getBoundingClientRect().top ?? 0);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHover({ x, top }), 500);
  };
  const leave = () => { window.clearTimeout(timer.current); setHover(null); };
  const grid = (list: Entry[], key: string) => (
    <div class="dg-lib-grid">
      {list.map((x, i) => (
        <button key={`${key}-${i}`} type="button" class="dg-lib-item" title={x.title} aria-label={x.title} data-shape={x.title}
          onPointerDown={(e) => { if (e.button === 0) { leave(); onPress(x, e as unknown as PointerEvent); } }} onMouseEnter={(e) => enter(x, e as unknown as MouseEvent)} onMouseLeave={leave}>
          <EntryPicture x={x} size={34} uid={`sb-${key}-${i}`} />
        </button>
      ))}
    </div>
  );
  return (
    <aside class="dg-sidebar" aria-label="Shapes">
      <input class="dg-search" type="search" aria-label="Search shapes" placeholder="Search shapes" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="dg-libs">
        {found ? (
          <section class="dg-lib">
            <h4 class="dg-lib-head">Results ({found.length})</h4>
            {found.length ? grid(found, 'found') : <p class="small muted dg-lib-none">No shape is called that.</p>}
          </section>
        ) : libs.map((l) => (
          <section key={l.id} class="dg-lib" aria-label={l.title}>
            <button type="button" class="dg-lib-head" aria-expanded={!folded.has(l.id)} onClick={() => { if (folded.has(l.id)) folded.delete(l.id); else folded.add(l.id); redraw((n) => n + 1); }}>
              <span class={`dg-fold${folded.has(l.id) ? '' : ' open'}`} aria-hidden="true" />{l.title}
            </button>
            {!folded.has(l.id) && grid(l.entries, l.id)}
          </section>
        ))}
      </div>
      {hover && (
        <div class="dg-preview" role="tooltip" style={{ top: `${Math.max(4, hover.top - 20)}px` }}>
          <EntryPicture x={hover.x} size={110} uid="sb-preview" />
          <span>{hover.x.title}</span>
        </div>
      )}
    </aside>
  );
}
