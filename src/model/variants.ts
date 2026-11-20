/**
 * Project › Variants: assembly variants kept in the .PrjPcb as [ProjectVariantN] sections, as
 * AD writes them —
 *   UniqueId=<GUID>  Description=Name  AllowFabrication=0  ParameterCount=0  VariationCount=n
 *   VariationK=Designator=R1|UniqueId=\SHEET\PART|Kind=1|AlternatePart=…|AltLibLink_DesignItemID=…|AltLibLink_Footprint=…
 *   ParamVariationJ=ParameterName=Comment|VariantValue=10k   ParamDesignatorJ=R1   (after the part's VariationK)
 *   ParamVariationCount=m
 * Kind: 0 fitted (listed when only its parameters vary), 1 not fitted, 2 alternate part (its
 * library link in the AltLibLink_ fields). UniqueId is the part's path through the sheet symbols;
 * a part is matched by it, else by designator.
 */
import { iniSections, iniRemoveSection, iniSetSection, reparse, type PrjPcb } from '../formats/altium/prjpcb';
import type { CompiledComponent } from './compile';

export type VariationKind = 0 | 1 | 2;
export interface Variation {
  designator: string;
  /** The part's unique ID path as written, without the leading backslash ("SHEETSYM\PART" or "PART"). */
  uniqueId: string;
  kind: VariationKind;
  /** AlternatePart= as written (AD puts the part's Comment there). */
  alternate: string;
  /** The rest of the line (AltLibLink_* …), kept as read. */
  fields: [string, string][];
}
export interface ParamVariation { designator: string; name: string; value: string }
export interface Variant { name: string; allowFabrication: boolean; variations: Variation[]; params: ParamVariation[]; extra: [string, string][] }

export const VARIATION_KINDS = ['Fitted', 'Not Fitted', 'Alternate'] as const;

function splitFields(v: string): [string, string][] {
  return v.split('|').map((part): [string, string] => { const eq = part.indexOf('='); return eq > 0 ? [part.slice(0, eq), part.slice(eq + 1)] : [part, '']; }).filter(([k]) => !!k);
}
const field = (f: [string, string][], k: string) => f.find(([x]) => x.toLowerCase() === k.toLowerCase())?.[1];

function parseVariation(v: string): Variation {
  const f = splitFields(v);
  const known = /^(Designator|UniqueId|Kind|AlternatePart)$/i;
  return {
    designator: field(f, 'Designator') ?? '', uniqueId: (field(f, 'UniqueId') ?? '').replace(/^\\/, ''),
    kind: (Number(field(f, 'Kind') ?? 0) as VariationKind) || 0, alternate: field(f, 'AlternatePart') ?? '', fields: f.filter(([k]) => !known.test(k)),
  };
}

export function readVariants(p: PrjPcb): Variant[] {
  return iniSections(p).filter((s) => /^ProjectVariant\d+$/i.test(s.name)).map((s) => {
    const get = (k: string) => s.entries.find(([x]) => x.toLowerCase() === k.toLowerCase())?.[1];
    const variations = s.entries.filter(([k]) => /^Variation\d+$/i.test(k)).map(([, v]) => parseVariation(v));
    const params: ParamVariation[] = [];
    for (const [k, v] of s.entries) {
      const m = /^ParamVariation(\d+)$/i.exec(k);
      if (!m) continue;
      const f = splitFields(v);
      params.push({ designator: get(`ParamDesignator${m[1]}`) ?? '', name: field(f, 'ParameterName') ?? '', value: field(f, 'VariantValue') ?? '' });
    }
    const extra = s.entries.filter(([k]) => !/^(Description|AllowFabrication|VariationCount|Variation\d+|ParamVariationCount|ParamVariation\d+|ParamDesignator\d+)$/i.test(k));
    return { name: get('Description') ?? s.name, allowFabrication: get('AllowFabrication') === '1', variations, params: params.filter((x) => x.designator && x.name), extra };
  });
}

const variationLine = (x: Variation) =>
  [`Designator=${x.designator}`, `UniqueId=\\${x.uniqueId}`, `Kind=${x.kind}`, `AlternatePart=${x.alternate}`, ...x.fields.map(([k, v]) => `${k}=${v}`)].join('|');

export function writeVariants(p: PrjPcb, list: Variant[]): void {
  for (const s of iniSections(p).filter((x) => /^ProjectVariant\d+$/i.test(x.name)).reverse()) iniRemoveSection(p, s.name);
  list.forEach((v, i) => {
    // A part whose parameters vary is listed even when fitted, its parameter changes after it
    const varied = new Set(v.params.map((x) => x.designator));
    const vs = v.variations.filter((x) => x.kind !== 0 || varied.has(x.designator));
    for (const d of varied) if (!vs.some((x) => x.designator === d)) vs.push({ designator: d, uniqueId: '', kind: 0, alternate: '', fields: [] });
    const extra = v.extra.length ? v.extra : [['ParameterCount', '0']] as [string, string][];
    const entries: [string, string][] = [...extra.filter(([k]) => /^UniqueId$/i.test(k)), ['Description', v.name], ['AllowFabrication', v.allowFabrication ? '1' : '0']];
    entries.push(...extra.filter(([k]) => /^ParameterCount$/i.test(k) || /^Parameter\d+/i.test(k)));
    entries.push(['VariationCount', String(vs.length)]);
    let n = 0;
    vs.forEach((x, k) => {
      entries.push([`Variation${k + 1}`, variationLine(x)]);
      for (const pv of v.params.filter((y) => y.designator === x.designator)) {
        n++;
        entries.push([`ParamVariation${n}`, `ParameterName=${pv.name}|VariantValue=${pv.value}`], [`ParamDesignator${n}`, pv.designator]);
      }
    });
    entries.push(['ParamVariationCount', String(n)]);
    entries.push(...extra.filter(([k]) => !/^(UniqueId|ParameterCount|ParamVariationCount)$/i.test(k) && !/^Parameter\d+/i.test(k)));
    iniSetSection(p, `ProjectVariant${i + 1}`, entries);
  });
  reparse(p);
}

/** The last part of a unique ID path: the part's own ID. */
export const ownId = (path: string) => path.split('\\').filter(Boolean).at(-1) ?? '';

/** How a part fares in a variant: by unique ID (its own, or its full path), else by designator. */
export function variationOf(v: Variant | null | undefined, designator: string, uniqueId: string): Variation | undefined {
  if (!v) return undefined;
  // A part in a channel has a path of its own (the channels share the part's own ID): matched by the whole path;
  // other parts by their own ID (a variation may name it by its path through the sheet symbols)
  const own = ownId(uniqueId), channel = uniqueId.includes('\\');
  const same = (x: Variation) => x.uniqueId === uniqueId || (!channel && !!own && ownId(x.uniqueId) === own) || (channel && !x.uniqueId.includes('\\') && x.uniqueId === own);
  return v.variations.find((x) => (uniqueId && same(x))) ?? v.variations.find((x) => !x.uniqueId && x.designator === designator);
}
export const isFitted = (v: Variant | null | undefined, designator: string, uniqueId: string) => variationOf(v, designator, uniqueId)?.kind !== 1;

/** An alternate part's library link: its library reference, footprint and library. */
export function alternateOf(x: Variation): { libRef: string; footprint: string; library: string; sameFootprint: boolean } {
  const f = (k: string) => field(x.fields, `AltLibLink_${k}`) ?? '';
  return { libRef: f('DesignItemID') || f('SymbolReference'), footprint: f('Footprint'), library: f('SourceLibraryName') || f('LibraryIdentifier'), sameFootprint: f('IsSameFootprint') !== 'False' };
}

/** An alternate part's AltLibLink_ fields for a part from a library (Konium's libraries are files: Library Name And Type) [est]. */
export function alternateFields(a: { libRef: string; footprint: string; library: string; sameFootprint: boolean }): [string, string][] {
  return [['AltLibLink_LibIdentifierKind', 'Library Name And Type'], ['AltLibLink_LibraryIdentifier', a.library], ['AltLibLink_SymbolReference', a.libRef],
    ['AltLibLink_DesignItemID', a.libRef], ['AltLibLink_UseLibraryName', 'True'], ['AltLibLink_SourceLibraryName', a.library],
    ['AltLibLink_UseDBTableName', 'False'], ['AltLibLink_DatabaseTableName', ''], ['AltLibLink_VaultGUID', ''], ['AltLibLink_ItemGUID', ''], ['AltLibLink_RevisionGUID', ''],
    ['AltLibLink_Footprint', a.footprint], ['AltLibLink_IsSameFootprint', a.sameFootprint ? 'True' : 'False']];
}

/**
 * The parts as a variant builds them: not-fitted ones left out (or kept, marked, when `keepNotFitted`),
 * alternate parts as their alternate (library reference, footprint), varied parameters taking
 * their variant values (a Comment of "=Value" names another parameter).
 */
export function variantComponents(components: CompiledComponent[], v: Variant | null | undefined, keepNotFitted = false): (CompiledComponent & { fitted: boolean })[] {
  const out: (CompiledComponent & { fitted: boolean })[] = [];
  for (const c of components) {
    const x = variationOf(v, c.designator, c.uniqueId);
    if (x?.kind === 1 && !keepNotFitted) continue;
    const params = { ...c.params };
    for (const pv of v?.params ?? []) if (pv.designator === c.designator) {
      const k = Object.keys(params).find((n) => n.toLowerCase() === pv.name.toLowerCase()) ?? pv.name;
      params[k] = pv.value;
    }
    const cp = Object.entries(params).find(([k]) => k.toLowerCase() === 'comment')?.[1];
    const comment = cp === undefined ? c.comment : cp.startsWith('=') ? Object.entries(params).find(([k]) => k.toLowerCase() === cp.slice(1).toLowerCase())?.[1] ?? cp : cp;
    const alt = x?.kind === 2 ? alternateOf(x) : null;
    out.push({ ...c, params, comment, libRef: alt?.libRef || c.libRef, footprint: alt?.footprint || c.footprint, fitted: x?.kind !== 1 });
  }
  return out;
}
