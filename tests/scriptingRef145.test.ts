import { describe, expect, it } from 'vitest';
import { scriptRuntime, type ScriptMain, type ScriptMessage, type Snapshot } from '../src/scripting/runtime';
import { applyScript, snapshot } from '../src/scripting/board';
import { REFERENCE, documentedNames, type ApiOf, type RunOn } from '../src/scripting/reference';
import { SCRIPT_API } from '../src/ai/jobs';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { footprintDoc } from '../src/model/pcbLib';
import { UndoStack } from '../src/core/undo';
import { NO_NET, type PcbDocument } from '../src/model/pcb';
import { primKey } from '../src/editors/pcb/PcbEditor';

const PARAMS = ['board', 'output', 'print', 'mm', 'mil', 'inch', 'toMil', 'toInch'];
function run(snap: Snapshot, body: string): Promise<ScriptMessage> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const main = new Function(...PARAMS, `const console = { log: print, info: print, warn: print, error: print, debug: print };\nreturn (async () => {\n${body}\n})();`) as ScriptMain;
  return new Promise((res) => scriptRuntime(snap, main, res));
}
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
/** The documented names of each kind of object. */
function documented(of: ApiOf): Set<string> {
  return new Set(REFERENCE.flatMap((s) => s.blocks).flatMap((b) => ('api' in b && b.api === of ? documentedNames(b.rows) : [])));
}

describe('the Scripting Reference matches the runtime (R8)', () => {
  it('every member a script can reach is documented, and nothing that isn\'t there', async () => {
    const m = await run(snapshot(demo(), 'board', new Set()), `
      const one = (l) => Object.keys(l[0]);
      print(JSON.stringify({
        board: Object.keys(board), component: one(board.components), pad: one(board.pads), track: one(board.tracks), arc: one(board.arcs),
        via: one(board.vias), text: one(board.texts), region: one(board.regions), fill: one(board.fills), net: Object.keys(board.net('GND')), output: Object.keys(output),
      }));`);
    expect(m.type).toBe('done');
    const keys = JSON.parse(m.log[0]!) as Record<string, string[]>;
    const prim = documented('primitive');
    for (const of of ['board', 'component', 'net', 'output'] as const) expect([...documented(of)].sort(), of).toEqual([...keys[of]!].sort());
    for (const of of ['pad', 'track', 'arc', 'via', 'text', 'region', 'fill'] as const) expect([...new Set([...documented(of), ...prim])].sort(), of).toEqual([...keys[of]!].sort());
    expect([...documented('globals')].sort()).toEqual([...PARAMS, 'console'].sort());
  });

  it('the AI is told of every member too', () => {
    const all = new Set((['board', 'component', 'primitive', 'pad', 'track', 'arc', 'via', 'text', 'region', 'fill', 'net', 'output', 'globals'] as ApiOf[]).flatMap((of) => [...documented(of)]));
    const missing = [...all].filter((n) => !new RegExp(`\\b${n}\\b`).test(SCRIPT_API));
    expect(missing).toEqual([]);
  });

  it('every link goes to a section; no long dashes', () => {
    const ids = new Set(REFERENCE.map((s) => s.id));
    const text = JSON.stringify(REFERENCE);
    const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((x) => x[1]!);
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter((l) => !ids.has(l))).toEqual([]);
    expect(text).not.toMatch(/[–—]/);
  });

  it('every example in it runs, and its changes are made on the board', async () => {
    const select = (doc: PcbDocument, on: RunOn): Set<string> => {
      if (on === 'parts') return new Set(doc.prims.filter((p) => 'component' in p && p.component !== NO_NET).map(primKey));
      if (on === 'track') return new Set(['Tracks6:1']);
      if (on === 'region') return new Set(doc.prims.filter((p) => p.kind === 'region' && p.regionKind === 0 && !p.shapeOf).map(primKey));
      return new Set();
    };
    let n = 0;
    for (const s of REFERENCE) for (const b of s.blocks) {
      if (!('code' in b)) continue;
      n++;
      const on = b.run ?? 'board';
      const doc = on === 'footprint' ? footprintDoc('FP', []) : demo();
      const m = await run(snapshot(doc, on === 'footprint' ? 'footprint' : 'board', select(doc, on)), b.code);
      expect(m.type === 'error' ? `${s.id}: ${m.message}` : 'done', `${s.title}:\n${b.code}`).toBe('done');
      if (m.type !== 'done') continue;
      new UndoStack().transact('Run script', (tx) => applyScript(doc, m.ops, tx));
    }
    expect(n).toBeGreaterThan(15);
  });
});

describe('the runtime: a script\'s own view follows its changes', () => {
  it('a part moved and turned takes its pads along; a removed track leaves the list; the selection follows select()', async () => {
    const m = await run(snapshot(demo(), 'board', new Set()), `
      const c = board.component('C1');
      const before = c.pads().map((p) => [p.x, p.y]);
      c.moveBy(10, 0).rotateBy(90);
      print(JSON.stringify(before), JSON.stringify(c.pads().map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), p.rotation])));
      c.setDesignator('C9'); print(c.pads()[0].component, board.pads.filter((p) => p.component === 'C9').length);
      const n = board.tracks.length; const t = board.tracks[0]; t.remove(); print(n - board.tracks.length, board.tracks.includes(t));
      board.addVia({ x: 1, y: 1 }); print(board.vias.length);
      board.select([c]); print(board.selected.map((o) => o.designator ?? o.id).join(','));`);
    expect(m.type).toBe('done');
    expect(m.log).toEqual(['[[13.05,15],[14.95,15]] [[24,14.05,90],[24,15.95,90]]', 'C9 2', '1 false', '4', 'C9']);
  });
  it('more than 5,000 lines: the rest left out, said once; 21 files: an error', async () => {
    const m = await run(snapshot(demo(), 'board', new Set()), `for (let i = 0; i < 6000; i++) print(i);`);
    expect(m.type === 'done' && [m.log.length, m.log.at(-1)]).toEqual([5001, '… (lines after 5000 left out)']);
    const f = await run(snapshot(demo(), 'board', new Set()), `for (let i = 0; i < 21; i++) output.text('f' + i + '.txt', 'x');`);
    expect(f.type === 'error' && f.message).toMatch(/Too many files \(20 at most\)/);
  });
});
