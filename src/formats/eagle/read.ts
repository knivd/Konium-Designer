/**
 * EAGLE's XML files (EAGLE 6 and later, and Fusion Electronics' exports of them): schematics (.sch),
 * boards (.brd) and libraries (.lbr). Read into what the converters need: the layers, the
 * libraries each file carries (packages, symbols, device sets with their gates, devices, pin to pad
 * connections and technologies' attributes), the parts and sheets of a schematic, the elements,
 * signals, plain drawing and design rules of a board. EAGLE's unit is the millimetre, Y up.
 */
import { attrNum, kid, kidsOf, parseXml, type XEl } from '../xml';

export interface ERot { angle: number; mirror: boolean; spin: boolean }
/** "R90", "MR180", "SR0", "SMR270" → its angle (degrees, anticlockwise), mirror and spin. */
export function rotOf(v: string | undefined): ERot {
  const s = (v ?? '').toUpperCase();
  const m = /(-?[0-9.]+)/.exec(s);
  return { angle: m ? ((Number(m[1]) % 360) + 360) % 360 : 0, mirror: s.includes('M'), spin: s.includes('S') };
}

export interface EGate { name: string; symbol: string; x: number; y: number; addlevel: string }
export interface EConnect { gate: string; pin: string; pads: string[] }
export interface EDevice { name: string; pkg: string; connects: EConnect[]; technologies: Map<string, Map<string, string>> }
export interface EDeviceSet { name: string; prefix: string; uservalue: boolean; description: string; gates: EGate[]; devices: Map<string, EDevice> }
export interface ELib { name: string; urn: string; description: string; packages: Map<string, XEl>; symbols: Map<string, XEl>; devicesets: Map<string, EDeviceSet> }

export interface EPart { name: string; lib: string; urn: string; deviceset: string; device: string; technology: string; value?: string; pkg?: string; attrs: Map<string, string>; el: XEl }

export interface EagleDoc {
  version: string;
  kind: 'sch' | 'brd' | 'lbr' | '';
  root: XEl;
  drawing: XEl;
  layers: Map<number, { name: string; active: boolean; visible: boolean }>;
  libraries: ELib[];
  /** A library by its name and (managed libraries) URN, else by name. */
  lib(name: string, urn?: string): ELib | undefined;
  schematic?: XEl;
  board?: XEl;
  library?: XEl;
}

const text = (e: XEl | undefined) => (e?.text ?? '').trim();

export function readLibrary(l: XEl): ELib {
  const packages = new Map<string, XEl>(), symbols = new Map<string, XEl>(), devicesets = new Map<string, EDeviceSet>();
  for (const p of kidsOf(kid(l, 'packages'), 'package')) packages.set(p.attrs.name ?? '', p);
  for (const s of kidsOf(kid(l, 'symbols'), 'symbol')) symbols.set(s.attrs.name ?? '', s);
  for (const d of kidsOf(kid(l, 'devicesets'), 'deviceset')) {
    const gates = kidsOf(kid(d, 'gates'), 'gate').map((g) => ({ name: g.attrs.name ?? '', symbol: g.attrs.symbol ?? '', x: attrNum(g, 'x'), y: attrNum(g, 'y'), addlevel: g.attrs.addlevel ?? 'next' }));
    const devices = new Map<string, EDevice>();
    for (const dv of kidsOf(kid(d, 'devices'), 'device')) {
      const connects = kidsOf(kid(dv, 'connects'), 'connect').map((c) => ({ gate: c.attrs.gate ?? '', pin: c.attrs.pin ?? '', pads: (c.attrs.pad ?? '').split(/\s+/).filter(Boolean) }));
      const technologies = new Map<string, Map<string, string>>();
      for (const t of kidsOf(kid(dv, 'technologies'), 'technology')) technologies.set(t.attrs.name ?? '', new Map(kidsOf(t, 'attribute').map((a) => [a.attrs.name ?? '', a.attrs.value ?? ''])));
      devices.set(dv.attrs.name ?? '', { name: dv.attrs.name ?? '', pkg: dv.attrs.package ?? '', connects, technologies });
    }
    devicesets.set(d.attrs.name ?? '', { name: d.attrs.name ?? '', prefix: d.attrs.prefix ?? '', uservalue: (d.attrs.uservalue ?? 'no') === 'yes', description: text(kid(d, 'description')), gates, devices });
  }
  return { name: l.attrs.name ?? '', urn: l.attrs.urn ?? '', description: text(kid(l, 'description')), packages, symbols, devicesets };
}

/** Whether these first bytes are an EAGLE XML file's. */
export const isEagleXml = (head: string): boolean => /<eagle[\s>]/.test(head) || /<!DOCTYPE\s+eagle/i.test(head);
/** EAGLE before 6 kept its files binary: their first bytes. */
export const isEagleBinary = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x10 && (b[1] === 0x00 || b[1] === 0x80);

export function readEagle(src: string | Uint8Array): EagleDoc {
  const t = typeof src === 'string' ? src : new TextDecoder().decode(src);
  const root = parseXml(t.replace(/^﻿/, ''));
  const eagle = kid(root, 'eagle');
  if (!eagle) throw new Error('not an EAGLE XML file');
  const drawing = kid(eagle, 'drawing');
  if (!drawing) throw new Error('an EAGLE file with no drawing');
  const layers = new Map<number, { name: string; active: boolean; visible: boolean }>();
  for (const l of kidsOf(kid(drawing, 'layers'), 'layer')) layers.set(attrNum(l, 'number'), { name: l.attrs.name ?? '', active: (l.attrs.active ?? 'yes') !== 'no', visible: (l.attrs.visible ?? 'yes') !== 'no' });
  const schematic = kid(drawing, 'schematic'), board = kid(drawing, 'board'), library = kid(drawing, 'library');
  const holder = schematic ?? board;
  const libraries = holder ? kidsOf(kid(holder, 'libraries'), 'library').map(readLibrary) : library ? [readLibrary(library)] : [];
  const byKey = new Map<string, ELib>(), byName = new Map<string, ELib>();
  for (const l of libraries) { byKey.set(`${l.name}\u0000${l.urn}`, l); if (!byName.has(l.name)) byName.set(l.name, l); }
  return {
    version: eagle.attrs.version ?? '', kind: schematic ? 'sch' : board ? 'brd' : library ? 'lbr' : '', root, drawing, layers, libraries,
    lib: (name, urn = '') => byKey.get(`${name}\u0000${urn}`) ?? byName.get(name),
    schematic, board, library,
  };
}

/** A schematic's parts (in a module, its own). */
export function partsOf(holder: XEl | undefined): Map<string, EPart> {
  const out = new Map<string, EPart>();
  for (const p of kidsOf(kid(holder, 'parts'), 'part')) {
    const attrs = new Map(kidsOf(p, 'attribute').map((a) => [a.attrs.name ?? '', a.attrs.value ?? '']));
    out.set(p.attrs.name ?? '', { name: p.attrs.name ?? '', lib: p.attrs.library ?? '', urn: p.attrs.library_urn ?? '', deviceset: p.attrs.deviceset ?? '', device: p.attrs.device ?? '', technology: p.attrs.technology ?? '',
      value: p.attrs.value, pkg: p.attrs.package, attrs, el: p });
  }
  return out;
}

/** "N$12": an automatic net name. */
export const autoNet = (n: string): boolean => /^N\$\d+$/i.test(n);

/** A pin's name as shown: EAGLE's "@n" suffix (pins of one name) dropped. */
export const pinShown = (n: string): string => n.replace(/@[^@]*$/, '');

/** EAGLE's overbar marks (!RESET! or !RESET) as AD's (a backslash after each character). */
export function overbar(n: string): string {
  if (!n.includes('!')) return n;
  let out = '', on = false;
  for (const c of n) {
    if (c === '!') { on = !on; continue; }
    out += on && c !== ' ' ? `${c}\\` : c;
  }
  return out;
}

/** A design rule's length in millimetres ("8mil", "0.2mm", "0.1in"). */
export function ruleLen(v: string | undefined): number | undefined {
  const m = /^\s*(-?[0-9.]+)\s*(mil|mm|in|inch|mic)?\s*$/i.exec(v ?? '');
  if (!m) return undefined;
  const x = Number(m[1]);
  const u = (m[2] ?? 'mm').toLowerCase();
  return u === 'mil' ? x * 0.0254 : u === 'in' || u === 'inch' ? x * 25.4 : u === 'mic' ? x / 1000 : x;
}
