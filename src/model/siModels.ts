/**
 * Signal Integrity models on parts, as AD keeps them: an IMPLEMENTATION record with MODELTYPE=SI
 * (MODELNAME Res, Cap, Connector, IC …) whose IMPL_PARAMS hold Type (Resistor, Capacitor,
 * Inductor, Diode, BJT, Connector, IC) and Tech (an IC's technology [est: its values]).
 */
import { SR, bagOf, ownedBy, type SchDocument } from './sch';

export interface SchSiModel { name: string; type: string; tech: string }

/** The SI model of a part (its component record at ci), the current one first, or null. */
export function siModelOf(doc: SchDocument, ci: number, owned = ownedBy(doc)): SchSiModel | null {
  const lists = (owned.get(ci) ?? []).filter((o) => o.record === SR.IMPLEMENTATION_LIST);
  const impls = lists.flatMap((l) => (owned.get(l.index) ?? []).filter((o) => o.record === SR.IMPLEMENTATION && (bagOf(doc, o)?.get('MODELTYPE') ?? '').toUpperCase() === 'SI'));
  const pick = impls.find((o) => bagOf(doc, o)?.bool('ISCURRENT')) ?? impls[0];
  if (!pick) return null;
  const out: SchSiModel = { name: bagOf(doc, pick)?.get('MODELNAME') ?? '', type: '', tech: '' };
  for (const kid of owned.get(pick.index) ?? []) {
    if (kid.record !== SR.IMPL_PARAMS) continue;
    for (const p of owned.get(kid.index) ?? []) {
      const b = bagOf(doc, p);
      const n = (b?.get('NAME') ?? '').toLowerCase();
      if (p.record !== SR.PARAMETER) continue;
      if (n === 'type') out.type = b?.get('TEXT') ?? '';
      else if (n === 'tech') out.tech = b?.get('TEXT') ?? '';
    }
  }
  return out;
}
