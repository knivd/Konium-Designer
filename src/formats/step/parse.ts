/**
 * ISO 10303-21 (STEP physical file) reader: the DATA section as entity instances by id.
 * Values: numbers; references as {r}; enumerations as {e}; strings as {s}; $ and * as null;
 * lists as arrays; typed values such as LENGTH_MEASURE(1.0) as {t, a}. A complex instance
 * (#1=(A(..)B(..));) has type '' and its parts by name.
 */
export type StepVal = number | { r: number } | { e: string } | { s: string } | { t: string; a: StepVal[] } | null | StepVal[];
export interface StepEntity { type: string; args: StepVal[]; parts?: Map<string, StepVal[]> }
export type StepFile = Map<number, StepEntity>;

export const isRef = (v: StepVal | undefined): v is { r: number } => !!v && typeof v === 'object' && 'r' in v;
export const refOf = (v: StepVal | undefined): number => (isRef(v) ? v.r : -1);
export const num = (v: StepVal | undefined, d = 0): number => (typeof v === 'number' ? v : v && typeof v === 'object' && 't' in v && typeof v.a[0] === 'number' ? v.a[0] : d);
export const bool = (v: StepVal | undefined): boolean => !!v && typeof v === 'object' && 'e' in v && v.e === 'T';
export const list = (v: StepVal | undefined): StepVal[] => (Array.isArray(v) ? v : []);
export const str = (v: StepVal | undefined): string => (v && typeof v === 'object' && 's' in v ? v.s : '');

/** The arguments of an entity as one of its types (the whole instance, or that part of a complex one). */
export function argsOf(e: StepEntity | undefined, type: string): StepVal[] | undefined {
  if (!e) return undefined;
  if (e.type === type) return e.args;
  return e.parts?.get(type);
}
export const typeIs = (e: StepEntity | undefined, type: string) => !!e && (e.type === type || !!e.parts?.has(type));

export function parseStep(text: string): StepFile {
  const out: StepFile = new Map();
  let i = text.indexOf('DATA;');
  if (i < 0) throw new Error('not a STEP file (no DATA section)');
  i += 5;
  const n = text.length;
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) { i++; continue; }
      if (c === 47 && text.charCodeAt(i + 1) === 42) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      return;
    }
  };
  const ident = (): string => {
    const s = i;
    for (;;) {
      const c = text.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45) i++; else break;
    }
    return text.slice(s, i).toUpperCase();
  };
  const value = (): StepVal => {
    ws();
    const c = text.charCodeAt(i);
    if (c === 35) { // #
      i++;
      let v = 0;
      for (let d = text.charCodeAt(i); d >= 48 && d <= 57; d = text.charCodeAt(++i)) v = v * 10 + d - 48;
      return { r: v };
    }
    if (c === 39) { // 'string', '' escapes
      let s = '';
      i++;
      for (;;) {
        const e = text.indexOf("'", i);
        if (e < 0) { s += text.slice(i); i = n; break; }
        s += text.slice(i, e);
        i = e + 1;
        if (text.charCodeAt(i) === 39) { s += "'"; i++; continue; }
        break;
      }
      return { s };
    }
    if (c === 40) return listOf();
    if (c === 36 || c === 42) { i++; return null; } // $ *
    if (c === 46) { // .ENUM.
      const e = text.indexOf('.', i + 1);
      if (e < 0) { i = n; return null; } // a broken file: no end to it
      const v = text.slice(i + 1, e);
      i = e + 1;
      return { e: v.toUpperCase() };
    }
    if (c === 34) { const e = text.indexOf('"', i + 1); if (e < 0) { i = n; return null; } const v = text.slice(i + 1, e); i = e + 1; return { s: v }; } // binary
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      const s = i;
      i++;
      for (let d = text.charCodeAt(i); (d >= 48 && d <= 57) || d === 46 || d === 69 || d === 101 || d === 45 || d === 43; d = text.charCodeAt(++i));
      return parseFloat(text.slice(s, i));
    }
    // A typed value: NAME(args)
    const t = ident();
    if (!t) { if (i < n) i++; return null; } // junk where a value should be
    ws();
    if (text.charCodeAt(i) === 40) return { t, a: listOf() };
    return { e: t };
  };
  const listOf = (): StepVal[] => {
    const a: StepVal[] = [];
    i++; // (
    ws();
    if (text.charCodeAt(i) === 41) { i++; return a; }
    for (;;) {
      a.push(value());
      ws();
      const c = text.charCodeAt(i);
      if (c === 44) { i++; continue; }
      if (c === 41) { i++; return a; }
      if (i >= n) return a;
      i++; // tolerate junk
    }
  };
  while (i < n) {
    ws();
    const c = text.charCodeAt(i);
    if (c !== 35) {
      if (text.startsWith('ENDSEC', i)) break;
      const e = text.indexOf(';', i);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    i++;
    let id = 0;
    for (let d = text.charCodeAt(i); d >= 48 && d <= 57; d = text.charCodeAt(++i)) id = id * 10 + d - 48;
    ws();
    if (text.charCodeAt(i) !== 61) { const e = text.indexOf(';', i); i = e < 0 ? n : e + 1; continue; }
    i++;
    ws();
    if (text.charCodeAt(i) === 40) {
      // Complex instance: (A(..) B(..) ...)
      i++;
      const parts = new Map<string, StepVal[]>();
      for (;;) {
        ws();
        if (text.charCodeAt(i) === 41) { i++; break; }
        if (i >= n) break;
        const t = ident();
        if (!t) { i++; continue; } // junk between the parts
        ws();
        parts.set(t, text.charCodeAt(i) === 40 ? listOf() : []);
      }
      out.set(id, { type: '', args: [], parts });
    } else {
      const t = ident();
      ws();
      out.set(id, { type: t, args: text.charCodeAt(i) === 40 ? listOf() : [] });
    }
    const e = text.indexOf(';', i);
    i = e < 0 ? n : e + 1;
  }
  return out;
}
