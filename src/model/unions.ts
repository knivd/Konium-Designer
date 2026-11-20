/**
 * Unions on the board: objects that select and move as one (Tools › Convert › Create Union from
 * selected objects; right-click › Unions). A union is an index carried by its members, a name in
 * UnionNames and, for a union that rebuilds itself (a length tuning, a drill table), a
 * SmartUnions record. Tracks, arcs and texts carry the index in their records; components and
 * pours as UNIONINDEX. Other kinds can't join one yet.
 */
import type { Change } from '../core/undo';
import type { PcbDocument, PcbPrim } from './pcb';
import { recordUnion, smartInfo, withRecordUnion, UNION_FIELD } from '../formats/altium/unions';
import type { PcbRawRecord } from '../formats/altium/framing';

const recOf = (doc: PcbDocument, p: PcbPrim): PcbRawRecord | undefined => doc.streams.get(p.src.storage)?.records[p.src.index];

export const canJoinUnion = (p: PcbPrim) => !!UNION_FIELD[p.src.storage];

/** A primitive's union (0: none). */
export function unionOf(doc: PcbDocument, p: PcbPrim): number {
  const r = recOf(doc, p);
  return r ? recordUnion(p.src.storage, r) : 0;
}
export const componentUnion = (doc: PcbDocument, c: number) => doc.components[c]?.bag.int('UNIONINDEX', 0) ?? 0;

export interface UnionMembers { prims: PcbPrim[]; components: number[] }
export function unionMembers(doc: PcbDocument, u: number): UnionMembers {
  if (!u) return { prims: [], components: [] };
  return {
    prims: doc.prims.filter((p) => canJoinUnion(p) && unionOf(doc, p) === u),
    components: doc.components.map((c, i) => (c.bag.int('UNIONINDEX', 0) === u ? i : -1)).filter((i) => i >= 0),
  };
}

/** Every union index in use (members, names, smart unions). */
export function unionsInUse(doc: PcbDocument): Set<number> {
  const out = new Set<number>();
  for (const p of doc.prims) if (canJoinUnion(p)) { const u = unionOf(doc, p); if (u) out.add(u); }
  for (const c of doc.components) { const u = c.bag.int('UNIONINDEX', 0); if (u) out.add(u); }
  for (const n of doc.unionNames ?? []) out.add(n.index);
  for (const s of doc.smartUnions ?? []) { const u = smartInfo(s).index; if (u) out.add(u); }
  return out;
}
export const nextUnion = (doc: PcbDocument) => Math.max(0, ...unionsInUse(doc)) + 1;

/** "Unions", "Unions 1", … as AD17 names them. */
export function freshUnionName(doc: PcbDocument, base: string): string {
  const names = new Set((doc.unionNames ?? []).map((n) => n.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Record edits putting primitives in a union (0 takes them out); kinds that can't hold one are left. */
export function unionEdits(doc: PcbDocument, prims: PcbPrim[], u: number): { storage: string; index: number; after: PcbRawRecord }[] {
  return prims.flatMap((p) => {
    const r = recOf(doc, p);
    const after = r ? withRecordUnion(p.src.storage, r, u) : null;
    return after ? [{ storage: p.src.storage, index: p.src.index, after }] : [];
  });
}

/** UnionNames and SmartUnions replaced (one undo step). */
export function setUnionMeta(doc: PcbDocument, names: { index: number; name: string }[], smart: string[]): Change {
  const n0 = doc.unionNames, s0 = doc.smartUnions;
  const wasN = doc.dirty.has('UnionNames'), wasS = doc.dirty.has('SmartUnions');
  return {
    apply() { doc.unionNames = names; doc.smartUnions = smart; doc.dirty.add('UnionNames'); doc.dirty.add('SmartUnions'); },
    revert() { doc.unionNames = n0; doc.smartUnions = s0; if (!wasN) doc.dirty.delete('UnionNames'); if (!wasS) doc.dirty.delete('SmartUnions'); },
  };
}

/** Names and smart unions without the given unions (once they have no members left). */
export function metaWithout(doc: PcbDocument, gone: Set<number>): { names: { index: number; name: string }[]; smart: string[] } {
  return { names: (doc.unionNames ?? []).filter((n) => !gone.has(n.index)), smart: (doc.smartUnions ?? []).filter((s) => !gone.has(smartInfo(s).index)) };
}

/** The smart union of a union, if any (its type: 1 drill table, 4 length tuning). */
export function smartOf(doc: PcbDocument, u: number): { rec: string; type: number } | null {
  const rec = (doc.smartUnions ?? []).find((s) => smartInfo(s).index === u);
  return rec ? { rec, type: smartInfo(rec).type } : null;
}
