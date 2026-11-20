import { describe, expect, it } from 'vitest';
import { blankReq, cleanPrefix, depthOf, idOf, isReq, loops, matches, mergeLinks, nextId, normaliseRequirements, numberOf, sameLink, sectionsOf, tally, type Requirement } from '../src/model/requirements';
import { isReqDoc, newReqDoc, readReqDoc, writeReqDoc } from '../src/formats/reqDoc';
import { detect, load, save } from '../src/formats/registry';

const req = (id: string, p: Partial<Requirement> = {}): Requirement => ({ ...blankReq(id), ...p });

describe('Requirements (R6): the model', () => {
  it('identifiers: the prefix and a number of three digits at least; the next one after the highest in the project', () => {
    expect(idOf('REQ', 7)).toBe('REQ-007');
    expect(idOf('PWR', 1234)).toBe('PWR-1234');
    expect(numberOf('REQ-042')).toBe(42);
    expect(nextId('REQ', [req('REQ-001'), req('REQ-009'), req('PWR-050'), req('REQ-003')])).toBe('REQ-010');
    expect(nextId('PWR', [req('REQ-001'), req('PWR-050')])).toBe('PWR-051');
    expect(nextId('REQ', [])).toBe('REQ-001');
    expect(cleanPrefix(' sys req!')).toBe('SYSREQ');
    expect(cleanPrefix('pwr-')).toBe('PWR');
    expect(cleanPrefix('')).toBe('REQ');
  });

  it('read leniently: defaults filled in, values out of range replaced, identifiers made unique, a parent that would loop dropped', () => {
    const r = normaliseRequirements({ prefix: 'req', rows: [
      { kind: 'section', title: 'Power' },
      { kind: 'req', id: 'REQ-001', title: 'Runs from USB', type: 'electrical', priority: 'urgent', status: 'approved', verify: { method: 'test', state: 'verified', note: 'bench' } },
      { kind: 'req', id: 'REQ-001', title: 'A duplicate' },
      { kind: 'req', title: 'No identifier' },
      { kind: 'req', id: 'REQ-010', parent: 'REQ-011' },
      { kind: 'req', id: 'REQ-011', parent: 'REQ-010' },
      { kind: 'req', id: 'REQ-012', parent: 'REQ-012' },
      'nonsense',
    ] as never });
    const reqs = r.rows.filter(isReq);
    expect(r.prefix).toBe('REQ');
    expect(r.rows[0]).toEqual({ kind: 'section', title: 'Power' });
    expect(reqs[0]).toMatchObject({ id: 'REQ-001', type: 'electrical', priority: 'must', status: 'approved', verify: { method: 'test', state: 'verified', note: 'bench' } });
    expect(new Set(reqs.map((x) => x.id)).size).toBe(reqs.length);
    expect(reqs[1]!.title).toBe('A duplicate');
    expect(reqs[1]!.id).not.toBe('REQ-001');
    // Of the two that are each other's parent, one keeps its parent and the other loses it; a requirement isn't its own parent
    const a = reqs.find((x) => x.id === 'REQ-010')!, b = reqs.find((x) => x.id === 'REQ-011')!;
    expect([a.parent, b.parent].filter(Boolean)).toHaveLength(1);
    expect(reqs.find((x) => x.id === 'REQ-012')!.parent).toBeUndefined();
    expect(r.rows).toHaveLength(7);
  });

  it('parents: loops found, depth counted; sections given to the rows under them', () => {
    const all = [req('A'), req('B', { parent: 'A' }), req('C', { parent: 'B' })];
    expect(loops(all, 'A', 'C')).toBe(true);
    expect(loops(all, 'C', 'A')).toBe(false);
    expect(loops(all, 'A', 'A')).toBe(true);
    const by = new Map(all.map((x) => [x.id, x]));
    expect(all.map((x) => depthOf(by, x))).toEqual([0, 1, 2]);
    expect(sectionsOf([req('X'), { kind: 'section', title: 'S1' }, req('Y'), { kind: 'section', title: 'S2' }, req('Z')])).toEqual(['', 'S1', 'S1', 'S2', 'S2']);
  });

  it('counted (the obsolete left out) and searched (every word, in the identifier, title, text or note)', () => {
    const rs = [
      req('R1', { status: 'approved', verify: { method: 'test', state: 'verified', note: '' } }),
      req('R2', { verify: { method: 'analysis', state: 'failed', note: 'too hot at 70 °C' } }),
      req('R3', { verify: { method: 'review', state: 'waived', note: '' } }),
      req('R4'),
      req('R5', { status: 'obsolete', verify: { method: 'test', state: 'verified', note: '' } }),
    ];
    expect(tally(rs)).toEqual({ all: 4, approved: 1, verified: 2, failed: 1, open: 1 });
    expect(matches(req('REQ-004', { title: 'Battery life', text: 'At least 8 hours of use' }), 'battery hours')).toBe(true);
    expect(matches(req('REQ-004', { title: 'Battery life' }), 'battery weight')).toBe(false);
    expect(matches(rs[1]!, 'HOT')).toBe(true);
    expect(matches(rs[1]!, 'r2')).toBe(true);
  });
});

describe('Requirements (R6): links to the design', () => {
  it('put together each once, in order: parts (numbers in order), nets, documents (any case), the board', () => {
    const got = mergeLinks([{ kind: 'part', ref: 'R10' }, { kind: 'board', ref: 'B.PcbDoc' }], [{ kind: 'net', ref: 'VCC' }, { kind: 'part', ref: 'R2' }, { kind: 'part', ref: 'R10' }, { kind: 'sheet', ref: 'Power.SchDoc' }, { kind: 'sheet', ref: 'power.schdoc' }, { kind: 'part', ref: '  ' }]);
    expect(got).toEqual([{ kind: 'part', ref: 'R2' }, { kind: 'part', ref: 'R10' }, { kind: 'net', ref: 'VCC' }, { kind: 'sheet', ref: 'power.schdoc' }, { kind: 'board', ref: 'B.PcbDoc' }]);
    expect(sameLink({ kind: 'sheet', ref: 'A.SchDoc' }, { kind: 'sheet', ref: 'a.schdoc' })).toBe(true);
    expect(sameLink({ kind: 'part', ref: 'R1' }, { kind: 'part', ref: 'r1' })).toBe(false);
    expect(sameLink({ kind: 'part', ref: 'VCC' }, { kind: 'net', ref: 'VCC' })).toBe(false);
  });

  it('read leniently: links of a kind not known, or without a name, left out', () => {
    const r = normaliseRequirements({ rows: [{ kind: 'req', id: 'REQ-001', links: [{ kind: 'part', ref: 'U1' }, { kind: 'wire', ref: 'x' }, { kind: 'net' }, null, { kind: 'net', ref: 'GND' }] }] as never });
    expect((r.rows[0] as Requirement).links).toEqual([{ kind: 'part', ref: 'U1' }, { kind: 'net', ref: 'GND' }]);
    expect((normaliseRequirements({ rows: [{ kind: 'req', id: 'REQ-002' }] as never }).rows[0] as Requirement).links).toEqual([]);
  });
});

describe('Requirements (R6): .ReqDoc files', () => {
  it('written and read back the same; known by its content and by its name', () => {
    const d = newReqDoc('Product.ReqDoc');
    d.reqs.rows.push(req('REQ-001', { title: 'Size', text: 'No larger than 50 × 30 mm', type: 'mechanical', links: [{ kind: 'part', ref: 'J1' }, { kind: 'board', ref: 'Main.PcbDoc' }] }), req('REQ-002', { parent: 'REQ-001', title: 'Thin', verify: { method: 'inspection', state: 'open', note: 'calipers' } }));
    const bytes = writeReqDoc(d);
    expect(isReqDoc(bytes)).toBe(true);
    expect(detect(bytes, 'whatever.txt')).toBe('ReqDoc');
    expect(detect(new TextEncoder().encode('{}'), 'Empty.ReqDoc')).toBe('ReqDoc');
    const back = readReqDoc(bytes, 'Product.ReqDoc');
    expect(back.reqs).toEqual(d.reqs);
    expect(back.dirty).toBe(false);
    const viaRegistry = load(bytes, 'Product.ReqDoc');
    expect(viaRegistry.kind).toBe('ReqDoc');
    expect(new TextDecoder().decode(save(viaRegistry))).toBe(new TextDecoder().decode(bytes));
    // An empty file is a document with nothing in it yet
    expect(readReqDoc(new Uint8Array(), 'New.ReqDoc').reqs).toEqual({ prefix: 'REQ', rows: [] });
  });
});

import { CHECKS, evalCheck, newCheck, normaliseCheck, parseTempRange, tempParam, checkWords, type DesignFacts } from '../src/model/reqChecks';
import { stateOf } from '../src/model/requirements';

describe('Requirements (R6): checks against the design', () => {
  const board = { name: 'B.PcbDoc', layers: 4, w: 48, h: 29.5, thickness: 1.6, top: 7.2, bottom: 0, track: 0.127, hole: 0.3 };
  const facts: DesignFacts = { board, design: { parts: 12, lines: 7, errors: 0 }, temps: [{ designator: 'U1', min: -40, max: 85 }, { designator: 'C1', min: -55, max: 125 }],
    costAt: (q) => ({ perBoard: q >= 100 ? 4.2 : 6.9, currency: '£', priced: 7, lines: 7 }), drc: 0, enclosures: [{ name: 'B.Enclosure', w: 54, d: 35.5, h: 18.6 }] };

  it('each check passes or fails against the design, and says what it measured', () => {
    expect(evalCheck({ ...newCheck('layers'), op: '<=', a: 4 }, facts)).toEqual({ status: 'pass', measured: '4 layers' });
    expect(evalCheck({ ...newCheck('layers'), op: '<=', a: 2 }, facts).status).toBe('fail');
    // Either way round
    expect(evalCheck({ ...newCheck('boardSize'), a: 30, b: 50 }, facts)).toEqual({ status: 'pass', measured: '48 × 29.5 mm' });
    expect(evalCheck({ ...newCheck('boardSize'), a: 45, b: 50 }, facts).status).toBe('pass');
    expect(evalCheck({ ...newCheck('boardSize'), a: 47, b: 40 }, facts).status).toBe('fail');
    expect(evalCheck({ ...newCheck('thickness'), op: '=', a: 1.6 }, facts).status).toBe('pass');
    expect(evalCheck({ ...newCheck('heightTop'), a: 7 }, facts)).toEqual({ status: 'fail', measured: '7.2 mm' });
    expect(evalCheck({ ...newCheck('track'), a: 0.15 }, facts).status).toBe('fail');
    expect(evalCheck({ ...newCheck('hole'), a: 0.3 }, facts).status).toBe('pass');
    expect(evalCheck({ ...newCheck('parts'), op: '<=', a: 12 }, facts).status).toBe('pass');
    expect(evalCheck({ ...newCheck('bomLines'), op: '<=', a: 6 }, facts).status).toBe('fail');
    expect(evalCheck(newCheck('erc'), facts)).toEqual({ status: 'pass', measured: 'No errors' });
    expect(evalCheck(newCheck('drc'), { ...facts, drc: 3 })).toEqual({ status: 'fail', measured: '3 violations' });
    expect(evalCheck({ ...newCheck('cost'), a: 5, qty: 100 }, facts)).toEqual({ status: 'pass', measured: '£4.2 per board at 100 off' });
    expect(evalCheck({ ...newCheck('cost'), a: 5, qty: 10 }, facts).status).toBe('fail');
    expect(evalCheck({ ...newCheck('temperature'), a: -20, b: 70 }, facts)).toEqual({ status: 'pass', measured: '-40 to 85 °C' });
    const hot = evalCheck({ ...newCheck('temperature'), a: -20, b: 105 }, facts);
    expect(hot.status).toBe('fail');
    expect(hot.detail).toContain('U1 (-40 to 85 °C)');
    expect(evalCheck({ ...newCheck('enclosure'), a: 40, b: 60, c: 20 }, facts).status).toBe('pass');
    expect(evalCheck({ ...newCheck('enclosure'), a: 50, b: 30, c: 20 }, facts).status).toBe('fail');
  });

  it('what can\'t be told yet says why: no board, no compile, a part without a range, prices missing, rules not checked', () => {
    expect(evalCheck(newCheck('layers'), {})).toMatchObject({ status: 'unknown', detail: 'No board to measure' });
    expect(evalCheck(newCheck('parts'), {})).toMatchObject({ status: 'unknown', detail: 'Compile the project' });
    expect(evalCheck(newCheck('drc'), { board })).toMatchObject({ status: 'unknown', detail: 'No board checked yet' });
    expect(evalCheck({ ...newCheck('temperature'), a: -20, b: 70 }, { temps: [{ designator: 'U1', min: -40, max: 85 }, { designator: 'R1' }] })).toMatchObject({ status: 'unknown', detail: '1 part has no temperature range in its parameters' });
    expect(evalCheck({ ...newCheck('cost'), a: 5 }, { costAt: () => ({ perBoard: 3, currency: '£', priced: 5, lines: 7 }) })).toMatchObject({ status: 'unknown', detail: '2 of 7 lines have no price yet' });
    // Already over with the lines priced so far: it fails
    expect(evalCheck({ ...newCheck('cost'), a: 2 }, { costAt: () => ({ perBoard: 3, currency: '£', priced: 5, lines: 7 }) }).status).toBe('fail');
    expect(evalCheck(newCheck('enclosure'), { board })).toMatchObject({ status: 'unknown', detail: 'No enclosure in the project' });
  });

  it('the verification follows a check that passes or fails (when it is set to), else stays as set by hand', () => {
    const r = req('REQ-001', { check: { ...newCheck('layers'), op: '<=', a: 4 }, verify: { method: 'analysis', state: 'open', note: '' } });
    expect(stateOf(r, facts)).toBe('verified');
    expect(stateOf({ ...r, check: { ...r.check!, a: 2 } }, facts)).toBe('failed');
    expect(stateOf({ ...r, check: { ...r.check!, follow: false } }, facts)).toBe('open');
    expect(stateOf(r, {})).toBe('open');
    expect(stateOf(r, null)).toBe('open');
  });

  it('read leniently, in words; temperature ranges read from parameters', () => {
    expect(normaliseCheck({ q: 'layers', op: '!=', a: 'x' })).toEqual({ q: 'layers', op: '<=', a: 4, follow: true });
    expect(normaliseCheck({ q: 'cost', a: 3, qty: 0.4, follow: false })).toEqual({ q: 'cost', op: '<=', a: 3, qty: 1, follow: false });
    expect(normaliseCheck({ q: 'nonsense' })).toBeUndefined();
    expect(CHECKS.every((k) => normaliseCheck(newCheck(k.q))!.q === k.q)).toBe(true);
    expect(checkWords({ ...newCheck('boardSize'), a: 50, b: 30 })).toBe('Board fits within 50 × 30 mm');
    expect(checkWords({ ...newCheck('temperature'), a: -20, b: 70 })).toBe('Parts work across -20 to 70 °C');
    expect(checkWords({ ...newCheck('cost'), a: 12, qty: 100 }, '£')).toBe('Parts cost per board ≤ £12 at 100 off');
    expect(parseTempRange('-40°C ~ 85°C')).toEqual({ min: -40, max: 85 });
    expect(parseTempRange('−55 … +125 °C')).toEqual({ min: -55, max: 125 });
    expect(parseTempRange('-40 to 105')).toEqual({ min: -40, max: 105 });
    expect(parseTempRange('0°C-70°C')).toEqual({ min: 0, max: 70 });
    expect(parseTempRange('Industrial')).toBeNull();
    expect(tempParam({ Value: '10k', 'Operating Temperature': '-40°C ~ 85°C' })).toBe('-40°C ~ 85°C');
    expect(tempParam({ 'Temp Range': '0 to 70' })).toBe('0 to 70');
    expect(tempParam({ Value: '10k' })).toBeUndefined();
    // A requirement's check kept through a file
    expect((normaliseRequirements({ rows: [{ kind: 'req', id: 'R', check: { q: 'hole', op: '>=', a: 0.25, follow: true } }] as never }).rows[0] as Requirement).check).toEqual({ q: 'hole', op: '>=', a: 0.25, follow: true });
  });
});
