import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// (In tests/tools, which the type check leaves out: it uses Node's own modules to run a Git server.)
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFolder, asHandle } from '../helpers/fakeFolder';
import { cloneInto, commitFiles, createRepo, fetchRemote, integrate, lockFiles, pushRemote, readLocks, repoAt, unlockFiles, type Remote } from '../../src/vcs/git';

/**
 * The team's own Git server, here Git's own (git http-backend behind a small server that asks
 * for a password before taking a push), reached the way the page reaches one.
 */
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const ME = { name: 'Ana', email: 'ana@example.com' }, YOU = { name: 'Ben', email: 'ben@example.com' };
const AUTH = { username: 'ana', password: 'secret-token' };

describe.skipIf(!hasGit)('Version control (R7): the team\'s own Git server', () => {
  let root = '', server: Server, url = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'konium-git-'));
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', join(root, 'demo.git')]);
    execFileSync('git', ['-C', join(root, 'demo.git'), 'config', 'http.receivepack', 'true']);
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const pushing = u.pathname.endsWith('git-receive-pack') || u.searchParams.get('service') === 'git-receive-pack';
      if (pushing && req.headers.authorization !== `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')}`) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }); res.end(); return;
      }
      const p = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'ana', REMOTE_ADDR: '127.0.0.1' } });
      req.pipe(p.stdin);
      let buf = Buffer.alloc(0), done = false;
      p.stdout.on('data', (c: Buffer) => {
        if (done) { res.write(c); return; }
        buf = Buffer.concat([buf, c]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        let status = 200;
        for (const line of buf.subarray(0, i).toString().split('\r\n')) {
          const k = line.slice(0, line.indexOf(':')), v = line.slice(line.indexOf(':') + 1).trim();
          if (k.toLowerCase() === 'status') status = parseInt(v, 10); else res.setHeader(k, v);
        }
        res.statusCode = status; done = true; res.write(buf.subarray(i + 4));
      });
      p.stdout.on('end', () => res.end());
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/demo.git`;
  });
  afterAll(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('a project pushed to an empty repository, cloned, changed on both sides and merged; a wrong token refused in words', async () => {
    const remote: Remote = { kind: 'git', url };
    const A = new FakeFolder(), B = new FakeFolder();
    A.write('Demo.PrjPcb', 'prj'); A.write('Demo.SchDoc', 'sch 1'); A.write('Demo.PcbDoc', 'pcb 1');
    const ra = repoAt(asHandle(A)), rb = repoAt(asHandle(B));
    await createRepo(ra, ME, remote);
    await expect(pushRemote(ra, remote, { auth: { username: 'ana', password: 'wrong' }, relay: null })).rejects.toThrow(/refused the sign-in/);
    expect(await pushRemote(ra, remote, { auth: AUTH, relay: null })).toBe('pushed');
    expect(await cloneInto(rb, remote, { auth: AUTH, relay: null }, YOU)).toMatch(/^[0-9a-f]{40}$/);
    expect(B.text('Demo.PcbDoc')).toBe('pcb 1');
    A.write('Demo.SchDoc', 'sch 2'); await commitFiles(ra, ['Demo.SchDoc'], 'Sheet', ME);
    expect(await pushRemote(ra, remote, { auth: AUTH, relay: null })).toBe('pushed');
    B.write('Demo.PcbDoc', 'pcb 2'); await commitFiles(rb, ['Demo.PcbDoc'], 'Board', YOU);
    expect(await pushRemote(rb, remote, { auth: AUTH, relay: null })).toBe('behind');
    const up = await integrate(rb, await fetchRemote(rb, remote, { auth: AUTH, relay: null }), YOU, async () => new Map());
    expect([up.merged, B.text('Demo.SchDoc')]).toEqual([true, 'sch 2']);
    expect(await pushRemote(rb, remote, { auth: AUTH, relay: null })).toBe('pushed');
    // What Git itself sees in the server's repository
    const log = execFileSync('git', ['-C', join(root, 'demo.git'), 'log', '--format=%an %s', 'main']).toString().trim().split('\n');
    expect(log[0]).toMatch(/^Ben Update: /);
    expect(log).toContain('Ana Sheet');
    expect(execFileSync('git', ['-C', join(root, 'demo.git'), 'show', 'main:Demo.PcbDoc']).toString()).toBe('pcb 2');
  });

  it('locks on a Git server: kept on their own branch (konium-locks), apart from the project\'s history', async () => {
    const remote: Remote = { kind: 'git', url };
    const A = new FakeFolder(), B = new FakeFolder();
    const ra = repoAt(asHandle(A)), rb = repoAt(asHandle(B));
    expect(await cloneInto(ra, remote, { auth: AUTH, relay: null }, ME)).toMatch(/^[0-9a-f]{40}$/);
    expect(await cloneInto(rb, remote, { auth: AUTH, relay: null }, YOU)).toMatch(/^[0-9a-f]{40}$/);
    expect(await readLocks(ra, remote, { auth: AUTH, relay: null })).toEqual({});
    expect((await lockFiles(ra, remote, { auth: AUTH, relay: null }, ['Demo.PcbDoc'], ME)).ok).toBe(true);
    const refused = await lockFiles(rb, remote, { auth: AUTH, relay: null }, ['Demo.PcbDoc'], YOU);
    expect(refused.ok ? null : refused.holder.by).toBe('Ana');
    expect((await lockFiles(rb, remote, { auth: AUTH, relay: null }, ['Demo.SchDoc'], YOU)).ok).toBe(true);
    expect(Object.keys(await readLocks(ra, remote, { auth: AUTH, relay: null })).sort()).toEqual(['Demo.PcbDoc', 'Demo.SchDoc']);
    expect(Object.keys(await unlockFiles(ra, remote, { auth: AUTH, relay: null }, ['Demo.PcbDoc'], ME))).toEqual(['Demo.SchDoc']);
    const json = JSON.parse(execFileSync('git', ['-C', join(root, 'demo.git'), 'show', 'konium-locks:locks.json']).toString()) as Record<string, { by: string }>;
    expect(Object.keys(json)).toEqual(['Demo.SchDoc']);
    expect(execFileSync('git', ['-C', join(root, 'demo.git'), 'log', '--format=%s', 'main']).toString()).not.toMatch(/Locks/);
  });
});
