import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileReport, safeName } from '../cloudflare/report/src/github';

afterEach(() => { vi.unstubAllGlobals(); });

describe('reports filed in the reports repository', () => {
  it('nothing is filed without a token and a repository', async () => {
    expect(await fileReport({}, { id: 'x', date: new Date(), title: 't', body: 'b', files: [] })).toBeNull();
    expect(await fileReport({ GITHUB_TOKEN: 't', REPORTS_REPO: 'not a repo' }, { id: 'x', date: new Date(), title: 't', body: 'b', files: [] })).toBeNull();
  });
  it('commits the text and each attachment under reports/<date>/<id>/, then opens an issue', async () => {
    const calls: { method: string; url: string; body: Record<string, string>; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
      return new Response(JSON.stringify(init.method === 'POST' ? { number: 7, html_url: 'https://github.com/o/r/issues/7' } : {}), { status: 201 });
    });
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const filed = await fileReport({ GITHUB_TOKEN: 'secret', REPORTS_REPO: 'o/r' }, {
      id: 'abc', date: new Date('2026-10-30T09:00:00Z'), title: '[Konium 26.071] DRC', body: 'It broke',
      files: [{ name: 'Board 1.PcbDoc', type: '', bytes }, { name: 'report.md', type: '', bytes }, { name: '../x?.png', type: '', bytes }],
    });
    expect(filed).toEqual({ issue: 7, url: 'https://github.com/o/r/issues/7', folder: 'reports/2026-10-30/abc' });
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PUT', 'PUT', 'POST']);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r/contents/reports/2026-10-30/abc/report.md');
    expect(calls[1]!.url).toBe('https://api.github.com/repos/o/r/contents/reports/2026-10-30/abc/Board%201.PcbDoc');
    expect(calls[2]!.url.endsWith('/_report.md')).toBe(true);
    expect(calls[3]!.url.endsWith('/__x_.png')).toBe(true);
    expect([...atob(calls[1]!.body.content!)].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
    expect(atob(calls[0]!.body.content!)).toContain('It broke');
    expect(calls.every((c) => c.auth === 'Bearer secret')).toBe(true);
    expect(calls[4]!.url).toBe('https://api.github.com/repos/o/r/issues');
    expect(calls[4]!.body.body).toContain('https://github.com/o/r/blob/HEAD/reports/2026-10-30/abc/Board%201.PcbDoc');
  });
  it('a failed call fails the filing (the email still goes)', async () => {
    vi.stubGlobal('fetch', async () => new Response('Bad credentials', { status: 401 }));
    await expect(fileReport({ GITHUB_TOKEN: 'x', REPORTS_REPO: 'o/r' }, { id: 'a', date: new Date(), title: 't', body: 'b', files: [] })).rejects.toThrow(/401/);
  });
  it('safe, distinct names', () => {
    const taken = new Set<string>(['report.md']);
    expect([safeName('a.png', taken), safeName('A.png', taken), safeName('', taken)]).toEqual(['a.png', 'A-2.png', 'file']);
  });
});
