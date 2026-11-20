import { beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE, REVIEW, type PackageInput, type ReviewInput } from '../src/ai/jobs';
import { pathSegments, type Seg } from '../src/ai/vector';
import { measureLand, onLines, shapes, type Grey } from '../src/ai/snap';
import { SYNTH_KINDS, compareLand, perturb, rand, rasterise, segmentsOf, synth, textOf, toSvg, type SynthKind } from '../src/ai/synth';
import { answerOf, footprintDrawing } from '../src/ai/review';
import { buildFootprint } from '../src/ai/footprint';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';
import { reviewChecks, newDraft } from '../src/app/dialogs/AiPackage';

/* ─── A PDF's own lines ──────────────────────────────────────────────────────────────── */

describe('a vector drawing\'s lines (26.079)', () => {
  // pdf.js's operator numbers, as many as the reading needs
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
  const path = (...d: number[]) => [0, [new Float32Array(d)], null];
  it('paths through the page\'s transforms into a picture\'s pixels: lines, closed shapes, curves in pieces, nested transforms undone', () => {
    // The viewport: 2 pixels to the point, y down from the page's top (100 pt high)
    const start = [2, 0, 0, -2, 0, 200];
    const fns = [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath];
    const args = [
      [], [1, 0, 0, 1, 10, 10],
      // a 10 × 5 rectangle from (0, 0), moved to (10, 10)
      path(0, 0, 0, 1, 10, 0, 1, 10, 5, 1, 0, 5, 4),
      [], [[1, 0, 0, 1, 50, 0], null],
      // a quarter circle, radius 10 about (0, 0) as a Bézier, in a form moved to (50, 0)
      path(0, 0, 10, 2, 5.5228, 10, 10, 5.5228, 10, 0),
      [],
      // back where it started: a line from (0, 50) to (20, 50)
      path(0, 0, 50, 1, 20, 50),
    ];
    const segs = pathSegments(fns, args, OPS, start, 400, 400);
    const r = (s: Seg) => [s.a.x, s.a.y, s.b.x, s.b.y].map((v) => +v.toFixed(2));
    expect(segs.slice(0, 4).map(r)).toEqual([[20, 180, 40, 180], [40, 180, 40, 170], [40, 170, 20, 170], [20, 170, 20, 180]]);
    const arc = segs.slice(4, 12);
    expect(arc).toHaveLength(8);
    expect(r(arc[0]!).slice(0, 2)).toEqual([100, 180]);
    expect(r(arc[7]!).slice(2)).toEqual([120, 200]);
    // On the circle, every piece's end (within the Bézier's error)
    for (const s of arc) expect(Math.hypot(s.b.x - 100, s.b.y - 200)).toBeCloseTo(20, 1);
    expect(r(segs[12]!)).toEqual([0, 100, 40, 100]);
    // Lines that miss the picture are left out
    expect(pathSegments([OPS.constructPath], [path(0, 500, 500, 1, 600, 600)], OPS, start, 400, 400)).toEqual([]);
  });

  it('a pad\'s box on its outline\'s lines, not its ink (half a stroke wider, and lines drawn up to it): square and round', () => {
    const w = 200, h = 160, data = new Uint8Array(w * h).fill(255);
    const ink = (x0: number, y0: number, x1: number, y1: number) => { for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) data[y * w + x] = 0; };
    // A pad 40 × 20 at (30, 30)–(70, 50) outlined 4 px wide, an extension line drawn up to its left side
    ink(28, 28, 72, 32); ink(28, 48, 72, 52); ink(28, 28, 32, 52); ink(68, 28, 72, 52); ink(10, 39, 28, 40);
    // A round pad, radius 15 about (140, 100), outlined 4 px wide, with a leader's arrow at 45°
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x + 0.5 - 140, y + 0.5 - 100); if (d >= 13 && d <= 17) data[y * w + x] = 0; }
    const img: Grey = { width: w, height: h, data };
    const segs: Seg[] = [
      { a: { x: 30, y: 30 }, b: { x: 70, y: 30 } }, { a: { x: 70, y: 30 }, b: { x: 70, y: 50 } }, { a: { x: 70, y: 50 }, b: { x: 30, y: 50 } }, { a: { x: 30, y: 50 }, b: { x: 30, y: 30 } },
      { a: { x: 10, y: 39.5 }, b: { x: 28, y: 39.5 } },
      ...Array.from({ length: 24 }, (_, k) => { const a = (k * Math.PI) / 12, b = ((k + 1) * Math.PI) / 12; return { a: { x: 140 + 15 * Math.cos(a), y: 100 + 15 * Math.sin(a) }, b: { x: 140 + 15 * Math.cos(b), y: 100 + 15 * Math.sin(b) } }; }),
      // the arrow: a small triangle on the circle at 45°, poking out of it
      { a: { x: 150.6, y: 89.4 }, b: { x: 158, y: 86 } }, { a: { x: 158, y: 86 }, b: { x: 154, y: 82 } }, { a: { x: 154, y: 82 }, b: { x: 150.6, y: 89.4 } },
    ];
    const found = shapes(img);
    const sq = found.find((b) => b.x0 < 40 && b.y0 < 40)!, rd = found.find((b) => b.x0 > 100)!;
    expect(sq.x1 - sq.x0).toBeGreaterThan(42);
    const { shapes: on, refined } = onLines([sq, rd], segs);
    expect(refined).toBe(2);
    expect(on[0]).toMatchObject({ x0: 30, x1: 70, y0: 30, y1: 50 });
    expect(on[1]!.x0).toBeCloseTo(125, 0); expect(on[1]!.x1).toBeCloseTo(155, 0); expect(on[1]!.y0).toBeCloseTo(85, 0); expect(on[1]!.y1).toBeCloseTo(115, 0);
  });
});

/* ─── Land-pattern drawings made up ──────────────────────────────────────────────────── */

describe('drawings made up with their answers (26.079)', () => {
  it('every kind: the same seed, the same drawing; its answer reads as the job reads it, makes a footprint, and says what the drawing shows', () => {
    for (const kind of SYNTH_KINDS) for (const seed of [1, 2, 3]) {
      const a = synth(seed, { kind }), b = synth(seed, { kind });
      expect(toSvg(a.drawing)).toBe(toSvg(b.drawing));
      const svg = toSvg(a.drawing);
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      // The answer through the job's own check is the read; pins named once each (shields share or are named so)
      expect(PACKAGE.check(a.answer, a.input)).toEqual(a.read);
      const named = a.read.land.map((p) => p.name).filter((n) => n && !/^(SH|SHIELD|MH|MP)\d*$/.test(n));
      expect(new Set(named).size).toBe(a.read.pins + (a.pattern.thermalPad ? 1 : 0));
      const built = buildFootprint(a.read, { source: 'datasheet', name: 'X' });
      expect(built.checks.filter((c) => c.level === 'error')).toEqual([]);
      // Every dimension the answer gives is written on the drawing (its page text)
      const page = textOf(a.drawing);
      for (const d of (a.answer.landPattern as { dimensions: string[] }).dimensions) expect(page).toContain(d.split(': ')[0]);
    }
  });
  it('drawn every way: pads filled, grey, outlined, hatched; turned; inches; titles', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const s = synth(seed);
      seen.add(s.style.pad); seen.add(s.style.units); seen.add(s.kind);
      if (s.pattern.rows.some((r) => r.direction === 'up' || r.direction === 'down') && s.kind === 'stagger') seen.add('turned');
    }
    for (const k of ['fill', 'grey', 'outline', 'hatch', 'mm', 'inch', ...SYNTH_KINDS]) expect(seen.has(k), k).toBe(true);
  });
  it('judging a read: by name, wherever its middle is; a pad off by more than 0.02 mm is wrong, as is one missing', () => {
    const s = synth(5, { kind: 'dual' });
    const t = s.read.land;
    expect(compareLand(t, t.map((p) => ({ ...p, x: p.x + 1.3, y: p.y - 0.7 }))).ok).toBe(true);
    const off = compareLand(t, t.map((p, i) => (i === 2 ? { ...p, x: p.x + 0.05 } : p)));
    expect(off).toMatchObject({ ok: false, off: 1, matched: t.length });
    expect(off.pos).toBeCloseTo(0.05, 3);
    expect(compareLand(t, t.slice(1))).toMatchObject({ ok: false, matched: t.length - 1 });
  });
});

/* ─── Measuring, on the drawings made up ─────────────────────────────────────────────── */

describe('pads measured in drawings made up (26.079)', () => {
  it('rows misplaced by a model, put right on the drawing: on its lines nearly always, and never worse than on its ink', () => {
    const kinds: SynthKind[] = ['dual', 'quad', 'header', 'stagger', 'fpc', 'bga'];
    let vec = 0, ink = 0, n = 0;
    for (const kind of kinds) for (let i = 0; i < 4; i++) {
      const seed = 500 + 37 * i;
      const s = synth(seed, { kind, width: [520, 700], height: [420, 560] });
      const img = rasterise(s.drawing), segs = segmentsOf(s.drawing);
      const bad = perturb(s.read, rand(seed + 1));
      n++;
      const a = measureLand(bad, img, { segs }), b = measureLand(bad, img);
      if (a && compareLand(s.read.land, a.read.land).ok) vec++;
      if (b && compareLand(s.read.land, b.read.land).ok) ink++;
      if (a) expect(a.vector).toBe(true);
    }
    expect(vec / n).toBeGreaterThanOrEqual(0.8);
    expect(vec).toBeGreaterThanOrEqual(ink);
  }, 60_000);
  it('where the drawing isn\'t to scale (pads drawn longer than dimensioned): said, the read\'s sizes kept', () => {
    const s = synth(11, { kind: 'dual', turned: false, width: [600, 700], height: [500, 600] });
    // As if the dimensions said 85 % of the drawn length
    const read = { ...s.read, land: s.read.land.map((p) => (p.name && Number(p.name) <= s.read.pins ? { ...p, w: +(p.w * 0.85).toFixed(3) } : p)) };
    const m = measureLand(read, rasterise(s.drawing), { segs: segmentsOf(s.drawing) })!;
    expect(m.notes.join(' ')).toMatch(/drawn [\d.]+ × [\d.]+ mm, dimensioned [\d.]+ × [\d.]+: the drawing isn't to scale there/);
    expect(m.read.notes).toContain('isn\'t to scale');
    expect(m.read.land[0]!.w).toBe(read.land[0]!.w);
    // Where the read's (0, 0) is in the picture: a pad's centre there is the drawing's
    const p = m.read.land[0]!, o = s.drawing.origin, sc = s.drawing.scale, t = s.read.land[0]!;
    expect(m.origin.x + p.x * m.scale).toBeCloseTo(o.x + t.x * sc, -0.5);
    expect(m.origin.y - p.y * m.scale).toBeCloseTo(o.y - t.y * sc, -0.5);
    expect(m.picture).toEqual({ width: s.drawing.width, height: s.drawing.height });
  });
});

/* ─── The model checking its footprint ───────────────────────────────────────────────── */

describe('the model checks the footprint it made (26.079)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  it('the footprint as the job\'s answer: rows named on (up or down) or listed, the rest single pads; read back the same', () => {
    for (const kind of ['dual', 'quad', 'header', 'stagger', 'fpc', 'bga', 'sot'] as SynthKind[]) for (const seed of [3, 4]) {
      const s = synth(seed, { kind });
      const a = answerOf(s.read.land);
      const back = PACKAGE.check({ family: s.read.family, pins: s.read.pins, landPattern: a }, s.input).land;
      const key = (l: typeof back) => l.map((p) => `${p.name}@${p.x.toFixed(3)},${p.y.toFixed(3)} ${p.w}x${p.h} ${p.hole}/${p.slot}/${p.plated}`).sort();
      expect(key(back)).toEqual(key(s.read.land));
      expect(a.rows.length).toBeGreaterThan(kind === 'sot' ? -1 : 0);
    }
    // A header's odd row: listed names
    const h = synth(7, { kind: 'header' });
    const odd = answerOf(h.read.land).rows.find((r) => Array.isArray(r.names));
    if (h.pattern.rows.some((r) => r.names)) expect(odd).toBeTruthy();
  });
  it('the footprint drawn for the model: every pad and its name, each row\'s pitch, the holes', () => {
    const s = synth(4, { kind: 'stagger' });
    const svg = toSvg(footprintDrawing(s.read.land));
    for (const p of s.read.land) if (p.name) expect(svg).toContain(`>${p.name}<`);
    expect(svg).toContain(`PITCH=${s.read.pitch!.toFixed(2)}`);
    expect(svg).toMatch(/Ø0\.\d+/);
  });
  it('asks with the footprint, its dimensions, whether it was measured and the pictures; answers: it matches, or put right', () => {
    const s = synth(2, { kind: 'dual' });
    const input: ReviewInput = { device: 'AB1', variant: { package: 'SOP-8', pins: 8 }, land: answerOf(s.read.land), dimensions: ['1.27: pitch'], measured: true, round: 2, pictures: [{ page: 1, url: PNG, label: 'the datasheet\'s land pattern' }] };
    const m = REVIEW.messages(input);
    const user = (m[1]!.content as { type: string; text?: string }[]).map((p) => p.text ?? '').join('\n');
    expect(user).toContain('Round 2 of checking. The pads\' places were measured in the drawing.');
    expect(user).toContain('- 1.27: pitch');
    expect(user).toContain('"first":"1"');
    expect(user).toContain('Picture of page 1: the datasheet\'s land pattern:');
    expect(REVIEW.roleOf!(input)).toBe('vision');
    expect(REVIEW.check({ verdict: 'ok', problems: [] }, input)).toEqual({ ok: true, problems: [], land: null, dimensions: [] });
    const fixed = REVIEW.check({ verdict: 'fix', problems: ['pads 5 … 8 the wrong way round'], landPattern: { dimensions: ['1.27: pitch'], ...answerOf(s.read.land) } }, input);
    expect(fixed).toMatchObject({ ok: false, problems: ['pads 5 … 8 the wrong way round'], dimensions: ['1.27: pitch'] });
    expect(fixed.land).toHaveLength(s.read.land.length);
    // Problems found, nothing put right: not ok, no land
    expect(REVIEW.check({ verdict: 'fix', problems: ['unsure of pad 9'] }, input)).toMatchObject({ ok: false, land: null });
    expect(() => REVIEW.check({}, input)).toThrow(/No verdict/);
  });
  it('the checking in the review: a note when it matched, what was put right when the rounds ran out, what it still finds', () => {
    const s = synth(2, { kind: 'dual' });
    const v = { partNumbers: [], package: 'SOP-8', pins: 8, leadForm: 'gull-wing' as const, body: { length: null, width: null, height: null }, pitch: 1.27, thermalPad: false, pinout: 'A', drawingPages: [], landPatternPages: [], pinTablePages: [], orderingPage: null };
    const d = newDraft(v, s.read);
    expect(reviewChecks(d)).toEqual([]);
    expect(reviewChecks({ ...d, review: { rounds: 2, ok: true, problems: [], fixed: 1, unchecked: false } })).toEqual([{ level: 'note', text: 'Checked by the model against the drawing: it matches (round 2, after putting it right once)' }]);
    expect(reviewChecks({ ...d, review: { rounds: 3, ok: false, problems: ['pad 9 is too small'], fixed: 3, unchecked: true } })).toEqual([
      { level: 'warning', text: 'The model put the footprint right 3 times in 3 rounds of checking; the last version wasn\'t checked again (more rounds: Preferences › System › AI)' },
      { level: 'note', text: 'Put right: pad 9 is too small' }]);
    expect(reviewChecks({ ...d, review: { rounds: 1, ok: false, problems: ['pad 9 is too small'], fixed: 0, unchecked: false } })[0]).toEqual({ level: 'warning', text: 'The model\'s check (1 round) still finds: pad 9 is too small' });
  });

  describe('the service', () => {
    const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '1', DAILY_BUDGET_USD: '1' };
    const MODELS = [{ id: '~google/gemini-pro-latest', name: 'Gemini', created: 200, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'] } }];
    const sqlite = (): Sql => {
      const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
        { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
      const db = new DatabaseSync(':memory:');
      return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
    };
    let store: StoreLogic;
    const fetchFn = (async (url: string) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: MODELS }))
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict": "ok", "problems": []}' } }], usage: { prompt_tokens: 5000, completion_tokens: 50, cost: 0.002 } })))) as typeof fetch;
    const post = (body: object) => new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
    const now = Date.parse('2026-11-01T12:00:00Z');
    beforeEach(() => { store = new StoreLogic(sqlite()); resetModelCache(); });
    it('runs the checking, three rounds a footprint allowed apart from the day\'s jobs', async () => {
      const input: ReviewInput = { device: 'AB1', variant: { package: 'SOP-8', pins: 8 }, land: { rows: [], pads: [] }, dimensions: [], measured: false, round: 1, pictures: [{ page: 1, url: PNG }] };
      for (let i = 0; i < 3; i++) {
        const r = await handle(post({ job: 'review', input }), env, store, fetchFn, now);
        expect(await r.json()).toMatchObject({ answer: { ok: true }, allowance: { counted: 'review', jobs: 3, left: 2 - i } });
      }
      expect((await handle(post({ job: 'review', input }), env, store, fetchFn, now)).status).toBe(429);
      // The day's jobs untouched
      const pkg: PackageInput = { device: 'AB1', variant: { partNumbers: [], package: 'SOP-8', pins: 8, leadForm: 'gull-wing', body: { length: null, width: null, height: null }, pitch: 1.27, thermalPad: false }, pages: [], pictures: [], pageCount: 1 };
      expect((await handle(post({ job: 'package', input: pkg }), env, store, fetchFn, now)).status).toBe(200);
    });
  });
});
