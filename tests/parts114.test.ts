import { afterEach, describe, expect, it } from 'vitest';
import sw from '../public/app/sw.js?raw';
import { handle, type PartsEnv } from '../cloudflare/parts/src/handler';
import { PartsStoreLogic, type Sql } from '../cloudflare/parts/src/store';
import { digikeyParts, mouserParts, parseMoney, supplierIdOf } from '../src/model/suppliers';
import { bomTotals, choiceOf, supplierChoiceBag, type BomLine } from '../src/model/activeBom';
import { partsConfig, resetPartsConfig, searchSupplier } from '../src/platform/supplierSearch';
import { CONNECTIONS } from '../src/platform/network';

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

// Digi-Key Product Information V4's keyword search, in the fields it documents
const DK = {
  ProductsCount: 1, ExactMatches: [],
  Products: [{
    ManufacturerProductNumber: 'RC0603FR-0710KL', Manufacturer: { Id: 1, Name: 'YAGEO' }, Description: { ProductDescription: 'RES 10K OHM 1% 1/10W 0603', DetailedDescription: '10 kOhms ±1% 0.1W' },
    QuantityAvailable: 5_000_000, ProductStatus: { Id: 0, Status: 'Active' }, ProductUrl: 'https://www.digikey.co.uk/en/products/detail/yageo/RC0603FR-0710KL/727212',
    ProductVariations: [
      { DigiKeyProductNumber: '311-10.0KHRCT-ND', PackageType: { Id: 2, Name: 'Cut Tape (CT)' }, StandardPricing: [{ BreakQuantity: 10, UnitPrice: 0.019, TotalPrice: 0.19 }, { BreakQuantity: 1, UnitPrice: 0.08, TotalPrice: 0.08 }], QuantityAvailableforPackageType: 4_000_000, MinimumOrderQuantity: 1 },
      { DigiKeyProductNumber: '311-10.0KHRTR-ND', PackageType: { Id: 1, Name: 'Tape & Reel (TR)' }, StandardPricing: [{ BreakQuantity: 5000, UnitPrice: 0.0021, TotalPrice: 10.5 }], QuantityAvailableforPackageType: 1_000_000, MinimumOrderQuantity: 5000 },
    ],
  }],
};
// Mouser's Search API answer, in the fields it documents
const MOUSER = {
  Errors: [],
  SearchResults: { NumberOfResult: 2, Parts: [
    { MouserPartNumber: '603-RC0603FR-0710KL', ManufacturerPartNumber: 'RC0603FR-0710KL', Manufacturer: 'YAGEO', Description: 'Thick Film Resistors - SMD 10 kOhms 100mW 0603 1%',
      Availability: '1,234,567 In Stock', AvailabilityInStock: '1234567', LifecycleStatus: null, ProductDetailUrl: 'https://www.mouser.co.uk/ProductDetail/603-RC0603FR-0710KL', Min: '1',
      PriceBreaks: [{ Quantity: 1, Price: '£0.08', Currency: 'GBP' }, { Quantity: 100, Price: '£0.009', Currency: 'GBP' }] },
    { MouserPartNumber: 'N/A', ManufacturerPartNumber: 'X', Manufacturer: 'Y', Description: 'not sold', PriceBreaks: [] },
  ] },
};

describe('Digi-Key and Mouser parts in one form (26.114)', () => {
  it('prices as distributors write them', () => {
    expect(parseMoney('£0.085')).toBe(0.085);
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('0,085 €')).toBe(0.085);
    expect(parseMoney('1.234,50 €')).toBe(1234.5);
    expect(parseMoney('1,234')).toBe(1234);
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney(0.5)).toBe(0.5);
  });

  it('a Digi-Key product: one part for each packaging, its own stock, price breaks in order, minimum order', () => {
    const p = digikeyParts(DK, 'GBP');
    expect(p.map((x) => x.spn)).toEqual(['311-10.0KHRCT-ND', '311-10.0KHRTR-ND']);
    expect(p[0]).toMatchObject({ supplier: 'Digi-Key', mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', stock: 4_000_000, currency: 'GBP', lifecycle: 'Active', packaging: 'Cut Tape (CT)', moq: 1 });
    expect(p[0]!.prices).toEqual([{ qty: 1, price: 0.08 }, { qty: 10, price: 0.019 }]);
    expect(p[1]!.moq).toBe(5000);
    // The product details' answer ({ Product }) too, and ProductStatus.Text where Status isn't given
    expect(digikeyParts({ Product: { ...DK.Products[0], ProductStatus: { Id: 2, Text: 'Obsolete' } } }, 'GBP')[0]!.lifecycle).toBe('Obsolete');
  });

  it('a Mouser part: stock, pound prices, no "N/A" parts; Mouser\'s errors said', () => {
    const p = mouserParts(MOUSER);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ supplier: 'Mouser', spn: '603-RC0603FR-0710KL', stock: 1_234_567, currency: 'GBP', lifecycle: '', moq: 1 });
    expect(p[0]!.prices).toEqual([{ qty: 1, price: 0.08 }, { qty: 100, price: 0.009 }]);
    expect(() => mouserParts({ Errors: [{ Code: 'Invalid', Message: 'Invalid unique identifier.' }], SearchResults: null })).toThrow(/Mouser: Invalid unique identifier/);
    expect(mouserParts({ Errors: [], SearchResults: { Parts: [{ MouserPartNumber: 'A', Availability: 'None', AvailabilityInStock: null }] } })[0]!.stock).toBeUndefined();
  });

  it('a supplier\'s name in a choice back to the service\'s id', () => {
    expect(supplierIdOf('Digi-Key')).toBe('digikey');
    expect(supplierIdOf('Digi-Key Electronics')).toBe('digikey');
    expect(supplierIdOf('Mouser')).toBe('mouser');
    expect(supplierIdOf('LCSC')).toBeNull();
  });
});

describe('Konium\'s parts service (cloudflare/parts, 26.114)', () => {
  const env: PartsEnv = { DIGIKEY_CLIENT_ID: 'id', DIGIKEY_CLIENT_SECRET: 'secret', MOUSER_KEY: 'mk', SALT: 's', LOOKUPS_PER_USER: '3', MOUSER_PER_MINUTE: '1' };
  const req = (path: string, body?: object, ip = '1.2.3.4') => new Request(`https://konium.app/api/parts${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip } } : { headers: { 'CF-Connecting-IP': ip } });
  const fake = () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 }));
      if (url.includes('/products/v4/search/keyword')) return new Response(JSON.stringify(DK));
      if (url.includes('/productdetails')) return url.includes('NOPE') ? new Response('', { status: 404 }) : new Response(JSON.stringify({ Product: DK.Products[0] }));
      if (url.includes('api.mouser.com')) return new Response(JSON.stringify(MOUSER));
      return new Response('', { status: 500 });
    }) as typeof fetch;
    return { calls, f };
  };

  it('says which distributors are set up and what is left; one without its secrets isn\'t', async () => {
    const store = new PartsStoreLogic(sqlite());
    const r = await (await handle(req('/config'), { ...env, MOUSER_KEY: '' }, store, fake().f)).json() as { sources: { id: string; ready: boolean }[]; left: number };
    expect(r.sources).toEqual([{ id: 'digikey', name: 'Digi-Key', ready: true }, { id: 'mouser', name: 'Mouser', ready: false }]);
    expect(r.left).toBe(3);
    const no = await handle(req('/search', { source: 'mouser', q: 'RC0603' }), { ...env, MOUSER_KEY: '' }, store, fake().f);
    expect(no.status).toBe(503);
  });

  it('Digi-Key: signs in once, sends the UK locale in pounds, keeps the answer (asked again: not counted, not sent)', async () => {
    const store = new PartsStoreLogic(sqlite());
    const { calls, f } = fake();
    const r1 = await (await handle(req('/search', { source: 'digikey', q: '10k 0603' }), env, store, f, 1_000_000)).json() as { parts: { spn: string }[]; left: number; cached?: boolean };
    expect(r1.parts.map((p) => p.spn)).toContain('311-10.0KHRCT-ND');
    expect(r1.left).toBe(2);
    const search = calls.find((c) => c.url.endsWith('/products/v4/search/keyword'))!;
    const h = search.init!.headers as Record<string, string>;
    expect(h['X-DIGIKEY-Client-Id']).toBe('id');
    expect(h['X-DIGIKEY-Locale-Site']).toBe('UK');
    expect(h['X-DIGIKEY-Locale-Currency']).toBe('GBP');
    expect(h.Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(search.init!.body))).toEqual({ Keywords: '10k 0603', Limit: 20, Offset: 0 });
    const n = calls.length;
    const r2 = await (await handle(req('/search', { source: 'digikey', q: '10K  0603' }), env, store, f, 1_000_000 + 3_600_000)).json() as { cached?: boolean; left: number };
    expect(r2.cached).toBe(true);
    expect(r2.left).toBe(2);
    expect(calls.length).toBe(n);
    // A day later it is asked again; the token, still good for an hour's searches, only when it lasts
    await handle(req('/search', { source: 'digikey', q: '10k 0603' }), env, store, f, 1_000_000 + 25 * 3_600_000);
    expect(calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(2);
  });

  it('a Digi-Key number asked for exactly: its packaging only; one that isn\'t there: none', async () => {
    const store = new PartsStoreLogic(sqlite());
    const { f } = fake();
    const r = await (await handle(req('/search', { source: 'digikey', q: '311-10.0KHRTR-ND', exact: true }), env, store, f)).json() as { parts: { spn: string }[] };
    expect(r.parts.map((p) => p.spn)).toEqual(['311-10.0KHRTR-ND']);
    const none = await (await handle(req('/search', { source: 'digikey', q: 'NOPE-ND', exact: true }), env, store, f)).json() as { parts: unknown[] };
    expect(none.parts).toEqual([]);
  });

  it('Mouser: the key in the address, its per-minute limit, each user\'s day, a search\'s form', async () => {
    const store = new PartsStoreLogic(sqlite());
    const { calls, f } = fake();
    const ok = await handle(req('/search', { source: 'mouser', q: 'RC0603FR-0710KL' }), env, store, f, 5_000_000);
    expect(ok.status).toBe(200);
    expect(calls[0]!.url).toBe('https://api.mouser.com/api/v1/search/keyword?apiKey=mk');
    expect(JSON.parse(String(calls[0]!.init!.body)).SearchByKeywordRequest).toMatchObject({ keyword: 'RC0603FR-0710KL', records: 20 });
    // A second, different search the same minute: over Mouser's minute here (1)
    const busy = await handle(req('/search', { source: 'mouser', q: 'other' }), env, store, f, 5_000_000);
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as { error: string }).error).toMatch(/try again in a minute/);
    // The user's three new searches a day (the busy one counted too), then no more until tomorrow
    await handle(req('/search', { source: 'digikey', q: 'a' }), env, store, f, 5_000_000);
    const over = await handle(req('/search', { source: 'digikey', q: 'b' }), env, store, f, 5_000_000);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/today's 3 new searches/);
    // Another user is unaffected
    expect((await handle(req('/search', { source: 'digikey', q: 'b' }, '5.6.7.8'), env, store, f, 5_000_000)).status).toBe(200);
    // Only searches: not a script, not a long text
    expect((await handle(req('/search', { source: 'digikey', q: '<script>' }, '9.9.9.9'), env, store, f)).status).toBe(400);
    expect((await handle(req('/search', { source: 'digikey', q: 'x'.repeat(81) }, '9.9.9.9'), env, store, f)).status).toBe(400);
  });
});

describe('the BOM with Digi-Key and Mouser parts (26.114)', () => {
  afterEach(() => resetPartsConfig());

  it('a found part as a choice: supplier, its number, pounds, lifecycle', () => {
    const c = choiceOf(supplierChoiceBag(digikeyParts(DK, 'GBP')[0]!));
    expect(c).toMatchObject({ supplier: 'Digi-Key', spn: '311-10.0KHRCT-ND', mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', currency: 'GBP', lifecycle: 'Active', stock: 4_000_000 });
    expect(c.prices[0]).toEqual({ qty: 1, price: 0.08 });
  });

  it('totals in pounds and dollars are added up each on its own, never together', () => {
    const line = (cur: string, price: number) => ({ quantity: 1, parts: [{}], designators: ['X'], item: { choices: [supplierChoiceBag({ supplier: 'S', spn: 'a', mpn: 'b', manufacturer: '', description: '', prices: [{ qty: 1, price }], currency: cur, lifecycle: '', url: '', packaging: '' })] } }) as unknown as BomLine;
    const t = bomTotals([line('GBP', 1), line('USD', 2), line('GBP', 3)], 10);
    expect(t.mixed).toBe(true);
    expect(t.byCurrency).toEqual([{ currency: 'GBP', run: 40, perBoard: 4, lines: 2 }, { currency: 'USD', run: 20, perBoard: 2, lines: 1 }]);
    expect(t.priced).toBe(3);
  });

  it('the app asks konium.app\'s parts service; its refusal is shown as it says it', async () => {
    let asked = '', sent = '';
    const f = (async (url: string, init?: RequestInit) => { asked = url; sent = String(init?.body ?? ''); return new Response(JSON.stringify({ error: 'Konium\'s Mouser searches for today are used up: try again tomorrow (UTC)' }), { status: 429 }); }) as typeof fetch;
    await expect(searchSupplier('mouser', ' RC0603 ', false, f)).rejects.toThrow(/used up/);
    expect(asked).toBe('https://konium.app/api/parts/search');
    expect(JSON.parse(sent)).toEqual({ source: 'mouser', q: 'RC0603', exact: false });
    const gone = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await partsConfig(gone)).toBeNull();
  });

  it('Network Activity names the service and what goes; the service worker never keeps /api/ answers', () => {
    const c = CONNECTIONS.find((x) => /Digi-Key and Mouser/.test(x.what))!;
    expect(c.to).toMatch(/konium\.app/);
    expect(c.use).toBe('parts');
    expect(sw).toMatch(/pathname\.startsWith\('\/api\/'\)\) return;/);
  });
});
