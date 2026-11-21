import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PAGE = import.meta.glob(['../index.html', '../public/*.{webmanifest,json,html}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * Konium's own words are British English: every string and piece of JSX text a person can read
 * (menus, dialogs, messages, reports). American spellings stay only where files need them —
 * values written into or read from documents — and in code (CSS, shaders, keys).
 */
const AMERICAN = [
  'color', 'colors', 'colored', 'coloring', 'colorize', 'center', 'centers', 'centered', 'centering', 'gray', 'grays', 'grayed', 'grayscale',
  'favorite', 'favorites', 'neighbor', 'neighbors', 'organize', 'customize', 'customized', 'analyze', 'analyzed', 'analyzer',
  'synchronize', 'synchronized', 'optimize', 'optimized', 'optimizer', 'equalize', 'localization', 'localized', 'initialize', 'minimize',
  'maximize', 'normalize', 'recognize', 'summarize', 'prioritize', 'finalize', 'categorize', 'visualize', 'utilize',
  'millimeter', 'millimeters', 'centimeter', 'centimeters', 'meter', 'meters', 'labeling', 'labeled', 'canceled', 'canceling',
  'modeling', 'modeled', 'behavior', 'behaviors', 'honor', 'analog', 'catalog', 'license', 'toward',
];
const CASES = AMERICAN.flatMap((w) => [w, w[0]!.toUpperCase() + w.slice(1)]).join('|');
/** The word on its own, or after a capitalised word and a hyphen (Top-Center); not inside identifiers or CSS (al-center). */
const WORD = new RegExp(`(^|[^A-Za-z0-9_.:&/-]|[A-Z][a-z]*-)(${CASES})(?=$|[^A-Za-z0-9_])`);

/** Values that files keep in AD's spelling (written into or read from documents, never shown as they are). */
const ALLOWED: [file: RegExp, text: RegExp][] = [
  [/./, /General Public License/],                                // the licence's own name, as it spells itself
  [/help\/guide\/tools\.ts$/, /spells its parts' names the American way/],   // Live Simulation's American set, quoted as it spells them
  [/model\/dimensions\.ts$/, /^'Millimeters'$/],                  // TEXTDIMENSIONUNIT
  [/model\/bagDefaults\.ts$|app\/pcbGridCommands\.ts$/, /^'Millimeters'$/], // a coordinate's UNITSTYLE
  [/dialogs\/Dimension\.tsx$/, /^'Center'$/],                     // TEXTPOSITION
  [/formats\/altium\/schdoc\.ts$/, /^'Organization'$/],           // the sheet's parameter
  [/formats\/gerber\/pnp\.ts$/, /Center-[XY]/],                    // Pick and Place columns, as machines read them
  [/help\/guide\/outputs\.ts$/, /Center-[XY]/],                   // the same columns, named in the User Guide
  [/formats\/altium\//, /^'[A-Z][A-Za-z]*'$/],                      // a one-word value in a file (BGAVIAMODE=Centered)
  [/formats\/altium\/pcbdwf\.ts$/, /<\/?Color\b|<Color\/>/],             // Draftsman's XML elements (DataContract names)
  [/app\/DiagramView\.tsx$|app\/diagram\/library\.ts$/, /align=center;/], // the diagram format's style keys
  [/diagram\/vsdx\.ts$|formats\/vsdx\.ts$/, /Colors?\b/],                   // Visio's cell and element names (Color, Colors)
  [/formats\/threeMf\.ts$/, /unit="millimeter"/],                          // 3MF's unit keyword
  [/formats\/diptrace\//, /Center|Color/],                                  // DipTrace's XML values and attributes (HorzAlign="Center", Color)
];

function literals(file: string, src: string): { line: number; text: string; raw: string }[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string; raw: string }[] = [];
  const visit = (n: ts.Node) => {
    const lit = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);
    if (lit) {
      const p = n.parent;
      const moduleName = ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword);
      const key = (ts.isPropertyAssignment(p) && p.name === n) || ts.isElementAccessExpression(p);
      const text = (n as ts.LiteralLikeNode).text.replace(/&(?=\w)/g, '');
      const bare = /^[a-z][\w.:-]*$/.test(text.trim());                // keys, CSS values, input types
      const css = /[{};]/.test(text) && /:\s*[#\w]/.test(text);        // style sheets
      const glsl = /#version \d+/.test(text);
      if (!moduleName && !key && !bare && !css && !glsl) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text, raw: n.getText(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('British English', () => {
  it('in every string the app shows', () => {
    const hits: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    for (const [f, src] of Object.entries(SOURCES)) {
      for (const l of literals(f, src)) {
        const m = WORD.exec(l.text);
        if (!m) continue;
        // A word made of capitals is a file key (COLOR, AREACOLOR)
        if (m[2] === m[2]!.toUpperCase()) continue;
        if (ALLOWED.some(([fr, tr]) => fr.test(f) && tr.test(l.raw))) continue;
        hits.push(`${f}:${l.line}: ${m[2]} in ${l.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
      }
    }
    expect(hits).toEqual([]);
  }, 30_000); // every source file parsed: several seconds when the whole suite runs at once
  it('in the page and its manifest', () => {
    for (const [f, text] of Object.entries(PAGE)) {
      // (the licence's own name is spelt as it spells itself)
      const visible = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|style="[^"]*"|"theme_color"|"background_color"|General Public License/g, '');
      expect(`${f}: ${WORD.exec(visible)?.[2] ?? ''}`).toBe(`${f}: `);
    }
  });
});
