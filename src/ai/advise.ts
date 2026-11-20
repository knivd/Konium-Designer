/**
 * The design as the AI adviser reads it: a compiled project written as compact text — its parts
 * (value, library reference, footprint, description, the parameters that say what the part is),
 * each with its pins (number, name, electrical type, net; nc for a pin on no net), then its nets
 * with their pins. Nothing else of the design goes (no drawings, no positions, no files). Also
 * what a finding's parts and nets are on the sheets, to cross-probe them.
 */
import { ELECTRICAL, natural, type CompiledProject, type ObjRef, type SheetInput } from '../model/compile';
import { ownedBy, type SchObject } from '../model/sch';
import type { Advice, Finding } from './jobs';

/** Electrical types as the text writes them (Input, I/O, Output, Open Collector, Passive, HiZ, Open Emitter, Power). */
const TYPE = ['I', 'IO', 'O', 'OC', 'P', 'Z', 'OE', 'PWR'];
/** Parameters that say nothing about what a part is (or say it twice). */
const NOISE = /^(comment|description|designator|footprint|latestrevision.*|published|publisher|packagedescription|packagereference|componentlink.*|datasheetversion|libref|library.*|uniqueid|sourcelibraryname|databasetablename)$/i;
/** Pins of a net listed in full up to this many; a bigger net (a ground) lists its first ones and says how many more. */
const NET_PINS = 80;

export interface DesignDigest {
  text: string;
  parts: number;
  nets: number;
  pins: number;
  /** Each part's and net's objects on the sheets (by designator and net name, upper case). */
  partRefs: Map<string, ObjRef[]>;
  netRefs: Map<string, ObjRef[]>;
  /** Each part as written, with what a check of it against its datasheet needs. */
  list: PartInfo[];
  /** Each net's pins (designator-pin), by name. */
  members: Map<string, string[]>;
}

/** A part: what the text says of it, and its pins with their nets. */
export interface PartInfo {
  designator: string; value: string; libRef: string; footprint: string; description: string; params: Record<string, string>;
  pins: { number: string; name: string; electrical: number; net: string | null }[];
  /** Its lines in the design's text. */
  block: string;
}

/** A comment that names a parameter (=Value): its value. */
const shown = (comment: string, params: Record<string, string>) => {
  const m = /^=(.+)$/.exec(comment.trim());
  if (!m) return comment.trim();
  const k = Object.keys(params).find((x) => x.toLowerCase() === m[1]!.trim().toLowerCase());
  return k ? params[k]!.trim() : '';
};
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The design's text. `scope` says what it is: the whole project, or one of its sheets (whose nets
 * may go on to other sheets).
 */
export function designDigest(name: string, sheets: SheetInput[], c: CompiledProject, scope: 'project' | 'sheet' = 'project'): DesignDigest {
  // Each pin's net, by part and pin
  const netOf = new Map<string, string>();
  for (const n of c.nets) for (const p of n.pins) netOf.set(`${p.designator}\u0000${p.pin}`.toUpperCase(), n.name);
  const docs = new Map(sheets.map((s) => [s.name.toLowerCase(), s.doc]));
  const lines: string[] = [];
  let pinCount = 0;
  const parts = c.components.filter((x) => x.kind !== 2 && x.kind !== 1).sort((a, b) => natural(a.designator, b.designator));
  const partRefs = new Map<string, ObjRef[]>();
  const list2: PartInfo[] = [];
  for (const comp of parts) {
    partRefs.set(comp.designator.toUpperCase(), comp.refs);
    // Its pins, from each of its parts on the sheets (a pin once, by number)
    const pins = new Map<string, { name: string; electrical: number }>();
    for (const r of comp.refs) {
      const doc = docs.get(r.sheet.toLowerCase());
      const o = doc?.objects[r.index];
      if (!doc || o?.kind !== 'component') continue;
      const own = o as SchObject & { kind: 'component'; partId: number; displayMode: number };
      for (const pn of ownedBy(doc).get(o.index) ?? []) {
        if (pn.kind !== 'pin' || !pn.designator || pins.has(pn.designator)) continue;
        if (!(pn.ownerPartId <= 0 || pn.ownerPartId === own.partId) || pn.ownerDisplayMode !== own.displayMode) continue;
        pins.set(pn.designator, { name: pn.name.replace(/\\/g, ''), electrical: pn.electrical });
      }
    }
    const params = Object.entries(comp.params).filter(([k, v]) => !NOISE.test(k) && v.trim() && v.trim() !== '*' && !/^=/.test(v.trim())).slice(0, 8)
      .map(([k, v]) => `${k}=${clean(v, 60)}`);
    const value = shown(comp.comment, comp.params);
    const at = lines.length;
    lines.push(`${comp.designator}: ${[value || '(no value)', comp.libRef && comp.libRef !== value ? `lib ${clean(comp.libRef, 60)}` : '', comp.footprint ? `fp ${clean(comp.footprint, 60)}` : 'no footprint',
      comp.description ? `"${clean(comp.description, 120)}"` : '', params.join(', ')].filter(Boolean).join('; ')}`);
    // A part whose pins are all passive and unnamed (a resistor, a capacitor) writes only where each goes
    const plain = [...pins.values()].every((p) => p.electrical === 4) && [...pins].every(([n, p]) => !p.name || p.name === n);
    const list = [...pins].sort((a, b) => natural(a[0], b[0])).map(([n, p]) => {
      const net = netOf.get(`${comp.designator}\u0000${n}`.toUpperCase());
      pinCount++;
      return plain ? `${n}=${net ?? 'nc'}` : `${n}${p.name && p.name !== n ? ` ${clean(p.name, 30)}` : ''} ${TYPE[p.electrical] ?? 'P'}=${net ?? 'nc'}`;
    });
    if (list.length) lines.push(`  ${list.join(' | ')}`);
    list2.push({ designator: comp.designator, value, libRef: comp.libRef, footprint: comp.footprint, description: comp.description, params: comp.params,
      pins: [...pins].sort((a, b) => natural(a[0], b[0])).map(([n, p]) => ({ number: n, name: p.name, electrical: p.electrical, net: netOf.get(`${comp.designator}\u0000${n}`.toUpperCase()) ?? null })),
      block: lines.slice(at).join('\n') });
  }
  // Nets: those named first, then the ones named after a pin
  const nets = [...c.nets].sort((a, b) => Number(a.auto) - Number(b.auto) || natural(a.name, b.name));
  const netRefs = new Map<string, ObjRef[]>();
  const members = new Map<string, string[]>();
  for (const n of nets) { netRefs.set(n.name.toUpperCase(), n.refs); members.set(n.name, n.pins.map((p) => `${p.designator}-${p.pin}`).sort(natural)); }
  // Power ports and labels on no pin: their names on one line
  const empty = nets.filter((n) => !n.pins.length).map((n) => n.name);
  const netLines = nets.filter((n) => n.pins.length).map((n) => {
    const pins = n.pins.map((p) => `${p.designator}-${p.pin}`).sort(natural);
    const shownPins = pins.length > NET_PINS ? `${pins.slice(0, NET_PINS).join(', ')} … and ${pins.length - NET_PINS} more` : pins.join(', ');
    return `${n.name}${n.auto ? ' (unnamed)' : ''}${n.sheets.length > 1 ? ` [${n.sheets.length} sheets]` : ''}: ${shownPins}`;
  });
  if (empty.length) netLines.push(`On no pin (power ports or labels joined to nothing): ${empty.join(', ')}`);
  const head = [
    `Design "${name}": ${scope === 'sheet' ? 'one sheet of its project (nets may go on to other sheets)' : `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`} (${sheets.map((s) => s.name).join(', ')}), ${parts.length} parts, ${c.nets.length} nets.`,
    `Pins are written "number name type=net"; types: ${TYPE.map((t, i) => `${t} ${ELECTRICAL[i]}`).join(', ')}; nc: on no net. A resistor's or capacitor's pins: "number=net".`,
  ];
  const text = [...head, '', 'Parts (designator: value; library reference; footprint; description; parameters):', ...lines, '', 'Nets (name: pins):', ...netLines].join('\n');
  return { text, parts: parts.length, nets: c.nets.length, pins: pinCount, partRefs, netRefs, list: list2, members };
}

/** Designator prefixes of parts worth their datasheet even when their symbols' pins are all passive (ICs, transistors, crystals, regulators, relays, modules). */
const ACTIVE_PREFIX = /^(U|IC|Q|T|Y|X|XTAL|VR|PS|K|M|MOD|OSC)\d/i;
/** Parameters that hold the maker's part number. */
const MPN_KEYS = /^(manufacturer[ _]?part[ _]?(number|no\.?)|mfr[ _.]?(part|p\/?n|pn)[ _#]*(number)?|mpn|part[ _]?number|manufacturer[ _]?p\/?n|mfg[ _]?p\/?n|order[ _]?(code|number))$/i;
/** Parameters that hold a datasheet's address. */
const URL_KEYS = /datasheet|componentlink\d*url|helpurl|^url$|^link$/i;

/** Connectors, test points, holes: worth their datasheets only with a maker's part number. */
const CONNECTOR_PREFIX = /^(J|P|CN|CON|X?TP|H|MH|FID)\d/i;
/** Whether a part is worth checking against its datasheet: an IC, a transistor, a crystal … (not a plain resistor or capacitor; a connector with its part number). */
export const wantsDatasheet = (p: PartInfo) => (CONNECTOR_PREFIX.test(p.designator) ? !!mpnOf(p) : p.pins.some((x) => x.electrical !== 4) || ACTIVE_PREFIX.test(p.designator));

/** The maker's part number: a parameter that says so, else the value or library reference when it looks like one (letters and digits, no spaces). */
export function mpnOf(p: Pick<PartInfo, 'params' | 'value' | 'libRef'>): string {
  const k = Object.keys(p.params).find((x) => MPN_KEYS.test(x.trim()) && p.params[x]!.trim() && p.params[x]!.trim() !== '*');
  if (k) return p.params[k]!.trim();
  const like = (s: string) => /^[A-Z0-9][A-Z0-9\-_.\/#+]{3,40}$/i.test(s.trim()) && /\d/.test(s) && /[A-Z]/i.test(s);
  return like(p.value) ? p.value.trim() : like(p.libRef) ? p.libRef.trim() : '';
}

/** A datasheet's address given in the part's parameters (a PDF's first). */
export function datasheetUrlOf(p: Pick<PartInfo, 'params'>): string {
  const urls = Object.entries(p.params).filter(([k, v]) => /^https?:\/\/\S+$/i.test(v.trim()) && (URL_KEYS.test(k) || /\.pdf(\?|#|$)/i.test(v.trim()))).map(([, v]) => v.trim());
  return urls.find((u) => /\.pdf(\?|#|$)/i.test(u)) ?? urls[0] ?? '';
}

/**
 * What is round a part: for each of its nets, the other pins on it with their parts' values (a
 * ground or a supply with many pins only counted), so a check of the part sees its pull-ups,
 * capacitors and what it drives.
 */
export function aroundOf(p: PartInfo, d: Pick<DesignDigest, 'list' | 'members'>, most = 12): string {
  const by = new Map(d.list.map((x) => [x.designator.toUpperCase(), x]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pin of p.pins) {
    if (!pin.net || seen.has(pin.net)) continue;
    seen.add(pin.net);
    const others = (d.members.get(pin.net) ?? []).filter((m) => !m.toUpperCase().startsWith(`${p.designator.toUpperCase()}-`));
    const label = (m: string) => {
      const des = m.slice(0, m.lastIndexOf('-'));
      const x = by.get(des.toUpperCase());
      const pn = x?.pins.find((q) => `${des}-${q.number}` === m);
      return `${m}${pn?.name && pn.name !== pn.number ? ` ${pn.name}` : ''}${x ? ` (${[x.value, x.description].filter(Boolean).join(', ').slice(0, 60)})` : ''}`;
    };
    out.push(`${pin.net}: ${others.length ? others.length > most ? `${others.slice(0, most).map(label).join('; ')} … and ${others.length - most} more` : others.map(label).join('; ') : 'nothing else'}`);
  }
  return out.join('\n');
}

/** A finding's objects on the sheets: its parts', then its nets'. */
export function findingRefs(f: Pick<Finding, 'parts' | 'nets'>, d: Pick<DesignDigest, 'partRefs' | 'netRefs'>): ObjRef[] {
  return [...f.parts.flatMap((p) => d.partRefs.get(p.toUpperCase()) ?? []), ...f.nets.flatMap((n) => d.netRefs.get(n.toUpperCase()) ?? [])];
}

/** The findings as plain text (to copy into a report or a message). */
export function adviceText(name: string, a: Advice): string {
  const word = { error: 'Error', warning: 'Warning', suggestion: 'Suggestion' } as const;
  return [`AI design review: ${name}`, '', a.summary, '', ...a.findings.map((f, i) => [`${i + 1}. [${word[f.severity]}] ${f.title}${f.parts.length || f.nets.length ? ` (${[...f.parts, ...f.nets].join(', ')})` : ''}`,
    f.detail ? `   ${f.detail}` : '', f.fix ? `   Fix: ${f.fix}` : ''].filter(Boolean).join('\n'))].join('\n');
}
