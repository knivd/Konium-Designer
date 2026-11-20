/**
 * Live Scope: what Live Simulation's probes read, drawn as it goes, on as many scopes side by
 * side as are wanted. A click on a wire, a pin or a two-pin part on the running sheet is the
 * probe, drawn on the scope picked; Keep holds it while the next is taken. Each scope shows its
 * probes one of three ways: against time, as a spectrum, or as the circuit's frequency response
 * at them.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_SCOPES, SCOPE_VIEWS, addScope, clearProbes, dropProbe, keepProbe, live, onLiveFrame, removeScope, scope, scopeData, setCurrentScope, setScopeView, si, type Probe, type ScopeData, type ScopeView } from '../liveSim';
import { niceAxis } from '../../sim/liveRecord';

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`;

/** A row under the plot's key: a probe, what it reads (now, or where the cursor is on the plot) and what it ranged over. */
interface Row { id: number; kept: boolean; colour: string; label: string; cells: string[] }
const HEADS: Record<ScopeView, string[]> = {
  time: ['Voltage', 'Current', 'Least', 'Most', 'Repeats at'],
  spectrum: ['Largest', 'At', '', '', ''],
  response: ['Most gain', 'At', 'Phase', '3 dB down at', 'And at'],
};
/** With the cursor on the plot, the first columns read what is under it. */
const HEADS_AT: Record<ScopeView, string[]> = {
  time: HEADS.time,
  spectrum: ['Here', 'At', '', '', ''],
  response: ['Gain here', 'At', 'Phase', '3 dB down at', 'And at'],
};
interface Key { rows: Row[]; foot: string; heads: string[]; /** Where the plot is on its canvas: its left edge and its width. */ plot: [x: number, w: number] }

interface Box { x: number; y: number; w: number; h: number }
const INSET = 4;

/** The plot drawn; the rows for its key come back. `hover` is the cursor's place across the plot (0 to 1), or null. */
function paint(canvas: HTMLCanvasElement, data: ScopeData | null, hover: number | null): Key {
  const dpr = window.devicePixelRatio || 1, cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  const g = canvas.getContext('2d')!;
  const cs = getComputedStyle(canvas);
  const ink = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = ink('--field', '#ffffff'), line = ink('--line', '#c4c4c4'), dim = ink('--text-dim', '#5a5a5a');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = bg; g.fillRect(0, 0, cw, ch);
  // A side's marks take 52 px; the right side has them only where there are two kinds of reading (volts and amperes, gain and phase)
  const twoSides = !!data && (data.view === 'response' || (data.view === 'time' && data.probes.some((p) => p.v?.m) && data.probes.some((p) => p.i?.m)));
  const box: Box = { x: 52, y: 8, w: Math.max(40, cw - 52 - (twoSides ? 52 : 12)), h: Math.max(30, ch - 28) };
  g.font = '11px Tahoma, "Segoe UI", sans-serif';
  g.lineWidth = 1;
  const rows: Row[] = [];
  let foot = '';
  const heads = (hover === null ? HEADS : HEADS_AT)[data?.view ?? 'time'];
  const frame = () => { g.strokeStyle = dim; g.setLineDash([]); g.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h); };
  const xAt = (u: number) => box.x + u * box.w;
  // The ends of an axis sit a little inside the frame, so that a trace at its least or most is seen clear of it
  const yAt = (v: number, a: { lo: number; hi: number }) => box.y + box.h - INSET - (v - a.lo) / (a.hi - a.lo) * (box.h - 2 * INSET);
  /** A side's marks and their grid: the left's lines go across; the right's are marks only. */
  const yAxis = (a: { lo: number; hi: number; step: number }, unit: string, right: boolean, grid: boolean) => {
    g.fillStyle = dim; g.textBaseline = 'middle'; g.textAlign = right ? 'left' : 'right';
    for (let v = a.lo; v <= a.hi + a.step * 1e-6; v += a.step) {
      const y = Math.round(yAt(v, a)) + 0.5;
      if (grid) { g.strokeStyle = line; g.setLineDash(Math.abs(v) < a.step * 1e-6 ? [] : [2, 3]); g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke(); }
      g.fillText(si(Math.abs(v) < a.step * 1e-6 ? 0 : v, unit).replace(/\.0+(?= )/, ''), right ? box.x + box.w + 5 : box.x - 5, y);
    }
    g.setLineDash([]);
  };
  const xMarks = (marks: [number, string][]) => {
    g.fillStyle = dim; g.textBaseline = 'top';
    let free = -Infinity;
    for (const [u, text] of marks) {
      const x = Math.round(xAt(u)) + 0.5;
      // A mark at an end of the plot is written inwards from it, clear of the side's own marks
      const align = u < 0.02 ? 'left' : u > 0.98 ? 'right' : 'center';
      g.textAlign = align;
      g.strokeStyle = line; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, box.y); g.lineTo(x, box.y + box.h); g.stroke();
      // …and only where it has room beside the one before it
      const w = text ? g.measureText(text).width : 0, from = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
      if (text && from >= free) { g.fillText(text, x, box.y + box.h + 4); free = from + w + 6; }
    }
    g.setLineDash([]);
  };
  /** A curve by its points' places across (0 to 1) and values: its least and most in each pixel column, so that a long record costs no more than a short one. */
  const curve = (u: ArrayLike<number>, y: ArrayLike<number>, a: { lo: number; hi: number }, colour: string, dashed: boolean, jump = Infinity, least?: ArrayLike<number>, most?: ArrayLike<number>) => {
    const n = y.length;
    if (!n) return;
    g.save(); g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
    g.strokeStyle = colour; g.lineWidth = 1.4; g.setLineDash(dashed ? [5, 3] : []);
    g.beginPath();
    // Each pixel column: in at its first value, down to its least, up to its most, out at its last
    let col = -1, lo = 0, hi = 0, last = 0, begun = false;
    const flush = () => {
      if (col < 0) return;
      const x = box.x + col + 0.5;
      if (hi !== lo) { g.lineTo(x, yAt(lo, a)); g.lineTo(x, yAt(hi, a)); g.lineTo(x, yAt(last, a)); }
    };
    for (let i = 0; i < n; i++) {
      const c = Math.max(0, Math.min(Math.floor(box.w), Math.floor(u[i]! * box.w))), v = y[i]!;
      if (!Number.isFinite(v) || u[i]! < -0.01 || u[i]! > 1.01) continue;
      if (c !== col) {
        flush();
        col = c; lo = hi = v;
        // A phase that goes round (from −180° to 180°) isn't joined across the turn
        if (begun && Math.abs(v - last) < jump) g.lineTo(box.x + c + 0.5, yAt(v, a)); else { g.moveTo(box.x + c + 0.5, yAt(v, a)); begun = true; }
      } else if (v < lo) lo = v; else if (v > hi) hi = v;
      // What it reached between this sample and the one before (a record's trace): a signal faster than the samples fills its band
      if (least && least[i]! < lo) lo = least[i]!;
      if (most && most[i]! > hi) hi = most[i]!;
      last = v;
    }
    flush();
    g.stroke(); g.restore(); g.lineWidth = 1; g.setLineDash([]);
  };
  const cursor = () => {
    if (hover === null) return;
    const x = Math.round(xAt(hover)) + 0.5;
    g.strokeStyle = dim; g.setLineDash([]); g.beginPath(); g.moveTo(x, box.y); g.lineTo(x, box.y + box.h); g.stroke();
  };
  const nearest = (xs: ArrayLike<number>, x: number) => { let lo = 0, hi = xs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m]! < x) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(xs[lo - 1]! - x) < Math.abs(xs[lo]! - x) ? lo - 1 : lo; };
  const row = (p: Probe, kept: boolean, cells: string[]) => rows.push({ id: p.id, kept, colour: hex(p.colour), label: p.label, cells });

  if (!data || !data.probes.length) { frame(); return { rows, foot: data && data.view !== 'time' ? data.note ?? '' : '', heads, plot: [box.x, box.w] }; }

  if (data.view === 'time') {
    const { from, to } = data, span = to - from;
    // The two sides: volts on the left, amperes on the right, the same number of steps on each so that one grid serves both
    let vLo = Infinity, vHi = -Infinity, iLo = Infinity, iHi = -Infinity;
    for (const p of data.probes) {
      if (p.v?.m) { vLo = Math.min(vLo, p.v.m.min); vHi = Math.max(vHi, p.v.m.max); }
      if (p.i?.m) { iLo = Math.min(iLo, p.i.m.min); iHi = Math.max(iHi, p.i.m.max); }
    }
    // Each axis takes in zero; a trace a hair's breadth the other side of zero (a low level of a few millivolts under 0 V)
    // doesn't earn the axis a division of its own there
    const ends = (lo: number, hi: number): [number, number] => { const a = Math.min(lo, 0), b = Math.max(hi, 0), s = b - a; return [a > -0.02 * s ? 0 : a, b < 0.02 * s ? 0 : b]; };
    [vLo, vHi] = vHi >= vLo ? ends(vLo, vHi) : [vLo, vHi];
    [iLo, iHi] = iHi >= iLo ? ends(iLo, iHi) : [iLo, iHi];
    const va = vHi >= vLo ? niceAxis(vLo, vHi) : null;
    let ia = iHi >= iLo ? niceAxis(iLo, iHi) : null;
    if (va && ia) {
      const steps = Math.round((va.hi - va.lo) / va.step);
      for (let about = steps; ; about--) {
        const t = niceAxis(iLo, iHi, Math.max(1, about)), have = Math.round((t.hi - t.lo) / t.step);
        if (have <= steps || about <= 1) { ia = { lo: t.lo, hi: t.lo + steps * t.step, step: t.step }; break; }
      }
    }
    if (va) yAxis(va, 'V', false, true);
    if (ia) yAxis(ia, 'A', !!va, !va);
    const div = niceAxis(0, span, 8).step, marks: [number, string][] = [];
    for (let t = Math.ceil(from / div) * div; t <= to + div * 1e-6; t += div) marks.push([(t - from) / span, '']);
    xMarks(marks);
    foot = `${si(div, 's')} a division`;
    for (const p of data.probes) {
      const c = hex(p.probe.colour);
      for (const [s, a, dashed] of [[p.v, va, false], [p.i, ia, true]] as const) {
        if (!s || !a) continue;
        const u = new Float64Array(s.t.length);
        for (let k = 0; k < u.length; k++) u[k] = (s.t[k]! - from) / span;
        curve(u, s.y, a, c, dashed, Infinity, s.lo, s.hi);
      }
      const at = hover === null ? null : from + hover * span;
      const read = (s: typeof p.v, unit: string) => (!s || !s.y.length ? '' : si(at === null ? s.y[s.y.length - 1]! : s.y[nearest(s.t, at)]!, unit));
      const main = p.v ?? p.i, unit = p.v ? 'V' : 'A';
      row(p.probe, p.kept, p.gone ? ['no longer on the sheet', '', '', '', ''] : [read(p.v, 'V'), read(p.i, 'A'), main?.m ? si(main.m.min, unit) : '', main?.m ? si(main.m.max, unit) : '', main?.m?.freq ? si(main.m.freq, 'Hz') : '']);
    }
    if (hover !== null) foot = `${si(from + hover * span, 's')}; ${foot}`;
  } else {
    // Against frequency, by decades: a spectrum's amplitudes, or a response's gain (left) and phase (right)
    const f = data.f;
    if (f.length < 2) { frame(); return { rows, foot: data.note ?? '', heads, plot: [box.x, box.w] }; }
    const l0 = Math.log10(f[0]!), l1 = Math.log10(f[f.length - 1]!), u = new Float64Array(f.length);
    for (let k = 0; k < f.length; k++) u[k] = (Math.log10(f[k]!) - l0) / (l1 - l0);
    const marks: [number, string][] = [];
    for (let d = Math.ceil(l0 - 1e-9); d <= l1 + 1e-9; d++) marks.push([(d - l0) / (l1 - l0), si(10 ** d, 'Hz').replace(/\.0+(?= )/, '')]);
    const at = hover === null ? -1 : nearest(u, hover);
    if (data.view === 'spectrum') {
      let top = -Infinity;
      for (const p of data.probes) for (const a of p.a) if (a > top) top = a;
      const hi = top > 0 ? Math.ceil(20 * Math.log10(top) / 20) * 20 : 0, axis = { lo: hi - 120, hi, step: 20 };
      g.fillStyle = dim; g.textBaseline = 'middle'; g.textAlign = 'right';
      for (let v = axis.lo; v <= axis.hi; v += axis.step) {
        const y = Math.round(yAt(v, axis)) + 0.5;
        g.strokeStyle = line; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke();
        g.fillText(`${v} dB`, box.x - 5, y);
      }
      g.setLineDash([]);
      xMarks(marks);
      for (const p of data.probes) {
        const db = Float64Array.from(p.a, (a) => Math.max(axis.lo, 20 * Math.log10(Math.max(a, 1e-30))));
        curve(u, db, axis, hex(p.probe.colour), false);
        let k = 0;
        for (let j = 1; j < p.a.length; j++) if (p.a[j]! > p.a[k]!) k = j;
        // The largest line, placed between its neighbours by their sizes (a parabola through the three, in decibels)
        let fk = f[k] ?? 0;
        if (k > 0 && k < db.length - 1) { const l = db[k - 1]!, m = db[k]!, r = db[k + 1]!, den = l - 2 * m + r; if (den < 0) fk += 0.5 * (l - r) / den * (f[1]! - f[0]!); }
        const unit = p.unit;
        row(p.probe, p.kept, p.gone ? ['no longer on the sheet', '', '', '', ''] : at >= 0 ? [si(p.a[at]!, unit), si(f[at]!, 'Hz'), '', '', ''] : p.a.length ? [si(p.a[k]!, unit), si(fk, 'Hz'), '', '', ''] : ['', '', '', '', '']);
      }
      foot = `0 dB is 1 ${data.probes[0]?.unit ?? 'V'}; each line of the spectrum is ${si(f[0]!, 'Hz')} wide`;
    } else {
      let gLo = Infinity, gHi = -Infinity;
      for (const p of data.probes) for (const d of p.db) { if (d < gLo) gLo = d; if (d > gHi) gHi = d; }
      // The gain's side in round steps, as many of them as divide the phase's turn evenly (4, 6, 8 or 12)
      const ga = niceAxis(Math.max(gLo, gHi - 160), gHi, 6);
      let steps = Math.round((ga.hi - ga.lo) / ga.step);
      const even = [4, 6, 8, 12].find((n) => n >= steps) ?? steps;
      ga.lo -= (even - steps) * ga.step; steps = even;
      const pa = { lo: -180, hi: 180, step: 360 / steps };
      g.fillStyle = dim; g.textBaseline = 'middle';
      for (let k = 0; k <= steps; k++) {
        const v = ga.lo + k * ga.step, y = Math.round(yAt(v, ga)) + 0.5;
        g.strokeStyle = line; g.setLineDash(Math.abs(v) < ga.step * 1e-6 ? [] : [2, 3]); g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke();
        g.textAlign = 'right'; g.fillText(`${Math.round(v * 10) / 10} dB`, box.x - 5, y);
        g.textAlign = 'left'; g.fillText(`${Math.round(pa.lo + k * pa.step)}°`, box.x + box.w + 5, y);
      }
      g.setLineDash([]);
      xMarks(marks);
      /** Where the gain falls 3 dB below its most, going from k towards an end (between the two points it falls through). */
      const edge = (db: Float64Array, k: number, dir: -1 | 1): string => {
        for (let j = k + dir; j >= 0 && j < db.length; j += dir) {
          if (db[j]! > db[k]! - 3) continue;
          const a = db[j - dir]!, b = db[j]!, w = a !== b ? (a - (db[k]! - 3)) / (a - b) : 0;
          return si(10 ** (Math.log10(f[j - dir]!) + w * (Math.log10(f[j]!) - Math.log10(f[j - dir]!))), 'Hz');
        }
        return '';
      };
      for (const p of data.probes) {
        curve(u, p.db, ga, hex(p.probe.colour), false);
        curve(u, p.deg, pa, hex(p.probe.colour), true, 180);
        let k = 0;
        for (let j = 1; j < p.db.length; j++) if (p.db[j]! > p.db[k]!) k = j;
        const j = at >= 0 ? at : k;
        row(p.probe, p.kept, p.gone || !p.db.length ? ['no longer on the sheet', '', '', '', ''] : [`${p.db[j]!.toFixed(1)} dB`, si(f[j]!, 'Hz'), `${p.deg[j]!.toFixed(0)}°`, edge(p.db, k, -1), edge(p.db, k, 1)]);
      }
      foot = data.note ?? 'gain solid, phase dashed; from the sources with an AC magnitude';
    }
    if (hover !== null && at >= 0 && data.view === 'spectrum') foot = `at ${si(f[at]!, 'Hz')}; ${foot}`;
  }
  cursor();
  frame();
  return { rows, foot, heads, plot: [box.x, box.w] };
}

/** One scope: its bar (its name, what it shows, Keep and Clear, another scope, close) over its plot and the key beside it. */
function Scope({ id, n, view }: { id: number; n: number; view: ScopeView }) {
  const sc = scope.value;
  const canvas = useRef<HTMLCanvasElement>(null);
  const hover = useRef<number | null>(null);
  const told = useRef(0);
  const [key, setKey] = useState<Key>({ rows: [], foot: '', heads: HEADS.time, plot: [52, 40] });
  const plot = useRef<[number, number]>([52, 40]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = (now = true) => {
      const out = paint(c, scopeData(id), hover.current);
      plot.current = out.plot;
      const t = performance.now();
      if (now || t - told.current > 200) { told.current = t; setKey(out); }
    };
    const off = onLiveFrame(() => draw(false));
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => draw());
    ro?.observe(c);
    const move = (e: PointerEvent) => { const r = c.getBoundingClientRect(), u = (e.clientX - r.left - plot.current[0]) / plot.current[1]; hover.current = u >= 0 && u <= 1 ? u : null; draw(); };
    const leave = () => { hover.current = null; draw(); };
    c.addEventListener('pointermove', move); c.addEventListener('pointerleave', leave);
    draw();
    return () => { off(); ro?.disconnect(); c.removeEventListener('pointermove', move); c.removeEventListener('pointerleave', leave); };
  }, [id, sc]);
  const picked = sc.current === id, probe = sc.probe && sc.probe.scope === id, any = !!probe || sc.kept.some((p) => p.scope === id);
  const name = `Scope ${n}`;
  return (
    <section class={`ls-scope${picked ? ' on' : ''}`} aria-label={name} onPointerDown={() => setCurrentScope(id)}>
      <div class="ls-bar">
        <button class="ls-name" aria-pressed={picked} title={picked ? 'The next probe is drawn here' : 'Pick this scope for the next probe'} onClick={() => setCurrentScope(id)}>{name}</button>
        <select aria-label={`${name} shows`} value={view} onChange={(e) => setScopeView(id, (e.target as HTMLSelectElement).value as ScopeView)}>
          {SCOPE_VIEWS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button class="btn" disabled={!probe} title="Keep this probe: it stays on the sheet as a monitor and on this scope while the next is taken" onClick={keepProbe}>Keep</button>
        <button class="btn" disabled={!any} title="Take this scope's probes off" onClick={() => clearProbes(id)}>Clear</button>
        <span class="ls-foot" aria-live="off">{key.foot}</span>
        <button class="ls-tool" aria-label="Another scope" title="Another scope beside this one" disabled={sc.scopes.length >= MAX_SCOPES} onClick={(e) => { e.stopPropagation(); addScope(); }}>+</button>
        <button class="ls-tool" aria-label={`Close ${name}`} title="Close this scope" disabled={sc.scopes.length < 2} onPointerDown={(e) => e.stopPropagation()} onClick={() => removeScope(id)}>×</button>
      </div>
      <div class="ls-main">
        <div class="ls-plotbox"><canvas class="ls-plot" role="img" aria-label={`${name}: ${key.rows.map((r) => r.label).join(', ') || 'no probe yet'}`} ref={canvas} /></div>
        <div class="ls-keybox">
          <table class="ls-key">
            <thead><tr><th scope="col">Probe</th>{key.heads.map((h, i) => <th key={i} scope="col">{h}</th>)}<th /></tr></thead>
            <tbody>
              {key.rows.map((r) => (
                <tr key={r.id} class={r.kept ? '' : 'ls-probe'}>
                  <th scope="row"><i class="ls-swatch" style={{ background: r.colour }} />{r.label}</th>
                  {r.cells.map((c, i) => <td key={i}>{c}</td>)}
                  <td>{r.kept && <button class="ls-drop" aria-label={`Take ${r.label} off ${name}`} title="Take it off this scope" onClick={() => dropProbe(r.id)}>×</button>}</td>
                </tr>
              ))}
              {!key.rows.length && <tr><td colSpan={7} class="ls-none"><div>{picked ? 'Click a wire, a pin or a two-pin part on the sheet.' : 'Pick this scope, then click on the sheet.'}</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function LiveScopePanel() {
  const st = live.value, sc = scope.value;
  if (!st) return <p class="panel-empty">Run a sheet with Design › Simulate › Live Simulation, then click a wire, a pin or a two-pin part on it: its voltage and current are drawn here as they go.</p>;
  return (
    <div class="panel-body livescope">
      {sc.scopes.map((s, i) => <Scope key={s.id} id={s.id} n={i + 1} view={s.view} />)}
    </div>
  );
}
