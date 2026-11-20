/**
 * A folder in memory with the File System Access calls Konium uses (getDirectoryHandle,
 * getFileHandle, removeEntry, entries, getFile, createWritable), throwing the DOMExceptions a
 * browser throws, for tests of what works on a project folder.
 */
const err = (name: string, msg: string) => new DOMException(msg, name);
/** Times that always move on (two writes in one millisecond still differ, as two saves on a disk do). */
let last = 0;
const now = () => (last = Math.max(Date.now(), last + 1));

export class FakeFile {
  readonly kind = 'file';
  data: Uint8Array = new Uint8Array();
  at = now();
  constructor(public name: string) {}
  async getFile(): Promise<File> { return new File([this.data as Uint8Array<ArrayBuffer>], this.name, { lastModified: this.at }); }
  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array | ArrayBuffer | string | Blob) => {
        parts.push(typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d instanceof Uint8Array ? d.slice() : new Uint8Array(d));
      },
      close: async () => {
        const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        this.data = out; this.at = now();
      },
    };
  }
  async isSameEntry(o: unknown) { return o === this; }
}

export class FakeFolder {
  readonly kind = 'directory';
  children = new Map<string, FakeFolder | FakeFile>();
  constructor(public name = 'root') {}
  async getDirectoryHandle(n: string, o: { create?: boolean } = {}): Promise<FakeFolder> {
    const c = this.children.get(n);
    if (c instanceof FakeFolder) return c;
    if (c) throw err('TypeMismatchError', `${n} is a file`);
    if (!o.create) throw err('NotFoundError', `${n} not found`);
    const d = new FakeFolder(n);
    this.children.set(n, d);
    return d;
  }
  async getFileHandle(n: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const c = this.children.get(n);
    if (c instanceof FakeFile) return c;
    if (c) throw err('TypeMismatchError', `${n} is a folder`);
    if (!o.create) throw err('NotFoundError', `${n} not found`);
    const f = new FakeFile(n);
    this.children.set(n, f);
    return f;
  }
  async removeEntry(n: string, o: { recursive?: boolean } = {}): Promise<void> {
    const c = this.children.get(n);
    if (!c) throw err('NotFoundError', `${n} not found`);
    if (c instanceof FakeFolder && c.children.size && !o.recursive) throw err('InvalidModificationError', `${n} is not empty`);
    this.children.delete(n);
  }
  async *entries(): AsyncIterable<[string, FakeFolder | FakeFile]> { for (const e of [...this.children.entries()]) yield e; }
  async *values(): AsyncIterable<FakeFolder | FakeFile> { for (const v of [...this.children.values()]) yield v; }
  async *keys(): AsyncIterable<string> { for (const k of [...this.children.keys()]) yield k; }
  async isSameEntry(o: unknown) { return o === this; }
  /** A file's text or bytes at a path ('a/b.txt'), or undefined. */
  read(path: string): Uint8Array | undefined {
    const s = path.split('/');
    let d: FakeFolder = this;
    for (const p of s.slice(0, -1)) { const c = d.children.get(p); if (!(c instanceof FakeFolder)) return undefined; d = c; }
    const f = d.children.get(s.at(-1)!);
    return f instanceof FakeFile ? f.data : undefined;
  }
  text(path: string): string | undefined { const b = this.read(path); return b && new TextDecoder().decode(b); }
  /** A file written at a path, its folders made. */
  write(path: string, data: Uint8Array | string): void {
    const s = path.split('/');
    let d: FakeFolder = this;
    for (const p of s.slice(0, -1)) { let c = d.children.get(p); if (!(c instanceof FakeFolder)) { c = new FakeFolder(p); d.children.set(p, c); } d = c; }
    const f = new FakeFile(s.at(-1)!);
    f.data = typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>);
    d.children.set(f.name, f);
  }
  /** Every file's path, sorted. */
  paths(prefix = ''): string[] {
    const out: string[] = [];
    for (const [n, c] of this.children) { const p = prefix ? `${prefix}/${n}` : n; if (c instanceof FakeFolder) out.push(...c.paths(p)); else out.push(p); }
    return out.sort();
  }
}

export const asHandle = (f: FakeFolder) => f as unknown as FileSystemDirectoryHandle;
