import { describe, expect, it } from 'vitest';
import { importSettings, settings } from '../src/core/settings';
import { isEnclosure, readEnclosure } from '../src/formats/enclosureDoc';
import { PropertyBag } from '../src/formats/altium/props';
import { adoptFormerKeys } from '../src/formats/altium/pcbdoc';
import { choiceOf } from '../src/model/activeBom';
import { readStack, readStackFile, stackFile } from '../src/model/pcbStack';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { cells, change, readDrawio, setSheet, writeDrawio } from '../src/formats/drawio';
import { formerNames } from '../src/platform/formerDb';
import { adoptFormer } from '../src/core/storage';
import { FORMERS } from '../src/core/former';

const enc = (s: string) => new TextEncoder().encode(s);
/** The app's names before this one, the most recent first, as files and storage saved under them carry them. */
const NAMES = ['v', 'l'].map((c) => 'konium'.replace('k', 'j').replace('n', c));

describe.each(NAMES.map((n, i) => [i ? 'the name before that' : 'the name just before', n] as const))('Konium Designer reads what was saved under %s', (_, OLD) => {
  const OLD_UP = OLD.toUpperCase();
  it('a settings file: its AI service and the models chosen for it', () => {
    importSettings(JSON.stringify({ [OLD]: 'settings', version: 1, settings: { aiMode: OLD, aiModels: { [`${OLD}:model`]: 'anthropic/claude', 'key:model': 'x' } } }));
    expect(settings.aiMode).toBe('konium');
    expect(settings.aiModels).toEqual({ 'konium:model': 'anthropic/claude', 'key:model': 'x' });
  });

  it('an enclosure document', () => {
    const b = enc(`{\n  "${OLD}Enclosure": 2,\n  "spec": { "board": "B.PcbDoc", "wall": 2.5 }\n}\n`);
    expect(isEnclosure(b)).toBe(true);
    expect(readEnclosure(b, 'B.Enclosure').spec.wall).toBe(2.5);
  });

  it('a board\'s own keys (the sheet, grids, guides …) taken over under the present name', () => {
    const bag = PropertyBag.fromEntries([['RECORD', 'Board'], [`${OLD_UP}SHEETLINKED`, '13,15'], [`${OLD_UP}GRID0`, 'abc'], ['KONIUMGUIDE0', 'kept']]);
    adoptFormerKeys(bag);
    expect(bag.get('KONIUMSHEETLINKED')).toBe('13,15');
    expect(bag.get('KONIUMGRID0')).toBe('abc');
    expect(bag.get('KONIUMGUIDE0')).toBe('kept');
    expect(bag.keys().some((k) => k.startsWith(OLD_UP))).toBe(false);
  });

  it('a BOM part choice\'s library, a layer stack file and a diagram block\'s linked sheet', () => {
    expect(choiceOf(PropertyBag.fromEntries([['MANUFACTURER', 'TI'], [`${OLD_UP}JLCLIBRARY`, 'Basic']])).library).toBe('Basic');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const file = JSON.parse(stackFile(readStack(doc.board.bag!, doc.board.copperStack), 1)) as Record<string, unknown>;
    delete file.konium; file[OLD] = 'layerStack';
    expect(typeof readStackFile(JSON.stringify(file))).not.toBe('string');
    const xml = `<mxfile><diagram id="d" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><UserObject label="MCU" ${OLD}Sheet="MCU.SchDoc" id="m"><mxCell style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry" /></mxCell></UserObject></root></mxGraphModel></diagram></mxfile>`;
    const d = readDrawio(enc(xml), 'B.drawio');
    expect(cells(d.pages[0]!).find((c) => c.id === 'm')!.sheet).toBe('MCU.SchDoc');
    // Linked again: saved under the present name, the earlier one gone
    change(d, 'Link', () => setSheet(d.pages[0]!, 'm', 'Main.SchDoc'), d.pages[0]!);
    const out = new TextDecoder().decode(writeDrawio(d));
    expect(out).toContain('koniumSheet="Main.SchDoc"');
    expect(out).not.toContain(`${OLD}Sheet`);
  });

  it('browser storage under the earlier name: moved over, the earlier keys gone; a value already under the present name kept', () => {
    const m = new Map<string, string>([[`${OLD}.widths`, 'a'], [`${OLD}.ai`, 'earlier'], ['konium.ai', 'present'], ['other', 'x']]);
    withStorage(m, adoptFormer);
    expect(Object.fromEntries(m)).toEqual({ 'konium.widths': 'a', 'konium.ai': 'present', other: 'x' });
  });

  it('the earlier name is written nowhere: not in the source, the site and its pictures, the demo, the documentation or the Workers', async () => {
    const nodeMod = (n: string) => import(/* @vite-ignore */ n) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { existsSync, readdirSync, readFileSync, statSync } = await nodeMod('node:fs'), { join } = await nodeMod('node:path'), { fileURLToPath } = await nodeMod('node:url');
    const root: string = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''), found: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir) as string[]) {
        if (['node_modules', '.git', 'dist', '.scratch', 'harness', '__pycache__'].includes(n)) continue;
        const p: string = join(dir, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (readFileSync(p, 'latin1').toLowerCase().includes(OLD)) found.push(p.slice(root.length + 1));
      }
    };
    // (site/, the built website, is kept only where the builds are made: not in the public source)
    for (const d of ['src', 'public', 'site', 'website', 'tests', 'docs', 'cloudflare', 'demo']) if (existsSync(join(root, d))) walk(join(root, d));
    for (const f of ['index.html', 'README.md', 'UNRELEASED.md', 'package.json', 'vite.config.ts']) if (readFileSync(join(root, f), 'latin1').toLowerCase().includes(OLD)) found.push(f);
    expect(found).toEqual([]);
  }, 30_000);

});

function withStorage(m: Map<string, string>, run: () => void): void {
  const st = { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  const g = globalThis as Record<string, unknown>, was = g.localStorage;
  g.localStorage = st;
  try { run(); } finally { g.localStorage = was; }
}

describe('Both earlier names at once', () => {
  const [A, B] = NAMES as [string, string];
  it('are made from the present name, the most recent first', () => {
    expect(FORMERS).toEqual(NAMES);
  });

  it('storage: the most recent name\'s value taken, both earlier ones gone', () => {
    const m = new Map<string, string>([[`${B}.x`, 'older'], [`${A}.x`, 'recent'], [`${B}.y`, 'only older']]);
    withStorage(m, adoptFormer);
    expect(Object.fromEntries(m)).toEqual({ 'konium.x': 'recent', 'konium.y': 'only older' });
  });

  it('a board\'s keys: the most recent name\'s taken', () => {
    const bag = PropertyBag.fromEntries([['RECORD', 'Board'], [`${B.toUpperCase()}GRID0`, 'older'], [`${A.toUpperCase()}GRID0`, 'recent']]);
    adoptFormerKeys(bag);
    expect(bag.get('KONIUMGRID0')).toBe('recent');
    expect(bag.keys().filter((k) => k.endsWith('GRID0'))).toEqual(['KONIUMGRID0']);
  });

  it('a settings file under the older name, its AI service under the more recent one', () => {
    importSettings(JSON.stringify({ [B]: 'settings', version: 1, settings: { aiMode: A, aiModels: { [`${A}:model`]: 'recent', [`${B}:model`]: 'older' } } }));
    expect(settings.aiMode).toBe('konium');
    expect(settings.aiModels).toEqual({ 'konium:model': 'recent' });
  });

  it('the browser\'s databases: each one\'s earlier names, the most recent first', () => {
    expect(formerNames('konium-backup')).toEqual([`${A}-backup`, `${B}-backup`]);
    expect(formerNames('konium')).toEqual(NAMES);
    expect(formerNames('elsewhere')).toEqual([]);
  });
});
