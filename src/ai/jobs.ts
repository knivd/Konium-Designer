/**
 * Konium's AI jobs: what is asked of a model, and how its answer is checked. Shared by the app
 * (own key, local model) and the Konium service's Worker (cloudflare/ai), which builds the same
 * messages itself, so the service only ever runs these jobs — never free chat. No DOM, no
 * imports: the Worker bundles this file as it is.
 *
 * Every job's answer is JSON; a job's `check` turns what came back into a clean value or throws
 * with what was wrong (a model may wrap JSON in prose or code fences, give numbers as strings,
 * or leave fields out).
 */

/** One message part, as OpenAI-compatible chat completions take it. */
export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface Message { role: 'system' | 'user'; content: string | Part[] }

/** A datasheet page's text, as read from the PDF; `drawing` when the page is mostly a drawing (its text the drawing's labels). */
export interface PageText { page: number; text: string; drawing?: boolean }

/** A picture of a datasheet page or part of one (a PNG or JPEG data URL), and what it shows when known. */
export interface Picture { page: number; url: string; label?: string }

export interface SurveyInput {
  /** The pages sent (all, or those picked to keep within the model's reach). */
  pages: PageText[];
  /** The datasheet's page count (pages not sent are still numbered in it). */
  pageCount: number;
  /** Pictures of drawing pages with little text (a drawing whose labels are lines, not text), for a model that takes pictures. */
  pictures?: Picture[];
  /** The part number the designer means to use, when they gave one (not sent to the model: it picks its variant from the answer). */
  partNumber?: string;
}

export type LeadForm = 'gull-wing' | 'j-lead' | 'no-lead' | 'ball' | 'through-hole' | 'other' | 'unknown';
export const LEAD_FORMS: LeadForm[] = ['gull-wing', 'j-lead', 'no-lead', 'ball', 'through-hole', 'other', 'unknown'];

export interface Variant {
  /** Orderable part numbers of this variant (packing options together). */
  partNumbers: string[];
  /** The package as the maker names it (SOT96-1, SO8, TO-236AB …): a label only. */
  package: string;
  /** 0: not known (the drawing tells). */
  pins: number;
  leadForm: LeadForm;
  body: { length: number | null; width: number | null; height: number | null };
  pitch: number | null;
  thermalPad: boolean | null;
  /** Variants with the same pin numbering share a letter (never across different pin counts). */
  pinout: string;
  drawingPages: number[];
  landPatternPages: number[];
  pinTablePages: number[];
  orderingPage: number | null;
}

export interface Survey {
  maker: string;
  device: string;
  description: string;
  variants: Variant[];
}

/* ─── A package's drawing, read ──────────────────────────────────────────────────────── */

/** Package families by the drawing's shape (IPC-7351's, plus SOJ, DIP and OTHER for anything else). */
export type PackageFamily = 'CHIP' | 'MOLDED' | 'MELF' | 'SOD' | 'SOT23' | 'SOT223' | 'DPAK' | 'SOIC' | 'SOP' | 'SOJ' | 'SON' | 'QFN' | 'QFP' | 'PLCC' | 'BGA' | 'DIP' | 'OTHER';
export const PACKAGE_FAMILIES: PackageFamily[] = ['CHIP', 'MOLDED', 'MELF', 'SOD', 'SOT23', 'SOT223', 'DPAK', 'SOIC', 'SOP', 'SOJ', 'SON', 'QFN', 'QFP', 'PLCC', 'BGA', 'DIP', 'OTHER'];

/** Millimetres, min and max (the same for a single value). */
export interface MmRange { min: number; max: number }

/** A pad of the datasheet's own land pattern: mm, x right and y up seen from the top; w along x, h along y. */
export interface LandPad {
  name: string; x: number; y: number; w: number; h: number;
  shape: 'rect' | 'round' | 'roundrect';
  /** Drill diameter (0: surface mount); a slotted hole's length (0: round). */
  hole: number; slot: number;
  plated: boolean;
}

export interface PackageRead {
  family: PackageFamily;
  /** No drawing in the datasheet: the dimensions are the standard package's (JEDEC, EIAJ), not the maker's. */
  standard: boolean;
  pins: number;
  /** Quad packages: pins on each left and right side (0: a quarter of them). */
  pinsSide: number;
  pitch: number | null;
  /** Body along the rows of pins (D), across them (E), seated height (A). */
  bodyD: MmRange | null; bodyE: MmRange | null; height: MmRange | null;
  /** Lead span across the rows (L), and across the other pair (quad); foot length (T); lead width (W). */
  span: MmRange | null; span2: MmRange | null; term: MmRange | null; leadW: MmRange | null;
  /** Exposed pad or tab: width and length. */
  tab: { w: MmRange; l: MmRange } | null;
  ball: MmRange | null; rows: number; cols: number;
  /** The datasheet's recommended land pattern ([] when it gives none), and the part's outline drawn with it. */
  land: LandPad[];
  outline: { x: number; y: number; w: number; h: number } | null;
  /** The land pattern's dimensions as the model read them (what it worked the pads out from). */
  dimensions: string[];
  pages: number[];
  notes: string;
}

export interface PackageInput {
  device: string;
  variant: Pick<Variant, 'partNumbers' | 'package' | 'pins' | 'leadForm' | 'body' | 'pitch' | 'thermalPad'>;
  /** The text of the pages with its drawings (and the pages after them). */
  pages: PageText[];
  /** Pictures of the pages with its outline drawing and land pattern. */
  pictures: Picture[];
  pageCount: number;
}

/** Finding a variant's drawings on its pages: pictures of the pages. */
export interface LocateInput { device: string; variant: Pick<Variant, 'package' | 'pins'>; pictures: Picture[] }
/** A drawing found: its page, what it is, and its box as fractions of the page (from the top left). */
export interface Region { page: number; kind: 'land' | 'outline' | 'table'; box: { x0: number; y0: number; x1: number; y1: number } }
export interface Located { regions: Region[] }

export type JobKind = 'survey' | 'locate' | 'package' | 'review' | 'pins' | 'advise' | 'board' | 'datasheet' | 'part' | 'ask' | 'mpn' | 'reqs' | 'reqadvise' | 'script' | 'layout' | 'routing' | 'ping';

export interface JobSpec<I, O> {
  kind: JobKind;
  /** What the model needs: text only, or pictures too. */
  role: 'text' | 'vision';
  /** The role for this input (a job with pictures needs a model that takes them). */
  roleOf?(input: I): 'text' | 'vision';
  /** The longest answer allowed (tokens; a model's thinking counts too). */
  maxTokens: number;
  /**
   * Plain text work a cheap model does as well (a specification split into requirements): on the
   * Konium service and with an OpenRouter key it runs on the cheap text model (CHEAP_MODEL, or its
   * family's newest), not the one chosen for drawings; should that fail, on the chosen one. With a
   * local model or another endpoint, on the chosen one.
   */
  cheap?: boolean;
  /** How hard a model that thinks may think (OpenRouter's reasoning effort); low unless said. */
  effort?: 'low' | 'medium' | 'high';
  messages(input: I): Message[];
  check(answer: unknown, input: I): O;
  /** A rough size of the input, to limit what is sent (characters). */
  size(input: I): number;
  /** An input with nothing in it: what an answer kept for the shared cache is checked against. */
  blank: I;
  /** Raised when what's asked changes: answers kept for an older version aren't served again. */
  version: number;
  /** Searches the web first (OpenRouter's web plugin, this many results): the pages found come back as the answer's `sources`. */
  web?: number;
}

/** Pictures a job takes at most, and the size of each (data URL characters). */
export const MAX_PICTURES = 6, MAX_PICTURE = 4_000_000;
const PICTURE_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** The user message: text, then each picture after its page number (pictures checked: data URLs of images only). */
function withPictures(text: string, pictures: Picture[] | undefined): string | Part[] {
  const list = (pictures ?? []).slice(0, MAX_PICTURES);
  if (!list.length) return text;
  const parts: Part[] = [{ type: 'text', text }];
  for (const p of list) {
    if (typeof p?.url !== 'string' || p.url.length > MAX_PICTURE || !PICTURE_URL.test(p.url)) throw new Error('A picture isn\'t an image');
    const label = str(p.label, 80);
    parts.push({ type: 'text', text: `Picture of page ${Math.round(Number(p.page)) || '?'}${label ? `: ${label}` : ''}:` }, { type: 'image_url', image_url: { url: p.url } });
  }
  return parts;
}

const pageBlock = (pages: PageText[]) => pages.map((p) => `=== Page ${p.page}${p.drawing ? ' (mostly a drawing)' : ''} ===\n${p.text}`).join('\n\n');

/* ─── Reading an answer ──────────────────────────────────────────────────────────────── */

/** The JSON in a model's reply: the whole text, or the first {...} in it (fences and prose around it dropped); an answer cut off at the length limit is closed after its last whole value. */
export function parseJsonAnswer(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) { try { return JSON.parse(fenced[1]!.trim()); } catch { /* go on */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  if (a >= 0) { const cut = closeJson(t.slice(a)); if (cut) { try { return JSON.parse(cut); } catch { /* not JSON */ } } }
  throw new Error('The model\'s answer isn\'t JSON');
}

/** JSON cut off part way: kept up to its last closed object or array, the brackets still open closed. */
export function closeJson(t: string): string | null {
  const stack: string[] = [];
  let inString = false, escaped = false, cut = -1, open: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (!stack.length) return t.slice(0, i + 1);
      cut = i + 1; open = [...stack];
    }
  }
  return cut > 0 ? t.slice(0, cut) + open.reverse().join('') : null;
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v.replace(',', '.')) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);
const pages = (v: unknown, count: number): number[] => {
  const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  return [...new Set(list.map(num).filter((n): n is number => n !== null && Number.isInteger(n) && n >= 1 && n <= count))].sort((a, b) => a - b);
};

/* ─── Survey: the variants a datasheet covers ────────────────────────────────────────── */

const SURVEY_SYSTEM = `You read electronic component datasheets for a PCB design tool. From the datasheet text (each page starts with a line "=== Page N ===") list every orderable variant of the device and its package.

Reply with JSON only, in this shape:
{"maker": "...", "device": "...", "description": "one line",
 "variants": [{"partNumbers": ["..."], "package": "...", "pins": 0, "leadForm": "...",
   "body": {"length": 0, "width": 0, "height": 0}, "pitch": 0, "thermalPad": false, "pinout": "A",
   "drawingPages": [0], "landPatternPages": [0], "pinTablePages": [0], "orderingPage": 0}]}

Rules:
- Take everything from the datasheet; never guess. Use null (or []) for what it doesn't say.
- partNumbers: the full orderable part numbers of the variant. Part numbers that differ only in packing (tape and reel, tube, tray) belong to one variant. A datasheet for one part (a connector, say) with no ordering table: one variant with its part number.
- package: the package name exactly as the datasheet writes it (for example "SOT96-1", "SO8", "TO-236AB", "DFN2020-6"); for a part with no package name (a connector), its type ("USB-C receptacle"). It is only a label.
- pins: the number of pins or terminals, counting an exposed pad as a pin only if the datasheet numbers it; null if the datasheet doesn't say.
- leadForm: one of gull-wing, j-lead, no-lead, ball, through-hole, other, unknown — from the outline drawing or its description. Connectors, sockets, card holders, switches and modules: other.
- body: the moulded body alone, without its leads — length, width and height in millimetres (nominal, or the middle of min and max; for leaded packages the body width, not the span across the leads); convert inches or mils to millimetres. pitch: the lead pitch in millimetres.
- thermalPad: true if the package has an exposed thermal pad.
- pinout: variants with the same pin numbering share a letter (A, B, C …); a different numbering, or a different number of pins, gets the next letter.
- drawingPages: pages with that package's outline (mechanical) drawing or dimension table. landPatternPages: pages with its recommended land pattern, footprint, solder pad layout or PCB layout. pinTablePages: pages with its pin configuration or pin description. orderingPage: the page that lists its part numbers.
- Pages marked "(mostly a drawing)" are drawings: their text is the drawing's labels and dimensions. Pictures of some pages may follow the text.
- A package with no drawing in the datasheet is still listed (drawingPages []).
- A datasheet covering several devices (single, dual, quad …) lists each device's variants.`;

export const SURVEY: JobSpec<SurveyInput, Survey> = {
  kind: 'survey',
  version: 2,
  role: 'text',
  roleOf: (i) => (i.pictures?.length ? 'vision' : 'text'),
  maxTokens: 8000,
  size: (i) => i.pages.reduce((s, p) => s + p.text.length, 0),
  blank: { pages: [], pageCount: 5000 },
  messages(i) {
    const note = i.pages.length < i.pageCount ? `\n\n(${i.pages.length} of the datasheet's ${i.pageCount} pages are given; the page numbers are the datasheet's own.)` : '';
    // The part number the designer gave stays here (it picks its variant from the answer): told it, a model lists that variant alone
    return [{ role: 'system', content: SURVEY_SYSTEM }, { role: 'user', content: withPictures(`${pageBlock(i.pages)}${note}`, i.pictures) }];
  },
  check(answer, i) {
    const a = (answer ?? {}) as Record<string, unknown>;
    const list = Array.isArray(a.variants) ? a.variants : a.variants && typeof a.variants === 'object' ? [a.variants] : [];
    const device = str(a.device, 80);
    const variants: Variant[] = [];
    for (const raw of list) {
      const v = (raw ?? {}) as Record<string, unknown>;
      const parts = [...new Set((Array.isArray(v.partNumbers) ? v.partNumbers : [v.partNumbers ?? v.partNumber]).map((p) => str(p, 60)).filter(Boolean))];
      const own = str(v.package, 80) || str(v.name, 80);
      const pins = num(v.pins);
      // A variant with nothing to know it by is no variant; one without a package name or a pin count is (the drawing tells)
      if (!own && !parts.length && (pins === null || pins < 1)) continue;
      const body = (v.body ?? {}) as Record<string, unknown>;
      const mmOrNull = (x: unknown) => { const n = num(x); return n !== null && n > 0 && n < 500 ? n : null; };
      const lf: string = str(v.leadForm, 20).toLowerCase().replace(/[\s_]+/g, '-');
      variants.push({
        partNumbers: parts,
        package: own || parts[0] || device || 'Package',
        pins: pins !== null && pins >= 1 && pins <= 5000 ? Math.round(pins) : 0,
        leadForm: LEAD_FORMS.includes(lf as LeadForm) ? lf as LeadForm : lf === 'jlead' || lf === 'j' ? 'j-lead' : lf === 'gullwing' ? 'gull-wing' : lf === 'leadless' || lf === 'nolead' ? 'no-lead' : lf === 'tht' || lf === 'pth' ? 'through-hole' : 'unknown',
        body: { length: mmOrNull(body.length), width: mmOrNull(body.width), height: mmOrNull(body.height) },
        pitch: mmOrNull(v.pitch),
        thermalPad: bool(v.thermalPad),
        pinout: (str(v.pinout, 3) || 'A').toUpperCase(),
        drawingPages: pages(v.drawingPages, i.pageCount),
        landPatternPages: pages(v.landPatternPages, i.pageCount),
        pinTablePages: pages(v.pinTablePages, i.pageCount),
        orderingPage: pages(v.orderingPage, i.pageCount)[0] ?? null,
      });
    }
    // No variants but a device, and pages that are drawings: one variant to read the drawings of
    const drawn = i.pages.filter((p) => p.drawing).map((p) => p.page);
    if (!variants.length && (device || drawn.length) && i.pages.length) {
      variants.push({ partNumbers: [], package: device || 'Package', pins: 0, leadForm: 'unknown', body: { length: null, width: null, height: null }, pitch: null, thermalPad: null,
        pinout: 'A', drawingPages: drawn.slice(0, 4), landPatternPages: [], pinTablePages: [], orderingPage: null });
    }
    if (!variants.length) throw new Error('No package found in the datasheet');
    distinctPinouts(variants);
    return { maker: str(a.maker, 80), device, description: str(a.description, 300), variants };
  },
};

/** Variants of different pin counts never share a pinout letter: those after the first count get letters of their own. */
export function distinctPinouts(variants: Variant[]): void {
  const used = new Set(variants.map((v) => v.pinout));
  const first = new Map<string, number>(), moved = new Map<string, string>();
  const next = () => { for (let c = 65; c < 91; c++) { const l = String.fromCharCode(c); if (!used.has(l)) { used.add(l); return l; } } return '?'; };
  for (const v of variants) {
    if (!v.pins) continue;
    const had = first.get(v.pinout);
    if (had === undefined) { first.set(v.pinout, v.pins); continue; }
    if (had === v.pins) continue;
    const key = `${v.pinout}:${v.pins}`;
    let l = moved.get(key);
    if (!l) { l = next(); moved.set(key, l); }
    v.pinout = l;
  }
}

/* ─── Package: one variant's drawing, read ───────────────────────────────────────────── */

const PACKAGE_SYSTEM = `You read package drawings in electronic component datasheets for a PCB design tool: the outline (mechanical) drawing with its dimension table, and the recommended land pattern (footprint, PCB layout) when the datasheet draws one. You get the variant to read, the text of its pages (each starts "=== Page N ===") and pictures of its drawings: whole pages, or a drawing enlarged (its label says which).

Reply with JSON only, in this shape:
{"family": "SOIC", "standard": false, "units": "mm", "pins": 8, "pinsPerSide": null, "pitch": 1.27,
 "body": {"length": [4.8, 5.0], "width": [3.8, 4.0], "height": [1.35, 1.75]},
 "leads": {"span": [5.8, 6.2], "span2": null, "foot": [0.4, 1.27], "width": [0.31, 0.51]},
 "thermalPad": null, "ball": null, "grid": null,
 "landPattern": null, "pages": [12], "notes": ""}

Rules:
- family, by the drawing's shape, never by the package's name: CHIP (two-terminal chip: resistor, capacitor), MOLDED (moulded two-terminal body, terminals folded under: tantalum capacitors, SMA/SMB diodes), MELF, SOD (two leads at the ends of a small body), SOT23 (3 to 8 gull-wing leads at 0.95 or 0.65 mm on a small body), SOT223 (leads on one side, a wide tab on the other), DPAK (TO-252, TO-263: leads, and a tab soldered under the body), SOIC (two rows of gull-wing leads at 1.27 mm), SOP (two rows of gull-wing leads at less than 1.27 mm: TSSOP, MSOP, SSOP, TSOP), SOJ (two rows of J-leads), SON (two rows of terminals under the body, no leads: DFN, WSON, USON), QFN (terminals on four sides under the body), QFP (gull-wing leads on four sides), PLCC (J-leads on four sides), BGA (balls in a grid), DIP (two rows of through-hole leads), OTHER (connectors, sockets, switches, modules, anything else).
- Every length in millimetres: convert inches (× 25.4) and mils (× 0.0254). units: the unit the drawing uses.
- Ranges are [min, max]; a single value v: [v, v]; nominal and tolerance: worked out.
- body.length: along the rows of pins (D); body.width: across them (E1; the body alone, without the leads); body.height: the seated height (A).
- leads.span: tip to tip across the rows (E; for packages without leads, the body width); span2: the same across the other two sides (quad packages); foot: the length of the lead or terminal on the board (L); width: the lead or terminal width (b). DIP: span is the distance between the rows' lead centres.
- pitch: the lead pitch (e). pinsPerSide: QFP, QFN, PLCC: pins on each left and right side.
- thermalPad: the exposed pad or tab, {"width": [min, max], "length": [min, max]} (E2, D2), or null. BGA: ball: the ball diameter range; grid: {"rows": n, "cols": n}.
- landPattern: only when the datasheet draws its recommended land pattern (PCB layout, footprint, solder pads), else null. Find that drawing first: not the outline drawing, the 3D view or the mating drawing. As seen from the top, x to the right and y up, in millimetres from the centre of the pattern:
  {"dimensions": ["8.64: between the centres of the two shield slots", "PITCH=0.50: between neighbouring pads of a row", "0.25: the bottom row's offset from the top row"],
   "rows": [{"first": "1", "last": "4", "count": 4, "pitch": 1.27, "direction": "down", "x": -2.7, "y": 1.905, "w": 1.55, "h": 0.6, "shape": "rect", "hole": 0, "names": null}],
   "pads": [{"name": "9", "x": 0, "y": 0, "w": 3.4, "h": 4.0, "shape": "rect", "hole": 0, "slot": 0, "plated": true}],
   "outline": {"x": 0, "y": 0, "w": 5.0, "h": 6.0}}
  dimensions: first, every dimension the land pattern drawing shows, as written, each with what it measures; then work the pads' places out from them (not from how far apart things look). Dimensions marked 2X, 24X … apply to that many.
  rows: pads in a line, x and y the first pad's centre, direction right, left, up or down, named from first to last (A1 … A12, or B12 … B1 counting down) or listed in names. Two rows offset from each other (staggered) each have their own first pad's x. pads: single pads. w: the pad's size along x, h along y. shape: rect, round (an oval when w and h differ) or roundrect; a pad of another shape (an L-shaped tab): its bounding rectangle, said in notes. hole: the drill diameter (0: surface mount); slot: a slotted hole's length (0: round hole); a hole drawn inside a pad's outline is that pad's plated hole; plated: false for unplated holes (locating posts). Give every pad, shield tab and mounting or locating hole the pattern shows; unplated holes have the name "". Pin names are the datasheet's. outline: the part's outline where the pattern draws it, or null.
- standard: true only when the datasheet has no drawing of this package: then give the standard package's dimensions (JEDEC, EIAJ) by its name, and say so in notes.
- pages: the pages read. notes: what the designer should check (unclear dimensions, values worked out).
- Never guess a dimension the drawing doesn't give: null.`;

export const PACKAGE: JobSpec<PackageInput, PackageRead> = {
  kind: 'package',
  version: 2,
  role: 'vision',
  roleOf: (i) => (i.pictures?.length ? 'vision' : 'text'),
  // Room to think: working pad places out of a drawing's dimensions takes some
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => (i.pages ?? []).reduce((s, p) => s + p.text.length, 0),
  blank: { device: '', variant: { partNumbers: [], package: '', pins: 0, leadForm: 'unknown', body: { length: null, width: null, height: null }, pitch: null, thermalPad: null }, pages: [], pictures: [], pageCount: 5000 },
  messages(i) {
    const v = i.variant;
    const known = [
      `Variant: package "${str(v.package, 80)}"`, v.pins ? `${v.pins} pins` : '', v.leadForm && v.leadForm !== 'unknown' ? v.leadForm : '',
      v.pitch ? `pitch ${v.pitch} mm` : '', v.thermalPad ? 'with a thermal pad' : '',
    ].filter(Boolean).join(', ');
    const parts = (v.partNumbers ?? []).slice(0, 6).map((p) => str(p, 60)).join(', ');
    const head = `Device: ${str(i.device, 80) || 'unknown'}\n${known}${parts ? `\nPart numbers: ${parts}` : ''}`;
    const text = (i.pages ?? []).length ? `\n\n${pageBlock(i.pages)}` : '\n\n(The datasheet has no drawing of this package.)';
    return [{ role: 'system', content: PACKAGE_SYSTEM }, { role: 'user', content: withPictures(`${head}${text}`, i.pictures) }];
  },
  check(answer, i) {
    const a = (answer ?? {}) as Record<string, unknown>;
    const fam = str(a.family, 12).toUpperCase().replace(/[^A-Z0-9]/g, '') as PackageFamily;
    const family: PackageFamily = PACKAGE_FAMILIES.includes(fam) ? fam : 'OTHER';
    // The model's shape, or a read already cleaned (one accepted for the shared cache)
    const tab = obj(a.tab);
    const body = a.body ? obj(a.body) : { length: a.bodyD, width: a.bodyE, height: a.height };
    const leads = a.leads ? obj(a.leads) : { span: a.span, span2: a.span2, foot: a.term, width: a.leadW };
    const tp = a.thermalPad && typeof a.thermalPad === 'object' ? obj(a.thermalPad) : tab.w ? { width: tab.w, length: tab.l } : null;
    const grid = a.grid ? obj(a.grid) : { rows: a.rows, cols: a.cols };
    const pitch = mmRange(a.pitch);
    const lp = a.landPattern && typeof a.landPattern === 'object' ? obj(a.landPattern) : Array.isArray(a.land) ? { pads: a.land, outline: a.outline } : null;
    const land = lp ? landPads(lp) : [];
    const o = lp?.outline && typeof lp.outline === 'object' ? obj(lp.outline) : null;
    const ow = num(o?.w), oh = num(o?.h);
    const read: PackageRead = {
      family,
      standard: bool(a.standard) === true,
      pins: clampInt(a.pins, 0, 5000) || i.variant?.pins || 0,
      pinsSide: clampInt(a.pinsPerSide ?? a.pinsSide, 0, 2000),
      pitch: pitch ? +((pitch.min + pitch.max) / 2).toFixed(4) : null,
      bodyD: mmRange(body.length), bodyE: mmRange(body.width), height: mmRange(body.height),
      span: mmRange(leads.span), span2: mmRange(leads.span2), term: mmRange(leads.foot ?? leads.term), leadW: mmRange(leads.width),
      tab: tp && mmRange(tp.width) && mmRange(tp.length) ? { w: mmRange(tp.width)!, l: mmRange(tp.length)! } : tp && mmRange(tp.width) ? { w: mmRange(tp.width)!, l: mmRange(tp.width)! } : null,
      ball: mmRange(a.ball), rows: clampInt(grid.rows, 0, 200), cols: clampInt(grid.cols, 0, 200),
      land,
      outline: o && ow && oh && ow > 0 && oh > 0 && ow < 300 && oh < 300 ? { x: num(o.x) ?? 0, y: num(o.y) ?? 0, w: ow, h: oh } : null,
      dimensions: (Array.isArray(lp?.dimensions) ? lp.dimensions : Array.isArray(a.dimensions) ? a.dimensions : []).map((d) => str(d, 120)).filter(Boolean).slice(0, 40),
      pages: pages(a.pages, i.pageCount || 5000),
      notes: str(a.notes, 600),
    };
    const dims = [read.bodyD, read.bodyE, read.span, read.leadW, read.ball].some(Boolean);
    if (!land.length && !dims) throw new Error('Nothing could be read from the drawing');
    return read;
  },
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const clampInt = (v: unknown, lo: number, hi: number) => { const n = num(v); return n === null ? 0 : Math.max(lo, Math.min(hi, Math.round(n))); };
/** Millimetres, plausible (0 to 300), as a range: [min, max], [v], v, "1.27 BSC", {min, nom, max}; min and max the right way round. */
function mmRange(v: unknown): MmRange | null {
  let lo: number | null = null, hi: number | null = null;
  if (Array.isArray(v)) { const n = v.map(num).filter((x): x is number => x !== null); lo = n.length ? Math.min(...n) : null; hi = n.length ? Math.max(...n) : null; }
  else if (v && typeof v === 'object') { const o = v as Record<string, unknown>; const mn = num(o.min), mx = num(o.max), nom = num(o.nom ?? o.nominal); lo = mn ?? nom ?? mx; hi = mx ?? nom ?? mn; }
  else { lo = hi = num(v); }
  if (lo === null || hi === null || !(lo > 0) || hi > 300) return null;
  return { min: +Math.min(lo, hi).toFixed(4), max: +Math.max(lo, hi).toFixed(4) };
}

const SHAPES: LandPad['shape'][] = ['rect', 'round', 'roundrect'];
/** The next pin name: 1 → 2, A1 → A2, B12 → B13 (else the name with a number added). */
function nextName(first: string, k: number): string {
  const m = /^(.*?)(\d+)$/.exec(first);
  return m ? `${m[1]}${Number(m[2]) + k}` : k ? `${first}${k + 1}` : first;
}
function landPads(lp: Record<string, unknown>): LandPad[] {
  const out: LandPad[] = [];
  const pad = (p: Record<string, unknown>, name: string, x: number, y: number) => {
    const hole = Math.max(0, num(p.hole) ?? 0), slot = Math.max(0, num(p.slot) ?? 0);
    let w = num(p.w) ?? 0, h = num(p.h) ?? 0;
    const plated = bool(p.plated) !== false;
    if ((!(w > 0) || !(h > 0)) && hole > 0) { w = Math.max(w, hole); h = Math.max(h, slot || hole); }
    if (!(w > 0) || !(h > 0) || w > 100 || h > 100 || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 300 || Math.abs(y) > 300) return;
    const sh = str(p.shape, 12).toLowerCase().replace(/[^a-z]/g, '');
    const shape: LandPad['shape'] = SHAPES.includes(sh as LandPad['shape']) ? sh as LandPad['shape'] : /oval|oblong|circ|obround/.test(sh) ? 'round' : /round/.test(sh) ? 'roundrect' : 'rect';
    if (out.length < 2000) out.push({ name: plated || hole === 0 ? name : '', x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4), shape, hole: +hole.toFixed(4), slot: slot > hole ? +slot.toFixed(4) : 0, plated: hole > 0 ? plated : true });
  };
  for (const raw of Array.isArray(lp.rows) ? lp.rows : []) {
    const r = obj(raw);
    const count = clampInt(r.count, 0, 500), pitch = num(r.pitch) ?? 0, x = num(r.x), y = num(r.y);
    if (!count || x === null || y === null || (count > 1 && !(pitch > 0))) continue;
    const dir = str(r.direction, 8).toLowerCase();
    const [dx, dy] = dir === 'left' ? [-1, 0] : dir === 'up' ? [0, 1] : dir === 'down' ? [0, -1] : [1, 0];
    const names = Array.isArray(r.names) ? r.names.map((n) => str(n, 12)) : [];
    const first = str(r.first, 12) || '1', last = str(r.last, 12);
    // Counting down when the last pad's number is below the first's (B12 … B1)
    const nf = /(\d+)$/.exec(first)?.[1], nl = /(\d+)$/.exec(last)?.[1];
    const step = nf && nl && Number(nl) < Number(nf) && first.slice(0, -nf.length) === last.slice(0, -nl.length) ? -1 : 1;
    for (let k = 0; k < count; k++) pad(r, names[k] || nextName(first, k * step), x + dx * pitch * k, y + dy * pitch * k);
  }
  for (const raw of Array.isArray(lp.pads) ? lp.pads : []) {
    const p = obj(raw);
    const x = num(p.x), y = num(p.y);
    if (x !== null && y !== null) pad(p, str(p.name, 12), x, y);
  }
  return out;
}

/* ─── Locate: where a variant's drawings are on its pages ──────────────────────────── */

const LOCATE_SYSTEM = `You find drawings on electronic component datasheet pages for a PCB design tool. You get pictures of pages and the package wanted. Find, for that package only (a page may draw several packages):
- "land": its recommended land pattern (PCB layout, footprint, solder pad layout, mounting pads);
- "outline": its outline (mechanical) drawing;
- "table": its dimension table, when it is apart from the drawing.

Reply with JSON only: {"regions": [{"page": 2, "kind": "land", "left": 520, "top": 180, "right": 880, "bottom": 610}]}
left, top, right, bottom: the region's edges in thousandths of the picture's width (left, right) and height (top, bottom), from its top left corner. Take in the whole drawing with all its dimension lines, figures and notes. Leave out what isn't there.`;

export const LOCATE: JobSpec<LocateInput, Located> = {
  kind: 'locate',
  version: 1,
  role: 'vision',
  maxTokens: 1000,
  size: () => 0,
  blank: { device: '', variant: { package: '', pins: 0 }, pictures: [] },
  messages(i) {
    const head = `Package wanted: "${str(i.variant?.package, 80)}"${i.variant?.pins ? `, ${i.variant.pins} pins` : ''} (${str(i.device, 80) || 'device unknown'}).`;
    return [{ role: 'system', content: LOCATE_SYSTEM }, { role: 'user', content: withPictures(head, i.pictures) }];
  },
  check(answer, i) {
    const a = (answer ?? {}) as Record<string, unknown>;
    const list = Array.isArray(a.regions) ? a.regions : [];
    const sent = new Set((i.pictures ?? []).map((p) => Math.round(Number(p.page))));
    const regions: Region[] = [];
    for (const raw of list) {
      const r = obj(raw);
      const page = clampInt(r.page, 0, 5000);
      const kind = str(r.kind, 10).toLowerCase();
      if (!['land', 'outline', 'table'].includes(kind) || (sent.size && !sent.has(page))) continue;
      // Thousandths, or fractions when all four are within 0–1 (a region already checked: its box)
      const bx = obj(r.box);
      const v = r.box ? [num(bx.x0), num(bx.y0), num(bx.x1), num(bx.y1)] : [num(r.left), num(r.top), num(r.right), num(r.bottom)];
      if (v.some((x) => x === null)) continue;
      const k = v.every((x) => x! >= 0 && x! <= 1) ? 1 : 1000;
      const [x0, y0, x1, y1] = v.map((x) => Math.max(0, Math.min(1, x! / k))) as [number, number, number, number];
      if (x1 - x0 < 0.03 || y1 - y0 < 0.03) continue;
      if (regions.length < 6) regions.push({ page, kind: kind as Region['kind'], box: { x0, y0, x1, y1 } });
    }
    return { regions };
  },
};

/* ─── Review: the model looks at the footprint it made ─────────────────────────────── */

/** A footprint's land pattern in the package job's answer shape: rows of pads and single pads (mm, x right, y up). */
export interface LandAnswer { rows: Record<string, unknown>[]; pads: Record<string, unknown>[] }

/**
 * Checking a footprint against its drawing: the land pattern as made (the package job's shape),
 * whether its pads' places were measured in the drawing, which round this is, and pictures: the
 * datasheet's land-pattern drawing, the footprint drawn to scale with its pad names, and (when
 * measured) its pads outlined over the drawing.
 */
export interface ReviewInput {
  device: string; variant: Pick<Variant, 'package' | 'pins'>;
  land: LandAnswer; dimensions: string[]; measured: boolean; round: number; pictures: Picture[];
}
/** The verdict: it matches, or what is wrong and the land pattern put right (null: none given). */
export interface Reviewed { ok: boolean; problems: string[]; land: LandPad[] | null; dimensions: string[] }

const REVIEW_SYSTEM = `You check footprints (PCB land patterns) made from electronic component datasheets for a PCB design tool. You get the land pattern as made, in JSON (millimetres from the pattern's centre, seen from the top: x to the right, y up; rows of pads with their first pad's centre, pitch and direction, and single pads; w is a pad's size along x, h along y), the dimensions it was worked out from, and pictures: the datasheet's land-pattern drawing; the footprint as made, drawn to scale with its pad names; and, when there is one, the footprint's pads outlined in red over the datasheet's drawing.

Compare them pad by pad against the drawing and its dimensions: how many pads, their names, places (pitch, the rows' distance and offset, stagger), sizes, holes and slots, plated or not, and pads missing or extra. When the pads' places were measured in the drawing, trust those places where the red outlines sit on the drawing's pads; look hardest at what can't be measured: names, sizes against the dimensions, holes, pads missing.

Reply with JSON only:
{"verdict": "ok", "problems": []}
when it matches the drawing; or
{"verdict": "fix", "problems": ["B1 … B12 are numbered the wrong way round", "the shield slots are 0.6 × 1.7, not round 0.6 holes"],
 "landPattern": {"dimensions": [...], "rows": [...], "pads": [...]}}
with the whole land pattern put right, in the same shape as you were given it. Say "ok" only when nothing needs changing; never change what the drawing doesn't show.`;

export const REVIEW: JobSpec<ReviewInput, Reviewed> = {
  kind: 'review',
  version: 1,
  role: 'vision',
  roleOf: (i) => (i.pictures?.length ? 'vision' : 'text'),
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => JSON.stringify(i.land ?? {}).length + JSON.stringify(i.dimensions ?? []).length,
  blank: { device: '', variant: { package: '', pins: 0 }, land: { rows: [], pads: [] }, dimensions: [], measured: false, round: 1, pictures: [] },
  messages(i) {
    const land = { rows: Array.isArray(i.land?.rows) ? i.land.rows.slice(0, 200) : [], pads: Array.isArray(i.land?.pads) ? i.land.pads.slice(0, 400) : [] };
    const dims = (Array.isArray(i.dimensions) ? i.dimensions : []).slice(0, 40).map((d) => str(d, 120)).filter(Boolean);
    const text = [
      `Device: ${str(i.device, 80) || 'unknown'}`,
      `Package: ${str(i.variant?.package, 80)}${i.variant?.pins ? `, ${Math.round(Number(i.variant.pins))} pins` : ''}`,
      `Round ${Math.max(1, Math.min(9, Math.round(Number(i.round)) || 1))} of checking.${i.measured ? " The pads' places were measured in the drawing." : " The pads' places are as worked out from the dimensions (not measured)."}`,
      dims.length ? `Dimensions read:\n${dims.map((d) => `- ${d}`).join('\n')}` : '',
      `The land pattern as made:\n${JSON.stringify(land)}`,
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: withPictures(text, i.pictures) }];
  },
  check(answer) {
    const a = obj(answer);
    const verdict = str(a.verdict, 20).toLowerCase();
    const problems = (Array.isArray(a.problems) ? a.problems : []).map((p) => str(p, 240)).filter(Boolean).slice(0, 12);
    const lp = a.landPattern && typeof a.landPattern === 'object' ? obj(a.landPattern) : null;
    const land = lp ? landPads(lp) : [];
    const dimensions = (Array.isArray(lp?.dimensions) ? lp.dimensions : []).map((d) => str(d, 120)).filter(Boolean).slice(0, 40);
    if (/^(ok|match|matches|correct|good|pass)/.test(verdict) && !problems.length) return { ok: true, problems: [], land: null, dimensions: [] };
    if (!verdict && !problems.length && !land.length) throw new Error('No verdict');
    return { ok: false, problems, land: land.length ? land : null, dimensions };
  },
};

/* ─── Pins: a variant's pin table, for its schematic symbol ─────────────────────────── */

/** A pin's electrical type, as a symbol's pin takes it (power and ground both AD's Power; nc: not connected). */
export type PinType = 'input' | 'output' | 'io' | 'passive' | 'power' | 'ground' | 'oc' | 'oe' | 'hiz' | 'nc';
export const PIN_TYPES: PinType[] = ['input', 'output', 'io', 'passive', 'power', 'ground', 'oc', 'oe', 'hiz', 'nc'];
/** A pin as read: its number on the package (as the footprint's pads are named), name (active-low marks taken off and said), type, function group, what it does. */
export interface SymbolPin { number: string; name: string; activeLow: boolean; type: PinType; group: string; description: string }
export type PartKind = 'ic' | 'connector' | 'transistor' | 'diode' | 'passive' | 'module' | 'other';
export const PART_KINDS: PartKind[] = ['ic', 'connector', 'transistor', 'diode', 'passive', 'module', 'other'];
/** A variant's pins, the kind of part and its designator prefix (U, J, Q …). */
export interface PinsRead { kind: PartKind; prefix: string; pins: SymbolPin[]; pages: number[]; notes: string }

export interface PinsInput {
  device: string;
  variant: Pick<Variant, 'partNumbers' | 'package' | 'pins' | 'pinout' | 'leadForm'>;
  /** The text of the pages with its pin table (and pin descriptions). */
  pages: PageText[];
  /** Pictures of those pages (a pin diagram reads better drawn). */
  pictures: Picture[];
  pageCount: number;
}

const PINS_SYSTEM = `You read pin tables in electronic component datasheets for a PCB design tool, to make the part's schematic symbol. You get the variant (its package, pin count and pinout letter: variants with the same letter share their pin numbering), the text of its pages (each starts "=== Page N ===") and pictures of them.

Reply with JSON only, in this shape:
{"kind": "ic", "prefix": "U",
 "pins": [{"number": "1", "name": "CS", "activeLow": true, "type": "input", "group": "SPI", "description": "Chip select"},
          {"number": "8", "name": "VCC", "activeLow": false, "type": "power", "group": "Power", "description": "Supply, 2.7 to 3.6 V"}],
 "pages": [3], "notes": ""}

Rules:
- pins: every pin, pad or ball of this variant's package, once each, by its number on the package (as the footprint's pads are named: 1, 2 …, or A1, B12 …), in number order. An exposed or thermal pad is a pin too: its number if the datasheet gives one (often pins + 1), else "EP". Shield or mounting tabs that connect: as the datasheet names them (SH1 …). Only this variant's package when the table has several; pins it doesn't have, left out.
- name: as the datasheet writes it, without active-low marks (an overbar, a leading or trailing # or /, a trailing _N): activeLow true for those. Several pins of one name (GND on four pins): each listed.
- type: input; output; io (bidirectional); passive (resistors, capacitors, crystals, connectors' contacts, analogue pins with no direction); power (a supply the part takes or gives: VCC, VDD, VIN, VBUS, VREF); ground (GND, VSS, AGND, PGND; an exposed pad tied to ground); oc (open collector or open drain); oe (open emitter or open source); hiz (three-state output); nc (not connected, do not connect).
- group: the function group the datasheet puts it in (Power, SPI, I2C, USB, GPIO, Clock, Control, Analogue, Shield …), else a short one of your own; description: a few words.
- kind: ic, connector, transistor, diode, passive, module or other; prefix: the usual designator prefix for it (U, J, Q, D, R, C, L, Y, SW, K …).
- pages: the pages read. notes: what the designer should check (pins the table leaves unclear, functions shared on a pin).`;

const TYPE_WORDS: [RegExp, PinType][] = [
  [/^(nc|n\/?c|no ?connect(ion)?|not connected|dnc|do not connect|reserved|rsvd)$/, 'nc'],
  [/^(gnd|ground|vss|0v)$/, 'ground'],
  [/^(power|pwr|supply|power in(put)?|power out(put)?|p|s)$/, 'power'],
  [/^(io|i\/o|bidir(ectional)?|in\/out|inout|b)$/, 'io'],
  [/^(oc|od|open[- ]?(collector|drain))$/, 'oc'],
  [/^(oe|os|open[- ]?(emitter|source))$/, 'oe'],
  [/^(hiz|hi-?z|tri-?state|three-?state|3-?state)$/, 'hiz'],
  [/^(in(put)?|i|di|ai)$/, 'input'],
  [/^(out(put)?|o|do|ao)$/, 'output'],
];
function pinType(v: unknown): PinType {
  const t = str(v, 30).toLowerCase().trim();
  if (PIN_TYPES.includes(t as PinType)) return t as PinType;
  return TYPE_WORDS.find(([re]) => re.test(t))?.[1] ?? 'passive';
}

export const PINS: JobSpec<PinsInput, PinsRead> = {
  kind: 'pins',
  version: 1,
  role: 'text',
  roleOf: (i) => (i.pictures?.length ? 'vision' : 'text'),
  maxTokens: 16000,
  effort: 'low',
  size: (i) => (i.pages ?? []).reduce((s, p) => s + p.text.length, 0),
  blank: { device: '', variant: { partNumbers: [], package: '', pins: 0, pinout: 'A', leadForm: 'unknown' }, pages: [], pictures: [], pageCount: 5000 },
  messages(i) {
    const v = i.variant;
    const known = [`Variant: package "${str(v?.package, 80)}"`, v?.pins ? `${v.pins} pins` : '', v?.pinout ? `pinout ${str(v.pinout, 3)}` : '', v?.leadForm && v.leadForm !== 'unknown' ? v.leadForm : ''].filter(Boolean).join(', ');
    const parts = (v?.partNumbers ?? []).slice(0, 6).map((p) => str(p, 60)).join(', ');
    const head = `Device: ${str(i.device, 80) || 'unknown'}\n${known}${parts ? `\nPart numbers: ${parts}` : ''}`;
    const text = (i.pages ?? []).length ? `\n\n${pageBlock(i.pages)}` : '\n\n(The datasheet has no pin table for this variant: give the pins its package and part type imply, and say so in notes.)';
    return [{ role: 'system', content: PINS_SYSTEM }, { role: 'user', content: withPictures(`${head}${text}`, i.pictures) }];
  },
  check(answer, i) {
    const a = obj(answer);
    const kind = str(a.kind, 12).toLowerCase() as PartKind;
    const seen = new Set<string>();
    const pins: SymbolPin[] = [];
    for (const raw of Array.isArray(a.pins) ? a.pins.slice(0, 2000) : []) {
      const p = obj(raw);
      const number = str(p.number ?? p.pin ?? p.designator, 12).replace(/\s+/g, '');
      if (!number || seen.has(number.toUpperCase())) continue;
      seen.add(number.toUpperCase());
      let name = str(p.name, 40);
      let activeLow = bool(p.activeLow) === true;
      // An active-low mark left on the name: taken off and said
      const m = /^[#/~!](.+)$|^(.+?)(#|\/|_N)$/.exec(name);
      if (m && name.length > 1) { name = (m[1] ?? m[2])!; activeLow = true; }
      pins.push({ number, name: name || number, activeLow, type: pinType(p.type), group: str(p.group, 24), description: str(p.description, 120) });
    }
    if (!pins.length) throw new Error('No pins were read');
    return {
      kind: PART_KINDS.includes(kind) ? kind : 'other',
      prefix: str(a.prefix, 4).toUpperCase().replace(/[^A-Z]/g, '') || 'U',
      pins, pages: pages(a.pages, i.pageCount || 5000), notes: str(a.notes, 600),
    };
  },
};

/* ─── Advise: a design reviewed as an experienced engineer would ─────────────────────── */

export interface AdviseInput {
  /** The design as text: its parts, each pin with its net, and its nets (src/ai/advise.ts writes it). */
  design: string;
  /** What the designer wants looked at especially ('' : everything). */
  focus: string;
  /** Findings the designer dismissed before (their titles): not reported again. */
  dismissed: string[];
  /** What the parts' datasheets say (each part checked against its own already), and what those checks found (titles). */
  facts?: string;
  known?: string[];
}
export type Severity = 'error' | 'warning' | 'suggestion';
export const SEVERITIES: Severity[] = ['error', 'warning', 'suggestion'];
/** A finding: how bad, what, why, what to do, and the parts and nets it is about. */
export interface Finding { severity: Severity; title: string; detail: string; fix: string; parts: string[]; nets: string[]; pages?: number[] }
export interface Advice { summary: string; findings: Finding[] }

const ADVISE_SYSTEM = `You are an experienced electronics design engineer reviewing a schematic before PCB layout, for a PCB design tool. You get the design as text: its parts (designator, value or comment, library reference, footprint, description, parameters), each part's pins (number, name, electrical type, the net it is on, or nc: not connected), and its nets with their pins.

Find the problems a careful engineer would raise in a design review, using what you know of the parts (from their part numbers, values and descriptions) and of good practice. Among others:
- supplies: every supply and ground pin of each IC connected to a suitable rail; decoupling capacitors for each IC's supplies; input and output capacitors of regulators and converters as their datasheets usually require; analogue supplies and references (AVCC, VREF) connected and filtered; rails whose names say a voltage the parts on them can't take
- inputs: inputs left floating, or enable, reset and boot pins without a defined level; open-collector and open-drain outputs (I2C, interrupts, resets) without a pull-up; pull-ups missing or more than one set on a bus
- interfaces: UART TX to RX (not TX to TX); I2C SDA and SCL; SPI chip selects; USB D+ and D− the right way round, USB-C CC resistors; CAN and RS-485 termination; ESD protection on connectors to the outside
- parts: LEDs without a series resistor; crystals without load capacitors; MOSFET gates floating; diodes and polarised capacitors on a rail the wrong way; voltage dividers on feedback pins against the output they set; footprints too small for what the part must carry; values missing
- nets: names that look like one signal but are separate nets (VCC and VCC_3V3, SDA and SDA1), nets with a single pin (a label used once), the same rail named differently on two sheets
Don't repeat what an electrical rule check already reports (duplicate designators, wires that end nowhere) unless it breaks how the circuit works.

Rules:
- Only parts, pins and nets that are in the design: name them exactly as written there.
- severity: error (it won't work, or something will be damaged), warning (likely a problem, or risky), suggestion (better practice, or worth checking against the datasheet).
- When it depends on a datasheet you don't know for sure, say so in detail and make it a suggestion.
- detail: why, in a sentence or three; fix: what to change, with values where you can give them.
- The most important first, at most 40. A design with nothing wrong gets no findings, and the summary says so.

Reply with JSON only, in this shape:
{"summary": "One short paragraph: what the design is, and how it looks overall.",
 "findings": [{"severity": "warning", "title": "No pull-ups on the I2C bus", "detail": "SDA and SCL are open drain: without pull-ups they never go high.", "fix": "Add 4.7 kΩ from SDA and SCL to +3V3, once for the bus.", "parts": ["U1", "U3"], "nets": ["SDA", "SCL"]}]}`;

const SEVERITY_WORDS: [RegExp, Severity][] = [[/^(err|crit|fatal|must|high|severe)/, 'error'], [/^(warn|risk|likely|medium|caution)/, 'warning']];

export const ADVISE: JobSpec<AdviseInput, Advice> = {
  kind: 'advise',
  version: 2,
  role: 'text',
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => (i.design?.length ?? 0) + (i.focus?.length ?? 0) + (typeof i.facts === 'string' ? i.facts.length : 0),
  blank: { design: '', focus: '', dismissed: [] },
  messages(i) {
    const focus = str(i.focus, 400);
    const dismissed = (Array.isArray(i.dismissed) ? i.dismissed : []).map((d) => str(d, 160)).filter(Boolean).slice(0, 60);
    const known = (Array.isArray(i.known) ? i.known : []).map((d) => str(d, 160)).filter(Boolean).slice(0, 120);
    const facts = typeof i.facts === 'string' ? i.facts.slice(0, 60_000).trim() : '';
    const head = [focus ? `Look especially at: ${focus}` : '', dismissed.length ? `The designer dismissed these before (not problems, or known): don't report them again.\n${dismissed.map((d) => `- ${d}`).join('\n')}` : '',
      known.length ? `Each part has been checked against its own datasheet already, which found these: don't report them again; look at how the parts work together.\n${known.map((d) => `- ${d}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const tail = facts ? `\n\nWhat the parts' datasheets say:\n${facts}` : '';
    return [{ role: 'system', content: ADVISE_SYSTEM }, { role: 'user', content: `${head ? `${head}\n\n` : ''}${typeof i.design === 'string' ? i.design : ''}${tail}` }];
  },
  check(answer) {
    const a = obj(answer);
    if (!Array.isArray(a.findings) && typeof a.summary !== 'string') throw new Error('No review came back');
    return { summary: str(a.summary, 1500), findings: findingsOf(a.findings, 60) };
  },
};

/** Findings as a model gives them: severities in its words, each title once, the worst first (each kind in its order). */
function findingsOf(v: unknown, most: number): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const list = (x: unknown, max: number) => (Array.isArray(x) ? x : typeof x === 'string' ? x.split(/[,\s]+/) : []).map((y) => str(y, max)).filter(Boolean).slice(0, 40);
  for (const raw of Array.isArray(v) ? v.slice(0, 80) : []) {
    const f = obj(raw);
    const title = str(f.title, 160);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const word = str(f.severity, 20).toLowerCase();
    const severity: Severity = SEVERITIES.includes(word as Severity) ? word as Severity : SEVERITY_WORDS.find(([re]) => re.test(word))?.[1] ?? 'suggestion';
    const pages = (Array.isArray(f.pages) ? f.pages : typeof f.pages === 'number' ? [f.pages] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 5000).slice(0, 8);
    findings.push({ severity, title, detail: str(f.detail, 1500), fix: str(f.fix, 800), parts: list(f.parts, 24), nets: list(f.nets, 80), ...(pages.length ? { pages } : {}) });
  }
  findings.sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity));
  return findings.slice(0, most);
}

/* ─── A board reviewed before it is made ─────────────────────────────────────────────── */

export interface BoardInput {
  /** The board as text, with its measurements worked out (src/ai/boardAdvise.ts writes it). */
  board: string;
  /** The project's schematic as text, when there is one (what the parts are, which pins are supplies). */
  design: string;
  /** What the parts' datasheets say (a schematic check in depth gathers it). */
  facts: string;
  focus: string;
  dismissed: string[];
}

const BOARD_SYSTEM = `You are an experienced PCB layout engineer reviewing a board before it is sent to be made, for a PCB design tool. You get the board as text — its size and copper layers, its design rules, each component's footprint, side and position (mm from the board's origin), measurements worked out for you (each IC supply pad's nearest capacitors on its net and their distances, crystals' distances to the pins they drive, each net's track length, widths, layers, vias, pours and unrouted connections, differential pairs' lengths, parts by the board's edge, exposed pads and the vias in them) — and, when there is one, its schematic's parts and nets, and what the parts' datasheets say.

Find what a careful layout engineer would raise. Among others:
- connections still unrouted; nets with no copper
- decoupling capacitors too far from the supply pins they serve (more than about 2–3 mm, or on the other side), a supply pin with none
- supply and high-current nets (regulators' inputs and outputs, motor and LED drivers, connectors bringing power in) too narrow for the current the parts suggest, or through too few vias
- crystals far from their IC (more than about 5–10 mm), clocks and fast signals routed long
- differential pairs (USB, Ethernet, LVDS) of unequal length or split across layers
- no ground pour or plane (a two-layer board with no ground pour), ground split up
- exposed pads without thermal vias when the part dissipates; regulators and power parts without copper to spread heat
- connectors and switches away from the board's edge; parts too close to it
- the design rules themselves: clearance and widths that a fab may not make, or wider than the board uses

Rules:
- Only components and nets that are on the board: name them exactly as written there.
- severity: error (won't work, or can't be made), warning (likely a problem, or risky), suggestion (better practice).
- detail: why, with the numbers from the board; fix: what to change, with values (mm).
- The most important first, at most 40. A board with nothing to change gets no findings, and the summary says so.

Reply with JSON only, in this shape:
{"summary": "One short paragraph: what the board is, and how its layout looks overall.",
 "findings": [{"severity": "warning", "title": "C5 too far from U2's supply pin", "detail": "U2-7 (+3V3) has its nearest capacitor 9.4 mm away.", "fix": "Move C5 within 2 mm of U2-7, on the same side.", "parts": ["U2", "C5"], "nets": ["+3V3"]}]}`;

export const BOARD: JobSpec<BoardInput, Advice> = {
  kind: 'board',
  version: 1,
  role: 'text',
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => (i.board?.length ?? 0) + (i.design?.length ?? 0) + (i.facts?.length ?? 0),
  blank: { board: '', design: '', facts: '', focus: '', dismissed: [] },
  messages(i) {
    const focus = str(i.focus, 400);
    const dismissed = (Array.isArray(i.dismissed) ? i.dismissed : []).map((d) => str(d, 160)).filter(Boolean).slice(0, 60);
    const text = [focus ? `Look especially at: ${focus}` : '', dismissed.length ? `The designer dismissed these before (not problems, or known): don't report them again.\n${dismissed.map((d) => `- ${d}`).join('\n')}` : '',
      typeof i.board === 'string' ? i.board : '', typeof i.design === 'string' && i.design.trim() ? `Its schematic:\n${i.design}` : '',
      typeof i.facts === 'string' && i.facts.trim() ? `What the parts' datasheets say:\n${i.facts.slice(0, 60_000)}` : ''].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: BOARD_SYSTEM }, { role: 'user', content: text }];
  },
  check(answer) {
    const a = obj(answer);
    if (!Array.isArray(a.findings) && typeof a.summary !== 'string') throw new Error('No review came back');
    return { summary: str(a.summary, 1500), findings: findingsOf(a.findings, 60) };
  },
};

/* ─── A part's datasheet, found on the web ───────────────────────────────────────────── */

export interface FindInput { mpn: string; maker: string; description: string }
/** Where its datasheet is: addresses to try, a PDF's first. */
export interface Found { urls: string[]; maker: string; title: string }

const FIND_SYSTEM = `You find the datasheet of an electronic component on the web, for a PCB design tool that will download and read it. You get the maker's part number (and the maker and what the part is, when known), and web search results.

Reply with JSON only, in this shape:
{"url": "https://www.ti.com/lit/ds/symlink/tps7a02.pdf", "page": "https://www.ti.com/product/TPS7A02", "maker": "Texas Instruments", "title": "TPS7A02 nA-IQ 200-mA LDO regulator"}

Rules:
- url: a direct link to the datasheet PDF, from the maker's own site when there is one (not a distributor's copy unless the maker has none, never a datasheet aggregator's viewer page). Empty if none was found.
- page: the maker's product page for the part (it links the datasheet), or empty.
- The part number may have a packing or temperature suffix: the datasheet of its family is right.`;

export const FIND: JobSpec<FindInput, Found> = {
  kind: 'datasheet',
  version: 1,
  role: 'text',
  maxTokens: 1500,
  web: 5,
  size: (i) => (i.mpn?.length ?? 0) + (i.description?.length ?? 0),
  blank: { mpn: '', maker: '', description: '' },
  messages: (i) => [{ role: 'system', content: FIND_SYSTEM },
    { role: 'user', content: `${str(i.mpn, 60)} datasheet${str(i.maker, 60) ? ` ${str(i.maker, 60)}` : ''}${str(i.description, 120) ? ` (${str(i.description, 120)})` : ''}` }],
  check(answer) {
    const a = obj(answer);
    const url = (v: unknown) => { const u = str(v, 600); return /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : ''; };
    const sources = (Array.isArray(a.sources) ? a.sources : []).map(url).filter(Boolean);
    const all = [...new Set([url(a.url), url(a.page), ...sources].filter(Boolean))];
    // A PDF first, then the pages that may link one
    const urls = [...all.filter((u) => /\.pdf(\?|#|$)/i.test(u)), ...all.filter((u) => !/\.pdf(\?|#|$)/i.test(u))].slice(0, 8);
    if (!urls.length) throw new Error('No datasheet was found');
    return { urls, maker: str(a.maker, 80), title: str(a.title, 160) };
  },
};

/* ─── A part checked against its datasheet ───────────────────────────────────────────── */

export interface PartInput {
  /** The part as the design's text writes it (its line and its pins with their nets). */
  part: string;
  /** What is on each of its nets (the other pins, with their parts' values). */
  around: string;
  /** Its datasheet: where it came from, and the pages picked (pin functions, ratings, the application circuit, layout). */
  datasheet: { source: string; pageCount: number; pages: PageText[] };
  /** Pictures of the datasheet's application circuit (for a model that takes them). */
  pictures: Picture[];
  focus: string;
}
/** What the datasheet asks of the design (a few lines, for the design-wide check), and what doesn't meet it. */
export interface PartChecked { facts: string; findings: Finding[] }

const PART_SYSTEM = `You are an experienced electronics design engineer checking one part of a schematic against its datasheet before PCB layout. You get the part (value, library reference, footprint, each pin with the net it is on, nc: not connected), what is on each of its nets (the other parts' pins, with their values), and pages of its datasheet (text, each page starting "=== Page N ===", and pictures of some).

Check pin by pin, and the part as a whole, against what the datasheet requires:
- each pin's function: is what it connects to right (supplies to the right rail, inputs driven or tied as the datasheet says, outputs not shorted together, pins that must not float or must be left open)
- the external parts the datasheet asks for (capacitors on supplies, references and bootstrap pins, resistors setting outputs, pull-ups, crystals' load capacitors, inductors and diodes of converters), with their values where the design gives them
- voltages: the rails it is on, by their names and the parts making them, against its recommended operating conditions and absolute maximum ratings
- the symbol and footprint against the datasheet: pin numbers and names that disagree with the pin table, an exposed pad left unconnected when it must be tied
- anything the datasheet's layout or application section says that matters at this stage

Rules:
- Only what the datasheet pages support, or plain good practice; give the page for each finding (pages).
- severity: error (won't work, or damage), warning (likely a problem, out of the recommended range, or risky), suggestion (better practice).
- Name parts, pins and nets exactly as the design writes them. detail: why, citing the datasheet; fix: what to change, with values.
- facts: what the datasheet asks of the design, in at most eight short lines (supply range and absolute maximum, required external parts with values, pins that must not float, level limits of its I/O, and what its layout guidelines ask: capacitors' distances, thermal vias, keep-outs), for later checks of the design as a whole and of its board.

Reply with JSON only, in this shape:
{"facts": "VIN 1.5–6.0 V (abs max 6.5 V); needs ≥1 µF on IN and OUT; EN must not float.",
 "findings": [{"severity": "warning", "title": "U3 EN left floating", "detail": "EN has no internal pull-up (page 15): the output may not turn on.", "fix": "Tie EN to VIN, or drive it from the MCU with a 100 kΩ pull-down.", "parts": ["U3"], "nets": ["NetU3_4"], "pages": [15]}]}`;

export const PART: JobSpec<PartInput, PartChecked> = {
  kind: 'part',
  version: 1,
  role: 'text',
  roleOf: (i) => (i.pictures?.length ? 'vision' : 'text'),
  maxTokens: 12000,
  effort: 'medium',
  size: (i) => (i.part?.length ?? 0) + (i.around?.length ?? 0) + (i.datasheet?.pages ?? []).reduce((n, p) => n + (p.text?.length ?? 0), 0),
  blank: { part: '', around: '', datasheet: { source: '', pageCount: 5000, pages: [] }, pictures: [], focus: '' },
  messages(i) {
    const focus = str(i.focus, 400);
    const ds = i.datasheet ?? { source: '', pageCount: 0, pages: [] };
    const text = `${focus ? `Look especially at: ${focus}\n\n` : ''}The part:\n${typeof i.part === 'string' ? i.part.slice(0, 20_000) : ''}\n\nOn its nets:\n${typeof i.around === 'string' ? i.around.slice(0, 30_000) : ''}\n\nIts datasheet (${str(ds.source, 300) || 'given by the designer'}, ${ds.pageCount || '?'} pages; these pages picked):\n${pageBlock(ds.pages ?? [])}`;
    return [{ role: 'system', content: PART_SYSTEM }, { role: 'user', content: withPictures(text, i.pictures) }];
  },
  check(answer, i) {
    const a = obj(answer);
    if (!Array.isArray(a.findings) && typeof a.facts !== 'string') throw new Error('No check came back');
    const pc = i.datasheet?.pageCount || 5000;
    const findings = findingsOf(a.findings, 30).map((f) => (f.pages ? { ...f, pages: f.pages.filter((n) => n <= pc) } : f));
    return { facts: str(a.facts, 900), findings };
  },
};

/* ─── A question about the design and its review ─────────────────────────────────────── */

export interface AskInput {
  design: string;
  /** What the parts' datasheets say, and the review so far, as text. */
  facts: string;
  review: string;
  history: { q: string; a: string }[];
  question: string;
}
export interface Answered { answer: string; parts: string[]; nets: string[] }

const ASK_SYSTEM = `You are an experienced electronics design engineer answering a designer's questions about their schematic or board, which you have reviewed. You get the design as text (its parts, each pin with its net, its nets; for a board, its layout and measurements too), what the parts' datasheets say, your review so far, the questions asked before with your answers, and the new question.

Answer it as a colleague would: directly, specifically to this design, with values where they help; say when it depends on something you can't see (a datasheet page you don't have, the layout). Plain text, a short paragraph or a few lines; no markdown headings.

Reply with JSON only: {"answer": "…", "parts": ["U3", "C7"], "nets": ["+3V3"]} — parts and nets: those the answer is about, written exactly as the design writes them.`;

export const ASK: JobSpec<AskInput, Answered> = {
  kind: 'ask',
  version: 1,
  role: 'text',
  maxTokens: 8000,
  effort: 'medium',
  size: (i) => (i.design?.length ?? 0) + (i.facts?.length ?? 0) + (i.review?.length ?? 0) + (i.question?.length ?? 0),
  blank: { design: '', facts: '', review: '', history: [], question: '' },
  messages(i) {
    const history = (Array.isArray(i.history) ? i.history : []).slice(-8).map((h) => `Q: ${str(h?.q, 1000)}\nA: ${str(h?.a, 3000)}`).join('\n\n');
    const text = [typeof i.design === 'string' ? i.design : '', typeof i.facts === 'string' && i.facts.trim() ? `What the parts' datasheets say:\n${i.facts.slice(0, 60_000)}` : '',
      typeof i.review === 'string' && i.review.trim() ? `Your review:\n${i.review.slice(0, 40_000)}` : '', history ? `Asked before:\n${history}` : '', `The question: ${str(i.question, 2000)}`].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: text }];
  },
  check(answer) {
    const a = obj(answer);
    const text = typeof a.answer === 'string' ? a.answer.trim().slice(0, 6000) : '';
    if (!text) throw new Error('No answer came back');
    const list = (x: unknown, max: number) => (Array.isArray(x) ? x : []).map((y) => str(y, max)).filter(Boolean).slice(0, 30);
    return { answer: text, parts: list(a.parts, 24), nets: list(a.nets, 80) };
  },
};

/** The addresses a web search's answer cites (OpenRouter's url_citation annotations). */
export function citations(annotations: unknown): string[] {
  const out: string[] = [];
  for (const a of Array.isArray(annotations) ? annotations : []) {
    const u = (a as { url_citation?: { url?: unknown } })?.url_citation?.url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  }
  return out.slice(0, 12);
}
/** A web search's answer with the pages it found (an answer that isn't JSON: the pages alone). */
export function withSources(text: string, sources: string[]): unknown {
  let v: unknown;
  try { v = parseJsonAnswer(text); } catch { v = null; }
  if (!sources.length) return v ?? parseJsonAnswer(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as object), sources } : { sources };
}

/* ─── Part numbers for a BOM's lines ─────────────────────────────────────────────────── */

export interface MpnLine {
  /** The line's key in the BOM (echoed back). */
  id: string;
  designators: string;
  comment: string;
  description: string;
  footprint: string;
  /** Other parameters worth knowing (Value, Tolerance, Voltage …), "Name=value; …". */
  params: string;
}
export interface MpnInput {
  lines: MpnLine[];
  /** Where the board is to be assembled: JLCPCB (LCSC numbers, its Basic parts first), or anywhere. */
  prefer: 'jlcpcb' | 'any';
  /** What the designer asks for besides (automotive grade, a maker …). */
  focus: string;
}
export interface MpnSuggestion { id: string; manufacturer: string; mpn: string; lcsc: string; confidence: 'high' | 'medium' | 'low'; why: string }
export interface MpnAnswer { parts: MpnSuggestion[] }

const MPN_SYSTEM = `You are an experienced electronics engineer choosing real, orderable parts for the lines of a bill of materials, for a PCB design tool. Each line has its designators, comment, description, footprint and parameters.

For each line, choose one manufacturer part that fits it:
- match everything the line says: value, tolerance, voltage, current and power ratings, dielectric (MLCC: X7R or X5R unless the line says otherwise; C0G/NP0 for small values in timing or RF), temperature range, and the package — take the package from the footprint's name (0402, 0603, SOT-23-5, SOIC-8, QFN-32 …) and the description;
- a line that names its part already (a part number in its comment, description or parameters): that part, with its maker;
- capacitors' voltage rating at least 1.5 to 2 times the rail they are on, where the line says which;
- common, in-production parts from major makers (Yageo, Samsung Electro-Mechanics, Murata, TDK, UNI-ROYAL, Vishay, Texas Instruments, STMicroelectronics, onsemi, Nexperia …), never obsolete or not-recommended ones;
- never invent a part number: when you don't know one that you are sure exists, leave mpn empty and say why.

When the board is to be assembled at JLCPCB, prefer parts JLCPCB stocks — its Basic parts for resistors, capacitors, LEDs and common diodes and transistors — and give the part's LCSC number (C followed by digits) when you know it; never guess an LCSC number.

confidence: high (the part surely fits and exists), medium (fits, check the details), low (a best guess).
why: one short sentence — what you matched, or what the line doesn't say.

Reply with JSON only, in this shape:
{"parts": [{"id": "the line's id", "manufacturer": "Yageo", "mpn": "RC0603FR-0710KL", "lcsc": "C98220", "confidence": "high", "why": "10 kΩ 1% 0603 thick film"}]}`;

export const MPN: JobSpec<MpnInput, MpnAnswer> = {
  kind: 'mpn',
  version: 1,
  role: 'text',
  maxTokens: 12000,
  effort: 'medium',
  size: (i) => JSON.stringify(i.lines ?? []).length + (i.focus?.length ?? 0),
  blank: { lines: [], prefer: 'any', focus: '' },
  messages(i) {
    const lines = (Array.isArray(i.lines) ? i.lines : []).slice(0, 200).map((l) => {
      const x = obj(l);
      return [`id: ${str(x.id, 40)}`, `designators: ${str(x.designators, 200)}`, `comment: ${str(x.comment, 200)}`, `description: ${str(x.description, 300)}`, `footprint: ${str(x.footprint, 120)}`,
        str(x.params, 600) ? `parameters: ${str(x.params, 600)}` : ''].filter(Boolean).join('\n');
    });
    const focus = str(i.focus, 400);
    const where = i.prefer === 'jlcpcb' ? 'The board is to be assembled at JLCPCB.' : 'The parts will be bought from any distributor.';
    return [{ role: 'system', content: MPN_SYSTEM }, { role: 'user', content: `${where}${focus ? `\nAlso: ${focus}` : ''}\n\nThe lines:\n\n${lines.join('\n\n')}` }];
  },
  check(answer, input) {
    const a = obj(answer);
    if (!Array.isArray(a.parts)) throw new Error('No parts came back');
    const ids = new Set((input.lines ?? []).map((l) => l.id));
    const seen = new Set<string>();
    const parts: MpnSuggestion[] = [];
    for (const raw of a.parts.slice(0, 250)) {
      const p = obj(raw);
      const id = str(p.id, 40);
      if (!id || seen.has(id) || (ids.size && !ids.has(id))) continue;
      seen.add(id);
      const lcsc = str(p.lcsc, 20).toUpperCase();
      const conf = str(p.confidence, 10).toLowerCase();
      parts.push({ id, manufacturer: str(p.manufacturer, 80), mpn: str(p.mpn, 80).replace(/\s+/g, ''), lcsc: /^C\d{2,9}$/.test(lcsc) ? lcsc : '',
        confidence: conf === 'high' || conf === 'medium' ? conf : 'low', why: str(p.why, 300) });
    }
    return { parts };
  },
};

/* ─── Requirements: a specification split into requirements ──────────────────────────── */

export interface ReqsInput {
  /** The specification's text (headings on their own lines where the document had them). */
  text: string;
  /** Its name (the file's, or what the designer called it). */
  title: string;
}
export type DraftType = 'functional' | 'electrical' | 'mechanical' | 'environmental' | 'interface' | 'compliance' | 'other';
export type DraftPriority = 'must' | 'should' | 'could';
export type DraftMethod = 'test' | 'analysis' | 'inspection' | 'review';
export interface DraftReq { section: string; ref: string; title: string; text: string; type: DraftType; priority: DraftPriority; method: DraftMethod; pictures: number[] }
export interface ReqsAnswer { requirements: DraftReq[] }
const DRAFT_TYPES: DraftType[] = ['functional', 'electrical', 'mechanical', 'environmental', 'interface', 'compliance', 'other'];
const DRAFT_METHODS: DraftMethod[] = ['test', 'analysis', 'inspection', 'review'];
/** The most requirements one answer brings, and the most specification text sent. */
export const MAX_DRAFTS = 400, MAX_SPEC = 240_000;

const REQS_SYSTEM = `You are an experienced electronics systems engineer splitting a product specification into single, verifiable requirements, for a PCB design tool's requirements list. You get the specification's text.

Rules:
- one requirement per thing to verify: a sentence that asks for two things (a voltage range and a current) becomes two requirements;
- keep the specification's words, figures, units, tolerances and conditions exactly; never round, convert or invent a figure, and never add a requirement the text doesn't state;
- leave out what isn't a requirement: background, rationale, definitions, document history, references, tables of contents;
- a requirement stated twice is listed once;
- section: the heading the requirement is under, as the specification words it (without its number), or "" when there is none;
- ref: the specification's own number or identifier for the clause (e.g. "3.2.1", "REQ-014"), or "";
- title: a short name, at most 8 words (e.g. "Input voltage range", "Board fits the housing");
- text: the requirement as one or two plain sentences, in the specification's words where it has them; "shall" where it says shall or must; when its figures are in a table, the rows it needs as a Markdown table under the sentences (a | Heading | Heading | line, a |---|---| line, then a | value | value | line a row);
- pictures: a [Picture N] marker in the text stands for a picture there (a drawing, a diagram, a photo); list the numbers of the pictures a requirement refers to or needs (e.g. "as shown in Figure 3" beside [Picture 3], or a drawing in its clause), [] when none;
- type: functional (what the product does), electrical (voltages, currents, power, signals), mechanical (size, mounting, weight, connectors' placement), environmental (temperature, humidity, vibration, ingress), interface (connectors, buses, protocols, user interface), compliance (standards, certification, safety, EMC), or other;
- priority: must (shall, must, is required), should (should, is recommended), could (may, can, optional, nice to have);
- method: how it would be verified: test (measured on the product), analysis (calculation, simulation), inspection (looking at the design or the product), or review (reading documents).

Reply with JSON only, in this shape, in the specification's order:
{"requirements": [{"section": "Power", "ref": "3.1", "title": "Input voltage range", "text": "The board shall operate from 9 V to 36 V DC.", "type": "electrical", "priority": "must", "method": "test", "pictures": []}]}`;

export const REQS: JobSpec<ReqsInput, ReqsAnswer> = {
  kind: 'reqs',
  version: 2,
  role: 'text',
  cheap: true,
  maxTokens: 24000,
  effort: 'medium',
  size: (i) => (typeof i.text === 'string' ? i.text.length : 0) + (typeof i.title === 'string' ? i.title.length : 0),
  blank: { text: '', title: '' },
  messages(i) {
    const text = (typeof i.text === 'string' ? i.text : '').slice(0, MAX_SPEC);
    if (!text.trim()) throw new Error('The specification has no text');
    return [{ role: 'system', content: REQS_SYSTEM }, { role: 'user', content: `The specification${str(i.title, 120) ? ` "${str(i.title, 120)}"` : ''}:\n\n${text}` }];
  },
  check(answer) {
    const a = obj(answer);
    const list = Array.isArray(a.requirements) ? a.requirements : null;
    if (!list) throw new Error('No requirements came back');
    const out: DraftReq[] = [];
    const seen = new Set<string>();
    for (const raw of list.slice(0, MAX_DRAFTS)) {
      const r = obj(raw);
      // Spaces tidied within lines; the lines of a table kept
      const text = str(r.text, 8000).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const title = str(r.title, 120).replace(/\s+/g, ' ') || text.split('\n')[0]!.slice(0, 80);
      if (!text && !title) continue;
      const key = `${title}|${text}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const type = str(r.type, 20).toLowerCase() as DraftType;
      const method = str(r.method, 20).toLowerCase() as DraftMethod;
      const p = str(r.priority, 20).toLowerCase();
      out.push({ section: str(r.section, 120).replace(/\s+/g, ' '), ref: str(r.ref, 40), title, text,
        type: DRAFT_TYPES.includes(type) ? type : 'other', priority: p === 'should' || p === 'could' ? p : p === 'may' ? 'could' : 'must', method: DRAFT_METHODS.includes(method) ? method : 'test',
        pictures: [...new Set((Array.isArray(r.pictures) ? r.pictures : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 9999))].slice(0, 20) });
    }
    return { requirements: out };
  },
};

/* ── the Requirements Adviser: a conversation about a requirements document ── */

/** A requirement as the adviser reads it (plain text; the rest of the document isn't sent). */
export interface AdviceReq { id: string; parent?: string; section: string; title: string; text: string; type: string; priority: string; status: string; method: string; source?: string }
export interface AdviceInput {
  reqs: AdviceReq[];
  /** The conversation so far: what was asked and what the adviser answered. */
  history: { ask: string; reply: string }[];
  ask: string;
  /** The requirement picked in the document (what "this one" means). */
  picked?: string;
  /** The project's name and what the design holds, in a line or two (its parts' kinds, its nets' count), when known. */
  design?: string;
}
/** A change the adviser proposes to a requirement (only the fields it would change; parent "" for none). */
export interface AdviceChange { id: string; title?: string; text?: string; type?: DraftType; priority?: 'must' | 'should' | 'could'; method?: DraftMethod; parent?: string; status?: 'draft' | 'approved' | 'obsolete'; why: string }
/** A requirement it proposes to add: its own reference (N1, N2) until it has an identifier, its parent an identifier or such a reference. */
export interface AdviceAdd { ref: string; parent?: string; section?: string; title: string; text: string; type: DraftType; priority: 'must' | 'should' | 'could'; method: DraftMethod; why: string }
export interface AdviceAnswer { reply: string; changes: AdviceChange[]; added: AdviceAdd[] }
export const MAX_ADVICE_REQS = 400, MAX_ADVICE_TEXT = 60_000;

const ADVISE_REQS_SYSTEM = `You are a senior electronics systems engineer working with the user on the requirements of a product designed in a PCB design tool. You get the requirements document (each requirement's identifier, parent, section, title, text, type, priority, status and verification method), the conversation so far and the user's request. Help them build and improve the requirements: review them, rewrite them, break them down, put them in a hierarchy, find what is missing, and answer questions about them.

What good requirements are:
- one thing to verify each: a requirement asking for two things is two requirements (or a parent and its children);
- verifiable: a figure with its unit, tolerance and conditions (temperature, load, input range), not "fast", "small", "robust", "user friendly", "as required", "etc.", "and/or", "TBD" left unexplained;
- "shall" for what must hold, "should" for what is wanted, "may" for what is allowed;
- the need, not a design choice, unless the design choice is the requirement;
- no two saying the same thing, none contradicting another;
- a hierarchy: a broad requirement (the board's power input) is the parent of the detailed ones (its voltage range, its reverse-polarity protection, its inrush current); a child refines its parent and never contradicts it.

Rules:
- propose, never decide: every change and every new requirement comes with a short reason (why), and the user applies the ones they want;
- never change a figure, unit, tolerance or condition the user wrote unless they ask, or it is plainly a typo (then say so in why); when a figure is missing, propose a placeholder the user must fill as "[value]" (e.g. "[value] V") and say so, never invent one;
- keep the identifiers: change requirements by their id; a new requirement takes a ref N1, N2 and so on, and its parent is an existing id or another new one's ref;
- a parent must not make a loop (a requirement under one of its own children);
- type: functional, electrical, mechanical, environmental, interface, compliance or other; priority: must, should or could; method: test, analysis, inspection or review; status: draft, approved or obsolete (propose obsolete rather than deleting);
- with "this one", "it" or "the picked one" the user means the requirement picked, given as picked;
- reply: what you found or did, short and practical, in the language the user writes in; with nothing to change, say so and leave changes and added empty; answer a question in reply alone.

Reply with JSON only, in this shape:
{"reply": "Three of them aren't verifiable; I've broken REQ-004 down and put the power requirements under REQ-002.", "changes": [{"id": "REQ-004", "text": "The board shall draw at most 250 mA from 12 V at 25 °C.", "why": "No limit was given: a figure makes it testable"}, {"id": "REQ-007", "parent": "REQ-002", "why": "It details the power input"}], "added": [{"ref": "N1", "parent": "REQ-004", "title": "Standby current", "text": "In standby the board shall draw at most [value] mA from 12 V.", "type": "electrical", "priority": "must", "method": "test", "why": "Standby isn't covered; the figure is yours to give"}]}`;

export const ADVISE_REQS: JobSpec<AdviceInput, AdviceAnswer> = {
  kind: 'reqadvise',
  version: 1,
  role: 'text',
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => JSON.stringify(i ?? {}).length,
  blank: { reqs: [], history: [], ask: '' },
  messages(i) {
    const ask = str(i.ask, 4000);
    if (!ask) throw new Error('Nothing asked');
    const reqs = (Array.isArray(i.reqs) ? i.reqs : []).slice(0, MAX_ADVICE_REQS).map((r0) => {
      const r = obj(r0);
      return { id: str(r.id, 40), ...(str(r.parent, 40) ? { parent: str(r.parent, 40) } : {}), section: str(r.section, 120), title: str(r.title, 200), text: str(r.text, 3000), type: str(r.type, 20), priority: str(r.priority, 10), status: str(r.status, 10), method: str(r.method, 12), ...(str(r.source, 200) ? { source: str(r.source, 200) } : {}) };
    });
    let doc = JSON.stringify(reqs);
    if (doc.length > MAX_ADVICE_TEXT) doc = `${doc.slice(0, MAX_ADVICE_TEXT)}… (the rest left out)`;
    // (the conversation so far as a transcript: every provider takes it so)
    const history = (Array.isArray(i.history) ? i.history : []).slice(-8).map((h0) => { const h = obj(h0); return `The user: ${str(h.ask, 4000)}\nYou: ${str(h.reply, 4000)}`; }).join('\n\n');
    return [
      { role: 'system', content: ADVISE_REQS_SYSTEM },
      { role: 'user', content: `The requirements document${str(i.design, 600) ? ` (the design: ${str(i.design, 600)})` : ''}:\n${doc}${str(i.picked, 40) ? `\n\npicked: ${str(i.picked, 40)}` : ''}${history ? `\n\nThe conversation so far (the changes you proposed then were applied or not as the document now shows):\n${history}` : ''}\n\nThe user's request: ${ask}` },
    ];
  },
  check(answer, input) {
    const a = obj(answer);
    const ids = new Set((Array.isArray(input.reqs) ? input.reqs : []).map((r) => r.id));
    const reply = str(a.reply, 6000);
    const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => { const x = str(v, 20).toLowerCase(); return (list as readonly string[]).includes(x) ? x as T : undefined; };
    const changes: AdviceChange[] = [];
    for (const c0 of (Array.isArray(a.changes) ? a.changes : []).slice(0, 200)) {
      const c = obj(c0);
      const id = str(c.id, 40);
      if (!ids.has(id)) continue;
      const ch: AdviceChange = { id, why: str(c.why, 600) };
      if (typeof c.title === 'string') ch.title = str(c.title, 200).replace(/\s+/g, ' ');
      if (typeof c.text === 'string') ch.text = str(c.text, 6000);
      const t = pick(c.type, DRAFT_TYPES); if (t) ch.type = t;
      const p = pick(c.priority, ['must', 'should', 'could'] as const); if (p) ch.priority = p;
      const m = pick(c.method, DRAFT_METHODS); if (m) ch.method = m;
      const st = pick(c.status, ['draft', 'approved', 'obsolete'] as const); if (st) ch.status = st;
      if (typeof c.parent === 'string') ch.parent = str(c.parent, 40);
      if (Object.keys(ch).length > 2) changes.push(ch);
    }
    const added: AdviceAdd[] = [];
    const refs = new Set<string>();
    for (const n0 of (Array.isArray(a.added) ? a.added : []).slice(0, 100)) {
      const n = obj(n0);
      const title = str(n.title, 200).replace(/\s+/g, ' '), text = str(n.text, 6000);
      if (!title && !text) continue;
      let ref = str(n.ref, 20) || `N${added.length + 1}`;
      while (refs.has(ref) || ids.has(ref)) ref = `${ref}_`;
      refs.add(ref);
      added.push({ ref, ...(str(n.parent, 40) ? { parent: str(n.parent, 40) } : {}), ...(str(n.section, 120) ? { section: str(n.section, 120) } : {}), title: title || text.slice(0, 80), text,
        type: pick(n.type, DRAFT_TYPES) ?? 'other', priority: pick(n.priority, ['must', 'should', 'could'] as const) ?? 'must', method: pick(n.method, DRAFT_METHODS) ?? 'test', why: str(n.why, 600) });
    }
    if (!reply && !changes.length && !added.length) throw new Error('No answer came back');
    return { reply, changes, added };
  },
};

/** The scripting API, as a script's author (or the AI writing one) reads it. */
export const SCRIPT_API = `A script is the body of an async function: it may use await and return. It sees the board (or footprint) open in front, and changes it only through the methods below; what it changes shows at once in its own objects, and every change is made on the board when it ends, as one step Undo takes back. An error thrown (throw new Error('...')) or a stop changes nothing. It has no network, no DOM, no storage, no files but the ones it outputs, and stops after 20 seconds.

Units: millimetres from the board's origin (as the status bar shows it), x to the right, y upwards; angles in degrees anticlockwise from x, rotations 0 to 360. mil(10) = 0.254 mm, inch(0.1) = 2.54 mm, mm(1) = 1; toMil(mm), toInch(mm) the other way.

board.kind: 'board' or 'footprint'; board.name; board.outline: [{x, y}] (the board shape's corners; empty in a footprint); board.layers: layer names ('Top Layer', 'Mid-Layer 1', 'Bottom Layer', 'Top Overlay', 'Bottom Overlay', 'Top Paste', 'Top Solder', 'Keep-Out Layer', 'Multi-Layer', 'Mechanical 1' …); board.nets: net names (a script can't make nets).
board.components: parts {id, kind: 'component', designator, comment, footprint, x, y, rotation, side ('top' or 'bottom'), locked, pads()} (a footprint has none).
  moveTo(x, y), moveBy(dx, dy), rotateTo(deg), rotateBy(deg) (not a locked one; its pads and other primitives move and turn with it), setDesignator(text). Each returns the part.
Primitives (each has id and kind; component is its part's designator, or null when free):
board.pads: {name, component, net, x, y, layer, width, height, shape ('round', 'rect', 'roundrect', 'octagon'), hole (0: SMD), plated, rotation}.
board.tracks: {x1, y1, x2, y2, width, layer, net, component, keepout}; board.arcs: {x, y, radius, start, end, width, layer, net, component, keepout} (start to end anticlockwise; 0 to 360 a circle).
board.vias: {x, y, diameter, hole, net}; board.texts: {x, y, text, height, layer, rotation, component}.
board.regions: {points: [{x, y}], layer, net, component, keepout}; board.fills: {x1, y1, x2, y2, rotation, layer, net, component, keepout}.
  Each: remove() and moveBy(dx, dy) (free ones only); setNet(name or null) (not texts); setWidth(w) (tracks and arcs). Each but remove returns the primitive.
The lists hold what is there now (removed ones gone, added ones in); treat them as read-only. Pour copper, polygons, 3D bodies and hidden texts aren't listed.
board.selected: what is selected (a part selected whole as the part, else primitives); it follows board.select. board.component(designator); board.net(name): {name, pads, tracks, arcs, vias, regions, fills} on it.
board.addTrack({x1, y1, x2, y2, width = 0.254, layer = 'Top Layer', net}); board.addArc({x, y, radius, start = 0, end = 360, width = 0.254, layer, net});
board.addVia({x, y, diameter = 0.6, hole = 0.3, net}); board.addPad({x, y, name (the next number), width = 1, height = width, shape = 'round', hole = 0, layer ('Top Layer', 'Multi-Layer' with a hole), rotation = 0, net}); board.addText({x, y, text, height = 1, layer = 'Top Overlay', rotation = 0}); board.addRegion({points: [{x, y}] (3 or more), layer, net}). Each returns the new primitive.
board.select(objects or ids): what is selected afterwards.
output.text(name, text), output.csv(name, rows): files offered to save when the script ends (rows: arrays of cells; 20 files at most).
print(...values) or console.log(...values): lines under the script (5,000 at most).`;

export interface ScriptInput {
  /** What the script is to do, in the designer's words. */
  request: string;
  /** The script so far, when it is to be changed. */
  code?: string;
  kind: 'board' | 'footprint';
  /** A little about the board: its layers, nets, designator prefixes, what is selected. */
  context?: string;
}
export interface ScriptAnswer { name: string; code: string; explanation: string }

const SCRIPT_SYSTEM = `You write scripts for Konium Designer, a PCB design tool. A script is plain JavaScript run in a sandbox on the board or footprint open in front of the designer. You get what the script is to do, sometimes a script to change, and a little about the board.

The scripting API (everything a script can use; nothing else exists: no imports, no network, no DOM, no files but outputs):

${SCRIPT_API}

Write the script to do just what was asked, short and readable: settings the designer may want to change as constants at the top, with their units; a one-line comment first saying what it does; comments only where the reason isn't plain. When what it needs isn't there (nothing selected, no such net), throw new Error with a sentence the designer will understand. End with a print() saying what was done. British English in comments and messages. Don't invent API functions: when something can't be done with the API, say so in the explanation and do what can be done.

Reply with JSON only: {"name": "a short title (sentence case, under 50 characters)", "code": "the script", "explanation": "one or two sentences on what it does and what to select or change first"}.`;

export const SCRIPT: JobSpec<ScriptInput, ScriptAnswer> = {
  kind: 'script',
  version: 2,
  role: 'text',
  maxTokens: 16000,
  effort: 'medium',
  size: (i) => (typeof i.request === 'string' ? i.request.length : 0) + (typeof i.code === 'string' ? i.code.length : 0) + (typeof i.context === 'string' ? i.context.length : 0),
  blank: { request: '', kind: 'board' },
  messages(i) {
    const request = str(i.request, 4000);
    if (!request) throw new Error('Say what the script is to do');
    const code = str(i.code, 40000);
    const parts = [`The script is to work on a ${i.kind === 'footprint' ? 'footprint (in a PCB library)' : 'board'}.`, `What it is to do: ${request}`];
    if (code) parts.push(`The script to change:\n\`\`\`js\n${code}\n\`\`\``);
    const ctx = str(i.context, 4000);
    if (ctx) parts.push(`About the ${i.kind === 'footprint' ? 'footprint' : 'board'}:\n${ctx}`);
    return [{ role: 'system', content: SCRIPT_SYSTEM }, { role: 'user', content: parts.join('\n\n') }];
  },
  check(answer) {
    const a = obj(answer);
    let code = typeof a.code === 'string' ? a.code.slice(0, 60000) : '';
    // A script sent in a code fence
    const fence = /^\s*```(?:js|javascript)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(code);
    if (fence) code = fence[1]!;
    if (!code.trim()) throw new Error('No script came back');
    return { name: str(a.name, 80).replace(/\s+/g, ' ') || 'Script', code: code.replace(/\r\n/g, '\n').trimEnd() + '\n', explanation: str(a.explanation, 800) };
  },
};

/* ─── A board's layout, planned before a part is placed ──────────────────────────────── */

export interface LayoutInput {
  /** The board as the planner reads it (src/ai/layoutBrief.ts writes it): its outline, each part with its size, each net with its pins, with what the project's schematic says of them. */
  board: string;
  /** What the designer says the layout must do. */
  brief: string;
  /** The designators a plan may name (the board's): what the answer is checked against. */
  parts: string[];
  /** A second round: the plan made before, as text, what the placer made of it (what it could not meet, and by how much), and what the designer wants changed in it. */
  previous: string;
  result: string;
  remarks: string;
}

export type BoardEdge = 'left' | 'right' | 'top' | 'bottom';
export const BOARD_EDGES: BoardEdge[] = ['left', 'right', 'top', 'bottom'];
/** Parts that belong together, and where their middle goes: x and y as fractions of the board's width and height seen from the top (0, 0 the lower left). */
export interface PlanGroup { name: string; why: string; parts: string[]; main: string; x: number; y: number; side: 'top' | 'bottom' }
/** A part at the board's edge: how far along it (0 to 1: left to right, bottom to top). */
export interface PlanEdge { part: string; edge: BoardEdge; along: number; why: string }
/** A part within so many millimetres of a pin ("U3-7") or a part ("U3"). */
export interface PlanNear { part: string; to: string; mm: number; why: string }
export interface PlanApart { a: string; b: string; mm: number; why: string }
export interface PlanClear { part: string; mm: number; why: string }
export interface LayoutPlan {
  summary: string;
  groups: PlanGroup[];
  edges: PlanEdge[];
  near: PlanNear[];
  apart: PlanApart[];
  clear: PlanClear[];
  notes: string[];
  /** Names in the answer that the board doesn't have: left out of the plan, and said. */
  unknown: string[];
  /** The board's parts the answer put in no group. */
  ungrouped: string[];
}

const LAYOUT_SYSTEM = `You are an experienced PCB layout engineer planning where the parts of a board go, before any of them is placed, for a PCB design tool. You get the board as text: its outline's size (and its corners when it isn't a rectangle), its copper layers, its holes and keepouts, each part with its footprint, value, size and pad count, the parts that are fixed where they are, and each net with its pins. When the project has a schematic, each part also has its description and the sheet it is drawn on, and each pin its name. You may also get what the designer says the layout must do.

You do not give positions for single parts: the tool's placer works those out exactly, and measures. You decide what a layout engineer decides first:
- groups: the parts that belong together by function (the power input and its protection; each regulator with its inductor, diode and capacitors; the microcontroller with its crystal, decoupling and programming header; each connector with its ESD parts and series resistors; the radio with its matching network; an analogue front end). Every part that is to be placed goes in exactly one group; a fixed part goes in the group it belongs with. main: the part the others gather round (the IC, the connector). x and y: where the group's middle goes, as fractions of the board's width and height seen from the top side: x 0 is the left edge and 1 the right edge, y 0 the bottom edge and 1 the top edge. side: top or bottom.
- edges: the parts that must sit at the board's edge (connectors, switches, LEDs meant to be seen, antennas, card slots): which edge (left, right, top, bottom) and how far along it (0 to 1: left to right along the top and bottom edges, bottom to top along the left and right ones).
- near: a part that must be close to a pin or to a part: a decoupling capacitor at the supply pin it serves (about 2 mm), a crystal and its load capacitors at the oscillator pins (about 5 mm), a regulator's feedback divider at its feedback pin, a series or termination resistor at its driver, ESD protection at its connector, a sense resistor at its amplifier. to: "U3-7" for a pin, "U3" for a part. mm: the most the distance should be.
- apart: two parts that must be kept away from each other (a switching regulator's inductor from an antenna, a crystal or an analogue input; a hot part from an electrolytic capacitor or a sensor), and by how much.
- clear: a part that needs room around it with nothing in it (an antenna, a part at high voltage, one that needs air or a tool), and how much.
- notes: what the designer should know that the plan itself can't say (mounting, where the heat goes, the layer stack, test access): a few short sentences at most.

How to plan:
- Start from what is fixed: the parts fixed in place, the holes and keepouts, what the designer said. Connectors go where their cables come from; when nothing says, bring power in at one side and take signals out at another, and let the signals flow across the board from where they enter to where they leave.
- Parts drawn on one schematic sheet usually belong together; a large sheet may hold several groups. Groups that share many nets go next to each other. Power conversion stays away from radio, crystals and analogue inputs. An antenna goes at an edge or a corner with nothing beside it.
- Sizes matter: the parts' sizes are given, and a group needs about twice its parts' area. Spread the groups over the board so that their areas don't pile up in one place, and leave room round the fixed parts.
- The capacitors on a supply net are shared out among the supply pins of the ICs on that net: give each IC supply pin its own (the small values at the pins, a larger one for the IC or the group), and say which pin each is for.
- Name only parts and pins the board has, exactly as written. Give each group and each constraint its reason (why), short and specific: what it is for, with the pin or the net.

Reply with JSON only, in this shape:
{"summary": "One short paragraph: what the board is, and the idea of its layout.",
 "groups": [{"name": "USB input and protection", "why": "The cable's power and data come in here, protected before they go on.", "parts": ["J1", "F1", "D1", "C1"], "main": "J1", "x": 0.08, "y": 0.5, "side": "top"}],
 "edges": [{"part": "J1", "edge": "left", "along": 0.5, "why": "The USB cable plugs in from the left."}],
 "near": [{"part": "C5", "to": "U2-7", "mm": 2, "why": "Decouples U2's VDD."}],
 "apart": [{"a": "L1", "b": "Y1", "mm": 10, "why": "The regulator's switching field away from the crystal."}],
 "clear": [{"part": "ANT1", "mm": 5, "why": "Nothing beside the antenna."}],
 "notes": ["The regulator's ground pad needs copper under it to spread its heat."]}`;

/** A fraction of the board (0 to 1), from a number or a percentage; the middle when it can't be read. */
const fraction = (v: unknown): number => {
  const n = typeof v === 'string' && /%\s*$/.test(v) ? (num(v.replace('%', '')) ?? 50) / 100 : num(v);
  return n === null || !Number.isFinite(n) ? 0.5 : Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n));
};

export const LAYOUT: JobSpec<LayoutInput, LayoutPlan> = {
  kind: 'layout',
  version: 2,
  role: 'text',
  maxTokens: 24000,
  effort: 'high',
  size: (i) => (i.board?.length ?? 0) + (i.brief?.length ?? 0) + (i.previous?.length ?? 0) + (i.result?.length ?? 0),
  blank: { board: '', brief: '', parts: [], previous: '', result: '', remarks: '' },
  messages(i) {
    const brief = str(i.brief, 3000), remarks = str(i.remarks, 3000), result = typeof i.result === 'string' ? i.result.slice(0, 20_000).trim() : '';
    const previous = typeof i.previous === 'string' ? i.previous.slice(0, 60_000) : '';
    const text = [
      brief ? `What the designer says the layout must do:\n${brief}` : '',
      typeof i.board === 'string' ? i.board : '',
      previous.trim() ? `The plan made before:\n${previous}` : '',
      previous.trim() && result ? `What the placer made of that plan:\n${result}` : '',
      previous.trim() && remarks ? `What the designer wants changed in it:\n${remarks}` : '',
      previous.trim() ? `Give the whole plan again${remarks ? ' with that changed' : ''}${result ? `${remarks ? ', and' : ','} changed so that what was not met can be (a group moved or given more room, a constraint loosened, or dropped with a note that says so)` : ''}, and the rest as it was unless the change asks for more.` : '',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: LAYOUT_SYSTEM }, { role: 'user', content: text }];
  },
  check(answer, input) {
    const a = obj(answer);
    // The board's designators, by their upper case; a name the board doesn't have is left out and said
    const known = new Map<string, string>();
    for (const p of Array.isArray(input?.parts) ? input.parts : []) if (typeof p === 'string' && p.trim()) known.set(p.trim().toUpperCase(), p.trim());
    const open = known.size === 0;
    const unknown = new Set<string>();
    const part = (v: unknown): string => {
      const name = str(v, 40).replace(/\s+/g, '');
      if (!name) return '';
      const hit = known.get(name.toUpperCase());
      if (hit) return hit;
      if (open) return name;
      unknown.add(name);
      return '';
    };
    /** "U3-7", "U3.7" or "U3 pin 7": the part as the board names it, and the pin as written; a part alone when that is all there is. */
    const target = (v: unknown): string => {
      const t = str(v, 60).replace(/\s+pin\s+/i, '-').replace(/\s+/g, '');
      if (!t) return '';
      if (open || known.has(t.toUpperCase())) return known.get(t.toUpperCase()) ?? t;
      for (let k = t.length - 1; k > 0; k--) {
        if (t[k] !== '-' && t[k] !== '.' && t[k] !== ':') continue;
        const hit = known.get(t.slice(0, k).toUpperCase());
        if (hit && t.slice(k + 1)) return `${hit}-${t.slice(k + 1)}`;
      }
      unknown.add(t);
      return '';
    };
    const mm = (v: unknown, most: number) => { const n = num(v); return n === null || !(n > 0) ? 0 : Math.round(Math.min(most, n) * 100) / 100; };
    const list = (v: unknown, most: number) => (Array.isArray(v) ? v.slice(0, most) : []);
    const taken = new Set<string>();
    const groups: PlanGroup[] = [];
    for (const raw of list(a.groups, 200)) {
      const g = obj(raw);
      const parts = [...new Set(list(g.parts, 2000).map(part).filter(Boolean))].filter((p) => !taken.has(p));
      if (!parts.length) continue;
      for (const p of parts) taken.add(p);
      const main = part(g.main);
      const used = new Set(groups.map((x) => x.name.toLowerCase()));
      let name = str(g.name, 60).replace(/\s+/g, ' ') || `Group ${groups.length + 1}`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.replace(/ \d+$/, '')} ${k}`;
      groups.push({ name, why: str(g.why, 400), parts, main: parts.includes(main) ? main : parts[0]!, x: fraction(g.x), y: fraction(g.y), side: /^b/i.test(str(g.side, 10)) ? 'bottom' : 'top' });
    }
    if (!groups.length) throw new Error('No plan came back');
    const edges: PlanEdge[] = [];
    for (const raw of list(a.edges ?? a.edge, 400)) {
      const e = obj(raw), p = part(e.part), edge = str(e.edge, 10).toLowerCase() as BoardEdge;
      if (p && BOARD_EDGES.includes(edge) && !edges.some((x) => x.part === p)) edges.push({ part: p, edge, along: fraction(e.along), why: str(e.why, 300) });
    }
    const near: PlanNear[] = [];
    for (const raw of list(a.near, 2000)) {
      const n = obj(raw), p = part(n.part), to = target(n.to);
      if (p && to && to.toUpperCase() !== p.toUpperCase() && !to.toUpperCase().startsWith(`${p.toUpperCase()}-`)) near.push({ part: p, to, mm: mm(n.mm, 200) || 5, why: str(n.why, 300) });
    }
    const apart: PlanApart[] = [];
    for (const raw of list(a.apart, 400)) {
      const x = obj(raw), p = part(x.a), q = part(x.b), d = mm(x.mm, 500);
      if (p && q && p !== q && d) apart.push({ a: p, b: q, mm: d, why: str(x.why, 300) });
    }
    const clear: PlanClear[] = [];
    for (const raw of list(a.clear, 200)) {
      const c = obj(raw), p = part(c.part), d = mm(c.mm, 200);
      if (p && d && !clear.some((x) => x.part === p)) clear.push({ part: p, mm: d, why: str(c.why, 300) });
    }
    const notes = list(a.notes, 12).map((n) => str(n, 400)).filter(Boolean);
    return {
      summary: str(a.summary, 1500), groups, edges, near, apart, clear, notes,
      unknown: [...unknown].slice(0, 60), ungrouped: [...known.values()].filter((p) => !taken.has(p)),
    };
  },
};

/* ─── A placed board's routing, planned before a track is drawn ──────────────────────── */

export interface RoutingInput {
  /** The board as the router's planner reads it (src/ai/routeBrief.ts writes it): its layers and rules, each part with where it is, each net with its pins and what is left to route. */
  board: string;
  /** What the designer says the routing must do. */
  brief: string;
  /** The nets a plan may name, and the copper layers by their names: what the answer is checked against. */
  nets: string[];
  layers: string[];
  /** A second round: the plan made before, as text, what the router made of it (what it could not route, and what the design rule check found), and what the designer wants changed in it. */
  previous: string;
  result: string;
  remarks: string;
}

export type ViaUse = 'free' | 'few' | 'none';
export const VIA_USES: ViaUse[] = ['free', 'few', 'none'];
/** How a class's tracks are shaped: with corners, or free-flowing (the direct way at any angle, each bend an arc round what it passes). */
export type RouteStyle = 'corners' | 'flowing';
/** Nets routed alike. width and clearance in mm (0: as the board's rules have it); layers: those to keep to (none: any); order: 1 is routed first; style '': as the designer's Routing Style preference says. */
export interface RouteClass { name: string; why: string; nets: string[]; width: number; clearance: number; layers: string[]; vias: ViaUse; order: number; style: RouteStyle | '' }
/** A pour over the whole of a layer, for a net. */
export interface RoutePour { net: string; layer: string; why: string }
/** A differential pair: its two nets, and the space between their tracks in mm (0: as the board's rule has it). */
export interface RoutePair { name: string; p: string; n: string; gap: number; why: string }
/** The via the board is routed with: across and its hole, mm. */
export interface RouteVia { diameter: number; hole: number; why: string }
export interface RoutingPlan {
  summary: string;
  classes: RouteClass[];
  /** null: the board's Routing Via Style rule as it stands. */
  via: RouteVia | null;
  pours: RoutePour[];
  pairs: RoutePair[];
  notes: string[];
  /** Names in the answer that the board doesn't have: left out of the plan, and said. */
  unknown: string[];
  /** The board's nets the answer put in no class (routed last, at the board's rules). */
  unclassed: string[];
}

const ROUTING_SYSTEM = `You are an experienced PCB layout engineer planning how a placed board is to be routed, before any track is drawn, for a PCB design tool. You get the board as text: its size and copper layers, its width, clearance and via rules as they stand, each part with its value, footprint, side and where its middle is, and each net with its pins, how many connections it still needs and how long they are as the crow flies. When the project has a schematic, each part also has its description and each pin its name. You may also get what the designer says the routing must do.

You do not draw tracks and you give no coordinates: the tool's autorouter finds the ways, at the widths and clearances you set, and its design rule check measures what came of it. You decide what a layout engineer decides before routing:
- classes: the nets that are routed alike, as net classes: each supply rail by the current it carries; ground; crystals and clocks; differential pairs (USB, Ethernet, CAN, LVDS); sensitive analogue; radio; reset and programming; the rest as ordinary signals. Every net goes in exactly one class. For each class:
  - width in mm. For a supply, wide enough for its current: on an outer layer of 1 oz copper, for a rise of 10 °C (IPC-2221), about 0.3 mm carries 1 A, 0.8 mm 2 A and 1.4 mm 3 A; wider where there is room. For signals, the board's rule as it stands unless there is a reason. A track wider than the pads it must reach between cannot be routed: keep to what the finest pitch on the net lets through.
  - clearance in mm, where the class needs more than the board's rule (mains and other high voltage, a sensitive analogue input, radio); otherwise 0, which leaves the rule as it is.
  - layers: the layers the class should keep to, by the names given, or none for any. On two layers, signals mainly on one side keeps the ground on the other whole.
  - vias: "free"; "few" where each via costs (clocks, fast pairs, radio); "none" where the net must stay on the layer of its pads (a crystal, an antenna feed).
  - style: "flowing" where the class gains from tracks that take the direct way at any angle and curve round what they pass, with no corners and little run beside each other (radio and microwave lines, fast pairs and clocks, a flexible board); "corners" for the usual 45° corners; leave it out to route the class as the designer's own setting says.
  - order: which class is routed first (1 first). What needs the shortest and most direct way goes first (crystals, differential pairs, clocks, radio), then the supplies, then the rest.
- via: the via the board is routed with: how far across and its hole, in mm. 0.6 mm with a 0.3 mm hole is within most fabricators' standard service and suits most boards; smaller only where the designer says the fabricator makes it. Leave it out to keep the board's rule as it stands.
- pours: a net poured as copper over the whole of a layer: ground on the bottom of a two-layer board; ground on both sides where that helps. The tool pours it inside the outline, drops a via into it at each surface-mount pad of that net on another layer, and pours again round what is routed. A net with a plane layer in the stack needs no pour.
- pairs: the differential pairs: the two nets (p and n), a name, and gap: the space between the pair's two tracks in mm, for the impedance it needs on this board's stack (say what you assumed), or 0 to keep the board's rule. The tool records them as pairs with a Differential Pairs Routing rule of the class's width and that gap, and lays the two tracks side by side at that gap on one layer where it can; a pair it cannot lay so is routed one net at a time, and its check says so.
- notes: what the designer should know that the plan itself can't say (a current you assumed, a net to route by hand, a stack that would serve better): a few short sentences at most.

How to plan:
- Read what each net is from its name, its pins' names and the parts on it: a net on a regulator's output and many supply pins is a rail; one between a crystal and two oscillator pins is a crystal net; D+ and D- at a USB connector are a pair.
- Estimate each rail's current from what hangs on it, and say what you assumed.
- Do not go below the board's minimum width or its clearance as they stand unless the designer says the fabricator allows it.
- Few classes, each with a reason: a class per kind of net, not per net.
- Name only nets and layers the board has, exactly as written. Give each class, pour and pair its reason (why), short and specific.

Reply with JSON only, in this shape:
{"summary": "One short paragraph: what the board is, and the idea of its routing.",
 "classes": [{"name": "Power", "why": "5 V in and the 3.3 V rail, about 0.5 A at most.", "nets": ["VBUS", "+3V3"], "width": 0.5, "clearance": 0, "layers": ["Top Layer"], "vias": "free", "order": 3}],
 "via": {"diameter": 0.6, "hole": 0.3, "why": "The board's 1.27 mm via is too large beside 0402 parts."},
 "pours": [{"net": "GND", "layer": "Bottom Layer", "why": "One unbroken return path under everything."}],
 "pairs": [{"name": "USB", "p": "USB_DP", "n": "USB_DM", "gap": 0.2, "why": "USB full speed data."}],
 "notes": ["The 3.3 V rail was taken as 0.3 A."]}`;

export const ROUTING: JobSpec<RoutingInput, RoutingPlan> = {
  kind: 'routing',
  version: 1,
  role: 'text',
  maxTokens: 24000,
  effort: 'high',
  size: (i) => (i.board?.length ?? 0) + (i.brief?.length ?? 0) + (i.previous?.length ?? 0) + (i.result?.length ?? 0),
  blank: { board: '', brief: '', nets: [], layers: [], previous: '', result: '', remarks: '' },
  messages(i) {
    const brief = str(i.brief, 3000), remarks = str(i.remarks, 3000), result = typeof i.result === 'string' ? i.result.slice(0, 20_000).trim() : '';
    const previous = typeof i.previous === 'string' ? i.previous.slice(0, 60_000) : '';
    const text = [
      brief ? `What the designer says the routing must do:\n${brief}` : '',
      typeof i.board === 'string' ? i.board : '',
      previous.trim() ? `The plan made before:\n${previous}` : '',
      previous.trim() && result ? `What the router made of that plan:\n${result}` : '',
      previous.trim() && remarks ? `What the designer wants changed in it:\n${remarks}` : '',
      previous.trim() ? `Give the whole plan again${remarks ? ' with that changed' : ''}${result ? `${remarks ? ', and' : ','} changed so that what was left unrouted or broke a rule can be put right (a class made narrower where it could not reach its pads, given another layer or more vias, routed earlier, or a pour moved), with a note that says what you changed` : ''}, and the rest as it was unless the change asks for more.` : '',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: ROUTING_SYSTEM }, { role: 'user', content: text }];
  },
  check(answer, input) {
    const a = obj(answer);
    const byName = (list: unknown) => {
      const m = new Map<string, string>();
      for (const v of Array.isArray(list) ? list : []) if (typeof v === 'string' && v.trim()) m.set(v.trim().toUpperCase(), v.trim());
      return m;
    };
    const nets = byName(input?.nets), layers = byName(input?.layers);
    const open = nets.size === 0, anyLayer = layers.size === 0;
    const unknown = new Set<string>();
    const net = (v: unknown): string => {
      const name = str(v, 80);
      if (!name) return '';
      const hit = nets.get(name.toUpperCase());
      if (hit) return hit;
      if (open) return name;
      unknown.add(name);
      return '';
    };
    /** A layer by its name as the board has it; "top" and "bottom" for the outer ones, "Top" for "Top Layer". */
    const all = [...layers.values()];
    const layer = (v: unknown): string => {
      const name = str(v, 60).replace(/\s+/g, ' ');
      if (!name) return '';
      if (anyLayer) return name;
      const u = name.toUpperCase();
      const hit = layers.get(u) ?? all.find((l) => l.toUpperCase().replace(/\s*LAYER$/, '') === u.replace(/\s*LAYER$/, ''))
        ?? (/^(TOP|FRONT|F\.CU)$/.test(u) ? all[0] : /^(BOTTOM|BACK|B\.CU)$/.test(u) ? all.at(-1) : undefined);
      if (hit) return hit;
      unknown.add(name);
      return '';
    };
    const mm = (v: unknown, most: number) => { const n = num(typeof v === 'string' ? v.replace(/\s*mm\s*$/i, '') : v); return n === null || !(n > 0) ? 0 : Math.round(Math.min(most, Math.max(0.05, n)) * 1000) / 1000; };
    const list = (v: unknown, most: number) => (Array.isArray(v) ? v.slice(0, most) : []);
    const taken = new Set<string>();
    const classes: RouteClass[] = [];
    for (const raw of list(a.classes, 60)) {
      const c = obj(raw);
      const members = [...new Set(list(c.nets, 5000).map(net).filter(Boolean))].filter((n) => !taken.has(n));
      if (!members.length) continue;
      for (const n of members) taken.add(n);
      const used = new Set(classes.map((x) => x.name.toLowerCase()));
      // A class's name goes into rule scopes: letters, digits, spaces and a few marks
      let name = str(c.name, 40).replace(/[^\p{L}\p{N} _+.-]/gu, ' ').replace(/\s+/g, ' ').trim() || `Class ${classes.length + 1}`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.replace(/ \d+$/, '')} ${k}`;
      const vias = str(c.vias, 10).toLowerCase() as ViaUse, order = num(c.order), style = str(c.style, 20).toLowerCase();
      classes.push({ name, why: str(c.why, 400), nets: members, width: mm(c.width, 10), clearance: mm(c.clearance, 10),
        layers: [...new Set(list(c.layers, 40).map(layer).filter(Boolean))], vias: VIA_USES.includes(vias) ? vias : 'free', order: order !== null && Number.isFinite(order) ? order : 1000 + classes.length,
        style: /^(flow|free|curv|round)/.test(style) ? 'flowing' : /^(corner|mit|45|90|ortho)/.test(style) ? 'corners' : '' });
    }
    if (!classes.length) throw new Error('No plan came back');
    // The order as 1, 2, 3 …, those given no place last, as they came
    [...classes].sort((x, y) => x.order - y.order).forEach((c, k) => { c.order = k + 1; });
    // A via with a hole that leaves it a ring; anything else leaves the board's rule
    const v = obj(a.via), vd = mm(v.diameter ?? v.width, 5), vh = mm(v.hole ?? v.drill, 4);
    const via: RouteVia | null = vd >= 0.2 && vh >= 0.1 && vh <= vd - 0.1 ? { diameter: vd, hole: vh, why: str(v.why, 300) } : null;
    const pours: RoutePour[] = [];
    for (const raw of list(a.pours ?? a.pour, 40)) {
      const p = obj(raw), n = net(p.net), l = layer(p.layer);
      if (n && l && !pours.some((x) => x.layer === l)) pours.push({ net: n, layer: l, why: str(p.why, 300) });
    }
    const pairs: RoutePair[] = [];
    for (const raw of list(a.pairs ?? a.pair, 200)) {
      const x = obj(raw), p = net(x.p ?? x.positive ?? x.pos), n = net(x.n ?? x.negative ?? x.neg);
      if (!p || !n || p === n || pairs.some((q) => [q.p, q.n].includes(p) || [q.p, q.n].includes(n))) continue;
      const used = new Set(pairs.map((q) => q.name.toLowerCase()));
      let name = str(x.name, 40).replace(/[^\p{L}\p{N} _+.-]/gu, ' ').replace(/\s+/g, ' ').trim() || `Pair ${pairs.length + 1}`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.replace(/ \d+$/, '')} ${k}`;
      pairs.push({ name, p, n, gap: mm(x.gap, 5), why: str(x.why, 300) });
    }
    const notes = list(a.notes, 12).map((n) => str(n, 400)).filter(Boolean);
    return { summary: str(a.summary, 1500), classes, via, pours, pairs, notes, unknown: [...unknown].slice(0, 60), unclassed: [...nets.values()].filter((n) => !taken.has(n)) };
  },
};

/** A connection test: the smallest job there is. */
export const PING: JobSpec<Record<string, never>, { ok: true }> = {
  kind: 'ping',
  version: 1,
  role: 'text',
  maxTokens: 20,
  size: () => 0,
  blank: {},
  messages: () => [{ role: 'system', content: 'Reply with JSON only.' }, { role: 'user', content: 'Reply with {"ok": true}' }],
  check(answer) {
    if ((answer as { ok?: unknown } | null)?.ok !== true) throw new Error('Unexpected answer');
    return { ok: true };
  },
};

export const JOBS: Record<JobKind, JobSpec<never, unknown>> = {
  survey: SURVEY as JobSpec<never, unknown>, locate: LOCATE as JobSpec<never, unknown>, package: PACKAGE as JobSpec<never, unknown>,
  review: REVIEW as JobSpec<never, unknown>, pins: PINS as JobSpec<never, unknown>, advise: ADVISE as JobSpec<never, unknown>, board: BOARD as JobSpec<never, unknown>,
  datasheet: FIND as JobSpec<never, unknown>, part: PART as JobSpec<never, unknown>, ask: ASK as JobSpec<never, unknown>, mpn: MPN as JobSpec<never, unknown>, reqs: REQS as JobSpec<never, unknown>, reqadvise: ADVISE_REQS as JobSpec<never, unknown>, script: SCRIPT as JobSpec<never, unknown>, layout: LAYOUT as JobSpec<never, unknown>, routing: ROUTING as JobSpec<never, unknown>, ping: PING as JobSpec<never, unknown>,
};

/** The shared cache's key for a variant's package: what tells it from the datasheet's other variants. */
export const packageKey = (v: Pick<Variant, 'package' | 'pins'>) => `${v.package.replace(/[^\w.-]+/g, '_').slice(0, 60)}-${v.pins}`;

/* ─── Choosing the variant a part number means ───────────────────────────────────────── */

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The variant a designer's part number names: the one with the part number that shares the
 * longest start with it (at least the device name's length and 4 characters), or -1.
 */
export function variantFor(survey: Survey, partNumber: string): number {
  const want = norm(partNumber);
  if (want.length < 3) return -1;
  let best = -1, bestLen = 0;
  survey.variants.forEach((v, k) => {
    for (const p of v.partNumbers) {
      const n = norm(p);
      let l = 0;
      while (l < n.length && l < want.length && n[l] === want[l]) l++;
      const whole = l === n.length || l === want.length;
      const score = l + (whole ? 0.5 : 0);
      if (l >= Math.max(4, norm(survey.device).length) && score > bestLen) { best = k; bestLen = score; }
    }
  });
  return best;
}
