/**
 * Konium's own 16×16 icons. Line icons use currentColor; the "doc" and toolbar icons
 * carry a little colour in the desktop-CAD manner. All artwork is original.
 */
const P: Record<string, preact.ComponentChildren> = {
  select: <path d="M3 2l9 5-4 1-1 4z" />,
  wire: <path d="M2 12h5V4h7" />,
  bus: <path d="M2 12h5V4h7" stroke-width="3" />,
  netlabel: <><path d="M2 12h12" /><path d="M4 9h6l2-2-2-2H4z" /></>,
  power: <><path d="M8 14V6" /><path d="M3 6h10" stroke-width="2.2" /></>,
  ground: <><path d="M8 2v6" /><path d="M3 8h10M5 11h6M7 14h2" /></>,
  part: <><rect x="4" y="3" width="8" height="10" rx="1" /><path d="M1 6h3M1 10h3M12 6h3M12 10h3" /></>,
  port: <path d="M2 5h8l4 3-4 3H2z" />,
  text: <path d="M3 3h10M8 3v10M6 13h4" />,
  track: <><path d="M2 13l5-5h7" stroke-width="2.4" /><circle cx="14" cy="8" r="1.4" /></>,
  route: <><path d="M2 13l4-4h4l4-4" stroke-width="2.2" /><circle cx="2" cy="13" r="1.4" /></>,
  via: <><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="2" /></>,
  pad: <><rect x="3" y="3" width="10" height="10" rx="1.5" /><circle cx="8" cy="8" r="2" /></>,
  fill: <rect x="3" y="4" width="10" height="8" fill="currentColor" />,
  polygon: <><path d="M2 4l6-2 6 3-1 8-9 1z" /><path d="M4 6l7 6M6 4l7 5M3 9l5 4" stroke-width="1" /></>,
  component: <><rect x="4" y="4" width="8" height="8" /><path d="M6 1v3M10 1v3M6 12v3M10 12v3" /></>,
  save: <><path d="M3 2h8l2 2v10H3z" /><path d="M5 2v4h5V2M5 14v-4h6v4" /></>,
  undo: <path d="M5 4L2 7l3 3M2 7h7a4 4 0 0 1 0 8H7" />,
  redo: <path d="M11 4l3 3-3 3M14 7H7a4 4 0 0 0 0 8h2" />,
  /* A toothed wheel: Preferences */
  gear: <path d="M13.26 6.79L15.23 6.98L15.23 9.02L13.26 9.21L12.58 10.86L13.83 12.39L12.39 13.83L10.86 12.58L9.21 13.26L9.02 15.23L6.98 15.23L6.79 13.26L5.14 12.58L3.61 13.83L2.17 12.39L3.42 10.86L2.74 9.21L0.77 9.02L0.77 6.98L2.74 6.79L3.42 5.14L2.17 3.61L3.61 2.17L5.14 3.42L6.79 2.74L6.98 0.77L9.02 0.77L9.21 2.74L10.86 3.42L12.39 2.17L13.83 3.61L12.58 5.14ZM10.3 8a2.3 2.3 0 1 1-4.6 0a2.3 2.3 0 1 1 4.6 0Z" stroke-linejoin="round" />,
  panels: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M6 3v10M2 7h4" /></>,
  warn: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6v4M8 11.5v.5" /></>,
  pin: <><path d="M6 2h4l-1 4 2 2H5l2-2z" /><path d="M8 8v6" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  menu: <path d="M4 6l4 4 4-4" />,
  chevronLeft: <path d="M10 3L5 8l5 5" />,
  chevronRight: <path d="M6 3l5 5-5 5" />,
  measure: <><path d="M2 11l9-9 3 3-9 9z" /><path d="M5 8l1.5 1.5M7 6l1 1M9 4l1.5 1.5" stroke-width="1" /></>,
  /* The enclosure designer's tools and views (each its own drawing) */
  encSelect: <><path d="M3 2l7.5 4.2-3.3.9-1 3.4z" /><path d="M9.5 9.5h4.5v4.5H9.5z" stroke-width="1.1" /></>,
  encHole: <><circle cx="8" cy="8" r="4" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke-width="1.1" /></>,
  encCutout: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><rect x="4.5" y="6" width="7" height="4" rx="1" fill="currentColor" /></>,
  encSlot: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M5.5 8h5" stroke-width="3.2" /></>,
  encPocket: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M4.5 11V5.5h7" /><path d="M5.5 11h6V6" stroke-dasharray="1.2 1.2" stroke-width="1.1" /></>,
  encVents: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M4.5 6h7M4.5 8h7M4.5 10h7" stroke-width="1.2" /></>,
  encBoss: <><ellipse cx="8" cy="4.5" rx="4.5" ry="2" /><path d="M3.5 4.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7" /><ellipse cx="8" cy="4.5" rx="1.5" ry=".7" /></>,
  encPin: <><path d="M6.5 13.5V6.5L8 3l1.5 3.5v7" /><path d="M3 13.5h10" /></>,
  encBlock: <><path d="M2.5 6l5.5-3 5.5 3v5l-5.5 3-5.5-3z" /><path d="M2.5 6l5.5 3 5.5-3M8 9v5" stroke-width="1.1" /></>,
  encRib: <><path d="M1.5 13h13" /><path d="M6.5 13V3.5h3V13" /><path d="M6.5 6.5h3" stroke-width="1" /></>,
  encText: <><path d="M1.5 14h13" stroke-width="1.1" /><path d="M4 12l4-9 4 9M5.6 8.6h4.8" /></>,
  encLogo: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.3l1.1 2.3 2.5.3-1.9 1.7.5 2.5L8 9.9l-2.2 1.2.5-2.5-1.9-1.7 2.5-.3z" stroke-width="1.1" /></>,
  encFind: <><rect x="1.5" y="3" width="9" height="7" rx="1" /><path d="M4 5.5h2.5v2H4z" stroke-width="1" /><circle cx="11" cy="10.5" r="2.6" /><path d="M12.9 12.4l1.8 1.8" /></>,
  encAssembled: <><rect x="2.5" y="6" width="11" height="7.5" rx="1" /><rect x="2" y="3.5" width="12" height="2.5" rx="1" /></>,
  encExploded: <><rect x="2.5" y="8.5" width="11" height="5.5" rx="1" /><rect x="2" y="2" width="12" height="2.5" rx="1" /><path d="M8 5.5v2" stroke-dasharray="1 1" stroke-width="1.1" /></>,
  encPlate: <><path d="M1 14h14" /><rect x="2" y="7.5" width="5.5" height="6.5" rx=".8" /><rect x="9" y="10.5" width="5.5" height="3.5" rx=".8" /></>,
  encSectionFB: <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M8 1v14" stroke-dasharray="2 1.4" /><path d="M8 3h5.5v10H8" fill="currentColor" fill-opacity=".25" stroke="none" /></>,
  encSectionLR: <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M1 8h14" stroke-dasharray="2 1.4" /><path d="M2.5 8h11v5h-11z" fill="currentColor" fill-opacity=".25" stroke="none" /></>,
  encShowBoard: <><rect x="1.5" y="4" width="13" height="8" rx=".8" /><rect x="5.5" y="6" width="4" height="4" stroke-width="1.1" /><path d="M3.5 6.5v3M11.5 6.5v3" stroke-width="1" /></>,
  encShowTop: <><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3.5 6v6.5h9V6" stroke-dasharray="1.4 1.2" stroke-width="1.1" /></>,
  encViews: <><path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="M2.5 4.8L8 8l5.5-3.2M8 8v6.2" stroke-width="1.1" /><path d="M8 8l-5.5-3.2" fill="currentColor" /></>,
  encFit: <><path d="M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11" /><rect x="5" y="5.5" width="6" height="5" rx=".8" stroke-width="1.1" /></>,
  encFaceView: <><rect x="1.5" y="1.5" width="13" height="13" rx="1" /><path d="M1.5 8.5h13" /><rect x="4.5" y="10.5" width="7" height="2.2" rx=".5" stroke-width="1" /></>,
  encExport: <><path d="M2.5 9.5v4h11v-4" /><path d="M8 2v8M5 7l3 3 3-3" /><path d="M10.5 2.5h3v3" stroke-width="1" /></>,
  encDuplicate: <><rect x="2" y="5" width="8" height="8" rx="1" /><path d="M6 5V3h8v8h-4" /></>,
  encMirror: <><path d="M8 1.5v13" stroke-dasharray="1.6 1.2" /><path d="M6 4L2 11h4zM10 4l4 7h-4z" /></>,
  encRepeat: <><rect x="1.5" y="6" width="3.5" height="4" rx=".6" /><rect x="6.25" y="6" width="3.5" height="4" rx=".6" /><rect x="11" y="6" width="3.5" height="4" rx=".6" /><path d="M3 3.5h10l-1.5-1.5" stroke-width="1" /></>,
  encDelete: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5l.7 9h5.6l.7-9" /><path d="M7 7v4.5M9 7v4.5" stroke-width="1" /></>,
  encEye: <><path d="M1.5 8c1.8-3 4-4.5 6.5-4.5s4.7 1.5 6.5 4.5c-1.8 3-4 4.5-6.5 4.5S3.3 11 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  encEyeOff: <><path d="M1.5 8c1.8-3 4-4.5 6.5-4.5s4.7 1.5 6.5 4.5c-1.8 3-4 4.5-6.5 4.5S3.3 11 1.5 8z" stroke-opacity=".45" /><path d="M2.5 13.5l11-11" /></>,
  encWarn: <><path d="M8 1.8l6.6 11.7H1.4z" /><path d="M8 6v3.6M8 11.3v.4" stroke-width="1.5" /></>,
  encStandoff: <><ellipse cx="8" cy="4" rx="3.5" ry="1.4" /><path d="M4.5 4v8.5c0 .8 1.6 1.4 3.5 1.4s3.5-.6 3.5-1.4V4" /><path d="M1.5 14.5h13" stroke-width="1" /></>,
  encScrew: <><path d="M3.5 3h9" stroke-width="2" /><path d="M6 4v8.5l2 2 2-2V4" /><path d="M6 6.5l4 1M6 9l4 1" stroke-width="1" /></>,
  encCentreX: <><path d="M8 1.5v13" stroke-dasharray="1.6 1.2" /><rect x="4" y="5" width="8" height="6" rx="1" /></>,
  encCentreY: <><path d="M1.5 8h13" stroke-dasharray="1.6 1.2" /><rect x="5" y="4" width="6" height="8" rx="1" /></>,
  encShapeRect: <rect x="2.5" y="4" width="11" height="8" />,
  encShapeRounded: <rect x="2.5" y="4" width="11" height="8" rx="2.5" />,
  encShapeCircle: <circle cx="8" cy="8" r="5" />,
  encShapeSlot: <rect x="1.5" y="5" width="13" height="6" rx="3" />,
  /* The Parts panel (R21): each of its actions its own glyph */
  partsSearch: <><circle cx="7" cy="7" r="4.5" /><path d="M10.4 10.4L14 14" /></>,
  /* Build from the datasheet: a wand and its sparks */
  partsBuild: <><path d="M2.5 13.5L10 6" /><path d="M9 5l2 2" /><path d="M12.5 1.6v2.2M11.4 2.7h2.2M14 6.4v1.8M13.1 7.3h1.8M6 1.8v1.8M5.1 2.7h1.8" stroke-width="1" /></>,
  /* Place: a part with the pointer that carries it */
  partsPlace: <><rect x="2" y="2" width="7" height="7" rx="1" /><path d="M8.5 8.5l5.5 2.2-2.3 1-1 2.3z" fill="currentColor" stroke-width="1" /></>,
  /* Save as an integrated library: two bound volumes and the way out */
  partsIntLib: <><path d="M2 2.5h3.5v11H2zM5.5 2.5H9v11H5.5z" /><path d="M12.3 5.5v6.5M10.6 10.3l1.7 1.7 1.7-1.7" /></>,
  /* Save as a part file: a sheet and the way out */
  partsFileOut: <><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /><path d="M8 7v4.6M6.3 9.9L8 11.6l1.7-1.7" /></>,
  /* Add a part file: a sheet and a plus */
  partsFileIn: <><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /><path d="M8 7.3v4.2M5.9 9.4h4.2" /></>,
  /* The example part: a flask */
  partsExample: <><path d="M6 1.8h4M6.6 1.8v4.4L3 13.6h10L9.4 6.2V1.8" /><path d="M4.9 10h6.2" /></>,
  /* Take off the shelf: a bin */
  partsRemove: <><path d="M2.8 4.5h10.4M6.3 4.5V2.8h3.4v1.7" /><path d="M4.3 4.5l.8 9.2h5.8l.8-9.2" /><path d="M6.9 7v4.3M9.1 7v4.3" stroke-width="1" /></>,
  /* A check passed */
  partsOk: <path d="M3 8.6l3.2 3.2L13 4.6" />,
  /* A link that opens outside */
  partsLink: <><path d="M9.2 2.8h4v4M13.2 2.8L7.6 8.4" /><path d="M11 9.6V13H3V5h3.4" /></>,
  /* Kept on this computer */
  partsLocal: <><rect x="3" y="7" width="10" height="7" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  /* The planning panels (Layout Planner, Smart Router, Plan, Place and Route): each action its own glyph */
  kpBoard: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 6.2h3.2l2.6 3.6" stroke-width="1.1" /><circle cx="5" cy="6.2" r="1" fill="currentColor" stroke="none" /><circle cx="10.8" cy="9.8" r="1" fill="currentColor" stroke="none" /></>,
  /* What goes out to the model: a paper dart */
  kpSend: <><path d="M2 7.6l12-5.2-4.6 11.4-2.3-4.5z" /><path d="M7.1 9.3L14 2.4" /></>,
  /* Plan the layout: zones, and one more */
  kpPlanLayout: <><rect x="2" y="2" width="5.5" height="5.5" rx="1" /><rect x="9.5" y="2" width="4.5" height="7.5" rx="1" /><rect x="2" y="9.5" width="5.5" height="4.5" rx="1" /><path d="M11.8 11.2v3.2M10.2 12.8h3.2" stroke-width="1.1" /></>,
  /* Place by the plan: a part set down in its zone */
  kpPlace: <><rect x="2" y="2" width="12" height="12" rx="1.5" stroke-dasharray="2 1.7" /><rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" fill="currentColor" stroke="none" /></>,
  /* Make rooms: the board divided */
  kpRooms: <><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 8.5h6.5M8.5 2v12" /></>,
  /* Copy the plan: two sheets */
  kpCopy: <><rect x="5.2" y="5" width="8.3" height="9" rx="1" /><path d="M3 11V3.2A1.2 1.2 0 0 1 4.2 2h6.3" /></>,
  /* Stop */
  kpStop: <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />,
  /* Plan the routing: a way thought out between two ends */
  kpPlanRouting: <><circle cx="3" cy="12.5" r="1.5" /><circle cx="13" cy="3.5" r="1.5" /><path d="M4.5 12.5c4 0 3-9 7-9" stroke-dasharray="1.8 1.6" /></>,
  /* Route by the plan: the track laid */
  kpRoute: <><circle cx="3" cy="12.5" r="1.5" /><circle cx="13" cy="3.5" r="1.5" /><path d="M4.5 12.5h3.3l3.7-3.7V5" stroke-width="1.8" /></>,
  /* Make the rules: a rule with its marks */
  kpRules: <><rect x="1.5" y="5" width="13" height="6" rx="1" /><path d="M4.4 5v2.4M7 5v3.6M9.6 5v2.4M12.2 5v3.6" stroke-width="1.1" /></>,
  /* Plan again: round once more */
  kpAgain: <><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13.3 2v3.2h-3.2" /></>,
  /* Start anew: round again, to the start */
  kpAnew: <><path d="M12.9 8.8a5 5 0 1 1-1.5-4.5" /><path d="M13.3 2v3.2h-3.2" /><path d="M6.7 6.1l3.2 1.9-3.2 1.9z" fill="currentColor" stroke="none" /></>,
  /* Start the run, and carry on with it */
  kpStart: <path d="M4.5 3l8.5 5-8.5 5z" fill="currentColor" stroke="none" />,
  kpContinue: <><path d="M3 3.2L9.6 8 3 12.8z" fill="currentColor" stroke="none" /><path d="M12.2 3.2v9.6" stroke-width="2" /></>,
  /* More of a row, and the way to another panel */
  kpMore: <path d="M4 6l4 4 4-4" />,
  kpGo: <path d="M3 8h9.5M8.8 4.3L12.5 8l-3.7 3.7" />,
  // A panel's empty states: AI off, and the way to Preferences
  kvAiOff: <><path d="M8 2.2l1.3 3.1 3.2 1.2-3.2 1.2L8 10.8 6.7 7.7 3.5 6.5l3.2-1.2z" /><path d="M2.5 13.5l11-11" /></>,
  kvPrefs: <><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></>,
  // The analysis panels' tools (their run is kpStart)
  anReport: <><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /><path d="M6 8.2h4M6 10.8h4" /></>,
  anWarmUp: <><path d="M2.5 2.5v11h11" /><path d="M4.2 11.6c2-5.4 4.5-7 8.6-7.3" /></>,
  anPick: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></>,
  // Help › Get Konium Designer on This Computer: its two actions
  getInstall: <><rect x="2" y="2.5" width="12" height="9" rx="1.2" /><path d="M5.5 14h5M8 11.5V14" /><path d="M8 4.6v4M6.3 7L8 8.7 9.7 7" /></>,
  getDownload: <><path d="M8 2v7.6M4.9 6.6L8 9.7l3.1-3.1" /><path d="M2.5 11.2v2.3h11v-2.3" /></>,
};

export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {P[name] ?? null}
    </svg>
  );
}

/* ─── Colour toolbar / tree icons ─────────────────────────────────────────────────────── */

const ink = '#3d4f5f', blue = '#3b78b5', gold = '#d6a737', green = '#3f9a6a', red = '#c0503f', paper = '#ffffff';

/* The Simulation Sources toolbar: a source (its circle and what it gives) with its value */
const srcInk = '#1d4f91';
const srcLabel = (t: string) => <text x="16" y="5.6" font-size={t.length > 3 ? 5 : 6} font-family="Arial" font-weight="700" text-anchor="end" fill={red} stroke="none">{t}</text>;
const srcBody = (glyph: preact.ComponentChildren, t: string) => <><path d="M5.5 1.5v3M5.5 13.5v2" stroke={srcInk} /><circle cx="5.5" cy="9" r="4.5" fill={paper} stroke={srcInk} />{glyph}{srcLabel(t)}</>;
const dcGlyph = <path d="M4.3 7h2.4M5.5 5.8v2.4M4.3 11h2.4" stroke={srcInk} stroke-width="0.9" />;
const sineGlyph = <path d="M2.5 9c.75-2.4 1.5-2.4 2.25 0s1.5 2.4 2.25 0 1.5-2.4 1.5-2.4" stroke={srcInk} stroke-width="0.9" fill="none" />;
const pulseGlyph = <path d="M2.5 10.5h1.5v-3h3v3h1.5" stroke={srcInk} stroke-width="0.9" fill="none" />;

const C: Record<string, preact.ComponentChildren> = {
  openProject: <><path d="M1.5 4.5V3h5l1.5 1.5h6V13h-12.5z" fill="#f0c75a" stroke="#a37b22" /><path d="M1.5 6.5h13" stroke="#a37b22" /></>,
  /* Open: a folder standing open with a document in it (it was a page of text, which said "a document", not "open one") */
  open: <><path d="M1.5 13.5V3h4.5l1.5 1.5h6v2.5" fill="#f0c75a" stroke="#a37b22" /><path d="M5.5 8V2.5h4l2 2V8" fill={paper} stroke={ink} /><path d="M1.5 13.5l2.3-6h11.7l-2.3 6z" fill="#f7da84" stroke="#a37b22" /></>,
  // Live Simulation's examples: a scope's screen with a wave on it
  liveSim: <><rect x="1.5" y="2" width="13" height="10" rx="1.5" fill={paper} stroke={ink} /><path d="M3.5 7c1-3.5 2-3.5 3 0s2 3.5 3 0 2-3.5 3 0" fill="none" stroke={green} stroke-width="1.3" /><path d="M5 14.5h6" stroke={ink} /></>,
  calculator: <><rect x="3" y="1.5" width="10" height="13" rx="1.5" fill={paper} stroke={ink} /><rect x="5" y="3.5" width="6" height="2.5" fill={green} /><path d="M5.5 8.5h1M7.5 8.5h1M9.5 8.5h1M5.5 10.5h1M7.5 10.5h1M9.5 10.5h1M5.5 12.5h1M7.5 12.5h1M9.5 12.5h1" stroke={ink} stroke-width="1.2" /></>,
  save: <><path d="M2 2h10l2 2v10H2z" fill="#7fa9d1" stroke="#2f5b86" /><path d="M4.5 2v4h6V2" fill={paper} stroke="#2f5b86" /><path d="M4 14v-5h8v5" fill={paper} stroke="#2f5b86" /></>,
  saveAll: <><path d="M4 1h8l2 2v8H4z" fill="#b6cfe6" stroke="#2f5b86" /><path d="M2 4h8l2 2v8H2z" fill="#7fa9d1" stroke="#2f5b86" /><path d="M4 14v-4h6v4" fill={paper} stroke="#2f5b86" /></>,
  saveAs: <><path d="M2 2h10l2 2v10H2z" fill="#7fa9d1" stroke="#2f5b86" /><path d="M4.5 2v4h6V2" fill={paper} stroke="#2f5b86" /><path d="M8.5 14.5l1-3 4.5-4.5 2 2-4.5 4.5z" fill="#f2c94c" stroke="#8a6a2c" /></>,
  closeAll: <><path d="M4 1.5h6l3 3v6H4z" fill="#e8eef4" stroke={ink} /><path d="M2 4.5h6l3 3v7H2z" fill={paper} stroke={ink} /><path d="M3.8 9l4 4M7.8 9l-4 4" stroke="#d01f1f" stroke-width="1.5" /></>,
  // File › Import Wizard: another tool's page, an arrow bringing it in
  importWizard: <><path d="M6.5 1.5h5l3 3v10h-8v-3" fill={paper} stroke={ink} /><path d="M6.5 5.5v-4" stroke={ink} /><path d="M11.5 1.5v3h3" stroke={ink} /><path d="M1 8.5h7.5M6 6l2.5 2.5L6 11" fill="none" stroke={green} stroke-width="1.6" /></>,
  exportWizard: <><path d="M1.5 1.5h5l3 3v10h-8z" fill={paper} stroke={ink} /><path d="M6.5 1.5v3h3" stroke={ink} /><path d="M7.5 8.5H15M12.5 6l2.5 2.5-2.5 2.5" fill="none" stroke={blue} stroke-width="1.6" /></>,
  demo: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#5aa07a" stroke="#2f6b4b" /><path d="M8 4.2l1.1 2.3 2.5.3-1.8 1.7.5 2.5L8 9.8 5.7 11l.5-2.5-1.8-1.7 2.5-.3z" fill="#ffd54a" stroke="#a37b22" stroke-width="0.8" /></>,
  printDialog: <><rect x="4" y="1.5" width="8" height="4" fill={paper} stroke={ink} /><rect x="1.5" y="5.5" width="13" height="6" rx="1" fill="#b9c4cc" stroke={ink} /><rect x="4" y="9.5" width="8" height="5" fill={paper} stroke={ink} /><path d="M5.5 12.2h.1M8 12.2h.1M10.5 12.2h.1" stroke={ink} stroke-width="1.6" /></>,
  fitObjects: <><path d="M1.5 5V1.5H5M11 1.5h3.5V5M1.5 11v3.5H5M11 14.5h3.5V11" stroke={ink} /><rect x="4" y="4.5" width="3.5" height="3" fill="#9fd0a6" stroke={green} /><circle cx="10.5" cy="6" r="1.6" fill="#f2c94c" stroke="#8a6a2c" /><path d="M4.5 11h7" stroke={red} stroke-width="1.6" /></>,
  fitBoard: <><path d="M1.5 5V1.5H5M11 1.5h3.5V5M1.5 11v3.5H5M11 14.5h3.5V11" stroke={ink} /><path d="M4 4.5h8v7H4z" fill="#3f8f5c" stroke="#245c39" /><path d="M5.5 7.5h3v2" stroke="#e8c26a" /></>,
  selectAll: <><rect x="1.5" y="1.5" width="13" height="13" fill="#cce4fa" stroke={blue} stroke-dasharray="2 1.5" /><rect x="4" y="4" width="3" height="3" fill={blue} stroke="none" /><rect x="9" y="4" width="3" height="3" fill={blue} stroke="none" /><rect x="4" y="9" width="3" height="3" fill={blue} stroke="none" /><rect x="9" y="9" width="3" height="3" fill={blue} stroke="none" /></>,
  noercSpecific: <><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="#d01f1f" stroke-width="1.8" /><circle cx="11.5" cy="11.5" r="3" fill={paper} stroke={blue} /><circle cx="11.5" cy="11.5" r="1" fill={blue} stroke="none" /></>,
  schArcCircular: <><path d="M3 13a10 10 0 0 1 10-10" stroke="#1d3fa8" stroke-width="1.6" fill="none" /><path d="M3 13h1.5M13 3v1.5" stroke={ink} /><circle cx="13" cy="13" r="1" fill={ink} stroke="none" /></>,
  roomArrange: <><rect x="1.5" y="2.5" width="13" height="11" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><rect x="3.5" y="4.5" width="3" height="2.5" fill={paper} stroke={ink} /><rect x="9.5" y="4.5" width="3" height="2.5" fill={paper} stroke={ink} /><rect x="3.5" y="9" width="3" height="2.5" fill={paper} stroke={ink} /><path d="M9 10.5h4M11.5 9l1.5 1.5-1.5 1.5" stroke={ink} /></>,
  gridReverse: <><path d="M1.5 1.5h13v13h-13z" fill={paper} stroke={ink} /><path d="M5.8 1.5v13M10.2 1.5v13M1.5 5.8h13M1.5 10.2h13" stroke={blue} stroke-width="0.8" /><path d="M12.5 8.5a4 4 0 1 1-1.2-2.8" stroke={red} stroke-width="1.4" /><path d="M11.8 3.6l-.3 2.3 2.3.1" stroke={red} stroke-width="1.2" /></>,
  gridVisible: <><path d="M1.5 1.5h13v13h-13z" fill={paper} stroke={ink} /><path d="M5.8 1.5v13M10.2 1.5v13M1.5 5.8h13M1.5 10.2h13" stroke={blue} stroke-width="0.8" /><path d="M3 9.5c2.8-3.2 7.2-3.2 10 0-2.8 3.2-7.2 3.2-10 0z" fill={paper} stroke={ink} /><circle cx="8" cy="9.5" r="1.5" fill={ink} stroke="none" /></>,
  drill: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><circle cx="6" cy="7" r="1.6" fill="none" stroke={ink} /><circle cx="10" cy="7" r="1" fill="none" stroke={ink} /><circle cx="6" cy="11.5" r="1" fill="none" stroke={ink} /><path d="M9 11.5h2M10 10.5v2" stroke={red} /></>,
  pnp: <><rect x="4.5" y="6.5" width="7" height="5" fill="#4a4f55" stroke={ink} /><path d="M6 6.5v-1M8 6.5v-1M10 6.5v-1M6 11.5v1M8 11.5v1M10 11.5v1" stroke={ink} /><path d="M8 1v4M6.5 3.5L8 5l1.5-1.5" stroke={red} /><path d="M1 9h2.5M12.5 9H15" stroke={blue} stroke-dasharray="1 1" /></>,
  dimGeneric: <><path d="M1.5 3v10M14.5 3v10" stroke={ink} /><path d="M1.5 10h13" stroke={red} /><path d="M3.5 8.5L1.5 10l2 1.5M12.5 8.5l2 1.5-2 1.5" stroke={red} fill="none" /><path d="M5.5 3.5h5v3h-5z" fill={paper} stroke={blue} /></>,
  saveProject: <><path d="M2 2h10l2 2v10H2z" fill="#7fa9d1" stroke="#2f5b86" /><path d="M4.5 2v4h6V2" fill={paper} stroke="#2f5b86" /><rect x="4.5" y="9" width="7" height="5" rx="0.5" fill="#5aa07a" stroke="#2f6b4b" /></>,
  openProjectDocs: <><path d="M5 1.5h6l2.5 2.5v7H5z" fill="#e8eef4" stroke={ink} /><path d="M2.5 4.5h6l2.5 2.5v7.5h-8.5z" fill={paper} stroke={ink} /><path d="M4.5 9.5h4M4.5 11.5h4" stroke={blue} /></>,
  fitAll: <><path d="M1.5 5V1.5H5M11 1.5h3.5V5M1.5 11v3.5H5M11 14.5h3.5V11" stroke={ink} /><rect x="4.5" y="4.5" width="7" height="7" fill="#9fd0a6" stroke={green} /></>,
  zoomIn: <><circle cx="6.5" cy="6.5" r="4.5" fill={paper} stroke={ink} /><path d="M10 10l4.5 4.5" stroke={ink} stroke-width="2" /><path d="M4.5 6.5h4M6.5 4.5v4" stroke={blue} /></>,
  zoomOut: <><circle cx="6.5" cy="6.5" r="4.5" fill={paper} stroke={ink} /><path d="M10 10l4.5 4.5" stroke={ink} stroke-width="2" /><path d="M4.5 6.5h4" stroke={blue} /></>,
  zoomSel: <><circle cx="6.5" cy="6.5" r="4.5" fill={paper} stroke={ink} /><path d="M10 10l4.5 4.5" stroke={ink} stroke-width="2" /><rect x="4.5" y="4.5" width="4" height="4" fill="#9fd0a6" stroke={green} /></>,
  cut: <><path d="M4 2l8 9M12 2L4 11" stroke={ink} /><circle cx="4" cy="12.5" r="2" fill={paper} stroke={red} /><circle cx="12" cy="12.5" r="2" fill={paper} stroke={red} /></>,
  copy: <><rect x="1.5" y="1.5" width="8" height="10" fill={paper} stroke={ink} /><rect x="6.5" y="4.5" width="8" height="10" fill={paper} stroke={ink} /><path d="M8.5 8h4M8.5 10h4M8.5 12h3" stroke={blue} /></>,
  paste: <><rect x="2.5" y="2.5" width="9" height="12" fill="#e5c58a" stroke="#8a6a2c" /><rect x="5" y="1.5" width="4" height="2.5" fill={paper} stroke="#8a6a2c" /><rect x="7.5" y="6.5" width="7" height="8" fill={paper} stroke={ink} /></>,
  undo: <path d="M5 3.5L1.5 7 5 10.5M1.5 7H10a4 4 0 0 1 0 8H7" stroke={blue} stroke-width="1.6" fill="none" />,
  redo: <path d="M11 3.5L14.5 7 11 10.5M14.5 7H6a4 4 0 0 0 0 8h3" stroke={blue} stroke-width="1.6" fill="none" />,
  selectArea: <><rect x="1.5" y="1.5" width="10" height="9" fill="none" stroke={ink} stroke-dasharray="2 1.5" /><path d="M8 7l6 3-2.6.8-.9 2.7z" fill={paper} stroke={ink} /></>,
  deselect: <><rect x="1.5" y="1.5" width="10" height="9" fill="none" stroke={ink} stroke-dasharray="2 1.5" /><path d="M9 9l5 5M14 9l-5 5" stroke={red} stroke-width="1.6" /></>,
  compile: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M5 9l2 2 4-5" stroke={green} stroke-width="1.8" fill="none" /></>,
  annotate: <><rect x="2" y="3" width="8" height="10" fill={paper} stroke={ink} /><path d="M11 3h3M11 6h3M11 9h3" stroke={blue} /><text x="4" y="11" font-size="7" font-family="Arial" fill={red} stroke="none">U</text></>,
  updatePcb: <><path d="M2 3h5v4H2z" fill="#f4eccc" stroke="#9b7b2c" /><path d="M9 9h5v5H9z" fill="#9fd0a6" stroke={green} /><path d="M5 8v3h3" stroke={blue} fill="none" /><path d="M7 9.5l1.5 1.5L7 12.5" stroke={blue} fill="none" /></>,
  bom: <><rect x="2.5" y="1.5" width="11" height="13" fill={paper} stroke={ink} /><path d="M4.5 4.5h1M7 4.5h5M4.5 7.5h1M7 7.5h5M4.5 10.5h1M7 10.5h5" stroke={blue} /></>,
  layers: <><path d="M8 2l6.5 3L8 8 1.5 5z" fill="#e05a4a" stroke="#8e2c20" /><path d="M1.5 8L8 11l6.5-3" stroke="#2f5b86" fill="none" /><path d="M1.5 11L8 14l6.5-3" stroke={gold} fill="none" /></>,
  stack: <><rect x="1.5" y="2" width="13" height="2.5" fill="#e05a4a" stroke="#8e2c20" /><rect x="1.5" y="6.5" width="13" height="2.5" fill="#d9cfa8" stroke="#8a7b4a" /><rect x="1.5" y="11" width="13" height="2.5" fill="#4b80c4" stroke="#2f5b86" /></>,
  rules: <><rect x="1.5" y="5" width="13" height="6" fill="#f4eccc" stroke="#8a7b4a" /><path d="M3.5 5v3M6 5v2M8.5 5v3M11 5v2M13.5 5v3" stroke="#8a7b4a" /></>,
  drc: <><rect x="1.5" y="2.5" width="13" height="11" fill="#1d2b26" stroke={ink} /><path d="M3 10h4l2-3h4" stroke="#e05a4a" stroke-width="1.6" fill="none" /><path d="M4 5l2 2 4-4" stroke="#7fd08a" stroke-width="1.6" fill="none" /></>,
  gerber: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M5 7h6v5H5z" fill="#e05a4a" stroke="none" /><path d="M6 9.5h4" stroke={paper} /></>,
  measure: <><path d="M1.5 11l9.5-9.5 3.5 3.5L5 14.5z" fill="#f2d98b" stroke="#8a6a2c" /><path d="M4.5 8l1.5 1.5M6.5 6l1 1M8.5 4l1.5 1.5" stroke="#8a6a2c" /></>,
  /* Schematic wiring */
  wire: <path d="M1.5 12.5h5v-9h8" stroke="#1d3fa8" stroke-width="1.8" fill="none" />,
  bus: <path d="M1.5 12.5h5v-9h8" stroke="#1d3fa8" stroke-width="3.2" fill="none" />,
  netlabel: <><path d="M1 13.5h14" stroke="#1d3fa8" stroke-width="1.6" /><text x="2" y="10" font-size="8" font-family="Arial" font-weight="700" fill="#1d3fa8" stroke="none">Net</text></>,
  gnd: <><path d="M8 1.5v6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M2.5 7.5h11M4.5 10.5h7M6.5 13.5h3" stroke="#1d3fa8" stroke-width="1.6" /></>,
  vcc: <><path d="M8 14.5v-9" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3 5.5h10" stroke="#1d3fa8" stroke-width="2.2" /><text x="4" y="4" font-size="4.5" font-family="Arial" fill="#1d3fa8" stroke="none">VCC</text></>,
  part: <><rect x="4.5" y="2.5" width="7" height="11" fill="#fff6c8" stroke="#8e2c20" /><path d="M1 5h3.5M1 8h3.5M1 11h3.5M11.5 5H15M11.5 8H15M11.5 11H15" stroke={ink} /></>,
  port: <path d="M1.5 5h9l4 3-4 3h-9z" fill="#fff6a0" stroke="#8e2c20" />,
  noerc: <path d="M4 4l8 8M12 4l-8 8" stroke="#d01f1f" stroke-width="1.8" />,
  text: <path d="M3 3h10M8 3v10M6 13h4" stroke={ink} stroke-width="1.6" fill="none" />,
  textFrame: <><rect x="1.5" y="2.5" width="13" height="11" fill={paper} stroke={ink} /><path d="M4 6h8M4 8.5h8M4 11h5" stroke={blue} /></>,
  junction: <><path d="M1.5 8h13M8 8v6" stroke="#1d3fa8" stroke-width="1.6" /><circle cx="8" cy="8" r="2.4" fill="#1d3fa8" stroke="none" /></>,
  /* PCB wiring */
  route: <><path d="M1.5 13.5l4-4h4l4.5-4.5" stroke="#d63a2b" stroke-width="2.4" fill="none" /><circle cx="14" cy="5" r="1.5" fill="#d63a2b" stroke="none" /></>,
  track: <path d="M1.5 13.5l5-5h8" stroke="#d63a2b" stroke-width="2.4" fill="none" />,
  via: <><circle cx="8" cy="8" r="5.5" fill="#c9cfcc" stroke="#6b7672" /><circle cx="8" cy="8" r="2" fill="#2b3330" stroke="none" /></>,
  pad: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="#c9cfcc" stroke="#6b7672" /><circle cx="8" cy="8" r="2.4" fill="#2b3330" stroke="none" /></>,
  fill: <rect x="2" y="4" width="12" height="8" fill="#d63a2b" stroke="#8e2c20" />,
  polygon: <><path d="M2 4.5l6-3 6.5 3.5-1 8.5-9.5 1z" fill="#f2a59c" stroke="#8e2c20" /><path d="M4 7l7 6M6 4l7 5M3 10l4 3.5" stroke="#d63a2b" stroke-width="0.9" /></>,
  arc: <path d="M2.5 13.5a10 10 0 0 1 11-11" stroke="#d63a2b" stroke-width="2" fill="none" />,
  string: <><text x="1.5" y="12.5" font-size="11" font-family="Arial" font-weight="700" fill="#c9a227" stroke="none">A</text><path d="M10 13h4" stroke="#c9a227" stroke-width="1.6" /></>,
  component: <><rect x="4" y="3.5" width="8" height="9" fill="#c9cfcc" stroke="#6b7672" /><path d="M5.5 1v2.5M8 1v2.5M10.5 1v2.5M5.5 12.5V15M8 12.5V15M10.5 12.5V15" stroke="#6b7672" /></>,
  select: <path d="M3 1.5l9.5 6-4.4.9-1.6 4.1z" fill={paper} stroke={ink} />,
  /* AD17 toolbar set (Konium's own drawings) */
  /* New: a blank page with its plus as a badge clear of the page's lines (the bare plus ran into the page's edge) */
  newDoc: <><path d="M2.5 1.5h6.5l3 3v10h-9.5z" fill={paper} stroke={ink} /><path d="M9 1.5v3h3" stroke={ink} /><circle cx="11.6" cy="11.6" r="3.6" fill={green} stroke="none" /><path d="M11.6 9.6v4M9.6 11.6h4" stroke={paper} stroke-width="1.4" /></>,
  print: <><rect x="4" y="1.5" width="8" height="4" fill={paper} stroke={ink} /><rect x="1.5" y="5.5" width="13" height="6" rx="1" fill="#b9c4cc" stroke={ink} /><rect x="4" y="9.5" width="8" height="5" fill={paper} stroke={ink} /><path d="M5.5 11.5h5M5.5 13h4" stroke={blue} /></>,
  printPreview: <><path d="M2 1.5h7l2.5 2.5v6" fill={paper} stroke={ink} /><path d="M2 1.5v12h6" fill="none" stroke={ink} /><circle cx="10.5" cy="10.5" r="2.8" fill={paper} stroke={ink} /><path d="M12.5 12.5l2.3 2.3" stroke={ink} stroke-width="1.8" /></>,
  zoomArea: <><rect x="1.5" y="1.5" width="9" height="7" fill="none" stroke={ink} stroke-dasharray="2 1.2" /><circle cx="9.5" cy="9.5" r="3" fill={paper} stroke={ink} /><path d="M11.7 11.7l2.8 2.8" stroke={ink} stroke-width="1.8" /></>,
  zoomFiltered: <><path d="M1.5 2h9l-3.5 4v4l-2 1.5V6z" fill="#f2d98b" stroke="#8a6a2c" /><circle cx="11" cy="10.5" r="2.6" fill={paper} stroke={ink} /><path d="M12.9 12.4l2 2" stroke={ink} stroke-width="1.8" /></>,
  rubberStamp: <><path d="M6 1.5h4v4l2 1v2H4v-2l2-1z" fill="#c78a5a" stroke="#6e4426" /><rect x="2.5" y="9.5" width="11" height="2" fill="#6e4426" stroke="none" /><path d="M3 13.5h10" stroke={red} stroke-width="1.6" /></>,
  moveSel: <><rect x="4.5" y="4.5" width="7" height="7" fill="#d9ecf9" stroke={blue} stroke-dasharray="1.5 1" /><path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke={ink} /><path d="M6.5 2.5L8 1l1.5 1.5M6.5 13.5L8 15l1.5-1.5M2.5 6.5L1 8l1.5 1.5M13.5 6.5L15 8l-1.5 1.5" stroke={ink} fill="none" /></>,
  clearFilter: <><path d="M1.5 2h10l-4 4.5v5l-2 1.5V6.5z" fill="#f2d98b" stroke="#8a6a2c" /><path d="M10 10l4.5 4.5M14.5 10L10 14.5" stroke={red} stroke-width="1.6" /></>,
  hierarchy: <><rect x="5" y="1.5" width="6" height="4" fill="#fff6c8" stroke="#9b7b2c" /><rect x="1.5" y="10.5" width="5" height="4" fill="#fff6c8" stroke="#9b7b2c" /><rect x="9.5" y="10.5" width="5" height="4" fill="#fff6c8" stroke="#9b7b2c" /><path d="M8 5.5v2.5M4 10.5V8h8v2.5" stroke={blue} fill="none" /></>,
  crossProbe: <><path d="M2 14l5.5-5.5" stroke={ink} stroke-width="1.6" /><path d="M7 9l2-6 4 4-6 2z" fill="#e05a4a" stroke="#8e2c20" /><path d="M11.5 1.5l3 3" stroke={gold} stroke-width="1.6" /></>,
  browseLib: <><rect x="1.5" y="2" width="3" height="12" fill="#5aa07a" stroke="#2f6b4b" /><rect x="5" y="2" width="3" height="12" fill="#d6a737" stroke="#8a6a2c" /><path d="M9 3l2.8-.8 3.2 11.5-2.8.8z" fill="#4b80c4" stroke="#2f5b86" /></>,
  harness: <path d="M1.5 12.5h5v-9h8" stroke="#2f6b4b" stroke-width="3.6" fill="none" />,
  busEntry: <><path d="M3 1.5v13" stroke="#1d3fa8" stroke-width="3" /><path d="M3.5 9l4-4h7" stroke="#1d3fa8" stroke-width="1.6" fill="none" /></>,
  sheetSymbol: <><rect x="2.5" y="2.5" width="11" height="11" fill="#d9ecf9" stroke="#8e2c20" /><path d="M5 5.5h4M5 8h3" stroke="#1d3fa8" /></>,
  sheetEntry: <><rect x="1.5" y="2.5" width="8" height="11" fill="#d9ecf9" stroke="#8e2c20" /><path d="M6 6h5l2.5 2-2.5 2H6z" fill="#fff6a0" stroke="#8e2c20" /></>,
  deviceSheet: <><rect x="2.5" y="2.5" width="11" height="11" fill="#d9ecf9" stroke="#8e2c20" /><path d="M2.5 13.5l11-11" stroke="#8e2c20" stroke-width="0.8" /><rect x="5" y="5" width="6" height="6" fill="#fff6c8" stroke="#8e2c20" /></>,
  harnessConnector: <><path d="M2.5 2.5h7l3 5.5-3 5.5h-7z" fill="#e6f1e8" stroke="#2f6b4b" /><path d="M12.5 8h3" stroke="#2f6b4b" stroke-width="2.6" /></>,
  harnessEntry: <><rect x="1.5" y="2.5" width="8" height="11" fill="#e6f1e8" stroke="#2f6b4b" /><path d="M5 8h9" stroke="#2f6b4b" stroke-width="1.6" /><path d="M5 6.5L3.5 8 5 9.5" stroke="#2f6b4b" fill="none" /></>,
  multiRoute: <><path d="M1.5 6l4-4h9M1.5 10l5-5h8M1.5 14l6-6h7" stroke="#d63a2b" stroke-width="1.6" fill="none" /></>,
  diffPair: <><path d="M1.5 6.5h5l3 3h5" stroke="#d63a2b" stroke-width="1.6" fill="none" /><path d="M1.5 9.5h5l3 3h5" stroke="#4b80c4" stroke-width="1.6" fill="none" /></>,
  /* Place › Wire Link: an insulated wire arching from one pad to another over the board */
  wireLink: <><path d="M1 13.5h4M11 13.5h4" stroke="#d63a2b" stroke-width="1.6" /><path d="M3 12.5V8.5a5 4.5 0 0 1 10 0v4" stroke="#8e1f1a" stroke-width="1.8" fill="none" /><circle cx="3" cy="13" r="1.5" fill="#c9cfcc" stroke="#6b7672" /><circle cx="13" cy="13" r="1.5" fill="#c9cfcc" stroke="#6b7672" /></>,
  solidRegion: <path d="M2 3.5l7-2 5.5 4-2 8.5-9 1z" fill="#d63a2b" stroke="#8e2c20" />,
  drawTools: <><path d="M2 13l8.5-8.5 2 2L4 15H2z" fill="#f2d98b" stroke="#8a6a2c" /><path d="M10.5 4.5l2-2 2 2-2 2" fill="#e05a4a" stroke="#8e2c20" /></>,
  alignTools: <><path d="M2 1.5v13" stroke={ink} stroke-width="1.6" /><rect x="3.5" y="3" width="9" height="3.5" fill="#9fd0a6" stroke={green} /><rect x="3.5" y="9.5" width="6" height="3.5" fill="#9fd0a6" stroke={green} /></>,
  powerTools: <><path d="M5 14.5V8" stroke="#1d3fa8" stroke-width="1.6" /><path d="M1.5 8h7" stroke="#1d3fa8" stroke-width="2" /><path d="M11.5 1.5v5M8.5 6.5h6M9.5 9h4M10.5 11.5h2" stroke="#1d3fa8" stroke-width="1.4" /></>,
  gridTool: <><path d="M1.5 1.5h13v13h-13z" fill={paper} stroke={ink} /><path d="M5.8 1.5v13M10.2 1.5v13M1.5 5.8h13M1.5 10.2h13" stroke={blue} stroke-width="0.8" /></>,
  line: <path d="M2 14L14 2" stroke="#c9a227" stroke-width="1.8" />,
  coordinate: <><path d="M8 1.5v13M1.5 8h13" stroke={ink} /><text x="9" y="6.5" font-size="5" font-family="Arial" fill={red} stroke="none">xy</text></>,
  dimension: <><path d="M1.5 3v10M14.5 3v10" stroke={ink} /><path d="M1.5 8h13" stroke={red} /><path d="M3.5 6.5L1.5 8l2 1.5M12.5 6.5l2 1.5-2 1.5" stroke={red} fill="none" /></>,
  origin: <><circle cx="8" cy="8" r="5" fill="none" stroke={red} /><path d="M8 1.5v13M1.5 8h13" stroke={red} /><path d="M8 3a5 5 0 0 1 5 5H8z" fill={red} stroke="none" /></>,
  arcCentre: <><path d="M3 13a10 10 0 0 1 10-10" stroke="#d63a2b" stroke-width="1.8" fill="none" /><circle cx="13" cy="13" r="1.4" fill={ink} stroke="none" /></>,
  arcAny: <><path d="M2.5 12a7 7 0 0 1 11-4" stroke="#d63a2b" stroke-width="1.8" fill="none" /><circle cx="2.5" cy="12" r="1.3" fill={ink} stroke="none" /><circle cx="13.5" cy="8" r="1.3" fill={ink} stroke="none" /></>,
  circle: <circle cx="8" cy="8" r="5.5" stroke="#d63a2b" stroke-width="1.8" fill="none" />,
  pasteArray: <><rect x="1.5" y="1.5" width="4" height="4" fill="#d9ecf9" stroke={blue} /><rect x="10.5" y="1.5" width="4" height="4" fill="#d9ecf9" stroke={blue} /><rect x="1.5" y="10.5" width="4" height="4" fill="#d9ecf9" stroke={blue} /><rect x="10.5" y="10.5" width="4" height="4" fill="#d9ecf9" stroke={blue} /></>,
  room: <rect x="1.5" y="2.5" width="13" height="11" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" />,
  /* Board Planning Mode (rigid-flex) */
  splitLine: <><rect x="1.5" y="3.5" width="13" height="9" fill="#9fc48a" stroke="#4d7a3a" /><path d="M8 3.5v9" stroke="#2f62e0" stroke-width="1.6" /><circle cx="8" cy="3.5" r="1.4" fill="#ffffff" stroke="#2f62e0" /><circle cx="8" cy="12.5" r="1.4" fill="#ffffff" stroke="#2f62e0" /></>,
  deleteSplitLine: <><rect x="1.5" y="3.5" width="13" height="9" fill="#9fc48a" stroke="#4d7a3a" /><path d="M6 3.5v9" stroke="#2f62e0" stroke-width="1.6" /><path d="M9.5 6.5l4 4M13.5 6.5l-4 4" stroke={red} stroke-width="1.6" /></>,
  bendingLine: <><rect x="1.5" y="3.5" width="13" height="9" fill="#e8cf7a" stroke="#9a7a24" /><rect x="6" y="3.5" width="4" height="9" fill="#ff9a2e" fill-opacity="0.55" stroke="none" /><path d="M8 3.5v9" stroke="#c45f00" stroke-width="1.4" /></>,
  storageManager: <><rect x="1.5" y="6.5" width="13" height="8" fill="#e9d7a6" stroke="#8a6d2a" /><path d="M2.5 6.5l1.5-4h8l1.5 4" fill="#f4e9c8" stroke="#8a6d2a" /><circle cx="11.5" cy="10.5" r="3" fill="#ffffff" stroke="#2f62e0" /><path d="M11.5 9v1.6l1.2.8" stroke="#2f62e0" fill="none" /></>,
  /* Advanced Rigid-Flex and coverlay */
  boardRegion: <><path d="M2.5 4.5l9-2 2.5 7-6 4-5.5-3z" fill="#9fc48a" stroke="#2f62e0" stroke-width="1.2" /><circle cx="2.5" cy="4.5" r="1.2" fill="#ffffff" stroke="#2f62e0" /><circle cx="14" cy="9.5" r="1.2" fill="#ffffff" stroke="#2f62e0" /></>,
  sliceRegion: <><path d="M2.5 4.5l9-2 2.5 7-6 4-5.5-3z" fill="#9fc48a" stroke="#4d7a3a" /><path d="M1 12L15 3" stroke="#2f62e0" stroke-width="1.6" stroke-dasharray="2.5 1.2" /></>,
  coverlayPolygon: <><rect x="1.5" y="5.5" width="13" height="6" fill="#e8cf7a" stroke="#9a7a24" /><path d="M3 4l9-1.5 1.5 9-10.5 1z" fill="#d08a2a" fill-opacity="0.6" stroke="#a5620f" /></>,
  coverlayCutout: <><rect x="1.5" y="5.5" width="13" height="6" fill="#e8cf7a" stroke="#9a7a24" /><path d="M3 3h10v10H3z M6 6v4h4V6z" fill="#d08a2a" fill-opacity="0.6" fill-rule="evenodd" stroke="#a5620f" /></>,
  foldUnfold: <><path d="M1.5 13.5h7" stroke="#4d7a3a" stroke-width="2.4" /><path d="M8.5 13.5a4 4 0 0 0 4-4V2.5" stroke="#c49a2a" stroke-width="2.4" fill="none" /><path d="M5 6.5l-2-2 2-2" stroke={blue} fill="none" /><path d="M3 4.5h4" stroke={blue} /></>,
  alignLeft: <><path d="M2 1.5v13" stroke={ink} stroke-width="1.6" /><rect x="3.5" y="3" width="10" height="3.5" fill="#9fd0a6" stroke={green} /><rect x="3.5" y="9.5" width="6" height="3.5" fill="#9fd0a6" stroke={green} /></>,
  alignRight: <><path d="M14 1.5v13" stroke={ink} stroke-width="1.6" /><rect x="2.5" y="3" width="10" height="3.5" fill="#9fd0a6" stroke={green} /><rect x="6.5" y="9.5" width="6" height="3.5" fill="#9fd0a6" stroke={green} /></>,
  alignTop: <><path d="M1.5 2h13" stroke={ink} stroke-width="1.6" /><rect x="3" y="3.5" width="3.5" height="10" fill="#9fd0a6" stroke={green} /><rect x="9.5" y="3.5" width="3.5" height="6" fill="#9fd0a6" stroke={green} /></>,
  alignBottom: <><path d="M1.5 14h13" stroke={ink} stroke-width="1.6" /><rect x="3" y="2.5" width="3.5" height="10" fill="#9fd0a6" stroke={green} /><rect x="9.5" y="6.5" width="3.5" height="6" fill="#9fd0a6" stroke={green} /></>,
  alignHCentre: <><path d="M8 1v14" stroke={ink} stroke-dasharray="2 1" /><rect x="3" y="3" width="10" height="3.5" fill="#9fd0a6" stroke={green} /><rect x="5" y="9.5" width="6" height="3.5" fill="#9fd0a6" stroke={green} /></>,
  alignVCentre: <><path d="M1 8h14" stroke={ink} stroke-dasharray="2 1" /><rect x="3" y="3" width="3.5" height="10" fill="#9fd0a6" stroke={green} /><rect x="9.5" y="5" width="3.5" height="6" fill="#9fd0a6" stroke={green} /></>,
  distributeH: <><rect x="1.5" y="5" width="3" height="6" fill="#9fd0a6" stroke={green} /><rect x="6.5" y="5" width="3" height="6" fill="#9fd0a6" stroke={green} /><rect x="11.5" y="5" width="3" height="6" fill="#9fd0a6" stroke={green} /><path d="M1.5 13.5h13" stroke={ink} /></>,
  distributeV: <><rect x="5" y="1.5" width="6" height="3" fill="#9fd0a6" stroke={green} /><rect x="5" y="6.5" width="6" height="3" fill="#9fd0a6" stroke={green} /><rect x="5" y="11.5" width="6" height="3" fill="#9fd0a6" stroke={green} /><path d="M13.5 1.5v13" stroke={ink} /></>,
  toGrid: <><path d="M1.5 4.5h13M1.5 11.5h13M4.5 1.5v13M11.5 1.5v13" stroke={blue} stroke-width="0.8" /><rect x="4.5" y="4.5" width="7" height="7" fill="#9fd0a6" stroke={green} /></>,
  annotateQuiet: <><rect x="2" y="3" width="8" height="10" fill={paper} stroke={ink} /><path d="M11 3h3M11 6h3M11 9h3" stroke={blue} /><path d="M3.5 11.5l2-6 2 6M4.2 9.5h2.6" stroke={red} fill="none" /></>,
  netColour: <><path d="M3 13l7.5-7.5 2 2L5 15H3z" fill="#e05a4a" stroke="#8e2c20" /><path d="M10.5 5.5l2-2 2 2-2 2" fill="#b9c4cc" stroke={ink} /><path d="M1.5 3h5" stroke="#3b78b5" stroke-width="1.8" /></>,
  bezier: <><path d="M2 13C4 2 12 14 14 3" stroke="#1d3fa8" stroke-width="1.5" fill="none" /><circle cx="2" cy="13" r="1.2" fill={ink} stroke="none" /><circle cx="14" cy="3" r="1.2" fill={ink} stroke="none" /></>,
  rect: <rect x="2" y="3.5" width="12" height="9" fill="#d9ecf9" stroke="#1d3fa8" />,
  roundRect: <rect x="2" y="3.5" width="12" height="9" rx="3" fill="#d9ecf9" stroke="#1d3fa8" />,
  ellipse: <ellipse cx="8" cy="8" rx="6" ry="4.5" fill="#d9ecf9" stroke="#1d3fa8" />,
  pie: <><circle cx="8" cy="8" r="6" fill="#d9ecf9" stroke="#1d3fa8" /><path d="M8 8V2a6 6 0 0 1 6 6z" fill="#1d3fa8" stroke="none" /></>,
  image: <><rect x="1.5" y="2.5" width="13" height="11" fill={paper} stroke={ink} /><path d="M2.5 12.5l4-5 3 3.5 2-2 2 3.5z" fill="#5aa07a" stroke="none" /><circle cx="11" cy="5.5" r="1.4" fill={gold} stroke="none" /></>,
  selFirst: <><path d="M3 3v10" stroke={ink} stroke-width="1.6" /><path d="M13 3L5 8l8 5z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  selPrev: <path d="M12 3L4 8l8 5z" fill="#3f9a6a" stroke="#2f6b4b" />,
  selNext: <path d="M4 3l8 5-8 5z" fill="#3f9a6a" stroke="#2f6b4b" />,
  selLast: <><path d="M13 3v10" stroke={ink} stroke-width="1.6" /><path d="M3 3l8 5-8 5z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  /* Power port styles (as each port draws) */
  gndBus: <><path d="M8 1.5v6" stroke="#1d3fa8" stroke-width="3" /><path d="M2.5 7.5h11M4.5 10.5h7M6.5 13.5h3" stroke="#1d3fa8" stroke-width="1.6" /></>,
  vccBus: <><path d="M8 14.5v-9" stroke="#1d3fa8" stroke-width="3" /><path d="M3 5.5h10" stroke="#1d3fa8" stroke-width="2.2" /><text x="4" y="4" font-size="4.5" font-family="Arial" fill="#1d3fa8" stroke="none">VCC</text></>,
  pwrBar: <><path d="M8 14.5v-8" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3 6.5h10" stroke="#1d3fa8" stroke-width="2.2" /></>,
  pwrArrow: <><path d="M8 14.5V6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M4 7l4-5 4 5z" fill="#1d3fa8" stroke="#1d3fa8" /></>,
  pwrWave: <><path d="M8 14.5V7" stroke="#1d3fa8" stroke-width="1.6" /><path d="M2 5c1.5-3 3-3 4.5 0s3 3 4.5 0 2.5-2 3.5-1" stroke="#1d3fa8" stroke-width="1.5" fill="none" /></>,
  pwrCircle: <><path d="M8 14.5V8" stroke="#1d3fa8" stroke-width="1.6" /><circle cx="8" cy="5" r="3" fill={paper} stroke="#1d3fa8" stroke-width="1.5" /></>,
  sigGnd: <><path d="M8 1.5v6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M2.5 7.5h11L8 13.5z" fill={paper} stroke="#1d3fa8" stroke-width="1.4" /></>,
  earth: <><path d="M8 1.5v6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M2.5 7.5h11" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3.5 7.5l-2 4M7 7.5l-2 4M10.5 7.5l-2 4M14 7.5l-2 4" stroke="#1d3fa8" stroke-width="1.3" /></>,
  pwr12: <><path d="M8 14.5v-6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3 8.5h10" stroke="#1d3fa8" stroke-width="2.2" /><text x="2.5" y="6.5" font-size="6" font-family="Arial" font-weight="700" fill="#1d3fa8" stroke="none">+12</text></>,
  pwr5: <><path d="M8 14.5v-6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3 8.5h10" stroke="#1d3fa8" stroke-width="2.2" /><text x="4.5" y="6.5" font-size="6" font-family="Arial" font-weight="700" fill="#1d3fa8" stroke="none">+5</text></>,
  pwrMinus5: <><path d="M8 14.5v-6" stroke="#1d3fa8" stroke-width="1.6" /><path d="M3 8.5h10" stroke="#1d3fa8" stroke-width="2.2" /><text x="5" y="6.5" font-size="6" font-family="Arial" font-weight="700" fill="#1d3fa8" stroke="none">-5</text></>,
  /* Schematic drawing (blue, as drawn on a sheet) */
  schLine: <path d="M2 14L14 2" stroke="#1d3fa8" stroke-width="1.6" />,
  schPolygon: <path d="M2 5l6-3.5 6.5 4-1.5 8.5-9.5.5z" fill="#d9ecf9" stroke="#1d3fa8" />,
  schArc: <><path d="M2.5 11.5a6.5 4.5 0 0 1 11-3" stroke="#1d3fa8" stroke-width="1.6" fill="none" /><circle cx="2.5" cy="11.5" r="1.2" fill={ink} stroke="none" /><circle cx="13.5" cy="8.5" r="1.2" fill={ink} stroke="none" /></>,
  smartPaste: <><rect x="2.5" y="2.5" width="9" height="12" fill="#e5c58a" stroke="#8a6a2c" /><rect x="5" y="1.5" width="4" height="2.5" fill={paper} stroke="#8a6a2c" /><path d="M11.5 6.5l1 2 2 .3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1L8.5 8.8l2-.3z" fill={gold} stroke="#8a6a2c" stroke-width="0.6" /></>,
  /* Net colours */
  netColourCustom: <><rect x="1.5" y="1.5" width="6" height="6" fill="#e05a4a" stroke={ink} /><rect x="8.5" y="1.5" width="6" height="6" fill="#5aa07a" stroke={ink} /><rect x="1.5" y="8.5" width="6" height="6" fill="#4b80c4" stroke={ink} /><rect x="8.5" y="8.5" width="6" height="6" fill={gold} stroke={ink} /></>,
  netColourClear: <><path d="M1.5 8h13" stroke="#e05a4a" stroke-width="2.2" /><path d="M9 9.5l5 5M14 9.5l-5 5" stroke={ink} stroke-width="1.4" /></>,
  netColourClearAll: <><path d="M1.5 4h13" stroke="#e05a4a" stroke-width="2" /><path d="M1.5 8h13" stroke="#5aa07a" stroke-width="2" /><path d="M9 9.5l5 5M14 9.5l-5 5" stroke={ink} stroke-width="1.4" /></>,
  /* Grids and snapping */
  electricalGrid: <><path d="M1.5 1.5h13v13h-13z" fill={paper} stroke={ink} /><path d="M5.8 1.5v13M10.2 1.5v13M1.5 5.8h13M1.5 10.2h13" stroke={blue} stroke-width="0.8" /><circle cx="10.2" cy="5.8" r="2.2" fill="none" stroke={red} stroke-width="1.4" /><path d="M8 8l2.2-2.2" stroke={red} /></>,
  gridSet: <><path d="M1.5 1.5h13v13h-13z" fill={paper} stroke={ink} /><path d="M5.8 1.5v13M10.2 1.5v13M1.5 5.8h13M1.5 10.2h13" stroke={blue} stroke-width="0.8" /><path d="M9 14.5l5.5-5.5 1 1L10 15.5H9z" fill="#f2d98b" stroke="#8a6a2c" /></>,
  gridKind: <><path d="M1.5 1.5h6v6h-6z" fill={paper} stroke={ink} /><path d="M3.5 1.5v6M5.5 1.5v6M1.5 3.5h6M1.5 5.5h6" stroke={blue} stroke-width="0.7" /><g fill={blue} stroke="none"><circle cx="10" cy="10" r=".8" /><circle cx="12.5" cy="10" r=".8" /><circle cx="10" cy="12.5" r=".8" /><circle cx="12.5" cy="12.5" r=".8" /><circle cx="15" cy="10" r=".8" /><circle cx="15" cy="12.5" r=".8" /><circle cx="10" cy="15" r=".8" /><circle cx="12.5" cy="15" r=".8" /></g><path d="M9 3h4l-1.5-1.5M13 3l-1.5 1.5" stroke={ink} fill="none" /></>,
  hotspot: <><rect x="2.5" y="5" width="7" height="6" fill="#c9cfcc" stroke="#6b7672" /><circle cx="9.5" cy="5" r="3" fill="none" stroke={red} stroke-width="1.4" /><path d="M9.5 1v8M5.5 5h8" stroke={red} stroke-width="0.9" /></>,
  /* Alignment and spacing */
  spaceIncH: <><rect x="5.5" y="5" width="2" height="6" fill="#9fd0a6" stroke={green} /><rect x="8.5" y="5" width="2" height="6" fill="#9fd0a6" stroke={green} /><path d="M1 8h3M12 8h3M2.5 6.5L1 8l1.5 1.5M13.5 6.5L15 8l-1.5 1.5" stroke={ink} fill="none" /></>,
  spaceDecH: <><rect x="1.5" y="5" width="2" height="6" fill="#9fd0a6" stroke={green} /><rect x="12.5" y="5" width="2" height="6" fill="#9fd0a6" stroke={green} /><path d="M4.5 8h2.5M9 8h2.5M5.5 6.5L7 8 5.5 9.5M10.5 6.5L9 8l1.5 1.5" stroke={ink} fill="none" /></>,
  spaceIncV: <><rect x="5" y="5.5" width="6" height="2" fill="#9fd0a6" stroke={green} /><rect x="5" y="8.5" width="6" height="2" fill="#9fd0a6" stroke={green} /><path d="M8 1v3M8 12v3M6.5 2.5L8 1l1.5 1.5M6.5 13.5L8 15l1.5-1.5" stroke={ink} fill="none" /></>,
  spaceDecV: <><rect x="5" y="1.5" width="6" height="2" fill="#9fd0a6" stroke={green} /><rect x="5" y="12.5" width="6" height="2" fill="#9fd0a6" stroke={green} /><path d="M8 4.5V7M8 9v2.5M6.5 5.5L8 7l1.5-1.5M6.5 10.5L8 9l1.5 1.5" stroke={ink} fill="none" /></>,
  arrangeRect: <><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke={ink} stroke-dasharray="2 1.5" /><rect x="3.5" y="3.5" width="4" height="4" fill="#c9cfcc" stroke="#6b7672" /><rect x="8.5" y="3.5" width="4" height="4" fill="#c9cfcc" stroke="#6b7672" /><rect x="3.5" y="8.5" width="4" height="4" fill="#c9cfcc" stroke="#6b7672" /></>,
  unionMake: <><rect x="1.5" y="1.5" width="7" height="7" fill="#c9cfcc" stroke="#6b7672" /><rect x="7.5" y="7.5" width="7" height="7" fill="#c9cfcc" stroke="#6b7672" /><path d="M4 12h3M5.5 10.5v3" stroke={green} stroke-width="1.6" /></>,
  unionBreak: <><rect x="1.5" y="1.5" width="6" height="6" fill="#c9cfcc" stroke="#6b7672" /><rect x="8.5" y="8.5" width="6" height="6" fill="#c9cfcc" stroke="#6b7672" /><path d="M3 12h4" stroke={red} stroke-width="1.6" /></>,
  /* Find Selection, by group */
  grpFirst: <><path d="M2.5 3v10" stroke={ink} stroke-width="1.6" /><path d="M9 3L4 8l5 5zM14 3L9 8l5 5z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  grpPrev: <path d="M8 3L3 8l5 5zM13.5 3l-5 5 5 5z" fill="#3f9a6a" stroke="#2f6b4b" />,
  grpNext: <path d="M2.5 3l5 5-5 5zM8 3l5 5-5 5z" fill="#3f9a6a" stroke="#2f6b4b" />,
  grpLast: <><path d="M13.5 3v10" stroke={ink} stroke-width="1.6" /><path d="M2 3l5 5-5 5zM7 3l5 5-5 5z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  /* Dimensions */
  dimAngular: <><path d="M2 14L14 14M2 14L11 4" stroke={ink} /><path d="M9 14a7 7 0 0 0-1.8-4.8" stroke={red} fill="none" /><path d="M6.4 8.6l.8.6.1-1" stroke={red} fill="none" /></>,
  dimRadial: <><circle cx="7" cy="9" r="5.5" fill="none" stroke={ink} /><path d="M7 9l4-4" stroke={red} /><path d="M9.2 4.6L11 5l-.4 1.8" stroke={red} fill="none" /><text x="10.5" y="4" font-size="4.5" font-family="Arial" fill={red} stroke="none">R</text></>,
  dimLeader: <><path d="M2 14l6-6h6.5" stroke={red} fill="none" /><path d="M2 14l1-3 2 2z" fill={red} stroke="none" /><text x="8.5" y="6.5" font-size="5" font-family="Arial" fill={ink} stroke="none">abc</text></>,
  dimDatum: <><path d="M2.5 2v12" stroke={ink} /><path d="M2.5 5h4M2.5 9h8M2.5 13h11" stroke={red} /><path d="M5 3.8l1.5 1.2L5 6.2M9 7.8l1.5 1.2L9 10.2M12 11.8l1.5 1.2-1.5 1.2" stroke={red} fill="none" /></>,
  dimBaseline: <><path d="M2.5 2v12M8 8v6M14 4v10" stroke={ink} /><path d="M2.5 11h5.5M2.5 6h11.5" stroke={red} /></>,
  dimCenter: <><circle cx="8" cy="8" r="5.5" fill="none" stroke={ink} /><path d="M8 1v14M1 8h14" stroke={red} stroke-dasharray="2.5 1" /></>,
  dimLinDia: <><circle cx="8" cy="9" r="4.5" fill="none" stroke={ink} /><path d="M3.5 2v5M12.5 2v5" stroke={ink} /><path d="M3.5 3.5h9" stroke={red} /><path d="M5 2.5l-1.5 1 1.5 1M11 2.5l1.5 1-1.5 1" stroke={red} fill="none" /></>,
  dimRadDia: <><circle cx="8" cy="8" r="5.5" fill="none" stroke={ink} /><path d="M4.1 11.9l7.8-7.8" stroke={red} /><path d="M4.4 9.9l-.3 2 2-.3M11.6 6.1l.3-2-2 .3" stroke={red} fill="none" /></>,
  /* Rooms */
  roomPoly: <path d="M2 4.5l5-3 7.5 3-1 9-11 1z" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" />,
  roomCopy: <><rect x="1.5" y="1.5" width="8" height="7" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><rect x="6.5" y="7.5" width="8" height="7" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" stroke-dasharray="2 1" /></>,
  roomOrtho: <><path d="M1.5 1.5h9v5h4v8h-13z" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><rect x="3.5" y="3.5" width="3" height="3" fill="#c9cfcc" stroke="#6b7672" /><rect x="8" y="9" width="4" height="3" fill="#c9cfcc" stroke="#6b7672" /></>,
  roomNonOrtho: <><path d="M1.5 4l6-2.5 7 4-1 9-11-1z" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><rect x="4" y="5" width="3" height="3" fill="#c9cfcc" stroke="#6b7672" /><rect x="8" y="9" width="4" height="3" fill="#c9cfcc" stroke="#6b7672" /></>,
  roomBounding: <><rect x="1.5" y="1.5" width="13" height="13" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><rect x="3.5" y="3.5" width="3" height="3" fill="#c9cfcc" stroke="#6b7672" /><rect x="8" y="9" width="4" height="3" fill="#c9cfcc" stroke="#6b7672" /></>,
  roomSlice: <><rect x="1.5" y="2.5" width="13" height="11" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" /><path d="M10 1v14" stroke={red} stroke-width="1.6" stroke-dasharray="2 1.2" /></>,
  /* Library editors */
  newComponent: <><rect x="3.5" y="3.5" width="7" height="10" fill="#fff6c8" stroke="#8e2c20" /><path d="M1 6h2.5M1 10h2.5M10.5 6H13" stroke={ink} /><path d="M13 9v6M10 12h6" stroke={green} stroke-width="1.6" /></>,
  newPart: <><rect x="1.5" y="1.5" width="6" height="8" fill="#fff6c8" stroke="#8e2c20" /><rect x="5.5" y="4.5" width="6" height="8" fill="#fff6c8" stroke="#8e2c20" /><path d="M13 9v6M10 12h6" stroke={green} stroke-width="1.6" /></>,
  pinTool: <><path d="M1.5 8h9" stroke={ink} stroke-width="1.6" /><path d="M10.5 3v10" stroke="#8e2c20" stroke-width="1.4" /><text x="11.5" y="7" font-size="5" font-family="Arial" fill="#8e2c20" stroke="none">1</text></>,
  modelManager: <><rect x="1.5" y="3" width="6" height="9" fill="#fff6c8" stroke="#8e2c20" /><path d="M7.5 7.5h2" stroke={ink} /><rect x="9.5" y="4.5" width="5" height="6" fill="#c9cfcc" stroke="#6b7672" /><path d="M10.5 3.5v1M13.5 3.5v1M10.5 10.5v1M13.5 10.5v1" stroke="#6b7672" /></>,
  mode: <><rect x="1.5" y="2.5" width="6" height="9" fill="#fff6c8" stroke="#8e2c20" /><rect x="8.5" y="4.5" width="6" height="9" fill="#d9ecf9" stroke="#1d3fa8" /></>,
  modeAdd: <><rect x="1.5" y="2.5" width="7" height="10" fill="#fff6c8" stroke="#8e2c20" /><path d="M12.5 7v6M9.5 10h6" stroke={green} stroke-width="1.8" /></>,
  modeRemove: <><rect x="1.5" y="2.5" width="7" height="10" fill="#fff6c8" stroke="#8e2c20" /><path d="M9.5 10h6" stroke={red} stroke-width="1.8" /></>,
  modePrev: <><rect x="6.5" y="2.5" width="8" height="11" fill="#fff6c8" stroke="#8e2c20" /><path d="M6 4L1.5 8 6 12z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  modeNext: <><rect x="1.5" y="2.5" width="8" height="11" fill="#fff6c8" stroke="#8e2c20" /><path d="M10 4l4.5 4-4.5 4z" fill="#3f9a6a" stroke="#2f6b4b" /></>,
  ieee: <><rect x="3.5" y="2.5" width="9" height="11" fill={paper} stroke="#1d3fa8" /><text x="5" y="11" font-size="7.5" font-family="Arial" font-weight="700" fill="#1d3fa8" stroke="none">&amp;</text></>,
  /* Home, getting and supporting Konium */
  home: <><path d="M1.5 8L8 2l6.5 6" fill="none" stroke="#8e2c20" stroke-width="1.6" stroke-linejoin="round" /><path d="M3.5 7.5v6.5h9V7.5L8 3.4z" fill="#d9ecf9" stroke="#1d3fa8" /><rect x="6.8" y="10" width="2.4" height="4" fill="#1d3fa8" stroke="none" /></>,
  /* A bug: Report a Bug */
  bug: <><path d="M5.2 4.4a2.8 2.4 0 0 1 5.6 0z" fill="#3b3b3b" /><ellipse cx="8" cy="9.4" rx="3.7" ry="4.6" fill="#d8433b" stroke="#7a1f1a" /><path d="M8 5v8.8" stroke="#7a1f1a" stroke-width=".8" /><circle cx="6.4" cy="8" r=".75" fill="#3b3b3b" /><circle cx="9.7" cy="10.2" r=".75" fill="#3b3b3b" /><circle cx="6.5" cy="11.6" r=".6" fill="#3b3b3b" /><path d="M4.3 7.5L2 6.3M4.1 9.8H1.6M4.5 12.1L2.4 13.6M11.7 7.5L14 6.3M11.9 9.8h2.5M11.5 12.1l2.1 1.5M6.6 2.2L6 1M9.4 2.2L10 1" stroke="#3b3b3b" stroke-width=".9" stroke-linecap="round" /></>,
  /* Tools › Scripts: a script's page with braces */
  scripts: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M10 1.5v3h3" stroke={ink} /><path d="M6.6 6.5c-1 0-1 .5-1 1.4s-.5 1.1-1 1.1c.5 0 1 .2 1 1.1s0 1.4 1 1.4M9.4 6.5c1 0 1 .5 1 1.4s.5 1.1 1 1.1c-.5 0-1 .2-1 1.1s0 1.4-1 1.4" stroke={blue} stroke-width="1.1" /></>,
  /* Help › User Guide: an open book with a question mark */
  userGuide: <><path d="M1.5 3.2c2.2-.9 4.4-.8 6.5.6v10.4c-2.1-1.4-4.3-1.5-6.5-.6z" fill={paper} stroke={ink} /><path d="M14.5 3.2c-2.2-.9-4.4-.8-6.5.6v10.4c2.1-1.4 4.3-1.5 6.5-.6z" fill={paper} stroke={ink} /><path d="M10.2 6.4a1.3 1.3 0 1 1 2 1.1c-.5.3-.8.6-.8 1.2" stroke={blue} stroke-width="1.1" fill="none" /><circle cx="11.4" cy="10.4" r=".6" fill={blue} /></>,
  /* Help › Scripting Reference: a blue book with braces on its cover */
  scriptRef: <><path d="M3 2h9.5v12H4.2A1.2 1.2 0 0 1 3 12.8z" fill="#3b6fb5" stroke="#1d3f78" /><path d="M3 12.8A1.2 1.2 0 0 1 4.2 11.6h8.3" stroke="#d9ecf9" /><path d="M6.8 4.3c-.9 0-.9.4-.9 1.2s-.4 1-.9 1c.5 0 .9.2.9 1s0 1.2.9 1.2M9.2 4.3c.9 0 .9.4.9 1.2s.4 1 .9 1c-.5 0-.9.2-.9 1s0 1.2-.9 1.2" stroke="#ffffff" stroke-width="1" /></>,
  /* What's New: a star burst with a line of news */
  network: <><circle cx="8" cy="8" r="6.3" fill="#dcecf7" stroke="#3f78a8" /><ellipse cx="8" cy="8" rx="2.6" ry="6.3" fill="none" stroke="#3f78a8" stroke-width=".8" /><path d="M1.9 6h12.2M1.9 10h12.2" stroke="#3f78a8" stroke-width=".8" /></>,
  contactAuthor: <><rect x="1.5" y="3.5" width="13" height="9.5" rx="1.2" fill="#f4efe2" stroke="#56677d" /><path d="M2.1 4.3L8 9l5.9-4.7" fill="none" stroke="#56677d" stroke-linejoin="round" /></>,
  whatsNew: <><path d="M8 1l1.6 3.2 3.5-.6-1.9 3 2.3 2.6-3.4.7.1 3.5L8 11.5l-2.2 1.9-.1-3.5L2.3 9.2l2.3-2.6-1.9-3 3.5.6z" fill="#f2c641" stroke="#a5781a" stroke-width=".8" stroke-linejoin="round" /><path d="M6 7.6h4M6.4 9h3.2" stroke="#a5781a" stroke-width=".8" /></>,
  /* A tip jar: give what you like */
  tipJar: <><rect x="4" y="1.5" width="8" height="2.2" rx=".6" fill="#c99a56" stroke="#6b4a1e" /><path d="M6.3 2.6h3.4" stroke="#6b4a1e" stroke-width=".9" /><path d="M4.6 3.7h6.8v.9c1.3.6 2 1.7 2 3.2v4.6a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6V7.8c0-1.5.7-2.6 2-3.2z" fill="#e3f1fa" stroke="#3a6f96" stroke-linejoin="round" /><path d="M8 12.4L5.5 10a1.55 1.55 0 0 1 2.5-1.8A1.55 1.55 0 0 1 10.5 10z" fill="#d8433b" stroke="#a32b25" stroke-width=".6" stroke-linejoin="round" /></>,
  download: <><path d="M8 1.5v8.5" stroke="#2f6b4b" stroke-width="2" /><path d="M4 6.5L8 10.5l4-4" fill="none" stroke="#2f6b4b" stroke-width="2" stroke-linejoin="round" /><path d="M2 11v3h12v-3" fill="none" stroke={ink} stroke-width="1.4" /></>,
  /* A toothed wheel: Preferences */
  gear: <path d="M13.26 6.79L15.23 6.98L15.23 9.02L13.26 9.21L12.58 10.86L13.83 12.39L12.39 13.83L10.86 12.58L9.21 13.26L9.02 15.23L6.98 15.23L6.79 13.26L5.14 12.58L3.61 13.83L2.17 12.39L3.42 10.86L2.74 9.21L0.77 9.02L0.77 6.98L2.74 6.79L3.42 5.14L2.17 3.61L3.61 2.17L5.14 3.42L6.79 2.74L6.98 0.77L9.02 0.77L9.21 2.74L10.86 3.42L12.39 2.17L13.83 3.61L12.58 5.14ZM10.3 8a2.3 2.3 0 1 1-4.6 0a2.3 2.3 0 1 1 4.6 0Z" fill="#9aa6b2" fill-rule="evenodd" stroke={ink} stroke-width=".9" stroke-linejoin="round" />,
  delete: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke={red} stroke-width="2.2" />,
  /* Documents and tree */
  prjpcb: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#5aa07a" stroke="#2f6b4b" /><rect x="4" y="5" width="8" height="6" fill="#c9e7d4" stroke="none" /></>,
  schdoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#fff6c8" stroke="#9b7b2c" /><path d="M5 8h3v3h3" stroke="#1d3fa8" fill="none" /></>,
  pcbdoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#bfe3c8" stroke="#2f6b4b" /><path d="M5 11l3-3h3" stroke="#d63a2b" stroke-width="1.4" fill="none" /></>,
  schlib: <><path d="M3 1.5h7l3 3v10H3z" fill="#fff0b3" stroke="#9b7b2c" /><rect x="5.5" y="6.5" width="4" height="5" fill="none" stroke="#8e2c20" /></>,
  pcblib: <><path d="M3 1.5h7l3 3v10H3z" fill="#a9d8b5" stroke="#2f6b4b" /><rect x="5.5" y="7" width="5" height="4" fill="#c9cfcc" stroke="#6b7672" /></>,
  prjmbd: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#6f8fd0" stroke="#2f4f8b" /><rect x="3.5" y="5" width="4" height="6" fill="#dce6fa" stroke="none" /><rect x="8.5" y="5" width="4" height="6" fill="#dce6fa" stroke="none" /></>,
  mbsDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#eef3fc" stroke="#2f4f8b" /><rect x="4.5" y="6" width="3" height="5" fill="#92cddc" stroke="#2f4f8b" stroke-width="0.6" /><rect x="9" y="6" width="2.5" height="5" fill="#92cddc" stroke="#2f4f8b" stroke-width="0.6" /><path d="M7.5 8.5h1.5" stroke="#2f4f8b" /></>,
  mbaDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#eef3fc" stroke="#2f4f8b" /><path d="M4.5 11l3-2 4 1.5-3 2z" fill="#5aa07a" stroke="#2f6b4b" stroke-width="0.6" /><path d="M8 5v5" stroke="#2f6b4b" stroke-width="1.4" /></>,
  libpkg: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#d9a441" stroke="#8a6214" /><rect x="4" y="5" width="3.5" height="6" fill="#fff0b3" stroke="none" /><rect x="8.5" y="5" width="3.5" height="6" fill="#a9d8b5" stroke="none" /></>,
  dsnwrk: <><rect x="1.5" y="3.5" width="9" height="8" rx="1" fill="#5aa07a" stroke="#2f6b4b" /><rect x="5.5" y="5.5" width="9" height="8" rx="1" fill="#7fb7e6" stroke="#1d5a96" /></>,
  harnessDoc: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M5 7h6M5 9.5h6M5 12h4" stroke="#a83279" stroke-width="1.3" /></>,
  bomdoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#e8f1fb" stroke="#1d5a96" /><path d="M5 6.5h6M5 9h6M5 11.5h6" stroke="#1d5a96" /></>,
  prjhar: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#c86a9e" stroke="#7a2456" /><path d="M3.5 6.5c3 0 3 3 6 3h3M3.5 9.5c3 0 3-3 6-3h3" stroke="#fbe6f1" stroke-width="1.2" /></>,
  wirDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#fdf0f6" stroke="#7a2456" /><rect x="4" y="6" width="2" height="5" fill="#c86a9e" stroke="none" /><rect x="10" y="6" width="2" height="5" fill="#c86a9e" stroke="none" /><path d="M6 7h4M6 10h4" stroke="#7a2456" /></>,
  ldrDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#fdf0f6" stroke="#7a2456" /><path d="M4.5 12l3-3.5h3l1-3" stroke="#a83279" stroke-width="1.8" /><circle cx="7.5" cy="8.5" r="1" fill="#7a2456" stroke="none" /></>,
  /* The diagram editor's toolbar (draw.io's commands) */
  dgFormat: <><rect x="1.5" y="2.5" width="13" height="11" fill={paper} stroke={ink} /><rect x="9.5" y="2.5" width="5" height="11" fill="#cfe0f3" stroke={ink} /><path d="M11 5h2M11 7h2M11 9h2" stroke={blue} /></>,
  dgToFront: <><rect x="1.5" y="1.5" width="8" height="8" fill={paper} stroke={ink} /><rect x="6.5" y="6.5" width="8" height="8" fill="#7fb0e0" stroke={blue} /></>,
  dgToBack: <><rect x="1.5" y="1.5" width="8" height="8" fill="#7fb0e0" stroke={blue} /><rect x="6.5" y="6.5" width="8" height="8" fill={paper} stroke={ink} /></>,
  dgFillColour: <><path d="M3 7l4-4 5 5-4 4z" fill={paper} stroke={ink} /><path d="M12.5 9.5c.8 1.2 1.2 2 1.2 2.5a1.2 1.2 0 0 1-2.4 0c0-.5.4-1.3 1.2-2.5z" fill={blue} stroke="none" /><rect x="1.5" y="13" width="13" height="2.5" fill={gold} stroke="none" /></>,
  dgLineColour: <><path d="M3 11l7.5-7.5 2 2L5 13H3z" fill={paper} stroke={ink} /><rect x="1.5" y="13.5" width="13" height="2" fill={red} stroke="none" /></>,
  dgShadow: <><rect x="4" y="4" width="10" height="10" fill="#9a9a9a" stroke="none" /><rect x="1.5" y="1.5" width="10" height="10" fill={paper} stroke={ink} /></>,
  dgWaypoints: <><path d="M2 13h5V3h7" fill="none" stroke={ink} stroke-width="1.4" /><circle cx="7" cy="13" r="1.5" fill={blue} stroke="none" /><circle cx="7" cy="3" r="1.5" fill={blue} stroke="none" /></>,
  dgInsert: <><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill={paper} stroke={ink} /><path d="M8 4.5v7M4.5 8h7" stroke={green} stroke-width="1.8" /></>,
  dgLayers: <><path d="M8 2l6.5 3.2L8 8.4 1.5 5.2z" fill="#cfe0f3" stroke={blue} /><path d="M1.5 8.2L8 11.4l6.5-3.2" fill="none" stroke={blue} /><path d="M1.5 11L8 14.2 14.5 11" fill="none" stroke={ink} /></>,
  dgSheets: <><rect x="1.5" y="2.5" width="6" height="4.5" fill="#dae8fc" stroke="#6c8ebf" /><rect x="8.5" y="9.5" width="6" height="4.5" fill="#dae8fc" stroke="#6c8ebf" /><path d="M4.5 7v4.5h4" fill="none" stroke={ink} /></>,
  diagramDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#fff8ee" stroke="#b85c00" /><rect x="4.5" y="5" width="3.5" height="2.5" fill="#ffd9a8" stroke="#b85c00" stroke-width="0.7" /><rect x="7.5" y="10.5" width="3.5" height="2.5" fill="#ffd9a8" stroke="#b85c00" stroke-width="0.7" /><path d="M6.2 7.5v4.2h1.3" stroke="#b85c00" stroke-width="0.8" /></>,
  /* The requirements document's toolbar (each its own drawing) */
  reqNew: <><path d="M2 3.5h9M2 6.5h9M2 9.5h6" stroke="#4a5a6a" /><path d="M11.5 9v6M8.5 12h6" stroke="#2f8a4a" stroke-width="1.6" /></>,
  reqChild: <><path d="M2 3.5h9M4.5 6.5v3.5h4" fill="none" stroke="#4a5a6a" /><path d="M11.5 9v6M8.5 12h6" stroke="#2f8a4a" stroke-width="1.6" /></>,
  reqSection: <><path d="M2.5 2.5v8M8.5 2.5v8M2.5 6.5h6" stroke="#2a4a7a" stroke-width="1.5" /><path d="M12 9.5v5.5M9.5 12.25h5" stroke="#2f8a4a" stroke-width="1.5" /></>,
  reqRemove: <><path d="M2 3.5h9M2 6.5h9M2 9.5h5" stroke="#4a5a6a" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" stroke="#c0392b" stroke-width="1.5" /></>,
  rowUp: <><rect x="2" y="9" width="12" height="4" fill="#dde7f2" stroke="#4a5a6a" /><path d="M8 7.5V1.5M5 4.5l3-3 3 3" fill="none" stroke="#2a4a7a" stroke-width="1.4" /></>,
  rowDown: <><rect x="2" y="3" width="12" height="4" fill="#dde7f2" stroke="#4a5a6a" /><path d="M8 8.5v6M5 11.5l3 3 3-3" fill="none" stroke="#2a4a7a" stroke-width="1.4" /></>,
  reqImport: <><rect x="1.5" y="1.5" width="8" height="6" fill="#e3f1e6" stroke="#2f7a4a" /><path d="M1.5 4.5h8M4.5 1.5v6" stroke="#2f7a4a" stroke-width="0.8" /><path d="M2 11.5h7M2 14.5h7" stroke="#4a5a6a" /><path d="M13 2v9M10.5 8.5l2.5 2.5 2.5-2.5" fill="none" stroke="#2a4a7a" stroke-width="1.4" /></>,
  reqExport: <><path d="M2 2.5h7M2 5.5h7" stroke="#4a5a6a" /><rect x="1.5" y="8.5" width="8" height="6" fill="#e3f1e6" stroke="#2f7a4a" /><path d="M1.5 11.5h8M4.5 8.5v6" stroke="#2f7a4a" stroke-width="0.8" /><path d="M13 2v11M10.5 10.5l2.5 2.5 2.5-2.5" fill="none" stroke="#b8662a" stroke-width="1.4" /></>,
  reqReport: <><path d="M2.5 1.5h11v13h-11z" fill="#fff" stroke="#4a5a6a" /><path d="M4.5 7.5V5M6.75 7.5V3.5M9 7.5V4.5" stroke="#2f8a4a" stroke-width="1.6" /><path d="M11.25 7.5V6" stroke="#c0392b" stroke-width="1.6" /><path d="M4.5 10h7M4.5 12.5h5" stroke="#8a96a2" stroke-width="0.9" /></>,
  reqAi: <><path d="M2 2.5h5.5M2 5h4M2 7.5h5.5" stroke="#8a96a2" stroke-width="0.9" /><path d="M2 10.5h6M2 13.5h6" stroke="#4a5a6a" /><path d="M5 7.5v3" stroke="#4a5a6a" stroke-width="0.8" stroke-dasharray="1 1" /><path d="M12 1.5l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" fill="#8a5cc4" /><path d="M11.5 11l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" fill="#b48ae0" /></>,
  /* The table or the connection graph; the graph fitted to its pane; the requirements adviser */
  reqGraph: <><rect x="1" y="6" width="5" height="4" rx="1" fill="#dde7f2" stroke="#2a4a7a" /><rect x="10" y="1.5" width="5" height="4" rx="1" fill="#dff1e3" stroke="#2f7a4a" /><rect x="10" y="10.5" width="5" height="4" rx="1" fill="#f9dcdc" stroke="#a03030" /><path d="M6 8c2 0 2-4.5 4-4.5M6 8c2 0 2 4.5 4 4.5" fill="none" stroke="#4a5a6a" /></>,
  reqGraphFit: <><path d="M1.5 5V1.5H5M11 1.5h3.5V5M1.5 11v3.5H5M11 14.5h3.5V11" stroke="#4a5a6a" /><rect x="4" y="7" width="3" height="2.5" rx=".6" fill="#dde7f2" stroke="#2a4a7a" stroke-width="0.8" /><rect x="9" y="4.5" width="3" height="2.5" rx=".6" fill="#dff1e3" stroke="#2f7a4a" stroke-width="0.8" /><rect x="9" y="9.5" width="3" height="2.5" rx=".6" fill="#f9dcdc" stroke="#a03030" stroke-width="0.8" /></>,
  reqAdviser: <><path d="M1.5 2.5h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6l-3 2.5V9.5H1.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" fill="#eef3fb" stroke="#2a4a7a" /><path d="M3 5h6M3 7h4" stroke="#4a5a6a" stroke-width="0.9" /><path d="M13 7.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6zM12 1.5l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4z" fill="#d79a1e" stroke="none" /></>,
  reqDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#f4f7f1" stroke="#4a5a4a" /><path d="M4.6 6.2l.9.9 1.6-1.8M4.6 9.4l.9.9 1.6-1.8M4.6 12.6l.9.9 1.6-1.8" fill="none" stroke="#2f8a4a" stroke-width="0.9" /><path d="M8.4 6.4h3M8.4 9.6h3M8.4 12.8h2.2" stroke="#4a5a6a" stroke-width="0.8" /></>,
  enclosureDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#f1f4f7" stroke="#4a5a6a" /><path d="M4.5 7.5l3-1.5 4 1.5v4l-4 1.5-3-1.5z" fill="#c9d3dd" stroke="#4a5a6a" stroke-width="0.7" /><path d="M4.5 7.5l3 1.5 4-1.5M7.5 9v4" stroke="#4a5a6a" stroke-width="0.7" /></>,
  draftDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#fff6e0" stroke="#8a5a00" /><rect x="5" y="6" width="4" height="3" fill="none" stroke="#8a5a00" /><path d="M5 11.5h6M10 6v3" stroke="#8a5a00" /></>,
  /* A database library: a database (a drum) on a sheet; a database link: the drum and a link */
  dblibDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#eef3f8" stroke="#3d5f86" /><ellipse cx="8" cy="7" rx="3" ry="1.2" fill="#9cc0e4" stroke="#2f5b86" /><path d="M5 7v4c0 .7 1.3 1.2 3 1.2s3-.5 3-1.2V7M5 9c0 .7 1.3 1.2 3 1.2s3-.5 3-1.2" fill="none" stroke="#2f5b86" /></>,
  dblinkDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#eef3f8" stroke="#3d5f86" /><ellipse cx="7" cy="6.5" rx="2.5" ry="1" fill="#9cc0e4" stroke="#2f5b86" /><path d="M4.5 6.5v3.5c0 .6 1.1 1 2.5 1s2.5-.4 2.5-1V6.5" fill="none" stroke="#2f5b86" /><rect x="9" y="10" width="3" height="1.8" rx=".9" fill="none" stroke="#b5651d" /><rect x="10.5" y="11.6" width="2" height="1.8" rx=".9" fill="none" stroke="#b5651d" /></>,
  /* A 3D model (STEP): a cube on a sheet */
  stepDoc: <><path d="M3 1.5h7l3 3v10H3z" fill="#f4f4f4" stroke="#5a5a5a" /><path d="M8 5.5l3 1.5v3.5L8 12l-3-1.5V7z" fill="#8fb3d9" stroke="#2f5b86" /><path d="M5 7l3 1.5L11 7M8 8.5V12" stroke="#2f5b86" fill="none" /></>,
  /* Mixed Sim files: a netlist (lines and a wave), a model (a diode), a subcircuit (a box with pins), results (a plotted wave) */
  nsxDoc: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M10 1.5v3h3" stroke={ink} /><path d="M5 6.5h5M5 8.5h3" stroke={blue} /><path d="M5 12c.8-2 1.6-2 2.4 0s1.6 2 2.4 0" stroke={red} fill="none" /></>,
  mdlDoc: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M10 1.5v3h3" stroke={ink} /><path d="M5.5 7.5h4.5L7.8 11z" fill="#3d4f5f" stroke={ink} stroke-width="0.8" /><path d="M5.5 11h4.5M7.8 5.5v2M7.8 11v2" stroke={ink} /></>,
  cktDoc: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M10 1.5v3h3" stroke={ink} /><rect x="6" y="7" width="4" height="5" fill="#cfe0f2" stroke={blue} /><path d="M4.5 8.5H6M4.5 10.5H6M10 9.5h1.5" stroke={blue} /></>,
  sdfDoc: <><path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} /><path d="M10 1.5v3h3" stroke={ink} /><path d="M4.5 12.5h7M4.5 6v6.5" stroke="#8a93a0" stroke-width="0.8" /><path d="M5 10c1-4 2-4 3 0s2 4 3 0" stroke={green} fill="none" /></>,
  /* Home: the simulation demo (a sine on a chart) */
  simDemo: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#24364a" stroke="#14202c" /><path d="M3 8h10" stroke="#5c7389" stroke-width="0.7" /><path d="M3 8c1.2-5 2.4-5 3.4 0s2.3 5 3.4 0 2.2-5 3.2 0" stroke="#7ee0a0" fill="none" stroke-width="1.3" /></>,
  /* SimView: zoom about the chart's centre, fit the waves, copy the chart as text, abort the run */
  simZoomIn: <><path d="M1.5 12c1.2-5 2.4-5 3.5 0" stroke={green} fill="none" /><circle cx="9.5" cy="6.5" r="4" fill={paper} stroke={ink} /><path d="M12.4 9.4l2.8 2.8" stroke={ink} stroke-width="1.8" /><path d="M7.5 6.5h4M9.5 4.5v4" stroke={blue} stroke-width="1.3" /></>,
  simZoomOut: <><path d="M1.5 12c1.2-5 2.4-5 3.5 0" stroke={green} fill="none" /><circle cx="9.5" cy="6.5" r="4" fill={paper} stroke={ink} /><path d="M12.4 9.4l2.8 2.8" stroke={ink} stroke-width="1.8" /><path d="M7.5 6.5h4" stroke={blue} stroke-width="1.3" /></>,
  simFit: <><rect x="2.5" y="3.5" width="11" height="9" fill={paper} stroke={ink} /><path d="M3.5 9c1.4-4 2.8-4 4.2 0s2.8 4 4.8 0" stroke={green} fill="none" /><path d="M1 1.5h3M1 1.5v3M15 1.5h-3M15 1.5v3M1 14.5h3M1 14.5v-3M15 14.5h-3M15 14.5v-3" stroke={blue} /></>,
  simCopyText: <><rect x="1.5" y="1.5" width="8" height="10" fill="#eef3f8" stroke={ink} /><rect x="6.5" y="4.5" width="8" height="10" fill={paper} stroke={ink} /><path d="M8.5 7.5h4M8.5 9.5h4M8.5 11.5h3" stroke={blue} /><path d="M2.5 8c.9-3 1.8-3 2.7 0" stroke={green} fill="none" /></>,
  simAbort: <><path d="M1.5 9c1.2-5 2.4-5 3.6 0" stroke={green} fill="none" /><path d="M8 3.5h4.5L15 6v4.5L12.5 13H8l-2.5-2.5V6z" fill="#d84a3a" stroke="#8f2116" /><path d="M8.5 8.2h3.5" stroke={paper} stroke-width="1.5" /></>,
  /* SimView's waves and charts: a wave added, removed, edited; a chart made, deleted; the source data */
  waveAdd: <><path d="M1 9c1.3-5 2.6-5 3.9 0s2.6 5 3.9 0" stroke={blue} fill="none" stroke-width="1.3" /><path d="M12 8v6M9 11h6" stroke={green} stroke-width="1.8" /></>,
  waveRemove: <><path d="M1 9c1.3-5 2.6-5 3.9 0s2.6 5 3.9 0" stroke={blue} fill="none" stroke-width="1.3" /><path d="M10 9l4.5 4.5M14.5 9L10 13.5" stroke="#d01f1f" stroke-width="1.6" /></>,
  waveEdit: <><path d="M1 9c1.3-5 2.6-5 3.9 0s2.6 5 3.9 0" stroke={blue} fill="none" stroke-width="1.3" /><path d="M9 15l.7-2.6 4.8-4.8 1.9 1.9-4.8 4.8z" fill="#f2c94c" stroke="#8a6a2c" stroke-width="0.9" /></>,
  chartNew: <><rect x="1.5" y="2.5" width="10" height="9" fill={paper} stroke={ink} /><path d="M2.5 9c1.2-4 2.4-4 3.6 0s2.4 4 3.6 0" stroke={blue} fill="none" /><path d="M13 9v6M10 12h6" stroke={green} stroke-width="1.8" /></>,
  chartDelete: <><rect x="1.5" y="2.5" width="10" height="9" fill={paper} stroke={ink} /><path d="M2.5 9c1.2-4 2.4-4 3.6 0s2.4 4 3.6 0" stroke={blue} fill="none" /><path d="M10.5 10l4.5 4.5M15 10l-4.5 4.5" stroke="#d01f1f" stroke-width="1.6" /></>,
  sourceData: <><rect x="1.5" y="1.5" width="13" height="13" fill={paper} stroke={ink} /><path d="M1.5 5h13M5.5 5v9.5" stroke={ink} stroke-width="0.8" /><path d="M2.5 3.3h1.5M7 3.3h6" stroke={blue} /><path d="M2.5 7.5h2M2.5 10h2M2.5 12.5h2" stroke={blue} stroke-width="0.8" /><path d="M7 11c1-3.5 2-3.5 3 0s2 3.5 3 0" stroke={green} fill="none" /></>,
  /* SimView's cursor moves: cursor A to the lowest or highest point, or the next peak or trough either way */
  cursorMin: <><path d="M1 5c2 8 4 8 6 0s4-6 8-4" stroke={blue} fill="none" stroke-width="1.2" /><path d="M4 13.5v2" stroke="#d01f1f" stroke-width="1.6" /><circle cx="4" cy="11" r="1.5" fill="#d01f1f" stroke="none" /></>,
  cursorMax: <><path d="M1 11c2-8 4-8 6 0s4 6 8 4" stroke={blue} fill="none" stroke-width="1.2" /><path d="M4 .5v2" stroke="#d01f1f" stroke-width="1.6" /><circle cx="4" cy="5" r="1.5" fill="#d01f1f" stroke="none" /></>,
  cursorPeakRight: <><path d="M1 12c1.5-6 3-6 4.5 0s3 6 4.5 0" stroke={blue} fill="none" stroke-width="1.2" /><path d="M10 4h5M13 2l2 2-2 2" stroke="#d01f1f" stroke-width="1.3" fill="none" /></>,
  cursorPeakLeft: <><path d="M6 12c1.5-6 3-6 4.5 0s3 6 4.5 0" stroke={blue} fill="none" stroke-width="1.2" /><path d="M6 4H1M3 2L1 4l2 2" stroke="#d01f1f" stroke-width="1.3" fill="none" /></>,
  cursorTroughRight: <><path d="M1 5c1.5 6 3 6 4.5 0s3-6 4.5 0" stroke={blue} fill="none" stroke-width="1.2" /><path d="M10 13h5M13 11l2 2-2 2" stroke="#d01f1f" stroke-width="1.3" fill="none" /></>,
  cursorTroughLeft: <><path d="M6 5c1.5 6 3 6 4.5 0s3-6 4.5 0" stroke={blue} fill="none" stroke-width="1.2" /><path d="M6 13H1M3 11l-2 2 2 2" stroke="#d01f1f" stroke-width="1.3" fill="none" /></>,
  /* The netlist editor's Find: a magnifier over lines of text */
  findText: <><path d="M2 3h9M2 5.5h7M2 8h5" stroke={blue} /><circle cx="10" cy="10" r="3.2" fill={paper} stroke={ink} /><path d="M12.3 12.3l2.5 2.5" stroke={ink} stroke-width="1.7" /></>,
  /* The Simulation Sources toolbar */
  srcP5: srcBody(dcGlyph, '+5'),
  srcN5: srcBody(dcGlyph, '−5'),
  srcP12: srcBody(dcGlyph, '+12'),
  srcN12: srcBody(dcGlyph, '−12'),
  srcSin1k: srcBody(sineGlyph, '1k'),
  srcSin10k: srcBody(sineGlyph, '10k'),
  srcSin100k: srcBody(sineGlyph, '100k'),
  srcSin1M: srcBody(sineGlyph, '1M'),
  srcPulse1k: srcBody(pulseGlyph, '1k'),
  srcPulse10k: srcBody(pulseGlyph, '10k'),
  srcPulse100k: srcBody(pulseGlyph, '100k'),
  srcPulse1M: srcBody(pulseGlyph, '1M'),
  file: <path d="M3 1.5h7l3 3v10H3z" fill={paper} stroke={ink} />,
  folder: <path d="M1.5 4V2.5h5l1.5 1.5h6.5v9h-13z" fill="#f0c75a" stroke="#a37b22" />,
  folderOpen: <><path d="M1.5 4V2.5h5l1.5 1.5h6.5v2h-13z" fill="#f0c75a" stroke="#a37b22" /><path d="M1.5 13.5l2-7.5h12l-2 7.5z" fill="#f7da84" stroke="#a37b22" /></>,
};

/** Schematic library IEEE symbols (Place › IEEE Symbols), each its own glyph. */
const ieeeInk = '#1d3fa8';
const iP = (d: string, fill = 'none') => <path d={d} stroke={ieeeInk} stroke-width="1.4" fill={fill} />;
const iT = (t: string, size = 9) => <text x="8" y="12" font-size={size} font-family="Arial" font-weight="700" text-anchor="middle" fill={ieeeInk} stroke="none">{t}</text>;
const IEEE: Record<string, preact.ComponentChildren> = {
  Dot: <circle cx="8" cy="8" r="3" stroke={ieeeInk} stroke-width="1.4" fill="none" />,
  RightLeftSignalFlow: iP('M13 4L3 8l10 4z'),
  Clock: iP('M5 3l7 5-7 5'),
  ActiveLowInput: iP('M2 11.5h12V5z'),
  AnalogSignalIn: iP('M3 12c0-9 10-9 10 0'),
  NotLogicConnection: iP('M4 4l8 8M12 4l-8 8'),
  PostponedOutput: iP('M4 13V4h8v4'),
  OpenCollector: iP('M8 3l4.5 4.5L8 12 3.5 7.5zM3 14h10'),
  Hiz: iP('M3 4h10L8 12z'),
  HighCurrent: iP('M4 3l8 5-8 5z'),
  Pulse: iP('M2 12h3V4h6v8h3'),
  Delay: iP('M4 4v8M12 4v8M4 8h8'),
  GroupLine: iP('M3 8h10M3 5v6'),
  GroupBinary: iP('M3 6h10M3 10h10M3 4v8'),
  ActiveLowOutput: iP('M2 11.5h12L2 5z'),
  PiSymbol: iT('π', 11),
  GreaterEqual: iT('≥', 11),
  OpenCollectorPullUp: iP('M8 3l4.5 4.5L8 12 3.5 7.5zM3.5 7.5h9M3 14h10'),
  OpenEmitter: iP('M8 4l4.5 4.5L8 13 3.5 8.5zM3 2h10'),
  OpenEmitterPullUp: iP('M8 4l4.5 4.5L8 13 3.5 8.5zM3.5 8.5h9M3 2h10'),
  DigitalSignalIn: iP('M6 3v10M10 3v10M3 6.5h10M3 9.5h10'),
  Invertor: <>{iP('M2.5 3l8 5-8 5z')}<circle cx="12.5" cy="8" r="1.8" stroke={ieeeInk} stroke-width="1.3" fill="none" /></>,
  OrGate: iT('≥1', 8),
  InputOutput: iP('M1.5 8l5-4v8zM14.5 8l-5-4v8z'),
  AndGate: iT('&', 10),
  XorGate: iT('=1', 8),
  ShiftLeft: iP('M14 8H3M6 5L3 8l3 3'),
  LessEqual: iT('≤', 11),
  Sigma: iT('Σ', 11),
  Schmitt: iP('M2 12h8V4M5 12V4h9'),
  ShiftRight: iP('M2 8h11M10 5l3 3-3 3'),
  OpenCircuitOutput: iP('M8 3l5 5-5 5-5-5z'),
  LeftRightSignalFlow: iP('M3 4l10 4-10 4z'),
  BidirectionalSignalFlow: iP('M1.5 8l5-3.5v7zM14.5 8l-5-3.5v7z'),
};
for (const [k, v] of Object.entries(IEEE)) C[`ieee${k}`] = v;

/* Room actions: the room with a badge for what the command does (each its own picture) */
const roomBase = <rect x="1.5" y="1.5" width="10" height="9" fill="#c7b6e8" fill-opacity="0.6" stroke="#6a4fa8" />;
const badge = (b: preact.ComponentChildren) => <>{roomBase}<rect x="8" y="8" width="7.5" height="7.5" rx="1" fill={paper} stroke="#8a93a0" stroke-width="0.6" />{b}</>;
const ROOM_BADGES: Record<string, preact.ComponentChildren> = {
  roomMove: <path d="M11.8 9v5.5M9 11.8h5.5M11.8 9l-1 1M11.8 9l1 1M11.8 14.5l-1-1M11.8 14.5l1-1M9 11.8l1-1M9 11.8l1 1M14.5 11.8l-1-1M14.5 11.8l-1 1" stroke={ink} stroke-width="0.8" />,
  roomVertices: <><path d="M9.5 9.5h4.5v4.5h-4.5z" stroke="#6a4fa8" stroke-width="0.8" /><rect x="8.7" y="8.7" width="1.6" height="1.6" fill={ink} stroke="none" /><rect x="13.2" y="8.7" width="1.6" height="1.6" fill={ink} stroke="none" /><rect x="8.7" y="13.2" width="1.6" height="1.6" fill={ink} stroke="none" /><rect x="13.2" y="13.2" width="1.6" height="1.6" fill={ink} stroke="none" /></>,
  roomArrangeRooms: <><rect x="9" y="9" width="2.5" height="2.5" fill="#c7b6e8" stroke="#6a4fa8" stroke-width="0.7" /><rect x="12.3" y="9" width="2.5" height="2.5" fill="#c7b6e8" stroke="#6a4fa8" stroke-width="0.7" /><rect x="9" y="12.3" width="2.5" height="2.5" fill="#c7b6e8" stroke="#6a4fa8" stroke-width="0.7" /><rect x="12.3" y="12.3" width="2.5" height="2.5" fill="#c7b6e8" stroke="#6a4fa8" stroke-width="0.7" /></>,
  roomToGrid: <path d="M10.3 8.5v7M13.3 8.5v7M8.5 10.3h7M8.5 13.3h7" stroke={blue} stroke-width="0.8" />,
  roomWrapNonOrtho: <><path d="M9 10.5l2.5-1.5 3.5 2-.5 3.5-5 .3z" stroke="#6a4fa8" stroke-width="0.9" /><rect x="10.5" y="11" width="2.5" height="2" fill="#c9cfcc" stroke="none" /></>,
  roomWrapOrtho: <><path d="M9 9h3.5v2.5h2.5v3.5h-6z" stroke="#6a4fa8" stroke-width="0.9" /><rect x="10" y="10.5" width="2" height="2" fill="#c9cfcc" stroke="none" /><rect x="12.5" y="12.5" width="1.6" height="1.6" fill="#c9cfcc" stroke="none" /></>,
  roomWrapBounding: <><rect x="9" y="9" width="5.8" height="5.8" stroke="#6a4fa8" stroke-width="0.9" /><rect x="10" y="10" width="2" height="2" fill="#c9cfcc" stroke="none" /><rect x="12.2" y="12.2" width="1.8" height="1.8" fill="#c9cfcc" stroke="none" /></>,
  roomConvert: <><path d="M9 14l2.5-4.5 3 4.5z" fill="#9fd0a6" stroke={green} stroke-width="0.7" /><path d="M8.5 9.5l2-1" stroke={ink} stroke-width="0.8" /></>,
  roomFanout: <path d="M9.5 9.5h1.5l1.5 1.5M9.5 12h2l1.5 1.5M9.5 14.5h1.5M13 11v0M14.5 13.5v0" stroke={red} stroke-width="0.9" />,
  roomAutoroute: <path d="M9 14.5h2.5l2-2V9" stroke="#c0503f" stroke-width="1.2" />,
  roomUnroute: <><path d="M9 14.5h2.5l2-2V9" stroke="#c0503f" stroke-width="1" stroke-dasharray="1.2 0.8" /><path d="M9.5 9.5l2.5 2.5M12 9.5l-2.5 2.5" stroke="#d01f1f" stroke-width="1" /></>,
  roomSelectConn: <path d="M9.2 14.3l5.6-5.6" stroke={ink} stroke-width="0.9" stroke-dasharray="1.4 0.9" />,
  roomSmartCut: <path d="M8.8 15l6-6.5M10 9.5l1.3 1.3" stroke="#d01f1f" stroke-width="1" />,
};
for (const [k, v] of Object.entries(ROOM_BADGES)) C[k] = badge(v);

/* CAMtastic's own buttons: the picture of the like action with a film corner (a photoplotted image), each its own */
const film = <><rect x="9" y="9" width="6.5" height="6.5" rx="0.8" fill="#262626" stroke="#111111" stroke-width="0.6" /><rect x="10.4" y="10.4" width="3.7" height="3.7" fill="#6fcf6f" stroke="none" /></>;
const CAM_ICONS: Record<string, preact.ComponentChildren> = {
  camPrint: <><rect x="3" y="1.5" width="7" height="3.5" fill={paper} stroke={ink} /><rect x="1.5" y="5" width="11" height="5.5" rx="1" fill="#b9c4cc" stroke={ink} /><rect x="3" y="8.5" width="6.5" height="4" fill={paper} stroke={ink} />{film}</>,
  camPrintPreview: <><path d="M2 1.5h6l2 2v5" fill={paper} stroke={ink} /><path d="M2 1.5v11h5" stroke={ink} /><circle cx="7.5" cy="7.5" r="2.4" fill={paper} stroke={ink} /><path d="M9.2 9.2l1.4 1.4" stroke={ink} stroke-width="1.6" />{film}</>,
  camDynamicPan: <><path d="M6.5 1v11M1 6.5h11M6.5 1l-1.5 1.5M6.5 1l1.5 1.5M6.5 12L5 10.5M6.5 12L8 10.5M1 6.5l1.5-1.5M1 6.5l1.5 1.5M12 6.5L10.5 5M12 6.5L10.5 8" stroke={blue} stroke-width="1.2" />{film}</>,
  camCut: <><path d="M3 1.5l6 7M9 1.5l-6 7" stroke={ink} /><circle cx="3" cy="10" r="1.8" fill={paper} stroke={red} /><circle cx="8.5" cy="11.5" r="1.4" fill={paper} stroke={red} />{film}</>,
  camCopy: <><rect x="1.5" y="1.5" width="6.5" height="8" fill={paper} stroke={ink} /><rect x="4.5" y="3.5" width="6.5" height="8" fill={paper} stroke={ink} /><path d="M6 6h3.5M6 8h3.5" stroke={blue} />{film}</>,
  camPaste: <><rect x="1.5" y="2.5" width="8" height="11" fill="#e5c58a" stroke="#8a6a2c" /><rect x="3.5" y="1.5" width="4" height="2.2" fill={paper} stroke="#8a6a2c" /><path d="M3.5 6.5h4M3.5 8.5h4" stroke="#8a6a2c" />{film}</>,
  camQuery: <><circle cx="5.5" cy="5.5" r="4" fill={paper} stroke={ink} /><path d="M4.2 4.4a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.6.5-.6.9M5.5 8v.1" stroke={blue} stroke-width="1.1" /><path d="M8.5 8.5l1.2 1.2" stroke={ink} stroke-width="1.6" />{film}</>,
  camRfq: <><path d="M2 1.5h6l2.5 2.5v5.5" fill={paper} stroke={ink} /><path d="M2 1.5v12h5.5" stroke={ink} /><path d="M3.5 5.5h4M3.5 7.5h4M3.5 9.5h3" stroke={blue} /><path d="M8 1.5v2.5h2.5" stroke={ink} />{film}</>,
};
Object.assign(C, CAM_ICONS);


export function ColourIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg class="cicon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke-linejoin="round" aria-hidden="true">
      {C[name] ?? P[name] ?? null}
    </svg>
  );
}

/** Icon for a document by file name. */
export function docIcon(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return ({ prjpcb: 'prjpcb', libpkg: 'libpkg', prjmbd: 'prjmbd', prjhar: 'prjhar', wirdoc: 'wirDoc', ldrdoc: 'ldrDoc', hardwf: 'draftDoc', drawio: 'diagramDoc', dgmdoc: 'diagramDoc', enclosure: 'enclosureDoc', reqdoc: 'reqDoc', mbsdoc: 'mbsDoc', mbadoc: 'mbaDoc', dsnwrk: 'dsnwrk', schdoc: 'schdoc', pcbdoc: 'pcbdoc', schlib: 'schlib', pcblib: 'pcblib', intlib: 'schlib', harness: 'harnessDoc', bomdoc: 'bomdoc', pcbdwf: 'draftDoc', dblib: 'dblibDoc', svndblib: 'dblibDoc', dblink: 'dblinkDoc', step: 'stepDoc', stp: 'stepDoc', nsx: 'nsxDoc', cir: 'nsxDoc', sp: 'nsxDoc', spi: 'nsxDoc', mdl: 'mdlDoc', ckt: 'cktDoc', sdf: 'sdfDoc' } as Record<string, string>)[ext] ?? 'file';
}

/**
 * Konium Designer's mark: a "K" routed as copper tracks between vias (the stem, a via at its middle,
 * and from there two arms at 45°, all four tracks of one length), on solder-mask green. The same drawing as public/icon.svg and the page's favicon.
 */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" class="logo">
      <defs>
        <linearGradient id="logo-m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#186553" /><stop offset="1" stop-color="#0a2c25" /></linearGradient>
        <linearGradient id="logo-c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d47a" /><stop offset="1" stop-color="#d4972a" /></linearGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="14" fill="url(#logo-m)" />
      <rect x="1.75" y="1.75" width="60.5" height="60.5" rx="13.25" fill="none" stroke="#ffffff" stroke-opacity=".14" stroke-width="1.5" />
      <path d="M24 16V48M24 32L40 16M24 32L40 48" fill="none" stroke="url(#logo-c)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      {[[24, 16], [24, 32], [24, 48], [40, 16], [40, 48]].map(([x, y]) => <g key={`${x},${y}`}><circle cx={x} cy={y} r="6.5" fill="url(#logo-c)" /><circle cx={x} cy={y} r="2.8" fill="#0a2c25" /></g>)}
    </svg>
  );
}
