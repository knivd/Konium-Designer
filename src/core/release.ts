/**
 * Release stages. Every build carries all of Konium's code, but a feature is switched on only from
 * the public release it belongs to; until then it is shown as a planned feature — its menu items
 * greyed with "Planned feature", its documents opening to a notice, its controls disabled — while
 * the build gets every fix. Raise STAGE when cutting the next public release (and add its What's
 * New entry: docs/RELEASES.md has each stage's text).
 *
 * ?features=all in the address (or localStorage "konium.features" = "all") switches everything on,
 * for testing; outside a browser (tests, tools) everything is on.
 */
export const STAGE = 20;

export type Feature = 'si' | 'multiboard' | 'harness' | 'bomSupply' | 'diagrams' | 'routeGuide' | 'enclosure' | 'requirements' | 'versionControl' | 'scripting' | 'analysis' | 'antenna' | 'live' | 'calculators' | 'aiLayout' | 'partsLibrary';

export const FEATURES: Record<Feature, { stage: number; name: string }> = {
  si: { stage: 2, name: 'Signal Integrity' },
  multiboard: { stage: 2, name: 'Multi-board design' },
  harness: { stage: 2, name: 'Harness design' },
  bomSupply: { stage: 3, name: 'BOM supply, cost and checks' },
  diagrams: { stage: 4, name: 'Diagrams' },
  routeGuide: { stage: 5, name: 'ActiveRoute Route Guide and Pin Swapping' },
  enclosure: { stage: 5, name: 'Enclosure designer' },
  requirements: { stage: 6, name: 'Requirements' },
  versionControl: { stage: 7, name: 'Version control' },
  scripting: { stage: 8, name: 'Scripting' },
  analysis: { stage: 16, name: 'Power, thermal and EMC analysis' },
  antenna: { stage: 17, name: 'Antenna analysis' },
  live: { stage: 18, name: 'Live simulation' },
  calculators: { stage: 19, name: 'Calculators' },
  aiLayout: { stage: 20, name: 'AI layout planner, Smart Router and free-flowing routing' },
  partsLibrary: { stage: 21, name: 'Parts library' },
};

/** Commands that belong to a feature (they show as planned until it is on). */
export const FEATURE_COMMANDS: Record<string, Feature> = {
  'si.panel': 'si',
  'file.newMbs': 'multiboard', 'file.newMba': 'multiboard',
  'reports.harnessWires': 'harness',
  'file.newDiagram': 'diagrams',
  'route.activeGuide': 'routeGuide', 'route.activeTune': 'routeGuide',
  'file.newEnclosure': 'enclosure',
  'file.newRequirements': 'requirements', 'panel.requirements': 'requirements',
  'vcs.add': 'versionControl', 'vcs.commit': 'versionControl', 'vcs.update': 'versionControl', 'vcs.push': 'versionControl', 'vcs.history': 'versionControl',
  'vcs.docHistory': 'versionControl', 'vcs.lock': 'versionControl', 'vcs.unlock': 'versionControl', 'vcs.settings': 'versionControl', 'vcs.clone': 'versionControl',
  'tools.scripts': 'scripting', 'help.scripting': 'scripting',
  'power.panel': 'analysis', 'thermal.panel': 'analysis', 'emc.panel': 'analysis', 'pdn.panel': 'analysis', 'field.panel': 'analysis',
  'antenna.panel': 'antenna', 'antenna.example': 'antenna',
  'live.panel': 'live', 'live.start': 'live', 'live.stop': 'live', 'live.hold': 'live', 'live.again': 'live', 'live.faster': 'live', 'live.slower': 'live', 'live.scope': 'live', 'live.examples': 'live', 'live.selection': 'live',
  'tools.calculators': 'calculators',
  'ai.layoutPlanner': 'aiLayout', 'ai.layoutExample': 'aiLayout', 'ai.smartRouter': 'aiLayout', 'ai.routeExample': 'aiLayout', 'route.makeFlowing': 'aiLayout', 'ai.boardRun': 'aiLayout',
  'parts.panel': 'partsLibrary', 'parts.example': 'partsLibrary',
  'live.monitorWithContext': 'live', 'live.scopeWithContext': 'live', 'live.newScopeWithContext': 'live', 'live.unmonitorWithContext': 'live',
};

export const PLANNED_NOTE = 'Planned feature: coming in a later release';

let everything: boolean | null = null;
/** Every feature on (testing), or outside a browser. */
export function allFeatures(): boolean {
  if (everything === null) {
    try {
      everything = typeof location === 'undefined' || /[?&]features=all\b/.test(location.search) || globalThis.localStorage?.getItem('konium.features') === 'all';
    } catch { everything = false; }
  }
  return everything;
}

export const featureOn = (f: Feature): boolean => allFeatures() || FEATURES[f].stage <= STAGE;
/** The feature a command belongs to, when it isn't on yet. */
export const plannedFeature = (commandId: string): Feature | null => { const f = FEATURE_COMMANDS[commandId]; return f && !featureOn(f) ? f : null; };
