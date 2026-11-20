import { describe, expect, it } from 'vitest';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readSchLib } from '../src/formats/altium/schlib';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { demoSchLib } from '../src/formats/synthetic/demoLib';
import { bagOf, type SchDocument } from '../src/model/sch';
import { replaceBags } from '../src/model/schEdit';
import { identity, transformBag, withChildren } from '../src/model/schTransform';
import { applyPartUpdates, updatedPart } from '../src/model/schUpdate';

const lib = readSchLib(demoSchLib(), 'Demo.SchLib');
const sym = (ref: string) => lib.symbols.find((s) => s.libRef === ref)!;
const part = (d: SchDocument, des: string) => d.objects.find((o) => o.kind === 'component' && o.designator === des)!;
const pins = (d: SchDocument, des: string) => d.objects.filter((o) => o.kind === 'pin' && o.owner === part(d, des).index)
  .map((o) => (o.kind === 'pin' ? `${o.designator}@${o.at.x / 100_000},${o.at.y / 100_000}/${o.orient}` : '')).sort();

describe('update from library', () => {
  it('same symbol, turned and mirrored part: pins land where they were; designator, unique id and footprint kept', () => {
    const d = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const u1 = part(d, 'U1');
    // Turn U1 a quarter and mirror it about its location, as Space and X would
    const at = { x: u1.kind === 'component' ? u1.at.x : 0, y: u1.kind === 'component' ? u1.at.y : 0 };
    const x = { ...identity(at), quarter: 1, mirrorX: true };
    replaceBags(d, withChildren(d, [u1.index]).map((i) => ({ index: i, before: bagOf(d, d.objects[i]!)!.clone(), after: transformBag(bagOf(d, d.objects[i]!)!, x) }))).apply();
    const before = pins(d, 'U1');
    const uid = bagOf(d, part(d, 'U1'))!.get('UNIQUEID');
    const r = updatedPart(d, part(d, 'U1').index, sym('LDO SOT-223'), 'Demo.SchLib')!;
    const n = d.objects.length, impls = d.objects.filter((o) => o.record === 45).length;
    const ch = applyPartUpdates(d, [r]);
    ch.apply();
    expect(pins(d, 'U1')).toEqual(before);
    const b = bagOf(d, part(d, 'U1'))!;
    expect([b.get('UNIQUEID'), b.int('ORIENTATION'), b.bool('ISMIRRORED'), b.get('SOURCELIBRARYNAME')]).toEqual([uid, 1, true, 'Demo.SchLib']);
    // Parameters: the part's Comment value gives way to the library's ("update")
    const comment = d.objects.find((o) => o.owner === part(d, 'U1').index && o.kind === 'text' && o.role === 'parameter');
    expect(comment && comment.kind === 'text' ? comment.text : '').toBe('LDO 3V3');
    expect(d.objects.filter((o) => o.record === 45).length).toBe(impls);
    ch.revert();
    expect(d.objects.length).toBe(n);
    expect(pins(d, 'U1')).toEqual(before);
  });

  it('Choose: a different symbol takes the part over, designator and placement kept', () => {
    const d = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const r = updatedPart(d, part(d, 'C1').index, sym('Res'), 'Demo.SchLib', { graphics: true, parameters: 'replace', models: true })!;
    applyPartUpdates(d, [r]).apply();
    const c1 = part(d, 'C1');
    expect(c1.kind === 'component' && c1.libRef).toBe('Res');
    expect(pins(d, 'C1')).toEqual(['1@250,410/1', '2@250,390/3']);
    const kids = d.objects.filter((o) => o.owner === c1.index && o.kind === 'text').map((o) => (o.kind === 'text' ? `${o.role}:${o.text}` : ''));
    expect(kids).toEqual(['designator:C1', 'parameter:1k']);
  });
});

import { libraryCsv, pcbLibRuleCheck, ruleCheckReport, schComponentReport, schLibRuleCheck, PCB_CHECK_ALL, SCH_CHECK_ALL } from '../src/model/libCheck';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { demoPcbLib } from '../src/formats/synthetic/demo';

describe('library reports', () => {
  it('Component Rule Check: duplicates and missing items, Altium layout', () => {
    const syms = [...lib.symbols, lib.symbols[0]!];
    const rows = schLibRuleCheck(syms, { ...SCH_CHECK_ALL, missingFootprint: true, missingPinsInSequence: true });
    expect(rows.find((r) => r.name === 'Res')?.errors).toEqual(['Duplicate Component Name']);
    expect(rows.find((r) => r.name === 'LM358')?.errors).toEqual(['Missing Footprint']);
    const text = ruleCheckReport('Demo.SchLib', rows);
    expect(text.split('\r\n')[0]).toBe('Component Rule Check Report for : Demo.SchLib');
    expect(text).toContain('( Duplicate Component Name )');
  });
  it('Component report lists each part with its pins; CSV quotes', () => {
    const t = schComponentReport(sym('LM358'));
    expect(t).toContain('Component Name : LM358');
    expect(t).toContain('Part : U?A');
    expect(t).toContain('Part : U?B');
    expect(libraryCsv([{ name: 'A"B', description: 'x, y' }])).toBe('Name,Description\r\n"A""B","x, y"\r\n');
  });
  it('PCB Component Rule Check finds nothing wrong in the demo footprints', () => {
    const pl = readPcbLib(demoPcbLib(), 'Demo.PcbLib');
    expect(pcbLibRuleCheck(pl.footprints, PCB_CHECK_ALL)).toEqual([]);
    expect(pcbLibRuleCheck([...pl.footprints, pl.footprints[0]!], PCB_CHECK_ALL).map((r) => r.errors[0])).toEqual(['Duplicate Footprint Name', 'Duplicate Footprint Name']);
  });
});
