import { afterEach, describe, expect, it, vi } from 'vitest';
import { breathe } from '../src/core/breathe';

const SRC = import.meta.glob(['../src/app/*Run.ts', '../src/model/autoroute.ts', '../src/model/autoPlace.ts', '../src/formats/**/import.ts', '../src/formats/importers.ts', '../src/formats/cadenceImport.ts', '../src/formats/kicad/project.ts'],
  { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

afterEach(() => { vi.useRealTimers(); delete (globalThis as { document?: unknown }).document; });

describe('A pause in long work that a hidden tab does not hold back (26.180)', () => {
  it('outside a browser it is a timer, as it was', async () => {
    let done = false;
    const p = breathe().then(() => { done = true; });
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  it('in a browser it is a message: it comes round with every timer stopped, each pause in its turn', async () => {
    (globalThis as { document?: unknown }).document = {};
    vi.useFakeTimers();   // a timer would never fire now
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => breathe().then(() => { order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
    // Many in a row, as a run's slices are
    let n = 0;
    for (let i = 0; i < 200; i++) { await breathe(); n++; }
    expect(n).toBe(200);
  });

  it('the long jobs pause with it: the analyses, the autorouter and placement, the imports', () => {
    const files = Object.keys(SRC);
    for (const want of ['antennaRun', 'thermalRun', 'powerRun', 'pdnRun', 'siRun', 'autoroute', 'autoPlace', 'importers', 'kicad/project', 'eagle/import', 'diptrace/import', 'easyeda/import', 'edif/import', 'cadenceImport']) {
      const f = files.find((k) => k.includes(want));
      expect(f, want).toBeDefined();
      expect(SRC[f!], want).toContain("core/breathe'");
      expect(SRC[f!], want).not.toMatch(/setTimeout\(r, 0\)/);
    }
  });
});
