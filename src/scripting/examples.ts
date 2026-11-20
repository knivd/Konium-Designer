/** Scripts that come with Konium Designer (R8): read, run, or copied to start one of your own. */
export interface ScriptDef {
  id: string; name: string; code: string; builtIn?: boolean;
  /** A project's script: its file in the project's Scripts folder, and the project. */
  file?: string; projectId?: string;
}

export const EXAMPLES: ScriptDef[] = [
  {
    id: 'ex-circle', name: 'Place selected parts in a circle', builtIn: true, code: `// Places the selected parts evenly round a circle about their middle, each turned to face outwards.
const radius = 20; // mm

const parts = board.selected.filter((o) => o.kind === 'component');
if (parts.length < 2) throw new Error('Select two parts or more first');
const cx = parts.reduce((s, c) => s + c.x, 0) / parts.length;
const cy = parts.reduce((s, c) => s + c.y, 0) / parts.length;
parts.forEach((c, i) => {
  const a = (360 / parts.length) * i;
  c.moveTo(cx + radius * Math.cos((a * Math.PI) / 180), cy + radius * Math.sin((a * Math.PI) / 180));
  c.rotateTo(a);
});
board.select(parts);
print(\`\${parts.length} parts round a \${radius} mm circle at (\${cx.toFixed(2)}, \${cy.toFixed(2)})\`);
`,
  },
  {
    id: 'ex-renumber', name: 'Renumber designators by position', builtIn: true, code: `// Renumbers the parts by where they are: in rows from the top left, each prefix on its own (R1, R2 … C1, C2 …).
// Then Design › Update Schematics in the project takes the new designators back to the sheets.
const row = 5; // mm: parts this close in Y count as one row

const groups = {};
for (const c of board.components) {
  const m = /^([A-Za-z_]+)\\d+$/.exec(c.designator);
  if (m) (groups[m[1]] ??= []).push(c);
}
let n = 0;
for (const [prefix, parts] of Object.entries(groups)) {
  parts.sort((a, b) => Math.round(b.y / row) - Math.round(a.y / row) || a.x - b.x);
  parts.forEach((c, i) => c.setDesignator(prefix + (i + 1)));
  n += parts.length;
}
print(\`\${n} parts renumbered\`);
`,
  },
  {
    id: 'ex-jlc', name: 'Pick and place file for JLCPCB', builtIn: true, code: `// A pick-and-place (CPL) file in JLCPCB's columns: Designator, Mid X, Mid Y, Layer, Rotation (millimetres).
// The middle is the middle of the part's pads.
const rows = [['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']];
for (const c of board.components) {
  const pads = c.pads();
  const xs = pads.length ? pads.map((p) => p.x) : [c.x], ys = pads.length ? pads.map((p) => p.y) : [c.y];
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  rows.push([c.designator, x.toFixed(4), y.toFixed(4), c.side === 'top' ? 'Top' : 'Bottom', c.rotation.toFixed(2)]);
}
output.csv(board.name + '-CPL.csv', rows);
print(\`\${rows.length - 1} parts\`);
`,
  },
  {
    id: 'ex-fence', name: 'Via fence along selected tracks', builtIn: true, code: `// Stitches vias along both sides of the selected tracks (a fence beside an RF line),
// leaving out any that would come too close to another net's copper.
const net = 'GND';
const pitch = 1.0;      // mm between vias
const offset = 1.0;     // mm from the track's centre line
const diameter = 0.6;   // mm, the vias' size
const clearance = 0.3;  // mm from other nets' tracks, arcs, pads and vias, as your clearance rule (pours, regions, fills: run the DRC)

if (!board.nets.includes(net)) throw new Error(\`No net \${net} on this board\`);
const tracks = board.selected.filter((o) => o.kind === 'track');
if (!tracks.length) throw new Error('Select the tracks to fence first');
const copper = (layer) => /^(Top Layer|Bottom Layer|Multi-Layer|Mid-Layer)/.test(layer);
const toSegment = (x, y, t) => {
  const dx = t.x2 - t.x1, dy = t.y2 - t.y1, l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((x - t.x1) * dx + (y - t.y1) * dy) / l2)) : 0;
  return Math.hypot(x - (t.x1 + u * dx), y - (t.y1 + u * dy));
};
// How far a point is from a pad's edge (as a rectangle, turned with the pad)
const toPad = (x, y, p) => {
  const r = (-p.rotation * Math.PI) / 180, dx = x - p.x, dy = y - p.y;
  const u = Math.abs(dx * Math.cos(r) - dy * Math.sin(r)) - p.width / 2, v = Math.abs(dx * Math.sin(r) + dy * Math.cos(r)) - p.height / 2;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0));
};
const room = diameter / 2 + clearance;
const clear = (x, y) =>
  board.tracks.every((t) => t.net === net || !copper(t.layer) || toSegment(x, y, t) > t.width / 2 + room) &&
  board.arcs.every((a) => a.net === net || !copper(a.layer) || Math.abs(Math.hypot(x - a.x, y - a.y) - a.radius) > a.width / 2 + room) &&
  board.pads.every((p) => p.net === net || toPad(x, y, p) > room) &&
  board.vias.every((v) => v.net === net || Math.hypot(x - v.x, y - v.y) > v.diameter / 2 + room);
const placed = [];
let skipped = 0;
const near = (x, y) => placed.some((p) => Math.hypot(p.x - x, p.y - y) < pitch / 2);
for (const t of tracks) {
  const dx = t.x2 - t.x1, dy = t.y2 - t.y1, len = Math.hypot(dx, dy);
  if (!len) continue;
  const ux = dx / len, uy = dy / len;
  for (let d = 0; d <= len + 1e-9; d += pitch) {
    for (const side of [1, -1]) {
      const x = t.x1 + ux * d - uy * offset * side, y = t.y1 + uy * d + ux * offset * side;
      if (near(x, y)) continue;
      if (clear(x, y)) placed.push(board.addVia({ x, y, net, diameter, hole: diameter / 2 }));
      else skipped++;
    }
  }
}
board.select(placed);
print(\`\${placed.length} vias on \${net}\${skipped ? \`, \${skipped} left out (too close to other nets)\` : ''}\`);
`,
  },
  {
    id: 'ex-nets', name: 'Net report', builtIn: true, code: `// Every net: its pads, vias and routed length, as a CSV file (pour copper not counted).
const rows = [['Net', 'Pads', 'Vias', 'Routed length (mm)']];
for (const name of [...board.nets].sort()) {
  const n = board.net(name);
  const arcs = n.arcs.reduce((s, a) => s + (a.radius * (((a.end - a.start) % 360 + 360) % 360 || 360) * Math.PI) / 180, 0);
  const length = n.tracks.reduce((s, t) => s + Math.hypot(t.x2 - t.x1, t.y2 - t.y1), 0) + arcs;
  rows.push([name, n.pads.length, n.vias.length, length.toFixed(2)]);
}
output.csv(board.name + '-nets.csv', rows);
print(\`\${rows.length - 1} nets\`);
`,
  },
  {
    id: 'ex-ring', name: 'Pads round a circle (footprint)', builtIn: true, code: `// Adds pads round a circle (a round connector, an LED ring), numbered on from the highest pad.
const count = 8;
const radius = 3;   // mm
const size = 0.8;   // mm across

for (let i = 0; i < count; i++) {
  const a = (360 / count) * i;
  board.addPad({ x: radius * Math.cos((a * Math.PI) / 180), y: radius * Math.sin((a * Math.PI) / 180), width: size, rotation: a });
}
print(\`\${count} pads on a \${radius} mm circle\`);
`,
  },
];

/** A new script's start. */
export const NEW_SCRIPT = `// What this script does.
// board: the board or footprint in front; print(): a line below; output.csv(name, rows): a file to save.
// Help (?) lists everything a script can use.

for (const c of board.selected) print(c.kind, c.designator ?? c.id);
`;
