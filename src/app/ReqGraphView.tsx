/**
 * A requirements document's connection graph (beside its table): each requirement a box, under its
 * parent left to right, coloured by where its verification stands; on the right the parts, nets,
 * documents and the board the requirements are linked to. The requirement picked lights up with
 * the ones above and under it and what in the design they are met by; a click picks a requirement,
 * or shows a design item in the design. Ctrl+wheel zooms; the buttons zoom and fit.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { LINK_KINDS, labelOf, type ReqLink, type ReqRow, type Requirement, type VerifyState } from '../model/requirements';
import { LINK_H, NODE_H, reqGraph, related } from '../model/reqGraph';
import { ColourIcon } from './icons';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function ReqGraphView({ rows, picked, state, onPick, onShow }: {
  rows: ReqRow[]; picked: string | null; state: (r: Requirement) => VerifyState; onPick: (row: number) => void; onShow: (l: ReqLink) => void;
}) {
  const g = useMemo(() => reqGraph(rows), [rows, rows.length, ...rows.map((r) => (r.kind === 'req' ? `${r.id}|${r.parent ?? ''}|${r.title}|${r.links.length}|${r.status}` : r.title))]);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const lit = picked ? related(g, picked) : null;
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of g.reqs) pos.set(`req:${n.req.id}`, n);
  for (const n of g.links) pos.set(`link:${n.key}`, n);
  const dim = (k: string) => (lit && !lit.has(k) ? ' dim' : '');
  const fit = () => { const el = box.current; if (el) setZoom(Math.max(0.2, Math.min(1.5, Math.min(el.clientWidth / g.width, el.clientHeight / g.height)))); };
  return (
    <div class="rg-wrap">
      <div class="rg-zoom" role="toolbar" aria-label="Zoom">
        <button type="button" class="tbtn" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z * 1.25))}><ColourIcon name="zoomIn" /></button>
        <button type="button" class="tbtn" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))}><ColourIcon name="zoomOut" /></button>
        <button type="button" class="tbtn" title="Fit the graph" aria-label="Fit the graph" onClick={fit}><ColourIcon name="reqGraphFit" /></button>
        <span class="small muted">{Math.round(zoom * 100)}%</span>
      </div>
      <div class="rg-scroll" ref={box} onWheel={(e) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom((z) => Math.max(0.2, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))); }}>
        {g.reqs.length === 0 ? <p class="muted reqdoc-empty">No requirements to draw yet.</p> : (
          <svg class="rg" width={g.width * zoom} height={g.height * zoom} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label="Connection graph of the requirements">
            {g.sections.map((s) => (
              <g key={`s${s.row}`} class="rg-section">
                <line x1={8} x2={g.width - 8} y1={s.y + 22} y2={s.y + 22} />
                <text x={12} y={s.y + 16}>{s.title || 'Untitled section'}</text>
              </g>
            ))}
            {g.edges.map((e, k) => {
              const a = pos.get(e.from), b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
              const on = lit && lit.has(e.from) && lit.has(e.to);
              return <path key={k} class={`rg-edge ${e.kind === 'parent' ? 'rg-parent' : `rg-to-${e.kind}`}${on ? ' on' : lit ? ' dim' : ''}`} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} />;
            })}
            {g.reqs.map((n) => {
              const k = `req:${n.req.id}`;
              return (
                <g key={k} class={`rg-node ver-${state(n.req)}${n.req.status === 'obsolete' ? ' obsolete' : ''}${picked === n.req.id ? ' picked' : ''}${dim(k)}`} transform={`translate(${n.x} ${n.y})`}
                  role="button" tabIndex={0} aria-label={`${n.req.id} ${n.req.title}`} onClick={() => onPick(n.row)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(n.row); } }}>
                  <title>{`${n.req.id}${n.req.title ? `: ${n.req.title}` : ''}${n.req.text ? `\n${clip(n.req.text, 300)}` : ''}`}</title>
                  <rect width={n.w} height={NODE_H} rx={5} />
                  <text x={8} y={15} class="rg-id">{n.req.id}</text>
                  <text x={8} y={31} class="rg-title">{clip(n.req.title || 'What is required', 30)}</text>
                </g>
              );
            })}
            {g.links.map((n) => {
              const k = `link:${n.key}`;
              return (
                <g key={k} class={`rg-item rg-${n.link.kind}${dim(k)}`} transform={`translate(${n.x} ${n.y})`} role="button" tabIndex={0}
                  aria-label={`${labelOf(LINK_KINDS, n.link.kind)} ${n.link.ref}: show it in the design`} onClick={() => onShow(n.link)} onKeyDown={(e) => { if (e.key === 'Enter') onShow(n.link); }}>
                  <title>{`${labelOf(LINK_KINDS, n.link.kind)} ${n.link.ref}: show it in the design`}</title>
                  <rect width={n.w} height={LINK_H} rx={LINK_H / 2} />
                  <text x={10} y={17}><tspan class="rg-kind">{labelOf(LINK_KINDS, n.link.kind)}</tspan> {clip(n.link.ref, 20)}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
