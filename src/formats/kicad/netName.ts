/**
 * A net's KiCad name. KiCad names a net by its strongest driver: a global label or power symbol by
 * its text; a local or hierarchical label by its text after its sheet's path (/Sheet/NAME); else a
 * pin, Net-(R1-Pad2) or, where the pin has a name of its own, Net-(U1-SDA). A board read from KiCad
 * takes the names its schematics compile to, as AD's project needs; each net's record keeps KiCad's
 * name, and what it was given, so that a net left as it was goes back to KiCad with its own name.
 */
import type { PcbNet } from '../../model/pcb';
import { compileProject, type SheetInput } from '../../model/compile';
import { sheetHierarchy, type SymbolRef } from '../../model/schHierarchy';
import { sheetInstances } from '../../model/channels';
import { kicadNet } from './write';

/**
 * A KiCad library ID (Library:Name) a symbol or footprint read from KiCad keeps (KICADLIBID,
 * KICADFOOTPRINT), while it is still the one it was (its name the same): else undefined.
 */
export function kicadLibId(kept: string | undefined, name: string): string | undefined {
  if (!kept) return undefined;
  const i = kept.indexOf(':');
  return (i >= 0 ? kept.slice(i + 1) : kept) === name ? kept : undefined;
}

/** The keys a renamed net's record keeps: KiCad's name, and the name Konium gave it. */
export const kicadNetKeys = (kicad: string, given: string): Record<string, string> => ({ KICADNAME: kicad, KICADNAMEFOR: given });

/** KiCad's own name for a net read from KiCad and still named as it was then, else undefined. */
export function kicadNetName(n: PcbNet): string | undefined {
  const k = n.bag.get('KICADNAME');
  return k && n.bag.get('KICADNAMEFOR') === n.name ? k : undefined;
}

/**
 * KiCad's name for a net a pin names (eeschema's RenderPinNetName): Net-(REF-NAME) when the pin has
 * a name other than its number, with -PadN after it when another pin of the part has that name;
 * Net-(REF-PadN) otherwise (a name of ~ is none).
 */
export function kicadPinNetName(ref: string, pinName: string, pinNumber: string, duplicate: boolean): string {
  const esc = (s: string) => s.replace(/\//g, '{slash}');
  if (pinName === '~') pinName = '';   // KiCad's hidden name
  if (pinName && pinName !== pinNumber) return `Net-(${ref}-${esc(pinName)}${duplicate ? `-Pad${esc(pinNumber)}` : ''})`;
  return `Net-(${ref}-Pad${esc(pinNumber)})`;
}

/** KiCad's unit letters (A … Z, AA …), as a part with more than one unit takes after its reference. */
const unitLetters = (n: number) => { let s = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };

/**
 * KiCad's names for the nets of these schematics as the exporter writes them (by Konium's name):
 * the strongest driver names a net (eeschema's driver priorities: global label, then power symbol,
 * then local label, then hierarchical label, then sheet pin, then pin); among equals the one on the
 * sheet nearest the top, then the first by name. A label's name has its sheet's path in front
 * (/Child/NAME), a global label's and a power symbol's don't. How Konium's objects go out: a power
 * port as a power symbol; a net label as a local label, or a global label when the design's labels
 * are global; a port as a hierarchical label in a hierarchical design, else a global label.
 */
export function kicadNetNames(sheets: SheetInput[], o: { mode: number; scope: 'hierarchical' | 'flat' | 'global'; channelFormat?: string; channelSeparator?: string }): Map<string, string> {
  const out = new Map<string, string>();
  if (!sheets.length) return out;
  const sep = o.channelSeparator ?? '_';
  const compiled = compileProject(sheets, { scope: o.mode, channelFormat: o.channelFormat, channelSeparator: sep });
  const docs = new Map(sheets.map((s) => [s.name, s.doc]));
  const h = sheetHierarchy(sheets);
  const symUid = (s: SymbolRef) => docs.get(s.sheet)?.records[s.index + 1]?.bag?.get('UNIQUEID') ?? '';
  const tree = new Map(sheetInstances(h, symUid, sep).map((t) => [t.key, t]));
  const esc = (s: string) => kicadNet(s);
  /** An instance's sheet path, as KiCad writes it before a label's name ("/" at the top, "/Child/" below). */
  const pathOf = (key: string) => {
    const names: string[] = [];
    for (let t = tree.get(key); t?.via; t = t.parent ? tree.get(t.parent) : undefined) names.unshift(t.via.designator || 'Sheet');
    return { path: `/${names.map((n) => `${n.replace(/\//g, '{slash}')}/`).join('')}`, depth: names.length };
  };
  const byIndex = new Map(sheets.map((s) => [s.name, new Map(s.doc.objects.map((x) => [x.index, x]))]));
  const objAt = (sheet: string, index: number) => byIndex.get(sheet)?.get(index);
  const parts = new Map(compiled.components.map((c) => [c.designator, c.parts]));
  for (const net of compiled.nets) {
    type D = { pri: number; depth: number; name: string };
    const drivers: D[] = [];
    for (const { ref, inst } of net.instRefs ?? net.refs.map((r) => ({ ref: r, inst: r.sheet }))) {
      const x = objAt(ref.sheet, ref.index);
      if (!x) continue;
      const { path, depth } = pathOf(inst);
      // (a power port that was KiCad's global label goes back as one: a global label's rank)
      if (x.kind === 'power') drivers.push({ pri: docs.get(ref.sheet)?.records[ref.index + 1]?.bag?.get('KICADGLOBAL') ? 7 : 6, depth: 0, name: esc(x.text) });
      else if (x.kind === 'text' && x.role === 'netlabel' && x.text.trim()) drivers.push(o.scope === 'global' ? { pri: 7, depth: 0, name: esc(x.text) } : { pri: 4, depth, name: path + esc(x.text) });
      else if (x.kind === 'port' && x.name.trim()) drivers.push(o.scope === 'hierarchical' ? { pri: 3, depth, name: path + esc(x.name) } : { pri: 7, depth: 0, name: esc(x.name) });
    }
    if (!drivers.length) {
      // A pin names it: Net-(REF-NAME), the names of pins with names first, then by name
      for (const p of net.pins) {
        if (!p.designator || p.designator.startsWith('#')) continue;
        const pin = objAt(p.ref.sheet, p.ref.index);
        const owner = pin?.kind === 'pin' ? docs.get(p.ref.sheet)?.objects[pin.owner] : undefined;   // (owner: its place in the list, as the compile reads it)
        const unit = owner?.kind === 'component' && (parts.get(p.designator) ?? 1) > 1 ? unitLetters(Math.max(1, owner.partId)) : '';
        // The other pins of its unit (and the pins every unit has), as KiCad looks for a name twice
        const siblings = owner?.kind === 'component' && pin?.kind === 'pin'
          ? owner.children.map((c) => docs.get(p.ref.sheet)?.objects[c]).filter((c) => c?.kind === 'pin' && (c.ownerPartId <= 0 || c.ownerPartId === pin.ownerPartId) && c.ownerDisplayMode === pin.ownerDisplayMode)
          : [];
        const named = p.name && p.name !== '~' && p.name !== p.pin;
        const duplicate = !!named && siblings.some((s) => s?.kind === 'pin' && s.name === p.name && s.designator !== p.pin);
        const name = kicadPinNetName(named ? p.designator + unit : p.designator, p.name, p.pin, duplicate);
        drivers.push({ pri: name.includes('-Pad') ? 0.5 : 1, depth: pathOf(p.inst ?? p.ref.sheet).depth, name });
      }
    }
    if (!drivers.length) continue;
    drivers.sort((a, b) => b.pri - a.pri || a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const best = drivers[0]!.name;
    if (best !== net.name) out.set(net.name, best);
  }
  return out;
}
