import { describe, expect, it } from 'vitest';
import { scriptRuntime, type ScriptMessage, type ScriptMain, type Snapshot } from '../src/scripting/runtime';
import { scriptLine, workerSource } from '../src/scripting/sandbox';
import { applyScript, snapshot } from '../src/scripting/board';
import { EXAMPLES } from '../src/scripting/examples';
import { fromFile, scriptFile } from '../src/scripting/store';
import { SCRIPT, SCRIPT_API } from '../src/ai/jobs';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { footprintDoc } from '../src/model/pcbLib';
import { UndoStack } from '../src/core/undo';
import { mm } from '../src/core/units';
import { L } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbTrack, type PcbVia } from '../src/model/pcb';
import { primKey } from '../src/editors/pcb/PcbEditor';

/** Run a script's code (as the worker does: the body of an async function) on a snapshot, in this process. */
function run(snap: Snapshot, body: string): Promise<ScriptMessage> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const main = new Function('board', 'output', 'print', 'mm', 'mil', 'inch', 'toMil', 'toInch', `return (async () => {\n${body}\n})();`) as ScriptMain;
  return new Promise((res) => scriptRuntime(snap, main, res));
}
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
/** Run on a board and make its changes, as Run does: the message and the undo stack. */
async function runOn(doc: PcbDocument, body: string, sel: Set<string> = new Set()) {
  const msg = await run(snapshot(doc, 'board', sel), body);
  if (msg.type !== 'done') throw new Error(msg.message);
  const undo = new UndoStack();
  let r: ReturnType<typeof applyScript> | null = null;
  undo.transact('Run script', (tx) => { r = applyScript(doc, msg.ops, tx); });
  return { msg, undo, result: r! as ReturnType<typeof applyScript> };
}

describe('scripting: what a script sees (R8)', () => {
  it('the demo board in millimetres from its origin, layers and nets by name, parts with their pads', async () => {
    const snap = snapshot(demo(), 'board', new Set());
    expect(snap.components.map((c) => c.designator)).toEqual(['J1', 'C1', 'U1', 'C2']);
    expect(snap.nets).toEqual(['GND', 'VIN', '+3V3']);
    expect(snap.layers.slice(0, 2)).toEqual(['Top Layer', 'Bottom Layer']);
    expect(snap.tracks[0]).toMatchObject({ id: 'Tracks6:0', x1: 5, layer: 'Top Layer', net: 'VIN', width: 0.6, component: null });
    const m = await run(snap, `const u = board.component('U1'); print(u.footprint, u.pads().length, board.net('GND').pads.length > 0, mil(100), toMil(2.54));`);
    expect(m).toMatchObject({ type: 'done', log: ['SOT-223 4 true 2.54 100'] });
  });
  it('a selected part comes whole (not its pads); a selected track on its own', () => {
    const doc = demo();
    const keys = new Set([...doc.prims.filter((p) => 'component' in p && p.component === 2).map(primKey), 'Tracks6:3']);
    expect(snapshot(doc, 'board', keys).selection).toEqual(['c2', 'Tracks6:3']);
  });
});

describe('scripting: the runtime', () => {
  const snap = () => snapshot(demo(), 'board', new Set());
  it('records what is asked, in order; reads back what it set', async () => {
    const m = await run(snap(), `const c = board.component('C1'); c.moveTo(10, 12).rotateBy(90); c.setDesignator('C9'); print(c.x, c.rotation, c.designator);
      const v = board.addVia({ x: 1, y: 2, net: 'GND' }); v.moveBy(1, 0); board.tracks[0].setWidth(0.3); board.select([c, v]);`);
    expect(m.type).toBe('done');
    if (m.type !== 'done') return;
    expect(m.log).toEqual(['10 90 C9']);
    expect(m.ops.map((o) => o.op)).toEqual(['compMove', 'compRotate', 'designator', 'add', 'move', 'width', 'select']);
  });
  it('a helpful error: a net, a layer, a locked part, a part\'s pad moved on its own, a removed object', async () => {
    const cases: [string, RegExp][] = [
      [`board.addTrack({ x1: 0, y1: 0, x2: 1, y2: 0, net: 'VCC' })`, /No net "VCC"/],
      [`board.addText({ x: 0, y: 0, text: 'A', layer: 'Silk' })`, /No layer "Silk"/],
      [`board.component('U1').pads()[0].moveBy(1, 0)`, /part of U1: move the part itself/],
      [`const t = board.tracks[0]; t.remove(); t.setWidth(1)`, /was removed/],
      [`board.addVia({ x: 'a', y: 0 })`, /x must be a number/],
      [`await Promise.resolve(); throw new Error('Select two parts')`, /Select two parts/],
    ];
    for (const [code, want] of cases) {
      const m = await run(snap(), code);
      expect(m.type, code).toBe('error');
      if (m.type === 'error') expect(m.message, code).toMatch(want);
    }
    const locked = snap();
    locked.components[0]!.locked = true;
    const m = await run(locked, `board.components[0].moveBy(1, 0)`);
    expect(m.type === 'error' && m.message).toMatch(/J1 is locked/);
  });
  it('a CSV with its cells quoted as needed; a new pad numbered after the highest', async () => {
    const m = await run(snapshot(footprintDoc('FP', []), 'footprint', new Set()), `output.csv('a.csv', [['a', 'b,c', 'say "hi"'], [1.5, null]]); board.addPad({ x: 0, y: 0 }); const p = board.addPad({ x: 1, y: 0 }); print(p.name, p.layer, board.addPad({ x: 2, y: 0, hole: 0.8 }).layer)`);
    expect(m.type === 'done' && m.files[0]).toEqual({ name: 'a.csv', text: 'a,"b,c","say ""hi"""\r\n1.5,\r\n' });
    expect(m.type === 'done' && m.log).toEqual(['2 Top Layer Multi-Layer']);
  });
  it('stands alone: its source runs as the worker gets it, with the script\'s lines found', async () => {
    const { src, offset } = workerSource(`print(board.components.length);\nboard.select(board.components);`);
    const posted: ScriptMessage[] = [];
    const self: { onmessage: ((e: { data: Snapshot }) => void) | null; postMessage(m: ScriptMessage): void } = { onmessage: null, postMessage: (m) => posted.push(m) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('self', src)(self);
    self.onmessage!({ data: snap() });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted[0]).toMatchObject({ type: 'done', log: ['4'] });
    expect(src.split('\n')[offset]).toBe('print(board.components.length);');
    expect(scriptLine(offset, undefined, `TypeError: x\n    at eval (blob:null/3f2a-11:${offset + 2}:7)`)).toBe(2);
    expect(scriptLine(offset, offset + 1)).toBe(1);
    // An error raised by a method of the board: the runtime's frame first, then the script's line that called it
    expect(scriptLine(offset, undefined, `Error: No net "X"\n    at netOk (blob:null/3f2a-11:40:13)\n    at Object.addVia (blob:null/3f2a-11:200:9)\n    at eval (blob:null/3f2a-11:${offset + 3}:9)`)).toBe(3);
  });
});

describe('scripting: the changes made on the board', () => {
  it('parts moved and turned, renumbered, a track narrowed, a via added: one undo step, saved and read back', async () => {
    const doc = demo();
    const { undo, result } = await runOn(doc, `board.component('C1').moveTo(20, 15).rotateTo(90); board.component('C2').setDesignator('C7');
      board.tracks[0].setWidth(0.3).setNet('GND'); const v = board.addVia({ x: 3, y: 4, net: 'GND', diameter: 0.8, hole: 0.4 }); v.moveBy(1, 1); board.select([v, board.component('C1')]);`);
    const o = doc.board.origin;
    const c1 = doc.components.find((c) => c.designator === 'C1')!;
    expect(c1.at).toEqual({ x: o.x + mm(20), y: o.y + mm(15) });
    expect(c1.rotation).toBe(90);
    expect(doc.components.some((c) => c.designator === 'C7')).toBe(true);
    const t0 = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === 0)!;
    expect(t0.width).toBe(mm(0.3));
    expect(doc.nets[t0.net]?.name).toBe('GND');
    const via = doc.prims.filter((p): p is PcbVia => p.kind === 'via').at(-1)!;
    expect(via.at).toEqual({ x: o.x + mm(4), y: o.y + mm(5) });
    expect([via.diameter, via.hole, doc.nets[via.net]?.name]).toEqual([mm(0.8), mm(0.4), 'GND']);
    expect(result.summary).toBe('1 part moved or turned, 1 designator changed, 1 object changed, 1 object added');
    expect(result.select).toContain(primKey(via));
    // Saved and read again
    const back = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(back.components.map((c) => c.designator)).toEqual(['J1', 'C1', 'U1', 'C7']);
    expect(back.prims.filter((p) => p.kind === 'via')).toHaveLength(4);
    // One step back to the board as it was
    undo.undo();
    const was = demo();
    expect(doc.components.map((c) => [c.designator, c.at, c.rotation])).toEqual(was.components.map((c) => [c.designator, c.at, c.rotation]));
    expect(doc.prims.filter((p) => p.kind === 'via')).toHaveLength(3);
    expect(doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === 0)!.width).toBe(mm(0.6));
  });
  it('removals made last: the objects asked for go, the rest stay, the selection follows the records', async () => {
    const doc = demo();
    const before = doc.prims.filter((p) => p.kind === 'track').length;
    const { result } = await runOn(doc, `board.tracks[0].remove(); board.tracks[2].remove(); const t = board.addTrack({ x1: 0, y1: 0, x2: 5, y2: 0, layer: 'Bottom Layer' }); board.select([board.tracks[3], t]);`);
    expect(doc.prims.filter((p) => p.kind === 'track')).toHaveLength(before - 1);
    expect(result.select).toHaveLength(2);
    for (const k of result.select!) expect(doc.prims.some((p) => primKey(p) === k)).toBe(true);
    const added = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.layer === L.BOTTOM && p.a.x === doc.board.origin.x && p.width === mm(0.254));
    expect(added).toBeTruthy();
  });
  it('a footprint: pads added round a circle (the example), numbered 1 to 8, on the top layer', async () => {
    const fp = footprintDoc('RING', []);
    const msg = await run(snapshot(fp, 'footprint', new Set()), EXAMPLES.find((e) => e.id === 'ex-ring')!.code);
    expect(msg.type).toBe('done');
    if (msg.type !== 'done') return;
    new UndoStack().transact('Run', (tx) => applyScript(fp, msg.ops, tx));
    const pads = fp.prims.filter((p): p is PcbPad => p.kind === 'pad');
    expect(pads.map((p) => p.name)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(pads.every((p) => p.layer === L.TOP && p.net === NO_NET && Math.abs(Math.hypot(p.at.x, p.at.y) - mm(3)) < 2)).toBe(true);
  });
  it('the examples run on the demo board (those needing a selection say so)', async () => {
    for (const ex of EXAMPLES) {
      if (ex.id === 'ex-ring') continue;
      const m = await run(snapshot(demo(), 'board', new Set()), ex.code);
      if (ex.id === 'ex-circle' || ex.id === 'ex-fence') { expect(m.type === 'error' && m.message, ex.name).toMatch(/^Select/); continue; }
      expect(m.type, `${ex.name}: ${m.type === 'error' ? m.message : ''}`).toBe('done');
    }
    const doc = demo();
    const keys = new Set(doc.prims.filter((p) => 'component' in p && p.component !== NO_NET).map(primKey));
    const { result } = await runOn(doc, EXAMPLES.find((e) => e.id === 'ex-circle')!.code, keys);
    expect(result.summary).toBe('4 parts moved or turned');
    const jlc = await run(snapshot(demo(), 'board', new Set()), EXAMPLES.find((e) => e.id === 'ex-jlc')!.code);
    expect(jlc.type === 'done' && jlc.files[0]!.text.split('\r\n')[0]).toBe('Designator,Mid X,Mid Y,Layer,Rotation');
    const fence = demo();
    const { result: f } = await runOn(fence, EXAMPLES.find((e) => e.id === 'ex-fence')!.code, new Set(['Tracks6:1']));
    expect(f.changed).toBeGreaterThan(10);
  });
});

describe('scripting: files and the AI job', () => {
  it('a script file carries its name', () => {
    const f = scriptFile({ id: 'x', name: 'Net report', code: 'print(1);\n' });
    expect(f).toEqual({ name: 'Net report.js', text: '// @name Net report\nprint(1);\n' });
    expect(fromFile(f.name, f.text)).toEqual({ name: 'Net report', code: 'print(1);\n' });
    expect(fromFile('fence.js', 'print(2);')).toEqual({ name: 'fence', code: 'print(2);' });
  });
  it('the AI is given the API and the board\'s names; a fenced answer is unwrapped', () => {
    const msgs = SCRIPT.messages({ request: 'renumber', code: 'print(1)', kind: 'board', context: 'Copper layers: Top Layer' });
    expect(String(msgs[0]!.content)).toContain(SCRIPT_API);
    expect(String(msgs[1]!.content)).toMatch(/renumber[\s\S]*print\(1\)[\s\S]*Copper layers/);
    expect(SCRIPT.check({ name: 'R', code: '```js\nprint(1)\n```', explanation: 'x' }, SCRIPT.blank)).toEqual({ name: 'R', code: 'print(1)\n', explanation: 'x' });
    expect(() => SCRIPT.check({ name: 'R', code: ' ' }, SCRIPT.blank)).toThrow(/No script/);
  });
});
