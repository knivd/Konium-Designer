/**
 * 26.207: the parts library made ready to be set up. The sign-in mail goes by Cloudflare's own
 * Email Service (the Worker's binding), from the library's address shown by its name; the
 * settings name the binding and its one sender; the installer has a step for the library that is
 * run only when asked for and never replaces the library's secret. And one name for one person:
 * the program says "the author" wherever it used to say "the developer".
 */
import { describe, expect, it } from 'vitest';
import { handle, type LibraryEnv, type Mailer } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { ENV, T0, sqlite, world } from './helpers/libraryWorld';
import { CONNECTIONS } from '../src/platform/network';
import toml from '../cloudflare/library/wrangler.toml?raw';
import installer from '../install-konium.ps1?raw';

const SOURCES = import.meta.glob(['../src/**/*.{ts,tsx}', '../cloudflare/**/*.{ts,md}', '../website/*.mjs'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const post = (path: string, body: unknown) => new Request(`https://konium.app/api/library${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' } });

describe('the parts library\'s sign-in mail by Cloudflare\'s Email Service (26.207)', () => {
  it('goes through the Worker\'s binding, from the library\'s address shown by its name', async () => {
    const sent: Parameters<Mailer['send']>[0][] = [];
    const EMAIL: Mailer = { send: async (m) => { sent.push(m); return { messageId: 'm1' }; } };
    const { RESEND_KEY: _none, ...bare } = ENV;
    const env: LibraryEnv = { ...bare, EMAIL, MAIL_FROM: 'library@konium.app', MAIL_NAME: 'Konium parts library' };
    const w = world(), store = new LibraryStoreLogic(sqlite());
    // (the binding alone is a way to mail: the library says it can sign people in)
    const config = await (await handle(new Request('https://konium.app/api/library/config'), env, store, w.fetchFn, T0)).json() as { ready: boolean; signIn: boolean };
    expect(config).toMatchObject({ ready: true, signIn: true });
    const res = await handle(post('/signin', { email: 'ada@example.org' }), env, store, w.fetchFn, T0);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ada@example.org', from: { email: 'library@konium.app', name: 'Konium parts library' }, subject: 'Your sign-in link for the Konium parts library' });
    expect(sent[0]!.text).toMatch(/https:\/\/konium\.app\/api\/library\/confirm\?id=[0-9a-f]{32}&code=[0-9a-f]{40}/);
    expect(sent[0]!.html).toContain('https://konium.app/api/library/confirm?id=');
    // (nothing went by the other route)
    expect(w.mails).toEqual([]);
    // (a sending that fails is said, and no ticket is left to wait on)
    const failing: LibraryEnv = { ...env, EMAIL: { send: async () => { throw Object.assign(new Error('not ready'), { code: 'E_EMAIL_SENDING_NOT_READY' }); } } };
    expect((await handle(post('/signin', { email: 'bob@example.org' }), failing, new LibraryStoreLogic(sqlite()), w.fetchFn, T0)).status).toBeGreaterThanOrEqual(500);
  });

  it('is set in the service\'s settings: the binding, its one sender, the repository', () => {
    expect(toml).toMatch(/^\[\[send_email\]\]\nname = "EMAIL"\nallowed_sender_addresses = \["library@konium\.app"\]$/m);
    expect(/^MAIL_FROM = "([^"]+)"$/m.exec(toml)![1]).toBe('library@konium.app');
    // (the repository: an owner and a name, or left empty where the tree is published before the library opens)
    expect(toml).toMatch(/^LIBRARY_REPO = "(|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)"$/m);
    // (and the list of connections says who mails the link)
    const row = CONNECTIONS.find((c) => c.use === 'library')!;
    expect(row.to).toContain('The sign-in link is mailed to you by Cloudflare\'s mail service');
    expect(row.to).not.toMatch(/mail provider/);
  });

  it('has a step of its own in the installer: asked for by name, the secret made once and never again', () => {
    expect(/\[string\[\]\]\$Steps = @\(([^)]*)\)/.exec(installer)![1]).toBe("'site', 'ai', 'parts', 'report', 'vcs', 'check'");
    expect(/\$AllSteps = @\(([^)]*)\)/.exec(installer)![1]).toBe("'site', 'ai', 'parts', 'report', 'vcs', 'library', 'check'");
    expect(installer).toContain("'library' { StepLibrary }");
    const step = installer.slice(installer.indexOf('function StepLibrary'), installer.indexOf('# ---- Checks, from outside'));
    expect(step.indexOf("-contains 'LIBRARY_SECRET'")).toBeGreaterThan(0);
    expect(step.indexOf("-contains 'LIBRARY_SECRET'")).toBeLessThan(step.indexOf("'secret', 'put', 'LIBRARY_SECRET'"));
    expect(step).toContain("PutKey 'library' 'GITHUB_TOKEN'");
    expect(step).toMatch(/Fetch "https:\/\/\$Domain\/api\/library\/config"/);
    // (nothing secret is written into the script)
    expect(installer).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]{10}/);
  });
});

describe('one name for one person (26.207)', () => {
  it('the program, its services and the website say "the author", never "the developer"', () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      src.split('\n').forEach((line, i) => {
        // (other people's menus and sites keep their own names)
        const own = line.replace(/Developer settings|Developer ›|developer\.digikey\.com|developers\b/g, '');
        if (/\bdeveloper('s)?\b/i.test(own)) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
    expect(SOURCES['../src/app/Home.tsx']).toContain('Tell Konium Designer\'s author what went wrong');
    expect(SOURCES['../src/app/dialogs/ReportBug.tsx']).toContain('to the author and to the AI assistant that helps build Konium Designer (Claude)');
  });
});
