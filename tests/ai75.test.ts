import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE, SURVEY, closeJson, distinctPinouts, packageKey, parseJsonAnswer, type PackageInput, type PackageRead, type PageText, type SurveyInput, type Variant } from '../src/ai/jobs';
import { isDrawing, packagePages, pickPages, surveyPictures } from '../src/ai/datasheet';
import { buildFootprint, calcMissing, checkRead, footprintName, mirrorLand, rotateLand, specOf } from '../src/ai/footprint';
import { draftFootprint, newDraft, nextPad } from '../src/app/dialogs/AiPackage';
import { measureLand, rowsOf, shapes, type Grey } from '../src/ai/snap';
import { ipcDefaults, ipcFootprint } from '../src/model/ipcFootprint';
import { decodePrim } from '../src/formats/altium/pcbdoc';
import { storageFor } from '../src/formats/altium/pcblib';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';
import type { PcbPad, PcbPrim } from '../src/model/pcb';
import { handle, resetModelCache, type AiEnv } from '../cloudflare/ai/src/handler';
import { NOT_YET, runJob, serviceRuns, type AiSettings } from '../src/ai/client';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';

const PNG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ';
const variant: Variant = {
  partNumbers: ['AB123SIG'], package: 'SOP8 150mil', pins: 8, leadForm: 'gull-wing', body: { length: 4.9, width: 3.9, height: 1.75 }, pitch: 1.27,
  thermalPad: false, pinout: 'A', drawingPages: [12], landPatternPages: [], pinTablePages: [3], orderingPage: 14,
};
const blankRead: PackageRead = {
  family: 'SOIC', standard: false, pins: 8, pinsSide: 0, pitch: 1.27,
  bodyD: { min: 4.8, max: 5.0 }, bodyE: { min: 3.8, max: 4.0 }, height: { min: 1.35, max: 1.75 },
  span: { min: 5.8, max: 6.2 }, span2: null, term: { min: 0.4, max: 1.27 }, leadW: { min: 0.31, max: 0.51 },
  tab: null, ball: null, rows: 0, cols: 0, land: [], outline: null, dimensions: [], pages: [12], notes: '',
};
const prims = (records: ReturnType<typeof buildFootprint>['records']): PcbPrim[] =>
  records.map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).filter((p): p is PcbPrim => !!p);
const padsOf = (records: ReturnType<typeof buildFootprint>['records']) => prims(records).filter((p): p is PcbPad => p.kind === 'pad');

/* ─── Answers cut short, surveys that read less ──────────────────────────────────────── */

describe('AI answers: cut short, and surveys of drawings', () => {
  it('an answer cut off at the length limit is kept up to its last whole value', () => {
    const cut = '{"maker": "Zetta", "variants": [{"package": "SOP8", "pins": 8}, {"package": "WSON8", "pi';
    expect(closeJson(cut)).toBe('{"maker": "Zetta", "variants": [{"package": "SOP8", "pins": 8}]}');
    expect(parseJsonAnswer(`\`\`\`json\n${cut}`)).toEqual({ maker: 'Zetta', variants: [{ package: 'SOP8', pins: 8 }] });
    // Braces inside strings don't count
    expect(closeJson('{"a": "x}{", "b": [1, 2], "c": {"d"')).toBe('{"a": "x}{", "b": [1, 2]}');
    expect(closeJson('{"a": 1')).toBeNull();
  });
  it('pages that are drawings are marked, and pictures of them go with the text (a job for a model that takes pictures)', () => {
    const input: SurveyInput = { pages: [{ page: 1, text: 'Micro SD card connector', drawing: true }, { page: 2, text: 'Notes' }], pageCount: 2, pictures: [{ page: 1, url: PNG }] };
    const m = SURVEY.messages(input);
    const parts = m[1]!.content as { type: string; text?: string }[];
    expect(parts[0]!.text).toMatch(/=== Page 1 \(mostly a drawing\) ===\nMicro SD/);
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
    expect(parts[1]!.text).toBe('Picture of page 1:');
    expect(SURVEY.roleOf!(input)).toBe('vision');
    expect(SURVEY.roleOf!({ ...input, pictures: [] })).toBe('text');
    // Only pictures go as pictures
    expect(() => SURVEY.messages({ ...input, pictures: [{ page: 1, url: 'https://example.com/x.png' }] })).toThrow(/isn't an image/);
  });
  it('a datasheet with a drawing and no ordering table still has a variant: the device, its drawing pages', () => {
    const input: SurveyInput = { pages: [{ page: 1, text: 'TF card H1.8', drawing: true }, { page: 2, text: 'Specification' }], pageCount: 2 };
    const s = SURVEY.check({ maker: 'Shou Han', device: 'TF-CARD H1.8', variants: [] }, input);
    expect(s.variants).toEqual([expect.objectContaining({ package: 'TF-CARD H1.8', pins: 0, drawingPages: [1] })]);
    expect(SURVEY.check({ variants: [{ partNumbers: ['HC-TYPE-C-24P'], package: null, pins: null, leadForm: 'Other' }] }, input).variants[0])
      .toMatchObject({ package: 'HC-TYPE-C-24P', pins: 0, leadForm: 'other' });
    expect(() => SURVEY.check({ variants: [] }, { pages: [{ page: 1, text: 'x' }], pageCount: 1 })).toThrow(/No package/);
  });
  it('variants with different pin counts never share a pinout letter', () => {
    const v = (pkg: string, pins: number, pinout: string): Variant => ({ ...variant, package: pkg, pins, pinout });
    const list = [v('SOJ36', 36, 'A'), v('TSOP44', 44, 'A'), v('SOJ36 reel', 36, 'A'), v('WSON8', 8, 'B'), v('SOP16', 16, 'B')];
    distinctPinouts(list);
    expect(list.map((x) => x.pinout)).toEqual(['A', 'C', 'A', 'B', 'D']);
  });
  it('drawing pages: many paths for their text, or mostly a picture; package pages first for the survey\'s pictures', () => {
    expect(isDrawing({ chars: 24, paths: 1835, cover: 0 })).toBe(true);
    expect(isDrawing({ chars: 1783, paths: 1719, cover: 0 })).toBe(false); // a table
    expect(isDrawing({ chars: 67, paths: 11, cover: 0.45 })).toBe(true); // a pasted drawing
    const pages: PageText[] = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, text: `Page ${i + 1} electrical characteristics` }));
    pages[19] = { page: 20, text: 'Typical supply current vs temperature', drawing: true };
    pages[37] = { page: 38, text: 'Package 8-Pad WSON (5x6mm)', drawing: true };
    pages[38] = { page: 39, text: '10.2 Package SOP16-300mil Dimensions Symbol A A1 b Min 0.10 Max 2.65', drawing: true };
    expect(surveyPictures(pages)).toEqual([38, 39]);
    // A short datasheet's drawing goes even without package words (a connector)
    expect(surveyPictures([{ page: 1, text: '', drawing: true }, { page: 2, text: 'Specification' }])).toEqual([1]);
    // A variant's drawing job: its pages, and the next when it carries the dimension table
    expect(packagePages(pages, [38], [])).toEqual([38, 39]);
    expect(packagePages(pages, [38], [], [39])).toEqual([38]);
    // Survey page picking favours drawing pages about packages
    expect(pickPages(pages, 200).map((p) => p.page)).toContain(39);
  });
});

/* ─── Reading a package's drawing ─────────────────────────────────────────────────────── */

describe('the package job', () => {
  const input: PackageInput = {
    device: 'AB123', variant, pages: [{ page: 12, text: 'Package SOP8 150mil Symbol Min Max', drawing: true }], pictures: [{ page: 12, url: PNG }], pageCount: 20,
  };
  it('asks with the variant, its pages and their pictures (a picture-reading job), or the name alone when there\'s no drawing', () => {
    const m = PACKAGE.messages(input);
    const parts = m[1]!.content as { type: string; text?: string }[];
    expect(parts[0]!.text).toMatch(/^Device: AB123\nVariant: package "SOP8 150mil", 8 pins, gull-wing, pitch 1.27 mm\nPart numbers: AB123SIG\n\n=== Page 12 \(mostly a drawing\) ===/);
    expect(parts.at(-1)!.type).toBe('image_url');
    expect(PACKAGE.roleOf!(input)).toBe('vision');
    const none = PACKAGE.messages({ ...input, pages: [], pictures: [] });
    expect(none[1]!.content).toMatch(/no drawing of this package/);
    expect(PACKAGE.roleOf!({ ...input, pictures: [] })).toBe('text');
  });
  it('cleans the answer: ranges in any form, millimetres, families by shape; rows of pads expanded and named on', () => {
    const r = PACKAGE.check({
      family: 'wson', units: 'mm', pins: '8', pitch: '1.27 BSC',
      body: { length: [5.05, 4.95], width: { min: 5.95, nom: 6, max: 6.05 }, height: 0.8 },
      leads: { span: null, foot: [0.55, 0.65], width: [0.35, 0.45] },
      thermalPad: { width: [3.35, 3.45], length: [3.95, 4.05] },
      landPattern: {
        rows: [{ first: '1', count: 4, pitch: 1.27, direction: 'down', x: -2.85, y: 1.905, w: 0.8, h: 0.5, shape: 'rect' },
          { first: '5', count: 4, pitch: 1.27, direction: 'up', x: 2.85, y: -1.905, w: 0.8, h: 0.5 }],
        pads: [{ name: '9', x: 0, y: 0, w: 3.4, h: 4.0 }, { name: 'MH', x: 5, y: 5, hole: 1.0, plated: false }],
        outline: { x: 0, y: 0, w: 5, h: 6 },
      },
      pages: [12, 99], notes: 'Exposed pad size from the table',
    }, input);
    expect(r).toMatchObject({ family: 'OTHER', pins: 8, pitch: 1.27, bodyD: { min: 4.95, max: 5.05 }, bodyE: { min: 5.95, max: 6.05 }, height: { min: 0.8, max: 0.8 }, pages: [12] });
    expect(r.land.map((p) => p.name)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '']);
    expect(r.land[3]).toMatchObject({ x: -2.85, y: -1.905 });
    expect(r.land[7]).toMatchObject({ x: 2.85, y: 1.905 });
    // An unplated hole: no name, the pad its size
    expect(r.land[9]).toMatchObject({ hole: 1, w: 1, h: 1, plated: false });
    expect(r.outline).toEqual({ x: 0, y: 0, w: 5, h: 6 });
    expect(PACKAGE.check({ family: 'SON', body: { length: [2, 2] } }, input).family).toBe('SON');
    // Names like A1 … A12 count on
    expect(PACKAGE.check({ family: 'OTHER', landPattern: { rows: [{ first: 'A1', count: 3, pitch: 0.5, direction: 'right', x: 0, y: 0, w: 0.3, h: 1 }] } }, input).land.map((p) => p.name)).toEqual(['A1', 'A2', 'A3']);
    expect(() => PACKAGE.check({ family: 'SOIC', notes: 'unreadable' }, input)).toThrow(/Nothing could be read/);
    expect(PACKAGE.check({ family: 'SOIC', body: { length: [4.8, 5] } }, PACKAGE.blank).pins).toBe(0);
    expect(packageKey(variant)).toBe('SOP8_150mil-8');
  });
});

/* ─── Footprints from what was read ───────────────────────────────────────────────────── */

describe('footprints from a package read', () => {
  it('worked out by IPC-7351B from the dimensions: the same as the IPC wizard\'s', () => {
    const b = buildFootprint(blankRead, { source: 'calc', name: '' });
    const wizard = ipcFootprint({ ...ipcDefaults('SOIC'), ...specOf(blankRead).spec });
    expect(b.fp.name).toBe('SOIC127P600X175-8N');
    expect(b.fp.pads).toEqual(wizard.pads);
    expect(padsOf(b.records)).toHaveLength(8);
    expect(b.checks.filter((c) => c.level !== 'note')).toEqual([]);
    // What the drawing didn't give: the family's typical values, said so
    const thin = buildFootprint({ ...blankRead, height: null, term: null }, { source: 'calc', name: 'X' });
    expect(thin.checks[0]).toMatchObject({ level: 'warning', text: expect.stringMatching(/foot length, height/) });
    expect(calcMissing({ ...blankRead, term: null })).toEqual(['foot length']);
    expect(calcMissing({ ...blankRead, family: 'OTHER' })).toHaveLength(1);
  });
  it('SOJ: J-leads in two rows (IPC-7351B\'s J-lead fillets)', () => {
    const r: PackageRead = { ...blankRead, family: 'SOJ', pins: 36, bodyD: { min: 23.37, max: 23.62 }, bodyE: { min: 10.03, max: 10.29 }, span: { min: 11.05, max: 11.3 }, term: { min: 0.6, max: 1.0 }, leadW: { min: 0.38, max: 0.51 }, height: { min: 3.5, max: 3.76 } };
    const b = buildFootprint(r, { source: 'calc', name: '' });
    expect(b.fp.name).toBe('SOJ127P1118X376-36N');
    expect(b.fp.pads).toHaveLength(36);
    // A J-lead's land reaches in under the body (heel) more than out (toe)
    const p1 = b.fp.pads[0]!;
    expect(p1.x - p1.w / 2).toBeGreaterThan(-11.3 / 2 - 0.5);
  });
  it('QFN: the exposed pad by D2 × E2, numbered after the pins', () => {
    const r: PackageRead = { ...blankRead, family: 'QFN', pins: 16, pinsSide: 4, pitch: 0.5, bodyD: { min: 2.9, max: 3.1 }, bodyE: { min: 2.9, max: 3.1 }, span: null, term: { min: 0.3, max: 0.5 }, leadW: { min: 0.18, max: 0.3 }, height: { min: 0.8, max: 0.9 }, tab: { w: { min: 1.6, max: 1.8 }, l: { min: 1.6, max: 1.8 } } };
    const b = buildFootprint(r, { source: 'calc', name: '' });
    expect(b.fp.pads).toHaveLength(17);
    expect(b.fp.pads[16]).toMatchObject({ name: '17', x: 0, y: 0, w: 1.7, h: 1.7 });
  });
  it('the datasheet\'s own land pattern: centred, its holes through all layers (slots, unplated ones), the outline drawn with it', () => {
    const r: PackageRead = {
      ...blankRead, family: 'OTHER', pins: 4, pitch: 0.5, bodyD: null, bodyE: null, span: null, term: null, leadW: null, height: { min: 3.16, max: 3.16 },
      land: [
        ...[0, 1, 2, 3].map((k) => ({ name: `A${k + 1}`, x: 1 + k * 0.5, y: 3, w: 0.3, h: 1.1, shape: 'rect' as const, hole: 0, slot: 0, plated: true })),
        { name: 'SH', x: -1, y: 2, w: 1.0, h: 2.0, shape: 'round', hole: 0.6, slot: 1.6, plated: true },
        { name: 'SH', x: 5.5, y: 2, w: 1.0, h: 2.0, shape: 'round', hole: 0.6, slot: 1.6, plated: true },
        { name: '', x: 0, y: 1, w: 0.55, h: 0.55, shape: 'round', hole: 0.55, slot: 0, plated: false },
      ],
      outline: { x: 2.25, y: 0, w: 8.9, h: 7.3 },
    };
    const b = buildFootprint(r, { source: 'datasheet', name: 'USB_C_TEST' });
    // Centred on the pads' middle: x from −1.5 to 6.0 → shifted by 2.25
    expect(b.fp.pads[0]).toMatchObject({ x: -1.25 });
    expect(b.fp.body).toMatchObject({ w: 8.9, h: 7.3, x: 0 });
    const pads = padsOf(b.records);
    const smd = pads.filter((p) => p.layer === L.TOP), th = pads.filter((p) => p.layer === L.MULTI);
    expect(smd).toHaveLength(4);
    expect(th).toHaveLength(3);
    const shell = th.find((p) => p.name === 'SH')!;
    expect(shell.hole).toBe(mm(0.6));
    expect(shell.slot).toMatchObject({ length: mm(1.6), rotation: 90 });
    expect(th.find((p) => !p.name)!.plated).toBe(false);
    expect(b.checks.map((c) => c.text)).toContain('Pads sharing a name: SH (shield or mounting pads)');
    expect(b.checks.some((c) => /numbered pads for/.test(c.text))).toBe(false); // A1–A4: SH is the shield's
    // The courtyard round pads and body, off the origin when they are
    expect(b.fp.courtyard.w).toBeGreaterThan(8.9);
  });
  it('DIP: through-hole pads by IPC-7251, pin 1 square', () => {
    const r: PackageRead = { ...blankRead, family: 'DIP', pins: 8, pitch: 2.54, span: { min: 7.62, max: 7.62 }, leadW: { min: 0.36, max: 0.56 }, bodyD: { min: 9.0, max: 9.5 }, bodyE: { min: 6.1, max: 6.6 }, height: { min: 5.33, max: 5.33 } };
    const b = buildFootprint(r, { source: 'calc', name: 'DIP8' });
    const pads = padsOf(b.records);
    expect(pads).toHaveLength(8);
    expect(pads.every((p) => p.layer === L.MULTI && p.hole === mm(0.9) && p.plated)).toBe(true);
    expect(pads[0]!.top.shape).not.toBe(pads[1]!.top.shape);
    expect(b.fp.pads[0]).toMatchObject({ x: -3.81, y: 3.81 });
    expect(b.fp.pads[4]).toMatchObject({ name: '5', x: 3.81, y: -3.81 });
  });
  it('checks: overlapping pads, a land pattern off the pitch, unconverted inches, the standard package', () => {
    const land = [0, 1, 2, 3].map((k) => ({ name: String(k + 1), x: 0, y: k * 0.8, w: 0.6, h: 0.5, shape: 'rect' as const, hole: 0, slot: 0, plated: true }));
    const r: PackageRead = { ...blankRead, pins: 4, pitch: 0.95, land: [...land, { ...land[3]!, name: '5', x: 0.3 }], standard: true };
    const texts = checkRead(r, r.land.map((p) => ({ ...p }))).map((c) => `${c.level}: ${c.text}`);
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringMatching(/^warning: The datasheet has no drawing/),
      expect.stringMatching(/^warning: 5 numbered pads for 4 pins/),
      expect.stringMatching(/^error: Pads overlap: 4 and 5/),
      expect.stringMatching(/^warning: The land pattern's pads are 0.8 mm apart, the drawing's pitch is 0.95 mm/),
    ]));
    expect(checkRead({ ...blankRead, pitch: 0.05 }, []).map((c) => c.text)).toContain('Pitch 0.05 mm: inches left unconverted?');
  });
  it('a land pattern read the wrong way round: mirrored and turned', () => {
    const r: PackageRead = { ...blankRead, land: [{ name: '1', x: -1, y: 2, w: 0.6, h: 1.5, shape: 'rect', hole: 0, slot: 0, plated: true }], outline: { x: 1, y: 0, w: 4, h: 2 } };
    expect(mirrorLand(r).land[0]).toMatchObject({ x: 1, y: 2 });
    expect(mirrorLand(r).outline).toMatchObject({ x: -1 });
    expect(rotateLand(r).land[0]).toMatchObject({ x: -2, y: -1, w: 1.5, h: 0.6 });
    expect(rotateLand(r).outline).toEqual({ x: -0, y: 1, w: 2, h: 4 });
    expect(footprintName({ package: 'SOP16 (300 mil)' }, r)).toBe('SOP16_300_mil');
  });
  it('the review\'s draft: pads worked out, or by hand when there\'s no family to work them out for', () => {
    const d = newDraft(variant, blankRead);
    expect(d).toMatchObject({ source: 'calc', name: null, packageName: 'SOP8_150mil' });
    expect(draftFootprint(d).built!.fp.name).toBe('SOIC127P600X175-8N');
    expect(draftFootprint({ ...d, name: 'MY_SO8' }).built!.fp.name).toBe('MY_SO8');
    const other = newDraft(variant, { ...blankRead, family: 'OTHER' });
    expect(other.source).toBe('datasheet');
    expect(draftFootprint(other).error).toMatch(/Add Pad/);
    const one = { ...other.read, land: [nextPad(other.read)] };
    expect(one.land[0]).toMatchObject({ name: '1', x: 0, y: 0, w: 1, h: 1 });
    expect(nextPad(one)).toMatchObject({ name: '2', y: -1.27 });
    expect(draftFootprint({ ...other, read: one }).built!.fp.name).toBe('SOP8_150mil');
  });
});

/* ─── The service: the package job ───────────────────────────────────────────────────── */

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

describe('the Konium AI service: drawings', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '5', DAILY_BUDGET_USD: '1' };
  const MODELS = [
    { id: '~x-ai/grok-latest', name: 'Grok', created: 300, pricing: { prompt: '0.000002', completion: '0.000006' }, architecture: { input_modalities: ['text'] } },
    { id: '~google/gemini-pro-latest', name: 'Gemini', created: 200, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  let store: StoreLogic;
  let chats: { model: string; messages: unknown[] }[];
  let reply = '';
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
    chats.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 5000, completion_tokens: 900, cost: 0.002 } }));
  }) as typeof fetch;
  const post = (path: string, body: object) => new Request(`https://konium.app/api/ai${path}`, { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
  const now = Date.parse('2026-10-31T12:00:00Z');
  const input: PackageInput = { device: 'AB123', variant, pages: [{ page: 12, text: 'Package', drawing: true }], pictures: [{ page: 12, url: PNG }], pageCount: 20 };
  beforeEach(() => { store = new StoreLogic(sqlite()); chats = []; resetModelCache(); });

  it('a job with pictures goes to a model that takes them, whatever was asked for', async () => {
    reply = JSON.stringify({ family: 'SOIC', pins: 8, pitch: 1.27, body: { length: [4.8, 5] } });
    const r = await handle(post('/job', { job: 'package', input, model: '~x-ai/grok-latest' }), env, store, fetchFn, now);
    expect(r.status).toBe(200);
    expect(chats[0]!.model).toBe('~google/gemini-pro-latest');
    expect(JSON.stringify(chats[0]!.messages)).toContain('"type":"image_url"');
    expect((await r.json() as { answer: PackageRead }).answer.family).toBe('SOIC');
  });
  it('an answer its own check turns down comes back raw, for the app to judge by its rules', async () => {
    reply = 'Sorry, the drawing is unreadable.';
    const r = await handle(post('/job', { job: 'package', input }), env, store, fetchFn, now);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ raw: 'Sorry, the drawing is unreadable.', problem: expect.stringMatching(/isn't JSON/), usage: { cost: 0.002 } });
  });
  it('packages accepted are kept for the next reader by datasheet and variant', async () => {
    const key = `${'b'.repeat(64)}:${packageKey(variant)}`;
    const read = PACKAGE.check({ family: 'SOIC', pins: 8, body: { length: [4.8, 5] } }, input);
    // (26.200: kept with the pass the reader's own job gave)
    const mine = await (await handle(post('/job', { job: 'package', input, cacheKey: key, fresh: true }), env, store, fetchFn, now)).json() as { accept: string };
    chats.length = 0;
    expect((await handle(post('/accept', { job: 'package', cacheKey: key, answer: read }), env, store, fetchFn, now)).status).toBe(403);
    expect((await handle(post('/accept', { job: 'package', cacheKey: key, answer: read, pass: mine.accept }), env, store, fetchFn, now)).status).toBe(200);
    const r = await handle(post('/job', { job: 'package', input, cacheKey: key }), env, store, fetchFn, now);
    expect(await r.json()).toMatchObject({ answer: { family: 'SOIC' }, cached: { acceptedBy: 1 } });
    expect(chats).toHaveLength(0);
  });
  it('answers kept under an older version of a job aren\'t served again; the service says which jobs it runs', async () => {
    const key = 'c'.repeat(64);
    const old = { maker: 'X', device: 'Y', description: '', variants: [{ partNumbers: ['Y1'], package: 'SMT', pins: 24, leadForm: 'no-lead' }] };
    // As a service before 26.076 kept it: no version in the key
    store.accept(`survey:${key}`, 'someone', old, now);
    reply = JSON.stringify({ maker: 'X', device: 'Y', variants: [{ partNumbers: ['Y1'], package: 'USB-C receptacle', pins: 24, leadForm: 'other' }] });
    const r = await handle(post('/job', { job: 'survey', input: { pages: [{ page: 1, text: 'Y1' }], pageCount: 1 }, cacheKey: key }), env, store, fetchFn, now);
    expect(await r.json()).toMatchObject({ answer: { variants: [{ package: 'USB-C receptacle' }] } });
    expect(chats).toHaveLength(1);
    const c = await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env, store, fetchFn, now)).json() as { jobs: string[] };
    expect(c.jobs).toEqual(['survey', 'locate', 'package', 'review', 'pins', 'advise', 'board', 'datasheet', 'part', 'ask', 'mpn', 'reqs', 'reqadvise', 'script', 'layout', 'routing', 'ping']);
    expect(serviceRuns(c as never, 'package')).toBe(true);
    expect(serviceRuns({ jobs: ['survey', 'ping'] }, 'package')).toBe(false);
    // A service that doesn't say is tried (an older one answers that it doesn't run the job)
    expect(serviceRuns({}, 'package')).toBe(true);
  });
});

describe('the app with a Konium service older than itself', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('a job the service doesn\'t run yet is said plainly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not a job the service runs' }), { status: 400 })));
    const cfg: AiSettings = { aiMode: 'konium', aiProvider: 'openrouter', aiCustomBase: '', aiLocalBase: '', aiModels: {}, aiShareCache: true };
    const input: PackageInput = { device: 'AB123', variant, pages: [], pictures: [], pageCount: 20 };
    await expect(runJob(PACKAGE, input, { cfg })).rejects.toThrow(NOT_YET);
  });
});

/* ─── Pads measured in the drawing ───────────────────────────────────────────────────── */

describe('pads measured in the land pattern\'s drawing', () => {
  /** A land pattern drawn as datasheets draw them: hatched pad outlines, dimension and extension lines, a frame, labels. */
  function drawing(): Grey {
    const w = 900, h = 600, s = 80, X0 = 450, Y0 = 300;
    const data = new Uint8Array(w * h).fill(255);
    const ink = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) data[Math.round(y) * w + Math.round(x)] = 0; };
    const line = (x0: number, y0: number, x1: number, y1: number, t = 1) => {
      const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
      for (let i = 0; i <= n; i++) for (let a = 0; a < t; a++) for (let b = 0; b < t; b++) ink(x0 + ((x1 - x0) * i) / n + a, y0 + ((y1 - y0) * i) / n + b);
    };
    const pad = (x: number, y: number, pw: number, ph: number) => {
      const l = X0 + (x - pw / 2) * s, r = X0 + (x + pw / 2) * s, t = Y0 - (y + ph / 2) * s, b = Y0 - (y - ph / 2) * s;
      line(l, t, r, t, 3); line(r, t, r, b, 3); line(r, b, l, b, 3); line(l, b, l, t, 3);
      for (let k = -ph * s; k < pw * s; k += 9) line(Math.max(l, l + k), Math.min(b, b - Math.max(0, -k)), Math.min(r, l + k + (b - t)), Math.max(t, b - (Math.min(r, l + k + (b - t)) - l - k)));
    };
    for (let k = 0; k < 6; k++) { pad(-1.25 + 0.5 * k + 0.125, 0.7, 0.3, 0.85); pad(-1.25 + 0.5 * k - 0.125, -0.7, 0.3, 0.85); }
    // Locating holes, a frame, dimension and extension lines, labels
    pad(-2.2, 0, 0.55, 0.55); pad(2.2, 0, 0.55, 0.55);
    line(60, 40, 840, 40); line(840, 40, 840, 560); line(840, 560, 60, 560); line(60, 560, 60, 40);
    line(150, 120, 750, 120); line(X0 + (-1.25 + 0.125 - 0.15) * s, 110, X0 + (-1.25 + 0.125 - 0.15) * s, Y0 - 1.1 * s);
    line(100, Y0 - 1.125 * s, 800, Y0 - 1.125 * s);
    for (let k = 0; k < 6; k++) for (let a = 0; a < 6; a++) line(X0 + (-1.3 + 0.5 * k) * s + a, Y0 - 1.3 * s, X0 + (-1.3 + 0.5 * k) * s + a, Y0 - 1.2 * s);
    return { width: w, height: h, data };
  }
  const pad = (name: string, x: number, y: number, w = 0.3, h = 0.85, hole = 0): PackageRead['land'][number] => ({ name, x, y, w, h, shape: 'rect', hole, slot: 0, plated: hole === 0 });
  // As a model read it: the rows too close, the stagger missed
  const read: PackageRead = { ...blankRead, family: 'OTHER', pins: 12, pitch: 0.5, land: [
    ...[0, 1, 2, 3, 4, 5].map((k) => pad(`A${k + 1}`, -1.25 + 0.5 * k, 0.35)), ...[0, 1, 2, 3, 4, 5].map((k) => pad(`B${6 - k}`, -1.25 + 0.5 * k, -0.35)),
    { ...pad('', -2.1, 0.1, 0.55, 0.55, 0.55), plated: false }, { ...pad('', 2.1, 0.1, 0.55, 0.55, 0.55), plated: false },
  ] };
  it('finds the pads as solids: outlines and hatching filled, lines and the frame left out', () => {
    const found = shapes(drawing());
    const pads = found.filter((b) => Math.abs(b.x1 - b.x0 - 27) < 5 && Math.abs(b.y1 - b.y0 - 71) < 6);
    expect(pads).toHaveLength(12);
    expect(rowsOf(read.land)).toHaveLength(2);
  });
  it('each row placed on its own shapes (the stagger and the rows\' distance come out), single pads on theirs, the read\'s sizes kept', () => {
    const m = measureLand(read, drawing())!;
    expect(m.moved).toBe(14);
    expect(m.scale).toBeCloseTo(80, 0);
    const at = (n: string) => m.read.land.find((p) => p.name === n)!;
    expect(at('A1').x - at('B6').x).toBeCloseTo(0.25, 1);
    expect(at('A1').y - at('B6').y).toBeCloseTo(1.4, 1);
    expect(at('A6').x - at('A1').x).toBeCloseTo(2.5, 5);
    expect(at('A1')).toMatchObject({ w: 0.3, h: 0.85 });
    const holes = m.read.land.filter((p) => !p.name);
    expect(holes[1]!.x - holes[0]!.x).toBeCloseTo(4.4, 1);
    expect(holes[0]!.y - at('B6').y).toBeCloseTo(0.7, 1);
    // A drawing with no row at the read's pitch gives no scale: not measured
    expect(measureLand({ ...read, land: read.land.map((p) => ({ ...p, x: p.x * 3 })) }, { width: 50, height: 50, data: new Uint8Array(2500).fill(255) })).toBeNull();
  });
});

describe('the locate job', () => {
  const input = { device: 'X', variant: { package: 'USB-C', pins: 24 }, pictures: [{ page: 1, url: PNG }, { page: 2, url: PNG }] };
  it('regions in thousandths (or fractions) of the picture; a page not sent, a kind not asked or a sliver left out; its own answer passes again', async () => {
    const { LOCATE } = await import('../src/ai/jobs');
    const r = LOCATE.check({ regions: [
      { page: 2, kind: 'land', left: 560, top: 140, right: 860, bottom: 560 }, { page: 1, kind: 'outline', left: 0.1, top: 0.1, right: 0.5, bottom: 0.6 },
      { page: 3, kind: 'land', left: 0, top: 0, right: 500, bottom: 500 }, { page: 2, kind: 'photo', left: 0, top: 0, right: 500, bottom: 500 }, { page: 2, kind: 'table', left: 100, top: 100, right: 110, bottom: 600 },
    ] }, input);
    expect(r.regions).toEqual([{ page: 2, kind: 'land', box: { x0: 0.56, y0: 0.14, x1: 0.86, y1: 0.56 } }, { page: 1, kind: 'outline', box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.6 } }]);
    expect(LOCATE.check(r, input)).toEqual(r);
    const m = LOCATE.messages(input);
    expect((m[1]!.content as { type: string }[]).filter((p) => p.type === 'image_url')).toHaveLength(2);
  });
});

describe('pins counted as the datasheet counts them', () => {
  it('a shield\'s own names (SH1, SH2) aren\'t pins when the count says so', () => {
    const land = [...[1, 2, 3, 4].map((k) => ({ name: String(k), x: k, y: 0, w: 0.3, h: 1, shape: 'rect' as const, hole: 0, slot: 0, plated: true })),
      { name: 'SH1', x: -2, y: 0, w: 1, h: 2, shape: 'round' as const, hole: 0.6, slot: 1.5, plated: true }, { name: 'SH2', x: 7, y: 0, w: 1, h: 2, shape: 'round' as const, hole: 0.6, slot: 1.5, plated: true }];
    const texts = checkRead({ ...blankRead, family: 'OTHER', pins: 4, pitch: 1, land }, land).map((c) => c.text);
    expect(texts.some((t) => /numbered pads for/.test(t))).toBe(false);
    expect(texts).toContain('SH1, SH2: shield or mounting pads, not counted as pins');
  });
});

describe('the Konium AI service: one frontier model for every job', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '5', DAILY_BUDGET_USD: '5' };
  const MODELS = [
    { id: 'google/gemini-3.5-flash-lite', name: 'Flash-Lite', created: 300, pricing: { prompt: '0.0000003', completion: '0.0000025' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'anthropic/claude-opus-5.5', name: 'Opus', created: 400, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'google/gemini-4-argon', name: 'Argon', created: 410, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'anthropic/claude-fable-5.1', name: 'Fable', created: 420, pricing: { prompt: '0.00001', completion: '0.00005' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'openai/gpt-6-astra-pro', name: 'Astra Pro', created: 430, pricing: { prompt: '0.00001', completion: '0.00005' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', created: 440, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~anthropic/claude-fable-latest', name: '~Anthropic: Claude Fable Latest', created: 441, pricing: { prompt: '0.00001', completion: '0.00005' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~google/gemini-pro-latest', name: 'Google: Gemini Pro Latest', created: 442, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~openai/gpt-astra-pro-latest', name: 'OpenAI: GPT Astra Pro Latest', created: 443, pricing: { prompt: '0.00003', completion: '0.00018' }, architecture: { input_modalities: ['text', 'image'] } },
    { id: '~deepseek/deepseek-pro-latest', name: 'DeepSeek: DeepSeek Pro Latest', created: 444, pricing: { prompt: '0.0000001', completion: '0.000008' }, architecture: { input_modalities: ['text'] } },
    { id: 'openai/gpt-chat-latest', name: 'OpenAI: GPT Chat Latest', created: 445, pricing: { prompt: '0.000005', completion: '0.00003' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  let store: StoreLogic;
  let chats: { model: string; max_tokens: number; reasoning: { effort: string } }[];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
    const b = JSON.parse(String(init!.body));
    chats.push(b);
    const sys = String(b.messages[0].content);
    const ans = sys.startsWith('You read package') ? { family: 'SOIC', pins: 8, body: { length: [4.8, 5] } } : sys.startsWith('You find') ? { regions: [] } : { device: 'X', variants: [{ package: 'SO8', pins: 8 }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ans) } }], usage: { prompt_tokens: 5000, completion_tokens: 900, cost: 0.05 } }));
  }) as typeof fetch;
  const post = (body: object) => new Request('https://konium.app/api/ai/job', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
  const now = Date.parse('2026-11-01T12:00:00Z');
  const pkg: PackageInput = { device: 'AB123', variant, pages: [{ page: 12, text: 'Package', drawing: true }], pictures: [{ page: 12, url: PNG }], pageCount: 20 };
  const survey: SurveyInput = { pages: [{ page: 1, text: 'SO8', drawing: true }], pageCount: 1, pictures: [{ page: 1, url: PNG }] };
  beforeEach(() => { store = new StoreLogic(sqlite()); chats = []; resetModelCache(); });

  it('OpenRouter\'s "latest" aliases of the families offered (26.082: Claude Opus, GPT Sol, Gemini Pro, Gemini Flash; FAMILIES for others), taking pictures, under the price ceiling, the cheapest first (26.083), named without the ~; the first does every job', async () => {
    const config = async (e: AiEnv) => { resetModelCache(); return await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), e, store, fetchFn, now)).json() as { models: { id: string; name: string }[]; defaults: { model: string } }; };
    expect((await config({ ...env, FAMILIES: 'anthropic/claude-fable, deepseek/deepseek-pro' })).models.map((m) => [m.id, m.name])).toEqual([['~anthropic/claude-fable-latest', 'Anthropic: Claude Fable Latest']]);
    const c = await config(env);
    expect(c.models.map((m) => [m.id, m.name])).toEqual([['~google/gemini-pro-latest', 'Google: Gemini Pro Latest'], ['~anthropic/claude-opus-latest', 'Anthropic: Claude Opus Latest']]);
    expect(c.defaults.model).toBe('~google/gemini-pro-latest');
    await handle(post({ job: 'survey', input: survey }), env, store, fetchFn, now);
    await handle(post({ job: 'locate', input: { device: 'X', variant: { package: 'SO8', pins: 8 }, pictures: [{ page: 1, url: PNG }] } }), env, store, fetchFn, now);
    await handle(post({ job: 'package', input: pkg }), env, store, fetchFn, now);
    expect(chats.map((x) => x.model)).toEqual(['~google/gemini-pro-latest', '~google/gemini-pro-latest', '~google/gemini-pro-latest']);
    // The drawing thinks harder
    expect(chats.map((x) => x.reasoning.effort)).toEqual(['low', 'low', 'medium']);
    expect(chats[2]!.max_tokens).toBe(16000);
  });
  it('the model asked for does the job (a version asked for: its family\'s alias); DEFAULT_MODEL names the default (an alias, whatever its price); the price ceiling keeps the dearest out', async () => {
    await handle(post({ job: 'survey', input: survey, model: '~google/gemini-pro-latest' }), env, store, fetchFn, now);
    expect(chats[0]!.model).toBe('~google/gemini-pro-latest');
    // A choice made before 26.080: its family's alias
    await handle(post({ job: 'survey', input: survey, model: 'anthropic/claude-opus-5.5' }), env, store, fetchFn, now);
    expect(chats[1]!.model).toBe('~anthropic/claude-opus-latest');
    await handle(post({ job: 'package', input: pkg }), { ...env, DEFAULT_MODEL: 'anthropic/claude-opus-5.5' }, store, fetchFn, now);
    expect(chats[2]!.model).toBe('~anthropic/claude-opus-latest');
    resetModelCache();
    const c = await (await handle(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), { ...env, MAX_PRICE_OUT: '25' }, store, fetchFn, now)).json() as { models: { id: string }[] };
    expect(c.models.map((m) => m.id)).toEqual(['~google/gemini-pro-latest', '~anthropic/claude-opus-latest']);
    resetModelCache();
    // (the dearest: its job uses many of the day's allowance, 26.099)
    await handle(post({ job: 'package', input: pkg }), { ...env, MAX_PRICE_OUT: '25', DEFAULT_MODEL: '~openai/gpt-astra-pro-latest', JOBS_PER_DAY: '100' }, store, fetchFn, now);
    expect(chats[3]!.model).toBe('~openai/gpt-astra-pro-latest');
  });
});
