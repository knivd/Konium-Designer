/**
 * The world parts library's service with stand-ins around it (GitHub as far as the service uses
 * it, the mail service, a Durable Object's SQLite): the real ones can't be reached from the tests.
 * Shared by the service's tests (library200) and the app's client's (library201).
 */
import type { LibraryEnv } from '../../cloudflare/library/src/handler';
import type { Sql } from '../../cloudflare/library/src/store';

export function sqlite(): Sql {
  // Node's own SQLite, as a Durable Object's: a statement runs when given
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

export const b64 = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const hex40 = (n: number): string => n.toString(16).padStart(40, '0');

/** GitHub as far as the service uses it (git data, raw files), and the mail service. */
export function world() {
  const blobs = new Map<string, string>();                               // sha → base64
  const trees = new Map<string, { base: string; files: Record<string, string> }>();   // sha → path → blob sha or text
  const commits = new Map<string, { tree: string; parent: string; message: string; author: { name: string; email: string } }>();
  const mails: { to: string[]; from: string; subject: string; text: string }[] = [];
  const calls: string[] = [];
  let n = 1, head = hex40(n++);
  trees.set('tree0', { base: '', files: {} });
  commits.set(head, { tree: 'tree0', parent: '', message: 'Initial commit', author: { name: 'x', email: 'x' } });
  const state = { refuseMove: 0, mailFails: false };
  const filesAt = (commit: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (t: string) => { const tr = trees.get(t); if (!tr) return; if (tr.base) walk(tr.base); Object.assign(out, tr.files); };
    walk(commits.get(commit)?.tree ?? '');
    return out;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace('https://api.github.com/repos/o/parts', 'gh:').replace('https://raw.githubusercontent.com/o/parts/', 'raw:')}`);
    if (url === 'https://api.resend.com/emails') {
      if (state.mailFails) return json({ message: 'no' }, 500);
      mails.push(JSON.parse(String(init!.body)) as (typeof mails)[number]);
      return json({ id: 'm1' });
    }
    if (url.startsWith('https://raw.githubusercontent.com/o/parts/')) {
      const [ref, ...rest] = url.slice('https://raw.githubusercontent.com/o/parts/'.length).split('/');
      const v = filesAt(ref === 'main' ? head : ref!)[decodeURIComponent(rest.join('/'))];
      if (v === undefined) return new Response('404: Not Found', { status: 404 });
      return new Response(/^[0-9a-f]{40}$/.test(v) && blobs.has(v) ? Uint8Array.from(atob(blobs.get(v)!), (c) => c.charCodeAt(0)) : v);
    }
    const path = url.replace('https://api.github.com/repos/o/parts', '');
    if ((init?.headers as Record<string, string>)?.Authorization !== 'Bearer gh-token') return json({ message: 'Bad credentials' }, 401);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown>
      : init?.body ? JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) as Record<string, unknown> : {};
    if (method === 'GET' && path === '/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { sha: head, type: 'commit' } });
    if (method === 'GET' && path.startsWith('/git/commits/')) { const c = commits.get(path.slice(13)); return c ? json({ sha: path.slice(13), tree: { sha: c.tree } }) : json({}, 404); }
    if (method === 'POST' && path === '/git/blobs') { const sha = hex40(n++); blobs.set(sha, String(body.content)); return json({ sha, url: 'u' }, 201); }
    if (method === 'POST' && path === '/git/trees') {
      const sha = `tree${n++}`, files: Record<string, string> = {};
      for (const f of body.tree as { path: string; sha?: string; content?: string; mode: string; type: string }[]) files[f.path] = f.sha ?? f.content ?? '';
      trees.set(sha, { base: String(body.base_tree), files });
      return json({ sha }, 201);
    }
    if (method === 'POST' && path === '/git/commits') {
      const sha = hex40(n++);
      commits.set(sha, { tree: String(body.tree), parent: (body.parents as string[])[0]!, message: String(body.message), author: body.author as { name: string; email: string } });
      return json({ sha }, 201);
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      if (state.refuseMove > 0) { state.refuseMove--; head = hex40(n++); commits.set(head, { tree: commits.get(commits.get(String(body.sha))!.parent)!.tree, parent: '', message: 'Someone else', author: { name: 'y', email: 'y' } }); return json({ message: 'Update is not a fast forward' }, 422); }
      if (commits.get(String(body.sha))!.parent !== head) return json({ message: 'Update is not a fast forward' }, 422);
      head = String(body.sha);
      return json({ ref: 'refs/heads/main', object: { sha: head } });
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return { fetchFn, mails, calls, blobs, commits, state, filesAt, head: () => head, put: (path: string, text: string) => { trees.get(commits.get(head)!.tree)!.files[path] = text; } };
}

export const ENV: LibraryEnv = { GITHUB_TOKEN: 'gh-token', LIBRARY_REPO: 'o/parts', LIBRARY_SECRET: 'a long secret', RESEND_KEY: 're_key' };
export const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
