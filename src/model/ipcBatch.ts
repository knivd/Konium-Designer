/**
 * The IPC batch generator's table: CSV (comma, semicolon or tab separated) with a heading row;
 * each row a package — Family, Name, Density and the dimensions by heading (millimetres), the
 * rest from the family's defaults.
 */
import { ipcDefaults, IPC_FAMILIES, type Density, type IpcFamily, type IpcSpec } from './ipcFootprint';

const RANGE_KEYS: [string, keyof IpcSpec][] = [['bodyd', 'bodyD'], ['bodye', 'bodyE'], ['span2', 'span2'], ['span', 'span'], ['term', 'term'], ['leadw', 'leadW']];
const NUM_KEYS: [string, keyof IpcSpec][] = [['height', 'height'], ['pitch', 'pitch'], ['pinsside', 'pinsSide'], ['pins', 'pins'], ['tabw', 'tabW'], ['tabl', 'tabL'], ['ball', 'ball'], ['rows', 'rows'], ['cols', 'cols']];

function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function readIpcBatch(text: string): { spec: IpcSpec; name: string; error?: string }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];
  const sep = [',', ';', '\t'].map((s) => [s, lines[0]!.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const head = cells(lines[0]!, sep).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const families = new Set(IPC_FAMILIES.map(([f]) => f));
  return lines.slice(1).map((line) => {
    const c = cells(line, sep);
    const get = (k: string) => { const i = head.indexOf(k); return i >= 0 ? c[i] ?? '' : ''; };
    const fam = get('family').toUpperCase() as IpcFamily;
    if (!families.has(fam)) return { spec: ipcDefaults('SOIC'), name: get('name'), error: `Unknown family "${get('family')}"` };
    const spec = ipcDefaults(fam);
    const dens = get('density').toUpperCase();
    if (dens === 'M' || dens === 'N' || dens === 'L') spec.density = dens as Density;
    if (get('prefix')) spec.prefix = get('prefix').toUpperCase();
    const bad: string[] = [];
    const num = (s: string, what: string) => { const v = Number(s); if (!Number.isFinite(v) || v < 0) { bad.push(what); return undefined; } return v; };
    for (const [k, field] of RANGE_KEYS) {
      const lo = get(`${k}min`), hi = get(`${k}max`);
      const r = { ...(spec[field] as { min: number; max: number }) };
      if (lo) r.min = num(lo, `${k}Min`) ?? r.min;
      if (hi) r.max = num(hi, `${k}Max`) ?? r.max;
      if (r.min > r.max) bad.push(`${k}: min above max`);
      (spec as unknown as Record<string, unknown>)[field] = r;
    }
    for (const [k, field] of NUM_KEYS) { const v = get(k); if (v) { const n = num(v, k); if (n !== undefined) (spec as unknown as Record<string, unknown>)[field] = field === 'pins' || field === 'pinsSide' || field === 'rows' || field === 'cols' ? Math.round(n) : n; } }
    if (fam === 'BGA' && get('rows') && get('cols') && !get('pins')) spec.pins = spec.rows * spec.cols;
    return { spec, name: get('name'), error: bad.length ? `Bad ${bad.join(', ')}` : undefined };
  });
}
