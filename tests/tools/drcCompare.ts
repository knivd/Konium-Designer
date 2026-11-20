/**
 * Compare the desktop suite's DRC report with Konium Designer's for the same board.
 *
 *   npx vite-node tests/tools/drcCompare.ts <suite report .drc / .txt / .html> <konium .txt> [--max n]
 *
 * Both reports are read as the suite writes them: its text report ("Processing Rule : …",
 * "   Violation between …", "Rule Violations :n") or its HTML report (a table per rule, a row per
 * violation); Konium's (tests/tools/drcTorture.ts) is laid out as the text one. Rules are matched by
 * kind (the several Width rules of a board are one kind), violations by the objects they name
 * (kind, designator and pin, coordinates to 0.01 mil, either order), not by their wording. Printed
 * per kind: the counts in each, then the violations only the suite found and those only Konium found
 * (with, beside each, a violation of the other report that names one of the same objects, if any).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const MIL_PER_MM = 1 / 0.0254;

export interface DrcObject {
  /** Pad, Via, Track, Arc, Fill, Text, Region, Component, Net, Polygon. */
  kind: string;
  /** A pad's designator-pin, a component's designator, a net's or polygon's name, a text's string. */
  name?: string;
  /** Coordinates in mil, x and y in turn; and how far each may be off (the report's precision). */
  at: number[]; tol: number;
  layer?: string;
}
export interface DrcEntry { kind: string; rule: string; text: string; objects: DrcObject[] }
export interface DrcRuleBlock { heading: string; kind: string; count?: number; entries: DrcEntry[] }
export interface ParsedReport { file: string; format: 'text' | 'html'; rules: DrcRuleBlock[]; total?: number }

/* ─── Rule kinds from the report's headings ───────────────────────────────────────────── */

/** The rule kind a heading (or a violation's leading words) names; most specific first. */
const KINDS: [RegExp, string][] = [
  [/component clearance/, 'ComponentClearance'], [/hole to hole/, 'HoleToHoleClearance'], [/board outline|board clearance/, 'BoardOutlineClearance'],
  [/silk to (solder )?mask/, 'SilkToSolderMaskClearance'], [/silk to silk/, 'SilkToSilkClearance'], [/silk to board/, 'SilkToBoardRegionClearance'],
  [/solder mask sliver|mask sliver/, 'MinimumSolderMaskSliver'], [/short.?circuit/, 'ShortCircuit'], [/un.?routed net/, 'UnRoutedNet'],
  [/un.?connected pin/, 'UnConnectedPin'], [/net antenna/, 'NetAntennae'], [/hole size/, 'HoleSize'], [/annular ring/, 'MinimumAnnularRing'],
  [/differential pair/, 'DiffPairsRouting'], [/height/, 'Height'], [/acute angle/, 'AcuteAngle'], [/smd to corner/, 'SMDToCorner'],
  [/neck.?down/, 'SMDNeckDown'], [/smd to plane/, 'SMDToPlane'], [/smd entry/, 'SMDEntry'], [/vias? under smd/, 'ViasUnderSMD'],
  [/routing via/, 'RoutingVias'], [/routing layers/, 'RoutingLayers'], [/layer pairs|drill pairs settings/, 'LayerPairs'], [/power plane connect/, 'PlaneConnect'], [/modified polygon|un.?poured polygon/, 'UnpouredPolygon'],
  [/room definition/, 'RoomDefinition'], [/matched (net )?lengths?/, 'MatchedLengths'], [/^length\b|length constraint/, 'Length'],
  [/parallel segment/, 'ParallelSegment'], [/daisy chain|stub length/, 'StubLength'], [/maximum via count/, 'MaximumViaCount'],
  [/permitted layers/, 'PermittedLayers'], [/creepage/, 'Creepage'], [/return path/, 'ReturnPath'], [/back drill|via stub/, 'BackDrilling'],
  [/fabrication test ?point usage/, 'FabricationTestPointUsage'], [/assembly test ?point usage/, 'AssemblyTestPointUsage'],
  [/fabrication test ?point/, 'FabricationTestpoint'], [/assembly test ?point/, 'AssemblyTestpoint'],
  [/drilled smt/, 'DrilledSMTPad'], [/multi.?layer pads? with 0|0 size hole/, 'MultiLayerPadNoHole'], [/broken plane/, 'BrokenPlane'],
  [/dead copper/, 'DeadCopper'], [/starved thermal/, 'StarvedThermal'], [/shorting copper|net tie/, 'ShortingCopper'],
  [/width constraint|^width\b/, 'Width'], [/clearance constraint|^clearance\b/, 'Clearance'],
];
export function kindOf(heading: string): string {
  const h = heading.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [re, k] of KINDS) if (re.test(h)) return k;
  // Its leading words, as a name
  return h.replace(/\(.*$/, '').replace(/[^a-z0-9 ]/g, '').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Unknown';
}

/* ─── Objects from a violation's words ────────────────────────────────────────────────── */

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const POINT = new RegExp(String.raw`\((${NUM})\s*(mil|mm)\s*,\s*(${NUM})\s*(mil|mm)\)`, 'g');
const STOP = String.raw`(?=\s+And\s|\s+Between\s|\s*\[|\s+Actual|\s+Mask\b|\s+Silk\b|\s+clearance|\s+Hole\b|\s+Signal|\s+Stub|\s+to its|\s+doesn|\s+enters|\s+by\s|\s+on\s+a\s|\s+is\s|:|,|\)|$)`;
const LAYER = new RegExp(String.raw`^\s*(?:on\s+(.+?)|from\s+(.+?)\s+to\s+(.+?))${STOP}`);

function points(s: string): { at: number[]; tol: number; end: number } {
  const at: number[] = [];
  let tol = 0.01, end = 0;
  const re = new RegExp(`^(?:${POINT.source})+`);
  const m = re.exec(s);
  if (!m) return { at, tol, end };
  for (const p of m[0].matchAll(POINT)) {
    const x = Number(p[1]) * (p[2] === 'mm' ? MIL_PER_MM : 1), y = Number(p[3]) * (p[4] === 'mm' ? MIL_PER_MM : 1);
    if (p[2] === 'mm' || p[4] === 'mm') tol = Math.max(tol, 0.01 + 0.0005 * MIL_PER_MM);
    at.push(x, y);
  }
  end = m[0].length;
  return { at, tol, end };
}

/** The objects a violation names. */
export function objectsOf(text: string): DrcObject[] {
  const out: DrcObject[] = [];
  // A plane's isolated copper is told by its plane, layer and area (each tool's arcs differ a little: 5%)
  const iso = /^Isolated copper: Split Plane\s+(?:\S+\s+)?\((.+?)\) on (.+?)\. (Dead copper|Copper island)[^:]*: ([\d.]+) sq/.exec(text);
  if (iso) return [{ kind: iso[3] === 'Dead copper' ? 'DeadPlaneCopper' : 'PlaneIsland', name: iso[1], layer: iso[2], at: [Number(iso[4])], tol: Number(iso[4]) * 0.05 }];
  const net = /\bNet ([^\s(),]+) Between\b/.exec(text);
  if (net) out.push({ kind: 'Net', name: net[1], at: [], tol: 0 });
  // The objects follow the rule's own words: after "Between", else after its first ": "
  let body = text;
  const b = body.indexOf(' Between ');
  if (b >= 0) body = body.slice(b + 9);
  else { const c = body.indexOf(': '); if (c >= 0) body = body.slice(c + 2); }
  const head = /\b(Polygon Region|Region|Pad|Via|Track|Arc|Fill|Text|Small Component|Component|Polygon)\b/g;
  for (let m = head.exec(body); m; m = head.exec(body)) {
    const kind = m[1]!.replace(/^Small /, '');
    let rest = body.slice(m.index + m[0].length);
    let name: string | undefined;
    if (kind === 'Pad') {
      const n = /^\s+([^\s(]+?)\s*(?=\()/.exec(rest);
      if (!n) continue;
      name = n[1]; rest = rest.slice(n[0].length);
    } else if (kind === 'Text') {
      const n = /^\s+"([^"]*)"\s*/.exec(rest);
      if (n) { name = n[1]; rest = rest.slice(n[0].length); }
    } else if (kind === 'Component' || kind === 'Polygon') {
      const n = /^\s+([^\s(),]+)/.exec(rest);
      if (!n) continue;
      name = kind === 'Component' ? n[1]!.split('-')[0] : n[1];
      rest = rest.slice(n[0].length).replace(/^\s+(?=\()/, '');
    } else if (kind === 'Region' || kind === 'Polygon Region') {
      const n = /^\s*\((\d+) hole\(s\)\)\s*(.+?)(?=\s+And\s|\s+Between\s|\s*\[|\s+\(|$)/.exec(rest);
      if (n) out.push({ kind, name: n[1], at: [], tol: 0, layer: n[2]!.trim() });
      continue;
    } else rest = rest.replace(/^\s+/, '');
    const pts = points(rest);
    if (!pts.at.length && kind !== 'Component' && kind !== 'Polygon') continue;
    const l = LAYER.exec(rest.slice(pts.end));
    const layer = l ? (l[1] ?? `${l[2]} to ${l[3]}`).trim() : undefined;
    out.push({ kind, name, at: pts.at, tol: pts.tol, layer });
    // On past what was read (rest is the end of body)
    head.lastIndex = body.length - rest.length + pts.end;
  }
  return out;
}

/* ─── Reading the reports ─────────────────────────────────────────────────────────────── */

const entity = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e.toLowerCase()] ?? all;
});
const plain = (html: string) => entity(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function parseReport(text: string, file = ''): ParsedReport {
  const html = /<(html|table)\b/i.test(text);
  const rules: DrcRuleBlock[] = [];
  let cur: DrcRuleBlock | null = null;
  let total: number | undefined;
  const open = (heading: string) => { cur = { heading, kind: kindOf(heading), entries: [] }; rules.push(cur); };
  const add = (t: string) => {
    if (!cur) open(t.replace(/:.*$/, ''));
    cur!.entries.push({ kind: cur!.kind, rule: cur!.heading, text: t, objects: objectsOf(t) });
  };
  if (!html) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      let m: RegExpExecArray | null;
      if ((m = /^\s*Processing Rule\s*:\s*(.*)$/.exec(line))) open(m[1]!.trim());
      else if ((m = /^\s*Violation between\s+(.*)$/i.exec(line))) add(m[1]!.trim());
      else if ((m = /^\s*Rule Violations\s*:\s*(\d+)/.exec(line)) && cur) (cur as DrcRuleBlock).count = Number(m[1]);
      else if ((m = /^\s*Violations Detected\s*:\s*(\d+)/.exec(line))) total = Number(m[1]);
    }
    return { file, format: 'text', rules, total };
  }
  // HTML: a heading row (one header cell) per rule, a row of one cell per violation; the summary's
  // two-cell rows (rule, count) give the counts; waived violations are left out
  const counts = new Map<string, number>(), stated = new Map<string, number>(), totals: number[] = [];
  let waived = false;
  for (const tr of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => ({ th: c[1]!.toLowerCase() === 'th', text: plain(c[2]!) }));
    if (!cells.length) continue;
    if (cells.length === 2 && /^\d+$/.test(cells[1]!.text)) {
      const label = cells[0]!.text, n = Number(cells[1]!.text);
      counts.set(label, n);
      // The header's "Warnings :" and "Rule Violations :" make the total; else the summary tables' "Total" rows
      if (/^(warnings|rule violations)\s*:$/i.test(label)) stated.set(label.toLowerCase().replace(/\W/g, ''), n);
      else if (/^total$/i.test(label)) totals.push(n);
      continue;
    }
    if (cells.length !== 1) continue;
    const c = cells[0]!;
    if (c.th) {
      if (/^waived/i.test(c.text)) { waived = true; continue; }
      if (/^(rule violations|warnings|violations?|count|summary|comment|date)$/i.test(c.text)) continue;
      waived = false; open(c.text);
    } else if (!waived && cur && /\(\s*-?\d|Net |Component |Polygon |^Isolated copper/.test(c.text)) add(c.text);
  }
  for (const r of rules) if (counts.has(r.heading)) r.count = counts.get(r.heading);
  total = stated.size ? [...stated.values()].reduce((x, y) => x + y, 0) : totals.length ? totals.reduce((x, y) => x + y, 0) : undefined;
  return { file, format: 'html', rules, total };
}

/* ─── Matching ────────────────────────────────────────────────────────────────────────── */

const isFree = (n?: string) => !n || /^free-/i.test(n);
function sameObject(a: DrcObject, b: DrcObject): boolean {
  if (a.kind !== b.kind && !(/Region/.test(a.kind) && /Region/.test(b.kind))) return false;
  if (a.kind === 'Pad' && !(isFree(a.name) || isFree(b.name)) && a.name !== b.name) return false;
  if (a.kind === 'DeadPlaneCopper' || a.kind === 'PlaneIsland') return a.name === b.name && a.layer === b.layer && Math.abs(a.at[0]! - b.at[0]!) <= Math.max(a.tol, b.tol);
  if ((a.kind === 'Component' || a.kind === 'Net' || a.kind === 'Polygon' || a.kind === 'Text') && a.name !== undefined && b.name !== undefined && a.name !== b.name) return false;
  if (/Region/.test(a.kind)) return a.layer === b.layer;
  if (a.at.length !== b.at.length) return !a.at.length || !b.at.length;
  const tol = Math.max(a.tol, b.tol) + 1e-6;
  const near = (p: number[], q: number[]) => p.every((v, k) => Math.abs(v - q[k]!) <= tol);
  if (near(a.at, b.at)) return true;
  // A track's or fill's two ends either way round
  if (a.at.length === 4) return near(a.at, [b.at[2]!, b.at[3]!, b.at[0]!, b.at[1]!]);
  return false;
}
/** Whether two violations name the same objects (order aside; a net named by one and not the other aside). */
function sameViolation(a: DrcEntry, b: DrcEntry): boolean {
  const oa = a.objects.filter((o) => o.kind !== 'Net'), ob = b.objects.filter((o) => o.kind !== 'Net');
  if (!oa.length || !ob.length) return a.text === b.text;
  // SMD Neck-Down is reported once for each pad, naming one of the pad's too-wide tracks by the
  // checker's own order (the suite's is not the widest): the pad makes the violation
  if (a.kind === 'SMDNeckDown' && b.kind === 'SMDNeckDown') {
    const pa = oa.find((o) => o.kind === 'Pad'), pb = ob.find((o) => o.kind === 'Pad');
    if (pa && pb) return sameObject(pa, pb);
  }
  // A region's own corner (Acute Angle) is told from its others by the angle alone
  if (oa.length === 1 && ob.length === 1 && /Region/.test(oa[0]!.kind) && /Region/.test(ob[0]!.kind)) {
    const ang = (e: DrcEntry) => /\(Angle = ([\d.]+)/.exec(e.text)?.[1];
    if (ang(a) && ang(b) && Math.abs(Number(ang(a)) - Number(ang(b))) > 0.0015) return false;
  }
  if (oa.length !== ob.length) return false;
  const used = new Set<number>();
  return oa.every((x) => { const k = ob.findIndex((y, j) => !used.has(j) && sameObject(x, y)); if (k < 0) return false; used.add(k); return true; });
}
const shares = (a: DrcEntry, b: DrcEntry) => a.objects.some((x) => x.kind !== 'Net' && b.objects.some((y) => sameObject(x, y)));

export interface KindDiff { kind: string; suite: DrcEntry[]; konium: DrcEntry[]; matched: number; onlySuite: DrcEntry[]; onlyKonium: DrcEntry[]; suiteRules: DrcRuleBlock[]; koniumRules: DrcRuleBlock[] }

export function compare(suite: ParsedReport, konium: ParsedReport): KindDiff[] {
  const kinds = [...new Set([...suite.rules, ...konium.rules].map((r) => r.kind))];
  return kinds.map((kind) => {
    const sr = suite.rules.filter((r) => r.kind === kind), kr = konium.rules.filter((r) => r.kind === kind);
    const s = sr.flatMap((r) => r.entries), k = kr.flatMap((r) => r.entries);
    const taken = new Set<number>(), onlySuite: DrcEntry[] = [];
    let matched = 0;
    for (const a of s) {
      const j = k.findIndex((b, n) => !taken.has(n) && sameViolation(a, b));
      if (j < 0) onlySuite.push(a); else { taken.add(j); matched++; }
    }
    return { kind, suite: s, konium: k, matched, onlySuite, onlyKonium: k.filter((_, n) => !taken.has(n)), suiteRules: sr, koniumRules: kr };
  }).sort((a, b) => (b.onlySuite.length + b.onlyKonium.length) - (a.onlySuite.length + a.onlyKonium.length) || a.kind.localeCompare(b.kind));
}

/** The comparison as text. */
export function compareText(suite: ParsedReport, konium: ParsedReport, max = Infinity): string {
  const diffs = compare(suite, konium);
  const n = (r: ParsedReport) => r.rules.reduce((x, b) => x + b.entries.length, 0);
  const out: string[] = [
    `Suite:  ${suite.file} (${suite.format}, ${suite.rules.length} rules, ${n(suite)} violations${suite.total !== undefined && suite.total !== n(suite) ? `; it says ${suite.total}` : ''})`,
    `Konium: ${konium.file} (${konium.format}, ${konium.rules.length} rules, ${n(konium)} violations${konium.total !== undefined && konium.total !== n(konium) ? `; it says ${konium.total}` : ''})`,
    '',
  ];
  const w = Math.max(24, ...diffs.map((d) => d.kind.length));
  const row = (a: string, ...c: (string | number)[]) => `${a.padEnd(w)} ${c.map((x) => String(x).padStart(8)).join(' ')}`;
  out.push(row('Rule kind', 'Suite', 'Konium', 'Matched', 'Suite+', 'Konium+'));
  for (const d of diffs) out.push(row(d.kind, d.suiteRules.length ? d.suite.length : '-', d.koniumRules.length ? d.konium.length : '-', d.matched, d.onlySuite.length, d.onlyKonium.length));
  const sum = (f: (d: KindDiff) => number) => diffs.reduce((x, d) => x + f(d), 0);
  out.push(row('Total', sum((d) => d.suite.length), sum((d) => d.konium.length), sum((d) => d.matched), sum((d) => d.onlySuite.length), sum((d) => d.onlyKonium.length)));
  out.push('', '(Suite+ / Konium+: violations only that report has; "-": no rule of the kind in that report.)');
  for (const d of diffs) {
    if (!d.onlySuite.length && !d.onlyKonium.length) continue;
    out.push('', `== ${d.kind}: suite ${d.suite.length}, Konium ${d.konium.length}, matched ${d.matched} ==`);
    for (const r of d.suiteRules) out.push(`   suite:  ${r.heading} (${r.entries.length})`);
    for (const r of d.koniumRules) out.push(`   Konium: ${r.heading} (${r.entries.length})`);
    const list = (title: string, mine: DrcEntry[], other: DrcEntry[]) => {
      if (!mine.length) return;
      out.push(`  ${title} (${mine.length}):`);
      for (const e of mine.slice(0, max)) {
        out.push(`    ${e.text}`);
        const rel = other.find((o) => shares(e, o));
        if (rel) out.push(`      ~ the other has: ${rel.text}`);
      }
      if (mine.length > max) out.push(`    … and ${mine.length - max} more`);
    };
    // Beside each, a violation of the other report naming one of its objects (any kind of rule)
    const allK = konium.rules.flatMap((r) => r.entries), allS = suite.rules.flatMap((r) => r.entries);
    list('Only the suite found', d.onlySuite, allK);
    list('Only Konium found', d.onlyKonium, allS);
  }
  return `${out.join('\n')}\n`;
}

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const max = maxAt >= 0 ? Number(args.splice(maxAt, 2)[1]) : Infinity;
if (args.length >= 2) {
  const read = (f: string) => { const b = readFileSync(f); return b[0] === 0xff && b[1] === 0xfe ? new TextDecoder('utf-16le').decode(b) : new TextDecoder('utf-8').decode(b); };
  const suite = parseReport(read(args[0]!), basename(args[0]!)), konium = parseReport(read(args[1]!), basename(args[1]!));
  process.stdout.write(compareText(suite, konium, max));
} else if (!process.env.VITEST) console.log('usage: npx vite-node tests/tools/drcCompare.ts <suite report .drc/.txt/.html> <konium .txt> [--max n]');
