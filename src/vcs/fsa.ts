/**
 * A project folder (File System Access) as the file system Git works on: the promise-style
 * calls isomorphic-git makes (readFile, writeFile, mkdir, rmdir, unlink, readdir, stat, lstat),
 * paths '/'-separated from the folder, errors with the codes it looks for (ENOENT, ENOTDIR,
 * EEXIST, ENOTEMPTY, EISDIR). Folders are remembered once found. There are no links.
 */

export class FsError extends Error {
  constructor(public code: string, path: string) { super(`${code}: ${path}`); }
}

export interface Stats {
  type: 'file' | 'dir';
  mode: number; size: number; ino: number; dev: number; uid: number; gid: number;
  mtimeMs: number; ctimeMs: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}

/**
 * Git tells a changed file by its size and modification time in whole seconds; a folder's files
 * have it to the millisecond, so that goes in as the "inode" (which Git also compares), and a
 * file saved twice in one second at the same size still shows as changed.
 */
const stats = (type: 'file' | 'dir', size: number, at: number): Stats => ({
  type, mode: type === 'file' ? 0o100644 : 0o40000, size, ino: type === 'file' ? at % 4294967296 : 0, dev: 1, uid: 1, gid: 1, mtimeMs: at, ctimeMs: at,
  isFile: () => type === 'file', isDirectory: () => type === 'dir', isSymbolicLink: () => false,
});

/** A DOMException (or a stand-in's) as the file system error isomorphic-git expects. */
function mapped(e: unknown, path: string, file = false): FsError {
  const n = (e as { name?: string })?.name;
  if (e instanceof FsError) return e;
  if (n === 'NotFoundError') return new FsError('ENOENT', path);
  if (n === 'TypeMismatchError') return new FsError(file ? 'EISDIR' : 'ENOTDIR', path);
  if (n === 'InvalidModificationError') return new FsError('ENOTEMPTY', path);
  return new FsError('EIO', `${path} (${(e as Error)?.message ?? e})`);
}

export interface FolderFs {
  promises: {
    readFile(p: string, o?: { encoding?: string } | string): Promise<Uint8Array | string>;
    writeFile(p: string, data: Uint8Array | string, o?: unknown): Promise<void>;
    mkdir(p: string): Promise<void>;
    rmdir(p: string): Promise<void>;
    unlink(p: string): Promise<void>;
    readdir(p: string): Promise<string[]>;
    stat(p: string): Promise<Stats>;
    lstat(p: string): Promise<Stats>;
    readlink(p: string): Promise<string>;
    symlink(target: string, p: string): Promise<void>;
  };
}

export function folderFs(root: FileSystemDirectoryHandle): FolderFs {
  const dirs = new Map<string, FileSystemDirectoryHandle>([['', root]]);
  const segs = (p: string) => p.split('/').filter((s) => s && s !== '.');
  const forget = (key: string) => { for (const k of [...dirs.keys()]) if (k === key || k.startsWith(`${key}/`)) dirs.delete(k); };
  async function dirAt(parts: string[], path: string): Promise<FileSystemDirectoryHandle> {
    let key = '', d = root;
    for (const s of parts) {
      key = key ? `${key}/${s}` : s;
      let h = dirs.get(key);
      if (!h) {
        try { h = await d.getDirectoryHandle(s); } catch (e) { throw mapped(e, path); }
        dirs.set(key, h);
      }
      d = h;
    }
    return d;
  }
  const parentOf = async (p: string) => { const s = segs(p); if (!s.length) throw new FsError('EPERM', p); return { dir: await dirAt(s.slice(0, -1), p), name: s.at(-1)!, key: s.join('/') }; };
  async function stat(p: string): Promise<Stats> {
    const s = segs(p);
    if (!s.length) return stats('dir', 0, 0);
    const { dir, name, key } = await parentOf(p);
    if (dirs.has(key)) return stats('dir', 0, 0);
    try {
      const f = await (await dir.getFileHandle(name)).getFile();
      return stats('file', f.size, f.lastModified);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'TypeMismatchError') throw mapped(e, p);
      dirs.set(key, await dir.getDirectoryHandle(name));
      return stats('dir', 0, 0);
    }
  }
  return {
    promises: {
      async readFile(p, o) {
        const { dir, name } = await parentOf(p);
        let bytes: Uint8Array;
        try { bytes = new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); } catch (e) { throw mapped(e, p, true); }
        const enc = typeof o === 'string' ? o : o?.encoding;
        return enc === 'utf8' || enc === 'utf-8' ? new TextDecoder().decode(bytes) : bytes;
      },
      async writeFile(p, data) {
        const { dir, name } = await parentOf(p);
        try {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write((typeof data === 'string' ? new TextEncoder().encode(data) : data) as unknown as BufferSource);
          await w.close();
        } catch (e) { throw mapped(e, p, true); }
      },
      async mkdir(p) {
        const { dir, name, key } = await parentOf(p);
        try { await dir.getDirectoryHandle(name); throw new FsError('EEXIST', p); } catch (e) {
          if (e instanceof FsError) throw e;
          if ((e as { name?: string })?.name === 'TypeMismatchError') throw new FsError('EEXIST', p);
        }
        try { dirs.set(key, await dir.getDirectoryHandle(name, { create: true })); } catch (e) { throw mapped(e, p); }
      },
      async rmdir(p) {
        const { dir, name, key } = await parentOf(p);
        try { await dir.removeEntry(name); } catch (e) { throw mapped(e, p); }
        forget(key);
      },
      async unlink(p) {
        const { dir, name } = await parentOf(p);
        try { await dir.getFileHandle(name); } catch (e) { throw mapped(e, p, true); }
        try { await dir.removeEntry(name); } catch (e) { throw mapped(e, p, true); }
      },
      async readdir(p) {
        const s = segs(p);
        let d: FileSystemDirectoryHandle;
        try { d = await dirAt(s, p); } catch (e) {
          // A file where a folder was asked for
          if (e instanceof FsError && e.code === 'ENOTDIR') throw e;
          if (s.length && (await stat(p).catch(() => null))?.type === 'file') throw new FsError('ENOTDIR', p);
          throw e;
        }
        const names: string[] = [];
        for await (const [n] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) names.push(n);
        return names;
      },
      stat,
      lstat: stat,
      async readlink(p) { throw new FsError('EINVAL', p); },
      async symlink(_t, p) { throw new FsError('EPERM', p); },
    },
  };
}
