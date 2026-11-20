import { ansiToStr, binToBytes, binToUtf8, bytesToBin, currentCodePage, isAscii, strToAnsi, strToCp1252, utf8ToBin } from '../text';

const UTF8 = '%UTF8%';

interface Entry { k: string; v: string | null }

/**
 * Altium property record: "|KEY=VALUE|KEY=VALUE…" (+ optional trailing NULs).
 *
 * Lossless by design: entry order, key case, duplicate keys and unknown keys are kept, and an
 * unmodified bag serialises to its original bytes exactly. Keys are matched case-insensitively.
 */
export class PropertyBag {
  private entries: Entry[] = [];
  private prefix = '';
  private trailingNuls = 0;
  private original: Uint8Array | null = null;
  private index: Map<string, number> | null = null;
  modified = false;
  /** The Windows code page its 8-bit text is in (the file's: Western unless the file says otherwise). */
  cp = 1252;

  static parse(bytes: Uint8Array): PropertyBag {
    const bag = new PropertyBag();
    bag.original = bytes;
    bag.cp = currentCodePage();
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) { end--; bag.trailingNuls++; }
    const s = bytesToBin(bytes.subarray(0, end));
    const parts = s.split('|');
    bag.prefix = parts[0] ?? '';
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!;
      const eq = p.indexOf('=');
      bag.entries.push(eq < 0 ? { k: p, v: null } : { k: p.slice(0, eq), v: p.slice(eq + 1) });
    }
    return bag;
  }

  static from(obj: Record<string, string | number | boolean>, trailingNul = true): PropertyBag {
    const bag = new PropertyBag();
    bag.trailingNuls = trailingNul ? 1 : 0;
    for (const [k, v] of Object.entries(obj)) bag.set(k, typeof v === 'boolean' ? (v ? 'T' : 'F') : String(v));
    return bag;
  }

  /** A record from entries in order, duplicates kept (Board6 repeats RECORD=Board, SELECTION, LAYER …). */
  static fromEntries(entries: ReadonlyArray<readonly [string, string]>, trailingNul = true): PropertyBag {
    const bag = new PropertyBag();
    bag.trailingNuls = trailingNul ? 1 : 0;
    bag.modified = true;
    for (const [k, v] of entries) {
      const ansi = strToCp1252(v);
      bag.entries.push({ k, v: ansi ?? v.replace(/[^\x00-\xff]/g, '?') });
      // Text cp1252 can't hold (Ω, ℃) also goes in a %UTF8% twin, as Altium writes it
      if (ansi === null) bag.entries.push({ k: UTF8 + k, v: utf8ToBin(v) });
    }
    return bag;
  }

  toBytes(): Uint8Array {
    if (!this.modified && this.original) return this.original;
    let s = this.prefix;
    for (const e of this.entries) s += '|' + e.k + (e.v === null ? '' : '=' + e.v);
    s += '\0'.repeat(this.trailingNuls);
    return binToBytes(s);
  }

  private idx(): Map<string, number> {
    if (!this.index) {
      this.index = new Map();
      this.entries.forEach((e, i) => { const k = e.k.toUpperCase(); if (!this.index!.has(k)) this.index!.set(k, i); });
    }
    return this.index;
  }

  keys(): string[] { return this.entries.map((e) => e.k); }
  rawEntries(): ReadonlyArray<Readonly<Entry>> { return this.entries; }
  get size(): number { return this.entries.length; }

  has(key: string): boolean { return this.idx().has(key.toUpperCase()); }

  /** Raw binary-string value (no decoding). */
  getRaw(key: string): string | undefined {
    const i = this.idx().get(key.toUpperCase());
    return i === undefined ? undefined : (this.entries[i]!.v ?? '');
  }

  /** Display string: prefers the %UTF8% twin, else decodes the file's code page. */
  get(key: string): string | undefined {
    const u = this.getRaw(UTF8 + key);
    if (u !== undefined) return binToUtf8(u);
    const r = this.getRaw(key);
    return r === undefined ? undefined : ansiToStr(r, this.cp);
  }

  int(key: string, def = 0): number {
    const v = this.getRaw(key);
    if (v === undefined || v === '') return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  }

  float(key: string, def = 0): number {
    const v = this.getRaw(key);
    if (v === undefined || v === '') return def;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  }

  bool(key: string, def = false): boolean {
    const v = this.getRaw(key);
    if (v === undefined) return def;
    const u = v.toUpperCase();
    return u === 'T' || u === 'TRUE' || u === '1';
  }

  setRaw(key: string, bin: string): void {
    this.modified = true;
    const k = key.toUpperCase(), ix = this.idx();
    const i = ix.get(k);
    // A new key goes on the end and into the index as it is (no rebuild: bags of thousands of keys stay linear)
    if (i === undefined) { this.entries.push({ k: key, v: bin }); ix.set(k, this.entries.length - 1); }
    else this.entries[i]!.v = bin;
  }

  /** Set a display string (in the file's code page). Text beyond ASCII also writes a %UTF8% twin, as Altium does. */
  set(key: string, value: string): void {
    const ansi = strToAnsi(value, this.cp);
    if (ansi !== null) {
      this.setRaw(key, ansi);
      if (!isAscii(value)) this.setRaw(UTF8 + key, utf8ToBin(value));
      else this.delete(UTF8 + key);
    } else {
      this.setRaw(key, value.replace(/[^\x00-\xff]/g, '?'));
      this.setRaw(UTF8 + key, utf8ToBin(value));
    }
  }

  /**
   * Replace every entry whose key matches with new entries, placed where the first match was
   * (or at the end): a group like an outline's vertices keeps its place in the record.
   */
  replaceGroup(match: (key: string) => boolean, entries: [string, string][]): void {
    const at = this.entries.findIndex((e) => match(e.k));
    const kept = this.entries.filter((e) => !match(e.k));
    const pos = at < 0 ? kept.length : this.entries.slice(0, at).filter((e) => !match(e.k)).length;
    const add: Entry[] = [];
    for (const [k, v] of entries) {
      const ansi = strToAnsi(v, this.cp);
      add.push({ k, v: ansi ?? v.replace(/[^\x00-\xff]/g, '?') });
    }
    kept.splice(pos, 0, ...add);
    this.entries = kept;
    this.index = null;
    this.modified = true;
  }

  delete(key: string): void {
    const k = key.toUpperCase();
    if (!this.idx().has(k)) return;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.k.toUpperCase() !== k);
    if (this.entries.length !== before) { this.modified = true; this.index = null; }
  }

  clone(): PropertyBag {
    const b = new PropertyBag();
    b.entries = this.entries.map((e) => ({ ...e }));
    b.prefix = this.prefix;
    b.trailingNuls = this.trailingNuls;
    b.original = this.original;
    b.modified = this.modified;
    b.cp = this.cp;
    return b;
  }

  toObject(): Record<string, string> {
    const o: Record<string, string> = {};
    for (const e of this.entries) if (!(e.k.toUpperCase() in o)) o[e.k] = this.get(e.k) ?? '';
    return o;
  }
}
