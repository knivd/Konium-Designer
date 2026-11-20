/**
 * The CAM editor's tables (CAMtastic's Tables menu and the netlist's rename): Layers Sets, NC Tools,
 * Steps, Parts, Rename Nets, and the Aperture List Wizard that gives a file's D-codes their shapes
 * from an aperture list (the wizard's formats: "D10 C 0.010", "D11 R 0.060X0.040", "10 ROUND 10",
 * "D12 RECT 60 40" … in inches, mils or millimetres) [est: their layout].
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { CamEditor } from '../../editors/cam/CamEditor';
import { apertureText } from '../../editors/cam/CamEditor';
import { formatCoord, parseLengthIn, type DisplayUnit } from '../../core/units';
import { apertureDefText, liveObjects, moveXf, xfObject, type CamPart } from '../../formats/cam/camModel';
import type { Aperture, DrillLayer, GerberLayer } from '../../formats/gerber/gerberRead';
import { camEdited } from '../camCommon';

const fmtOf = (u: DisplayUnit) => (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
const footer = (ok: () => void, extra?: preact.ComponentChildren) => <>{extra}<span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

/** Tables › Layers Sets: named sets of layers (View Set Lay On / Off shows or hides one). */
export function CamLayerSetsDialog({ ed }: { ed: CamEditor }) {
  const [sets, setSets] = useState(() => (ed.doc.layerSets ?? []).map((s) => ({ ...s, layers: [...s.layers] })));
  const [cur, setCur] = useState(0);
  const names = ed.doc.layers.map((l) => l.name);
  const s = sets[cur];
  const ok = () => { ed.edit('Layers Sets', [], () => { ed.doc.layerSets = sets.filter((x) => x.name.trim()); }); camEdited(); closeDialog(); };
  return (
    <Dialog title="Layers Sets" width={560} height={420} class="cam-table cam-sets" onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={footer(ok, <><button class="btn" onClick={() => { setSets([...sets, { name: `Set ${sets.length + 1}`, layers: ed.doc.layers.filter((l) => l.visible).map((l) => l.name) }]); setCur(sets.length); }}>Add</button>
        <button class="btn" disabled={!s} onClick={() => { setSets(sets.filter((_, k) => k !== cur)); setCur(0); }}>Delete</button></>)}>
      <div class="cam-sets-body">
        <ul class="cam-set-list" aria-label="Layer sets">{sets.map((x, k) => <li key={k} class={k === cur ? 'on' : ''} onClick={() => setCur(k)}>{x.name}</li>)}</ul>
        {s ? (
          <div class="cam-set-edit">
            <label>Name <input type="text" aria-label="Set name" value={s.name} onInput={(e) => setSets(sets.map((x, k) => (k === cur ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} /></label>
            {names.map((n) => <label key={n} class="camform-check"><input type="checkbox" aria-label={`${n} in the set`} checked={s.layers.includes(n)}
              onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setSets(sets.map((x, k) => (k === cur ? { ...x, layers: on ? [...x.layers, n] : x.layers.filter((y) => y !== n) } : x))); }} />{n}</label>)}
          </div>
        ) : <p class="muted">No sets: Add makes one of the layers shown now.</p>}
      </div>
    </Dialog>
  );
}

/** Tables › NC Tools: each drill layer's tools — size (changed here), plating, hits and rout paths. */
export function CamNcToolsDialog({ ed, units }: { ed: CamEditor; units: DisplayUnit }) {
  const f = fmtOf(units);
  const drills = ed.doc.layers.filter((l) => l.data.kind === 'drill');
  const [rows, setRows] = useState(() => drills.flatMap((l) => { const d = l.data as DrillLayer; return [...d.tools.keys()].sort((a, b) => a - b).map((t) => ({ l, t, size: f(d.tools.get(t)!), plated: d.plated !== false })); }));
  const [err, setErr] = useState('');
  const ok = () => {
    const parsed = rows.map((r) => ({ ...r, c: parseLengthIn(r.size, units) }));
    const bad = parsed.find((r) => !r.c || r.c <= 0);
    if (bad) { setErr(`T${String(bad.t).padStart(2, '0')}: not a size`); return; }
    ed.edit('NC Tools', drills, () => {
      for (const r of parsed) { const d = r.l.data as DrillLayer; d.tools.set(r.t, r.c!); }
      for (const l of drills) { const mine = parsed.filter((r) => r.l === l); if (mine.length) (l.data as DrillLayer).plated = mine.every((r) => r.plated); }
    });
    camEdited();
    closeDialog();
  };
  return (
    <Dialog title="NC Tools" width={620} height={440} class="cam-table" onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, <span class="camform-err">{err}</span>)}>
      {!rows.length && <p class="muted">No drill layers.</p>}
      <table class="cam-grid" aria-label="NC tools">
        <thead><tr><th>Layer</th><th>Tool</th><th>Diameter</th><th>Plated</th><th class="num">Hits</th><th class="num">Slots</th><th class="num">Rout paths</th></tr></thead>
        <tbody>{rows.map((r, k) => {
          const d = r.l.data as DrillLayer, er = new Set(r.l.erased ?? []);
          const hits = d.hits.filter((h, i) => h.tool === r.t && !er.has(i));
          return (
            <tr key={k}><td>{r.l.name}</td><td>T{String(r.t).padStart(2, '0')}</td>
              <td><input type="text" aria-label={`T${r.t} diameter`} value={r.size} onInput={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, size: (e.target as HTMLInputElement).value } : x)))} /></td>
              <td><input type="checkbox" aria-label={`T${r.t} plated`} checked={r.plated} onChange={(e) => setRows(rows.map((x) => (x.l === r.l ? { ...x, plated: (e.target as HTMLInputElement).checked } : x)))} /></td>
              <td class="num">{hits.filter((h) => !h.slot).length}</td><td class="num">{hits.filter((h) => h.slot).length}</td><td class="num">{d.routes.filter((x) => x.tool === r.t).length}</td></tr>
          );
        })}</tbody>
      </table>
    </Dialog>
  );
}

/** Tables › Steps: the step-and-repeat blocks of every layer — repeats and steps changed here. */
export function CamStepsDialog({ ed, units }: { ed: CamEditor; units: DisplayUnit }) {
  const f = fmtOf(units);
  const blocks = ed.doc.layers.flatMap((l) => (l.data.kind === 'gerber' ? (l.data.steps ?? []).map((s) => ({ l, s })) : []));
  const [rows, setRows] = useState(() => blocks.map(({ l, s }) => ({ l, id: s.id, nx: String(s.nx), ny: String(s.ny), dx: f(s.dx), dy: f(s.dy) })));
  const [err, setErr] = useState('');
  const ok = () => {
    const parsed = rows.map((r) => ({ ...r, NX: Math.round(Number(r.nx)), NY: Math.round(Number(r.ny)), DX: parseLengthIn(r.dx, units), DY: parseLengthIn(r.dy, units) }));
    const bad = parsed.find((r) => !(r.NX >= 1) || !(r.NY >= 1) || r.DX === undefined || r.DY === undefined);
    if (bad) { setErr(`${bad.l.name} block ${bad.id}: repeats of 1 or more and steps as lengths`); return; }
    const layers = [...new Set(parsed.map((r) => r.l))];
    ed.edit('Steps', layers, () => {
      for (const r of parsed) {
        const g = r.l.data as GerberLayer;
        g.steps = g.steps!.map((s) => (s.id === r.id ? { ...s, nx: r.NX, ny: r.NY, dx: r.DX!, dy: r.DY! } : s));
        // The block's repeats made again
        const er = new Set(r.l.erased ?? []);
        g.objects.forEach((o, i) => { if (o.sr === r.id && o.srCopy) er.add(i); });
        r.l.erased = [...er].sort((a, b) => a - b);
        const base = g.objects.filter((o, i) => o.sr === r.id && !o.srCopy && !er.has(i));
        for (let a = 0; a < r.NX; a++) for (let b = 0; b < r.NY; b++) if (a || b) for (const o of base) g.objects.push({ ...xfObject(o, moveXf(a * r.DX!, b * r.DY!)), sr: r.id, srCopy: true });
      }
    });
    camEdited();
    closeDialog();
  };
  const cell = (k: number, key: 'nx' | 'ny' | 'dx' | 'dy', label: string) => <td><input type="text" aria-label={label} value={rows[k]![key]} onInput={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, [key]: (e.target as HTMLInputElement).value } : x)))} /></td>;
  return (
    <Dialog title="Steps" width={640} height={400} class="cam-table" onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, <span class="camform-err">{err}</span>)}>
      {!rows.length && <p class="muted">No step-and-repeat blocks (Edit › Step/Repeat › Add Objects makes one).</p>}
      <table class="cam-grid" aria-label="Steps">
        <thead><tr><th>Layer</th><th>Block</th><th>X repeats</th><th>Y repeats</th><th>X step</th><th>Y step</th><th class="num">Objects</th></tr></thead>
        <tbody>{rows.map((r, k) => (
          <tr key={k}><td>{r.l.name}</td><td>{r.id}</td>{cell(k, 'nx', `Block ${r.id} X repeats`)}{cell(k, 'ny', `Block ${r.id} Y repeats`)}{cell(k, 'dx', `Block ${r.id} X step`)}{cell(k, 'dy', `Block ${r.id} Y step`)}
            <td class="num">{liveObjects(r.l).filter(({ o }) => o.sr === r.id && !o.srCopy).length}</td></tr>
        ))}</tbody>
      </table>
    </Dialog>
  );
}

/** Tables › Parts: the parts made of pads — designator, value, footprint, rotation and side changed here, parts deleted. */
export function CamPartsDialog({ ed, units }: { ed: CamEditor; units: DisplayUnit }) {
  const f = fmtOf(units);
  const [rows, setRows] = useState<(CamPart & { gone?: boolean })[]>(() => (ed.doc.parts ?? []).map((p) => ({ ...p, pads: { ...p.pads } })));
  const ok = () => { ed.edit('Parts', [], () => { ed.doc.parts = rows.filter((r) => !r.gone).map(({ gone: _g, ...r }) => r); }); camEdited(); closeDialog(); };
  const set = (k: number, p: Partial<CamPart>) => setRows(rows.map((x, j) => (j === k ? { ...x, ...p } : x)));
  return (
    <Dialog title="Parts" width={720} height={460} class="cam-table" onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      {!rows.length && <p class="muted">No parts yet: select a part's pads and use Tools › Parts › Create &amp; Group Parts.</p>}
      <table class="cam-grid" aria-label="Parts">
        <thead><tr><th>Designator</th><th>Value</th><th>Footprint</th><th>X</th><th>Y</th><th>Rotation</th><th>Side</th><th class="num">Pads</th><th /></tr></thead>
        <tbody>{rows.map((r, k) => (r.gone ? null : (
          <tr key={k}>
            <td><input type="text" aria-label={`Part ${k + 1} designator`} value={r.ref} onInput={(e) => set(k, { ref: (e.target as HTMLInputElement).value })} /></td>
            <td><input type="text" aria-label={`Part ${k + 1} value`} value={r.value ?? ''} onInput={(e) => set(k, { value: (e.target as HTMLInputElement).value })} /></td>
            <td><input type="text" aria-label={`Part ${k + 1} footprint`} value={r.footprint ?? ''} onInput={(e) => set(k, { footprint: (e.target as HTMLInputElement).value })} /></td>
            <td>{f(r.at.x)}</td><td>{f(r.at.y)}</td>
            <td><input type="text" aria-label={`Part ${k + 1} rotation`} value={String(r.rot)} onInput={(e) => set(k, { rot: Number((e.target as HTMLInputElement).value) || 0 })} /></td>
            <td><select aria-label={`Part ${k + 1} side`} value={r.side} onChange={(e) => set(k, { side: (e.target as HTMLSelectElement).value as CamPart['side'] })}><option value="top">Top</option><option value="bottom">Bottom</option></select></td>
            <td class="num">{Object.values(r.pads).reduce((n, x) => n + x.length, 0)}</td>
            <td><button class="btn small" title="Delete the part (its pads stay)" onClick={() => set(k, { gone: true } as Partial<CamPart>)}>Delete</button></td>
          </tr>
        )))}</tbody>
      </table>
    </Dialog>
  );
}

/** Tools › Netlist › Rename Nets: the extracted nets' names changed. */
export function CamRenameNetsDialog({ ed }: { ed: CamEditor }) {
  const nets = ed.doc.nets ?? [];
  const [names, setNames] = useState(() => nets.map((n) => n.name));
  const [err, setErr] = useState('');
  const ok = () => {
    const dup = names.find((n, k) => !n.trim() || names.indexOf(n) !== k);
    if (dup !== undefined) { setErr(dup.trim() ? `${dup} is used twice` : 'A net needs a name'); return; }
    ed.edit('Rename Nets', [], () => { ed.doc.nets = nets.map((n, k) => ({ ...n, name: names[k]!.trim() })); });
    if (ed.shownNet && !names.includes(ed.shownNet)) ed.shownNet = null;
    camEdited();
    closeDialog();
  };
  return (
    <Dialog title="Rename Nets" width={520} height={460} class="cam-table" onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, <span class="camform-err">{err}</span>)}>
      <table class="cam-grid" aria-label="Nets">
        <thead><tr><th>Net</th><th>Layers</th></tr></thead>
        <tbody>{nets.map((n, k) => (
          <tr key={k}><td><input type="text" aria-label={`Net ${k + 1} name`} value={names[k]} onInput={(e) => { const v = names.slice(); v[k] = (e.target as HTMLInputElement).value; setNames(v); }} /></td>
            <td>{Object.keys(n.members).join(', ')}</td></tr>
        ))}</tbody>
      </table>
    </Dialog>
  );
}

/**
 * An aperture list in one of the wizard's formats: per line a D-code, a shape and its sizes —
 * D10 C 0.010 | D11 R 0.060X0.040 | 12 ROUND 10 | D13 RECT 60 40 | D14 OBLONG 0.8 1.6 | D15 SQUARE 50 …
 */
export function parseApertureList(text: string, unit: 'in' | 'mil' | 'mm'): { code: number; shape: 'C' | 'R' | 'O'; w: number; h: number }[] {
  const k = unit === 'in' ? 1e7 : unit === 'mm' ? 1e7 / 25.4 : 1e4;
  const out: { code: number; shape: 'C' | 'R' | 'O'; w: number; h: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toUpperCase();
    const m = /^D?(\d+)[\s,;:=]+([A-Z]+)[\s,;:]*([\d.]+)(?:\s*[X*,\s]\s*([\d.]+))?/.exec(line);
    if (!m) continue;
    const code = Number(m[1]);
    if (code < 10) continue;
    const word = m[2]!;
    const w = Number(m[3]) * k, h = m[4] ? Number(m[4]) * k : w;
    const shape: 'C' | 'R' | 'O' = /^(C|CIR|CIRCLE|ROUND|RND)/.test(word) ? 'C' : /^(O|OB|OBLONG|OVAL|OBROUND)/.test(word) ? 'O' : 'R';
    if (w > 0) out.push({ code, shape, w: Math.round(w), h: Math.round(h) });
  }
  return out;
}

/** Tables › Aperture List Wizard: an aperture list pasted (or read from a file) gives a layer's D-codes their shapes. */
export function CamApertureWizardDialog({ ed, units, text: initial = '' }: { ed: CamEditor; units: DisplayUnit; text?: string }) {
  const gerbers = ed.doc.layers.filter((l) => l.data.kind === 'gerber');
  const [layers, setLayers] = useState<string[]>(() => (ed.layer?.data.kind === 'gerber' ? [ed.layer.name] : gerbers.slice(0, 1).map((l) => l.name)));
  const [text, setText] = useState(initial);
  const [unit, setUnit] = useState<'in' | 'mil' | 'mm'>('in');
  const [err, setErr] = useState('');
  const list = parseApertureList(text, unit);
  const f = fmtOf(units);
  const ok = () => {
    if (!list.length) { setErr('No aperture lines read'); return; }
    const target = gerbers.filter((l) => layers.includes(l.name));
    if (!target.length) { setErr('Tick a layer'); return; }
    ed.edit('Aperture List Wizard', target, () => {
      for (const l of target) {
        const g = l.data as GerberLayer;
        for (const a of list) { const ap: Aperture = { code: a.code, shape: a.shape, w: a.w, h: a.h, def: apertureDefText(g.units, a.code, a.shape, a.w, a.h) }; g.apertures.set(a.code, ap); }
        g.warnings = g.warnings.filter((w) => !/aperture/.test(w));
      }
    });
    camEdited();
    closeDialog();
  };
  return (
    <Dialog title="Aperture List Wizard" width={640} height={520} class="cam-table cam-apwiz" onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, <span class="camform-err">{err}</span>)}>
      <div class="cam-apwiz-body">
        <label>Aperture list (one D-code per line: D10 C 0.010, D11 R 0.060X0.040, 12 ROUND 10 …)
          <textarea aria-label="Aperture list" rows={8} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} /></label>
        <label>Sizes in <select aria-label="Sizes in" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as typeof unit)}><option value="in">inches</option><option value="mil">mils</option><option value="mm">millimetres</option></select></label>
        <fieldset class="camform-layers"><legend>Layers</legend>{gerbers.map((l) => <label key={l.name}><input type="checkbox" aria-label={l.name} checked={layers.includes(l.name)} onChange={(e) => setLayers((e.target as HTMLInputElement).checked ? [...layers, l.name] : layers.filter((x) => x !== l.name))} />{l.name}</label>)}</fieldset>
        <table class="cam-grid" aria-label="Apertures read"><thead><tr><th>D-Code</th><th>Shape and size</th></tr></thead>
          <tbody>{list.map((a) => <tr key={a.code}><td>D{a.code}</td><td>{apertureText({ code: a.code, shape: a.shape, w: a.w, h: a.h, def: '' }, f)}</td></tr>)}</tbody></table>
      </div>
    </Dialog>
  );
}

