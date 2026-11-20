/**
 * Cadence round trip, measured (R11): the OrCAD Capture designs (.dsn) and Allegro boards (.brd) in
 * each folder just under a folder imported as the Import Wizard does (a design and a board of one name,
 * or the only ones in the folder, one project), then exported for Cadence unchanged: the .dsn and
 * .brd should come back byte for byte. Where a project has both, the board's pins are checked
 * against the schematics' nets as Konium compiles them: each pin on the board net that its
 * schematic net's pins are on, and that board net the one of that schematic net (by connection,
 * not by name).
 *
 *   npx vite-node tests/tools/cadenceRoundTrip.ts <folder>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { importCadence } from '../../src/formats/cadenceImport';
import { exportCadence } from '../../src/formats/cadenceExport';
import { load } from '../../src/formats/registry';
import { compileProject } from '../../src/model/compile';
import { iniGet, readPrjPcb } from '../../src/formats/altium/prjpcb';
import { NO_NET, type PcbDocument } from '../../src/model/pcb';
import type { SchDocument } from '../../src/model/sch';

const [dir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: cadenceRoundTrip.ts <folder>'); process.exit(2); }
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

const byDir = new Map<string, string[]>();
// (each folder just under the one given is a project's: its designs and boards imported together, as the wizard pairs them)
const top = (p: string) => { const r = relative(dir, p).split(/[\\/]/); return r.length > 1 ? join(dir, r[0]!) : dirname(p); };
for (const p of walk(dir).filter((x) => /\.(dsn|brd)$/i.test(x))) byDir.set(top(p), [...(byDir.get(top(p)) ?? []), p]);
const out: string[] = [];
let designs = 0, designsBack = 0, boards = 0, boardsBack = 0, pins = 0, pinsSame = 0;
for (const [d, paths] of [...byDir].sort()) {
  const files = paths.map((p) => ({ path: relative(dir, p), bytes: new Uint8Array(readFileSync(p)) }));
  const t0 = Date.now();
  const r = await importCadence(files);
  for (const m of r.messages.filter((x) => x.level === 'error')) out.push(`${relative(dir, d)}: ${m.message}`);
  for (const prj of r.projects) {
    const docs = prj.documents.filter((x) => /\.(schdoc|pcbdoc)$/i.test(x.name)).map((x) => ({ name: x.name, doc: load(x.bytes, x.name) }));
    const sheets = docs.filter((x) => x.doc.kind === 'SchDoc').map((x) => ({ name: x.name, doc: x.doc as SchDocument }));
    const board = docs.find((x) => x.doc.kind === 'PcbDoc')?.doc as PcbDocument | undefined;
    const e = exportCadence({ name: prj.name, sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: Number(iniGet(readPrjPcb(prj.prj.bytes, prj.prj.name), 'Design', 'HierarchyMode') ?? 2), variables: [] });
    const src = (re: RegExp) => files.find((f) => re.test(f.path) && f.path.toLowerCase().replace(/\.[^.]+$/, '').endsWith(prj.name.toLowerCase()))?.bytes ?? files.find((f) => re.test(f.path))?.bytes;
    const note: string[] = [];
    if (sheets.length) { designs++; const back = e.files.find((f) => /\.dsn$/i.test(f.path)); const ok = same(back?.bytes, src(/\.dsn$/i) ?? new Uint8Array()); if (ok) designsBack++; note.push(`design ${ok ? 'back byte for byte' : 'NOT back'} (${sheets.length} sheets)`); }
    if (board) { boards++; const back = e.files.find((f) => /\.brd$/i.test(f.path)); const ok = same(back?.bytes, src(/\.brd$/i) ?? new Uint8Array()); if (ok) boardsBack++; note.push(`board ${ok ? 'back byte for byte' : 'NOT back'}`); }
    // The board's pins on the schematics' nets
    if (sheets.length && board) {
      try {
        // (with the project's Net Identifier Scope, as the import set it)
        const c = compileProject(sheets, { scope: Number(iniGet(readPrjPcb(prj.prj.bytes, prj.prj.name), 'Design', 'HierarchyMode') ?? 2) });
        // (by connection, not by name: a hierarchical net's name is chosen differently by each tool)
        // (each schematic net by its place in the list: two nets of a hierarchical design may share a name)
        const net = new Map(c.nets.flatMap((nn, ni) => nn.pins.map((p): [string, string] => [`${p.designator}.${p.pin}`, `${ni}`])));
        const pairs: [string, string][] = [];
        for (const p of board.prims) {
          if (p.kind !== 'pad' || p.component === NO_NET) continue;
          const want = net.get(`${board.components[p.component]?.designator}.${p.name}`);
          if (want === undefined) continue;
          pairs.push([want, p.net !== NO_NET ? board.nets[p.net]?.name ?? '' : '']);
        }
        const most = (m: Map<string, Map<string, number>>) => new Map([...m].map(([k, v]) => [k, [...v].sort((x, y) => y[1] - x[1])[0]![0]]));
        const tally = (ix: 0 | 1) => { const m = new Map<string, Map<string, number>>(); for (const pr of pairs) { const a = pr[ix], b = pr[1 - ix]!; const v = m.get(a) ?? new Map<string, number>(); v.set(b, (v.get(b) ?? 0) + 1); m.set(a, v); } return most(m); };
        const toBoard = tally(0), toSch = tally(1);
        const n = pairs.length, k = pairs.filter(([a, b]) => b && toBoard.get(a) === b && toSch.get(b) === a).length;
        pins += n; pinsSame += k;
        note.push(`board pins connected as the schematics connect them: ${k} of ${n}`);
      } catch (x) { note.push(`not compiled: ${(x as Error).message}`); }
    }
    out.push(`${relative(dir, d) || '.'} / ${prj.name}: ${note.join('; ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}
out.push('', `Designs back byte for byte: ${designsBack} of ${designs}`, `Boards back byte for byte: ${boardsBack} of ${boards}`, `Board pins connected as the schematics connect them: ${pinsSame} of ${pins}`);
console.log(out.join('\n'));
