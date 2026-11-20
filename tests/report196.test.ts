/**
 * 26.196: large attachments on a bug report. Over 8 MB together the app zips them; the report is
 * filed without them and its answer carries a pass; the parts follow one by one and are committed
 * beside the report (attachments.zip.001 …). The Worker passes a part on unread.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULK_NAME, MAX_BULK as W_MAX_BULK, MAX_PARTS, PART_BYTES as W_PART, SENDERS, checkPass, fenced, filePart, fileReport, oneLineMd, partIsOurs, partName, uploadPass } from '../cloudflare/report/src/github';
import { MAX_ATTACH, MAX_BULK, MAX_PLAIN, PART_BYTES, packFiles, partBody, partsOf, reportForm, sendReport, type Report } from '../src/platform/report';
import { unzipSync } from '../src/formats/inflate';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(readonly from: string, readonly to: string, readonly raw: string) {} } }));

afterEach(() => { vi.unstubAllGlobals(); });

const ENV = { GITHUB_TOKEN: 'secret-token', REPORTS_REPO: 'o/r' };
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e', DAY = '2026-11-19';
/** Bytes that don't compress (so the zip is as large as they are). */
function noise(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let s = 0x9e3779b9;
  for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[i] = s & 255; }
  return b;
}
const report = (over: Partial<Report> = {}): Report => ({ name: '', email: '', text: 'The saved board opens empty', version: '26.196', diagnostics: '', files: [], ...over });

describe('the report service and the app agree on large attachments (26.196)', () => {
  it('the same sizes on both sides; the plain way stays under the service\'s 10 MB', () => {
    expect([MAX_BULK, PART_BYTES]).toEqual([W_MAX_BULK, W_PART]);
    expect(MAX_BULK).toBe(40 * 1024 * 1024);
    expect(MAX_PLAIN).toBe(8 * 1024 * 1024);
    expect(MAX_PLAIN).toBeLessThan(10 * 1024 * 1024);
    expect(MAX_ATTACH).toBeGreaterThan(MAX_BULK);
    expect(MAX_PARTS).toBe(7);
    expect(partsOf(MAX_BULK)).toBe(MAX_PARTS);
    expect([partsOf(1), partsOf(PART_BYTES), partsOf(PART_BYTES + 1)]).toEqual([1, 1, 2]);
    expect([BULK_NAME, partName(1), partName(12)]).toEqual(['attachments.zip', 'attachments.zip.001', 'attachments.zip.012']);
  });
});

describe('the pass for a report\'s parts (26.196)', () => {
  it('good for that report, that day and that many parts, for half an hour', async () => {
    const now = Date.UTC(2026, 10, 19, 14, 0, 0);
    const pass = await uploadPass(ENV, ID, DAY, 4, now);
    expect(pass).toMatch(/^\d+\.4\.[0-9a-f]{64}$/);
    expect(await checkPass(ENV, ID, DAY, pass, now + 60_000)).toBe(4);
    expect(await checkPass(ENV, ID, DAY, pass, now + 29 * 60_000)).toBe(4);
    expect(await checkPass(ENV, ID, DAY, pass, now + 31 * 60_000)).toBeNull();
    // Another report, another day, more parts than given, another secret: refused
    expect(await checkPass(ENV, ID.replace('0f', '1f'), DAY, pass, now)).toBeNull();
    expect(await checkPass(ENV, ID, '2026-11-20', pass, now)).toBeNull();
    expect(await checkPass(ENV, ID, DAY, pass.replace('.4.', '.7.'), now)).toBeNull();
    expect(await checkPass({ ...ENV, GITHUB_TOKEN: 'other' }, ID, DAY, pass, now)).toBeNull();
    expect(await checkPass({ REPORTS_REPO: 'o/r' }, ID, DAY, pass, now)).toBeNull();
    for (const bad of ['', 'x', '1.2.3', `${now + 1000}.99.${'a'.repeat(64)}`]) expect(await checkPass(ENV, ID, DAY, bad, now)).toBeNull();
  });
});

describe('a part committed beside its report (26.196)', () => {
  it('goes to the report\'s folder under the part\'s number, its request passed on as it came', async () => {
    const calls: { url: string; method: string; body: unknown; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, method: init.method!, body: init.body, auth: String((init.headers as Record<string, string>).Authorization) }); return new Response('{}', { status: 201 }); });
    const body = new TextEncoder().encode(partBody(ID, 2, new Uint8Array([1, 2, 3])));
    expect(await filePart(ENV, { id: ID, day: DAY, part: 2, body })).toEqual({ status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.github.com/repos/o/r/contents/reports/${DAY}/${ID}/attachments.zip.002`);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toBe(body);
    expect(calls[0]!.auth).toBe('Bearer secret-token');
  });
  it('only the app\'s own request for that part is passed on (26.200): the sender chooses the part\'s bytes and nothing besides', async () => {
    let asked = 0;
    vi.stubGlobal('fetch', async () => { asked++; return new Response('{}', { status: 201 }); });
    const enc = (s: string) => new TextEncoder().encode(s);
    const good = partBody(ID, 3, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(partIsOurs(ID, 3, enc(good))).toBe(true);
    const b64 = (JSON.parse(good) as { content: string }).content;
    const head = `{"message":"Report ${ID}: attachments.zip.003","content":"`;
    for (const [why, bad] of [
      ['another part\'s number', good],
      ['another report', good.replace(ID, ID.replace(/^./, (c) => (c === '0' ? '1' : '0')))],
      ['a commit message of the sender\'s', `{"message":"fixes #12","content":"${b64}"}`],
      ['a branch added', `${head}${b64}","branch":"main"}`],
      ['a file to replace named', `${head}${b64}","sha":"${'a'.repeat(40)}"}`],
      ['an author added', `${head}${b64}","committer":{"name":"x","email":"x@example.org"}}`],
      ['a quote escaped to carry on', `${head}${b64}\\","sha":"x"}`],
      ['the fields the other way round', `{"content":"${b64}","message":"Report ${ID}: attachments.zip.003"}`],
      ['space before the end', `${head}${b64}" }`],
      ['nothing at all', ''],
      ['the head alone', head],
    ] as const) {
      const part = why === 'another part\'s number' ? 4 : 3;
      expect(partIsOurs(ID, part, enc(bad)), why).toBe(false);
      expect((await filePart(ENV, { id: ID, day: DAY, part, body: enc(bad) })).status, why).toBe(400);
    }
    expect(asked).toBe(0);
    // An empty part's content and a large one are both the app's own
    expect(partIsOurs(ID, 3, enc(`${head}"}`))).toBe(true);
    expect(partIsOurs(ID, 1, enc(partBody(ID, 1, new Uint8Array(300_000).fill(255))))).toBe(true);
  });
  it('there already: as good as written; a commit come between: sent again; anything else: said', async () => {
    const PART1 = new TextEncoder().encode(partBody(ID, 1, new Uint8Array([1])));
    vi.stubGlobal('fetch', async () => new Response('{"message":"Invalid request.\\n\\n\\"sha\\" wasn\'t supplied."}', { status: 422 }));
    expect((await filePart(ENV, { id: ID, day: DAY, part: 1, body: PART1 })).status).toBe(200);
    vi.stubGlobal('fetch', async () => new Response('{"message":"is at 1 but expected 2"}', { status: 409 }));
    expect((await filePart(ENV, { id: ID, day: DAY, part: 1, body: PART1 })).status).toBe(409);
    vi.stubGlobal('fetch', async () => new Response('Bad credentials', { status: 401 }));
    expect(await filePart(ENV, { id: ID, day: DAY, part: 1, body: PART1 })).toEqual({ status: 502, error: 'GitHub 401 Bad credentials' });
    expect((await filePart({}, { id: ID, day: DAY, part: 1, body: PART1 })).status).toBe(503);
  });
});

describe('a report\'s text stays text where it is shown (26.200)', () => {
  it('a block\'s fence is longer than any run of back-ticks in the text; a name\'s marks are escaped', () => {
    expect(fenced('plain')).toBe('```\nplain\n```');
    const sly = 'see\n```\n# Folder: [here](https://evil.example)\n@someone fixes #3\n````\nmore';
    const f = fenced(sly);
    expect(f.startsWith('`````\n')).toBe(true);
    expect(f.endsWith('\n`````')).toBe(true);
    // No line of the text is a fence as long as the block's own
    expect(f.split('\n').slice(1, -1).some((l) => /^`{5,}\s*$/.test(l))).toBe(false);
    expect(oneLineMd('a](https://evil.example) @x #3 `c`\n# h')).toBe('a\\]\\(https://evil.example\\) \\@x \\#3 \\`c\\` \\# h');
  });
  it('the report\'s file and its issue: the text fenced and marked as the sender\'s, the attachments\' names escaped', async () => {
    const calls: { url: string; body: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, string> }); return new Response(JSON.stringify({ number: 5, html_url: 'u' }), { status: 201 }); });
    const text = 'It crashed.\n```\n\nAttachments:\n- [all fine](https://evil.example)\n\n@maintainer please run this';
    await fileReport(ENV, { id: ID, date: new Date(`${DAY}T10:00:00Z`), title: '[Konium 26.200] It crashed. @x', body: text, files: [{ name: 'a](https://evil.example).txt', type: 'text/plain', bytes: new Uint8Array([1]) }] });
    const md = atob(calls[0]!.body.content!);
    expect(md).toBe(`# \\[Konium 26.200\\] It crashed. \\@x\n\n${SENDERS}\n\n\`\`\`\`\n${text}\n\`\`\`\`\n`);
    const issue = calls.at(-1)!.body.body!;
    expect(issue).toContain(`\n\n${SENDERS}\n\n\`\`\`\`\n${text}\n\`\`\`\``);
    expect(issue).toContain('- [a\\]\\(https\\_evil.example\\).txt](https://github.com/o/r/blob/HEAD/');
    // Outside the block the issue holds the service's own lines and nothing of the sender's but the escaped name
    expect(issue.slice(0, issue.indexOf(SENDERS))).not.toContain('evil.example)');
  });
});

describe('the report Worker with large attachments (26.196)', () => {
  it('files the report without them, names the zip in it, gives a pass; then takes each part, and no more than that', async () => {
    const { default: worker } = await import('../cloudflare/report/src/index');
    const gh: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { gh.push({ url, method: init.method!, body: init.body }); return new Response(JSON.stringify({ number: 3, html_url: 'https://github.com/o/r/issues/3' }), { status: 201 }); });
    const env = { ...ENV, REPORT_TO: '', REPORT_FROM: '', REPORTS: { send: async () => {} } };
    const zipSize = 2 * W_PART + 100;
    const form = reportForm(report({ bulk: { bytes: new Uint8Array(zipSize), holds: [{ name: 'Board.brd', size: 47_000_000 }, { name: 'Board.PcbDoc', size: 61_500_000 }] } }));
    const res = await worker.fetch(new Request('https://konium.app/api/report', { method: 'POST', body: form }), env as never);
    const answer = await res.json() as { ok: boolean; id: string; upload: { day: string; parts: number; pass: string } };
    expect(res.status).toBe(200);
    expect(answer.ok).toBe(true);
    expect(answer.upload.parts).toBe(3);
    expect(answer.upload.day).toMatch(/^\d{4}-\d\d-\d\d$/);
    // The report's text names the zip, its parts and what it holds (report.md, then the issue)
    const md = atob((JSON.parse(String(gh[0]!.body)) as { content: string }).content);
    expect(md).toContain('Attachments: none');
    expect(md).toContain('Large attachments, in the reports repository only: attachments.zip (12.0 MB) in 3 parts (attachments.zip.001 to attachments.zip.003; joined in order they are the zip), holding Board.brd (44.8 MB), Board.PcbDoc (58.7 MB)');
    gh.length = 0;
    // Each part: to the report's folder, as it came
    const at = (k: number, pass = answer.upload.pass, id = answer.id) => `https://konium.app/api/report?part=${k}&id=${id}&d=${answer.upload.day}&t=${pass}`;
    const body = partBody(answer.id, 1, new Uint8Array([9, 8, 7]));
    const ok = await worker.fetch(new Request(at(1), { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }), env as never);
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);
    expect(gh).toHaveLength(1);
    expect(gh[0]!.url).toBe(`https://api.github.com/repos/o/r/contents/reports/${answer.upload.day}/${answer.id}/attachments.zip.001`);
    expect(new TextDecoder().decode(gh[0]!.body as Uint8Array)).toBe(body);
    // The same part, but saying which file to replace (so as to be written again and again): not the app's request, refused
    const again = await worker.fetch(new Request(at(1), { method: 'POST', body: body.replace(/"}$/, `","sha":"${'b'.repeat(40)}"}`), headers: { 'Content-Type': 'application/json' } }), env as never);
    expect([again.status, await again.json()]).toEqual([400, { error: 'Not a part of a report' }]);
    expect(gh).toHaveLength(1);
    // Parts are counted by the minute from one address
    const held = await worker.fetch(new Request(at(1), { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }), { ...env, PART_LIMITER: { limit: async () => ({ success: false }) } } as never);
    expect(held.status).toBe(429);
    expect(gh).toHaveLength(1);
    // A part beyond those announced, a pass that isn't this report's, no pass: refused, nothing goes to the repository
    gh.length = 0;
    for (const url of [at(4), at(0), at(1, answer.upload.pass.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), at(1, answer.upload.pass, ID), at(1, '')]) {
      const r = await worker.fetch(new Request(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }), env as never);
      expect(r.status, url).toBe(403);
    }
    expect((await worker.fetch(new Request('https://konium.app/api/report?part=1&id=nonsense&d=x&t=y', { method: 'POST', body }), env as never)).status).toBe(400);
    // A part larger than a part may be
    const big = await worker.fetch(new Request(at(2), { method: 'POST', body: new Uint8Array(Math.ceil(W_PART / 3) * 4 + 5000) }), env as never);
    expect(big.status).toBe(413);
    // …and one that says it is short and is not: read no further than a part may be long
    const lying = new Request(at(2), { method: 'POST', body: new Uint8Array(Math.ceil(W_PART / 3) * 4 + 5000), headers: { 'Content-Length': '10' } });
    expect((await worker.fetch(lying, env as never)).status).toBe(413);
    expect(gh).toHaveLength(0);
  });

  it('a zip over the limit, or parts that don\'t fit its size, is refused; a message to the author takes none', async () => {
    const { default: worker } = await import('../cloudflare/report/src/index');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 201 }));
    const env = { ...ENV, REPORT_TO: '', REPORT_FROM: '', REPORTS: { send: async () => {} } };
    const send = async (bulk: object) => { const f = reportForm(report()); f.set('bulk', JSON.stringify(bulk)); return worker.fetch(new Request('https://konium.app/api/report', { method: 'POST', body: f }), env as never); };
    const over = await send({ size: W_MAX_BULK + 1, parts: 7, holds: [] });
    expect([over.status, (await over.json() as { error: string }).error]).toEqual([413, 'The attachments are too large (40 MB zipped at most)']);
    expect((await send({ size: 3 * W_PART, parts: 2, holds: [] })).status).toBe(400);
    expect((await send({ size: 100, parts: 1, holds: [] })).status).toBe(200);
  });
});

describe('the app sends large attachments zipped, in parts (26.196)', () => {
  it('the attachments zipped: the zip holds them under their names, two of one name told apart', async () => {
    const a = new TextEncoder().encode('board '.repeat(5000)), b = noise(3000);
    const bulk = await packFiles([{ name: 'Board.PcbDoc', type: '', bytes: a }, { name: 'shot.png', type: 'image/png', bytes: b }, { name: 'shot.png', type: 'image/png', bytes: b }]);
    expect(bulk.holds).toEqual([{ name: 'Board.PcbDoc', size: a.length }, { name: 'shot.png', size: 3000 }, { name: 'shot-2.png', size: 3000 }]);
    expect(bulk.bytes.length).toBeLessThan(a.length / 4 + 2 * 3000 + 600);
    // A zip, its first entry deflated; unzipped it gives back what went in
    const dv = new DataView(bulk.bytes.buffer, bulk.bytes.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(8, true)).toBe(8);
    const back = unzipSync(bulk.bytes);
    expect(back.map((f) => f.name)).toEqual(['Board.PcbDoc', 'shot.png', 'shot-2.png']);
    expect(back[0]!.bytes).toEqual(a);
    expect(back[2]!.bytes).toEqual(b);
  });

  it('the report first, then each part with the pass; the parts joined are the zip', async () => {
    const zip = noise(PART_BYTES * 2 + 1234);
    const calls: { url: string; type: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, type: (init.headers as Record<string, string> | undefined)?.['Content-Type'] ?? '', body: init.body });
      return new Response(JSON.stringify(calls.length === 1 ? { ok: true, id: ID, upload: { day: DAY, parts: 3, pass: 'p.3.x' } } : { ok: true }), { status: 200 });
    });
    const steps: string[] = [];
    const res = await sendReport(report({ bulk: { bytes: zip, holds: [{ name: 'Board.brd', size: 47_000_000 }] } }), 'https://konium.app/api/report', (s) => steps.push(s), async () => {});
    expect(res).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(['https://konium.app/api/report', ...[1, 2, 3].map((k) => `https://konium.app/api/report?part=${k}&id=${ID}&d=${DAY}&t=p.3.x`)]);
    const form = calls[0]!.body as FormData;
    expect(JSON.parse(String(form.get('bulk')))).toEqual({ size: zip.length, parts: 3, holds: [{ name: 'Board.brd', size: 47_000_000 }] });
    expect(form.getAll('file')).toEqual([]);
    expect(calls.slice(1).every((c) => c.type === 'application/json')).toBe(true);
    const parts = calls.slice(1).map((c) => JSON.parse(String(c.body)) as { message: string; content: string });
    expect(parts.map((p) => p.message)).toEqual([1, 2, 3].map((k) => `Report ${ID}: attachments.zip.00${k}`));
    const joined = parts.flatMap((p) => [...atob(p.content)].map((ch) => ch.charCodeAt(0)));
    expect(joined.length).toBe(zip.length);
    expect(joined.every((v, i) => v === zip[i])).toBe(true);
    expect(steps).toEqual([1, 2, 3].map((k) => `Sending the attachments: part ${k} of 3`));
  }, 20_000);

  it('a part answered "busy" is sent again; a part that can\'t go: the report has gone, and that is said', async () => {
    const zip = noise(1000);
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return n === 1 ? new Response(JSON.stringify({ ok: true, id: ID, upload: { day: DAY, parts: 1, pass: 'p' } })) : n === 2 ? new Response(JSON.stringify({ error: 'Busy: send the part again' }), { status: 409 }) : new Response(JSON.stringify({ ok: true })); });
    expect(await sendReport(report({ bulk: { bytes: zip, holds: [] } }), 'https://x/api/report', undefined, async () => {})).toEqual({ ok: true });
    expect(n).toBe(3);
    // Refused for good (the pass is over): not tried again
    n = 0;
    vi.stubGlobal('fetch', async () => { n++; return n === 1 ? new Response(JSON.stringify({ ok: true, id: ID, upload: { day: DAY, parts: 1, pass: 'p' } })) : new Response(JSON.stringify({ error: 'This report takes no (more) parts: send the report again' }), { status: 403 }); });
    expect(await sendReport(report({ bulk: { bytes: zip, holds: [] } }), 'https://x/api/report', undefined, async () => {})).toEqual({ ok: true, note: 'the report was sent, but its attachments were not (part 1 of 1: This report takes no (more) parts: send the report again)' });
    expect(n).toBe(2);
    // A report service that gives no pass (not deployed yet, or with no repository): the report has gone without them
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, id: ID })));
    expect(await sendReport(report({ bulk: { bytes: zip, holds: [] } }), 'https://x/api/report')).toEqual({ ok: true, note: 'the report was sent, but the report service takes no large attachments at the moment: they were left out' });
    // A report with nothing large goes as it always did, in one request
    n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response(JSON.stringify({ ok: true, id: ID })); });
    expect(await sendReport(report({ files: [{ name: 'a.png', type: 'image/png', bytes: new Uint8Array(10) }] }), 'https://x/api/report')).toEqual({ ok: true });
    expect(n).toBe(1);
  });
});
