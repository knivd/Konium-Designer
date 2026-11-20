/**
 * The Mixed Sim text documents: a netlist (.nsx, and SPICE decks: .cir, .sp, .spi), a model
 * (.mdl, one .MODEL) or a subcircuit (.ckt, one .SUBCKT) — plain text, edited as text.
 */
export interface SimTextDocument {
  kind: 'SimText';
  name: string;
  text: string;
  /** The text's line ends as read (kept on save). */
  eol: '\r\n' | '\n';
  /** Its encoding as read, kept on save: UTF-8 (with its byte-order mark or not), or Windows-1252 (a file that isn't UTF-8). */
  encoding?: 'utf-8' | 'utf-8-bom' | 'windows-1252';
  dirty: boolean;
}

export const SIM_TEXT_EXT = /\.(nsx|cir|sp|spi|mdl|ckt)$/i;
export const isNetlistName = (name: string): boolean => /\.(nsx|cir|sp|spi)$/i.test(name);

export function readSimText(bytes: Uint8Array, name: string): SimTextDocument {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let raw: string, encoding: SimTextDocument['encoding'];
  // Vendor models are often Windows-1252 (©, µ): not UTF-8, they're read and written back as that
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); encoding = bom ? 'utf-8-bom' : 'utf-8'; }
  catch { raw = new TextDecoder('windows-1252').decode(bytes); encoding = 'windows-1252'; }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { kind: 'SimText', name, text: raw.replace(/\r\n/g, '\n'), eol, encoding, dirty: false };
}

/** Windows-1252's bytes 0x80–0x9F by the characters they stand for (the rest are Latin-1's own). */
let cp1252: Map<number, number> | null = null;
function encode1252(t: string): Uint8Array {
  if (!cp1252) { cp1252 = new Map(); const d = new TextDecoder('windows-1252'); for (let b = 0x80; b <= 0x9f; b++) cp1252.set(d.decode(new Uint8Array([b])).charCodeAt(0), b); }
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); out[i] = cp1252.get(c) ?? (c < 0x100 && (c < 0x80 || c > 0x9f) ? c : 0x3f); }
  return out;
}

export function writeSimText(d: SimTextDocument): Uint8Array {
  const t = d.eol === '\r\n' ? d.text.replace(/\n/g, '\r\n') : d.text;
  if (d.encoding === 'windows-1252') return encode1252(t);
  const b = new TextEncoder().encode(t);
  if (d.encoding !== 'utf-8-bom') return b;
  const out = new Uint8Array(b.length + 3);
  out.set([0xef, 0xbb, 0xbf]); out.set(b, 3);
  return out;
}

/** A new model, netlist or subcircuit file's text [est: AD's own starting text]. */
export function newSimText(name: string): SimTextDocument {
  const stem = name.replace(/\.[^.]+$/, '').replace(/\s+/g, '_');
  const text = /\.mdl$/i.test(name) ? `*${name}\n.MODEL ${stem} D(IS=1e-14 N=1)\n`
    : /\.ckt$/i.test(name) ? `*${name}\n.SUBCKT ${stem} 1 2\nR1 1 2 1k\n.ENDS ${stem}\n`
    : `*${name}\nV1 IN 0 DC 0 SIN(0 1 1k) AC 1\nR1 IN OUT 1k\nC1 OUT 0 100n\n.TRAN 10u 5m\n.AC DEC 100 1 1meg\n.OP\n.END\n`;
  return { kind: 'SimText', name, text, eol: '\r\n', dirty: true };
}
