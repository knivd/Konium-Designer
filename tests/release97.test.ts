import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURES, FEATURE_COMMANDS, STAGE } from '../src/core/release';

const RAW = import.meta.glob(['../docs/RELEASES.md', '../index.html', '../public/llms.txt', '../website/site.mjs'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const readFileSync = (f: string, _enc: 'utf8') => RAW[`../${f}`]!;

const load = async (search: string, stored: string | null = null) => {
  vi.resetModules();
  vi.stubGlobal('location', { search });
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'konium.features' ? stored : null) });
  return import('../src/core/release');
};

describe('release stages (26.097)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('switches on only the features of this release and earlier in a browser', async () => {
    const r = await load('?debug');
    for (const [f, { stage }] of Object.entries(FEATURES)) expect(r.featureOn(f as keyof typeof FEATURES)).toBe(stage <= STAGE);
    expect(r.plannedFeature('file.newDiagram')).toBe(STAGE < 4 ? 'diagrams' : null);
    expect(r.plannedFeature('file.save')).toBeNull();
  });

  it('switches everything on with ?features=all, localStorage, or outside a browser', async () => {
    expect((await load('?debug&features=all')).featureOn('enclosure')).toBe(true);
    expect((await load('', 'all')).featureOn('si')).toBe(true);
    vi.unstubAllGlobals(); vi.resetModules();
    expect((await import('../src/core/release')).featureOn('diagrams')).toBe(true);
  });

  it('every command it gates belongs to a feature of a later stage, and each later stage has its release text', () => {
    for (const f of Object.values(FEATURE_COMMANDS)) expect(FEATURES[f]).toBeDefined();
    const doc = readFileSync('docs/RELEASES.md', 'utf8');
    for (const s of new Set(Object.values(FEATURES).map((f) => f.stage))) if (s > STAGE) expect(doc).toContain(`## R${s} (STAGE = ${s})`);
  });

  it("the site lists only what is switched on", () => {
    const site = readFileSync('index.html', 'utf8') + readFileSync('public/llms.txt', 'utf8') + readFileSync('website/site.mjs', 'utf8');
    for (const f of Object.values(FEATURES)) if (f.stage > STAGE) expect(site).not.toContain(`${f.name}:`);
  });
});
