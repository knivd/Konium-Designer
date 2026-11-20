import type { PcbPrim } from '../../model/pcb';
import { L, layerColour } from '../../model/layers';
import { crossHatch } from '../../model/bodies';

/**
 * A footprint drawn small (Component Wizard, Place Component): pads in the top layer's red
 * (multi-layer pads grey with their hole), the overlay in yellow, on the board-editor black.
 * Y is up, as in the editor.
 */
export function FootprintPreview({ prims, size = 220 }: { prims: PcbPrim[]; size?: number }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const p of prims) {
    if (p.kind === 'pad') grow(p.at.x, p.at.y, Math.max(p.top.w, p.top.h) / 2);
    else if (p.kind === 'track') { grow(p.a.x, p.a.y, p.width / 2); grow(p.b.x, p.b.y, p.width / 2); }
    else if (p.kind === 'arc') grow(p.c.x, p.c.y, p.r + p.width / 2);
    else if (p.kind === 'fill') { grow(p.a.x, p.a.y); grow(p.b.x, p.b.y); }
    else if (p.kind === 'region' || p.kind === 'body') for (const v of p.outline) grow(v.x, v.y);
  }
  if (!(x0 <= x1)) return <svg class="fp-preview" width={size} height={size} role="img" aria-label="Empty footprint" />;
  const pad = (x1 - x0) * 0.08 + 1, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
  const colour = (l: number) => (l === L.MULTI ? '#c0c0c0' : l === L.BOTTOM ? '#3a6cff' : l === L.TOP ? '#e8211d' : l === L.TOP_OVERLAY ? '#ffd700' : l === L.BOTTOM_OVERLAY ? '#b8860b' : '#a060c0');
  const arcPath = (cx: number, cy: number, r: number, a: number, b: number) => {
    const sweep = ((b - a) % 360 + 360) % 360 || 360;
    if (sweep >= 359.99) return `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy}`;
    const p = (d: number) => [cx + r * Math.cos((d * Math.PI) / 180), cy + r * Math.sin((d * Math.PI) / 180)];
    const [ax, ay] = p(a), [bx, by] = p(a + sweep);
    return `M ${ax} ${ay} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${bx} ${by}`;
  };
  return (
    <svg class="fp-preview" width={size} height={size} viewBox={`${x0 - pad} ${-(y1 + pad)} ${w} ${h}`} role="img" aria-label={`Footprint preview: ${prims.filter((p) => p.kind === 'pad').length} pads`}>
      <rect x={x0 - pad} y={-(y1 + pad)} width={w} height={h} fill="#000" />
      <g transform="scale(1,-1)">
        {prims.map((p, i) => {
          switch (p.kind) {
            case 'track': return <line key={i} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={colour(p.layer)} stroke-width={p.width} stroke-linecap="round" />;
            case 'arc': return <path key={i} d={arcPath(p.c.x, p.c.y, p.r, p.start, p.end)} fill="none" stroke={colour(p.layer)} stroke-width={p.width} />;
            case 'fill': return <rect key={i} x={Math.min(p.a.x, p.b.x)} y={Math.min(p.a.y, p.b.y)} width={Math.abs(p.b.x - p.a.x)} height={Math.abs(p.b.y - p.a.y)} fill={colour(p.layer)} />;
            case 'pad': {
              const { w: pw, h: ph, shape } = p.top;
              const r = shape === 'round' ? Math.min(pw, ph) / 2 : shape === 'roundrect' ? (Math.min(pw, ph) / 2) * (p.top.cornerPct / 100) : 0;
              return (
                <g key={i} transform={`translate(${p.at.x} ${p.at.y}) rotate(${p.rotation})`}>
                  <rect x={-pw / 2} y={-ph / 2} width={pw} height={ph} rx={r} fill={colour(p.layer)} />
                  {p.hole > 0 && <circle r={p.hole / 2} fill="#1b1b1b" />}
                </g>
              );
            }
            case 'region': return p.regionKind === 0 && !p.boardCutout ? <polygon key={i} points={p.outline.map((v) => `${v.x},${v.y}`).join(' ')} fill={colour(p.layer)} /> : null;
            case 'body': {
              // Cross-hatched in its mechanical layer's colour, as AD17 draws a body in its small previews
              const sw = (x1 - x0) / 300;
              return <g key={i} stroke={`#${layerColour(p.layer).toString(16).padStart(6, '0')}`} stroke-width={sw}>
                {crossHatch(p.outline, Math.max((x1 - x0) / 60, 1)).map(([a, b], k) => <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)}
                <polygon points={p.outline.map((v) => `${v.x},${v.y}`).join(' ')} fill="none" stroke-width={sw * 1.5} />
              </g>;
            }
            default: return null;
          }
        })}
      </g>
    </svg>
  );
}
