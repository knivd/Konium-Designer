/** 26.070: EDIF schematics written — the Export Wizard's EDIF Schematic, read back by Konium's own EDIF import. */
import { describe, expect, it } from 'vitest';
import { demoFiles } from '../src/formats/synthetic/demo';
import { load } from '../src/formats/registry';
import { compileProject } from '../src/model/compile';
import { edifSchematic, edifString, exportEdif } from '../src/formats/edif/write';
import { importEdif } from '../src/formats/edif/import';
import { readEdif } from '../src/formats/edif/read';
import { EXPORTERS } from '../src/formats/exporters';
import { readSchLib } from '../src/formats/altium/schlib';
import { DIR_VECTORS, type SchDocument, type SchObject } from '../src/model/sch';
import { identity, transformBag, withChildren } from '../src/model/schTransform';
import { replaceBags } from '../src/model/schEdit';

const files = demoFiles();
const sheetsOf = () => files.filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: load(f.bytes, f.name) as SchDocument }));
const project = (sheets: { name: string; doc: SchDocument }[]) => ({ name: 'Demo', sheets, schLibs: [], pcbLibs: [], hierarchyMode: 0, variables: [] });
const groups = (sheets: { name: string; doc: SchDocument }[], scope: number) =>
  new Set(compileProject(sheets, { scope }).nets.filter((n) => n.pins.length).map((n) => n.pins.map((q) => `${q.designator}-${q.pin}`).sort().join(' ')));
/** Every shown pin's outer end, by part and number (mil). */
const pinEnds = (sheets: { doc: SchDocument }[]) => new Map(sheets.flatMap(({ doc }) => doc.objects.filter((o): o is SchObject & { kind: 'pin' } => o.kind === 'pin' && !o.hidden).flatMap((p) => {
  const c = doc.objects[p.owner];
  if (c?.kind !== 'component' || (p.ownerPartId > 0 && p.ownerPartId !== c.partId)) return [];
  const d = DIR_VECTORS[p.orient & 3]!;
  return [[`${c.designator}-${p.designator}`, `${Math.round((p.at.x + d.x * p.length) / 1e4)},${Math.round((p.at.y + d.y * p.length) / 1e4)}`] as [string, string]];
})));
const back = async (text: string) => {
  const r = await importEdif([{ path: 'Demo.edf', bytes: new TextEncoder().encode(text) }]);
  const p = r.projects[0]!;
  return { sheets: p.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: load(d.bytes, d.name) as SchDocument })), lib: p.documents.find((d) => /\.schlib$/i.test(d.name))!, messages: r.messages };
};

describe('EDIF schematic export', () => {
  it('the demo project: a page per sheet, its nets joined across the pages by name — read back, the same connections', async () => {
    const sheets = sheetsOf();
    const r = edifSchematic(project(sheets));
    expect(r.stats.pages).toBe(3);
    const doc = readEdif(r.text);
    expect([...doc.libraries.keys()]).toEqual(['symbols', 'power', 'designs']);
    expect(doc.design).toEqual({ cell: 'demo', lib: 'designs' });
    const b = await back(r.text);
    expect(b.sheets.length).toBe(3);
    expect(groups(b.sheets, 3)).toEqual(groups(sheets, 0));
    // No net labels added at pins: every pin is on a wire or a power symbol
    expect(b.messages.some((m) => /no wire drawn reaches/.test(m.message))).toBe(false);
    // The parts come back where they were, their pins' ends on the same points
    expect(pinEnds(b.sheets)).toEqual(pinEnds(sheets));
  });

  it('turned and mirrored parts: EDIF\'s orientation (R90 … MYR90) and back to AD\'s', async () => {
    const sheets = sheetsOf();
    const doc = sheets[0]!.doc;
    for (const [des, quarter, mirror] of [['R1', 1, true], ['C2', 2, false], ['D1', 3, true], ['C1', 0, true]] as const) {
      const c = doc.objects.find((o) => o.kind === 'component' && o.designator === des)! as SchObject & { kind: 'component' };
      const x = { ...identity(c.at), quarter, mirrorX: mirror };
      replaceBags(doc, withChildren(doc, [c.index]).map((i) => ({ index: i, before: doc.records[i + 1]!.bag!.clone(), after: transformBag(doc.records[i + 1]!.bag!, x) }))).apply();
    }
    const want = new Map(doc.objects.filter((o): o is SchObject & { kind: 'component' } => o.kind === 'component').map((c) => [c.designator, `${c.orient & 3}${c.mirrored ? 'M' : ''}`]));
    expect(want.get('R1')).toBe('1M');
    const r = edifSchematic(project(sheets));
    expect(r.text).toMatch(/\(orientation MYR90\)|\(orientation MXR90\)/);
    const b = await back(r.text);
    const got = new Map(b.sheets[0]!.doc.objects.filter((o): o is SchObject & { kind: 'component' } => o.kind === 'component').map((c) => [c.designator, `${c.orient & 3}${c.mirrored ? 'M' : ''}`]));
    expect(got).toEqual(want);
    expect(pinEnds([b.sheets[0]!])).toEqual(pinEnds([{ doc }]));
  });

  it('names: renames for what EDIF can\'t take, %nn% for characters, ports and off-sheet connectors as off-page connectors', () => {
    const r = edifSchematic(project(sheetsOf()));
    expect(r.text).toMatch(/\(net \(rename &_3V3 "\+3V3"\)/);
    expect(r.text).toContain('"10%181%F"');
    expect(r.text).toMatch(/\(contents\n\s+\(offPageConnector /);
    expect(edifString('a "b" 50%')).toBe('"a %34%b%34% 50%37%"');
    // Every list closed
    let depth = 0;
    for (const ch of r.text.replace(/"[^"]*"/g, '')) { if (ch === '(') depth++; else if (ch === ')') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
  });

  it('the Export Wizard\'s type; a schematic library as a library of its own', () => {
    expect(EXPORTERS.map((e) => e.id)).toContain('edif');
    const lib = readSchLib(files.find((f) => /\.schlib$/i.test(f.name))!.bytes, 'Demo.SchLib');
    const r = exportEdif({ name: 'Demo', sheets: [], schLibs: [{ name: 'Demo.SchLib', symbols: lib.symbols.map((s) => ({ libRef: s.libRef, bags: s.bags })), fonts: [], systemFont: 1 }], pcbLibs: [], hierarchyMode: 0, variables: [] });
    expect(r.files.map((f) => f.path)).toEqual(['Demo/Demo.edf']);
    const doc = readEdif(new TextDecoder().decode(r.files[0]!.bytes));
    const l = doc.libraries.get('demo')!;
    expect(l.cells.size).toBeGreaterThanOrEqual(lib.symbols.length);
    const cell = [...l.cells.values()][0]!;
    expect(cell.views[0]!.symbol!.pins.size).toBe(cell.views[0]!.ports.length);
  });
});
