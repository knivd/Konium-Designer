/**
 * DipTrace's XML files (File › Export › DipTrace XML, and its plug-ins' files):
 * a board (`<Source Type="DipTrace-PCB">`, .dipxml), a schematic (`DipTrace-Schematic`, .dchxml), a
 * component library (`<Library Type="DipTrace-ComponentLibrary">`, .elixml) and a pattern library
 * (`DipTrace-PatternLibrary`, .libxml). A board or schematic carries its design cache: a component
 * library holding a pattern library. Lengths are in the file's units (mm, inch or mil), angles in
 * radians anticlockwise, Y up; read here as millimetres and degrees.
 */
import { attrNum, kid, kidsOf, parseXml, type XEl } from '../xml';

export type DtKind = 'pcb' | 'sch' | 'complib' | 'patlib';
export interface DtDoc {
  kind: DtKind;
  root: XEl;
  version: string;
  /** Millimetres per file unit. */
  k: number;
  /** The pattern library's pad styles (by name) and patterns (by style), the component library's components (by style). */
  padStyles: Map<string, XEl>;
  patterns: Map<string, XEl>;
  components: Map<string, XEl>;
  /** The board or schematic element. */
  body?: XEl;
}

/** Whether text is DipTrace's XML (its first bytes). */
export function isDipTraceXml(head: string): boolean {
  return /<Source\s[^>]*Type="DipTrace-(PCB|Schematic)"|<Library\s[^>]*Type="DipTrace-(ComponentLibrary|PatternLibrary)"/.test(head.slice(0, 4096));
}

const UNIT: Record<string, number> = { mm: 1, inch: 25.4, mil: 0.0254, in: 25.4 };

export function readDipTrace(bytes: Uint8Array | string): DtDoc {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const docEl = parseXml(text.replace(/^\uFEFF/, ''));
  const root = docEl.children.find((c) => c.name === 'Source' || c.name === 'Library') ?? docEl;
  const type = root.attrs.Type ?? '';
  const kind: DtKind | null = type === 'DipTrace-PCB' ? 'pcb' : type === 'DipTrace-Schematic' ? 'sch' : type === 'DipTrace-ComponentLibrary' ? 'complib' : type === 'DipTrace-PatternLibrary' ? 'patlib' : null;
  if (!kind) throw new Error('Not a DipTrace XML file');
  const k = UNIT[(root.attrs.Units ?? 'mm').toLowerCase()] ?? 1;
  const compLib = kind === 'complib' ? root : kind === 'patlib' ? undefined : kidsOf(root, 'Library').find((l) => l.attrs.Type === 'DipTrace-ComponentLibrary');
  const patLib = kind === 'patlib' ? root : kidsOf(compLib ?? root, 'Library').find((l) => l.attrs.Type === 'DipTrace-PatternLibrary')
    ?? kidsOf(root, 'Library').find((l) => l.attrs.Type === 'DipTrace-PatternLibrary');
  const padStyles = new Map<string, XEl>();
  for (const s of kidsOf(kid(patLib, 'PadStyles'), 'PadStyle')) padStyles.set(s.attrs.Name ?? '', s);
  const patterns = new Map<string, XEl>();
  kidsOf(kid(patLib, 'Patterns'), 'Pattern').forEach((p, i) => { if (p.attrs.Enabled !== 'N') patterns.set(p.attrs.PatternStyle ?? `PatType${p.attrs.Id ?? i}`, p); });
  const components = new Map<string, XEl>();
  kidsOf(kid(compLib, 'Components'), 'Component').forEach((c, i) => { if (c.attrs.Enabled !== 'N') components.set(c.attrs.ComponentStyle ?? `CompType${c.attrs.Id ?? i}`, c); });
  return { kind, root, version: root.attrs.Version ?? '', k, padStyles, patterns, components, body: kind === 'pcb' ? kid(root, 'Board') : kind === 'sch' ? kid(root, 'Schematic') : undefined };
}

/** A number (the reader takes a comma for the point too). */
export function dnum(e: XEl | undefined, a: string, d = 0): number {
  const v = e?.attrs[a];
  if (v === undefined || v === '') return d;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : d;
}
/** Y/N (and the simulator's +/−). */
export const dyes = (e: XEl | undefined, a: string, d = false): boolean => { const v = e?.attrs[a]; return v === undefined || v === '' ? d : v === 'Y' || v === '+'; };
/** A child's text. */
export const dtext = (e: XEl | undefined, name: string): string => (kid(e, name)?.text ?? '').trim();
/** Present (not deleted on a plug-in's edit). */
export const live = (e: XEl): boolean => e.attrs.Enabled !== 'N';
/** Radians → degrees. */
export const deg = (rad: number): number => Math.round(((rad * 180) / Math.PI) * 10000) / 10000;
export { attrNum };

type Pt = { x: number; y: number };
/** An element's <Points>, in mm. */
export function pointsOf(doc: DtDoc, e: XEl | undefined): (Pt & { arc: boolean; el: XEl })[] {
  return kidsOf(kid(e, 'Points'), 'Point').map((p) => ({ x: dnum(p, 'X') * doc.k, y: dnum(p, 'Y') * doc.k, arc: dyes(p, 'Arc'), el: p }));
}
/** A text shape's lines. */
export const textLines = (e: XEl): string[] => kidsOf(kid(e, 'TextLines'), 'TextLine').map((t) => t.text ?? '');

/** DipTrace's font size (points) as a text height (mm): the em of a point, its capitals ~0.85 of it [est, against DipTrace's Gerbers]. */
export const fontMm = (pt: number): number => Math.max(0.3, pt * 0.3);

/** Footprint names for the patterns (by style): each pattern's name, made unique in the library's order. */
export function patternNameMap(doc: DtDoc): Map<string, string> {
  const out = new Map<string, string>(), taken = new Set<string>();
  for (const [style, pat] of doc.patterns) {
    const base = (dtext(pat, 'Name') || style).replace(/[\\/:*?"<>|]/g, '_');
    let n = base;
    for (let k = 2; taken.has(n.toUpperCase()); k++) n = `${base}_${k}`;
    taken.add(n.toUpperCase());
    out.set(style, n);
  }
  return out;
}
