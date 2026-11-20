/**
 * A team's key for Konium's store: 20 random bytes written as KON1- and eight groups of four
 * letters and digits (Crockford base 32: no I, L, O or U, so it reads back without mistakes).
 * From it, in the browser only: the token the store knows the team by (HKDF "auth"), and the
 * AES-GCM key everything is encrypted with before it leaves (HKDF "enc"). The store never sees
 * the key, so it can't read what it keeps; whoever has the key can.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'KON1';

function base32(b: Uint8Array): string {
  let bits = 0, v = 0, out = '';
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += ALPHABET[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += ALPHABET[(v << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0, v = 0;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    v = (v << 5) | i; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** A new team key (KON1-XXXX-…). */
export function newTeamKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(20));
  return `${PREFIX}-${base32(b).match(/.{4}/g)!.join('-')}`;
}

/** A key as typed or pasted (spaces, dashes, lower case, O for 0, I or L for 1) in its written form, or null. */
export function readTeamKey(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '');
  if (!/^K[O0]N[1IL]/.test(s)) return null;
  const body = s.slice(PREFIX.length).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== 32 || !unbase32(body)) return null;
  return `${PREFIX}-${body.match(/.{4}/g)!.join('-')}`;
}

export interface TeamCrypto {
  /** What the store knows the team by (sent with every request). */
  token: string;
  /** A short name for the team's key, to tell keys apart (not secret: from the token). */
  id: string;
  seal(name: string, data: Uint8Array): Promise<Uint8Array>;
  open(name: string, data: Uint8Array): Promise<Uint8Array>;
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const te = (s: string) => new TextEncoder().encode(s);

/** The token and the encryption a key gives. */
export async function teamCrypto(key: string): Promise<TeamCrypto> {
  const k = readTeamKey(key);
  if (!k) throw new Error('Not a Konium team key');
  const raw = unbase32(k.slice(PREFIX.length).replace(/-/g, ''))!;
  const base = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = te('konium-vcs-1');
  const token = hex(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te('auth') }, base, 256));
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te('enc') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = hex(await crypto.subtle.digest('SHA-256', te(token))).slice(0, 12);
  return {
    token, id,
    // The blob's name is bound in, so one can't be passed off as another
    async seal(name, data) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te(name) }, aes, data as Uint8Array<ArrayBuffer>));
      const out = new Uint8Array(12 + c.length);
      out.set(iv); out.set(c, 12);
      return out;
    },
    async open(name, data) {
      if (data.length < 28) throw new Error('Damaged data from the store');
      try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: te(name) }, aes, data.slice(12))); } catch { throw new Error('The team key doesn\'t open this (another team\'s, or damaged)'); }
    },
  };
}
