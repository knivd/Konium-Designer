/**
 * The CAM editor's tables and reports, as AD17's CAMtastic menus have them [est: their layout]:
 * Tables › Layers (each layer's name, type, colour, shown, its file kind and object count; its
 * place in the stack), Tables › Apertures (each D-code's shape and size and how often the layer
 * uses it), and Reports — the drill report (tools, sizes and hits), the aperture report and the
 * status (each layer's counts and extent).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { CamEditor } from '../../editors/cam/CamEditor';
import { apertureText } from '../../editors/cam/CamEditor';
import { CAM_LAYER_TYPES, camExtent, colourOf, sortLayers, type CamLayer, type CamLayerType } from '../../formats/cam/camDoc';
import { formatCoord, type DisplayUnit } from '../../core/units';
import { liveObjects } from '../../formats/cam/camModel';
import { camChanged } from '../camCommands';

const fmtOf = (u: DisplayUnit) => (c: number) => formatCoord(c, u, u === 'mil' ? 2 : 4);
const objects = (l: CamLayer) => (l.data.kind === 'gerber' ? l.data.objects.length : l.data.hits.length + l.data.routes.length);

/** Tables › Layers: the document's layers to edit as a table. */
export function CamLayerTableDialog({ ed }: { ed: CamEditor }) {
  const d = ed.doc;
  const [rows, setRows] = useState(() => d.layers.map((l) => ({ l, type: l.type, colour: l.colour, visible: l.visible })));
  const set = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const move = (i: number, by: number) => { const j = i + by; if (j < 0 || j >= rows.length) return; const n = [...rows]; [n[i], n[j]] = [n[j]!, n[i]!]; setRows(n); };
  const ok = () => {
    for (const r of rows) Object.assign(r.l, { type: r.type, colour: r.colour, visible: r.visible });
    const current = d.layers[d.current];
    d.layers = rows.map((r) => r.l);
    d.current = Math.max(0, current ? d.layers.indexOf(current) : Math.min(d.current, d.layers.length - 1));
    closeDialog();
    camChanged(ed);
  };
  return (
    <Dialog title="Layers Table" width={720} height={480} class="cam-table" onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><button class="btn" onClick={() => {
        // Sorted on stand-ins with the types as edited: the layers themselves change only on OK
        const stand = new Map(rows.map((r) => [{ ...r.l, type: r.type } as CamLayer, r]));
        setRows(sortLayers([...stand.keys()]).map((l) => stand.get(l)!));
      }}>Sort By Type</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <table class="cam-grid" aria-label="Layers">
        <thead><tr><th>#</th><th>Layer</th><th>Type</th><th>Colour</th><th>Shown</th><th>File</th><th class="num">Objects</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.l.name + i}>
              <td class="num">{i + 1}</td>
              <td>{r.l.name}</td>
              <td><select aria-label={`${r.l.name} type`} value={r.type} onChange={(e) => { const t = (e.target as HTMLSelectElement).value as CamLayerType; set(i, { type: t, ...(r.colour === colourOf(r.type) ? { colour: colourOf(t) } : {}) }); }}>
                {CAM_LAYER_TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
              <td><input type="color" aria-label={`${r.l.name} colour`} value={r.colour} onInput={(e) => set(i, { colour: (e.target as HTMLInputElement).value })} /></td>
              <td><input type="checkbox" aria-label={`Show ${r.l.name}`} checked={r.visible} onChange={(e) => set(i, { visible: (e.target as HTMLInputElement).checked })} /></td>
              <td>{r.l.data.kind === 'gerber' ? `Gerber (${r.l.data.units})` : `NC drill (${r.l.data.units})`}</td>
              <td class="num">{objects(r.l)}</td>
              <td><button class="btn small" title="Up the stack" onClick={() => move(i, -1)}>▲</button><button class="btn small" title="Down the stack" onClick={() => move(i, 1)}>▼</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

/** Tables › Apertures: the current layer's D-codes. */
export function CamAperturesDialog({ ed, units }: { ed: CamEditor; units: DisplayUnit }) {
  const d = ed.doc;
  const gerbers = d.layers.map((l, i) => [l, i] as const).filter(([l]) => l.data.kind === 'gerber');
  const [li, setLi] = useState(() => (d.layers[d.current]?.data.kind === 'gerber' ? d.current : gerbers[0]?.[1] ?? -1));
  const l = d.layers[li];
  const g = l?.data.kind === 'gerber' ? l.data : null;
  const f = fmtOf(units);
  const used = new Map<number, number>();
  if (g) for (const o of g.objects) if (o.kind !== 'region') used.set(o.ap, (used.get(o.ap) ?? 0) + 1);
  return (
    <Dialog title="Apertures" width={640} height={460} class="cam-table" onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <label class="cam-pick">Layer <select aria-label="Layer" value={li} onChange={(e) => setLi(Number((e.target as HTMLSelectElement).value))}>
        {gerbers.map(([gl, i]) => <option key={i} value={i}>{gl.name}</option>)}</select></label>
      {!g && <p class="muted">The document has no Gerber layer.</p>}
      {g && (
        <table class="cam-grid" aria-label="Apertures">
          <thead><tr><th>D-Code</th><th>Shape and size</th><th class="num">Used</th></tr></thead>
          <tbody>{[...g.apertures.values()].sort((a, b) => a.code - b.code).map((a) => <tr key={a.code}><td>D{a.code}</td><td>{apertureText(a, f)}</td><td class="num">{used.get(a.code) ?? 0}</td></tr>)}</tbody>
        </table>
      )}
    </Dialog>
  );
}

/** Reports: as text (Copy takes it to the clipboard). */
export function CamReportDialog({ title, text }: { title: string; text: string }) {
  return (
    <Dialog title={title} width={640} height={480} class="cam-table" onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><button class="btn" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <pre class="cam-report" aria-label={title}>{text}</pre>
    </Dialog>
  );
}

/** Reports › Drill: each drill layer's tools, their sizes and their hits and slots. */
export function drillReport(ed: CamEditor, u: DisplayUnit): string {
  const f = fmtOf(u);
  const out: string[] = [`Drill report — ${ed.doc.name}`, ''];
  let total = 0;
  for (const l of ed.doc.layers) {
    if (l.data.kind !== 'drill') continue;
    const d = l.data;
    out.push(`${l.name}${d.plated === false ? ' (non-plated)' : d.plated ? ' (plated)' : ''}`, 'Tool    Size            Hits   Slots');
    let n = 0;
    const er = new Set(l.erased ?? []);
    for (const t of [...d.tools.keys()].sort((a, b) => a - b)) {
      const hits = d.hits.filter((h, i) => h.tool === t && !er.has(i));
      const slots = hits.filter((h) => h.slot).length;
      n += hits.length;
      out.push(`T${String(t).padStart(2, '0')}     ${f(d.tools.get(t)!).padEnd(15)} ${String(hits.length - slots).padStart(5)}  ${String(slots).padStart(6)}`);
    }
    out.push(`Total   ${n} holes${d.routes.length ? `, ${d.routes.length} routed paths` : ''}`, '');
    total += n;
  }
  if (total === 0) out.push('No drill layers.');
  return out.join('\n');
}

/** Reports › Apertures: every Gerber layer's apertures and their use. */
export function apertureReport(ed: CamEditor, u: DisplayUnit): string {
  const f = fmtOf(u);
  const out: string[] = [`Aperture report — ${ed.doc.name}`, ''];
  for (const l of ed.doc.layers) {
    if (l.data.kind !== 'gerber') continue;
    const g = l.data;
    const used = new Map<number, number>();
    for (const { o } of liveObjects(l)) if (o.kind !== 'region') used.set(o.ap, (used.get(o.ap) ?? 0) + 1);
    out.push(`${l.name} (${l.type})`);
    for (const a of [...g.apertures.values()].sort((x, y) => x.code - y.code)) out.push(`  D${a.code}  ${apertureText(a, f).padEnd(40)} ${used.get(a.code) ?? 0}`);
    out.push('');
  }
  return out.join('\n');
}

/** Reports › Status: each layer's objects by kind and the document's extent. */
export function statusReport(ed: CamEditor, u: DisplayUnit): string {
  const f = fmtOf(u);
  const out: string[] = [`Status — ${ed.doc.name}`, ''];
  for (const l of ed.doc.layers) {
    if (l.data.kind === 'gerber') {
      const by = { draw: 0, arc: 0, flash: 0, region: 0 };
      for (const { o } of liveObjects(l)) by[o.kind]++;
      out.push(`${l.name.padEnd(28)} ${l.type.padEnd(14)} lines ${by.draw}, arcs ${by.arc}, flashes ${by.flash}, regions ${by.region}, apertures ${l.data.apertures.size}${l.visible ? '' : ' (hidden)'}`);
    } else out.push(`${l.name.padEnd(28)} ${l.type.padEnd(14)} holes ${l.data.hits.length - (l.erased?.length ?? 0)}, tools ${l.data.tools.size}${l.data.routes.length ? `, rout paths ${l.data.routes.length}` : ''}${l.visible ? '' : ' (hidden)'}`);
  }
  const b = camExtent(ed.doc, false);
  if (b) out.push('', `Extent ${f(b.maxX - b.minX)} × ${f(b.maxY - b.minY)}, from (${f(b.minX)}, ${f(b.minY)})`);
  return out.join('\n');
}
