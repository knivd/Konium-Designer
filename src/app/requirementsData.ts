/**
 * The requirements of a project, across all its requirements documents: those open (as they are
 * now, edits and all) and those not open (read from the project's files). Identifiers are unique
 * across the project, so a new one takes the next number after the highest in any of them.
 */
import { snapshot } from '../model/richText';
import { docs, projects, tick, type OpenDoc, type Project } from './state';
import { openDocument } from './actions';
import { readReqDoc, type ReqDocument } from '../formats/reqDoc';
import { isReq, type Requirement } from '../model/requirements';

const read = new WeakMap<Uint8Array, ReqDocument | null>();

export interface ReqSource { name: string; doc: ReqDocument; od: OpenDoc | null }

export const projectOf = (od: OpenDoc | null | undefined): Project | null => (od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);

/** Every requirements document of the project (or, outside one, the open requirements documents outside any project). */
export function reqSources(p: Project | null): ReqSource[] {
  const open = docs.value.filter((x) => x.doc.kind === 'ReqDoc' && (p ? x.projectId === p.id : !x.projectId));
  const out: ReqSource[] = open.map((od) => ({ name: od.name, doc: od.doc as ReqDocument, od }));
  if (p) {
    const have = new Set(out.map((s) => s.name.toLowerCase()));
    for (const f of p.files.values()) {
      if (!/\.reqdoc$/i.test(f.name) || have.has(f.name.toLowerCase())) continue;
      let d = read.get(f.bytes);
      if (d === undefined) { try { d = readReqDoc(f.bytes, f.name); } catch { d = null; } read.set(f.bytes, d); }
      if (d) out.push({ name: f.name, doc: d, od: null });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** All the project's requirements, with the document each is in. */
export function projectReqs(p: Project | null): { req: Requirement; source: ReqSource }[] {
  return reqSources(p).flatMap((source) => source.doc.reqs.rows.filter(isReq).map((req) => ({ req, source })));
}

/** Each document's undo and redo: its requirements as they were. */
const history = new WeakMap<ReqDocument, { undo: string[]; redo: string[] }>();
export function reqHistory(d: ReqDocument): { undo: string[]; redo: string[] } {
  let h = history.get(d);
  if (!h) { h = { undo: [], redo: [] }; history.set(d, h); }
  return h;
}
/** A change to a document, one step to undo (in the document's tab or from the panel alike). */
export function changeReqs(d: ReqDocument, fn: () => void): void {
  const h = reqHistory(d);
  h.undo.push(snapshot(d.reqs)); if (h.undo.length > 300) h.undo.shift(); h.redo = [];
  fn();
  d.dirty = true; tick.value++;
}

/** A document to change: open already, or opened now (in the background, its tab not brought to the front). */
export function writable(p: Project | null, s: ReqSource): ReqDocument | null {
  if (s.od) return s.doc;
  const f = p?.files.get(s.name.toLowerCase());
  const od = f && p ? openDocument(f, p.id, false) : null;
  return od?.doc.kind === 'ReqDoc' ? (od.doc as ReqDocument) : null;
}
