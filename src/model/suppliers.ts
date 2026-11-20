/**
 * Distributors' parts (Digi-Key, Mouser) in one form, for a BOM document's part choices: what
 * Konium's parts service (cloudflare/parts) answers with, made from each distributor's own answer.
 * Pure: the service and the tests use it alike. Field names as the distributors' APIs give them
 * (Digi-Key Product Information V4; Mouser Search API).
 */
import type { PriceBreak } from './activeBom';

export type SupplierId = 'digikey' | 'mouser';
export const SUPPLIER_NAMES: Record<SupplierId, string> = { digikey: 'Digi-Key', mouser: 'Mouser' };
/** A choice's supplier name back to the service's id (as Altium and Konium write it, and the usual spellings). */
export function supplierIdOf(name: string): SupplierId | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return n === 'digikey' || n === 'digikeyelectronics' ? 'digikey' : n === 'mouser' || n === 'mouserelectronics' ? 'mouser' : null;
}

export interface SupplierPart {
  supplier: string;
  /** The distributor's own part number. */
  spn: string;
  mpn: string;
  manufacturer: string;
  description: string;
  /** Units in stock; undefined when the distributor doesn't say. */
  stock?: number;
  prices: PriceBreak[];
  /** ISO code (GBP, USD, EUR …). */
  currency: string;
  /** Active, Obsolete, Not For New Designs … as the distributor says it; '' when it doesn't. */
  lifecycle: string;
  url: string;
  /** Packaging (Cut Tape, Tape & Reel …), when the distributor sells it in several. */
  packaging: string;
  /** The least that can be ordered. */
  moq?: number;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(v.replace(/\s/g, ''));
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A price as a distributor writes it ("£0.085", "$1,234.50", "0,085 €", "1.234,50 €"): the last
 * separator followed by other than three digits is the decimal point; a lone comma before exactly
 * three digits is a thousands separator unless the number starts "0,".
 */
export function parseMoney(s: string | number | undefined | null): number | undefined {
  if (typeof s === 'number') return Number.isFinite(s) ? s : undefined;
  if (!s) return undefined;
  const t = String(s).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return undefined;
  const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
  let v: string;
  if (dot >= 0 && comma >= 0) v = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) v = /^-?\d{1,3}(,\d{3})+$/.test(t) && !/^-?0,/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
  else v = t;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const breaks = (list: { qty: number; price: number | undefined }[]): PriceBreak[] =>
  list.filter((b): b is PriceBreak => Number.isFinite(b.qty) && b.qty > 0 && b.price !== undefined && b.price > 0).sort((a, b) => a.qty - b.qty);

/* ─── Digi-Key: Product Information V4 ─── */

interface DkVariation { DigiKeyProductNumber?: string; PackageType?: { Name?: string }; StandardPricing?: { BreakQuantity?: number; UnitPrice?: number }[]; QuantityAvailableforPackageType?: number; MinimumOrderQuantity?: number }
interface DkProduct {
  ManufacturerProductNumber?: string; Manufacturer?: { Name?: string }; Description?: { ProductDescription?: string; DetailedDescription?: string };
  QuantityAvailable?: number; ProductStatus?: { Status?: string; Text?: string }; ProductUrl?: string; DigiKeyProductNumber?: string;
  ProductVariations?: DkVariation[]; SearchLocaleUsed?: { Currency?: string };
}

/** A Digi-Key product as parts: one for each packaging it is sold in (each its own Digi-Key number). */
export function digikeyProduct(p: DkProduct, currency: string): SupplierPart[] {
  const base = {
    supplier: SUPPLIER_NAMES.digikey, mpn: p.ManufacturerProductNumber ?? '', manufacturer: p.Manufacturer?.Name ?? '',
    description: p.Description?.ProductDescription || p.Description?.DetailedDescription || '',
    currency: p.SearchLocaleUsed?.Currency || currency, lifecycle: p.ProductStatus?.Status ?? p.ProductStatus?.Text ?? '', url: p.ProductUrl ?? '',
  };
  const vars = (p.ProductVariations ?? []).filter((v) => v.DigiKeyProductNumber);
  if (!vars.length) return p.DigiKeyProductNumber ? [{ ...base, spn: p.DigiKeyProductNumber, stock: num(p.QuantityAvailable), prices: [], packaging: '' }] : [];
  return vars.map((v) => ({
    ...base, spn: v.DigiKeyProductNumber!, packaging: v.PackageType?.Name ?? '',
    stock: num(v.QuantityAvailableforPackageType) ?? num(p.QuantityAvailable),
    prices: breaks((v.StandardPricing ?? []).map((b) => ({ qty: Number(b.BreakQuantity), price: num(b.UnitPrice) }))),
    moq: num(v.MinimumOrderQuantity),
  }));
}

/** Digi-Key's keyword search answer ({ ExactMatches, Products }) as parts, exact matches first, each once. */
export function digikeyParts(body: unknown, currency: string): SupplierPart[] {
  const b = (body ?? {}) as { ExactMatches?: DkProduct[]; Products?: DkProduct[]; Product?: DkProduct };
  const all = [...(b.Product ? [b.Product] : []), ...(b.ExactMatches ?? []), ...(b.Products ?? [])].flatMap((p) => digikeyProduct(p, currency));
  const seen = new Set<string>();
  return all.filter((x) => (seen.has(x.spn) ? false : (seen.add(x.spn), true)));
}

/* ─── Mouser: Search API ─── */

interface MouserPart {
  MouserPartNumber?: string; ManufacturerPartNumber?: string; Manufacturer?: string; Description?: string;
  Availability?: string; AvailabilityInStock?: string | number | null; LifecycleStatus?: string | null; ProductDetailUrl?: string;
  PriceBreaks?: { Quantity?: number | string; Price?: string | number; Currency?: string }[]; Min?: string | number;
}

/** Mouser's search answer ({ Errors, SearchResults: { Parts } }) as parts; its errors thrown. */
export function mouserParts(body: unknown): SupplierPart[] {
  const b = (body ?? {}) as { Errors?: { Message?: string; message?: string }[]; SearchResults?: { Parts?: MouserPart[] } | null };
  const errs = (b.Errors ?? []).map((e) => e.Message ?? e.message ?? '').filter(Boolean);
  if (errs.length && !b.SearchResults?.Parts?.length) throw new Error(`Mouser: ${errs.join('; ')}`);
  return (b.SearchResults?.Parts ?? []).filter((p) => p.MouserPartNumber && !/^N\/?A$/i.test(p.MouserPartNumber)).map((p) => {
    const inStock = p.AvailabilityInStock === null || p.AvailabilityInStock === undefined || p.AvailabilityInStock === '' ? undefined : num(p.AvailabilityInStock);
    const fromText = /in stock/i.test(p.Availability ?? '') ? num(p.Availability) : undefined;
    return {
      supplier: SUPPLIER_NAMES.mouser, spn: p.MouserPartNumber!, mpn: p.ManufacturerPartNumber ?? '', manufacturer: p.Manufacturer ?? '', description: p.Description ?? '',
      stock: inStock ?? fromText,
      prices: breaks((p.PriceBreaks ?? []).map((x) => ({ qty: Number(x.Quantity), price: parseMoney(x.Price) }))),
      currency: p.PriceBreaks?.find((x) => x.Currency)?.Currency ?? '',
      lifecycle: p.LifecycleStatus ?? '', url: p.ProductDetailUrl ?? '', packaging: '', moq: num(p.Min),
    };
  });
}
