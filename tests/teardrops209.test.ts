/**
 * 26.209: teardrops as the desktop software makes them: copper regions
 * marked as teardrops, set by a window of working mode, objects, options and four scopes. The
 * numbers for a via and for an SMD pad are those of a board saved by the desktop software with
 * its default settings (a 0.6 mm via and 0.65 × 1.75 mm pads on 10 mil tracks), put here as
 * plain numbers; the mark is the one its regions carry.
 */
import { describe, expect, it } from 'vitest';
import { TEARDROP_DEFAULTS, TEARDROP_POINTS, cleanTeardropSettings, edgeTeardrop, planTeardropRegions, plannedRegions, roundTeardrop, teardropRegions, teardropsAt, type TeardropSettings } from '../src/model/teardropRegions';
import { fromStored, sanitise } from '../src/core/settings';
import { TEARDROP_FLAG, encodeRegion, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../src/model/pcb';
import { L } from '../src/model/layers';
import { addPrimRecords } from '../src/model/pcbEdit';

const MIL = 10_000, r2 = (x: number) => Math.round(x / 100) / 100;   // (to 0.01 mil)
const RAW = import.meta.glob(['../public/whats-new.json'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const readFileSync = (f: string, _enc: 'utf8') => RAW[`../${f}`]!;
const FILES = Object.keys(import.meta.glob(['../public/whats-new/*.webp']));
const existsSync = (f: string) => FILES.includes(`../${f}`);

describe('a teardrop\'s shape (26.209)', () => {
  it('at a via is what the desktop software draws: the chord, the reach and the curve of a 0.6 mm via on a 10 mil track', () => {
    const r = (0.6 / 0.0254) * MIL / 2, w = 10 * MIL;
    const t = roundTeardrop(r, w, 0, 70, 30, 'curved')!;
    expect([t.plus.length, t.minus.length]).toEqual([TEARDROP_POINTS, TEARDROP_POINTS]);
    // (as read from the board, from the via's centre along the track and across it, in mils)
    const side = t.plus.map((p) => [r2(p.u), r2(p.v)]);
    expect(side[0]).toEqual([17.79, 5]);                 // the narrow end: the track's own width
    expect(side[10]).toEqual([8.43, 8.27]);              // the wide end, on the via's edge: 70 % of 23.62 across
    expect(side[1]).toEqual([16.59, 5.03]);
    expect(side[5]).toEqual([12.37, 5.82]);
    expect(side[9]).toEqual([9.1, 7.65]);
    expect(r2(Math.hypot(t.plus[10]!.u, t.plus[10]!.v))).toBe(r2(r));
    // (the other side is its mirror)
    expect(t.minus.map((p) => [r2(p.u), r2(-p.v)])).toEqual(side);
    expect(r2(t.reach)).toBe(17.79);
    // (straight sides: the two ends alone)
    expect(roundTeardrop(r, w, 0, 70, 30, 'line')!.plus.map((p) => [r2(p.u), r2(p.v)])).toEqual([[17.79, 5], [8.43, 8.27]]);
    // (a track as wide as the chord asked for, or lying off the pad, gets none)
    expect(roundTeardrop(r, r * 2 * 0.7, 0, 70, 30, 'curved')).toBeNull();
    expect(roundTeardrop(r, w, r, 70, 30, 'curved')).toBeNull();
  });

  it('at an SMD pad: twice the track\'s width on the pad\'s edge, the track\'s width long, the curve\'s corner at the edge', () => {
    // A 25.59 × 68.9 mil pad, the track leaving through its short edge (the track's frame: u out of the pad)
    const hw = 12.795 * MIL, hl = 34.449 * MIL, w = 10 * MIL;
    const pad = [{ u: -hl, v: -hw }, { u: hl, v: -hw }, { u: hl, v: hw }, { u: -hl, v: hw }];
    const t = edgeTeardrop(pad, w, 0, 2 * w, w, 'curved')!;
    const from = (p: { u: number; v: number }) => [r2(p.u - hl), r2(p.v)];
    // (as read from the board, from the pad's edge: the wide end 0.12 inside it and 20 across, the narrow end 9.88 out and 10 across)
    expect(from(t.plus[10]!)).toEqual([-0.12, 10]);
    expect(from(t.plus[0]!)).toEqual([9.88, 5]);
    expect(t.plus.map((p) => r2(p.v))).toEqual([5, 5.05, 5.2, 5.45, 5.8, 6.25, 6.8, 7.45, 8.2, 9.05, 10]);
    expect(t.plus.map((p) => r2(t.plus[0]!.u - p.u))).toEqual([0, 1.9, 3.6, 5.1, 6.4, 7.5, 8.4, 9.1, 9.6, 9.9, 10]);
    // (a pad's edge too short for the width asked: as wide as the edge reaches; no wider than the track: none)
    const narrow = [{ u: -hl, v: -7 * MIL }, { u: hl, v: -7 * MIL }, { u: hl, v: 7 * MIL }, { u: -hl, v: 7 * MIL }];
    const n = edgeTeardrop(narrow, w, 0, 2 * w, w, 'curved')!;
    expect(Math.abs(n.plus[10]!.v)).toBeLessThanOrEqual(7 * MIL);
    expect(Math.abs(n.plus[10]!.v)).toBeGreaterThan(5.5 * MIL);
    expect(edgeTeardrop([{ u: -hl, v: -5 * MIL }, { u: hl, v: -5 * MIL }, { u: hl, v: 5 * MIL }, { u: -hl, v: 5 * MIL }], w, 0, 2 * w, w, 'curved')).toBeNull();
  });

  it('the settings are kept within what makes a teardrop', () => {
    expect(cleanTeardropSettings(undefined)).toEqual(TEARDROP_DEFAULTS);
    expect(TEARDROP_DEFAULTS).toMatchObject({ style: 'curved', force: true, adjust: true, report: false, viaPad: { on: true, length: 30, width: 70 }, smd: { on: true, width: 200, length: 100 }, tracks: { on: true, length: 100 }, tJunction: { on: true, span: 300, height: 100 } });
    const odd = cleanTeardropSettings({ style: 'zigzag', force: 'yes', viaPad: { on: false, length: -5, width: 400 }, smd: { width: 50 }, tJunction: { span: NaN } });
    expect(odd).toMatchObject({ style: 'curved', force: true, viaPad: { on: false, length: 1, width: 99 }, smd: { on: true, width: 101, length: 100 }, tJunction: { span: 300, height: 100 } });
  });
});

/** A new board, as File › New makes it. */
const board = (): PcbDocument => readPcbDoc(newPcbDocBytes('Teardrops.PcbDoc', new Date(Date.UTC(2026, 10, 22))), 'Teardrops.PcbDoc');
const track = (a: [number, number], b: [number, number], width: number, net: number, layer = L.TOP): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer, a: { x: a[0] * MIL, y: a[1] * MIL }, b: { x: b[0] * MIL, y: b[1] * MIL }, width: width * MIL, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
const via = (at: [number, number], net: number): PcbVia => ({ kind: 'via', src: { storage: 'Vias6', index: -1 }, at: { x: at[0] * MIL, y: at[1] * MIL }, diameter: 50 * MIL, hole: 28 * MIL, layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false });
const smd = (at: [number, number], w: number, h: number, net: number): PcbPad => { const st = { w: w * MIL, h: h * MIL, shape: 'rect' as const, cornerPct: 0 }; return { kind: 'pad', src: { storage: 'Pads6', index: -1 }, name: '1', layer: L.TOP, at: { x: at[0] * MIL, y: at[1] * MIL }, rotation: 0, top: st, mid: st, bot: st, hole: 0, plated: false, net, component: NO_NET, locked: false }; };
const only = (prims: PcbPrim[]): PcbDocument => ({ ...board(), prims });
const set = (o: Partial<TeardropSettings> = {}): TeardropSettings => ({ ...TEARDROP_DEFAULTS, ...o });

describe('where teardrops are made (26.209)', () => {
  it('at a via, at a change of width and at a T-junction, each scope by its tick; none twice', () => {
    const doc = only([
      via([1000, 1000], 1), track([1000, 1000], [1400, 1000], 10, 1),                       // a track out of a via
      track([1400, 1000], [1800, 1000], 30, 1),                                              // which then widens
      track([1600, 1000], [1600, 1300], 10, 1),                                              // and a track that ends on the wide one
    ]);
    // (the T's foot is in the middle of the wide track)
    const plan = planTeardropRegions(doc, set());
    expect(plan.made.map((t) => t.kind).sort()).toEqual(['tJunction', 'tracks', 'via']);
    expect(plan.failed).toEqual([]);
    for (const t of plan.made) { expect(t.net).toBe(1); expect(t.layer).toBe(L.TOP); expect(t.outline.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(true); }
    const by = Object.fromEntries(plan.made.map((t) => [t.kind, t]));
    expect(by.via!.outline).toHaveLength(2 * TEARDROP_POINTS);
    // (the via's: its narrow end 30 % of the diameter beyond where the track's edge leaves the via, towards the track)
    expect(Math.max(...by.via!.outline.map((p) => p.x)) / MIL).toBeCloseTo(1000 + Math.sqrt(25 * 25 - 5 * 5) + 15, 1);
    // (the change of width: from the joint, as long as the wider track is wide, back along the narrow one)
    const tr = by.tracks!.outline.map((p) => [p.x / MIL, p.y / MIL]);
    expect([Math.min(...tr.map((p) => p[0]!)), Math.max(...tr.map((p) => p[0]!))]).toEqual([1370, 1400]);
    expect([Math.min(...tr.map((p) => p[1]!)), Math.max(...tr.map((p) => p[1]!))]).toEqual([985, 1015]);
    // (the T: 300 % of the wide track's width along it, 100 % up the track that ends, on the side that track is)
    const tj = by.tJunction!.outline.map((p) => [p.x / MIL, p.y / MIL]);
    expect([Math.min(...tj.map((p) => p[0]!)), Math.max(...tj.map((p) => p[0]!))]).toEqual([1555, 1645]);
    expect(Math.max(...tj.map((p) => p[1]!))).toBe(1045);
    expect(Math.min(...tj.map((p) => p[1]!))).toBeGreaterThan(1014);
    // Each scope by its own tick
    expect(planTeardropRegions(doc, set({ viaPad: { ...TEARDROP_DEFAULTS.viaPad, on: false } })).made.map((t) => t.kind).sort()).toEqual(['tJunction', 'tracks']);
    expect(planTeardropRegions(doc, set({ tracks: { on: false, length: 100 }, tJunction: { ...TEARDROP_DEFAULTS.tJunction, on: false } })).made.map((t) => t.kind)).toEqual(['via']);
    // Straight sides: four corners (the T: its two fillets, eight... as two straight sides)
    expect(planTeardropRegions(doc, set({ style: 'line' })).made.find((t) => t.kind === 'via')!.outline).toHaveLength(4);
    // Selected only: the joints of what is selected
    expect(planTeardropRegions(doc, set(), new Set([doc.prims[0]!])).made.map((t) => t.kind)).toEqual(['via']);
    expect(planTeardropRegions(doc, set(), new Set()).made).toEqual([]);
    // Made once: with its teardrops on the board, a second run adds none
    const withThem: PcbDocument = { ...doc, prims: [...doc.prims, ...plan.made.map((t) => ({ kind: 'region' as const, src: { storage: 'Regions6', index: -1 }, layer: t.layer, outline: t.outline, holes: [], regionKind: 0, boardCutout: false, net: t.net, polygon: NO_NET, component: NO_NET, locked: false, keepout: false, teardrop: true }))] };
    expect(teardropRegions(withThem)).toHaveLength(3);
    expect(planTeardropRegions(withThem, set()).made).toEqual([]);
  });

  it('a track too short for its teardrop gets a smaller one (Adjust teardrop size), or none', () => {
    // (the track turns 8 mil beyond the via's edge: the full teardrop needs 15)
    const doc = only([via([1000, 1000], 1), track([1000, 1000], [1033, 1000], 10, 1), track([1033, 1000], [1033, 1200], 10, 1)]);
    const adjusted = planTeardropRegions(doc, set({ tracks: { on: false, length: 100 }, tJunction: { ...TEARDROP_DEFAULTS.tJunction, on: false } }));
    expect([adjusted.made.length, adjusted.smaller, adjusted.failed.length]).toEqual([1, 1, 0]);
    expect(Math.max(...adjusted.made[0]!.outline.map((p) => p.x)) / MIL).toBeLessThanOrEqual(1033);
    const asked = planTeardropRegions(doc, set({ adjust: false, tracks: { on: false, length: 100 }, tJunction: { ...TEARDROP_DEFAULTS.tJunction, on: false } }));
    expect([asked.made.length, asked.failed.map((f) => [f.kind, f.why])]).toEqual([0, [['via', 'room']]]);
  });

  it('a track as wide as the via it runs into has no joint to widen: nothing made, nothing failed', () => {
    const doc = only([via([1000, 1000], 1), track([1000, 1000], [1400, 1000], 50, 1)]);
    const plan = planTeardropRegions(doc, set());
    expect([plan.made.length, plan.failed.length]).toEqual([0, 0]);
  });

  it('the teardrops of the objects picked (Remove with Selected only): those that touch them', () => {
    const prims: PcbPrim[] = [
      via([1000, 1000], 1), track([1000, 1000], [1400, 1000], 10, 1), track([1400, 1000], [1800, 1000], 30, 1), track([1600, 1000], [1600, 1300], 10, 1),
      via([3000, 1000], 1), track([3000, 1000], [3400, 1000], 10, 1),
    ];
    const bare = only(prims), drops = plannedRegions(planTeardropRegions(bare, set()));
    expect(drops.map((r) => r.teardrop)).toEqual([true, true, true, true]);
    const doc: PcbDocument = { ...bare, prims: [...prims, ...drops] };
    const kinds = (among: PcbPrim[]) => teardropsAt(doc, new Set(among)).map((r) => drops.indexOf(r)).sort();
    const of = (kind: string, x: number) => planTeardropRegions(bare, set()).made.findIndex((t) => t.kind === kind && Math.abs(t.at.x / MIL - x) < 1);
    // (a via: its own teardrop, not the other via's; the wide track: the change of width that ends on it and the T that stands on it)
    expect(kinds([prims[0]!])).toEqual([of('via', 1000)]);
    expect(kinds([prims[4]!])).toEqual([of('via', 3000)]);
    expect(kinds([prims[2]!])).toEqual([of('tracks', 1400), of('tJunction', 1600)].sort());
    expect(kinds([prims[1]!])).toEqual([of('via', 1000), of('tracks', 1400)].sort());
    // (a teardrop picked itself is its own; nothing picked, none)
    expect(kinds([drops[0]!])).toEqual([0]);
    expect(kinds([])).toEqual([]);
  });

  it('near other copper: a smaller one that keeps the clearance (Adjust), the full one all the same (Force), or none', () => {
    // (another net's track runs 16.5 mil above the via's track: the full teardrop comes within 10 mil of it, a smaller one does not)
    const doc = only([via([1000, 1000], 1), track([1000, 1000], [1400, 1000], 10, 1), track([1027, 1024], [1400, 1024], 5, 2)]);
    const quiet = { tracks: { on: false, length: 100 }, tJunction: { ...TEARDROP_DEFAULTS.tJunction, on: false } };
    const width = (plan: ReturnType<typeof planTeardropRegions>) => { const ys = plan.made[0]!.outline.map((p) => p.y / MIL); return Math.max(...ys) - Math.min(...ys); };
    const both = planTeardropRegions(doc, set(quiet));
    expect([both.made.length, both.smaller, both.failed.length]).toEqual([1, 1, 0]);
    expect(width(both)).toBeLessThan(30);
    const forced = planTeardropRegions(doc, set({ ...quiet, adjust: false }));
    expect([forced.made.length, forced.smaller, forced.failed.length]).toEqual([1, 0, 0]);
    expect(width(forced)).toBeCloseTo(35, 1);
    const neither = planTeardropRegions(doc, set({ ...quiet, adjust: false, force: false }));
    expect([neither.made.length, neither.failed.map((f) => f.why)]).toEqual([0, ['clearance']]);
    const kept = planTeardropRegions(doc, set({ ...quiet, force: false }));
    expect([kept.made.length, kept.smaller]).toEqual([1, 1]);
    expect(kept.made[0]!.outline).toEqual(both.made[0]!.outline);
  });

  it('a track that leaves a via off its centre: no side overshoots the narrow end', () => {
    // (the track's centre line runs 9 mil beside the centre of a 50 mil via)
    const t = roundTeardrop(25 * MIL, 10 * MIL, 9 * MIL, 70, 30, 'curved')!;
    for (const p of [...t.plus, ...t.minus]) { expect(p.u).toBeLessThanOrEqual(t.reach + 1); expect(p.u).toBeGreaterThan(0); expect(Math.hypot(p.u, p.v)).toBeGreaterThan(25 * MIL - 2); }
    // (a chord nearly the via's whole width with next to no length: straight sides, not a curve thrown beyond its end)
    const flat = roundTeardrop(25 * MIL, 10 * MIL, 0, 99, 1, 'curved')!;
    expect([flat.plus.length, flat.minus.length]).toEqual([2, 2]);
  });

  it('a joint with its teardrop gets no second one, whatever the size or the angle of the first', () => {
    const twice = (prims: PcbPrim[], o: Partial<TeardropSettings> = {}) => {
      const bare = only(prims), first = planTeardropRegions(bare, set(o));
      const second = planTeardropRegions({ ...bare, prims: [...prims, ...plannedRegions(first)] }, set(o));
      return [first.made.map((t) => t.kind).sort(), first.smaller, second.made.length];
    };
    // (a track that leaves an SMD pad through its side on the slant, and one through its end)
    expect(twice([smd([1000, 1000], 60, 24, 1), track([1000, 1000], [1100, 1100], 8, 1)])).toEqual([['smd'], 0, 0]);
    expect(twice([smd([1000, 1000], 60, 24, 1), track([1000, 1000], [1200, 1000], 8, 1)])).toEqual([['smd'], 0, 0]);
    // (a track that leaves a via beside its centre)
    expect(twice([via([1000, 1000], 1), track([1000, 1012], [1400, 1012], 10, 1)])).toEqual([['via'], 0, 0]);
    // (teardrops made smaller for want of room: at the via, at a change of width hardly wider, at a T with short arms)
    expect(twice([via([1000, 1000], 1), track([1000, 1000], [1033, 1000], 10, 1), track([1033, 1000], [1033, 1200], 10, 1)])).toEqual([['via'], 1, 0]);
    expect(twice([track([1000, 1000], [1400, 1000], 10, 1), track([1400, 1000], [1800, 1000], 11, 1)])).toEqual([['tracks'], 0, 0]);
    expect(twice([track([1000, 1000], [1400, 1000], 10, 1), track([1400, 1000], [1800, 1000], 30, 1)], { tracks: { on: true, length: 5 } })).toEqual([['tracks'], 0, 0]);
    expect(twice([track([1592, 1000], [1608, 1000], 10, 1), track([1600, 1000], [1600, 1300], 10, 1)])).toEqual([['tJunction'], 0, 0]);
    expect(twice([track([1000, 1000], [1800, 1000], 10, 1), track([1600, 1000], [1600, 1300], 10, 1)], { tJunction: { on: true, span: 120, height: 10 } })).toEqual([['tJunction'], 0, 0]);
  });

  it('copper of no net gets its teardrops too, as on the board read', () => {
    const doc = only([via([1000, 1000], NO_NET), track([1000, 1000], [1400, 1000], 10, NO_NET)]);
    const plan = planTeardropRegions(doc, set({ force: false }));
    expect(plan.made.map((t) => [t.kind, t.net])).toEqual([['via', NO_NET]]);
  });
});

describe('the settings as kept (26.209)', () => {
  it('come back within their limits, and the style chosen for the earlier teardrops is carried over', () => {
    expect(sanitise({}).pcbTeardrops).toEqual(TEARDROP_DEFAULTS);
    const odd = sanitise({ pcbTeardrops: { style: 'line', report: true, viaPad: { on: false, length: 9999, width: 0 }, smd: 'no' } }).pcbTeardrops;
    expect(odd).toMatchObject({ style: 'line', report: true, force: true, viaPad: { on: false, length: 300, width: 1 }, smd: TEARDROP_DEFAULTS.smd });
    expect(sanitise({ pcbTeardrops: 'curved' }).pcbTeardrops).toEqual(TEARDROP_DEFAULTS);
    // (teardrops made of tracks, as chosen in an earlier build: straight sides now; of arcs: curved)
    expect(fromStored({ pcbTeardropStyle: 'track' }).pcbTeardrops.style).toBe('line');
    expect(fromStored({ pcbTeardropStyle: 'arc' }).pcbTeardrops.style).toBe('curved');
    expect(fromStored({ pcbTeardropStyle: 'track', pcbTeardrops: { style: 'curved' } }).pcbTeardrops.style).toBe('curved');
    // (the defaults are not shared with what the window changes)
    expect(sanitise({}).pcbTeardrops).not.toBe(TEARDROP_DEFAULTS);
  });
});

describe('a teardrop in the board\'s file (26.209)', () => {
  it('is a region with the teardrop mark, there again when the board is read back', () => {
    const rec = encodeRegion({ layer: L.TOP, outline: [{ x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 0, y: 100000 }], net: 2, teardrop: true });
    expect(rec.subs[0]![1]).toBe(0x0c | TEARDROP_FLAG);
    expect(encodeRegion({ layer: L.TOP, outline: [{ x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 0, y: 100000 }] }).subs[0]![1]).toBe(0x0c);
    expect(TEARDROP_FLAG).toBe(0x10);
    // (its property block is the one the desktop software's own teardrops carry)
    const text = new TextDecoder('latin1').decode(rec.subs[0]!);
    expect(text).toContain('V7_LAYER=TOP|NAME= |KIND=0|SUBPOLYINDEX=-1|UNIONINDEX=0|ARCRESOLUTION=0.5mil|ISSHAPEBASED=FALSE|CAVITYHEIGHT=0mil');
    // A board with a teardrop on it, written and read back: the region is a teardrop still, and no other is
    const doc = board();
    addPrimRecords(doc, [{ storage: 'Regions6', rec }, { storage: 'Regions6', rec: encodeRegion({ layer: L.TOP, outline: [{ x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 0, y: 100000 }] }) }]).apply();
    expect(doc.prims.filter((p) => p.kind === 'region' && p.teardrop)).toHaveLength(1);
    const back = readPcbDoc(writePcbDoc(doc), 'Teardrops.PcbDoc');
    expect(back.prims.filter((p) => p.kind === 'region').map((p) => [p.kind === 'region' && !!p.teardrop, p.kind === 'region' && p.net])).toEqual([[true, 2], [false, NO_NET]]);
  });
});

describe('the release as told (26.209)', () => {
  it('What\'s New has its entry, with its two pictures, in the house style', () => {
    const wn = JSON.parse(readFileSync('public/whats-new.json', 'utf8')) as { releases: { version: string; title: string; items: { text: string; image?: string; alt?: string }[] }[] };
    const entry = wn.releases.find((r) => r.version === '26.209')!;
    expect(entry.title).toContain('Teardrops');
    const pictures = entry.items.filter((i) => i.image);
    expect(pictures.map((i) => i.image)).toEqual(['whats-new/26.209-teardrops.webp', 'whats-new/26.209-live.webp']);
    for (const i of pictures) { expect(existsSync(`public/${i.image}`), i.image).toBe(true); expect((i.alt ?? '').length).toBeGreaterThan(40); }
    const all = entry.items.map((i) => `${i.text} ${i.alt ?? ''}`).join(' ');
    for (const said of ['Via/TH Pad', 'T-Junction', 'Polarised capacitor', 'Update From Libraries', 'folder picker', 'every pushing mode', 'Shift+S']) expect(all).toContain(said);
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/\bAD\b|\bKD\b|Altium|Protel/);
    // (the parts library is not switched on: the entry says nothing of it)
    expect(all).not.toMatch(/parts library|world library/i);
  });
});
