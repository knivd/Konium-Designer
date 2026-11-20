import { describe, expect, it } from 'vitest';
import { afterSubtree, blankReq, inTreeOrder, isReq, moveInTree, normaliseRequirements, treeRows, type ReqRow, type Requirement } from '../src/model/requirements';
import { NODE_W, reqGraph, related } from '../src/model/reqGraph';
import { ADVISE_REQS } from '../src/ai/jobs';

/** A document as one was saved: children put in another section, after a requirement that isn't their parent. */
const doc = (): ReqRow[] => normaliseRequirements({ prefix: 'REQ', rows: [
  { kind: 'section', title: 'General' },
  blankReq('REQ-001'),
  { kind: 'section', title: 'Section 1' },
  blankReq('REQ-002'),
  blankReq('REQ-003', 'REQ-001'),
  blankReq('REQ-005', 'REQ-003'),
  blankReq('REQ-006', 'REQ-005'),
  blankReq('REQ-004', 'REQ-001'),
  blankReq('REQ-008', 'REQ-004'),
] as ReqRow[] }).rows;
const ids = (rows: ReqRow[]) => rows.map((r) => (isReq(r) ? r.id : `[${r.title}]`));
const req = (rows: ReqRow[], id: string) => rows.find((r) => isReq(r) && r.id === id) as Requirement;

describe('requirements as a tree (26.161)', () => {
  it('each requirement under its parent, wherever it was put; the rest in order', () => {
    const rows = doc();
    const t = treeRows(rows);
    expect(t.map((x) => `${isReq(rows[x.i]!) ? (rows[x.i] as Requirement).id : 'S'}:${x.depth}`)).toEqual(['S:0', 'REQ-001:0', 'REQ-003:1', 'REQ-005:2', 'REQ-006:3', 'REQ-004:1', 'REQ-008:2', 'S:0', 'REQ-002:0']);
    expect(ids(inTreeOrder(rows))).toEqual(['[General]', 'REQ-001', 'REQ-003', 'REQ-005', 'REQ-006', 'REQ-004', 'REQ-008', '[Section 1]', 'REQ-002']);
  });

  it('a requirement whose parent is in another document stays where it is, at the top', () => {
    const rows: ReqRow[] = [{ kind: 'section', title: 'A' }, blankReq('REQ-010', 'REQ-999'), blankReq('REQ-011', 'REQ-010')];
    expect(treeRows(rows).map((x) => x.depth)).toEqual([0, 0, 1]);
  });

  it('moves among those at its level, with what is under it', () => {
    const rows = inTreeOrder(doc());
    // REQ-004 (with REQ-008) before REQ-003 (with its three levels)
    expect(ids(moveInTree(rows, req(rows, 'REQ-004'), -1)!)).toEqual(['[General]', 'REQ-001', 'REQ-004', 'REQ-008', 'REQ-003', 'REQ-005', 'REQ-006', '[Section 1]', 'REQ-002']);
    // An only child goes nowhere; the first and last at the top neither
    expect(moveInTree(rows, req(rows, 'REQ-005'), -1)).toBeNull();
    expect(moveInTree(rows, req(rows, 'REQ-005'), 1)).toBeNull();
    expect(moveInTree(rows, rows[0]!, -1)).toBeNull();
    expect(moveInTree(rows, req(rows, 'REQ-002'), 1)).toBeNull();
    // A top requirement past a section heading: into the section before
    expect(ids(moveInTree(rows, req(rows, 'REQ-002'), -1)!)).toEqual(['[General]', 'REQ-001', 'REQ-003', 'REQ-005', 'REQ-006', 'REQ-004', 'REQ-008', 'REQ-002', '[Section 1]']);
    // A section past the requirement before it, with that requirement's whole tree
    expect(ids(moveInTree(rows, rows[7]!, -1)!)).toEqual(['[General]', '[Section 1]', 'REQ-001', 'REQ-003', 'REQ-005', 'REQ-006', 'REQ-004', 'REQ-008', 'REQ-002']);
  });

  it('a new one beside another goes after it and what is under it', () => {
    const rows = inTreeOrder(doc());
    expect(afterSubtree(rows, req(rows, 'REQ-003'))).toBe(5);
    expect(afterSubtree(rows, req(rows, 'REQ-001'))).toBe(7);
    expect(afterSubtree(rows, rows[7]!)).toBe(8);
  });
});

describe('the connection graph (26.161)', () => {
  const rows = doc();
  req(rows, 'REQ-006').links = [{ kind: 'part', ref: 'U1' }, { kind: 'net', ref: 'VCC' }];
  req(rows, 'REQ-008').links = [{ kind: 'part', ref: 'U1' }];
  const g = reqGraph(rows);
  const node = (id: string) => g.reqs.find((n) => n.req.id === id)!;

  it('children to the right of their parent, a parent level with the middle of its children', () => {
    expect(node('REQ-003').x).toBe(node('REQ-001').x + NODE_W + 70);
    expect(node('REQ-001').y).toBe((node('REQ-003').y + node('REQ-004').y) / 2);
    expect(node('REQ-002').y).toBeGreaterThan(node('REQ-008').y);
    expect(g.sections.map((s) => s.title)).toEqual(['General', 'Section 1']);
    expect(g.edges.filter((e) => e.kind === 'parent').length).toBe(5);
  });

  it('a design item once, right of every requirement, joined to each linked to it', () => {
    expect(g.links.map((l) => l.key).sort()).toEqual(['net:VCC', 'part:U1']);
    expect(Math.min(...g.links.map((l) => l.x))).toBeGreaterThan(Math.max(...g.reqs.map((n) => n.x + n.w)));
    expect(g.edges.filter((e) => e.to === 'link:part:U1').map((e) => e.from).sort()).toEqual(['req:REQ-006', 'req:REQ-008']);
    // (no two overlapping)
    const ys = g.links.map((l) => l.y).sort((a, b) => a - b);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(26);
  });

  it('what lights up with a requirement: above it, under it, and what those under it are met by', () => {
    const r = related(g, 'REQ-003');
    expect([...r].filter((k) => k.startsWith('req:')).sort()).toEqual(['req:REQ-001', 'req:REQ-003', 'req:REQ-005', 'req:REQ-006']);
    expect(r.has('link:part:U1') && r.has('link:net:VCC')).toBe(true);
    expect(related(g, 'REQ-002').has('link:part:U1')).toBe(false);
  });
});

describe('the Requirements Adviser job (26.161)', () => {
  const input = { reqs: [{ id: 'REQ-001', section: 'General', title: 'Power', text: 'Runs from 12 V', type: 'electrical', priority: 'must', status: 'draft', method: 'test' }], history: [{ ask: 'Review it', reply: 'It lacks a tolerance.' }], ask: 'Break this one down', picked: 'REQ-001' };

  it('sends the requirements, the one picked and the conversation so far', () => {
    const m = ADVISE_REQS.messages(input);
    expect(m.length).toBe(2);
    const user = String(m[1]!.content);
    expect(user).toContain('"id":"REQ-001"');
    expect(user).toContain('picked: REQ-001');
    expect(user).toContain('The user: Review it\nYou: It lacks a tolerance.');
    expect(user.endsWith("The user's request: Break this one down")).toBe(true);
  });

  it('keeps what can be applied: changes to requirements that exist, new ones with their own references', () => {
    const a = ADVISE_REQS.check({
      reply: 'Done.',
      changes: [{ id: 'REQ-001', text: 'The board shall run from 12 V ± 10 %.', type: 'ELECTRICAL', why: 'A tolerance' }, { id: 'REQ-404', title: 'x', why: 'no such' }, { id: 'REQ-001', why: 'nothing to change' }],
      added: [{ ref: 'N1', parent: 'REQ-001', title: 'Reverse polarity', text: 'Survives [value] V reversed.', type: 'odd', priority: 'MAY', method: 'test', why: 'Not covered' }, { ref: 'N1', title: 'Second', text: 'x' }, { title: '', text: '' }],
    }, input);
    expect(a.changes).toEqual([{ id: 'REQ-001', text: 'The board shall run from 12 V ± 10 %.', type: 'electrical', why: 'A tolerance' }]);
    expect(a.added.map((x) => [x.ref, x.parent, x.type, x.priority])).toEqual([['N1', 'REQ-001', 'other', 'must'], ['N1_', undefined, 'other', 'must']]);
    expect(() => ADVISE_REQS.check({}, input)).toThrow();
  });
});
