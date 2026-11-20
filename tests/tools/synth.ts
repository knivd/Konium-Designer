/**
 * Land-pattern drawings made up, with their answers (src/ai/synth.ts): rendered in a browser, kept
 * as a dataset, and used to measure how well Konium's measuring and a model read them.
 *
 *   npx tsx tests/tools/synth.ts --out DIR [--n 100] [--seed 1] [--kinds dual,quad,…] [--chat]
 *       pictures (PNG) and dataset.jsonl: each drawing's job input and the answer that reads it right;
 *       --chat also writes train.jsonl, chat examples (system, user with the picture, the answer)
 *   npx tsx tests/tools/synth.ts --eval measure [--n 100] …
 *       the measuring on the rendered pictures (with the drawing's lines, and on its ink alone), from
 *       reads moved as a model moves them: how many come out exact, by kind
 *   npx tsx tests/tools/synth.ts --eval model --model ID [--rounds 2] [--key] [--n 20] …
 *       the package job on each picture (the Konium service, or OpenRouter with --key and the key in
 *       OPENROUTER_KEY), its read measured, and checked by the model up to --rounds rounds: exact, by kind
 *
 * Playwright's Chromium renders (pre-installed: require('playwright')).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { PACKAGE, REVIEW, type PackageRead, type Picture } from '../../src/ai/jobs';
import { SYNTH_KINDS, compareLand, perturb, rand, segmentsOf, synth, toSvg, type Synth, type SynthKind } from '../../src/ai/synth';
import { measureLand, type Grey, type Measured } from '../../src/ai/snap';
import { answerOf, footprintDrawing } from '../../src/ai/review';
import { runJob, setAiKey, type AiSettings } from '../../src/ai/client';

const args = process.argv.slice(2);
const opt = (k: string, d = '') => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? '' : d; };
const flag = (k: string) => args.includes(`--${k}`);
const N = Number(opt('n', '100')), SEED = Number(opt('seed', '1')), OUT = opt('out');
const KINDS = (opt('kinds') ? opt('kinds').split(',') : SYNTH_KINDS) as SynthKind[];
const EVAL = opt('eval');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = createRequire(import.meta.url)('playwright') as any;
const browser = await chromium.launch();
const page = await browser.newPage();

/** An SVG rendered: its PNG, and its grey values (as the app measures). */
async function render(svg: string, w: number, h: number): Promise<{ png: Buffer; grey: Grey }> {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
  const png: Buffer = await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
  const b64: string = await page.evaluate(async (url: string) => {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data, g = new Uint8Array(c.width * c.height);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4]! * 77 + d[i * 4 + 1]! * 150 + d[i * 4 + 2]! * 29) >> 8;
    let s = ''; for (let i = 0; i < g.length; i += 0x8000) s += String.fromCharCode(...g.subarray(i, i + 0x8000));
    return btoa(s);
  }, `data:image/png;base64,${png.toString('base64')}`);
  return { png, grey: { width: w, height: h, data: new Uint8Array(Buffer.from(b64, 'base64')) } };
}

const samples = function* (): Generator<Synth> {
  for (let i = 0; i < N; i++) yield synth(SEED + i, { kind: KINDS[i % KINDS.length] });
};
const table = (rows: Record<string, Record<string, number>>) => {
  const cols = [...new Set(Object.values(rows).flatMap((r) => Object.keys(r)))];
  console.log(['kind'.padEnd(8), ...cols.map((c) => c.padStart(9))].join(' '));
  for (const [k, r] of Object.entries(rows)) console.log([k.padEnd(8), ...cols.map((c) => String(r[c] ?? 0).padStart(9))].join(' '));
};

if (!EVAL) {
  if (!OUT) throw new Error('--out DIR');
  mkdirSync(OUT, { recursive: true });
  const data: string[] = [], chat: string[] = [];
  for (const s of samples()) {
    const id = String(s.seed).padStart(6, '0');
    const { png } = await render(toSvg(s.drawing), s.drawing.width, s.drawing.height);
    writeFileSync(`${OUT}/${id}.png`, png);
    data.push(JSON.stringify({ id, kind: s.kind, image: `${id}.png`, width: s.drawing.width, height: s.drawing.height, scale: s.drawing.scale, input: s.input, answer: s.answer, style: s.style }));
    if (flag('chat')) {
      const m = PACKAGE.messages({ ...s.input, pictures: [{ page: 1, url: `data:image/png;base64,${png.toString('base64')}`, label: 'the recommended land pattern, enlarged' }] });
      chat.push(JSON.stringify({ messages: [...m, { role: 'assistant', content: JSON.stringify(s.answer) }] }));
    }
  }
  writeFileSync(`${OUT}/dataset.jsonl`, `${data.join('\n')}\n`);
  if (chat.length) writeFileSync(`${OUT}/train.jsonl`, `${chat.join('\n')}\n`);
  console.log(`${data.length} drawings in ${OUT}`);
} else if (EVAL === 'measure') {
  const rows: Record<string, Record<string, number>> = {};
  for (const s of samples()) {
    const r = (rows[s.kind] ??= { n: 0, lines: 0, ink: 0, none: 0 });
    const { grey } = await render(toSvg(s.drawing), s.drawing.width, s.drawing.height);
    const bad = perturb(s.read, rand(s.seed + 1));
    r.n!++;
    const a = measureLand(bad, grey, { segs: segmentsOf(s.drawing) }), b = measureLand(bad, grey);
    if (!a) r.none!++;
    if (a && compareLand(s.read.land, a.read.land).ok) r.lines!++;
    if (b && compareLand(s.read.land, b.read.land).ok) r.ink!++;
  }
  table(rows);
} else if (EVAL === 'model') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
  const own = flag('key'), model = opt('model'), rounds = Number(opt('rounds', '0'));
  if (own) setAiKey(process.env.OPENROUTER_KEY ?? '');
  const mode = own ? 'key' : 'konium';
  const cfg: AiSettings = { aiMode: mode, aiProvider: 'openrouter', aiCustomBase: '', aiLocalBase: '', aiModels: model ? { [`${mode}:model`]: model } : {}, aiShareCache: false };
  const rows: Record<string, Record<string, number>> = {};
  let cost = 0;
  for (const s of samples()) {
    const r = (rows[s.kind] ??= { n: 0, read: 0, measured: 0, checked: 0, failed: 0 });
    r.n!++;
    const { png, grey } = await render(toSvg(s.drawing), s.drawing.width, s.drawing.height);
    const pic: Picture = { page: 1, url: `data:image/png;base64,${png.toString('base64')}`, label: 'the recommended land pattern, enlarged' };
    const segs = segmentsOf(s.drawing);
    try {
      const got = await runJob(PACKAGE, { ...s.input, pictures: [pic] }, { cfg, fresh: true });
      cost += got.usage.cost ?? 0;
      let read: PackageRead = got.value, m: Measured | null = measureLand(read, grey, { segs });
      if (compareLand(s.read.land, read.land).ok) r.read!++;
      if (compareLand(s.read.land, (m?.read ?? read).land).ok) r.measured!++;
      for (let round = 1; round <= rounds; round++) {
        const shown = (m?.read ?? read).land;
        const fp = footprintDrawing(shown);
        const pics: Picture[] = [{ ...pic, label: 'the datasheet\'s land pattern' }, { page: 1, url: `data:image/png;base64,${(await render(toSvg(fp), fp.width, fp.height)).png.toString('base64')}`, label: 'the footprint as made, drawn to scale' }];
        if (m) {
          // The pads in red over the drawing: the drawing's SVG with outlines added
          const red = shown.map((p) => { const x = m!.origin.x + p.x * m!.scale, y = m!.origin.y - p.y * m!.scale, w = p.w * m!.scale, h = p.h * m!.scale; return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="none" stroke="#e00000" stroke-width="2"/><text x="${x}" y="${y + 4}" fill="#e00000" font-size="11" font-family="Arial" text-anchor="middle">${p.name}</text>`; }).join('');
          pics.push({ page: 1, url: `data:image/png;base64,${(await render(toSvg(s.drawing).replace('</svg>', `${red}</svg>`), s.drawing.width, s.drawing.height)).png.toString('base64')}`, label: 'the footprint\'s pads (red) over the datasheet\'s drawing' });
        }
        const rv = await runJob(REVIEW, { device: s.input.device, variant: { package: s.input.variant.package, pins: s.input.variant.pins }, land: answerOf(shown), dimensions: read.dimensions, measured: !!m, round, pictures: pics }, { cfg });
        cost += rv.usage.cost ?? 0;
        if (rv.value.ok || !rv.value.land) break;
        read = { ...read, land: rv.value.land };
        m = measureLand(read, grey, { segs });
      }
      if (rounds && compareLand(s.read.land, (m?.read ?? read).land).ok) r.checked!++;
    } catch (e) { r.failed!++; console.log(`${s.seed} ${s.kind}: ${(e as Error).message}`); }
  }
  table(rows);
  console.log(`cost $${cost.toFixed(3)}`);
} else throw new Error(`--eval measure | model, not ${EVAL}`);
await browser.close();
