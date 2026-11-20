import { locale } from '../../core/locale';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { active, docs, notify, prefsPage, showPrefs, tick } from '../state';
import { settings, updateSettings } from '../../core/settings';
import { followSuccessors, shownId } from '../../ai/models';
import { LOCATE, PACKAGE, PINS, REVIEW, SURVEY, packageKey, variantFor, type PackageInput, type PinsInput, type PinsRead, type Region, type PackageRead, type PageText, type Picture, type Survey, type SurveyInput, type Variant } from '../../ai/jobs';
import { TEXT_BUDGET, allText, hasText, openDatasheet, packagePages, pickPages, surveyPictures, type Crop, type Datasheet } from '../../ai/datasheet';
import { measureLand, type Grey, type Measured } from '../../ai/snap';
import { answerOf, footprintPicture, overlayPicture } from '../../ai/review';
import type { Seg } from '../../ai/vector';
import { allowanceNote, 
  AiError, NOT_YET, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, shareAccepted, withModel,
  type JobResult, type ModelInfo, type ServiceConfig,
} from '../../ai/client';
import { PackageReview, draftFootprint, newDraft, padNames, reviewChecks, usePrims, useDrafts, type Draft, type Review } from './AiPackage';
import { SymbolReview, draftSymbol, newSymbolDraft, symbolChecks, type SymbolDraft } from './AiSymbol';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { writePcbLib } from '../../formats/altium/pcblib';
import { SchLibEditor } from '../../editors/sch/SchLibEditor';
import { writeSchLib } from '../../formats/altium/schlib';
import { addNewDocument, freshName } from '../actions';
import { newDocTarget } from '../workspace';
import { Icon } from '../icons';
import { featureOn } from '../../core/release';
import { APP_VERSION } from '../../platform/distribution';
import { canSearch, findSheet } from '../../ai/partSheets';
import { buildSymbol } from '../../ai/symbol';
import { makePart, partName } from '../../model/partPackage';
import { keepPart } from '../partShelf';

/** A step of a footprint's job, done: what came of it, and how long it took (ms). */
interface Done { text: string; ms: number }
/**
 * A variant's footprint job: waiting its turn, under way (the step, in full and short, since when,
 * and the steps done), done, or failed.
 */
type ReadState<T = PackageRead> = { state: 'queued' } | { state: 'reading'; step: string; short: string; since: number; done: Done[] }
  | { state: 'error'; error: string; done: Done[] } | { state: 'ready'; result: JobResult<T>; done: Done[] };
/** What the open variant shows: its footprint or its symbol. */
type View = 'footprint' | 'symbol';
/** Words of a page with a pin table or pin diagram, for a variant whose survey gave none. */
const PIN_WORDS = /\bpin(-| )?(configuration|description|assignment|function|definition|map|out)s?\b|\bpinouts?\b|\bterminal (configuration|function)s?\b|\bball (map|assignment)s?\b/i;

/** A time taken: 8 s, 1 min 05 s. */
const took = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`; };
/** The steps done, each with its time. */
const Steps = ({ done }: { done: Done[] }) => (done.length ? <ol class="ai-steps small">{done.map((d, i) => <li key={i}>✓ {d.text} <span class="muted">{took(d.ms)}</span></li>)}</ol> : null);

/**
 * Pictures: whole pages for the survey and for finding the drawings; a drawing found, enlarged
 * (its longer side), for reading it; the land pattern for measuring its pads, larger still; a whole
 * page when the drawings weren't found [est: about 150 dpi on A4].
 */
const SURVEY_PX = 1000, LOCATE_PX = 1200, CROP_PX = 1600, MEASURE_PX = 2400, DRAWING_PX = 2000, PER_PAGE = 12_000;
const LABEL: Record<Region['kind'], string> = { land: 'the recommended land pattern, enlarged', outline: 'the package outline drawing, enlarged', table: 'the dimension table, enlarged' };
/** A region found, with a margin for dimension figures it may have cut (3 % of the page each side). */
const widen = (b: Crop): Crop => ({ x0: Math.max(0, b.x0 - 0.03), y0: Math.max(0, b.y0 - 0.03), x1: Math.min(1, b.x1 + 0.03), y1: Math.min(1, b.y1 + 0.03) });
/** A page's text, cut short when it is very long. */
const clip = (t: PageText): PageText => (t.text.length > PER_PAGE ? { ...t, text: `${t.text.slice(0, PER_PAGE)} …` } : t);

/**
 * Tools › Component Builder: a datasheet in, footprints and symbols out. The datasheet read in the browser
 * (its text, and which pages are drawings), surveyed by the AI (every orderable variant, its
 * package, pins, lead form, body and pitch, its pinout, and the pages of its drawing, land pattern
 * and pin table), the variants to build ticked (the part number given pre-ticks its own); then for
 * each ticked variant, Create Footprint: its drawings found on their pages (a small job), sent
 * enlarged with the pages' text and read (the dimensions, and the datasheet's land pattern when it
 * draws one), the land pattern's pads measured in the drawing itself (on its own lines when it is a
 * vector drawing), the footprint made — the datasheet's pads, or worked out by IPC-7351B — shown
 * back to the model with the drawing and put right until it matches (Preferences › System › AI:
 * how many rounds), reviewed beside the page (another model a click away) and added to a PCB
 * library. Create Symbol: the variant's pin table read (its pages' text, and pictures of them),
 * the pins laid round a body (supplies on top, grounds below, inputs left, outputs right; a
 * connector's in number order), checked against its footprint's pads, reviewed (names, types,
 * sides) and added to a schematic library, linked to the footprint. Variants with the same pinout
 * share one reading. A footprint comes with its 3D body (model/packageBody.ts).
 */
export function AiBuilderDialog({ part }: { part?: string }) {
  const mode = settings.aiMode;
  const fileRef = useRef<HTMLInputElement>(null);
  const surveyShared = useRef(false);
  const [sheet, setSheet] = useState<Datasheet | null>(null);
  const [pages, setPages] = useState<PageText[] | null>(null);
  const [partNumber, setPartNumber] = useState(part ?? '');
  /** The datasheet's address, when it was found from the part number (a file given by hand has none). */
  const [where, setWhere] = useState('');
  // What is accepted is shared for the next reader only when the datasheet came from the web (its address is known):
  // a file opened from this computer may be one that is not public, and nothing read from it is kept anywhere
  const share = (kind: Parameters<typeof shareAccepted>[0], key: string, value: unknown) => { if (where) void shareAccepted(kind, key, value); };
  /** Variants kept as parts on the shelf, by the part number they went under. */
  const [kept, setKept] = useState<Map<number, string>>(new Map());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<JobResult<Survey> | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [models, setModels] = useState<{ list: ModelInfo[]; defaults: ServiceConfig['defaults']; jobs?: ServiceConfig['jobs']; allowance?: ServiceConfig['allowance']; loaded?: boolean }>({ list: [], defaults: {} });
  const [preview, setPreview] = useState<{ page: number; url: string } | null>(null);
  const [reads, setReads] = useState<Map<number, ReadState>>(new Map());
  const [added, setAdded] = useState<Map<number, string>>(new Map());
  const [open, setOpen] = useState<number | null>(null);
  // Symbols: opened from a schematic library, the builder shows them first
  const [view, setView] = useState<View>(() => (active.value?.editor instanceof SchLibEditor ? 'symbol' : 'footprint'));
  const [pinReads, setPinReads] = useState<Map<number, ReadState<PinsRead>>>(new Map());
  const [symAdded, setSymAdded] = useState<Map<number, string>>(new Map());
  const [symDrafts, setSymDrafts] = useState<Map<number, SymbolDraft>>(new Map());
  const putSym = (k: number, d: SymbolDraft) => setSymDrafts((m) => new Map(m).set(k, d));
  // The pin tables read so far (a variant with the same pinout takes its twin's)
  const pinsRead = useRef(new Map<number, JobResult<PinsRead>>());
  const schLibs = docs.value.filter((d) => d.editor instanceof SchLibEditor);
  const [schTarget, setSchTarget] = useState<string>(() => (active.value?.editor instanceof SchLibEditor ? active.value.id : schLibs[0]?.id ?? 'new'));
  /** Everything read from the datasheet before, gone (another datasheet, or read again). */
  const forget = () => { setReads(new Map()); setAdded(new Map()); setOpen(null); reset(); setPinReads(new Map()); setSymAdded(new Map()); setSymDrafts(new Map()); pinsRead.current = new Map(); };
  // The model every job here runs on: Preferences › System › AI's choice, chosen here too
  const [chosen, setChosen] = useState(() => modelFor(mode));
  const choose = (id: string) => { updateSettings({ aiModels: withModel(settings.aiModels, mode, id) }); setChosen(id); };
  const { drafts, put, reset } = useDrafts();
  const libs = docs.value.filter((d) => d.editor instanceof PcbLibEditor);
  const [target, setTarget] = useState<string>(() => (active.value?.editor instanceof PcbLibEditor ? active.value.id : libs[0]?.id ?? 'new'));

  // Datasheets opened here stay open while the dialog is (a job may still be reading one), and close with it
  const opened = useRef<Datasheet[]>([]);
  const current = useRef<Datasheet | null>(null);
  useEffect(() => () => { for (const d of opened.current) d.close(); }, []);
  // While anything is under way, its time counts up every second
  const busyAt = useRef(0);
  const [, setTick] = useState(0);
  useEffect(() => { if (busy) busyAt.current = Date.now(); }, [busy]);
  useEffect(() => {
    if (!busy && ![...reads.values(), ...pinReads.values()].some((r) => r.state === 'reading')) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [reads, pinReads, busy]);
  // The models to choose from, with their prices for the estimates (own key: OpenRouter's list; the service: its own; a local server's)
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    (mode === 'konium' ? serviceConfig().then((c) => ({ list: c.models, defaults: c.defaults, jobs: c.jobs, allowance: c.allowance, loaded: true })) : listModels(mode).then((list) => ({ list, defaults: {} })))
      .then((m) => {
        if (!live) return;
        setModels(m);
        // A chosen model no longer offered: its successor chosen instead, quietly
        const moved = followSuccessors(settings.aiModels, mode, m.list, mode === 'konium');
        if (moved) { updateSettings({ aiModels: moved }); setChosen(modelFor(mode)); }
      }).catch(() => { /* no estimate */ });
    return () => { live = false; };
  }, [mode]);
  // One model does every job: the one chosen, else the service's default
  // The service's default (a service before 26.078 names one for each of text and drawings)
  const defaultId = models.defaults.model || models.defaults.vision;
  const modelInfo = () => { const id = modelFor(mode) || defaultId; return models.list.find((m) => m.id === id); };
  /** A model as shown: its name when listed, else its id (an alias's without its ~). */
  const nameOf = (id: string | undefined) => (id ? models.list.find((m) => m.id === id)?.name ?? shownId(id) : '');
  // Pictures need a model that takes them: the service has one; with a key or a local model, one chosen for drawings
  const canSee = mode === 'konium' || !!modelFor(mode);
  // A Konium service deployed before drawings were read doesn't take the job
  const drawingsOk = mode !== 'konium' || !models.loaded || serviceRuns(models, 'package');
  // Nor, before 26.083, the pin tables
  const pinsOk = mode !== 'konium' || !models.loaded || serviceRuns(models, 'pins');

  const open1 = async (f: File) => {
    setError(''); setResult(null); setTicked(new Set()); setPreview(null); forget(); setWhere(''); setKept(new Map());
    setBusy(`Reading ${f.name}…`);
    try {
      const d = await openDatasheet(new Uint8Array(await f.arrayBuffer()), f.name);
      opened.current.push(d); current.current = d;
      const text = await allText(d);
      setSheet(d); setPages(text);
      if (!hasText(text) && !text.some((p) => p.drawing)) setError('This PDF has (almost) no text — a scan? Reading scanned pages as pictures comes in a later build.');
    } catch (e) { setError((e as Error).message); setSheet(null); setPages(null); }
    setBusy('');
  };

  /** The part number's datasheet found on the web and fetched (R21): the builder then goes on as with a file. */
  const findIt = async () => {
    const mpn = partNumber.trim();
    if (!mpn) return;
    setError(''); setResult(null); setTicked(new Set()); setPreview(null); forget(); setWhere(''); setKept(new Map());
    setBusy(`Looking for ${mpn}'s datasheet…`);
    try {
      // (kept for the session by its part number, as the Design Adviser keeps it: not closed with this window)
      const ps = await findSheet(mpn, { onStep: (s) => setBusy(`${mpn}: ${s}…`) });
      current.current = ps.sheet;
      setSheet(ps.sheet); setPages(ps.pages); setWhere(ps.source === 'file' ? '' : ps.where);
      if (!hasText(ps.pages) && !ps.pages.some((p) => p.drawing)) setError('This PDF has (almost) no text — a scan? Reading scanned pages as pictures comes in a later build.');
    } catch (e) { setError((e as Error).message); setSheet(null); setPages(null); }
    setBusy('');
  };

  const surveyPics = useMemo(() => (pages && canSee ? surveyPictures(pages) : []), [pages, canSee]);
  const input: SurveyInput | null = useMemo(() => {
    if (!sheet || !pages || mode === 'off') return null;
    // The part number isn't sent: it picks its variant from the answer here
    return { pages: pickPages(pages, TEXT_BUDGET[mode]), pageCount: sheet.pageCount };
  }, [sheet, pages, mode]);
  const surveyTokens = input ? estimateTokens(SURVEY.messages(input)) + surveyPics.length * 1500 : 0;

  const survey = async (fresh = false) => {
    if (!input || !sheet) return;
    setError(''); setBusy('Reading the datasheet…');
    try {
      const pictures: Picture[] = [];
      for (const n of surveyPics) pictures.push({ page: n, url: await sheet.picture(n, SURVEY_PX, 'image/jpeg') });
      const r = await runJob(SURVEY, pictures.length ? { ...input, pictures } : input, { cacheKey: sheet.fingerprint, fresh });
      setResult(r); forget();
      const own = partNumber.trim() ? variantFor(r.value, partNumber) : -1;
      setTicked(new Set(own >= 0 ? [own] : r.value.variants.length === 1 ? [0] : []));
      surveyShared.current = !!r.cached;
    } catch (e) { setError(e instanceof AiError || e instanceof Error ? e.message : String(e)); }
    setBusy('');
  };

  const show = async (page: number, keep = false) => {
    if (!sheet) return;
    if (preview?.page === page && !keep) { setPreview(null); return; }
    try { setPreview({ page, url: await sheet.picture(page, 1100) }); } catch (e) { setError((e as Error).message); }
  };

  const v = result?.value;
  const byPage = useMemo(() => new Map((pages ?? []).map((p) => [p.page, p])), [pages]);
  /** A variant's drawing job: the pages whose text goes, and those sent as pictures. */
  const plan = (k: number) => {
    const x = v!.variants[k]!;
    const others = v!.variants.filter((o) => o.package !== x.package).flatMap((o) => [...o.drawingPages, ...o.landPatternPages]);
    const list = packagePages(pages ?? [], x.drawingPages, x.landPatternPages, others);
    const pics = canSee ? list.filter((n) => byPage.get(n)?.drawing || x.drawingPages.includes(n) || x.landPatternPages.includes(n)).slice(0, 4) : [];
    // Where to look for the drawings: those pages, and the drawing pages beside them — every drawing page of a short
    // datasheet (a survey's page numbers can be wrong when the pages have no text of their own)
    const drawn = (pages ?? []).filter((q) => q.drawing).map((q) => q.page);
    const more = sheet && sheet.pageCount <= 12 ? drawn : drawn.filter((n) => list.some((m) => Math.abs(m - n) <= 1));
    const find = canSee ? [...new Set([...pics, ...more])].slice(0, 6).sort((a, b) => a - b) : [];
    return { pages: list, pictures: pics, find };
  };
  // Finding the drawings first (a small job) when the service or model can: then enlarged pictures of them
  const locating = canSee && (mode !== 'konium' || !models.loaded || serviceRuns(models, 'locate'));
  const planTokens = (k: number) => {
    const p = plan(k);
    const read = estimateTokens(PACKAGE.messages({ device: v!.device, variant: v!.variants[k]!, pages: p.pages.map((n) => byPage.get(n)!), pictures: [], pageCount: sheet!.pageCount }));
    return read + (locating && p.find.length ? 500 + p.find.length * 1000 + Math.min(3, p.find.length + 1) * 1600 : p.pictures.length * 1600);
  };

  const readDrawing = async (k: number, fresh = false, model?: string) => {
    if (!sheet || !v) return;
    const x = v.variants[k]!;
    // Each step shown as it goes (the variant's row and the panel), and what came of each with its time
    const done: Done[] = [];
    let since = Date.now();
    const step = (text: string, short: string) => { since = Date.now(); setReads((m) => new Map(m).set(k, { state: 'reading', step: text, short, since, done: [...done] })); };
    const finish = (text: string) => { done.push({ text, ms: Date.now() - since }); };
    const who = nameOf(model || modelFor(mode) || defaultId);
    try {
      const p = plan(k);
      const pictures: Picture[] = [];
      let land: Region | null = null;
      const textPages = new Set(p.pages);
      if (p.find.length && locating) {
        // 1. Where on its pages the drawings are (a whole page holds them too small to read)
        step(`Finding the drawings on page${p.find.length === 1 ? '' : 's'} ${p.find.join(', ')}…`, 'finding the drawings');
        try {
          const pages = await Promise.all(p.find.map(async (n) => ({ page: n, url: await sheet.picture(n, LOCATE_PX, 'image/jpeg') })));
          const found = await runJob(LOCATE, { device: v.device, variant: { package: x.package, pins: x.pins }, pictures: pages });
          const order: Region['kind'][] = ['land', 'outline', 'table'];
          const regions = [...found.value.regions].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 4);
          for (const r of regions) pictures.push({ page: r.page, url: await sheet.picture(r.page, CROP_PX, 'image/jpeg', widen(r.box)), label: LABEL[r.kind] });
          land = regions.find((r) => r.kind === 'land') ?? null;
          for (const r of regions) textPages.add(r.page);
          finish(regions.length ? `Found ${regions.map((r) => `the ${r.kind === 'land' ? 'land pattern' : r.kind === 'outline' ? 'outline drawing' : 'dimension table'} on page ${r.page}`).join(', ')}` : 'No drawings found: whole pages sent');
        } catch (e) { finish(`The drawings weren't found (${e instanceof Error ? e.message : String(e)}): whole pages sent`); }
      }
      if (!pictures.length) for (const n of p.pictures) pictures.push({ page: n, url: await sheet.picture(n, DRAWING_PX, 'image/jpeg') });
      // 2. The drawings read
      step(`${pictures.some((q) => q.label) ? 'Reading the drawings found' : 'Reading the drawings'}${who ? ` with ${who}` : ''}…`, 'reading');
      const job: PackageInput = {
        device: v.device,
        variant: { partNumbers: x.partNumbers, package: x.package, pins: x.pins, leadForm: x.leadForm, body: x.body, pitch: x.pitch, thermalPad: x.thermalPad },
        pages: [...textPages].sort((a, b) => a - b).map((n) => clip(byPage.get(n)!)), pictures, pageCount: sheet.pageCount,
      };
      const r = await runJob(PACKAGE, job, { cacheKey: `${sheet.fingerprint}:${packageKey(x)}`, fresh: fresh || !!model, ...(model ? { model } : {}) });
      finish(r.cached ? 'Read before, by others (accepted)' : `Read by ${nameOf(r.model) || 'the model'}: ${r.value.land.length ? `${r.value.land.length} pads` : 'the dimensions'}`);
      // 3. Its pads measured in the land pattern's drawing (their places; the AI's reading gives which pads and their sizes)
      let read = r.value, measured: Measured | null = null;
      let drawing: { grey: Grey; segs: Seg[] } | null = null;
      const measure = (rd: PackageRead) => { try { return drawing && rd.land.length ? measureLand(rd, drawing.grey, { segs: drawing.segs }) : null; } catch { return null; } };
      if (land && read.land.length) {
        step('Measuring the pads in the drawing…', 'measuring');
        try {
          // The drawing's own lines too, when it is a vector drawing: its pads' exact edges
          const segs = await sheet.segments(land.page, MEASURE_PX, widen(land.box)).catch(() => []);
          drawing = { grey: await sheet.grey(land.page, MEASURE_PX, widen(land.box)), segs };
        } catch { /* as read */ }
        measured = measure(read);
        finish(measured ? `Measured ${measured.moved} of ${measured.total} pads in the drawing${measured.vector ? ', on its lines' : ''}` : 'Not measured: no row of pads at the pitch read in the drawing');
      }
      // 4. The footprint shown back to the model with the drawing (its pads over the drawing too, when measured), put right
      // until it finds nothing more or the rounds run out (not one someone already accepted)
      let review: Review | null = null, fixed = 0;
      const rounds = settings.aiReviewRounds, landPic = pictures.find((q) => q.label === LABEL.land) ?? pictures[0];
      if (rounds > 0 && landPic && read.land.length && !r.cached && canSee && (mode !== 'konium' || serviceRuns(models, 'review'))) {
        for (let round = 1; round <= rounds; round++) {
          if (current.current !== sheet) return;
          step(`Checking the footprint against the drawing with ${who || 'the model'}: round ${round} of up to ${rounds}…`, `checking ${round}/${rounds}`);
          const shown = (measured?.read ?? read).land;
          try {
            const pics: Picture[] = [{ ...landPic, label: landPic.label === LABEL.land ? 'the datasheet\'s land pattern' : 'the datasheet\'s page' }, { page: landPic.page, url: await footprintPicture(shown), label: 'the footprint as made, drawn to scale' }];
            if (measured && landPic.label === LABEL.land) pics.push({ page: landPic.page, url: await overlayPicture(landPic.url, shown, measured), label: 'the footprint\'s pads (red) over the datasheet\'s drawing' });
            const rv = await runJob(REVIEW, { device: v.device, variant: { package: x.package, pins: x.pins }, land: answerOf(shown), dimensions: read.dimensions, measured: !!measured, round, pictures: pics }, model ? { model } : {});
            review = { rounds: round, ok: rv.value.ok, problems: rv.value.problems, fixed, unchecked: false };
            finish(rv.value.ok ? `Check ${round}: it matches the drawing` : `Check ${round}: ${rv.value.land ? 'put right' : 'found'} — ${rv.value.problems.join('; ') || 'no reason given'}`);
            if (rv.value.ok || !rv.value.land) break;
            // Put right: measured again on the drawing
            read = { ...read, land: rv.value.land, dimensions: rv.value.dimensions.length ? rv.value.dimensions : read.dimensions };
            fixed++;
            review = { ...review, fixed, unchecked: true };
            measured = measure(read);
          } catch (e) {
            review = { rounds: round, ok: false, problems: [`The check couldn't be done: ${e instanceof Error ? e.message : String(e)}`], fixed, unchecked: false };
            finish(`Check ${round}: couldn't be done`);
            break;
          }
        }
      }
      // Another datasheet opened meanwhile: this one's answer is no longer wanted
      if (current.current !== sheet) return;
      setReads((m) => new Map(m).set(k, { state: 'ready', result: r, done }));
      const fd: Draft = { ...newDraft(x, read, measured), review };
      put(k, fd);
      linkFootprint(k, nameOfFootprint(fd));
      if (mode === 'konium') void serviceConfig().then((c) => setModels((m) => ({ ...m, allowance: c.allowance }))).catch(() => { /* as it was */ });
      setOpen(k); setView('footprint');
      const first = land?.page ?? r.value.pages[0] ?? x.landPatternPages[0] ?? x.drawingPages[0];
      if (first) void show(first, true);
    } catch (e) {
      setReads((m) => new Map(m).set(k, { state: 'error', error: e instanceof Error ? e.message : String(e), done }));
      setOpen(k); setView('footprint');
    }
  };
  const readTicked = async () => {
    // One after another: those waiting say so
    const list = [...ticked].sort((a, b) => a - b).filter((k) => { const s = reads.get(k)?.state; return s !== 'ready' && s !== 'reading' && s !== 'queued'; });
    setReads((m) => { const n = new Map(m); for (const k of list) n.set(k, { state: 'queued' }); return n; });
    for (const k of list) await readDrawing(k);
  };

  /* Symbols */
  /** A footprint draft's name as it stands. */
  const nameOfFootprint = (d: Draft) => ((d.name ?? draftFootprint(d).built?.fp.name) || '').trim();
  /** A variant's symbol, made before its footprint was named, links the footprint. */
  const linkFootprint = (k: number, name: string) => { if (name) setSymDrafts((m) => { const d = m.get(k); return d && !d.footprint.trim() ? new Map(m).set(k, { ...d, footprint: name }) : m; }); };
  /** The symbol's name: the part number given, when it is this variant's; else the variant's first; else the device. */
  const symbolName = (k: number) => {
    const x = v!.variants[k]!;
    const own = partNumber.trim() && variantFor(v!, partNumber) === k ? partNumber.trim() : '';
    return (own || x.partNumbers[0] || v!.device || 'Component').slice(0, 60);
  };
  /** The exact part number a variant is kept under: the one given, when it is this variant's; else the variant's first. */
  const partNo = (k: number) => {
    const x = v!.variants[k]!;
    return (partNumber.trim() && variantFor(v!, partNumber) === k ? partNumber.trim() : x.partNumbers[0] ?? '').slice(0, 80);
  };
  const symbolDescription = (k: number) => [v!.description || v!.device, v!.variants[k]!.package].filter(Boolean).join(', ').slice(0, 250);
  /** A variant's pin-table job: the pages whose text goes (its pin table's, else those that look like one), and those sent as pictures. */
  const pinPlan = (k: number) => {
    const x = v!.variants[k]!;
    let list = x.pinTablePages.filter((n) => byPage.has(n));
    if (!list.length) list = (pages ?? []).filter((q) => PIN_WORDS.test(q.text)).map((q) => q.page).slice(0, 3);
    list = list.slice(0, 6);
    return { pages: list, pictures: canSee ? list.slice(0, 3) : [] };
  };
  const pinsInput = (k: number, pictures: Picture[]): PinsInput => {
    const x = v!.variants[k]!;
    return { device: v!.device, variant: { partNumbers: x.partNumbers, package: x.package, pins: x.pins, pinout: x.pinout, leadForm: x.leadForm }, pages: pinPlan(k).pages.map((n) => clip(byPage.get(n)!)), pictures, pageCount: sheet!.pageCount };
  };
  const pinTokens = (k: number) => estimateTokens(PINS.messages(pinsInput(k, []))) + pinPlan(k).pictures.length * 1600;
  /** The variant read already whose pins this one shares (the same pinout, pin count and thermal pad), else −1. */
  const twinOf = (k: number) => {
    const x = v!.variants[k]!;
    return v!.variants.findIndex((o, j) => j !== k && pinsRead.current.has(j) && o.pinout === x.pinout && o.pins === x.pins && o.thermalPad === x.thermalPad);
  };
  const variantName = (k: number) => v!.variants[k]!.partNumbers[0] || v!.variants[k]!.package;

  const readPins = async (k: number, fresh = false) => {
    if (!sheet || !v) return;
    const x = v.variants[k]!;
    const done: Done[] = [];
    let since = Date.now();
    const step = (text: string, short: string) => { since = Date.now(); setPinReads((m) => new Map(m).set(k, { state: 'reading', step: text, short, since, done: [...done] })); };
    const finish = (text: string) => { done.push({ text, ms: Date.now() - since }); };
    const who = nameOf(modelFor(mode) || defaultId);
    try {
      const twin = fresh ? -1 : twinOf(k);
      let r: JobResult<PinsRead>;
      if (twin >= 0) {
        r = pinsRead.current.get(twin)!;
        done.push({ text: `The same pinout as ${variantName(twin)}: its pins`, ms: 0 });
      } else {
        const p = pinPlan(k);
        step(`Reading the pin table${p.pages.length ? ` on page${p.pages.length === 1 ? '' : 's'} ${p.pages.join(', ')}` : ''}${who ? ` with ${who}` : ''}…`, 'reading the pins');
        const pictures: Picture[] = [];
        for (const n of p.pictures) pictures.push({ page: n, url: await sheet.picture(n, DRAWING_PX, 'image/jpeg') });
        r = await runJob(PINS, pinsInput(k, pictures), { cacheKey: `${sheet.fingerprint}:${packageKey(x)}-${x.pinout}`, fresh });
        finish(r.cached ? 'Read before, by others (accepted)' : `Read by ${nameOf(r.model) || 'the model'}: ${r.value.pins.length} pin${r.value.pins.length === 1 ? '' : 's'}`);
      }
      // Another datasheet opened meanwhile: this one's answer is no longer wanted
      if (current.current !== sheet) return;
      pinsRead.current.set(k, r);
      setPinReads((m) => new Map(m).set(k, { state: 'ready', result: r, done }));
      const fd = drafts.get(k);
      putSym(k, newSymbolDraft(r.value, symbolName(k), symbolDescription(k), fd ? nameOfFootprint(fd) : ''));
      if (mode === 'konium' && twin < 0) void serviceConfig().then((c) => setModels((m) => ({ ...m, allowance: c.allowance }))).catch(() => { /* as it was */ });
      setOpen(k); setView('symbol');
      const first = r.value.pages[0] ?? x.pinTablePages[0];
      if (first) void show(first, true);
    } catch (e) {
      setPinReads((m) => new Map(m).set(k, { state: 'error', error: e instanceof Error ? e.message : String(e), done }));
      setOpen(k); setView('symbol');
    }
  };
  const readTickedPins = async () => {
    const list = [...ticked].sort((a, b) => a - b).filter((k) => { const s = pinReads.get(k)?.state; return s !== 'ready' && s !== 'reading' && s !== 'queued'; });
    setPinReads((m) => { const n = new Map(m); for (const k of list) n.set(k, { state: 'queued' }); return n; });
    for (const k of list) await readPins(k);
  };

  const draft = open !== null ? drafts.get(open) : undefined;
  const made = useMemo(() => (draft ? draftFootprint(draft) : null), [draft]);
  const prims = usePrims(made?.built?.records);
  const symDraft = open !== null ? symDrafts.get(open) : undefined;
  const symMade = useMemo(() => (symDraft ? draftSymbol(symDraft) : null), [symDraft]);
  // Its pins against its footprint's pads, when it has one
  const fpPads = useMemo(() => (made?.built ? padNames(made.built.records) : null), [made]);

  const addToLibrary = () => {
    if (open === null || !draft || !made?.built || !v || !sheet) return;
    const x = v.variants[open]!;
    const { fp, records } = made.built;
    const name = (draft.name ?? fp.name).trim() || fp.name;
    const height = `${(fp.height / 0.0254).toFixed(2)}mil`;
    const from = draft.source === 'datasheet' ? `land pattern from the datasheet${draft.read.pages.length ? ` (page ${draft.read.pages.join(', ')})` : ''}` : fp.description || 'pads by IPC-7351B';
    const description = `${[v.maker, v.device, x.package].filter(Boolean).join(' ')}: ${from}`.slice(0, 250);
    const lib = libs.find((d) => d.id === target);
    let libName = '';
    if (lib?.editor instanceof PcbLibEditor) {
      lib.editor.insertFootprint(name, description, height, records);
      libName = lib.name;
    } else {
      libName = freshName('PcbLib', 'PcbLib');
      const od = addNewDocument(libName, writePcbLib([{ name, description, height, records }], libName), newDocTarget());
      if (od) { setTarget(od.id); libName = od.name; }
    }
    setAdded((m) => new Map(m).set(open, libName));
    linkFootprint(open, name);
    // What the designer used, for the next reader of this datasheet (the survey once, with its first footprint)
    if (!surveyShared.current && result) { surveyShared.current = true; share('survey', sheet.fingerprint, result.value); }
    share('package', `${sheet.fingerprint}:${packageKey(x)}`, draft.read);
    notify(`${name} added to ${libName}`);
  };

  /** The open variant kept as a part (R21): its symbol under the part number, linked to its footprint, with what it was read from. */
  const keepAsPart = () => {
    if (open === null || !draft || !made?.built || !symDraft || !v || !sheet) return;
    const x = v.variants[open]!, mpn = partNo(open);
    if (!mpn) return;
    const { fp, records } = made.built;
    const fpName = (draft.name ?? fp.name).trim() || fp.name;
    const from = draft.source === 'datasheet' ? `land pattern from the datasheet${draft.read.pages.length ? ` (page ${draft.read.pages.join(', ')})` : ''}` : fp.description || 'pads by IPC-7351B';
    const symbol = buildSymbol(symDraft.read, { name: partName(mpn), description: symDraft.description, footprint: fpName, sides: symDraft.sides, pinLength: settings.schPinLength / 10 });
    const pkg = makePart({
      mpn, maker: v.maker, device: v.device, description: symDraft.description || symbolDescription(open), packageName: x.package, from: draft.source === 'datasheet' ? 'datasheet' : 'ipc', symbol,
      footprint: { name: fpName, description: `${[v.maker, v.device, x.package].filter(Boolean).join(' ')}: ${from}`.slice(0, 250), height: `${(fp.height / 0.0254).toFixed(2)}mil`, records },
      pins: symDraft.read.pins.map((p) => ({ number: p.number, name: p.name, type: p.type })),
      datasheet: { url: where, title: sheet.title ?? '', sha256: sheet.fingerprint, pages: sheet.pageCount, pinPages: symDraft.read.pages, packagePages: draft.read.pages },
      app: APP_VERSION, by: 'the Component Builder',
    });
    const had = keepPart(pkg);
    setKept((m) => new Map(m).set(open, mpn));
    // What the designer used, for the next reader of this datasheet (as Add to Library and Add Symbol share it)
    if (!surveyShared.current && result) { surveyShared.current = true; share('survey', sheet.fingerprint, result.value); }
    share('package', `${sheet.fingerprint}:${packageKey(x)}`, draft.read);
    share('pins', `${sheet.fingerprint}:${packageKey(x)}-${x.pinout}`, symDraft.read);
    notify(had ? `${mpn} was on your shelf: replaced (Tools › Parts)` : `${mpn} kept on your shelf (Tools › Parts)`);
  };

  const addSymbol = () => {
    if (open === null || !symDraft || !symMade || !v || !sheet) return;
    const x = v.variants[open]!;
    const lib = schLibs.find((d) => d.id === schTarget);
    let libName = '', name = symMade.libRef;
    if (lib?.editor instanceof SchLibEditor) {
      const [a] = lib.editor.insertSymbols([{ ...symMade, storage: '' }], `Add ${symMade.libRef}`);
      libName = lib.name; name = a?.libRef ?? name;
      tick.value++;
    } else {
      libName = freshName('SchLib', 'SchLib');
      const od = addNewDocument(libName, writeSchLib([symMade]), newDocTarget());
      if (od) { setSchTarget(od.id); libName = od.name; }
    }
    setSymAdded((m) => new Map(m).set(open, libName));
    if (!surveyShared.current && result) { surveyShared.current = true; share('survey', sheet.fingerprint, result.value); }
    share('pins', `${sheet.fingerprint}:${packageKey(x)}-${x.pinout}`, symDraft.read);
    notify(`${name} added to ${libName}${name === symMade.libRef ? '' : ` (${symMade.libRef} was taken)`}`);
  };

  if (mode === 'off') {
    return (
      <Dialog title="Component Builder" width={560} height={260} onClose={closeDialog} class="ai-builder"
        footer={<><span class="spacer" /><button class="btn default" onClick={() => { closeDialog(); prefsPage.value = 'sys-ai'; showPrefs.value = true; }}>Open Preferences…</button><button class="btn" onClick={closeDialog}>Close</button></>}>
        <p>AI is off. Choose how Konium Designer reaches a model (the Konium service, your own key, or a model on your computer) in Preferences › System › AI.</p>
        <p class="small muted">Nothing is sent anywhere until you start a job, and each job shows what it will send first.</p>
      </Dialog>
    );
  }

  const pageLinks = (list: number[]) => list.length
    ? list.map((n, i) => <span key={n}>{i ? ', ' : ''}<a href="#" class={preview?.page === n ? 'on' : ''} onClick={(e) => { e.preventDefault(); void show(n); }}>{n}</a></span>)
    : <span class="muted">—</span>;
  // Rounds of the model checking the footprint it made (each a job; the service counts them apart)
  const checks = canSee && (mode !== 'konium' || serviceRuns(models, 'review')) ? settings.aiReviewRounds : 0;
  const cost = (tokens: number, maxOut: number, rounds = 0) => {
    const also = rounds ? `, and up to ${rounds} round${rounds === 1 ? '' : 's'} of checking the footprint` : '';
    if (mode === 'local') return `Free: it runs on your model${also}.`;
    const m = modelInfo();
    // A round: the land pattern and three pictures in, a land pattern out [est]
    const round = estimateCost(6000, 4000, m);
    if (mode !== 'konium') return `Estimated cost: ${money(estimateCost(tokens, maxOut, m))}${rounds && round !== null ? `, and up to ${money(rounds * round)} for checking it` : ''}.`;
    return `${allowanceNote(models.allowance, m)}${also}; none if someone already read it and sharing is on.${m ? ` Read by ${m.name}.` : ''}`;
  };
  const usage = (r: JobResult<unknown>) => `Read by ${r.cached ? `others before you (accepted by ${r.cached.acceptedBy})` : nameOf(r.model) || 'the service'}${r.usage.in ? ` · ${r.usage.in.toLocaleString(locale())} tokens in, ${r.usage.out.toLocaleString(locale())} out${r.usage.cost ? ` · ${money(r.usage.cost)}` : ''}` : ''}.`;
  /** A variant's footprint or symbol, as it stands: a link that opens it. */
  const status = (k: number, to: View) => {
    const s: ReadState<unknown> | undefined = to === 'footprint' ? reads.get(k) : pinReads.get(k), a = (to === 'footprint' ? added : symAdded).get(k);
    const go = (e: Event) => { e.preventDefault(); setOpen(k); setView(to); };
    if (a) return <a href="#" onClick={go}>added to {a}</a>;
    if (!s) return <a href="#" onClick={go}>create…</a>;
    if (s.state === 'queued') return <span class="muted">waiting its turn</span>;
    if (s.state === 'reading') return <a href="#" class="muted" onClick={go}>{s.short}… {took(Date.now() - s.since)}</a>;
    if (s.state === 'error') return <a href="#" class="ai-error" onClick={go}>failed</a>;
    return <a href="#" onClick={go}>review</a>;
  };
  // The models that take pictures (or might: a local server may not say), with their prices
  const seeing = models.list.filter((m) => m.vision !== false && (m.vision || m.visionGuess || mode === 'local'));
  const per = (n: number) => (n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0));
  const priced = (m: ModelInfo) => `${m.name}${m.priceIn !== undefined && m.priceOut !== undefined ? ` — $${per(m.priceIn)} / $${per(m.priceOut)} per M tokens` : ''}`;
  // A job under way keeps its model: the choice is locked until every job has finished
  const working = !!busy || [...reads.values(), ...pinReads.values()].some((r) => r.state === 'reading' || r.state === 'queued');
  const canFind = featureOn('partsLibrary') && !working && !!partNumber.trim() && canSearch();
  const findHint = canSearch() ? 'Find its datasheet: the part number goes to the AI service, which looks for the maker\'s datasheet on the web; the PDF is then fetched through the Konium service'
    : 'Finding a datasheet on the web needs the Konium service or an OpenRouter key (Preferences › System › AI)';

  const picker = (
    <>
      <label for="ai-model">Model</label>
      <select id="ai-model" aria-label="Model" value={chosen} disabled={working} title={working ? 'Locked while a job is under way' : undefined} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>
        <option value="">{mode === 'konium' ? `Default${defaultId ? ` (${nameOf(defaultId)})` : ''}` : '(choose one)'}</option>
        {chosen && !seeing.some((m) => m.id === chosen) && <option value={chosen}>{nameOf(chosen)}</option>}
        {seeing.map((m) => <option key={m.id} value={m.id}>{priced(m)}</option>)}
      </select>
    </>
  );
  // Another go, on the model chosen above (another one there first, if wanted)
  const retry = (again: () => void, said: preact.ComponentChildren) => (
    <div class="ai-row ai-retry small">
      <span class="ai-said">{said}</span>
      <button class="btn" disabled={working} title={`Read it again${nameOf(chosen || defaultId) ? ` with ${nameOf(chosen || defaultId)}` : ''} (another model: choose it above)`} onClick={again}>Read Again</button>
    </div>
  );
  const waiting = (m: Map<number, ReadState<unknown>>) => [...ticked].filter((k) => { const s = m.get(k)?.state; return s !== 'ready' && s !== 'reading' && s !== 'queued'; });
  const toRead = waiting(reads), toReadPins = waiting(pinReads);
  const openState = open !== null ? reads.get(open) : undefined;
  const openPlan = open !== null && v && !openState ? plan(open) : null;
  const symState = open !== null ? pinReads.get(open) : undefined;
  const symPlan = open !== null && v && !symState ? pinPlan(open) : null;
  const symTwin = symPlan && open !== null ? twinOf(open) : -1;
  const symChecks = symDraft && open !== null && v ? symbolChecks(symDraft, v.variants[open]!, fpPads) : [];
  /** How a job went: its steps, under way, failed or done. */
  const progress = (st: ReadState<unknown> | undefined) => (<>
    {st?.state === 'queued' && <p class="ai-busy">Waiting its turn: the variants ticked are made one after another.</p>}
    {st?.state === 'reading' && <div class="ai-busy"><Steps done={st.done} /><p>{st.step} <span class="muted">{took(Date.now() - st.since)}</span></p></div>}
    {st?.state === 'error' && <><Steps done={st.done} /><p class="ai-error">{st.error}</p></>}
  </>);
  const how = (st: { done: Done[] }) => (st.done.length > 0
    ? <details class="ai-how small"><summary>How it went: {st.done.length} step{st.done.length === 1 ? '' : 's'}, {took(st.done.reduce((t, d) => t + d.ms, 0))}</summary><Steps done={st.done} /></details> : null);

  return (
    <Dialog title="Component Builder" width={1180} height={760} onClose={closeDialog} class="ai-builder"
      footer={<>
        {result && <span class="small muted">{usage(result)} Check against the datasheet.</span>}
        <span class="spacer" />
        {v && <button class="btn" disabled={!toRead.length || !drawingsOk} onClick={() => void readTicked()} title="Footprints for the ticked variants from their drawings (one job each)">Create Footprints{toRead.length ? ` (${toRead.length})` : ''}</button>}
        {v && <button class="btn" disabled={!toReadPins.length || !pinsOk} onClick={() => void readTickedPins()} title="Schematic symbols for the ticked variants from their pin tables (one job for each pinout)">Create Symbols{toReadPins.length ? ` (${toReadPins.length})` : ''}</button>}
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="ai-builder-body">
        <div class="ai-builder-main">
          <div class="ai-top">
            <button class="btn" disabled={working} onClick={() => fileRef.current?.click()}>Datasheet (PDF)…</button>
            <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void open1(f); (e.target as HTMLInputElement).value = ''; }} />
            <span class="ai-file">{sheet ? `${sheet.name} — ${sheet.pageCount} page${sheet.pageCount === 1 ? '' : 's'}${sheet.title ? ` — ${sheet.title}` : ''}` : <span class="muted">or drop a PDF here</span>}</span>
            <label for="ai-part">Part number</label>
            {/* The part number, and (R21) the way from it to its datasheet: one cell, so the rows keep their two columns */}
            <span class="ai-part">
              <input id="ai-part" type="text" placeholder="the one you'll use (optional)" value={partNumber} onInput={(e) => setPartNumber((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canFind) void findIt(); }} />
              {featureOn('partsLibrary') && <button type="button" class="ex-icon-btn" aria-label="Find Its Datasheet" disabled={!canFind} onClick={() => void findIt()} title={findHint}><Icon name="partsSearch" /></button>}
            </span>
            {picker}
          </div>
          <div class="ai-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void open1(f); }}>
            {featureOn('partsLibrary') && !sheet && !busy && partNumber.trim() && (
              <div class="ai-find">
                <Icon name="partsSearch" size={24} />
                <p>Find the datasheet of <b>{partNumber.trim()}</b> on the web</p>
                <p class="small muted">{canSearch() ? 'The part number goes to the AI service, which looks for the maker\'s datasheet; the PDF is then fetched through the Konium service.' : findHint}</p>
                <button type="button" class="btn default" disabled={!canFind} onClick={() => void findIt()}>Find Its Datasheet</button>
                <p class="small muted">or drop its PDF here</p>
              </div>
            )}
            {input && !result && (
              <div class="ai-send">
                <p>Sends the text of {input.pages.length === sheet!.pageCount ? `all ${sheet!.pageCount} pages` : `${input.pages.length} of ${sheet!.pageCount} pages (those about ordering, packages and pins)`}{surveyPics.length ? `, and pictures of page${surveyPics.length === 1 ? '' : 's'} ${surveyPics.join(', ')} (drawings with little text)` : ''} — about {surveyTokens.toLocaleString(locale())} tokens — to {destination()}{modelInfo() ? `, model ${modelInfo()!.name}` : modelFor(mode) ? `, model ${shownId(modelFor(mode))}` : ''}.</p>
                <p class="small muted">{cost(surveyTokens, SURVEY.maxTokens)}</p>
                <button class="btn default" disabled={!!busy} onClick={() => void survey()}>Read the Datasheet</button>
              </div>
            )}
            {busy && <p class="ai-busy">{busy} <span class="muted">{took(Date.now() - busyAt.current)}</span></p>}
            {error && <p class="ai-error">{error}</p>}
            {v && (
              <>
                <p><b>{v.maker} {v.device}</b>{v.description ? ` — ${v.description}` : ''}{result?.cached && <> · <a href="#" onClick={(e) => { e.preventDefault(); void survey(true); }}>Read it again with AI</a></>}</p>
                <table class="ai-variants">
                  <thead><tr><th /><th>Part numbers</th><th>Package</th><th>Pins</th><th>Leads</th><th>Body (mm)</th><th>Pitch</th><th>Pinout</th><th>Drawing</th><th>Land pattern</th><th>Pin table</th><th>Footprint</th><th>Symbol</th></tr></thead>
                  <tbody>{v.variants.map((x: Variant, k) => (
                    <tr key={k} class={open === k ? 'on' : ''}>
                      <td><input type="checkbox" checked={ticked.has(k)} onChange={(e) => { const s = new Set(ticked); if ((e.target as HTMLInputElement).checked) s.add(k); else s.delete(k); setTicked(s); }} /></td>
                      <td>{x.partNumbers.join(', ') || <span class="muted">—</span>}</td>
                      <td>{x.package}{x.thermalPad ? ' (thermal pad)' : ''}</td>
                      <td>{x.pins || '?'}</td>
                      <td>{x.leadForm}</td>
                      <td>{[x.body.length, x.body.width, x.body.height].map((n) => (n === null ? '?' : n)).join(' × ')}</td>
                      <td>{x.pitch ?? '—'}</td>
                      <td>{x.pinout}</td>
                      <td>{pageLinks(x.drawingPages)}</td>
                      <td>{pageLinks(x.landPatternPages)}</td>
                      <td>{pageLinks(x.pinTablePages)}</td>
                      <td>{status(k, 'footprint')}</td>
                      <td>{status(k, 'symbol')}</td>
                    </tr>))}
                  </tbody>
                </table>
                <div class="sync-buttons">
                  <button class="btn" onClick={() => setTicked(new Set(v.variants.map((_, k) => k)))}>Select All</button>
                  <button class="btn" onClick={() => setTicked(new Set())}>Select None</button>
                </div>
                <p class="small muted">Click a page number to see the page. Tick the variants you want and Create Footprints or Create Symbols (or create… one at a time); each is yours to check and change before it goes into a library. A footprint comes with its 3D body.</p>
              </>
            )}
            {v && open !== null && v.variants[open] && (
              <div class="ai-package">
                <div class="ai-head">
                  <h4>{v.variants[open]!.package}{v.variants[open]!.partNumbers.length ? ` — ${v.variants[open]!.partNumbers.slice(0, 3).join(', ')}` : ''}</h4>
                  <div class="out-tabs" role="tablist">
                    <button role="tab" aria-selected={view === 'footprint'} class={view === 'footprint' ? 'on' : ''} onClick={() => setView('footprint')}>Footprint</button>
                    <button role="tab" aria-selected={view === 'symbol'} class={view === 'symbol' ? 'on' : ''} onClick={() => setView('symbol')}>Symbol</button>
                  </div>
                </div>
                {featureOn('partsLibrary') && (
                  <div class="ai-keep">
                    <Icon name="part" />
                    <span class="small">{kept.has(open) ? <>Kept on your shelf as <b>{kept.get(open)}</b> (Tools › Parts).</>
                      : !partNo(open) ? 'A part needs its exact part number: type it above.'
                      : made?.built && symDraft ? <>As <b>{partNo(open)}</b>: its symbol and its footprint with the datasheet's pages, on your shelf (Tools › Parts).</>
                      : <>A part is this variant's footprint and its symbol together: make {made?.built ? 'its symbol' : symDraft ? 'its footprint' : 'both'}, then keep it as <b>{partNo(open)}</b>.</>}</span>
                    <button type="button" class={`btn${made?.built && symDraft && partNo(open) && !kept.has(open) ? ' default' : ''}`} disabled={!made?.built || !symDraft || !partNo(open)} onClick={keepAsPart}>Keep as a Part</button>
                  </div>
                )}
                {view === 'footprint' && <>
                {openPlan && (
                  <div class="ai-send">
                    <p>{openPlan.pages.length
                      ? locating && openPlan.find.length
                        ? <>Finds the drawings on page{openPlan.find.length === 1 ? '' : 's'} {openPlan.find.join(', ')} (a small job), then sends them enlarged with the text of page{openPlan.pages.length === 1 ? '' : 's'} {openPlan.pages.join(', ')}</>
                        : <>Sends the text of page{openPlan.pages.length === 1 ? '' : 's'} {openPlan.pages.join(', ')}{openPlan.pictures.length ? `, and pictures of page${openPlan.pictures.length === 1 ? '' : 's'} ${openPlan.pictures.join(', ')}` : ''}</>
                      : <>The datasheet has no drawing of this package: sends its name and pin count, for the standard package's dimensions</>}
                      {' '}— about {planTokens(open).toLocaleString(locale())} tokens — to {destination()}.</p>
                    {!canSee && openPlan.pages.length > 0 && <p class="small ai-error">No model for reading drawings is chosen (Preferences › System › AI): only the pages' text goes.</p>}
                    <p class="small muted">{cost(planTokens(open), PACKAGE.maxTokens, checks)}</p>
                    {drawingsOk ? <button class="btn default" onClick={() => void readDrawing(open)}>Create Footprint</button> : <p class="ai-error">{NOT_YET}.</p>}
                  </div>
                )}
                {progress(openState)}
                {openState?.state === 'error' && retry(() => void readDrawing(open, true), 'Another model may do better: choose it above.')}
                {openState?.state === 'ready' && draft && (
                  <>
                    {retry(() => void readDrawing(open, true), <span class="muted">{usage(openState.result)} Pages read: {pageLinks(draft.read.pages)}.</span>)}
                    {how(openState)}
                    <PackageReview draft={draft} onChange={(d) => put(open, d)} prims={prims} checks={[...reviewChecks(draft), ...(made?.built?.checks ?? [])]} error={made?.error} name={made?.built?.fp.name ?? ''} />
                    <div class="ai-row ai-add">
                      {made?.built?.checks.some((c) => c.level === 'error') && <span class="small ai-error">Look at the checks first.</span>}
                      <label>Into <select aria-label="Library" value={libs.some((d) => d.id === target) ? target : 'new'} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
                        {libs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        <option value="new">New PCB library</option>
                      </select></label>
                      <button class="btn default" disabled={!made?.built || !(draft.name ?? made.built.fp.name).trim()} onClick={addToLibrary}>Add to Library</button>
                    </div>
                  </>
                )}
                </>}
                {view === 'symbol' && <>
                {symPlan && (
                  <div class="ai-send">
                    {symTwin >= 0
                      ? <p>The same pinout as {variantName(symTwin)}, read already: its pins, without another job.</p>
                      : <>
                        <p>{symPlan.pages.length
                          ? <>Sends the text of page{symPlan.pages.length === 1 ? '' : 's'} {symPlan.pages.join(', ')}{symPlan.pictures.length ? `, and pictures of ${symPlan.pictures.length === symPlan.pages.length ? (symPlan.pages.length === 1 ? 'it' : 'them') : `page${symPlan.pictures.length === 1 ? '' : 's'} ${symPlan.pictures.join(', ')}`}` : ''} (the pin table)</>
                          : <>No pin table was found for this variant: sends its package and pin count, for the pins its kind of part has</>}
                          {' '}— about {pinTokens(open).toLocaleString(locale())} tokens — to {destination()}.</p>
                        <p class="small muted">{cost(pinTokens(open), PINS.maxTokens)}</p>
                      </>}
                    {pinsOk ? <button class="btn default" onClick={() => void readPins(open)}>Create Symbol</button> : <p class="ai-error">{NOT_YET}.</p>}
                  </div>
                )}
                {progress(symState)}
                {symState?.state === 'error' && retry(() => void readPins(open, true), 'Another model may do better: choose it above.')}
                {symState?.state === 'ready' && symDraft && (
                  <>
                    {retry(() => void readPins(open, true), <span class="muted">{usage(symState.result)} Pages read: {pageLinks(symDraft.read.pages)}.</span>)}
                    {how(symState)}
                    <SymbolReview draft={symDraft} onChange={(d) => putSym(open, d)} checks={symChecks} />
                    <div class="ai-row ai-add">
                      {symChecks.some((c) => c.level === 'error') && <span class="small ai-error">Look at the checks first.</span>}
                      <label>Into <select aria-label="Schematic library" value={schLibs.some((d) => d.id === schTarget) ? schTarget : 'new'} onChange={(e) => setSchTarget((e.target as HTMLSelectElement).value)}>
                        {schLibs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        <option value="new">New schematic library</option>
                      </select></label>
                      <button class="btn default" disabled={!symDraft.name.trim() || !symDraft.read.pins.length} onClick={addSymbol}>Add to Library</button>
                    </div>
                  </>
                )}
                </>}
              </div>
            )}
          </div>
        </div>
        {preview && <div class="ai-preview"><div class="small muted">Page {preview.page}</div><img src={preview.url} alt={`Datasheet page ${preview.page}`} /></div>}
      </div>
    </Dialog>
  );
}
