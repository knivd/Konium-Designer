/**
 * What a project's design measures, for the requirements' checks: its board (layers, extent,
 * thickness, the tallest parts above and below, the narrowest track, the smallest hole), its
 * compiled design (parts, BOM lines, errors, each part's operating temperature), the parts' cost
 * per board from its BOM document's prices, its enclosures' sizes, and the design rule check when
 * one has been run on the board as it is. Worked out again only when the design has changed.
 */
import { docs, tick, type OpenDoc, type Project } from './state';
import { compileOptions, projectSheets } from './project';
import { compileProject } from '../model/compile';
import { docBaseName } from '../formats/altium/prjpcb';
import { readPcbDoc } from '../formats/altium/pcbdoc';
import { readBomDoc, type BomDocument } from '../formats/altium/bomdoc';
import { readEnclosure, type EnclosureDocument } from '../formats/enclosureDoc';
import { boardFacts } from '../model/enclosureBoard';
import { layoutOf } from '../model/enclosure';
import { isCopper } from '../model/layers';
import { NO_NET, type PcbDocument } from '../model/pcb';
import { UNITS_PER_MM } from '../core/units';
import { bomItems, defaultBomSetup, inBom } from '../model/bom';
import { variantComponents } from '../model/variants';
import { bomLines, bomTotals } from '../model/activeBom';
import { runDrc } from '../model/drc';
import { parseTempRange, tempParam, type DesignFacts } from '../model/reqChecks';

const parsedFiles = new WeakMap<Uint8Array, unknown>();
function fromFile<T>(p: Project, name: string, read: (b: Uint8Array, n: string) => T): T | null {
  const f = p.files.get(name.toLowerCase());
  if (!f) return null;
  if (!parsedFiles.has(f.bytes)) { try { parsedFiles.set(f.bytes, read(f.bytes, f.name)); } catch { parsedFiles.set(f.bytes, null); } }
  return parsedFiles.get(f.bytes) as T | null;
}
const openIn = (p: Project, name: string): OpenDoc | undefined => docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
const namesOf = (p: Project, ext: RegExp) => p.prj.documents.map(docBaseName).filter((n) => ext.test(n));

/** The project's board: open, else read from its file. */
export function boardOf(p: Project): { name: string; doc: PcbDocument; od?: OpenDoc } | null {
  const name = namesOf(p, /\.pcbdoc$/i)[0];
  if (!name) return null;
  const od = openIn(p, name);
  if (od?.doc.kind === 'PcbDoc') return { name, doc: od.doc as PcbDocument, od };
  const doc = fromFile(p, name, readPcbDoc);
  return doc ? { name, doc } : null;
}

/** What changes the design: each open document's edits, and the files. */
function revision(p: Project): string {
  return docs.value.filter((d) => d.projectId === p.id && d.doc.kind !== 'ReqDoc').map((d) => `${d.name}:${d.editor?.undo.revision ?? (d.doc as { dirty?: boolean }).dirty ?? 0}`).join('|') + `#${p.files.size}#${p.prj.documents.length}`;
}

/** The design rule check run on a board as it was (its edit count then): its violations. */
const drcRuns = new WeakMap<PcbDocument, { rev: number; violations: number }>();
const boardRev = (b: { doc: PcbDocument; od?: OpenDoc }) => b.od?.editor?.undo.revision ?? 0;

/** Run the design rule check on the project's board now (for the checks that need it). */
export function checkDesignRules(p: Project): number | null {
  const b = boardOf(p);
  if (!b) return null;
  const r = runDrc(b.doc);
  drcRuns.set(b.doc, { rev: boardRev(b), violations: r.violations.length });
  tick.value++;
  return r.violations.length;
}

const cache = new Map<string, { rev: string; facts: DesignFacts }>();

/** What the project's design measures now (worked out again only when it has changed). */
export function designFacts(p: Project | null): DesignFacts {
  if (!p) return {};
  const rev = revision(p);
  const b = boardOf(p);
  const run = b ? drcRuns.get(b.doc) : undefined;
  const drc = run && b && run.rev === boardRev(b) ? run.violations : undefined;
  const hit = cache.get(p.id);
  if (hit && hit.rev === rev) return { ...hit.facts, drc };
  const facts: DesignFacts = { board: null, design: null, temps: null, costAt: null, enclosures: [] };
  if (b) {
    try {
      const bf = boardFacts(b.doc);
      let track: number | undefined, hole: number | undefined;
      for (const q of b.doc.prims) {
        if ((q.kind === 'track' || q.kind === 'arc') && !q.keepout && q.polygon === NO_NET && isCopper(q.layer) && q.width > 0) track = Math.min(track ?? Infinity, q.width);
        else if ((q.kind === 'via' || q.kind === 'pad') && q.hole > 0) hole = Math.min(hole ?? Infinity, q.hole);
      }
      facts.board = { name: b.name, layers: b.doc.board.copperStack.length, w: bf.w, h: bf.h, thickness: bf.thickness, top: bf.top, bottom: bf.bottom,
        track: track === undefined ? undefined : track / UNITS_PER_MM, hole: hole === undefined ? undefined : hole / UNITS_PER_MM };
      // The project's enclosures, made round this board
      for (const name of namesOf(p, /\.enclosure$/i)) {
        const od = openIn(p, name);
        const e = od?.doc.kind === 'Enclosure' ? (od.doc as EnclosureDocument) : fromFile(p, name, readEnclosure);
        if (!e) continue;
        const g = layoutOf(e.spec, bf);
        facts.enclosures!.push({ name, w: 2 * g.ox, d: 2 * g.oy, h: g.height });
      }
    } catch { facts.board = null; }
  }
  const sheets = projectSheets(p);
  if (sheets.length) {
    try {
      const res = compileProject(sheets, compileOptions(p));
      const comps = variantComponents(res.components, null).filter(inBom);
      const items = bomItems(comps);
      const bomName = namesOf(p, /\.bomdoc$/i)[0];
      const bomOd = bomName ? openIn(p, bomName) : undefined;
      const bd = bomName ? (bomOd?.doc.kind === 'BomDoc' ? (bomOd.doc as BomDocument) : fromFile(p, bomName, readBomDoc)) : null;
      const lines = bomLines(items, bd?.setup ?? defaultBomSetup(), bd);
      facts.design = { parts: comps.length, lines: lines.length, errors: res.messages.filter((m) => m.level === 'error').length };
      facts.temps = comps.map((c) => { const t = tempParam(c.params); const r = t ? parseTempRange(t) : null; return { designator: c.designator, min: r?.min, max: r?.max }; });
      if (bd) {
        facts.costAt = (qty: number) => {
          const t = bomTotals(lines, qty);
          const first = t.byCurrency[0];
          if (!first) return null;
          const sym = first.currency === 'GBP' ? '£' : first.currency === 'EUR' ? '€' : first.currency === 'USD' ? '$' : `${first.currency} `;
          return { perBoard: first.perBoard, currency: sym, priced: first.lines, lines: lines.length };
        };
      }
    } catch { facts.design = null; }
  }
  cache.set(p.id, { rev, facts });
  return { ...facts, drc };
}
