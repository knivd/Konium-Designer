import { useState } from 'preact/hooks';
import { h, render } from 'preact';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { notify, units, type Project } from '../state';
import { ReportDialog } from './Hierarchy';
import { SymbolPreview } from './PlacePart';
import { deliverOutputs } from './Outputs';
import { saveFileAs } from '../../platform/fs';
import type { LibSymbol } from '../../formats/altium/schlib';
import type { PcbPrim } from '../../model/pcb';
import { partLetter, SR } from '../../model/sch';
import { ELECTRICAL } from '../../model/compile';
import { symbolPins, pcbLibRuleCheck, ruleCheckReport, schLibRuleCheck, PCB_CHECK_ALL, SCH_CHECK_ALL, type PcbCheckOptions, type SchCheckOptions } from '../../model/libCheck';
import { formatCoord } from '../../core/units';
import { NO_SCRIPT } from '../../core/reportHtml';

/* ─── Component Rule Check ──────────────────────────────────────────────────────────── */

let schOpts = SCH_CHECK_ALL;
export function SchRuleCheckDialog({ libName, symbols, project }: { libName: string; symbols: () => LibSymbol[]; project: Project | null }) {
  const [o, setO] = useState(schOpts);
  const box = (k: keyof SchCheckOptions, label: string) => <label class="al-opt"><input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: (e.target as HTMLInputElement).checked })} />{label}</label>;
  const ok = () => {
    schOpts = o;
    closeDialog();
    const text = ruleCheckReport(libName, schLibRuleCheck(symbols(), o));
    showDialog(ReportDialog, { title: 'Component Rule Check', name: `${libName.replace(/\.[^.]+$/, '')}.ERR`, text, project });
  };
  return (
    <Dialog title="Library Component Rule Check" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="rulecheck"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="align-cols">
        <fieldset><legend>Duplicate</legend>{box('duplicateNames', 'Component Names')}{box('duplicatePins', 'Pins')}</fieldset>
        <fieldset><legend>Missing</legend>
          {box('missingDescription', 'Description')}{box('missingPinName', 'Pin Name')}{box('missingFootprint', 'Footprint')}
          {box('missingPinNumber', 'Pin Number')}{box('missingDesignator', 'Default Designator')}{box('missingPinsInSequence', 'Missing Pins In Sequence')}
        </fieldset>
      </div>
    </Dialog>
  );
}

let pcbOpts = PCB_CHECK_ALL;
export function PcbRuleCheckDialog({ libName, footprints, current, project }: { libName: string; footprints: () => { name: string; prims: PcbPrim[] }[]; current: () => { name: string; prims: PcbPrim[] }; project: Project | null }) {
  const [o, setO] = useState(pcbOpts);
  const [all, setAll] = useState(true);
  const box = (k: keyof PcbCheckOptions, label: string, title?: string) => <label class="al-opt" title={title}><input type="checkbox" checked={!!o[k]} onChange={(e) => setO({ ...o, [k]: (e.target as HTMLInputElement).checked })} />{label}</label>;
  const ok = () => {
    pcbOpts = o;
    closeDialog();
    const text = ruleCheckReport(libName, pcbLibRuleCheck(all ? footprints() : [current()], o), 'Warnings');
    showDialog(ReportDialog, { title: 'Component Rule Check', name: `${libName.replace(/\.[^.]+$/, '')}.ERR`, text, project });
  };
  return (
    <Dialog title="Component Rule Check" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="rulecheck"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="align-cols">
        <fieldset><legend>Duplicate</legend>{box('duplicatePads', 'Pads')}{box('duplicatePrimitives', 'Primitives')}{box('duplicateFootprints', 'Footprints')}</fieldset>
        <fieldset><legend>Constraints</legend>
          {box('missingPadNames', 'Missing Pad Names')}{box('mirrored', 'Mirrored Component', 'Text drawn mirrored on a top-side layer (copper, overlay, paste or solder mask)')}{box('offsetReference', 'Offset Component Reference')}
          <label class="al-opt" title="Copper joining pads of different names"><input type="checkbox" checked={o.shortedCopper !== false} onChange={(e) => setO({ ...o, shortedCopper: (e.target as HTMLInputElement).checked })} />Shorted Copper</label>
          <label class="al-opt" title="Copper that reaches no pad (copper text apart)"><input type="checkbox" checked={o.unconnectedCopper !== false} onChange={(e) => setO({ ...o, unconnectedCopper: (e.target as HTMLInputElement).checked })} />Unconnected Copper</label>
          <label class="al-opt"><input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} />Check All Components</label>
        </fieldset>
      </div>
    </Dialog>
  );
}

/* ─── Library Report ────────────────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8">${NO_SCRIPT}<title>${esc(title)}</title><style>
body{font:13px/1.4 Segoe UI,Arial,sans-serif;margin:24px;color:#222}h1{font-size:20px}h2{font-size:16px;margin:28px 0 6px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;margin:6px 0}td,th{border:1px solid #ccc;padding:2px 8px;text-align:left}th{background:#eee}.pv svg{width:320px;height:200px;border:1px solid #ddd;background:#fff}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

/** An SVG of the symbol, as the Place Part preview draws it. */
function symbolSvg(sym: LibSymbol): string {
  const div = document.createElement('div');
  render(h(SymbolPreview, { bags: sym.bags, part: 1 }), div);
  const s = div.innerHTML;
  render(null, div);
  return s;
}

async function saveReport(project: Project | null, name: string, text: string, what: string): Promise<void> {
  if (project?.dir) await deliverOutputs(project, name, what, [{ name, text }]);
  else { const hd = await saveFileAs(name, new TextEncoder().encode(text)); if (hd) notify(`Saved ${name}`); }
}

export function SchLibReportDialog({ libName, symbols, project }: { libName: string; symbols: () => LibSymbol[]; project: Project | null }) {
  const [o, setO] = useState({ params: true, pins: true, models: true, previews: true, name: `${libName.replace(/\.[^.]+$/, '')}.html` });
  const box = (k: 'params' | 'pins' | 'models' | 'previews', label: string) => <label class="al-opt"><input type="checkbox" checked={o[k]} onChange={(e) => setO({ ...o, [k]: (e.target as HTMLInputElement).checked })} />{label}</label>;
  const ok = () => {
    const syms = symbols();
    const body = [`<p>${syms.length} components</p>`, ...syms.map((s) => {
      const c = s.bags[0];
      const params = s.bags.filter((b, i) => i > 0 && b.int('RECORD', -1) === SR.PARAMETER).map((b) => `<tr><td>${esc(b.get('NAME') ?? '')}</td><td>${esc(b.get('TEXT') ?? '')}</td></tr>`).join('');
      const pins = symbolPins(s).filter((p) => p.mode === 0).map((p) => `<tr><td>${esc(p.designator)}</td><td>${esc(p.name)}</td><td>${ELECTRICAL[p.electrical] ?? ''}</td><td>${p.part > 0 ? partLetter(p.part) : 'all'}</td></tr>`).join('');
      const models = s.bags.filter((b) => b.int('RECORD', -1) === SR.IMPLEMENTATION).map((b) => `<tr><td>${esc(b.get('MODELNAME') ?? '')}</td><td>${esc(b.get('MODELTYPE') ?? '')}</td><td>${esc(b.get('DESCRIPTION') ?? '')}</td></tr>`).join('');
      return [`<h2>${esc(s.libRef)}</h2><p>${esc(c?.get('COMPONENTDESCRIPTION') ?? s.description)}${s.parts > 1 ? ` — ${s.parts} parts` : ''}</p>`,
        o.previews ? `<div class="pv">${symbolSvg(s)}</div>` : '',
        o.params && params ? `<table><tr><th>Parameter</th><th>Value</th></tr>${params}</table>` : '',
        o.pins && pins ? `<table><tr><th>Pin</th><th>Name</th><th>Type</th><th>Part</th></tr>${pins}</table>` : '',
        o.models && models ? `<table><tr><th>Model</th><th>Type</th><th>Description</th></tr>${models}</table>` : ''].join('');
    })].join('\n');
    closeDialog();
    void saveReport(project, o.name, page(`Schematic Library Report: ${libName}`, body), 'Library Report');
  };
  return (
    <Dialog title="Library Report Settings" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="libreport"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="rc-name">Output File Name<input type="text" value={o.name} onInput={(e) => setO({ ...o, name: (e.target as HTMLInputElement).value })} /></label>
      <fieldset><legend>Style</legend><label class="al-opt"><input type="radio" checked readOnly />Browser Style (HTML)</label></fieldset>
      <fieldset><legend>Include</legend>{box('params', "Component's Parameters")}{box('pins', "Component's Pins")}{box('models', "Component's Models")}{box('previews', 'Draw Previews')}</fieldset>
    </Dialog>
  );
}

/** A footprint drawn small: pads, tracks, arcs, fills (Library Report previews). */
function footprintSvg(prims: PcbPrim[]): string {
  const S = 1 / 10_000;
  const pts: [number, number][] = [];
  const els: string[] = [];
  const col = (l: number) => (l === 1 ? '#c00' : l === 32 ? '#00c' : l === 74 ? '#888' : l === 33 || l === 34 ? '#b8a000' : '#555');
  for (const p of prims) {
    if (p.kind === 'pad') {
      const w = p.top.w * S, hh = p.top.h * S;
      pts.push([p.at.x * S - w / 2, -p.at.y * S - hh / 2], [p.at.x * S + w / 2, -p.at.y * S + hh / 2]);
      els.push(`<rect x="${p.at.x * S - w / 2}" y="${-p.at.y * S - hh / 2}" width="${w}" height="${hh}" fill="${col(p.layer)}" opacity="0.8" transform="rotate(${-p.rotation} ${p.at.x * S} ${-p.at.y * S})"/>`);
    } else if (p.kind === 'track') {
      pts.push([p.a.x * S, -p.a.y * S], [p.b.x * S, -p.b.y * S]);
      els.push(`<line x1="${p.a.x * S}" y1="${-p.a.y * S}" x2="${p.b.x * S}" y2="${-p.b.y * S}" stroke="${col(p.layer)}" stroke-width="${Math.max(2, p.width * S)}" stroke-linecap="round"/>`);
    } else if (p.kind === 'arc') {
      pts.push([(p.c.x - p.r) * S, -(p.c.y + p.r) * S], [(p.c.x + p.r) * S, -(p.c.y - p.r) * S]);
      els.push(`<circle cx="${p.c.x * S}" cy="${-p.c.y * S}" r="${p.r * S}" fill="none" stroke="${col(p.layer)}" stroke-width="${Math.max(2, p.width * S)}"/>`);
    } else if (p.kind === 'fill') {
      pts.push([p.a.x * S, -p.a.y * S], [p.b.x * S, -p.b.y * S]);
      els.push(`<rect x="${Math.min(p.a.x, p.b.x) * S}" y="${-Math.max(p.a.y, p.b.y) * S}" width="${Math.abs(p.b.x - p.a.x) * S}" height="${Math.abs(p.b.y - p.a.y) * S}" fill="${col(p.layer)}" opacity="0.6"/>`);
    }
  }
  if (!pts.length) return '';
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), pad = 20;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - Math.min(...xs) + 2 * pad, hgt = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  return `<svg viewBox="${x0} ${y0} ${w} ${hgt}" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`;
}

export function PcbLibReportDialog({ libName, footprints, project }: { libName: string; footprints: () => { name: string; description: string; height: string; prims: PcbPrim[] }[]; project: Project | null }) {
  const [o, setO] = useState({ previews: true, name: `${libName.replace(/\.[^.]+$/, '')}.html` });
  const ok = () => {
    const u = units.value;
    const fps = footprints();
    const body = [`<p>${fps.length} footprints</p>`, ...fps.map((f) => {
      const n = (k: PcbPrim['kind']) => f.prims.filter((p) => p.kind === k).length;
      const pads = f.prims.filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad').map((p) => `<tr><td>${esc(p.name)}</td><td>${formatCoord(p.at.x, u)}</td><td>${formatCoord(p.at.y, u)}</td><td>${formatCoord(p.top.w, u)} × ${formatCoord(p.top.h, u)}</td><td>${p.hole ? formatCoord(p.hole, u) : '—'}</td></tr>`).join('');
      return [`<h2>${esc(f.name)}</h2><p>${esc(f.description)} — height ${esc(f.height)}; ${n('pad')} pads, ${n('track')} tracks, ${n('arc')} arcs, ${n('fill')} fills, ${n('region')} regions, ${n('text')} strings</p>`,
        o.previews ? `<div class="pv">${footprintSvg(f.prims)}</div>` : '',
        pads ? `<table><tr><th>Pad</th><th>X</th><th>Y</th><th>Size</th><th>Hole</th></tr>${pads}</table>` : ''].join('');
    })].join('\n');
    closeDialog();
    void saveReport(project, o.name, page(`PCB Library Report: ${libName}`, body), 'Library Report');
  };
  return (
    <Dialog title="Library Report Settings" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="libreport"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="rc-name">Output File Name<input type="text" value={o.name} onInput={(e) => setO({ ...o, name: (e.target as HTMLInputElement).value })} /></label>
      <fieldset><legend>Style</legend><label class="al-opt"><input type="radio" checked readOnly />Browser Style (HTML)</label></fieldset>
      <fieldset><legend>Include</legend><label class="al-opt"><input type="checkbox" checked={o.previews} onChange={(e) => setO({ ...o, previews: (e.target as HTMLInputElement).checked })} />Draw Previews</label></fieldset>
    </Dialog>
  );
}

/* ─── Copy / Move Component: Destination Library ────────────────────────────────────── */

export function DestinationLibraryDialog({ title, libraries, onOk }: { title: string; libraries: string[]; onOk: (name: string) => void }) {
  const [sel, setSel] = useState(0);
  const ok = (i = sel) => { const n = libraries[i]; closeDialog(); if (n) onOk(n); };
  return (
    <Dialog title={title} width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="choosesheet"
      footer={<><span class="spacer" /><button class="btn default" onClick={() => ok()} disabled={!libraries.length}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">Destination Library</p>
      <Grid cols={[{ label: 'Library', get: (n: string) => n }]} rows={libraries} sel={sel} onSel={setSel} onOpen={ok} empty="No other schematic library open or in the project." />
    </Dialog>
  );
}
