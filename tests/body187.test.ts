/**
 * Lifelike 3D bodies for generated footprints (26.187): the pieces a package is made of, family by family.
 */
import { describe, expect, it } from 'vitest';
import { IPC_FAMILIES, ipcDefaults, ipcFootprint, ipcRecords, type IpcFamily } from '../src/model/ipcFootprint';
import { PIECE_COLOURS, packagePieces, type BodyPiece } from '../src/model/packageBody';

const made = (family: IpcFamily, change: Partial<ReturnType<typeof ipcDefaults>> = {}) => { const s = { ...ipcDefaults(family), ...change }, fp = ipcFootprint(s); return { s, fp, pieces: packagePieces(fp, s) }; };
const count = (p: BodyPiece[], what: BodyPiece['what']) => p.filter((x) => x.what === what).length;
const box = (p: BodyPiece) => ({ x0: Math.min(...p.outline.map((v) => v.x)), x1: Math.max(...p.outline.map((v) => v.x)), y0: Math.min(...p.outline.map((v) => v.y)), y1: Math.max(...p.outline.map((v) => v.y)) });

describe('the pieces of a package (26.187)', () => {
  it('every family is more than a box, no higher than the package, and inside its courtyard', () => {
    for (const [family] of IPC_FAMILIES) {
      const { fp, pieces } = made(family);
      expect(pieces.length, family).toBeGreaterThan(2);
      expect(Math.max(...pieces.map((p) => p.to)), family).toBeCloseTo(fp.height, 6);
      expect(Math.min(...pieces.map((p) => p.from)), family).toBeGreaterThanOrEqual(0);
      for (const p of pieces) {
        expect(p.to, family).toBeGreaterThan(p.from);
        expect(p.outline.length, family).toBeGreaterThanOrEqual(4);
        const b = box(p), cx = fp.courtyard.x ?? 0, cy = fp.courtyard.y ?? 0;
        expect(b.x0, `${family} ${p.what}`).toBeGreaterThanOrEqual(cx - fp.courtyard.w / 2 - 1e-6); expect(b.x1, `${family} ${p.what}`).toBeLessThanOrEqual(cx + fp.courtyard.w / 2 + 1e-6);
        expect(b.y0, `${family} ${p.what}`).toBeGreaterThanOrEqual(cy - fp.courtyard.h / 2 - 1e-6); expect(b.y1, `${family} ${p.what}`).toBeLessThanOrEqual(cy + fp.courtyard.h / 2 + 1e-6);
      }
    }
  });

  it('a chip is two metal ends and the body between; a capacitor\'s body is not a resistor\'s colour', () => {
    const r = made('CHIP'), c = made('CHIP', { prefix: 'CAPC' });
    expect([count(r.pieces, 'lead'), count(r.pieces, 'body')]).toEqual([2, 1]);
    const body = (p: BodyPiece[]) => p.find((x) => x.what === 'body')!;
    expect(body(r.pieces).colour).toBe(PIECE_COLOURS.resistor); expect(body(c.pieces).colour).toBe(PIECE_COLOURS.ceramic);
    // The ends are the terminal's length, at the body's two ends, the whole height
    const ends = r.pieces.filter((x) => x.what === 'lead').map(box).sort((a, b) => a.x0 - b.x0);
    expect(ends[0]!.x0).toBeCloseTo(-r.fp.body.w / 2, 6); expect(ends[1]!.x1).toBeCloseTo(r.fp.body.w / 2, 6);
    expect(ends[0]!.x1 - ends[0]!.x0).toBeCloseTo((r.s.term.min + r.s.term.max) / 2, 6);
  });

  it('a gull-wing package: three pieces to a lead (foot, riser, shoulder), the foot on its land, the body standing off the board with a dot at pin 1', () => {
    const { fp, s, pieces } = made('SOIC');
    expect(count(pieces, 'lead')).toBe(3 * s.pins); expect(count(pieces, 'body')).toBe(2); expect(count(pieces, 'mark')).toBe(1);
    const feet = pieces.filter((p) => p.what === 'lead' && p.from === 0 && p.to < 0.3);
    expect(feet.length).toBe(s.pins);
    for (const f of feet) {
      const b = box(f), pad = fp.pads.find((p) => Math.abs(p.y - (b.y0 + b.y1) / 2) < 1e-6 && Math.sign(p.x) === Math.sign(b.x0 + b.x1))!;
      expect(pad).toBeDefined();
      expect(b.x0).toBeGreaterThanOrEqual(pad.x - pad.w / 2 - 1e-6); expect(b.x1).toBeLessThanOrEqual(pad.x + pad.w / 2 + 1e-6);
      expect(b.y1 - b.y0).toBeCloseTo((s.leadW.min + s.leadW.max) / 2, 6);
    }
    // The lead's end is at half the span
    expect(Math.max(...feet.map((f) => box(f).x1))).toBeCloseTo((s.span.min + s.span.max) / 4, 6);
    expect(Math.min(...pieces.filter((p) => p.what === 'body').map((p) => p.from))).toBeGreaterThan(0.04);
    // The dot is by pin 1, on top
    const dot = box(pieces.find((p) => p.what === 'mark')!), one = fp.pads.find((p) => p.name === '1')!;
    expect(Math.sign(dot.x0 + dot.x1)).toBe(Math.sign(one.x)); expect(Math.sign(dot.y0 + dot.y1)).toBe(Math.sign(one.y));
  });

  it('a package of more than a hundred leads has two pieces to a lead', () => {
    const { s, pieces } = made('QFP', { pins: 144, pinsSide: 36 });
    expect(count(pieces, 'lead')).toBe(2 * s.pins);
    expect(count(made('QFP').pieces, 'lead')).toBe(3 * 64);
  });

  it('no-lead packages have a land flush with each side and the pad under them; J-leads are tucked under; a ball grid shows its two outer rings', () => {
    const qfn = made('QFN');
    expect(count(qfn.pieces, 'lead')).toBe(qfn.s.pins + 1);
    for (const p of qfn.pieces.filter((x) => x.what === 'lead')) { const b = box(p); expect(Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1))).toBeLessThanOrEqual(qfn.fp.body.w / 2 + 0.011); }
    const plcc = made('PLCC');
    expect(count(plcc.pieces, 'lead')).toBe(2 * plcc.s.pins);
    const bga = made('BGA');
    expect(count(bga.pieces, 'ball')).toBe(100 - 36); expect(count(bga.pieces, 'body')).toBe(2);
    expect(bga.pieces.filter((p) => p.what === 'ball').every((p) => p.from === 0)).toBe(true);
  });

  it('a MELF is round (slabs widest at its middle), a moulded capacitor is yellow with a stripe, a DPAK has its tab, a diode its band', () => {
    // (a diode's body is in two parts either side of its band, slab by slab: a resistor's MELF is whole)
    const melf = made('MELF', { prefix: 'RESMELF' }).pieces.filter((p) => p.what === 'body').map((p) => box(p).y1 - box(p).y0);
    expect(melf.length).toBe(6); expect(count(made('MELF').pieces, 'mark')).toBe(6); expect(count(made('MELF').pieces, 'body')).toBe(12); expect(melf[0]).toBeLessThan(melf[2]!); expect(melf[5]).toBeLessThan(melf[3]!); expect(melf[0]).toBeCloseTo(melf[5]!, 6);
    const cap = made('MOLDED').pieces;
    expect(cap.filter((p) => p.what === 'body').every((p) => p.colour === PIECE_COLOURS.tantalum)).toBe(true); expect(count(cap, 'mark')).toBe(1);
    const dpak = made('DPAK');
    const tab = dpak.pieces.filter((p) => p.what === 'lead').map(box).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0))[0]!;
    expect(tab.y1 - tab.y0).toBeGreaterThan(4); expect(tab.x1).toBeGreaterThan(dpak.fp.body.w / 2 + (dpak.fp.body.x ?? 0));
    expect(count(made('SOD').pieces, 'mark')).toBe(1);
  });

  it('a footprint with no family is read by its pads: through-hole pins go through the board, pads beside the body are leads', () => {
    const dip = packagePieces({ name: 'DIP8', description: '', pads: [0, 1, 2, 3].flatMap((i) => [{ name: String(i + 1), x: -3.81, y: 3.81 - 2.54 * i, w: 1.6, h: 1.6, shape: 'round' as const, hole: 0.8 }, { name: String(8 - i), x: 3.81, y: 3.81 - 2.54 * i, w: 1.6, h: 1.6, shape: 'round' as const, hole: 0.8 }]),
      body: { w: 6.4, h: 9.8 }, courtyard: { w: 9.5, h: 10.5 }, silk: [], pin1: { x: -3.81, y: 5 }, height: 3.5 });
    expect(count(dip, 'pin')).toBe(8); expect(dip.filter((p) => p.what === 'pin').every((p) => p.from < -1.6 && p.to > 0)).toBe(true); expect(count(dip, 'body')).toBe(2);
    const so = packagePieces({ name: 'X', description: '', pads: [-1, 1].flatMap((sx) => [1, 0, -1].map((k, i) => ({ name: String(sx < 0 ? i + 1 : 6 - i), x: sx * 1.4, y: k * 0.95, w: 1.1, h: 0.6, shape: 'rect' as const }))),
      body: { w: 1.6, h: 2.9 }, courtyard: { w: 4.4, h: 3.4 }, silk: [], pin1: { x: -1.4, y: 1.6 }, height: 1.1 });
    expect(count(so, 'lead')).toBe(18);
  });

  it('the wizard\'s footprint carries them as 3D bodies of the footprint: one record a piece', () => {
    const s = ipcDefaults('SOT23'), fp = ipcFootprint(s), pieces = packagePieces(fp, s);
    const records = ipcRecords(fp, s);
    expect(pieces.length).toBe(3 * 3 + 2 + 1);
    expect(records.length).toBe(fp.pads.length + fp.silk.length + 1 + 8 + pieces.length);
  });
});
