/**
 * Writes the showcase project (not shipped: it's for the release pictures).
 *   npx vite-node tests/tools/showcase/main.ts <outdir> [--place-only]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { design } from './design';
import { buildBoard, finishBoard, routeBoard, sixLayers, writeBoard } from './pcb';
import { schematics } from './sch';
import { footprintLibrary, outJob, project } from './project';
import { exportStep } from '../../../src/formats/step/write';
import { runDrc } from '../../../src/model/drc';

const out = process.argv[2] ?? '.scratch/showcase';
const placeOnly = process.argv.includes('--place-only');
const flexOnly = process.argv.includes('--flex');
const schOnly = process.argv.includes('--sch-only');
mkdirSync(out, { recursive: true });
const log = (s: string) => { console.log(s); };

// Courtyard overlaps and parts off the board
const boxes = design.parts.map((p) => {
  const [x0, y0, x1, y1] = p.fp.court;
  const a = (p.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [p.x + x! * c - y! * s, p.y + x! * s + y! * c]);
  return { ref: p.ref, b: [Math.min(...pts.map((q) => q[0]!)), Math.min(...pts.map((q) => q[1]!)), Math.max(...pts.map((q) => q[0]!)), Math.max(...pts.map((q) => q[1]!))] as const };
});
let bad = 0;
for (let i = 0; i < boxes.length; i++) {
  const a = boxes[i]!;
  if (a.b[0] < -0.5 || a.b[1] < -0.5 || a.b[2] > 115.5 || a.b[3] > 78.5) { if (!/^J[12]$/.test(a.ref)) { log(`off board: ${a.ref} ${a.b.map((v) => v.toFixed(1))}`); bad++; } }
  for (let j = i + 1; j < boxes.length; j++) {
    const b = boxes[j]!;
    const ox = Math.min(a.b[2], b.b[2]) - Math.max(a.b[0], b.b[0]), oy = Math.min(a.b[3], b.b[3]) - Math.max(a.b[1], b.b[1]);
    if (ox > 0.05 && oy > 0.05) { log(`overlap: ${a.ref} × ${b.ref} (${ox.toFixed(2)} × ${oy.toFixed(2)})`); bad++; }
  }
}
log(`${design.parts.length} parts, ${bad} placement problems`);

if (flexOnly) {
  const { flexBoard } = await import('./flex');
  const f = await flexBoard(log);
  writeFileSync(join(out, 'SensorFlex.PcbDoc'), writeBoard(f));
  log('flex written');
  process.exit(0);
}
const sheets = schematics();
for (const f of sheets) writeFileSync(join(out, f.name), f.bytes);
writeFileSync(join(out, 'Showcase.PcbLib'), footprintLibrary());
writeFileSync(join(out, 'Showcase.PrjPcb'), project([...sheets.map((f) => f.name), 'Showcase.PcbDoc', 'Showcase.PcbLib', 'Showcase.OutJob']));
if (schOnly) { log('schematics written'); process.exit(0); }
const fresh = () => { const d = buildBoard(); sixLayers(d); return d; };
let doc = fresh();
log(`stack: ${doc.board.copperStack.length} copper layers; ${doc.nets.length} nets; ${doc.prims.length} primitives`);
if (placeOnly) {
  writeFileSync(join(out, 'Showcase.PcbDoc'), writeBoard(doc));
} else {
  // Route; nets that don't finish go first next time
  const first = new Set<string>();
  for (let attempt = 1; attempt <= 8; attempt++) {
    log(`attempt ${attempt}${first.size ? `, first: ${[...first].join(' ')}` : ''}`);
    const failed = await routeBoard(doc, log, first);
    if (!failed.length) break;
    failed.forEach((n) => first.add(n));
    if (attempt < 8) doc = fresh();
  }
  writeFileSync(join(out, 'Showcase-routed.PcbDoc'), writeBoard(doc));
  await finishBoard(doc, log);
  const drc = runDrc(doc);
  const byRule = new Map<string, number>();
  for (const v of drc.violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  log(`DRC: ${drc.violations.length} violations ${JSON.stringify([...byRule])}`); for (const v of drc.violations.slice(0, 12)) log(`  ${v.message}`);
  const bytes = writeBoard(doc);
  writeFileSync(join(out, 'Showcase.PcbDoc'), bytes);
  writeFileSync(join(out, 'Showcase.OutJob'), outJob(bytes));
  writeFileSync(join(out, 'Showcase.step'), await exportStep(doc, { holes: false, when: new Date('2026-10-28T12:00:00Z') }));
}
log(`written to ${out}`);
