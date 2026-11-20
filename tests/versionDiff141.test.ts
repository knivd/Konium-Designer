import { describe, expect, it } from 'vitest';
import { demoFiles } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { pcbDiff, schDiff, stable } from '../src/model/versionDiff';
import { mil } from '../src/core/units';
import type { PcbPrim } from '../src/model/pcb';

const file = (n: string) => demoFiles().find((f) => f.name === n)!;
const board = () => readPcbDoc(file('Demo.PcbDoc').bytes, 'Demo.PcbDoc');
const sheet = () => readSchDoc(file('Demo.SchDoc').bytes, 'Demo.SchDoc');
const keys = { prim: (p: PcbPrim) => `${p.src.storage}:${p.src.index}`, poly: (i: number) => `poly:${i}` };
const fmt = (c: number) => `${Math.round(c / 10_000)}mil`;

describe('Visual compare (R7): two versions object by object', () => {
  it('stable text: the same object written in another key order compares equal', () => {
    expect(stable({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stable({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(stable(new Float32Array([1, 2]))).toBe('[1,2]');
  });

  it('a board against itself (read twice): no differences', () => {
    expect(pcbDiff(board(), board(), keys, fmt)).toEqual([]);
  });

  it('a board changed: a part moved and turned, a via added, a track widened, a text gone; each with its keys on each side', () => {
    const a = board(), b = board();
    const u1 = b.components.find((c) => c.designator === 'U1')!;
    const dx = mil(50);
    u1.at = { x: u1.at.x + dx, y: u1.at.y }; u1.rotation = (u1.rotation + 90) % 360;
    for (const p of b.prims) if ('component' in p && p.component === u1.index && 'at' in p) p.at = { x: p.at.x + dx, y: p.at.y };
    const free = b.prims.filter((p) => p.kind === 'track' && p.component === 0xffff && p.polygon === 0xffff);
    const t = free[0]! as PcbPrim & { kind: 'track' };
    t.width += mil(5);
    b.prims.push({ kind: 'via', src: { storage: 'Vias6', index: 999 }, at: { x: mil(1500), y: mil(1500) }, diameter: mil(24), hole: mil(12), layerStart: 1, layerEnd: 32, net: 0xffff, locked: false } as PcbPrim);
    const txt = b.prims.findIndex((p) => p.kind === 'text' && p.component === 0xffff);
    const gone = txt >= 0 ? b.prims.splice(txt, 1)[0]! : null;
    const d = pcbDiff(a, b, keys, fmt);
    const by = (what: RegExp) => d.find((x) => what.test(x.what));
    const u = by(/^U1$/)!;
    expect(u.kind).toBe('changed');
    expect(u.detail).toMatch(/moved 50mil/);
    expect(u.detail).toMatch(/rotated/);
    expect(u.old.length).toBeGreaterThan(1);
    expect(u.cur.length).toBe(u.old.length);
    const w = d.find((x) => x.kind === 'changed' && /^Track/.test(x.what))!;
    expect(w.detail).toMatch(/\d+mil → \d+mil wide/);
    expect(w.old).toEqual([keys.prim(free[0]!)]);
    const v = d.find((x) => x.kind === 'added' && /^Via/.test(x.what))!;
    expect(v.cur).toEqual(['Vias6:999']);
    if (gone) expect(d.some((x) => x.kind === 'removed' && x.what.startsWith('Text') && x.old[0] === keys.prim(gone))).toBe(true);
    // Changed first, then added, then removed
    const ranks = d.map((x) => ({ changed: 0, added: 1, removed: 2 })[x.kind]);
    expect([...ranks].sort()).toEqual(ranks);
  });

  it('a schematic against itself: none; a part moved and a net label renamed: both found, a wire added', () => {
    expect(schDiff(sheet(), sheet(), (i) => `o${i}`, fmt)).toEqual([]);
    const a = sheet(), b = sheet();
    const comp = b.objects.find((o) => o.kind === 'component')! as typeof b.objects[number] & { kind: 'component' };
    const des = b.objects.find((o) => o.owner === comp.index && o.kind === 'text' && o.role === 'designator') as { text: string } | undefined;
    const dx = mil(100);
    for (const o of b.objects) {
      if (o.index !== comp.index && o.owner !== comp.index) continue;
      if ('at' in o) o.at = { x: o.at.x + dx, y: o.at.y };
      if ('pts' in o) o.pts = o.pts.map((p) => ({ x: p.x + dx, y: p.y }));
    }
    const label = b.objects.find((o) => o.kind === 'text' && o.role === 'netlabel') as { text: string; index: number } | undefined;
    if (label) label.text = `${label.text}_X`;
    b.objects.push({ index: b.objects.length, record: 27, owner: -1, ownerPartId: -1, ownerDisplayMode: 0, hidden: false, kind: 'wire', pts: [{ x: mil(9000), y: mil(9000) }, { x: mil(9500), y: mil(9000) }], width: 1, color: { r: 0, g: 0, b: 128 } } as never);
    const d = schDiff(a, b, (i) => `o${i}`, fmt);
    const part = d.find((x) => x.kind === 'changed' && x.what === (des?.text || comp.libRef))!;
    expect(part.detail).toMatch(/moved 100mil/);
    expect(part.cur).toContain(`o${comp.index}`);
    if (label) expect(d.some((x) => x.kind === 'changed' && /^Net label/.test(x.what) && /_X/.test(x.detail))).toBe(true);
    expect(d.filter((x) => x.kind === 'added' && x.what.startsWith('Wire (')).map((x) => [x.what, x.cur])).toEqual([['Wire (9000mil, 9000mil) to (9500mil, 9000mil)', [`o${b.objects.length - 1}`]]]);
  });
});
