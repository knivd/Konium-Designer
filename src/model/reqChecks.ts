/**
 * Requirements checked against the design: a requirement can carry a check of something the
 * design can be measured for (its copper layers, the board's size and thickness, how tall the
 * parts stand, how many parts and BOM lines, the parts' cost per board at a quantity, the parts'
 * operating temperature, the narrowest track and the smallest hole, the design rules and the
 * compile, the enclosure's size), each compared with the requirement's figure. A check passes,
 * fails, or can't be told yet (the board isn't there, a part has no temperature range, prices
 * aren't known); it can set the requirement's verification as it goes.
 */

export type CheckQ = 'layers' | 'boardSize' | 'thickness' | 'heightTop' | 'heightBottom' | 'parts' | 'bomLines' | 'cost' | 'temperature' | 'track' | 'hole' | 'drc' | 'erc' | 'enclosure';
export type CheckOp = '<=' | '>=' | '=';

export interface ReqCheck {
  q: CheckQ;
  /** At most, at least, exactly (where the measure takes one). */
  op: CheckOp;
  /** The figure (and the second and third, for sizes and ranges: width × height × depth, minimum to maximum). */
  a: number; b?: number; c?: number;
  /** The quantity of boards a cost is for. */
  qty?: number;
  /** The requirement's verification follows the check (Verified when it passes, Failed when it fails). */
  follow: boolean;
}

/** What each check measures: its name, unit, the comparisons it takes, the figures it needs. */
export interface CheckKind { q: CheckQ; name: string; unit: string; ops: CheckOp[] | 'fits' | 'covers' | 'none'; figures: number; hint: string }
export const CHECKS: CheckKind[] = [
  { q: 'layers', name: 'Copper layers', unit: '', ops: ['<=', '>=', '='], figures: 1, hint: 'The board\'s copper layers' },
  { q: 'boardSize', name: 'Board fits within', unit: 'mm', ops: 'fits', figures: 2, hint: 'The board\'s extent fits within width × height, either way round' },
  { q: 'thickness', name: 'Board thickness', unit: 'mm', ops: ['<=', '>=', '='], figures: 1, hint: 'The board\'s thickness, from its layer stack' },
  { q: 'heightTop', name: 'Tallest part on top', unit: 'mm', ops: ['<='], figures: 1, hint: 'How far the tallest part stands above the board\'s top' },
  { q: 'heightBottom', name: 'Tallest part underneath', unit: 'mm', ops: ['<='], figures: 1, hint: 'How far the tallest part stands below the board' },
  { q: 'parts', name: 'Parts', unit: '', ops: ['<=', '>=', '='], figures: 1, hint: 'Parts in the BOM (the compiled design)' },
  { q: 'bomLines', name: 'Different parts (BOM lines)', unit: '', ops: ['<=', '>=', '='], figures: 1, hint: 'Lines in the BOM: different parts to buy' },
  { q: 'cost', name: 'Parts cost per board', unit: '', ops: ['<='], figures: 1, hint: 'The parts\' cost per board at the quantity given, from the BOM document\'s prices' },
  { q: 'temperature', name: 'Parts work across', unit: '°C', ops: 'covers', figures: 2, hint: 'Every part\'s operating temperature range (its parameters) covers minimum to maximum' },
  { q: 'track', name: 'Narrowest track', unit: 'mm', ops: ['>='], figures: 1, hint: 'The narrowest copper track or arc on the board' },
  { q: 'hole', name: 'Smallest hole', unit: 'mm', ops: ['>='], figures: 1, hint: 'The smallest drilled hole (pads and vias)' },
  { q: 'drc', name: 'Design rules: no violations', unit: '', ops: 'none', figures: 0, hint: 'The board\'s design rule check finds no violations' },
  { q: 'erc', name: 'Compile: no errors', unit: '', ops: 'none', figures: 0, hint: 'Compiling the project finds no errors' },
  { q: 'enclosure', name: 'Enclosure fits within', unit: 'mm', ops: 'fits', figures: 3, hint: 'The project\'s enclosure fits within width × depth × height, any way round' },
];
export const checkKind = (q: CheckQ): CheckKind => CHECKS.find((k) => k.q === q) ?? CHECKS[0]!;

/** A new check of a kind: its first comparison, figures to fill in. */
export function newCheck(q: CheckQ): ReqCheck {
  const k = checkKind(q);
  const op: CheckOp = Array.isArray(k.ops) ? k.ops[0]! : '<=';
  const base: ReqCheck = { q, op, a: 0, follow: true };
  switch (q) {
    case 'layers': return { ...base, a: 4 };
    case 'boardSize': return { ...base, a: 100, b: 80 };
    case 'thickness': return { ...base, op: '=', a: 1.6 };
    case 'heightTop': return { ...base, a: 10 };
    case 'heightBottom': return { ...base, a: 3 };
    case 'parts': return { ...base, a: 50 };
    case 'bomLines': return { ...base, a: 20 };
    case 'cost': return { ...base, a: 10, qty: 100 };
    case 'temperature': return { ...base, a: -20, b: 70 };
    case 'track': return { ...base, op: '>=', a: 0.15 };
    case 'hole': return { ...base, op: '>=', a: 0.3 };
    case 'enclosure': return { ...base, a: 120, b: 80, c: 40 };
    default: return base;
  }
}

/** A check as read (none when it isn't one). */
export function normaliseCheck(o: unknown): ReqCheck | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Record<string, unknown>;
  if (!CHECKS.some((k) => k.q === x.q)) return undefined;
  const k = checkKind(x.q as CheckQ);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const d = newCheck(k.q);
  const op = Array.isArray(k.ops) && k.ops.includes(x.op as CheckOp) ? (x.op as CheckOp) : d.op;
  const c: ReqCheck = { q: k.q, op, a: num(x.a, d.a), follow: x.follow !== false };
  if (k.figures >= 2) c.b = num(x.b, d.b ?? 0);
  if (k.figures >= 3) c.c = num(x.c, d.c ?? 0);
  if (k.q === 'cost') c.qty = Math.max(1, Math.round(num(x.qty, d.qty ?? 1)));
  return c;
}

/** What the design measures, as far as it's known (undefined: not known, or no board, BOM or enclosure to measure). */
export interface DesignFacts {
  board?: { name: string; layers: number; w: number; h: number; thickness: number; top: number; bottom: number; track?: number; hole?: number } | null;
  /** The compiled design: its parts (in the BOM), its BOM lines and its errors. */
  design?: { parts: number; lines: number; errors: number } | null;
  /** Each part's operating temperature range, when its parameters give one. */
  temps?: { designator: string; min?: number; max?: number }[] | null;
  /** The parts' cost per board for a quantity of boards (lines priced of all). */
  costAt?: ((qty: number) => { perBoard: number; currency: string; priced: number; lines: number } | null) | null;
  /** Design rule violations (undefined: not checked yet). */
  drc?: number;
  /** The project's enclosures: each one's outside size. */
  enclosures?: { name: string; w: number; d: number; h: number }[];
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';
export interface CheckResult { status: CheckStatus; measured: string; detail?: string }

const n = (v: number, dp = 2) => String(Math.round(v * 10 ** dp) / 10 ** dp);
const OPS: Record<CheckOp, string> = { '<=': '≤', '>=': '≥', '=': '=' };
/** A check as words: "Copper layers ≤ 4", "Board fits within 50 × 30 mm", "Parts work across −20 to 70 °C". */
export function checkWords(c: ReqCheck, currency = ''): string {
  const k = checkKind(c.q), u = k.unit ? ` ${k.unit}` : '';
  switch (k.ops) {
    case 'none': return k.name;
    case 'fits': return `${k.name} ${[c.a, c.b, c.c].slice(0, k.figures).map((v) => n(v ?? 0)).join(' × ')}${u}`;
    case 'covers': return `${k.name} ${n(c.a)} to ${n(c.b ?? 0)}${u}`;
    default: return c.q === 'cost' ? `${k.name} ${OPS[c.op]} ${currency}${n(c.a)} at ${c.qty ?? 1} off` : `${k.name} ${OPS[c.op]} ${n(c.a)}${u}`;
  }
}

const cmp = (v: number, op: CheckOp, a: number, tol = 1e-6): boolean => (op === '<=' ? v <= a + tol : op === '>=' ? v >= a - tol : Math.abs(v - a) <= Math.max(tol, Math.abs(a) * 0.005));
const fits = (have: number[], room: number[]): boolean => {
  const hs = [...have].sort((x, y) => x - y), rs = [...room].sort((x, y) => x - y);
  return hs.every((h, i) => h <= rs[i]! + 1e-6);
};
const unknown = (why: string): CheckResult => ({ status: 'unknown', measured: '', detail: why });

/** A check against the design as it is now. */
export function evalCheck(c: ReqCheck, f: DesignFacts): CheckResult {
  const b = f.board;
  const one = (v: number | undefined, unit: string, dp = 2): CheckResult =>
    v === undefined ? unknown('Not measured') : { status: cmp(v, c.op, c.a, c.q === 'thickness' ? 0.01 : 1e-6) ? 'pass' : 'fail', measured: `${n(v, dp)}${unit}` };
  switch (c.q) {
    case 'layers': return b ? one(b.layers, b.layers === 1 ? ' layer' : ' layers', 0) : unknown('No board to measure');
    case 'boardSize': {
      if (!b) return unknown('No board to measure');
      return { status: fits([b.w, b.h], [c.a, c.b ?? 0]) ? 'pass' : 'fail', measured: `${n(b.w, 1)} × ${n(b.h, 1)} mm` };
    }
    case 'thickness': return b ? one(b.thickness, ' mm') : unknown('No board to measure');
    case 'heightTop': return b ? one(b.top, ' mm', 1) : unknown('No board to measure');
    case 'heightBottom': return b ? one(b.bottom, ' mm', 1) : unknown('No board to measure');
    case 'track': return !b ? unknown('No board to measure') : b.track === undefined ? unknown('The board has no tracks') : one(b.track, ' mm', 3);
    case 'hole': return !b ? unknown('No board to measure') : b.hole === undefined ? unknown('The board has no holes') : one(b.hole, ' mm', 3);
    case 'parts': return f.design ? one(f.design.parts, f.design.parts === 1 ? ' part' : ' parts', 0) : unknown('Compile the project');
    case 'bomLines': return f.design ? one(f.design.lines, f.design.lines === 1 ? ' line' : ' lines', 0) : unknown('Compile the project');
    case 'erc': return f.design ? { status: f.design.errors ? 'fail' : 'pass', measured: f.design.errors ? `${f.design.errors} error${f.design.errors === 1 ? '' : 's'}` : 'No errors' } : unknown('Compile the project');
    case 'drc': return f.drc === undefined ? unknown('No board checked yet') : { status: f.drc ? 'fail' : 'pass', measured: f.drc ? `${f.drc} violation${f.drc === 1 ? '' : 's'}` : 'No violations' };
    case 'cost': {
      const k = f.costAt?.(c.qty ?? 1);
      if (!k) return unknown('No BOM document with prices in the project');
      const m = `${k.currency}${n(k.perBoard)} per board at ${c.qty ?? 1} off`;
      if (k.priced < k.lines) return { status: k.perBoard > c.a + 1e-9 ? 'fail' : 'unknown', measured: m, detail: `${k.lines - k.priced} of ${k.lines} lines have no price yet` };
      return { status: k.perBoard <= c.a + 1e-9 ? 'pass' : 'fail', measured: m };
    }
    case 'temperature': {
      const ts = f.temps;
      if (!ts) return unknown('Compile the project');
      const lo = c.a, hi = c.b ?? c.a;
      const known = ts.filter((t) => t.min !== undefined && t.max !== undefined);
      const short = known.filter((t) => t.min! > lo + 1e-9 || t.max! < hi - 1e-9);
      const missing = ts.length - known.length;
      const span = known.length ? `${n(Math.max(...known.map((t) => t.min!)), 0)} to ${n(Math.min(...known.map((t) => t.max!)), 0)} °C` : 'No ranges';
      if (short.length) return { status: 'fail', measured: span, detail: `Not across it: ${short.slice(0, 6).map((t) => `${t.designator} (${n(t.min!, 0)} to ${n(t.max!, 0)} °C)`).join(', ')}${short.length > 6 ? ` and ${short.length - 6} more` : ''}` };
      if (missing) return { status: 'unknown', measured: span, detail: `${missing} part${missing === 1 ? ' has' : 's have'} no temperature range in ${missing === 1 ? 'its' : 'their'} parameters` };
      return { status: 'pass', measured: span };
    }
    case 'enclosure': {
      const e = f.enclosures ?? [];
      if (!e.length) return unknown('No enclosure in the project');
      const big = e.map((x) => ({ x, ok: fits([x.w, x.d, x.h], [c.a, c.b ?? 0, c.c ?? 0]) }));
      const worst = big.find((x) => !x.ok) ?? big[0]!;
      return { status: big.every((x) => x.ok) ? 'pass' : 'fail', measured: `${n(worst.x.w, 1)} × ${n(worst.x.d, 1)} × ${n(worst.x.h, 1)} mm`, detail: e.length > 1 ? worst.x.name : undefined };
    }
  }
}

/**
 * A part's operating temperature from its parameters' text: "-40°C ~ 85°C", "-40 to +85 °C",
 * "−55 … 125 °C" (none when there's no range in it).
 */
export function parseTempRange(text: string): { min: number; max: number } | null {
  const t = text.replace(/[−–—]/g, '-').replace(/\s+/g, ' ');
  const m = /([-+]?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*C?\s*(?:~|to|\.\.\.?|…|-(?=\s*[-+]?\d)|\/)\s*([-+]?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*C?/i.exec(t);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** The parameter that gives a part's operating temperature (its name says temperature), if any. */
export function tempParam(params: Record<string, string>): string | undefined {
  const keys = Object.keys(params);
  const k = keys.find((x) => /operating\s*temp/i.test(x)) ?? keys.find((x) => /temp(erature)?\s*range/i.test(x)) ?? keys.find((x) => /^temp(erature)?$/i.test(x.trim()));
  return k ? params[k] : undefined;
}
