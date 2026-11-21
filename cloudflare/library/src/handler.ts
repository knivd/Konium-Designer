/**
 * The world parts library (konium.app/api/library; R21, step 2): parts published by Konium
 * Designer's users, kept in a public Git repository at GitHub, given to the public domain
 * (CC0 1.0), and fetched by anyone who types the same part number.
 *
 * - Fetching needs no sign-in. A part is found by its key (its part number in upper case, letters
 *   and digits only); its files are passed on from the repository as they are.
 * - Publishing needs a sign-in: a link mailed to an address, confirmed by a press on the page it
 *   opens (so a mail scanner that follows links signs nobody in). The address is kept in this
 *   service's own store and never published: a part carries a contributor number made from it
 *   with the service's secret, and the name the contributor chose to show, if any.
 * - This Worker reads no library file. The app sends the symbol's and the footprint's libraries
 *   as GitHub's own blob requests, passed on as they came (so a part costs next to no processor
 *   time here), and gets a pass for each; publishing then names the two blobs and sends the
 *   record, which is checked as text. One commit holds a part's four files.
 * - A part already in the library can be published again only by whoever published it, and only
 *   while it is unverified (approval is the next step's).
 *
 * GET  /config                 is the library set up; its repository and licence
 * GET  /part/<key>             { found, entry, commit }: the library's note about a part
 * GET  /part/<key>/<file>?c=   part.json, symbol.SchLib or footprint.PcbLib, at that commit
 * POST /signin   { email }     mails the link → { ticket }
 * GET  /confirm?id=&code=      the page the link opens; its button POSTs /confirm
 * POST /session  { ticket }    → { pending } until confirmed, then { token, user }
 * GET  /me                     (signed in) → { user }
 * POST /blob?kind=symbol|footprint   (signed in) GitHub's blob request, passed on → { sha, pass }
 * POST /publish  { record, symbol: { sha, pass }, footprint: { sha, pass }, licence, name, app }   (signed in)
 */
import { partKey } from '../../../src/model/partKey';
import {
  ENTRY_FILE, FOOTPRINT_FILE, KEY_FORMAT, LIBRARY_FILES, LIBRARY_LICENCE, MAX_FOOTPRINT, MAX_NOTE, MAX_RECORD, MAX_SYMBOL, MIN_NOTE, RECORD_FILE, STATUS_NAMES, SYMBOL_FILE, VERDICTS, WORDS_OF,
  cleanRecord, forMessage, mailAddress, oneLine, partFolder, readEntry, recordProblems, shownName, standing, standingText, type LibraryEntry, type LibraryFile,
} from '../../../src/model/worldLibrary';
import type { Contributor, Indexed, SignIn, Taken } from './store';
import { limitKey } from '../../limitKey';
import { bodyUpTo, jsonUpTo } from '../../body';

export interface Mailer { send(m: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> }

export interface LibraryEnv {
  /** A token for the library's repository alone: Contents, read and write (a secret). */
  GITHUB_TOKEN?: string;
  /** The public repository, "owner/name", and its branch (main). */
  LIBRARY_REPO?: string;
  LIBRARY_BRANCH?: string;
  /** Long random text (a secret): signs sessions and passes, makes contributor numbers, stands in for IP addresses. */
  LIBRARY_SECRET?: string;
  /** How the sign-in mail goes: Cloudflare's Email Service binding, or Resend with this key (a secret). */
  EMAIL?: Mailer;
  RESEND_KEY?: string;
  /** The sender: an address on the site's domain, and the name shown with it. */
  MAIL_FROM?: string;
  MAIL_NAME?: string;
  /** Where the mailed link leads (https://konium.app). */
  SITE?: string;
  FETCH_PER_DAY?: string;
  SIGNIN_PER_HOUR?: string;
  PUBLISH_PER_DAY?: string;
  /** How many words about parts (checks, builds, problems) one contributor may send in a day. */
  CHECK_PER_DAY?: string;
}

/** The Durable Object's methods (LibraryStoreLogic's), called over RPC. */
export interface LibraryStoreApi {
  take(period: string, who: string, kind: string, limit: number): Taken | Promise<Taken>;
  startSignIn(s: SignIn): void | Promise<void>;
  signIn(id: string): SignIn | null | Promise<SignIn | null>;
  confirmSignIn(id: string): void | Promise<void>;
  endSignIn(id: string): void | Promise<void>;
  contributor(uid: string): Contributor | null | Promise<Contributor | null>;
  keepContributor(uid: string, email: string, name: string | null, now: number, client?: string | null): void | Promise<void>;
  part(key: string): Indexed | null | Promise<Indexed | null>;
  keepPart(p: Indexed): void | Promise<void>;
  partCount(): number | Promise<number>;
  prune(beforePeriod: string, now: number): void | Promise<void>;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const int = (v: string | undefined, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && v !== undefined && v !== '' ? n : d; };

export const limits = (env: LibraryEnv) => ({ fetch: int(env.FETCH_PER_DAY, 500), signin: int(env.SIGNIN_PER_HOUR, 5), publish: int(env.PUBLISH_PER_DAY, 20), check: int(env.CHECK_PER_DAY, 40) });
/** A sign-in link's life, a session's, and a blob pass's. */
export const SIGNIN_MS = 15 * 60_000, SESSION_MS = 90 * 86_400_000, PASS_MS = 30 * 60_000;
/**
 * Sign-in mails to one address in an hour, whoever asks (so nobody's inbox is filled in their
 * name), with as many again for whoever asks from where that address last signed in (so strangers
 * using up the first lot cannot keep a contributor out); and for the whole service in an hour
 * and in a day (what the sending of mail may come to, whoever asks and from wherever).
 */
const MAILS_PER_ADDRESS = 3, MAILS_PER_HOUR = 60, MAILS_PER_DAY = 400;
/** A small request's body at most (a sign-in, a ticket). */
const SMALL = 4096;

const API = 'https://api.github.com';
const repoOf = (env: LibraryEnv) => (env.LIBRARY_REPO && /^[\w.-]+\/[\w.-]+$/.test(env.LIBRARY_REPO) ? env.LIBRARY_REPO : '');
const branchOf = (env: LibraryEnv) => (env.LIBRARY_BRANCH && /^[\w./-]{1,80}$/.test(env.LIBRARY_BRANCH) ? env.LIBRARY_BRANCH : 'main');
const siteOf = (env: LibraryEnv) => (env.SITE && /^https:\/\/[\w.-]+$/.test(env.SITE) ? env.SITE : 'https://konium.app');
/** Can parts be fetched and published; can anyone sign in. */
export const ready = (env: LibraryEnv) => !!(env.GITHUB_TOKEN && repoOf(env) && env.LIBRARY_SECRET);
export const canSignIn = (env: LibraryEnv) => ready(env) && !!(env.EMAIL || env.RESEND_KEY);

/* ─── Signing ─────────────────────────────────────────────────────────────────────────── */

async function hmac(key: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Compared in full, whatever differs. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Who a request counts as, for the limits: a hash of the IP address (an IPv6 address by its /64). */
async function clientOf(req: Request, env: LibraryEnv): Promise<string> {
  return (await hmac(env.LIBRARY_SECRET ?? '', `ip|${limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown')}`)).slice(0, 24);
}
/** A contributor, from the address: the same address is always the same contributor, and the address can't be had back from it. */
export const uidOf = async (env: LibraryEnv, email: string): Promise<string> => (await hmac(env.LIBRARY_SECRET ?? '', `uid|${email}`)).slice(0, 16);
/** The number a contributor's parts carry. */
export const byOf = (uid: string): string => `k-${uid.slice(0, 8)}`;

export async function sessionFor(env: LibraryEnv, uid: string, now: number): Promise<{ token: string; until: number }> {
  const until = now + SESSION_MS;
  return { token: `${uid}.${until}.${await hmac(env.LIBRARY_SECRET ?? '', `session|${uid}|${until}`)}`, until };
}
/** Whose session a request carries; null when none, or it is over, or it isn't this service's. */
async function signedIn(req: Request, env: LibraryEnv, now: number): Promise<string | null> {
  const m = /^Bearer ([0-9a-f]{16})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(req.headers.get('Authorization') ?? '');
  if (!m || !env.LIBRARY_SECRET || !(Number(m[2]) > now)) return null;
  return same(await hmac(env.LIBRARY_SECRET, `session|${m[1]}|${m[2]}`), m[3]!) ? m[1]! : null;
}

type BlobKind = 'symbol' | 'footprint';
async function blobPass(env: LibraryEnv, uid: string, kind: BlobKind, sha: string, now: number): Promise<string> {
  const until = now + PASS_MS;
  return `${until}.${await hmac(env.LIBRARY_SECRET ?? '', `blob|${uid}|${kind}|${sha}|${until}`)}`;
}
async function passGood(env: LibraryEnv, uid: string, kind: BlobKind, v: unknown, now: number): Promise<string | null> {
  const o = (v && typeof v === 'object' ? v : {}) as { sha?: unknown; pass?: unknown };
  const m = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(typeof o.pass === 'string' ? o.pass : '');
  if (!m || typeof o.sha !== 'string' || !/^[0-9a-f]{40}$/.test(o.sha) || !(Number(m[1]) > now)) return null;
  return same(await hmac(env.LIBRARY_SECRET ?? '', `blob|${uid}|${kind}|${o.sha}|${m[1]}`), m[2]!) ? o.sha : null;
}

/* ─── The repository ──────────────────────────────────────────────────────────────────── */

const rawUrl = (env: LibraryEnv, ref: string, path: string) => `https://raw.githubusercontent.com/${repoOf(env)}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;

function gh(env: LibraryEnv, fetchFn: typeof fetch, method: string, path: string, body?: BodyInit): Promise<Response> {
  return fetchFn(`${API}/repos/${repoOf(env)}${path}`, {
    method, body,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'konium-library', 'Content-Type': 'application/json' },
  });
}
async function ghJson(env: LibraryEnv, fetchFn: typeof fetch, method: string, path: string, body?: object): Promise<Record<string, unknown>> {
  const res = await gh(env, fetchFn, method, path, body ? JSON.stringify(body) : undefined);
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path.split('/').slice(0, 3).join('/')}: ${res.status} ${(await res.text()).slice(0, 160)}`), { status: res.status });
  return res.json() as Promise<Record<string, unknown>>;
}

/** A part the index doesn't know, looked for in the repository itself (it may have been added there by hand, or the index lost). */
async function fromRepo(env: LibraryEnv, fetchFn: typeof fetch, key: string): Promise<LibraryEntry | null> {
  const res = await fetchFn(rawUrl(env, branchOf(env), `${partFolder(key)}/${ENTRY_FILE}`));
  if (!res.ok) return null;
  try { const e = readEntry(await res.json()); return e && e.key === key ? e : null; } catch { return null; }
}

/** The library's note as the store keeps it, and back: what is said of the part travels as text beside the note's own fields. */
const said = (e: LibraryEntry): string => (e.checked || e.built || e.problems ? JSON.stringify({ checked: e.checked, built: e.built, problems: e.problems }) : '');
const indexed = (e: LibraryEntry, commit: string, uid: string): Indexed => ({ key: e.key, mpn: e.mpn, status: e.status, by: e.by, name: e.name, published: e.published, revision: e.revision, licence: e.licence, app: e.app, commit, uid, more: said(e) });
function entryOf(ix: Indexed): LibraryEntry {
  let more: object = {};
  try { more = ix.more ? JSON.parse(ix.more) as object : {}; } catch { /* kept as nothing */ }
  const { commit: _c, uid: _u, more: _m, ...plain } = ix;
  return readEntry({ ...plain, ...more }) ?? (plain as unknown as LibraryEntry);
}

/** A part's files (all four, or its note alone) as one commit on the branch; tried again when another commit came between. */
async function commitPart(env: LibraryEnv, fetchFn: typeof fetch, o: { folder: string; record?: string; entry: string; symbol?: string; footprint?: string; message: string; author: { name: string; email: string; date: string } }): Promise<string> {
  const branch = branchOf(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = String((((await ghJson(env, fetchFn, 'GET', `/git/ref/heads/${branch}`)).object ?? {}) as { sha?: string }).sha ?? '');
    const base = String((((await ghJson(env, fetchFn, 'GET', `/git/commits/${head}`)).tree ?? {}) as { sha?: string }).sha ?? '');
    const file = (name: string, what: { content: string } | { sha: string }) => ({ path: `${o.folder}/${name}`, mode: '100644', type: 'blob', ...what });
    const tree = await ghJson(env, fetchFn, 'POST', '/git/trees', {
      base_tree: base,
      tree: [...(o.record === undefined ? [] : [file(RECORD_FILE, { content: o.record })]), file(ENTRY_FILE, { content: o.entry }),
        ...(o.symbol === undefined ? [] : [file(SYMBOL_FILE, { sha: o.symbol })]), ...(o.footprint === undefined ? [] : [file(FOOTPRINT_FILE, { sha: o.footprint })])],
    });
    const commit = String((await ghJson(env, fetchFn, 'POST', '/git/commits', { message: o.message, tree: tree.sha, parents: [head], author: o.author })).sha ?? '');
    const moved = await gh(env, fetchFn, 'PATCH', `/git/refs/heads/${branch}`, JSON.stringify({ sha: commit, force: false }));
    if (moved.ok) return commit;
    // Not a fast-forward: someone else's part went in meanwhile
    if (moved.status !== 422 && moved.status !== 409) throw new Error(`GitHub PATCH /git/refs: ${moved.status} ${(await moved.text()).slice(0, 160)}`);
  }
  throw new Error('the repository was busy');
}

/* ─── Mail and pages ──────────────────────────────────────────────────────────────────── */

async function sendMail(env: LibraryEnv, fetchFn: typeof fetch, m: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const from = mailAddress(env.MAIL_FROM) || 'library@konium.app', name = (env.MAIL_NAME || 'Konium parts library').replace(/[<>"\r\n]/g, '');
  if (env.EMAIL) { await env.EMAIL.send({ ...m, from }); return; }
  if (!env.RESEND_KEY) throw new Error('no way to send mail is set up');
  const res = await fetchFn('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${name} <${from}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) throw new Error(`mail: HTTP ${res.status}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f5f7;color:#1c2630}main{max-width:460px;margin:12vh auto 0;padding:28px 28px 24px;background:#fff;border:1px solid #d5dbe1;border-radius:10px}
h1{margin:0 0 10px;font-size:20px}p{margin:0 0 12px}.dim{color:#5c6b7a;font-size:14px}button{font:inherit;font-weight:600;padding:9px 18px;border:0;border-radius:6px;background:#2f6fb3;color:#fff;cursor:pointer}button:hover{background:#285f9a}
@media(prefers-color-scheme:dark){body{background:#101815;color:#e6ece9}main{background:#17221e;border-color:#2b3a34}.dim{color:#9fb0a8}button{background:#d2b04c;color:#13201d}button:hover{background:#dfbf5f}}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
const STALE = () => page('The parts library: link no longer good', '<h1>This link is no longer good</h1><p>It works once, for 15 minutes. Ask for a new one in Konium Designer (Tools › Parts, a part\'s Publish).</p>', 410);

/* ─── The requests ────────────────────────────────────────────────────────────────────── */

export async function handle(req: Request, env: LibraryEnv, store: LibraryStoreApi, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '').replace(/^.*?\/api\/library/, '');
  const stamp = new Date(now).toISOString(), day = stamp.slice(0, 10), hour = stamp.slice(0, 13);
  const lim = limits(env);
  const repo = repoOf(env);

  if (req.method === 'GET' && path === '/config') {
    return reply({ ready: ready(env), signIn: canSignIn(env), repo, web: repo ? `https://github.com/${repo}` : '', licence: LIBRARY_LICENCE, publishPerDay: lim.publish, parts: ready(env) ? await store.partCount() : 0 });
  }
  if (!ready(env)) return reply({ error: 'The parts library isn\'t set up on the Konium service yet' }, 503);

  /* Fetching */
  const part = /^\/part\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (req.method === 'GET' && part) {
    const key = part[1]!;
    if (!KEY_FORMAT.test(key)) return reply({ error: 'Not a part\'s key' }, 400);
    if (part[2] !== undefined) {
      const file = part[2] as LibraryFile;
      if (!LIBRARY_FILES.includes(file)) return reply({ error: 'Not a part\'s file' }, 404);
      const c = url.searchParams.get('c') ?? '';
      const at = /^[0-9a-f]{40}$/.test(c);
      const res = await fetchFn(rawUrl(env, at ? c : branchOf(env), `${partFolder(key)}/${file}`));
      if (!res.ok) return reply({ error: 'That file isn\'t in the library' }, 404);
      // (passed on as it is: a commit's files never change, so they may be kept for good)
      return new Response(res.body, { headers: { ...CORS, 'Content-Type': file === RECORD_FILE ? 'application/json' : 'application/octet-stream', 'Cache-Control': at ? 'public, max-age=31536000, immutable' : 'public, max-age=120', 'X-Content-Type-Options': 'nosniff' } });
    }
    const client = await clientOf(req, env);
    if (!(await store.take(day, client, 'fetch', lim.fetch)).ok) return reply({ error: `That's today's ${lim.fetch} look-ups in the parts library from here: the count starts again tomorrow (UTC)` }, 429);
    const known = await store.part(key);
    if (known) return reply({ found: true, entry: entryOf(known), commit: known.commit });
    const entry = await fromRepo(env, fetchFn, key);
    if (!entry) return reply({ found: false });
    await store.keepPart(indexed(entry, '', ''));
    return reply({ found: true, entry, commit: '' });
  }

  /* Signing in */
  if (req.method === 'POST' && path === '/signin') {
    if (!canSignIn(env)) return reply({ error: 'Signing in to the parts library isn\'t set up on the Konium service yet' }, 503);
    const body = await jsonUpTo<{ email?: unknown }>(req, SMALL);
    if (body === 'long' || body === 'bad' || !body || typeof body !== 'object') return reply({ error: 'Not a sign-in' }, 400);
    const email = mailAddress(body.email);
    if (!email) return reply({ error: 'That is not an email address' }, 400);
    const client = await clientOf(req, env), uid = await uidOf(env, email);
    if (!(await store.take(hour, client, 'signin', lim.signin)).ok) return reply({ error: 'Too many sign-in links asked for from here: try again in an hour' }, 429);
    if (!(await store.take(hour, uid, 'signin-to', MAILS_PER_ADDRESS)).ok) {
      // The address's own lot is used up: whoever asks from where it last signed in still gets theirs
      const known = await store.contributor(uid);
      if (!known || !known.client || known.client !== client || !(await store.take(hour, uid, 'signin-own', MAILS_PER_ADDRESS)).ok) return reply({ error: 'Too many sign-in links sent to that address: try again in an hour' }, 429);
    }
    if (!(await store.take(hour, 'everyone', 'signin', MAILS_PER_HOUR)).ok || !(await store.take(day, 'everyone', 'signin', MAILS_PER_DAY)).ok) return reply({ error: 'The parts library is sending no more sign-in links just now: try again in an hour' }, 429);
    const id = randomHex(16), code = randomHex(20);
    await store.startSignIn({ id, uid, email, code: await hmac(env.LIBRARY_SECRET!, `code|${code}`), until: now + SIGNIN_MS, confirmed: false });
    const link = `${siteOf(env)}/api/library/confirm?id=${id}&code=${code}`;
    try {
      await sendMail(env, fetchFn, {
        to: email, subject: 'Your sign-in link for the Konium parts library',
        text: `Someone asked to sign in to the Konium parts library with this address, from Konium Designer.\n\nIf it was you, open this link and confirm (it works once, for 15 minutes):\n${link}\n\nIf it was not you, do nothing: without the link nobody is signed in.\n\nKonium Designer, ${siteOf(env)}\n`,
        html: `<p>Someone asked to sign in to the Konium parts library with this address, from Konium Designer.</p><p>If it was you, open this link and confirm (it works once, for 15 minutes):<br><a href="${esc(link)}">${esc(link)}</a></p><p>If it was not you, do nothing: without the link nobody is signed in.</p><p>Konium Designer, <a href="${esc(siteOf(env))}">${esc(siteOf(env).replace('https://', ''))}</a></p>`,
      });
    } catch (e) {
      console.log(`library: sign-in mail: ${(e as Error).message}`);
      await store.endSignIn(id);
      return reply({ error: 'The sign-in link couldn\'t be sent: try again shortly' }, 502);
    }
    await store.prune(new Date(now - 3 * 86_400_000).toISOString().slice(0, 10), now);
    return reply({ ticket: id, minutes: SIGNIN_MS / 60_000 });
  }

  if (path === '/confirm' && (req.method === 'GET' || req.method === 'POST')) {
    let id = url.searchParams.get('id') ?? '', code = url.searchParams.get('code') ?? '';
    if (req.method === 'POST') {
      const sent = await bodyUpTo(req, SMALL);
      if (!sent) return STALE();
      const form = new URLSearchParams(new TextDecoder().decode(sent));
      id = form.get('id') ?? ''; code = form.get('code') ?? '';
    }
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{40}$/.test(code)) return STALE();
    const s = await store.signIn(id);
    if (!s || !(s.until > now) || !same(await hmac(env.LIBRARY_SECRET!, `code|${code}`), s.code)) return STALE();
    if (req.method === 'GET') {
      // The press is what signs in: a mail scanner that only follows the link gets this page and no further
      return page('The parts library: confirm your sign-in',
        `<h1>Sign in to the Konium parts library</h1><p>Someone asked to sign in with this address from Konium Designer. If it was you, confirm.</p><form method="post" action="/api/library/confirm"><input type="hidden" name="id" value="${id}"><input type="hidden" name="code" value="${code}"><p><button type="submit">Confirm My Sign-In</button></p></form><p class="dim">If it was not you, close this page: nothing happens.</p>`);
    }
    await store.confirmSignIn(id);
    return page('The parts library: signed in', '<h1>You are signed in</h1><p>Go back to Konium Designer: it has noticed already. You can close this page.</p><p class="dim">Your address is kept by the library to sign you in and to reach you about your parts. It is never published: your parts carry a contributor number instead.</p>');
  }

  if (req.method === 'POST' && path === '/session') {
    const body = await jsonUpTo<{ ticket?: unknown }>(req, SMALL);
    if (body === 'long' || body === 'bad' || !body || typeof body !== 'object') return reply({ error: 'Not a sign-in' }, 400);
    const ticket = typeof body.ticket === 'string' && /^[0-9a-f]{32}$/.test(body.ticket) ? body.ticket : '';
    const s = ticket ? await store.signIn(ticket) : null;
    if (!s || !(s.until > now)) return reply({ error: 'That sign-in link ran out: ask for a new one' }, 410);
    if (!s.confirmed) return reply({ pending: true });
    await store.endSignIn(ticket);
    await store.keepContributor(s.uid, s.email, null, now, await clientOf(req, env));
    const c = await store.contributor(s.uid);
    return reply({ ...(await sessionFor(env, s.uid, now)), user: { id: byOf(s.uid), name: c?.name ?? '', email: s.email } });
  }

  /* Signed in from here on */
  const mine = path === '/me' || path === '/blob' || path === '/publish' || path === '/check';
  if (!mine) return reply({ error: 'Not here' }, 404);
  const uid = await signedIn(req, env, now);
  if (!uid) return reply({ error: 'Sign in to the parts library first' }, 401);

  if (req.method === 'GET' && path === '/me') {
    const c = await store.contributor(uid);
    return reply({ user: { id: byOf(uid), name: c?.name ?? '', email: c?.email ?? '' } });
  }

  if (req.method === 'POST' && path === '/blob') {
    const kind = url.searchParams.get('kind') as BlobKind;
    if (kind !== 'symbol' && kind !== 'footprint') return reply({ error: 'Not a part\'s file' }, 400);
    const most = kind === 'symbol' ? MAX_SYMBOL : MAX_FOOTPRINT;
    // (the request is GitHub's own: {"content":"<base64>","encoding":"base64"}; base64 is four characters for three bytes)
    const room = Math.ceil(most / 3) * 4 + 64;
    const body = await bodyUpTo(req, room);
    if (!body) return reply({ error: `The ${kind}'s library is too large for the parts library (${Math.round(most / 1024)} KB at most)` }, 413);
    // A compound file (as .SchLib and .PcbLib are) starts D0 CF 11 E0 A1 B1 1A E1: "0M8R4KGxGuE" in base64. The request must be
    // GitHub's blob request to the letter and nothing more: it begins and ends as that does, and between the two there is no
    // quote and no backslash (the only ways a string in JSON ends early or carries something other than itself).
    const ends = new TextDecoder();
    const head = ends.decode(body.subarray(0, 23)), tail = ends.decode(body.subarray(Math.max(0, body.byteLength - 22)));
    const inner = body.subarray(12, Math.max(12, body.byteLength - 22));
    if (head !== '{"content":"0M8R4KGxGuE' || tail !== '","encoding":"base64"}' || inner.indexOf(0x22) >= 0 || inner.indexOf(0x5c) >= 0) return reply({ error: `That is not a ${kind}'s library` }, 400);
    if (!(await store.take(day, uid, 'blob', lim.publish * 4)).ok) return reply({ error: 'Too many files sent today: try again tomorrow (UTC)' }, 429);
    const res = await gh(env, fetchFn, 'POST', '/git/blobs', body as Uint8Array<ArrayBuffer>);
    if (!res.ok) { console.log(`library: blob: GitHub ${res.status} ${(await res.text()).slice(0, 160)}`); return reply({ error: 'The repository didn\'t take the file: try again shortly' }, 502); }
    const sha = String(((await res.json()) as { sha?: unknown }).sha ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha)) return reply({ error: 'The repository didn\'t take the file: try again shortly' }, 502);
    return reply({ sha, pass: await blobPass(env, uid, kind, sha, now) });
  }

  if (req.method === 'POST' && path === '/publish') {
    const body = await jsonUpTo<{ record?: unknown; symbol?: unknown; footprint?: unknown; licence?: unknown; name?: unknown; app?: unknown }>(req, MAX_RECORD + 4096);
    if (body === 'long') return reply({ error: 'The part\'s record is too large' }, 413);
    if (body === 'bad' || !body || typeof body !== 'object') return reply({ error: 'Not a part' }, 400);
    const problems = recordProblems(body.record);
    if (problems.length) return reply({ error: 'This part can\'t be published as it is', problems }, 400);
    if (body.licence !== LIBRARY_LICENCE) return reply({ error: 'The parts library takes parts given to the public domain (CC0 1.0) only' }, 400);
    const symbol = await passGood(env, uid, 'symbol', body.symbol, now), footprint = await passGood(env, uid, 'footprint', body.footprint, now);
    if (!symbol || !footprint) return reply({ error: 'The symbol and the footprint must be sent again: their passes ran out' }, 400);
    const record = cleanRecord(body.record), key = partKey(record.mpn);
    const had = (await store.part(key)) ?? (await fromRepo(env, fetchFn, key).then((e) => (e ? indexed(e, '', '') : null)));
    if (had && (had.uid !== uid || had.status !== 'unverified')) {
      return reply({ error: `${had.mpn} is in the parts library already${had.by ? `, published by ${had.name || had.by}` : ''}`, entry: entryOf(had) }, 409);
    }
    if (!(await store.take(day, uid, 'publish', lim.publish)).ok) return reply({ error: `That's today's ${lim.publish} parts published: the count starts again tomorrow (UTC)` }, 429);
    const who = await store.contributor(uid);
    const name = body.name === undefined ? (who?.name ?? '') : shownName(body.name);
    const entry: LibraryEntry = {
      key, mpn: record.mpn, status: 'unverified', by: byOf(uid), name, published: stamp, revision: (had?.revision ?? 0) + 1, licence: LIBRARY_LICENCE,
      app: typeof body.app === 'string' && /^[\w.]{1,20}$/.test(body.app) ? body.app : '',
    };
    const folder = partFolder(key);
    let commit: string;
    try {
      commit = await commitPart(env, fetchFn, {
        folder, record: `${JSON.stringify(record, null, 1)}\n`, entry: `${JSON.stringify(entry, null, 1)}\n`, symbol, footprint,
        // (the part's own words go into the message on one line, with nothing a repository's site reads as a mention or a reference)
        message: `${had ? 'Update' : 'Add'} ${forMessage(record.mpn)} (${forMessage(record.maker)}; ${forMessage(record.package.name)}, ${record.package.pins} pins)${had ? `, revision ${entry.revision}` : ''}\n\nPublished from Konium Designer${entry.app ? ` ${entry.app}` : ''} by ${name ? `${forMessage(name)} (${entry.by})` : entry.by}, under ${LIBRARY_LICENCE}.\n`,
        author: { name: forMessage(name) || entry.by, email: `${entry.by}@parts.konium.app`, date: stamp },
      });
    } catch (e) {
      console.log(`library: publish: ${(e as Error).message}`);
      return reply({ error: 'The repository didn\'t take the part: try again shortly' }, 502);
    }
    await store.keepPart(indexed(entry, commit, uid));
    await store.keepContributor(uid, who?.email ?? '', name, now);
    return reply({ ok: true, entry, commit, url: `https://github.com/${repo}/tree/${branchOf(env)}/${folder}` });
  }

  /* Approval (step 3): what somebody else says of a part. It is right; a board with it works; something is wrong with it */
  if (req.method === 'POST' && path === '/check') {
    const body = await jsonUpTo<{ key?: unknown; revision?: unknown; verdict?: unknown; note?: unknown; name?: unknown }>(req, SMALL);
    if (body === 'long' || body === 'bad' || !body || typeof body !== 'object') return reply({ error: 'Not a word about a part' }, 400);
    const key = typeof body.key === 'string' ? body.key : '', verdict = VERDICTS.find((v) => v === body.verdict);
    if (!KEY_FORMAT.test(key) || !verdict || !Number.isInteger(body.revision)) return reply({ error: 'Not a word about a part' }, 400);
    const had = (await store.part(key)) ?? (await fromRepo(env, fetchFn, key).then((e) => (e ? indexed(e, '', '') : null)));
    if (!had) return reply({ error: 'That part isn\'t in the parts library' }, 404);
    const entry = entryOf(had), me = byOf(uid);
    if (entry.revision !== body.revision) return reply({ error: `${entry.mpn} is at revision ${entry.revision} in the parts library now: look it up again`, entry }, 409);
    // A part's own author has made their check already (it is what made the part Unverified), and puts a fault right by publishing again
    if (verdict !== 'built' && (had.uid === uid || entry.by === me)) {
      return reply({ error: verdict === 'confirm' ? 'A confirmation is somebody else\'s check: this part is your own' : 'This part is your own: publish it again with the fault put right', entry }, 403);
    }
    const note = verdict === 'problem' && typeof body.note === 'string' ? oneLine(body.note).slice(0, MAX_NOTE) : '';
    if (verdict === 'problem' && note.length < MIN_NOTE) return reply({ error: 'Say what is wrong with it, in a line' }, 400);
    const list = WORDS_OF[verdict], before = entry[list] ?? [];
    // (said already, and nothing new to add: the note stays as it is and nothing is committed)
    if (verdict !== 'problem' && before.some((w) => w.by === me)) return reply({ ok: true, entry, commit: had.commit });
    if (!(await store.take(day, uid, 'check', lim.check)).ok) return reply({ error: `That's today's ${lim.check} checks sent: the count starts again tomorrow (UTC)` }, 429);
    const who = await store.contributor(uid);
    // (the name to show: as given with this word, else the one chosen before)
    const shown = body.name === undefined ? (who?.name ?? '') : shownName(body.name);
    const word = { by: me, name: shown, at: stamp, ...(note ? { note } : {}) };
    const others = (l: 'checked' | 'built' | 'problems') => (entry[l] ?? []).filter((w) => w.by !== me);
    // One word of each kind from each contributor; whoever finds it right no longer finds it wrong, and the other way round
    const next = readEntry({
      ...entry, built: list === 'built' ? [...others('built'), word] : entry.built,
      checked: list === 'checked' ? [...others('checked'), word] : list === 'problems' ? others('checked') : entry.checked,
      problems: list === 'problems' ? [...others('problems'), word] : list === 'checked' ? others('problems') : entry.problems,
    })!;
    next.status = standing(next);
    const folder = partFolder(key), name = STATUS_NAMES[next.status];
    const what = verdict === 'confirm' ? `Checked: ${forMessage(entry.mpn)} (${standingText(next)}; ${name})` : verdict === 'built' ? `Built: ${forMessage(entry.mpn)} (${standingText(next)}; ${name})` : `Problem with ${forMessage(entry.mpn)} (${standingText(next)}; ${name})`;
    let commit: string;
    try {
      commit = await commitPart(env, fetchFn, {
        folder, entry: `${JSON.stringify(next, null, 1)}\n`,
        message: `${what}\n\n${note ? `${forMessage(note)}\n\n` : ''}Revision ${entry.revision}, as said by ${forMessage(word.name) || me} in Konium Designer.\n`,
        author: { name: forMessage(word.name) || me, email: `${me}@parts.konium.app`, date: stamp },
      });
    } catch (e) {
      console.log(`library: check: ${(e as Error).message}`);
      return reply({ error: 'The repository didn\'t take it: try again shortly' }, 502);
    }
    await store.keepPart(indexed(next, commit, had.uid));
    await store.keepContributor(uid, who?.email ?? '', shown, now);
    return reply({ ok: true, entry: next, commit });
  }
  return reply({ error: 'Not here' }, 404);
}
