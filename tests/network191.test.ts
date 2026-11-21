import { describe, expect, it } from 'vitest';
import { CONNECTIONS, mayConnect } from '../src/platform/network';
import { settings } from '../src/core/settings';
import { FEATURES, STAGE } from '../src/core/release';
import { GUIDE_REFERENCE as REFERENCE } from '../src/help/guide/reference';
import { GETTING_STARTED } from '../src/help/guide/gettingStarted';

type Block = { table?: string[][]; p?: string };
const plain = (s: string) => s.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/ \(see [^)]*\)/g, '').replace(/\.$/, '');
const tableOf = (chapter: { sections: { id: string; blocks: unknown[] }[] }, id: string) =>
  (chapter.sections.find((s) => s.id === id)!.blocks as Block[]).find((b) => b.table)!.table!;

describe('where each connection goes (26.191)', () => {
  const guide = tableOf(REFERENCE, 'ref-network');

  it('About and Preferences list every connection the User Guide does, with the same To and What goes', () => {
    // (a planned feature's row is in the program for whoever switches it on; the guide gets it when the feature is released)
    const released = CONNECTIONS.filter((c) => !c.feature || FEATURES[c.feature].stage <= STAGE);
    expect(released.map((c) => c.what)).toEqual(guide.map((r) => r[0]));
    for (const [i, r] of guide.entries()) {
      expect(released[i]!.to).toBe(plain(r[2]!));
      expect(released[i]!.sends).toBe(plain(r[3]!));
    }
    expect(CONNECTIONS.filter((c) => !released.includes(c)).map((c) => c.feature)).toEqual(['partsLibrary']);
  });

  it('To names who the data reaches after konium.app: OpenRouter, Digi-Key, Mouser, GitHub, and Ko-fi for the links', () => {
    const to = (what: RegExp) => CONNECTIONS.find((c) => what.test(c.what))!.to;
    expect(to(/Konium service/)).toMatch(/^konium\.app, then OpenRouter \(openrouter\.ai\), then /);
    expect(to(/your own key/)).toMatch(/not through konium\.app: OpenRouter \(openrouter\.ai\)/);
    expect(to(/local model/)).toMatch(/your computer or your network/);
    expect(to(/Digi-Key and Mouser/)).toMatch(/^konium\.app, then Digi-Key \(api\.digikey\.com\) or Mouser \(api\.mouser\.com\)$/);
    expect(to(/JLCPCB/)).toMatch(/^jlcsearch\.tscircuit\.com: .*not JLCPCB itself$/);
    expect(to(/Bug reports/)).toMatch(/konium\.app, then the author's mailbox.*GitHub \(github\.com\).*Claude, by Anthropic/);
    expect(to(/Datasheets/)).toMatch(/OpenRouter.*konium\.app, then the website the datasheet is on/);
    expect(to(/Links you click/)).toMatch(/ko-fi\.com.*lcsc\.com.*gydel\.games/);
    expect(CONNECTIONS.find((c) => /Donation note/.test(c.what))!.sends).toMatch(/OpenRouter/);
  });

  it('a link is the user\'s click: no switch stops it, and it is the only row that says so', () => {
    const saved = { offline: settings.offline, checkUpdates: settings.checkUpdates };
    try {
      Object.assign(settings, { offline: true, checkUpdates: false });
      for (const c of CONNECTIONS) expect(mayConnect(c.use)).toBe(c.use === 'link');
    } finally { Object.assign(settings, saved); }
    expect(CONNECTIONS.filter((c) => c.use === 'link').map((c) => c.what)).toEqual(['Links you click']);
    expect(guide.at(-1)![4]).toMatch(/Network activity off does not stop these/);
  });

  it('the overview names the same parties', () => {
    const rows = tableOf(GETTING_STARTED, 'gs-privacy');
    const to = (what: RegExp) => rows.find((r) => what.test(r[0]!))![2]!;
    expect(to(/^AI jobs/)).toMatch(/konium\.app, then OpenRouter/);
    expect(to(/Digi-Key and Mouser/)).toBe('konium.app, then Digi-Key or Mouser.');
    expect(to(/Bug reports/)).toMatch(/GitHub/);
    expect(to(/Links you click/)).toMatch(/ko-fi\.com/);
  });
});
