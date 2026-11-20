/**
 * Konium's bug reports: Help › Report a Bug posts here (multipart form), the Worker mails it to
 * the address kept in the REPORT_TO secret — that address is never in Konium or in this source.
 * Sent with Cloudflare Email Routing's send_email binding (to a verified destination: free).
 * When GITHUB_TOKEN and REPORTS_REPO are set, the report is also filed in that private
 * repository (its files committed, an issue opened) for the developer's AI assistant.
 *
 * Form fields: text (required), name, email, version, diagnostics, website (a trap for bots:
 * people never see it, so it stays empty), file (any number of attachments, 10 MB together).
 *
 * Larger attachments (26.196): the app zips them and names the zip in the form's `bulk` field
 * (its size, how many parts, what it holds). The report is filed without them and the answer
 * carries a pass; the app then posts each part to this same address with ?part=k&id=…&d=…&t=…,
 * and each is committed beside the report as attachments.zip.001, .002 … (joined in order they
 * are the zip). The mail names the zip; it does not carry it. Only the repository takes them.
 * A part is taken only when it is the app's own request for that part to the letter (github.ts,
 * partIsOurs), and is written once: one already there is left as it is.
 *
 * kind=contact (Help › Contact the Author: a question, or a security problem reported privately,
 * with its topic): a message to the author, mailed only — not filed in the reports repository —
 * and it needs an address to answer.
 */
import { EmailMessage } from 'cloudflare:email';
import { buildMail, oneLine, validEmail, type MailFile } from './mime';
import { BULK_NAME, MAX_BULK, MAX_PARTS, PART_BYTES, checkPass, filePart, fileReport, partName, uploadPass, type GitHubEnv } from './github';
import { limitKey } from '../../limitKey';
import { bodyUpTo } from '../../body';

interface Env extends GitHubEnv {
  REPORTS: { send(message: EmailMessage): Promise<void> };
  REPORT_TO: string;
  REPORT_FROM: string;
  LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Parts of large attachments a minute from one address at most. */
  PART_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

/** Attachments together, and the text. */
const MAX_FILES = 10 * 1024 * 1024, MAX_TEXT = 20_000;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply({ error: 'Reports are posted here' }, 405);
    const ip = limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown');
    // A part of a filed report's large attachments (so many a minute from one address: a report's own parts and a few sent again)
    const at = new URL(req.url).searchParams;
    if (at.has('part')) {
      if (env.PART_LIMITER && !(await env.PART_LIMITER.limit({ key: ip })).success) return reply({ error: 'Too many parts from here just now: try again in a minute' }, 429);
      return part(req, env, at);
    }
    const mail = !!(env.REPORT_TO && env.REPORT_FROM), repo = !!(env.GITHUB_TOKEN && env.REPORTS_REPO);
    if (!mail && !repo) return reply({ error: 'Reports aren\'t set up on the server yet' }, 503);
    // A few reports a minute from one address at most
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) return reply({ error: 'Too many reports from here just now: try again in a minute' }, 429);
    // Read no further than a report may be long, whatever its Content-Length says or leaves unsaid
    const raw = await bodyUpTo(req, Math.round(MAX_FILES * 1.1 + MAX_TEXT * 4 + 200_000));
    if (!raw) return reply({ error: 'The attachments are too large (10 MB together at most)' }, 413);

    let form: FormData;
    try { form = await new Response(raw as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': req.headers.get('Content-Type') ?? '' } }).formData(); } catch { return reply({ error: 'Not a report' }, 400); }
    const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    // A form filled in by a bot: thanked, and dropped
    if (field('website')) return reply({ ok: true });
    const contact = field('kind') === 'contact';
    const text = field('text').trim();
    if (!text) return reply({ error: contact ? 'Write your message' : 'Say what happened' }, 400);
    if (text.length > MAX_TEXT) return reply({ error: 'The description is too long' }, 400);

    const files: MailFile[] = [];
    let total = 0;
    for (const f of form.getAll('file')) {
      if (typeof f === 'string') continue;
      total += f.size;
      if (total > MAX_FILES) return reply({ error: 'The attachments are too large (10 MB together at most)' }, 413);
      files.push({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
    }

    // Large attachments to follow in parts: named here, taken by the repository only
    let bulk: { size: number; parts: number; holds: string } | null = null;
    if (field('bulk') && !contact) {
      try {
        const b = JSON.parse(field('bulk')) as { size?: unknown; parts?: unknown; holds?: unknown };
        const size = Number(b.size), parts = Number(b.parts);
        if (!(size > 0) || size > MAX_BULK) return reply({ error: `The attachments are too large (${MAX_BULK / 1048576} MB zipped at most)` }, 413);
        if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS || parts !== Math.ceil(size / PART_BYTES)) return reply({ error: 'Not a report' }, 400);
        const holds = Array.isArray(b.holds) ? b.holds.slice(0, 40).map((h) => { const x = h as { name?: unknown; size?: unknown }; return `${oneLine(String(x.name ?? '')).slice(0, 120)} (${mb(Number(x.size) || 0)})`; }).join(', ') : '';
        bulk = { size, parts, holds };
      } catch { return reply({ error: 'Not a report' }, 400); }
    }

    const name = oneLine(field('name')).slice(0, 100), email = validEmail(field('email'));
    if (contact && !email) return reply({ error: 'An email address is needed, to answer you' }, 400);
    if (contact && !mail) return reply({ error: 'Messages aren\'t set up on the server yet' }, 503);
    const topic = oneLine(field('topic')).slice(0, 80);
    const version = oneLine(field('version')).slice(0, 20) || '?';
    const diagnostics = field('diagnostics').slice(0, 40_000);
    const id = crypto.randomUUID();
    const body = [
      `From: ${name || '(no name)'}${email ? ` <${email}>` : field('email') ? ` (address not valid: ${oneLine(field('email')).slice(0, 100)})` : ' (no address)'}`,
      `Konium ${version}`,
      ...(contact ? [`About: ${topic || '(not said)'}`] : []),
      `Attachments: ${files.length ? files.map((f) => `${f.name} (${Math.ceil(f.bytes.length / 1024)} KB)`).join(', ') : 'none'}`,
      ...(bulk ? [`Large attachments, in the reports repository only: ${BULK_NAME} (${mb(bulk.size)}) in ${bulk.parts} part${bulk.parts > 1 ? 's' : ''} (${partName(1)}${bulk.parts > 1 ? ` to ${partName(bulk.parts)}` : ''}; joined in order they are the zip)${bulk.holds ? `, holding ${bulk.holds}` : ''}`] : []),
      '', text, '',
      ...(diagnostics ? ['--- Diagnostics ---', diagnostics] : []),
    ].join('\n');
    const date = new Date(), subject = contact ? `[Konium message] ${topic || 'Message'}: ${text.split('\n')[0]!.slice(0, 60)}` : `[Konium ${version}] ${text.split('\n')[0]!.slice(0, 70)}`;
    // By email and to the reports repository, each on its own: the report is in when either takes it
    const sent = await Promise.allSettled([
      mail ? env.REPORTS.send(new EmailMessage(env.REPORT_FROM, env.REPORT_TO, buildMail({
        from: env.REPORT_FROM, fromName: contact ? 'Konium message' : 'Konium bug report', to: env.REPORT_TO, replyTo: email, subject, text: body, files, id, date,
      }))) : Promise.reject(new Error('email not set up')),
      // Messages to the author stay out of the reports repository
      repo && !contact ? fileReport(env, { id, date, title: subject, body, files }) : Promise.reject(new Error(contact ? 'a message: mailed only' : 'repository not set up')),
    ]);
    const failed = sent.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (contact) {
      if (sent[0]!.status === 'rejected') return reply({ error: `The message couldn't be sent: ${(sent[0].reason as Error)?.message ?? 'unknown error'}` }, 502);
      return reply({ ok: true, id });
    }
    for (const f of failed) console.log(`report ${id}: ${(f.reason as Error)?.message ?? f.reason}`);
    if (failed.length === sent.length) return reply({ error: `The report couldn't be sent: ${((mail ? failed[0] : failed[1])!.reason as Error)?.message ?? 'unknown error'}` }, 502);
    // The pass for its parts, when the repository has the report (the mail alone takes none)
    if (bulk && sent[1]!.status === 'fulfilled') {
      const day = date.toISOString().slice(0, 10);
      return reply({ ok: true, id, upload: { day, parts: bulk.parts, pass: await uploadPass(env, id, day, bulk.parts) } });
    }
    return reply({ ok: true, id });
  },
};

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

/** One part of a report's large attachments: allowed by the report's pass, passed on to the repository as it came. */
async function part(req: Request, env: Env, at: URLSearchParams): Promise<Response> {
  const id = at.get('id') ?? '', day = at.get('d') ?? '', k = Number(at.get('part'));
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isInteger(k)) return reply({ error: 'Not a part of a report' }, 400);
  const parts = await checkPass(env, id, day, at.get('t') ?? '');
  if (parts === null || k < 1 || k > parts) return reply({ error: 'This report takes no (more) parts: send the report again' }, 403);
  // A part in base64 inside its request: a third larger, and a little for the rest
  const most = Math.ceil(PART_BYTES / 3) * 4 + 4096;
  const body = await bodyUpTo(req, most);
  if (!body || !body.byteLength) return reply({ error: 'The part is too large' }, 413);
  const r = await filePart(env, { id, day, part: k, body });
  if (r.status !== 200) console.log(`report ${id} part ${k}: ${r.error}`);
  if (r.status === 400) return reply({ error: 'Not a part of a report' }, 400);
  return r.status === 200 ? reply({ ok: true }) : reply({ error: r.status === 409 ? 'Busy: send the part again' : 'The part couldn\'t be stored: try again shortly' }, r.status);
}
