import { describe, expect, it } from 'vitest';
import { FakeFolder, asHandle } from './helpers/fakeFolder';
import { folderFs } from '../src/vcs/fsa';
import { newTeamKey, readTeamKey, teamCrypto } from '../src/vcs/keys';
import { KoniumStore, StoreConflict, newRepoId } from '../src/vcs/store';
import {
  changedBetween, cloneInto, commitFiles, createRepo, discard, exportZip, fetchRemote, fileAt, history, integrate, lockFiles, parseRemote, pushRemote, readLocks, readWork,
  remoteOf, repoAt, restoreFiles, statusOf, teamProjects, unlockFiles, type Remote,
} from '../src/vcs/git';
import { unzipEntries } from '../src/formats/xlsxRead';

const ME = { name: 'Ana', email: 'ana@example.com' }, YOU = { name: 'Ben', email: 'ben@example.com' };
const te = (s: string) => new TextEncoder().encode(s);
const td = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : null);

/** Konium's store in memory: blobs per team token, tags, the conditions honoured. */
function memoryStore() {
  const blobs = new Map<string, { data: Uint8Array; tag: string }>();
  let n = 0;
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const name = decodeURIComponent(new URL(String(url)).pathname.replace(/^\/api\/vcs\/blob\//, ''));
    const h = init.headers as Record<string, string>;
    const key = `${h.authorization}|${name}`;
    const cur = blobs.get(key);
    if ((init.method ?? 'GET') === 'GET') return cur ? new Response(cur.data as Uint8Array<ArrayBuffer>, { headers: { etag: cur.tag } }) : new Response('', { status: 404 });
    if ((h['if-none-match'] === '*' && cur) || (h['if-match'] && cur?.tag !== h['if-match'])) return new Response('', { status: 412 });
    const tag = `"${++n}"`;
    blobs.set(key, { data: new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()), tag });
    return new Response('{}', { headers: { etag: tag } });
  }) as typeof fetch;
  return { blobs, fetcher };
}

describe('Version control (R7): the project folder as Git sees it', () => {
  it('files and folders read, written, listed and removed, with the errors Git expects', async () => {
    const root = new FakeFolder();
    const fs = folderFs(asHandle(root)).promises;
    await expect(fs.readFile('/a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.mkdir('/x/y')).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir('/x');
    await expect(fs.mkdir('/x')).rejects.toMatchObject({ code: 'EEXIST' });
    await fs.writeFile('/x/a.txt', 'hello');
    expect(await fs.readFile('/x/a.txt', 'utf8')).toBe('hello');
    expect(await fs.readFile('/x/a.txt', { encoding: 'utf8' })).toBe('hello');
    expect((await fs.stat('/x/a.txt')).isFile()).toBe(true);
    expect((await fs.stat('/x')).isDirectory()).toBe(true);
    expect(await fs.readdir('/x')).toEqual(['a.txt']);
    await expect(fs.readdir('/x/a.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(fs.readFile('/x')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(fs.rmdir('/x')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    await fs.unlink('/x/a.txt');
    await fs.rmdir('/x');
    await expect(fs.stat('/x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a team key: written plainly, read back however typed, and only it opens what it sealed', async () => {
    const k = newTeamKey();
    expect(k).toMatch(/^KON1(-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    expect(readTeamKey(` ${k.toLowerCase().replace(/-/g, ' ')} `)).toBe(k);
    expect(readTeamKey(k.replace(/0/g, 'O'))).toBe(k);
    expect(readTeamKey('KON1-ABCD')).toBeNull();
    const a = await teamCrypto(k), b = await teamCrypto(newTeamKey());
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.id).toHaveLength(12);
    const sealed = await a.seal('r/x/refs', te('secret design'));
    expect(td(await a.open('r/x/refs', sealed))).toBe('secret design');
    expect(new TextDecoder().decode(sealed)).not.toContain('secret');
    await expect(b.open('r/x/refs', sealed)).rejects.toThrow(/doesn't open/);
    await expect(a.open('r/y/refs', sealed)).rejects.toThrow(/doesn't open/);
  });

  it('the store: sealed blobs, written only if new or unchanged since read', async () => {
    const mem = memoryStore();
    const s = await KoniumStore.open(newTeamKey(), 'https://konium.app/api/vcs', mem.fetcher);
    expect(await s.get('index')).toBeNull();
    const t1 = await s.putJson('index', { projects: [] }, null);
    await expect(s.putJson('index', { projects: [] }, null)).rejects.toBeInstanceOf(StoreConflict);
    const t2 = await s.putJson('index', { projects: [{ id: 'a', name: 'A', at: 1 }] }, t1);
    await expect(s.putJson('index', { projects: [] }, t1)).rejects.toBeInstanceOf(StoreConflict);
    expect((await s.getJson<{ projects: unknown[] }>('index'))).toEqual({ value: { projects: [{ id: 'a', name: 'A', at: 1 }] }, tag: t2 });
    for (const b of mem.blobs.values()) expect(new TextDecoder().decode(b.data)).not.toContain('projects');
  });

  it('a project put under version control: what it leaves out, its status, commits, history, a version read, zipped and restored', async () => {
    const root = new FakeFolder();
    root.write('Demo.PrjPcb', '[Design]\n');
    root.write('Demo.SchDoc', 'sheet v1');
    root.write('History/Demo.SchDoc/Demo.~(1).SchDoc.Zip', 'old');
    root.write('Project Outputs for Demo/BOM.csv', 'x');
    const r = repoAt(asHandle(root));
    const first = await createRepo(r, ME, null);
    expect(root.text('.gitignore')).toContain('History/');
    expect([...(await statusOf(r))]).toEqual([['.gitignore', 'unchanged'], ['Demo.PrjPcb', 'unchanged'], ['Demo.SchDoc', 'unchanged']]);
    root.write('Demo.SchDoc', 'sheet v2');
    root.write('Demo.PcbDoc', 'board v1');
    expect(Object.fromEntries(await statusOf(r))).toMatchObject({ 'Demo.SchDoc': 'modified', 'Demo.PcbDoc': 'untracked' });
    const second = await commitFiles(r, ['Demo.SchDoc', 'Demo.PcbDoc'], 'Board added', ME);
    expect(await changedBetween(r, first, second)).toEqual(['Demo.PcbDoc', 'Demo.SchDoc']);
    expect((await history(r)).map((v) => v.message)).toEqual(['Board added', 'Added to version control']);
    expect((await history(r, 'Demo.PcbDoc')).map((v) => v.oid)).toEqual([second]);
    expect(td(await fileAt(r, first, 'Demo.SchDoc'))).toBe('sheet v1');
    expect(await fileAt(r, first, 'Demo.PcbDoc')).toBeNull();
    const z = unzipEntries(await exportZip(r, first, 'Demo (v1)'));
    expect(z.map((e) => e.name).sort()).toEqual(['Demo (v1)/.gitignore', 'Demo (v1)/Demo.PrjPcb', 'Demo (v1)/Demo.SchDoc']);
    expect(td(await z.find((e) => e.name.endsWith('SchDoc'))!.data())).toBe('sheet v1');
    await restoreFiles(r, first, ['Demo.SchDoc']);
    expect(root.text('Demo.SchDoc')).toBe('sheet v1');
    expect((await statusOf(r)).get('Demo.SchDoc')).toBe('modified');
    await discard(r, ['Demo.SchDoc']);
    expect([root.text('Demo.SchDoc'), (await statusOf(r)).get('Demo.SchDoc')]).toEqual(['sheet v2', 'unchanged']);
  });

  it('remotes read back from the folder\'s settings', async () => {
    expect(parseRemote('konium://0123456789ab/abcd1234efgh56')).toEqual({ kind: 'konium', team: '0123456789ab', repo: 'abcd1234efgh56' });
    expect(parseRemote('https://github.com/a/b.git')).toEqual({ kind: 'git', url: 'https://github.com/a/b.git' });
    expect(parseRemote('ftp://x')).toBeNull();
  });
});

describe('Version control (R7): a team on Konium\'s store', () => {
  async function team() {
    const mem = memoryStore(), key = newTeamKey();
    const store = await KoniumStore.open(key, 'https://konium.app/api/vcs', mem.fetcher);
    const remote: Remote = { kind: 'konium', team: store.teamId, repo: newRepoId() };
    const A = new FakeFolder(), B = new FakeFolder();
    A.write('Demo.PrjPcb', 'prj'); A.write('Demo.SchDoc', 'sch 1'); A.write('Demo.PcbDoc', 'pcb 1');
    const ra = repoAt(asHandle(A)), rb = repoAt(asHandle(B));
    await createRepo(ra, ME, remote);
    expect(await pushRemote(ra, remote, { store }, 'Demo')).toBe('pushed');
    expect(await pushRemote(ra, remote, { store }, 'Demo')).toBe('up-to-date');
    expect(await cloneInto(rb, remote, { store }, YOU)).toMatch(/^[0-9a-f]{40}$/);
    return { mem, store, remote, A, B, ra, rb };
  }
  const none = async () => new Map();

  it('one pushes, another clones (the team\'s project list kept), nothing in the store readable without the key', async () => {
    const { mem, store, B, rb, remote } = await team();
    expect(B.text('Demo.SchDoc')).toBe('sch 1');
    expect(await remoteOf(rb)).toEqual(remote);
    expect((await teamProjects(store)).projects.map((p) => [p.id, p.name])).toEqual([[remote.repo, 'Demo']]);
    for (const b of mem.blobs.values()) expect(new TextDecoder().decode(b.data)).not.toMatch(/sch 1|Demo/);
  });

  it('both change different files: the second is told to update, the update merges, then both have both', async () => {
    const { store, remote, A, B, ra, rb } = await team();
    A.write('Demo.SchDoc', 'sch 2 (Ana)'); await commitFiles(ra, ['Demo.SchDoc'], 'Sheet', ME);
    expect(await pushRemote(ra, remote, { store })).toBe('pushed');
    B.write('Demo.PcbDoc', 'pcb 2 (Ben)'); await commitFiles(rb, ['Demo.PcbDoc'], 'Board', YOU);
    expect(await pushRemote(rb, remote, { store })).toBe('behind');
    const up = await integrate(rb, await fetchRemote(rb, remote, { store }), YOU, none);
    expect([up.merged, up.changed]).toEqual([true, ['Demo.SchDoc']]);
    expect([B.text('Demo.SchDoc'), B.text('Demo.PcbDoc')]).toEqual(['sch 2 (Ana)', 'pcb 2 (Ben)']);
    expect(await pushRemote(rb, remote, { store })).toBe('pushed');
    const ff = await integrate(ra, await fetchRemote(ra, remote, { store }), ME, none);
    expect([ff.merged, ff.changed]).toEqual([undefined, ['Demo.PcbDoc']]);
    expect(A.text('Demo.PcbDoc')).toBe('pcb 2 (Ben)');
    expect((await statusOf(ra)).get('Demo.PcbDoc')).toBe('unchanged');
    expect((await integrate(ra, await fetchRemote(ra, remote, { store }), ME, none)).upToDate).toBe(true);
  });

  it('both change the same file: the choice asked, mine, theirs or both (theirs beside mine)', async () => {
    for (const choice of ['mine', 'theirs', 'both'] as const) {
      const { store, remote, A, B, ra, rb } = await team();
      A.write('Demo.PcbDoc', 'pcb Ana'); await commitFiles(ra, ['Demo.PcbDoc'], 'Ana', ME); await pushRemote(ra, remote, { store });
      B.write('Demo.PcbDoc', 'pcb Ben'); await commitFiles(rb, ['Demo.PcbDoc'], 'Ben', YOU);
      let asked: string[] = [];
      const up = await integrate(rb, await fetchRemote(rb, remote, { store }), YOU, async (c) => { asked = c.map((x) => `${x.path} by ${x.by}`); return new Map([['Demo.PcbDoc', choice]]); });
      expect(asked).toEqual(['Demo.PcbDoc by Ana']);
      expect(B.text('Demo.PcbDoc')).toBe(choice === 'theirs' ? 'pcb Ana' : 'pcb Ben');
      if (choice === 'both') { expect(up.extra).toHaveLength(1); expect(up.extra[0]).toMatch(/^Demo \(theirs [0-9a-f]{7}\)\.PcbDoc$/); expect(B.text(up.extra[0]!)).toBe('pcb Ana'); }
      expect(await pushRemote(rb, remote, { store })).toBe('pushed');
    }
  });

  it('the choice names who last changed the file on their side, not who pushed last', async () => {
    const { store, remote, A, B, ra, rb } = await team();
    A.write('Demo.PcbDoc', 'pcb Ana'); await commitFiles(ra, ['Demo.PcbDoc'], 'Board', ME);
    A.write('Demo.SchDoc', 'sch Cara'); await commitFiles(ra, ['Demo.SchDoc'], 'Sheet', { name: 'Cara', email: 'cara@example.com' });
    await pushRemote(ra, remote, { store });
    B.write('Demo.PcbDoc', 'pcb Ben'); await commitFiles(rb, ['Demo.PcbDoc'], 'Ben', YOU);
    let asked: string[] = [];
    await integrate(rb, await fetchRemote(rb, remote, { store }), YOU, async (c) => { asked = c.map((x) => `${x.path} by ${x.by}`); return null; });
    expect(asked).toEqual(['Demo.PcbDoc by Ana']);
  });

  it('an update stops at files changed here and not committed that it would overwrite; cancelling the choice changes nothing', async () => {
    const { store, remote, A, B, ra, rb } = await team();
    A.write('Demo.SchDoc', 'sch Ana'); await commitFiles(ra, ['Demo.SchDoc'], 'Ana', ME); await pushRemote(ra, remote, { store });
    B.write('Demo.SchDoc', 'sch Ben, not committed');
    const up = await integrate(rb, await fetchRemote(rb, remote, { store }), YOU, none);
    expect(up.blocked).toEqual(['Demo.SchDoc']);
    expect(B.text('Demo.SchDoc')).toBe('sch Ben, not committed');
    await commitFiles(rb, ['Demo.SchDoc'], 'Ben', YOU);
    const head = (await history(rb))[0]!.oid;
    const c = await integrate(rb, await fetchRemote(rb, remote, { store }), YOU, async () => null);
    expect(c.cancelled).toBe(true);
    expect([(await history(rb))[0]!.oid, B.text('Demo.SchDoc')]).toEqual([head, 'sch Ben, not committed']);
    expect(await readWork(rb, 'Demo.SchDoc')).not.toBeNull();
  });

  it('locks: one takes a file, the other sees whose it is and is refused (unless taking it over); only the holder\'s unlock lets it go, unless broken', async () => {
    const { mem, store, remote, ra, rb } = await team();
    expect(await readLocks(ra, remote, { store })).toEqual({});
    const took = await lockFiles(ra, remote, { store }, ['Demo.PcbDoc'], ME);
    expect(took.ok && Object.keys(took.locks)).toEqual(['Demo.PcbDoc']);
    expect((await readLocks(rb, remote, { store }))['Demo.PcbDoc']).toMatchObject({ by: 'Ana', email: 'ana@example.com' });
    const refused = await lockFiles(rb, remote, { store }, ['Demo.SchDoc', 'Demo.PcbDoc'], YOU);
    expect(refused.ok ? null : refused.holder.by).toBe('Ana');
    expect(Object.keys(await readLocks(ra, remote, { store }))).toEqual(['Demo.PcbDoc']);
    // Ben's unlock doesn't touch Ana's lock; Ana's own does
    expect(Object.keys(await unlockFiles(rb, remote, { store }, ['Demo.PcbDoc'], YOU))).toEqual(['Demo.PcbDoc']);
    expect(await unlockFiles(ra, remote, { store }, ['Demo.PcbDoc'], ME)).toEqual({});
    // Taken over, then broken
    await lockFiles(ra, remote, { store }, ['Demo.PcbDoc'], ME);
    const over = await lockFiles(rb, remote, { store }, ['Demo.PcbDoc'], YOU, true);
    expect(over.ok && over.locks['Demo.PcbDoc']!.by).toBe('Ben');
    expect(await unlockFiles(ra, remote, { store }, ['Demo.PcbDoc'], ME, true)).toEqual({});
    // Sealed like the rest
    for (const b of mem.blobs.values()) expect(new TextDecoder().decode(b.data)).not.toMatch(/Ana|PcbDoc/);
  });

  it('locks taken at once by two: the second write finds the first\'s and is refused', async () => {
    const { store, remote, ra, rb } = await team();
    const [a, b] = await Promise.all([lockFiles(ra, remote, { store }, ['Demo.PcbDoc'], ME), lockFiles(rb, remote, { store }, ['Demo.PcbDoc'], YOU)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const holder = (await readLocks(ra, remote, { store }))['Demo.PcbDoc']!.by;
    expect(holder).toBe(a.ok ? 'Ana' : 'Ben');
  });
});
