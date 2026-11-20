/**
 * 26.200: what the review before the source went public found in the program itself, each with
 * the test that shows it closed (docs/REVIEW-26.200.md; the services' are in services200.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { zip } from '../src/formats/zip';
import { mbsColour, mbsLine, newMbsDoc, readMbsDoc, writeMbsDoc } from '../src/formats/altium/multiboard';
import { unzipSync } from '../src/formats/inflate';
import { scriptRuntime, type ScriptMain, type ScriptMessage, type Snapshot } from '../src/scripting/runtime';
import { checkedLog, checkedMessage, MAX_LINE, MAX_LOG_LINES } from '../src/scripting/outcome';
import { applyScript, snapshot } from '../src/scripting/board';
import { EXAMPLES } from '../src/scripting/examples';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { UndoStack } from '../src/core/undo';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** Markup a value could break out of an attribute with. */
const SLY = '0);"/><script>alert(1)</script><rect fill="rgba(0';

describe('I1: a multi-board schematic\'s styles reach the drawing as numbers only', () => {
  it('a colour is four numbers whatever the file says', () => {
    expect(mbsColour({ r: 146, g: 205, b: 220 }, '#000')).toBe('rgba(146,205,220,1)');
    expect(mbsColour({ a: 128, r: 1, g: 2, b: 3 }, '#000')).toBe('rgba(1,2,3,0.502)');
    expect(mbsColour({ r: SLY, g: '7', b: { toString: 1 }, a: [255] }, '#000')).toBe('rgba(0,0,0,1)');
    expect(mbsColour({ r: -4, g: 999, b: 12.6, a: Infinity }, '#000')).toBe('rgba(0,255,13,1)');
    for (const not of [undefined, null, SLY, 7, [1, 2, 3]]) expect(mbsColour(not, '#92cddc')).toBe('#92cddc');
  });
  it('a line is a colour, a width and dashes, numbers all', () => {
    expect(mbsLine({ thickness: 2, color: { r: 47, g: 90, b: 142 }, dashPattern: [4, 2] })).toEqual({ colour: 'rgba(47,90,142,1)', w: 2, dash: '8 4' });
    expect(mbsLine(undefined)).toEqual({ colour: '#2f5a8e', w: 1.5, dash: '' });
    const l = mbsLine({ thickness: SLY, color: SLY, dashPattern: [SLY, 3, -1, NaN, { x: 1 }] });
    expect(l).toEqual({ colour: '#2f5a8e', w: 1.5, dash: '3' });
    expect(mbsLine({ thickness: 1, dashPattern: SLY }).dash).toBe('');
    expect(mbsLine({ thickness: 1e9 }).w).toBe(100);
  });
  it('a file\'s lists are lists of objects by the time anything walks them; what is saved is the file\'s own', () => {
    const made = unzipSync(writeMbsDoc(newMbsDoc('A.MbsDoc')));
    const files = made.map((f) => {
      const n = f.name.toLowerCase();
      if (n === 'styles.json') return { name: f.name, bytes: enc({ lineStyles: [null, 7, SLY, { id: 1, thickness: SLY, color: { r: SLY } }], fillStyles: SLY, fontStyles: { 0: 1 } }) };
      if (/page_1\.json$/.test(n)) return { name: f.name, bytes: enc({ items: [null, 3, SLY, [1], { id: 1, $type: '__drawingModule', rect: { x: 10, y: 10, width: 50, height: 40 }, fillStyleId: 1, lineStyleId: 1 }] }) };
      if (n === 'logical.json') return { name: f.name, bytes: enc({ modules: [null, SLY, { id: 5, designator: 'M1' }], connections: SLY }) };
      return f;
    });
    const d = readMbsDoc(zip(files), 'A.MbsDoc');
    expect(d.styles.lineStyles).toHaveLength(1);
    expect(d.styles.fillStyles).toBeUndefined();
    expect(d.styles.fontStyles).toBeUndefined();
    expect(d.pages[0]!.data.items).toHaveLength(1);
    expect(d.logical.modules).toEqual([{ id: 5, designator: 'M1' }]);
    expect(d.logical.connections).toEqual([]);
    expect(mbsLine(d.styles.lineStyles![0])).toEqual({ colour: 'rgba(0,0,0,1)', w: 1.5, dash: '' });
    // The styles are not rewritten on a save: the file's own bytes go back
    const back = unzipSync(writeMbsDoc(d)).find((f) => f.name.toLowerCase() === 'styles.json')!;
    expect(new TextDecoder().decode(back.bytes)).toContain('script');
    // Not a schematic's JSON at all: said, not walked
    expect(() => readMbsDoc(zip(files.map((f) => (f.name.toLowerCase() === 'logical.json' ? { name: f.name, bytes: enc(null) } : f))), 'A.MbsDoc')).toThrow(/not a multi-board schematic/);
    const bare = readMbsDoc(zip(files.map((f) => (/page_1\.json$/i.test(f.name) || f.name.toLowerCase() === 'styles.json' ? { name: f.name, bytes: enc(SLY) } : f))), 'A.MbsDoc');
    expect([bare.pages[0]!.data.items, bare.styles]).toEqual([[], {}]);
  });
});

function run(snap: Snapshot, body: string): Promise<ScriptMessage> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const main = new Function('board', 'output', 'print', 'mm', 'mil', 'inch', 'toMil', 'toInch', `return (async () => {\n${body}\n})();`) as ScriptMain;
  return new Promise((res) => scriptRuntime(snap, main, res));
}
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
/** A message as it arrives from another window: a structured copy. */
const arrived = <T,>(m: T): T => structuredClone(m);
/** What the page would take for an element of its own, were it shown as it came. */
const element = () => ({ type: 'img', props: { src: 'x', dangerouslySetInnerHTML: { __html: '<img src onerror="alert(1)">' } }, key: null, ref: null, constructor: undefined });

describe('I2: what a script\'s frame sends back is the script\'s word: rebuilt from checked values', () => {
  it('what an honest script asks for comes through as it was', async () => {
    const doc = demo(), snap = snapshot(doc, 'board', new Set(['c2']));
    const body = `const u = board.component('U1'); u.moveBy(1, 2).rotateBy(90).setDesignator('U9');
      const t = board.addTrack({ x1: 1, y1: 1, x2: 5, y2: 1, width: 0.3, net: 'GND' }); t.moveBy(0.5, 0);
      board.addArc({ x: 3, y: 3, radius: 2 }); board.addVia({ x: 4, y: 4, net: 'VIN' });
      board.addText({ x: 2, y: 8, text: 'Rev A\\nline two' }); board.addPad({ x: 9, y: 9, shape: 'rect', hole: 0.8 });
      board.addRegion({ points: [[0, 0], [2, 0], [2, 2]], layer: 'Bottom Layer' });
      board.tracks[0].setWidth(0.5).setNet(null); board.tracks[1].remove(); board.select([u, t]);
      output.text('parts.csv', 'a,b\\n'); print('done', 3, { a: 1 });`;
    const sent = await run(snap, body);
    expect(sent.type).toBe('done');
    const got = checkedMessage(arrived(sent));
    if (got?.type !== 'done' || sent.type !== 'done') throw new Error('not done');
    // The same changes (a new object's fields without the runtime's own "component: null")
    const plain = sent.ops.map((o) => (o.op === 'add' ? { ...o, fields: Object.fromEntries(Object.entries(o.fields).filter(([k]) => k !== 'component')) } : o));
    expect(got.ops).toEqual(plain);
    expect(got.ops.map((o) => o.op)).toEqual(['compMove', 'compRotate', 'designator', 'add', 'move', 'add', 'add', 'add', 'add', 'add', 'width', 'net', 'remove', 'select']);
    expect(got.log).toEqual(['done 3 {"a":1}']);
    expect(got.files).toEqual([{ name: 'parts.csv', text: 'a,b\n' }]);
    // …and they are made on the board
    const undo = new UndoStack();
    let said = '';
    undo.transact('Run script', (tx) => { said = applyScript(doc, got.ops, tx).summary; });
    expect(said).toContain('6 objects added');
    expect(doc.components.some((c) => c.designator === 'U9')).toBe(true);
  });
  it('every example script comes through the check as it left the runtime', async () => {
    for (const ex of EXAMPLES) {
      const sent = await run(snapshot(demo(), 'board', new Set(['c0', 'c2'])), ex.code);
      const got = checkedMessage(arrived(sent))!;
      if (got.type === 'ready') throw new Error('not a run\'s end');
      expect(got.type, ex.name).toBe(sent.type);
      expect(got.log, ex.name).toEqual(sent.log);
      if (sent.type === 'done' && got.type === 'done') { expect(got.ops.length, ex.name).toBe(sent.ops.length); expect(got.files, ex.name).toEqual(sent.files); }
    }
  });
  it('a log line is a text: an object made to look like an element of the page never is', () => {
    expect(checkedLog(['a', 3, true, element(), null, ['x'], { text: 'y' }, 'b'])).toEqual(['a', '3', 'true', 'b']);
    expect(checkedLog(SLY)).toEqual([]);
    expect(checkedLog(Array.from({ length: 9000 }, (_, k) => `l${k}`))).toHaveLength(MAX_LOG_LINES);
    expect(checkedLog(['x'.repeat(MAX_LINE + 50)])[0]).toHaveLength(MAX_LINE + 1);
    for (const type of ['done', 'error']) {
      const got = checkedMessage(arrived({ type, ops: [], files: [], message: element(), line: element(), stack: element(), log: ['seen', element()] }))!;
      if (got.type === 'ready') throw new Error('not a run\'s end');
      expect(got.log).toEqual(['seen']);
      for (const v of Object.values(got)) expect(typeof v === 'string' || typeof v === 'undefined' || Array.isArray(v)).toBe(true);
      if (got.type === 'error') expect(got.message).toBe('The script failed');
    }
    // Files: texts with names that are names
    const f = checkedMessage(arrived({ type: 'done', ops: [], log: [], files: [{ name: element(), text: 'x' }, { name: 'a.csv', text: element() }, { name: '..\\..\\evil/run.bat', text: 'ok' }, 5] }));
    expect(f).toMatchObject({ type: 'done', files: [{ name: '.._.._evil_run.bat', text: 'ok' }] });
  });
  it('a change that is not one a script can ask for fails the run; nothing is changed', () => {
    const el = element();
    const not: unknown[] = [
      { op: 'designator', id: 'c0', value: el }, { op: 'designator', id: 'c0', value: '   ' }, { op: 'designator', id: 'c0', value: 'U1\u0000' },
      { op: 'designator', id: el, value: 'U1' }, { op: 'designator', id: '__proto__', value: 'U1' }, { op: 'compMove', id: 'c0', x: '1', y: 2 }, { op: 'compMove', id: 'c0', x: NaN, y: 2 },
      { op: 'compRotate', id: 'c0', rotation: el }, { op: 'net', id: 'Tracks6:0', net: el }, { op: 'width', id: 'Tracks6:0', width: [1] }, { op: 'move', id: 'Tracks6:0', dx: 1 },
      { op: 'select', ids: [el] }, { op: 'select', ids: 'c0' }, { op: 'run', id: 'c0' }, el, null, 'remove',
      { op: 'add', id: 'new1', kind: 'text', fields: { x: 1, y: 1, text: el, height: 1, layer: 'Top Overlay', rotation: 0 } },
      { op: 'add', id: 'new1', kind: 'text', fields: { x: 1, y: 1, text: 'ok', height: 1, layer: el, rotation: 0 } },
      { op: 'add', id: 'new1', kind: 'pad', fields: { x: 1, y: 1, name: el, width: 1, height: 1, shape: 'round', hole: 0, layer: 'Top Layer', rotation: 0, net: null } },
      { op: 'add', id: 'new1', kind: 'pad', fields: { x: 1, y: 1, name: '1', width: 1, height: 1, shape: 'star', hole: 0, layer: 'Top Layer', rotation: 0, net: null } },
      { op: 'add', id: 'new1', kind: 'arc', fields: { x: 1, y: 1, radius: 1, start: '0', end: 360, width: 0.2, layer: 'Top Layer', net: null } },
      { op: 'add', id: 'new1', kind: 'region', fields: { points: [{ x: 0, y: 0 }, { x: 1, y: el }, { x: 1, y: 1 }], layer: 'Top Layer', net: null } },
      { op: 'add', id: 'new1', kind: 'region', fields: { points: SLY, layer: 'Top Layer', net: null } },
      { op: 'add', id: 'new1', kind: 'component', fields: {} }, { op: 'add', id: 'new1', kind: 'track', fields: el },
    ];
    for (const op of not) {
      const got = checkedMessage(arrived({ type: 'done', ops: [{ op: 'remove', id: 'Tracks6:1' }, op], files: [], log: ['before'] }))!;
      expect(got.type, JSON.stringify(op)).toBe('error');
      if (got.type === 'error') { expect(got.message).toMatch(/^The script sent back something that is not /); expect(got.log).toEqual(['before']); }
    }
    expect(checkedMessage(arrived({ type: 'done', ops: SLY, files: [], log: [] }))!.type).toBe('error');
    // Not a message of the frame's at all
    for (const v of [null, 5, SLY, [], { type: 'other' }, { type: el }]) expect(checkedMessage(arrived(v))).toBeNull();
    expect(checkedMessage({ type: 'ready', extra: el })).toEqual({ type: 'ready' });
  });
});

describe('I3: a label\'s style is kept only as values that can be nothing else', () => {
  it('a character reference without its semicolon makes no second declaration, no url() and no attribute', async () => {
    const { sanitise } = await import('../src/app/diagram/richtext');
    const out = (h: string) => sanitise(h);
    // &#59 is a semicolon to a browser, though not to the reading here: the value is not one a style may hold
    expect(out('<span style="color: red&#59 background-image: url(https://stranger.example/seen)">x</span>')).toBe('<span>x</span>');
    expect(out('<span style="color: red&#x3b;position:fixed">x</span>')).toBe('<span style="color: red;">x</span>');
    expect(out('<span style="background-color: ur&#x6c(https://stranger.example/x)">x</span>')).toBe('<span>x</span>');
    expect(out('<span style="color: \\75rl(x)">x</span>')).toBe('<span>x</span>');
    expect(out('<span style="color: red; font-family: &quot;Courier New&quot;, monospace; font-size: 12px">x</span>')).toBe('<span style="color: red; font-family: \'Courier New\', monospace; font-size: 12px;">x</span>');
    expect(out('<font color="red&#34 onmouseover=&#34alert(1)" face="Arial" size="3">x</font>')).toBe('<font size="3" face="Arial">x</font>');
    // A link's address is written as text: its ampersands are ampersands again when read
    expect(out('<a href="https://maker.example/?a=1&amp;b=2&#34 onclick=alert(1)">x</a>')).toBe('<a href="https://maker.example/?a=1&amp;b=2&amp;#34 onclick=alert(1)">x</a>');
    for (const h of ['<a href="https://maker.example/?a=1&amp;b=2">x</a>', '<div style="text-align: center; color: rgb(0, 0, 255);">x</div>', '<font color="#ff0000" size="3">red</font>']) expect(out(out(h)), h).toBe(out(h));
    // Nothing kept can hold a quote, an angle or a bare ampersand inside an attribute
    for (const m of out('<p style="color: a&#34b; margin-top: 3px&lt;&gt;" align="center"><a href="#x&quot;&gt;&lt;script&gt;">y</a></p>').matchAll(/="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>]|&(?!amp;|quot;|lt;|gt;)/);
  });
});

describe('D1, D2: removing an owner renumbers the owners\' indices and nothing else', () => {
  it('the board\'s own plane-edge tracks (polygon 0xFFFE) are left exactly as they are when a pour goes', async () => {
    const { addPolygon, addPrimRecords, explodePolygons, ownerOf, removePolygons } = await import('../src/model/pcbEdit');
    const { encodeTrack, writePcbDoc, writeVertices } = await import('../src/formats/altium/pcbdoc');
    const { TRACK, put } = await import('../src/formats/altium/pcbLayouts');
    const { newPolygonProps } = await import('../src/formats/altium/polygonProps');
    const { mil } = await import('../src/core/units');
    const { L } = await import('../src/model/layers');
    for (const how of [removePolygons, explodePolygons]) {
      const doc = demo();
      while (doc.polygons.length < 3) {
        const bag = newPolygonProps('TOP', 0xffff, `P${doc.polygons.length}`, doc.polygons.length);
        writeVertices(bag, [{ p: { x: 0, y: 0 } }, { p: { x: mil(100), y: 0 } }, { p: { x: mil(100), y: mil(100) } }]);
        addPolygon(doc, bag).apply();
      }
      const owned = (polygon: number, x: number) => { const r = encodeTrack({ layer: L.TOP, a: { x: mil(x), y: 0 }, b: { x: mil(x + 50), y: 0 }, width: mil(10) }); put(r.subs[0]!, TRACK.polygon, polygon); return { storage: 'Tracks6', rec: r }; };
      const edge = owned(0xfffe, 5000), last = owned(2, 6000), first = owned(0, 7000), free = owned(0xffff, 8000), stray = owned(40, 9000);
      addPrimRecords(doc, [edge, last, first, free, stray]).apply();
      const recs = () => doc.streams.get('Tracks6')!.records;
      const change = how(doc, [0, 1]);
      change.apply();
      expect(doc.polygons).toHaveLength(1);
      // The board's mark, "none" and an index past the list's end: the very same records, untouched
      for (const r of [edge, free, stray]) expect(recs().includes(r.rec), how.name).toBe(true);
      expect([ownerOf(edge.rec, 'polygon'), ownerOf(free.rec, 'polygon'), ownerOf(stray.rec, 'polygon')]).toEqual([0xfffe, 0xffff, 40]);
      // The pour that stays is now the first: its copper says so
      expect(recs().some((r) => r !== edge.rec && ownerOf(r, 'polygon') === 0 && recs().indexOf(r) >= 0)).toBe(true);
      expect(recs().filter((r) => ownerOf(r, 'polygon') === 2)).toHaveLength(0);
      // Written and read again, the edge still carries the board's mark
      const back = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
      expect(back.prims.filter((p) => p.kind === 'track' && p.polygon === 0xfffe)).toHaveLength(1);
      change.revert();
      expect(doc.polygons).toHaveLength(3);
      expect(recs().includes(edge.rec) && recs().includes(last.rec) && recs().includes(first.rec)).toBe(true);
    }
  });
  it('a footprint\'s own via goes where its part goes, goes when it goes, and keeps its part when another goes', async () => {
    const { addPrimRecords, moveComponent, ownerOf, removeComponents } = await import('../src/model/pcbEdit');
    const { encodeVia, writePcbDoc } = await import('../src/formats/altium/pcbdoc');
    const { VIA, put } = await import('../src/formats/altium/pcbLayouts');
    const { mil } = await import('../src/core/units');
    const doc = demo();
    const part = 2, c = doc.components[part]!, name = c.designator;
    const mine = encodeVia({ at: { x: c.at.x + mil(20), y: c.at.y }, diameter: mil(24), hole: mil(12) }), free = encodeVia({ at: { x: mil(4000), y: mil(4000) }, diameter: mil(24), hole: mil(12) });
    put(mine.subs[0]!, VIA.component, part);
    addPrimRecords(doc, [{ storage: 'Vias6', rec: mine }, { storage: 'Vias6', rec: free }]).apply();
    const vias = () => doc.prims.filter((p) => p.kind === 'via');
    const owned = () => vias().filter((p) => 'component' in p);
    expect(owned()).toHaveLength(1);
    expect(owned()[0]).toMatchObject({ component: part, at: { x: c.at.x + mil(20), y: c.at.y } });
    expect(vias().filter((p) => !('component' in p)).length).toBeGreaterThanOrEqual(1);
    // Moved and turned a quarter with its part: 20 mil to the right of it becomes 20 mil above it
    const at0 = { ...c.at };
    moveComponent(doc, part, { x: mil(100), y: mil(50) }, 90).apply();
    const now = doc.components[part]!.at;
    expect(now).toEqual({ x: at0.x + mil(100), y: at0.y + mil(50) });
    expect(owned()[0]!.at).toEqual({ x: now.x, y: now.y + mil(20) });
    expect(vias().find((p) => !('component' in p) && p.at.x === mil(4000))).toBeDefined();
    // Saved in the ASCII format and read again, it is still its part's
    const { readPcbAscii, writePcbAscii } = await import('../src/formats/altium/pcbAscii');
    const ascii = readPcbAscii(writePcbAscii(doc).bytes, 'x.PcbDoc');
    const kept = ascii.prims.filter((p) => p.kind === 'via' && 'component' in p);
    expect(kept).toHaveLength(1);
    expect(ascii.components[(kept[0] as { component: number }).component]!.designator).toBe(name);
    // An earlier part goes: the via is still its own part's, under the part's new number
    const n = vias().length;
    const gone = removeComponents(doc, [0]);
    gone.apply();
    expect(doc.components[part - 1]!.designator).toBe(name);
    expect(owned()).toHaveLength(1);
    expect(owned()[0]).toMatchObject({ component: part - 1 });
    expect(vias()).toHaveLength(n);
    const back = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    const v = back.prims.find((p) => p.kind === 'via' && 'component' in p)!;
    expect(back.components[(v as { component: number }).component]!.designator).toBe(name);
    gone.revert();
    expect(owned()[0]).toMatchObject({ component: part });
    // Its own part goes: the via goes with it, the board's own vias stay
    removeComponents(doc, [part]).apply();
    expect(owned()).toHaveLength(0);
    expect(vias()).toHaveLength(n - 1);
    expect(doc.streams.get('Vias6')!.records.some((r) => ownerOf(r, 'component') !== 0xffff)).toBe(false);
  });
});

/** As much of IndexedDB as the backup store uses, in memory (object stores with a key path, one index each, transactions that complete when their requests have). */
function fakeIndexedDB(o: { full?: boolean } = {}) {
  type Row = Record<string, unknown>;
  const dbs = new Map<string, Map<string, { keyPath?: string; rows: Map<string, Row>; indexes: Map<string, string> }>>();
  const later = (r: { onsuccess?: () => void; onerror?: () => void; result?: unknown; error?: unknown }, fn: () => unknown, after?: () => void) => {
    queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } after?.(); });
    return r;
  };
  const dbOf = (name: string, stores: NonNullable<ReturnType<typeof dbs.get>>) => ({
    name,
    createObjectStore(n: string, opt?: { keyPath?: string }) { const s = { keyPath: opt?.keyPath, rows: new Map<string, Row>(), indexes: new Map<string, string>() }; stores.set(n, s); return { createIndex(i: string, path: string) { s.indexes.set(i, path); } }; },
    transaction(n: string) {
      const t: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error?: unknown; objectStore(x: string): unknown } = { objectStore: () => api };
      let timer: ReturnType<typeof setTimeout> | undefined, failed = false;
      const settle = () => { clearTimeout(timer); timer = setTimeout(() => (failed ? t.onabort?.() : t.oncomplete?.()), 0); };
      const s = stores.get(n)!;
      const run = (fn: () => unknown) => later({}, () => { try { return fn(); } catch (e) { failed = true; t.error = e; throw e; } }, settle);
      const api = {
        put: (v: Row, k?: string) => run(() => { if (o.full) throw new DOMException('full', 'QuotaExceededError'); s.rows.set(String(s.keyPath ? v[s.keyPath] : k), v); }),
        get: (k: string) => run(() => s.rows.get(k)), getAll: () => run(() => [...s.rows.values()]), delete: (k: string) => run(() => { s.rows.delete(k); }),
        index: (i: string) => ({
          getAll: (v: unknown) => run(() => [...s.rows.values()].filter((r) => r[s.indexes.get(i)!] === v)),
          getAllKeys: (v: unknown) => run(() => [...s.rows.entries()].filter(([, r]) => r[s.indexes.get(i)!] === v).map(([k]) => k)),
        }),
      };
      settle();
      return t;
    },
    close() { /* nothing held */ },
  });
  return {
    databases: async () => [...dbs.keys()].map((name) => ({ name })),
    open(name: string) {
      const r: { onupgradeneeded?: (e: { oldVersion: number }) => void; onsuccess?: () => void; onerror?: () => void; result?: unknown } = {};
      queueMicrotask(() => { const fresh = !dbs.has(name); if (fresh) dbs.set(name, new Map()); r.result = dbOf(name, dbs.get(name)!); if (fresh) r.onupgradeneeded?.({ oldVersion: 0 }); r.onsuccess?.(); });
      return r;
    },
  };
}

describe('D3, D7: auto-saved copies', () => {
  it('a document saved or closed drops this session\'s copies of it, never another session\'s of the same name', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB();
    try {
      const st = await import('../src/platform/backupStore');
      const K = 'Amp.PrjPcb|Main.SchDoc', OTHER = 'Amp.PrjPcb|Power.SchDoc', bytes = new Uint8Array([1, 2, 3]);
      const copy = (docKey: string, session: string, slot = 1) => ({ key: `${docKey}#${session}#${slot}`, docKey, slot, name: docKey.split('|')[1]!, session, at: slot, size: 3 });
      for (const c of [copy(K, 'crashed'), copy(K, 'crashed', 2), copy(K, 'mine'), copy(K, 'window2'), copy(OTHER, 'mine')]) expect(await st.putAutoCopy(c, bytes)).toBe(true);
      const left = async () => (await st.listAutoCopies()).map((c) => c.key).sort();
      // Saved or closed here: this session's copies of that document go; the crashed session's and the other window's stay
      await st.dropAutoCopies({ docKey: K, session: 'mine' });
      expect(await left()).toEqual([`${K}#crashed#1`, `${K}#crashed#2`, `${K}#window2#1`, `${OTHER}#mine#1`].sort());
      expect(await st.autoCopyBytes(`${K}#crashed#2`)).toEqual(bytes);
      // No session named: nothing goes by a document's name alone
      await st.dropAutoCopies({ docKey: K });
      expect(await left()).toHaveLength(4);
      // Opened again after the crash, the copies are this session's, and go when the document is saved
      await st.adoptAutoCopies([`${K}#crashed#1`, `${K}#crashed#2`], 'mine');
      await st.dropAutoCopies({ docKey: K, session: 'mine' });
      expect(await left()).toEqual([`${K}#window2#1`, `${OTHER}#mine#1`].sort());
      // By key, as before (the Home page's Discard)
      await st.dropAutoCopies({ keys: [`${K}#window2#1`] });
      expect(await left()).toEqual([`${OTHER}#mine#1`]);
    } finally { delete (globalThis as { indexedDB?: unknown }).indexedDB; }
  });
  it('a copy the browser refuses is known to be refused (and the program says so once: backup.ts, refused)', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB({ full: true });
    try {
      const st = await import('../src/platform/backupStore');
      expect(await st.putAutoCopy({ key: 'a#s#1', docKey: 'a', slot: 1, name: 'a', session: 's', at: 1, size: 1 }, new Uint8Array([1]))).toBe(false);
      expect(await st.putStoredVersion({ key: 'a#1', docKey: 'a', n: 1, name: 'a', at: 1, size: 1 }, new Uint8Array([1]))).toBe(false);
    } finally { delete (globalThis as { indexedDB?: unknown }).indexedDB; }
    const { readFileSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): { readFileSync(p: string, e: string): string } } }).process.getBuiltinModule('node:fs');
    const src = readFileSync('src/app/backup.ts', 'utf8');
    for (const t of ["refused('Auto Save could not keep a copy of', od.name)", "refused('Local History could not keep a version of', f.name)", 'dropAutoCopies({ docKey: keyOf(refOf(od)), session: SESSION })', 'if (!od || before.has(od)) { missed.push(c.name); continue; }'])
      expect(src.includes(t), t).toBe(true);
  });
});

describe('an archive that unpacks to more than can be held is refused', () => {
  it('by what it says of its size, and by what it makes', async () => {
    const { inflateRawSync, MAX_INFLATED } = await import('../src/formats/inflate');
    expect(() => inflateRawSync(new Uint8Array([3, 0]), MAX_INFLATED + 1)).toThrow(/more than this can unpack/);
    // An honest one is unpacked as before
    const text = new TextEncoder().encode('konium '.repeat(5000));
    const packed = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    expect(inflateRawSync(packed)).toEqual(text);
  });
});

describe('pages the program writes are pages of text and pictures', () => {
  it('every report and print page tells the browser to run nothing in it and fetch nothing from outside it', async () => {
    const { NO_SCRIPT, reportHtml } = await import('../src/core/reportHtml');
    expect(NO_SCRIPT).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`);
    expect(reportHtml('A <b>title</b>', 'text & <script>alert(1)</script>')).toContain(`<meta charset="utf-8">${NO_SCRIPT}<title>A &lt;b&gt;title&lt;/b&gt;</title>`);
    // Each place that writes a whole page carries it, straight after the character set (so nothing comes before the policy)
    const fs = (globalThis as unknown as { process: { getBuiltinModule(m: string): { readFileSync(p: string, e: string): string; readdirSync(p: string, o: { recursive: boolean }): string[] } } }).process.getBuiltinModule('node:fs');
    const pages: string[] = [];
    for (const f of fs.readdirSync('src', { recursive: true })) {
      if (!/\.tsx?$/.test(f) || /\.gen\.ts$/.test(f)) continue;
      const text = fs.readFileSync(`src/${f}`, 'utf8');
      // (the script sandbox's frame is the one page that is there to run a script; it has a policy of its own)
      if (!/<!doctype html>/i.test(text) || /scripting[\\/]sandbox\.ts$/.test(f)) continue;
      pages.push(f.replace(/\\/g, '/'));
      const heads = text.match(/<meta charset="utf-8">/g) ?? [];
      expect(heads.length, f).toBeGreaterThan(0);
      expect((text.match(/<meta charset="utf-8">\$\{NO_SCRIPT\}/g) ?? []).length, f).toBe(heads.length);
    }
    expect(pages.length).toBeGreaterThanOrEqual(9);
  });
});

describe('the site\'s own answers', () => {
  it('no page may be shown inside another site\'s page, and no file is taken for another kind (Apache and Cloudflare Pages alike)', () => {
    const { readFileSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): { readFileSync(p: string, e: string): string } } }).process.getBuiltinModule('node:fs');
    const ht = readFileSync('public/.htaccess', 'utf8'), cf = readFileSync('public/_headers', 'utf8');
    for (const [name, value] of [['X-Frame-Options', 'DENY'], ['Content-Security-Policy', "frame-ancestors 'none'"], ['X-Content-Type-Options', 'nosniff']]) {
      expect(ht).toContain(`Header always set ${name} "${value}"`);
      expect(cf).toMatch(new RegExp(`^/\\*\\n(?:  .*\\n)*?  ${name}: ${value.replace(/[']/g, "\\'")}$`, 'm'));
    }
  });
});
