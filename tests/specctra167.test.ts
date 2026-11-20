import { describe, expect, it } from 'vitest';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { EXPORTERS } from '../src/formats/exporters';
import { exportSpecctra, exportSpecctraDsn, qid, readViaName, viaName, pinNames } from '../src/formats/specctra/dsn';
import { applySession, readSession } from '../src/formats/specctra/ses';
import { isList, kid, kids, parseSexpr, type SList } from '../src/formats/kicad/sexpr';
import { moveComponent, removePrims } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { UNITS_PER_MM } from '../src/core/units';
import type { PcbDocument, PcbPad } from '../src/model/pcb';

/**
 * R15 (26.167), Specctra both ways: a board as a Specctra design (.dsn) an autorouter reads, and the
 * session (.ses) it writes read back as the board's routes.
 */

const board = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const UM = UNITS_PER_MM / 1000;
/** The design read (its quote character no string). */
const dsnTree = (text: string) => parseSexpr(text.replace(/\(string_quote\s+\S\s*\)/g, ''));
const nums = (n: SList, from = 0) => n.items.slice(from).filter((x): x is number => typeof x === 'number');
const str = (n: SList, i: number) => String(n.items[i]);

/** Every pin of every placed part where Specctra puts it: its image's pin turned (a back one's flipped across the image's Y axis first: Specctra's mirror-first flip). */
function pinPlaces(text: string): Map<string, { x: number; y: number }> {
  const root = dsnTree(text);
  const images = new Map(kids(kid(root, 'library'), 'image').map((im) => [str(im, 0), kids(im, 'pin').map((p) => { const v = nums(p, 1); const rot = kid(p, 'rotate'); return { name: String(p.items[rot ? 2 : 1]), x: v[v.length - 2]!, y: v[v.length - 1]! }; })]));
  const out = new Map<string, { x: number; y: number }>();
  for (const c of kids(kid(root, 'placement'), 'component')) for (const pl of kids(c, 'place')) {
    const [x, y, rot] = nums(pl, 1);
    const back = pl.items.includes('back');
    const a = (rot! * Math.PI) / 180;
    for (const p of images.get(str(c, 0)) ?? []) {
      const px = back ? -p.x : p.x;
      out.set(`${str(pl, 0)}-${p.name}`, { x: x! + px * Math.cos(a) - p.y * Math.sin(a), y: y! + px * Math.sin(a) + p.y * Math.cos(a) });
    }
  }
  return out;
}
const routed = (d: PcbDocument) => {
  const m = new Map<string, number>();
  for (const q of d.prims) {
    if ((q.kind !== 'track' && q.kind !== 'arc') || (q.component >= 0 && q.component < d.components.length) || q.net < 0 || q.net >= d.nets.length || (q.polygon >= 0 && q.polygon < d.polygons.length) || q.keepout) continue;
    const k = `${d.nets[q.net]!.name}@${q.layer}`;
    const l = q.kind === 'track' ? Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) : q.r * (((((q.end - q.start) % 360) + 360) % 360 || 360) * Math.PI) / 180;
    m.set(k, (m.get(k) ?? 0) + l);
  }
  return m;
};
/** A session as an autorouter would write it for this design: its wiring (as routed) in tenths of a µm. */
function sessionOf(text: string): string {
  const root = dsnTree(text);
  const byNet = new Map<string, string[]>();
  const t = (v: number) => Math.round(v * 10);
  for (const w of kids(kid(root, 'wiring'), 'wire')) {
    const path = kid(w, 'path')!, net = String(kid(w, 'net')!.items[0]);
    const v = nums(path, 1);
    byNet.set(net, [...(byNet.get(net) ?? []), `(wire (path ${str(path, 0)} ${t(v[0]!)} ${v.slice(1).map(t).join(' ')}))`]);
  }
  for (const v of kids(kid(root, 'wiring'), 'via')) {
    const net = String(kid(v, 'net')!.items[0]), c = nums(v, 1);
    byNet.set(net, [...(byNet.get(net) ?? []), `(via ${qid(str(v, 0))} ${t(c[0]!)} ${t(c[1]!)})`]);
  }
  return `(session "Demo.ses"\n (base_design "Demo.dsn")\n (placement (resolution um 10))\n (routes (resolution um 10) (parser (host_cad "test"))\n  (network_out\n${[...byNet].map(([n, l]) => `   (net ${qid(n)}\n    ${l.join('\n    ')})`).join('\n')}\n  )\n )\n)\n`;
}

describe('Specctra (R15)', () => {
  it('names as Specctra reads them, and via padstacks that say their layers and sizes', () => {
    expect(qid('GND')).toBe('GND');
    expect(qid('NetR1_1')).toBe('"NetR1_1"');
    expect(qid('A-B')).toBe('"A-B"');
    expect(qid('1')).toBe('"1"');
    expect(qid('say "x"')).toBe('"say x"');
    expect(pinNames([{ name: '1' }, { name: '2' }, { name: '1' }, { name: '' }])).toEqual(['1', '2', '1@1', '@0']);
    const v = readViaName(viaName(0, 3, 24 * 10000, 12 * 10000))!;
    expect([v.from, v.to]).toEqual([0, 3]);
    expect(Math.abs(v.dia - 240000)).toBeLessThan(UM);
    expect(Math.abs(v.hole - 120000)).toBeLessThan(UM);
  });

  it('a board as a Specctra design: layers, boundary, images, placement, every net\'s pins, the routes there are', () => {
    expect(EXPORTERS.some((e) => e.id === 'specctra')).toBe(true);
    const d = board();
    const r = exportSpecctra({ name: 'Demo', sheets: [], board: d, schLibs: [], pcbLibs: [], hierarchyMode: 2, variables: [] });
    expect(r.files.map((f) => f.path)).toEqual(['Demo/Demo.dsn']);
    const text = new TextDecoder().decode(r.files[0]!.bytes);
    const root = dsnTree(text);
    expect(root.k).toBe('pcb');
    expect(kid(root, 'resolution')!.items).toEqual(['um', 10]);
    const st = kid(root, 'structure')!;
    expect(kids(st, 'layer').map((l) => str(l, 0))).toEqual(['Top.Layer', 'Bottom.Layer']);
    expect(kid(st, 'boundary')).toBeDefined();
    expect(kids(kid(root, 'placement'), 'component').flatMap((c) => kids(c, 'place')).length).toBe(d.components.length);
    // Every pad on a net is a pin of it, where the board has it
    const pins = pinPlaces(text);
    const nets = kids(kid(root, 'network'), 'net');
    let n = 0;
    for (const net of nets) {
      const name = str(net, 0);
      // (a pin reference read as words: R1- then "1")
      const refs = kid(net, 'pins')!.items.map(String).reduce<string[]>((a, t) => (a.length && a[a.length - 1]!.endsWith('-') ? [...a.slice(0, -1), a[a.length - 1]! + t] : [...a, t]), []);
      for (const ref of refs) {
        const at = pins.get(ref.replace(/"/g, ''))!;
        expect(at).toBeDefined();
        const [des, pin] = ref.replace(/"/g, '').split('-');
        const c = d.components.find((x) => x.designator === des)!;
        const pad = d.prims.find((q): q is PcbPad => q.kind === 'pad' && q.component === c.index && q.name === pin)!;
        expect(d.nets[pad.net]!.name).toBe(name);
        expect(Math.hypot(at.x * UM - pad.at.x, at.y * UM - pad.at.y)).toBeLessThan(UM);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
    const wiring = kid(root, 'wiring')!;
    expect(kids(wiring, 'via').length).toBe(d.prims.filter((q) => q.kind === 'via').length);
    expect(kids(wiring, 'wire').length).toBeGreaterThan(0);
    // The vias listed in the structure are padstacks of the library
    const padstacks = new Set(kids(kid(root, 'library'), 'padstack').map((p) => str(p, 0)));
    for (const v of kid(st, 'via')!.items) expect(padstacks.has(String(v))).toBe(true);
  });

  it('a part on the bottom: its pins where the board has them, flipped and turned as Specctra flips and turns', () => {
    const d = board();
    const ci = d.components.findIndex((c) => c.layer === L.TOP && d.prims.some((q) => q.kind === 'pad' && q.component === c.index && q.layer !== L.MULTI));
    moveComponent(d, ci, { x: 0, y: 0 }, 30, { flip: true }).apply();
    const b = readPcbDoc(writePcbDoc(d), 'B.PcbDoc');
    const c = b.components[ci]!;
    expect(c.layer).toBe(L.BOTTOM);
    const text = exportSpecctraDsn(b, 'B').text;
    expect(text).toMatch(new RegExp(`\\(place ${c.designator} [-\\d. ]+ back `));
    const pins = pinPlaces(text);
    const names = new Map<string, number>();
    for (const q of b.prims) {
      if (q.kind !== 'pad' || q.component !== c.index) continue;
      const k = names.get(q.name) ?? 0; names.set(q.name, k + 1);
      const at = pins.get(`${c.designator}-${k ? `${q.name}@${k}` : q.name}`)!;
      expect(Math.hypot(at.x * UM - q.at.x, at.y * UM - q.at.y)).toBeLessThan(UM);
    }
  });

  it('a session read back: its routes in place of the board\'s, as routed; pours poured again; one undo', () => {
    const d = board();
    const before = routed(d), vias0 = d.prims.filter((q) => q.kind === 'via').length;
    const ses = readSession(sessionOf(exportSpecctraDsn(d, 'Demo').text));
    expect(ses.nets.length).toBeGreaterThan(0);
    // The board unrouted first: the session puts its routes back
    removePrims(d, d.prims.filter((q) => (q.kind === 'track' || q.kind === 'arc' || q.kind === 'via') && !('component' in q && q.component >= 0 && q.component < d.components.length) && q.net >= 0 && q.net < d.nets.length && !(q.kind !== 'via' && q.polygon >= 0 && q.polygon < d.polygons.length))).apply();
    expect(routed(d).size).toBe(0);
    const r = applySession(d, ses);
    expect(r.warnings).toEqual([]);
    r.change.apply();
    const after = routed(d);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(Math.abs(after.get(k)! - v)).toBeLessThan(Math.max(UM * 20, v * 0.002));
    expect(d.prims.filter((q) => q.kind === 'via').length).toBe(vias0);
    expect(d.prims.some((q) => q.kind === 'region' && q.polygon === 0)).toBe(true);
    r.change.revert();
    expect(routed(d).size).toBe(0);
    r.change.apply();
    expect(routed(d).size).toBe(before.size);
  });

  it('a session over a routed board: its routes take the routed ones\' place; a part the router moved is said', () => {
    const d = board();
    const text = exportSpecctraDsn(d, 'Demo').text;
    const n0 = d.prims.filter((q) => q.kind === 'track' || q.kind === 'via').length;
    const moved = sessionOf(text).replace('(placement (resolution um 10))', `(placement (resolution um 10) (component X (place ${d.components[0]!.designator} 0 0 front 0)))`);
    const r = applySession(d, readSession(moved));
    expect(r.removed).toBeGreaterThan(0);
    expect(r.warnings.some((w) => /1 part was moved in the router/.test(w))).toBe(true);
    r.change.apply();
    expect(d.prims.filter((q) => q.kind === 'track' || q.kind === 'via').length).toBe(n0);
    expect(isList(kid(dsnTree(text), 'network'))).toBe(true);
  });
});
