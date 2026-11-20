/**
 * A document of a feature not released yet (a multi-board schematic or assembly, a harness drawing,
 * a diagram, an enclosure): open in its tab, but not shown or edited until the release that
 * brings it.
 */
import type { OpenDoc } from './state';
import type { SchDocument } from '../model/sch';
import { harnessKind } from '../model/harness';
import { FEATURES, PLANNED_NOTE, featureOn, type Feature } from '../core/release';

/** The feature a document belongs to, when it isn't on yet. */
export function plannedDoc(od: OpenDoc): Feature | null {
  const k = od.doc.kind;
  const f: Feature | null = k === 'MbsDoc' || k === 'MbaDoc' ? 'multiboard' : k === 'Diagram' ? 'diagrams' : k === 'Enclosure' ? 'enclosure' : k === 'ReqDoc' ? 'requirements'
    : k === 'SchDoc' && harnessKind(od.doc as SchDocument) ? 'harness' : null;
  return f && !featureOn(f) ? f : null;
}

export function PlannedDocView({ od, feature }: { od: OpenDoc; feature: Feature }) {
  return (
    <div class="planned-doc" aria-label={`${od.name}: planned feature`}>
      <div class="planned-doc-box">
        <h2>{FEATURES[feature].name}<span class="planned-tag">Planned</span></h2>
        <p>{PLANNED_NOTE}. {od.name} is open, and kept as it is, but Konium Designer doesn't show or edit it yet.</p>
      </div>
    </div>
  );
}

/** A panel of a feature not released yet. */
export function PlannedPanel({ feature }: { feature: Feature }) {
  return <p class="panel-empty">{FEATURES[feature].name}<span class="planned-tag">Planned</span><br />{PLANNED_NOTE}.</p>;
}
