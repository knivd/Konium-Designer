/**
 * KiCad libraries round trip, measured: every symbol library (.kicad_sym) and footprint library
 * (a folder of .kicad_mod files) under a folder read by Konium Designer's importer as a SchLib or
 * PcbLib, written back by its exporter, and compared symbol by symbol and footprint by footprint.
 *
 *   npx vite-node tests/tools/kicadLibRoundTrip.ts <folder> [<out folder>] [--max n]
 *
 * A symbol's or footprint's items are compared whole (every setting, uuids aside, lists in any
 * order): its pins, graphics, texts, fields (properties) and settings for a symbol (a unit's items
 * by its unit and style); its pads, graphics, texts, fields, attributes and models for a footprint.
 * KiCad 8's and 9's ways of writing the same thing are the same (a bare flag or (flag yes), an
 * empty field or none, fp_text reference or the Reference property).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importKicad } from '../../src/formats/kicad/project';
import { exportKicad } from '../../src/formats/kicad/export';
import { readSchLib } from '../../src/formats/altium/schlib';
import { deriveSheet } from '../../src/model/sch';
import { openPcbLib } from '../../src/model/pcbLib';
import { kicadName } from '../../src/formats/kicad/write';
import { parseSexpr, kids, str, type SList } from '../../src/formats/kicad/sexpr';
import { footprintItems, symbolItems, type Items } from './kicadItems';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 4;
const [dir, out] = args.filter((a, i) => !a.startsWith('--') && (maxAt < 0 || i !== maxAt + 1));
if (!dir) { console.error('usage: kicadLibRoundTrip.ts <folder> [<out folder>] [--max n]'); process.exit(2); }
const td = new TextDecoder();
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/* ─── Compare ─── */

interface Tally { before: number; after: number; same: number; lost: number; added: number; ex: string[] }
const totals = new Map<string, Tally>();
const tally = (k: string) => { let t = totals.get(k); if (!t) { t = { before: 0, after: 0, same: 0, lost: 0, added: 0, ex: [] }; totals.set(k, t); } return t; };

function compare(kind: string, a: Map<string, SList>, b: Map<string, SList>, items: (n: SList) => Items): void {
  const top = tally(kind);
  top.before += a.size; top.after += b.size;
  for (const [name, an] of a) {
    // (a name with a library's in it, as a rescue library has them: by its own)
    const own = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const bn = b.get(kicadName(name)) ?? b.get(name) ?? b.get(own) ?? b.get(kicadName(own));
    if (!bn) { top.lost++; if (top.ex.length < MAX) top.ex.push(`lost ${name}`); continue; }
    const ai = items(an), bi = items(bn);
    let same = true;
    for (const k of new Set([...ai.keys(), ...bi.keys()])) {
      const t = tally(`${kind} ${k}`);
      const pool = [...(bi.get(k) ?? [])];
      const xs = ai.get(k) ?? [];
      t.before += xs.length; t.after += pool.length;
      const lost: string[] = [];
      for (const x of xs) { const i = pool.indexOf(x); if (i >= 0) { pool.splice(i, 1); t.same++; } else lost.push(x); }
      t.lost += lost.length; t.added += pool.length;
      if (lost.length || pool.length) { same = false; if (t.ex.length < MAX) t.ex.push(`[${name}] ${(lost[0] ?? '(none)').slice(0, 150)}  ->  ${(pool[0] ?? '(none)').slice(0, 150)}`); }
    }
    if (same) top.same++;
  }
  const ownOf = (x: string) => (x.includes(':') ? x.slice(x.indexOf(':') + 1) : x);
  top.added += [...b.keys()].filter((n) => ![...a.keys()].some((x) => kicadName(x) === n || x === n || ownOf(x) === n || kicadName(ownOf(x)) === n)).length;
}

/* ─── Main ─── */

const all = walk(dir);
const symLibs = all.filter((p) => /\.kicad_sym$/i.test(p));
const fpDirs = [...new Set(all.filter((p) => /\.kicad_mod$/i.test(p)).map((p) => p.replace(/[\\/][^\\/]+$/, '')))];
const report: string[] = [`KiCad libraries round trip: ${relative(process.cwd(), dir) || dir}: ${symLibs.length} symbol libraries, ${fpDirs.length} footprint libraries`];
const t0 = Date.now();

for (const p of symLibs) {
  const name = p.split(/[\\/]/).pop()!.replace(/\.kicad_sym$/i, '');
  const text = readFileSync(p, 'utf8');
  try {
    const r = await importKicad([{ path: `libs/${name}.kicad_sym`, bytes: new TextEncoder().encode(text) }]);
    const lib = r.libraries.find((l) => /\.schlib$/i.test(l.name));
    if (!lib) { report.push(`  ${name}.kicad_sym: not read (${r.messages.map((m) => m.message).join('; ').slice(0, 200)})`); continue; }
    const l = readSchLib(lib.bytes, lib.name), sh = deriveSheet(l.header);
    const res = exportKicad({ name: 'back', sheets: [], schLibs: [{ name: lib.name, symbols: l.symbols.map((x) => ({ libRef: x.libRef, bags: x.bags })), fonts: sh.fonts, systemFont: sh.systemFont }] });
    const f = res.files.find((x) => x.path.endsWith('.kicad_sym'))!;
    if (out) { const o = join(out, `${name}.kicad_sym`); mkdirSync(out, { recursive: true }); writeFileSync(o, f.bytes); }
    const named = (t: SList) => new Map(kids(t, 'symbol').map((s) => [str(s) ?? '', s] as [string, SList]));
    compare('symbol', named(parseSexpr(text)), named(parseSexpr(td.decode(f.bytes))), symbolItems);
  } catch (e) { report.push(`  ${name}.kicad_sym: failed (${(e as Error).message})`); }
}
for (const d of fpDirs) {
  const name = d.split(/[\\/]/).pop()!.replace(/\.pretty$/i, '');
  const mods = all.filter((p) => p.startsWith(`${d}/`) && /\.kicad_mod$/i.test(p) && !p.slice(d.length + 1).includes('/'));
  try {
    const r = await importKicad(mods.map((p) => ({ path: `libs/${name}.pretty/${p.split('/').pop()}`, bytes: new Uint8Array(readFileSync(p)) })));
    const lib = r.libraries.find((l) => /\.pcblib$/i.test(l.name));
    if (!lib) { report.push(`  ${name}.pretty: not read (${r.messages.map((m) => m.message).join('; ').slice(0, 200)})`); continue; }
    const res = exportKicad({ name: 'back', sheets: [], pcbLibs: [openPcbLib(lib.bytes, lib.name)] });
    const a = new Map(mods.map((p) => { const t = parseSexpr(readFileSync(p, 'utf8')); return [str(t) ?? p.split('/').pop()!.replace(/\.kicad_mod$/i, ''), t] as [string, SList]; }));
    const b = new Map(res.files.filter((x) => x.path.endsWith('.kicad_mod')).map((x) => { const t = parseSexpr(td.decode(x.bytes)); return [str(t) ?? '', t] as [string, SList]; }));
    if (out) for (const x of res.files.filter((y) => y.path.endsWith('.kicad_mod'))) { const o = join(out, `${name}.pretty`, x.path.split('/').pop()!); mkdirSync(join(out, `${name}.pretty`), { recursive: true }); writeFileSync(o, x.bytes); }
    compare('footprint', a, b, footprintItems);
  } catch (e) { report.push(`  ${name}.pretty: failed (${(e as Error).message})`); }
}

report.push(`${Date.now() - t0} ms\n`);
report.push(`${'Kind'.padEnd(28)} ${['Before', 'Back', 'Same', 'Lost', 'Added'].map((h) => h.padStart(8)).join('')}`);
for (const [k, t] of [...totals].sort((p, q) => p[0].localeCompare(q[0]))) {
  report.push(`${k.padEnd(28)} ${[t.before, t.after, t.same, t.lost, t.added].map((v) => String(v).padStart(8)).join('')}`);
  for (const x of t.ex) report.push(`      ${x}`);
}
console.log(report.join('\n'));
