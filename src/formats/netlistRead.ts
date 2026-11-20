/**
 * Design › Netlist › Load a Netlist (26.187): a netlist file read as the parts and nets it names,
 * whatever wrote it. The formats, told apart by what the file holds:
 *
 *   Protel       [ designator / footprint / comment ] blocks, ( net / pin lines ) blocks; pins as U1-3
 *   Protel 2     the same brackets with named fields (DESIGNATOR, FOOTPRINT, PARTTYPE, DESCRIPTION), after "PROTEL NETLIST 2.0"
 *   Tango        as Protel, pins as U1,3
 *   PADS         *PART* lines "R1 0805" (or "R1 10k@0805"), *NET* with *SIGNAL* name and pin lists "R1.1 C2.2"
 *   Telesis      $PACKAGES "footprint! device! value; R1 R2" and $NETS "name; R1.1 C2.2" (a comma carries a line on)
 *   KiCad        (export (components (comp (ref R1) (value 10k) (footprint Lib:Name))) (nets (net (name GND) (node (ref R1) (pin 1)))))
 *   P-CAD        ACCEL_ASCII: (compInst "R1" (originalName "…") (compValue "10k")), (net "GND" (node "R1" "1")), footprints by (attachedPattern …)
 *   Pcad         the older form in braces, as Netlist For Project › Pcad for PCB writes it: {I pattern.PRT R1 {CN pin net …}}
 *   MultiWire    PARTS (designator, footprint, comment in columns) and NETS (a name, its pins indented under it)
 *   EDIF         (edif …): its instances and nets (portRef … (instanceRef …)), the footprint a property of the instance
 *
 * What comes back is the netlist and no more: a part is a designator, a footprint's name and a
 * comment; a net is a name and its pins. Lines that could not be read are counted, not guessed at.
 */

export interface NetlistPart { designator: string; footprint: string; comment: string; description: string }
export interface NetlistNet { name: string; pins: { designator: string; pin: string }[] }
export interface ReadNetlist {
  /** The format it was taken for: 'NET' (the bracketed .NET netlist), 'NET 2' (its form with named fields), 'Tango', 'PADS', 'Telesis', 'KiCad', 'P-CAD', 'Pcad', 'MultiWire', 'EDIF'. */
  format: string;
  parts: NetlistPart[];
  nets: NetlistNet[];
  /** What was passed over, in a line each. */
  notes: string[];
}

/** Each format as the app names it. */
export const NETLIST_KINDS: Record<string, string> = { NET: 'Netlist (.NET)', 'NET 2': 'Netlist (.NET), version 2', Tango: 'Tango', PADS: 'PADS', Telesis: 'Telesis', KiCad: 'KiCad', 'P-CAD': 'P-CAD', Pcad: 'Pcad for PCB', MultiWire: 'MultiWire', EDIF: 'EDIF' };

const part = (designator: string, footprint = '', comment = '', description = ''): NetlistPart => ({ designator, footprint, comment, description });

/** A list in brackets as written with quotes and nested lists: KiCad's, P-CAD's and EDIF's files are these. */
type Sx = string | Sx[];
function sexpr(text: string): Sx[] {
  const root: Sx[] = [], stack: Sx[][] = [root];
  const n = text.length;
  for (let i = 0; i < n;) {
    const ch = text[i]!;
    if (ch === '(') { const list: Sx[] = []; stack[stack.length - 1]!.push(list); stack.push(list); i++; }
    else if (ch === ')') { if (stack.length > 1) stack.pop(); i++; }
    else if (ch === '"') {
      let s = '';
      for (i++; i < n && text[i] !== '"'; i++) { if (text[i] === '\\' && i + 1 < n) i++; s += text[i]; }
      i++;
      stack[stack.length - 1]!.push(s);
    } else if (/\s/.test(ch)) i++;
    else { let j = i; while (j < n && !/[\s()"]/.test(text[j]!)) j++; stack[stack.length - 1]!.push(text.slice(i, j)); i = j; }
  }
  return root;
}
const head = (x: Sx): string => (Array.isArray(x) && typeof x[0] === 'string' ? x[0].toLowerCase() : '');
const kids = (x: Sx, name: string): Sx[][] => (Array.isArray(x) ? (x.filter((k) => head(k) === name.toLowerCase()) as Sx[][]) : []);
const kid = (x: Sx, name: string): Sx[] | undefined => kids(x, name)[0];
const word = (x: Sx | undefined, at = 1): string => (Array.isArray(x) && typeof x[at] === 'string' ? (x[at] as string) : '');
/** Every list named `name` at any depth. */
function all(x: Sx, name: string, out: Sx[][] = []): Sx[][] {
  if (!Array.isArray(x)) return out;
  if (head(x) === name.toLowerCase()) out.push(x);
  for (const k of x) all(k, name, out);
  return out;
}

/** Which format a netlist file is ('' where it is none of them). */
export function netlistFormat(text: string): string {
  const t = text.replace(/^﻿/, ''), top = t.slice(0, 4000);
  if (/^\s*\(\s*export\b/i.test(top) && /\(\s*components\b/i.test(t)) return 'KiCad';
  if (/^\s*ACCEL_ASCII\b/i.test(top) || (/^\s*\(\s*asciiHeader/i.test(top) && /\(\s*netlist\b/i.test(t))) return 'P-CAD';
  if (/^\s*\(\s*edif\b/i.test(top)) return 'EDIF';
  if (/^\s*\{\s*COMPONENT\b/i.test(top) && /\{\s*I\s+\S+\s+\S+/.test(t)) return 'Pcad';
  if (/^\s*NETLIST\s*$/im.test(top) && /^PARTS\s*$/im.test(t) && /^NETS\s*$/im.test(t)) return 'MultiWire';
  if (/^\s*[!*]PADS-/im.test(top) || (/^\s*\*PART\*/im.test(t) && /^\s*\*NET\*/im.test(t))) return 'PADS';
  if (/^\s*\$PACKAGES\b/im.test(t) && /^\s*\$NETS\b/im.test(t)) return 'Telesis';
  if (/^\s*PROTEL NETLIST 2\.0/i.test(top)) return 'NET 2';
  if (/^\s*\[\s*$/m.test(t) && /^\s*\(\s*$/m.test(t)) {
    // Protel and Tango are the same brackets: Tango writes a pin as U1,3 and Protel as U1-3
    const pins = [...t.matchAll(/^\s*\(\s*\r?\n[^\r\n]*\r?\n([\s\S]*?)^\s*\)\s*$/gm)].flatMap((m) => m[1]!.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const commas = pins.filter((p) => /^[^\s,]+,[^\s,]+$/.test(p)).length;
    return commas > pins.length / 2 ? 'Tango' : 'NET';
  }
  return '';
}

/** A pin written as one word: the designator and the pin either side of the last mark (U1-3, U1,3, U1.3; J1-A-3 is J1-A, 3). */
function pinOf(w: string, marks: string): { designator: string; pin: string } | null {
  let at = -1;
  for (const m of marks) at = Math.max(at, w.lastIndexOf(m));
  return at > 0 && at < w.length - 1 ? { designator: w.slice(0, at), pin: w.slice(at + 1) } : null;
}

function readBracketed(text: string, tango: boolean): ReadNetlist {
  const out: ReadNetlist = { format: tango ? 'Tango' : 'NET', parts: [], nets: [], notes: [] };
  const lines = text.split(/\r?\n/);
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l === '[') {
      const block: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== ']'; i++) block.push(lines[i]!.trim());
      if (block[0]) out.parts.push(part(block[0], block[1] ?? '', block[2] ?? ''));
    } else if (l === '(') {
      const block: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== ')'; i++) if (lines[i]!.trim()) block.push(lines[i]!.trim());
      if (!block.length) continue;
      const net: NetlistNet = { name: block[0]!, pins: [] };
      for (const w of block.slice(1)) { const p = pinOf(w.split(/\s+/)[0]!, tango ? ',-' : '-,'); if (p) net.pins.push(p); else skipped++; }
      out.nets.push(net);
    }
  }
  if (skipped) out.notes.push(`${skipped} pin line${skipped === 1 ? '' : 's'} could not be read`);
  return out;
}

function readNamed(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'NET 2', parts: [], nets: [], notes: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '[') {
      // Field names each on a line, each followed by its value's line
      const f = new Map<string, string>();
      for (i++; i < lines.length && lines[i] !== ']'; i++) { const k = lines[i]!.toUpperCase(); if (/^[A-Z][A-Z0-9 ]*$/.test(k) && i + 1 < lines.length && lines[i + 1] !== ']') { f.set(k, lines[i + 1]!); i++; } }
      const d = f.get('DESIGNATOR');
      if (d) out.parts.push(part(d, f.get('FOOTPRINT') ?? '', f.get('PARTTYPE') ?? '', f.get('DESCRIPTION') ?? ''));
    } else if (lines[i] === '(') {
      const block: string[] = [];
      for (i++; i < lines.length && lines[i] !== ')'; i++) if (lines[i]) block.push(lines[i]!);
      if (!block.length) continue;
      const net: NetlistNet = { name: block[0]!, pins: [] };
      // (each pin's line: U1-3, then the pin's name and its type)
      for (const w of block.slice(1)) { const p = pinOf(w.split(/\s+/)[0]!, '-'); if (p) net.pins.push(p); else skipped++; }
      out.nets.push(net);
    }
  }
  if (skipped) out.notes.push(`${skipped} pin line${skipped === 1 ? '' : 's'} could not be read`);
  return out;
}

function readPads(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'PADS', parts: [], nets: [], notes: [] };
  let section = '', net: NetlistNet | null = null, skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || /^\*REMARK\*/i.test(l) || /^[!*]PADS-/i.test(l)) continue;
    const mark = /^\*([A-Z]+)\*\s*(.*)$/i.exec(l);
    if (mark) {
      const k = mark[1]!.toUpperCase();
      if (k === 'SIGNAL') { net = { name: mark[2]!.trim().split(/\s+/)[0] ?? '', pins: [] }; if (net.name) out.nets.push(net); else net = null; section = 'NET'; }
      else { section = k; net = null; }
      continue;
    }
    if (section === 'PART') {
      // "R1 0805", or "R1 10k@0805": the part type before the @, the decal after it
      const [d, what = ''] = l.split(/\s+/);
      const at = what.indexOf('@');
      out.parts.push(part(d!, at >= 0 ? what.slice(at + 1) : what, at >= 0 ? what.slice(0, at) : ''));
    } else if (section === 'NET' && net) {
      for (const w of l.split(/\s+/)) { const p = pinOf(w, '.'); if (p) net.pins.push(p); else skipped++; }
    }
  }
  if (skipped) out.notes.push(`${skipped} pin${skipped === 1 ? '' : 's'} could not be read`);
  return out;
}

function readTelesis(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'Telesis', parts: [], nets: [], notes: [] };
  // A line that ends with a comma goes on on the next
  const joined: string[] = [];
  let carry = '';
  for (const raw of text.split(/\r?\n/)) { const l = raw.trim(); if (!l) continue; carry += (carry ? ' ' : '') + l; if (/,\s*$/.test(l)) { carry = carry.replace(/,\s*$/, ''); continue; } joined.push(carry); carry = ''; }
  if (carry) joined.push(carry);
  let section = '', skipped = 0;
  for (const l of joined) {
    if (l.startsWith('$')) { section = l.split(/\s+/)[0]!.toUpperCase(); continue; }
    const semi = l.indexOf(';');
    if (semi < 0) continue;
    const left = l.slice(0, semi).trim(), right = l.slice(semi + 1).trim().split(/[\s,]+/).filter(Boolean);
    if (section === '$PACKAGES') {
      // footprint! device! value; designators (the device and value may be missing)
      const [footprint = '', device = '', value = ''] = left.split('!').map((s) => s.trim().replace(/^'|'$/g, ''));
      for (const d of right) out.parts.push(part(d, footprint, value || device));
    } else if (section === '$NETS') {
      const net: NetlistNet = { name: left.replace(/^'|'$/g, ''), pins: [] };
      for (const w of right) { const p = pinOf(w, '.'); if (p) net.pins.push(p); else skipped++; }
      out.nets.push(net);
    }
  }
  if (skipped) out.notes.push(`${skipped} pin${skipped === 1 ? '' : 's'} could not be read`);
  return out;
}

function readKicad(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'KiCad', parts: [], nets: [], notes: [] };
  const root = sexpr(text)[0];
  if (!root) return out;
  for (const c of all(root, 'comp')) {
    const ref = word(kid(c, 'ref'));
    if (!ref) continue;
    // (a footprint is written Library:Name: the name is what a board's library is asked for)
    const fp = word(kid(c, 'footprint'));
    out.parts.push(part(ref, fp.includes(':') ? fp.slice(fp.indexOf(':') + 1) : fp, word(kid(c, 'value')), word(kid(c, 'description'))));
  }
  for (const n of all(root, 'net')) {
    const name = word(kid(n, 'name'));
    const pins = kids(n, 'node').map((node) => ({ designator: word(kid(node, 'ref')), pin: word(kid(node, 'pin')) })).filter((p) => p.designator && p.pin);
    if (name || pins.length) out.nets.push({ name: name || `Net${word(kid(n, 'code'))}`, pins });
  }
  return out;
}

function readPcad(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'P-CAD', parts: [], nets: [], notes: [] };
  const lists = sexpr(text.replace(/^\s*ACCEL_ASCII\s+"[^"]*"/i, ''));
  const root: Sx = lists;
  // A component's pattern is said by its definition (compDef … (attachedPattern (patternName "…"))), or on the instance
  const patternOf = new Map<string, string>();
  for (const d of all(root, 'compDef')) { const p = word(kid(kid(d, 'attachedPattern') ?? [], 'patternName')); if (p) patternOf.set(word(d).toLowerCase(), p); }
  for (const c of all(root, 'compInst')) {
    const ref = word(c);
    if (!ref) continue;
    const def = word(kid(c, 'compRef')), original = word(kid(c, 'originalName'));
    const footprint = word(kid(c, 'patternName')) || patternOf.get(def.toLowerCase()) || patternOf.get(original.toLowerCase()) || '';
    out.parts.push(part(ref, footprint, word(kid(c, 'compValue')) || original || def));
  }
  for (const n of all(root, 'net')) {
    const name = word(n);
    if (!name) continue;
    out.nets.push({ name, pins: kids(n, 'node').map((node) => ({ designator: word(node, 1), pin: word(node, 2) })).filter((p) => p.designator && p.pin) });
  }
  return out;
}

function readEdif(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'EDIF', parts: [], nets: [], notes: [] };
  const root = sexpr(text)[0];
  if (!root) return out;
  /** A name as EDIF writes one: a word, or (rename word "the real name"). */
  const name = (x: Sx | undefined): string => (typeof x === 'string' ? x : Array.isArray(x) && head(x) === 'rename' ? word(x, 2) || word(x, 1) : Array.isArray(x) && head(x) === 'array' ? name(x[1]) : '');
  const prop = (inst: Sx[], want: RegExp): string => {
    for (const p of kids(inst, 'property')) if (want.test(name(p[1]))) { const v = p.find((k, i) => i > 1 && Array.isArray(k) && ['string', 'integer', 'number'].includes(head(k))) as Sx[] | undefined; return v ? word(v).replace(/%34%/g, '"') : ''; }
    return '';
  };
  // The page that holds instances and nets: the last cell's contents (the design's own; the cells before it are its library's parts)
  const pages = all(root, 'contents');
  const page = pages[pages.length - 1];
  if (!page) return out;
  const local = new Map<string, string>();
  for (const inst of kids(page, 'instance')) {
    const id = typeof inst[1] === 'string' ? inst[1] : word(inst[1] as Sx[], 1), ref = name(inst[1]) || id;
    if (!ref) continue;
    local.set(id.toLowerCase(), ref);
    const cell = word(kid(kid(inst, 'viewRef') ?? [], 'cellRef'));
    out.parts.push(part(ref, prop(inst, /^(footprint|pcb_?footprint|package|pattern|decal)$/i), prop(inst, /^(value|comment|part_?type|device)$/i) || cell, prop(inst, /^description$/i)));
  }
  for (const n of kids(page, 'net')) {
    const net: NetlistNet = { name: name(n[1]), pins: [] };
    for (const ref of all(kid(n, 'joined') ?? [], 'portRef')) {
      const inst = word(kid(ref, 'instanceRef'));
      // (a port with no instance is the design's own connector: not a part's pin)
      if (!inst) continue;
      // A pin's name may be written &1 for 1 (a name cannot begin with a figure)
      net.pins.push({ designator: local.get(inst.toLowerCase()) ?? inst, pin: name(ref[1]).replace(/^&/, '') });
    }
    if (net.name) out.nets.push(net);
  }
  return out;
}

function readPcadBraces(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'Pcad', parts: [], nets: [], notes: [] };
  const nets = new Map<string, NetlistNet>();
  // Each part: {I pattern.PRT designator {CN pin net pin net …}} (a pin on no net has ? for its net)
  for (const m of text.matchAll(/\{\s*I\s+(\S+)\s+(\S+)\s*(?:\{\s*CN([^}]*)\})?/g)) {
    const pattern = m[1]!.replace(/\.PRT$/i, '');
    out.parts.push(part(m[2]!, /^UNKNOWN$/i.test(pattern) ? '' : pattern));
    const words = (m[3] ?? '').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 1 < words.length; i += 2) {
      const name = words[i + 1]!;
      if (name === '?') continue;
      const net = nets.get(name) ?? { name, pins: [] };
      nets.set(name, net);
      net.pins.push({ designator: m[2]!, pin: words[i]! });
    }
  }
  out.nets = [...nets.values()];
  return out;
}

function readMultiwire(text: string): ReadNetlist {
  const out: ReadNetlist = { format: 'MultiWire', parts: [], nets: [], notes: [] };
  let section = '', net: NetlistNet | null = null, skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) continue;
    if (/^(NETLIST|PARTS|NETS|END)$/i.test(l.trim()) || /^DESIGN\b/i.test(l)) { section = l.trim().split(/\s+/)[0]!.toUpperCase(); net = null; continue; }
    if (section === 'PARTS') {
      // Columns: the designator in twelve, the footprint in twenty-four, then the comment; else by gaps of two spaces or more
      const cols = l.length > 12 && l[11] === ' ' && (l.length <= 36 || l[35] === ' ') ? [l.slice(0, 12), l.slice(12, 36), l.slice(36)].map((x) => x.trim()) : l.trim().split(/\s{2,}|\t+/);
      if (cols[0]) out.parts.push(part(cols[0], cols[1] ?? '', cols[2] ?? ''));
    } else if (section === 'NETS') {
      if (!/^\s/.test(l)) { net = { name: l.trim(), pins: [] }; out.nets.push(net); }
      else if (net) for (const w of l.trim().split(/\s+/)) { const p = pinOf(w, '-'); if (p) net.pins.push(p); else skipped++; }
    }
  }
  if (skipped) out.notes.push(`${skipped} pin${skipped === 1 ? '' : 's'} could not be read`);
  return out;
}

/** A netlist file read; null where it is none of the formats known. */
export function readNetlistFile(text: string): ReadNetlist | null {
  const t = text.replace(/^﻿/, '');
  const format = netlistFormat(t);
  const got = format === 'KiCad' ? readKicad(t) : format === 'P-CAD' ? readPcad(t) : format === 'EDIF' ? readEdif(t) : format === 'PADS' ? readPads(t) : format === 'Telesis' ? readTelesis(t)
    : format === 'Pcad' ? readPcadBraces(t) : format === 'MultiWire' ? readMultiwire(t)
    : format === 'NET 2' ? readNamed(t) : format === 'NET' || format === 'Tango' ? readBracketed(t, format === 'Tango') : null;
  if (!got) return null;
  // A part named twice is one part; a pin of a part the file does not list makes the part known (some writers list nets only)
  const seen = new Map<string, NetlistPart>();
  for (const p of got.parts) if (!seen.has(p.designator.toUpperCase())) seen.set(p.designator.toUpperCase(), p);
  let implied = 0;
  for (const n of got.nets) for (const p of n.pins) if (!seen.has(p.designator.toUpperCase())) { seen.set(p.designator.toUpperCase(), part(p.designator)); implied++; }
  if (implied) got.notes.push(`${implied} part${implied === 1 ? ' is' : 's are'} named by nets only, with no footprint`);
  got.parts = [...seen.values()];
  // Nets of one name are one net; a pin is in the first net that names it
  const nets = new Map<string, NetlistNet>(), taken = new Set<string>();
  let twice = 0;
  for (const n of got.nets) {
    const into = nets.get(n.name) ?? { name: n.name, pins: [] };
    nets.set(n.name, into);
    for (const p of n.pins) { const k = `${p.designator.toUpperCase()}\u0000${p.pin.toUpperCase()}`; if (taken.has(k)) { if (!into.pins.some((q) => q.designator.toUpperCase() === p.designator.toUpperCase() && q.pin.toUpperCase() === p.pin.toUpperCase())) twice++; continue; } taken.add(k); into.pins.push(p); }
  }
  if (twice) got.notes.push(`${twice} pin${twice === 1 ? ' is' : 's are'} named by more than one net: the first net has ${twice === 1 ? 'it' : 'them'}`);
  got.nets = [...nets.values()];
  return got;
}
