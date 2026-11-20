/**
 * Requirements document › Split a Specification With AI: a cheap text model (Qwen Flash, always
 * its family's newest, on the Konium service and with an OpenRouter key; else the model chosen in
 * Preferences › System › AI) reads a specification (pasted, or opened: text, Markdown, Word or PDF) and splits it into
 * single requirements, each with its section, the specification's clause, a short title, its text
 * in the specification's words (with the rows of a table it needs, as a table), type, priority and
 * how it would be verified; a Word document's pictures go with the requirements that refer to
 * them. They are shown to review; the ones ticked go at the end of the document (one step to
 * undo), with the next identifiers and their source kept.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { prefsPage, showPrefs } from '../state';
import { settings } from '../../core/settings';
import { MAX_SPEC, REQS, type DraftReq, type ReqsInput } from '../../ai/jobs';
import { AiError, NOT_YET, allowanceNote, cheapModelInfo, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig } from '../../ai/client';
import { SPEC_ACCEPT, specDoc, type SpecPicture } from '../../ai/specText';
import { draftRows, type Draft } from '../../model/reqIO';
import { isRich, sanitiseHtml, textToHtml, toBase64, type ReqFile } from '../../model/richText';
import { RichView, pictureUrl } from '../RichText';
import { METHODS, PRIORITIES, REQ_TYPES, isReq, labelOf, type Requirement } from '../../model/requirements';
import type { ReqDocument } from '../../formats/reqDoc';
import { changeReqs } from '../requirementsData';

interface Row { d: DraftReq; keep: boolean }

export function ReqAiSplitDialog({ doc, existing, onDone }: { doc: ReqDocument; existing: () => Requirement[]; onDone: (first: number) => void }) {
  const mode = settings.aiMode;
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pics, setPics] = useState<SpecPicture[]>([]);
  const thumbs = useMemo(() => new Map(pics.map((p) => [p.n, `data:${p.type};base64,${toBase64(p.bytes)}`])), [pics]);
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    // The cheap text model where it runs (the service's, or OpenRouter's with a key), else the one chosen
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'reqs'), allowance: c.allowance, model: (c.cheapJobs?.includes('reqs') ? c.cheap : undefined) ?? c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else if (mode === 'key' && settings.aiProvider === 'openrouter') void cheapModelInfo(mode).then((m) => { if (live) setInfo({ runs: true, model: m ?? undefined }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const input: ReqsInput = { text: text.slice(0, MAX_SPEC), title: title.trim() };
  const cost = !text.trim() ? '' : mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}.`
    : `Estimated cost: ${money(estimateCost(estimateTokens(REQS.messages(input)), Math.min(REQS.maxTokens, 1500 + input.text.length / 5), info.model))}.`;

  const open = async (f: File) => {
    setState(`Reading ${f.name}…`); setBusy(true);
    try {
      const d = await specDoc(f.name, new Uint8Array(await f.arrayBuffer()));
      if (!d.text.trim()) throw new Error(`${f.name} has no text${/\.pdf$/i.test(f.name) ? ' (a scanned PDF has pictures of its pages, not text)' : ''}`);
      setText(d.text); setPics(d.pictures); setTitle(f.name.replace(/\.[^.]+$/, '')); setState('');
    } catch (e) { setState((e as Error).message); }
    setBusy(false);
  };
  const run = async () => {
    setRows(null); setBusy(true);
    setState('Asking the model… (a long specification takes a minute or two)');
    try {
      const r = await runJob(REQS, input);
      setRows(r.value.requirements.map((d) => ({ d, keep: true })));
      setState(r.value.requirements.length ? `${r.value.requirements.length} requirement${r.value.requirements.length === 1 ? '' : 's'} from ${r.model}: check them against the specification` : `${r.model} found no requirements in it`);
    } catch (e) { setState(e instanceof AiError || e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  /** A requirement found as one to add: its table as a table, its pictures where it marks them (else at its end). */
  const draftOf = async (d: DraftReq): Promise<Draft> => {
    let h = textToHtml(d.text);
    const files: ReqFile[] = [];
    for (const n of d.pictures) {
      const p = pics.find((x) => x.n === n);
      if (!p) continue;
      const url = await pictureUrl(new Blob([p.bytes as Uint8Array<ArrayBuffer>], { type: p.type }));
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!m) continue;
      const id = `f${files.length + 1}`;
      files.push({ id, name: p.name, type: m[1]!, data: m[2]!, inline: true });
      const img = `<img src="kfile:${id}" alt="Picture ${n}">`;
      h = h.includes(`[Picture ${n}]`) ? h.split(`[Picture ${n}]`).join(img) : `${h}<p>${img}</p>`;
    }
    const html = sanitiseHtml(h);
    return { ...d, source: [title.trim(), d.ref].filter(Boolean).join(' '), ...(isRich(html) ? { html } : {}), ...(files.length ? { files } : {}) };
  };
  const add = async () => {
    const ticked = await Promise.all((rows ?? []).filter((r) => r.keep).map(({ d }) => draftOf(d)));
    if (!ticked.length) return;
    const made = draftRows(ticked, doc.reqs, existing());
    const first = doc.reqs.rows.length;
    changeReqs(doc, () => { doc.reqs.rows.push(...made); });
    onDone(first + Math.max(0, made.findIndex(isReq)));
    closeDialog();
  };
  const kept = (rows ?? []).filter((r) => r.keep).length;

  if (mode === 'off') {
    return (
      <Dialog title="Split a Specification With AI" width={520} onClose={closeDialog} footer={<><span class="spacer" /><button class="btn default" onClick={() => { closeDialog(); prefsPage.value = 'sys-ai'; showPrefs.value = true; }}>Open Preferences...</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
        <p>AI is off. Choose how Konium Designer reaches a model (the Konium service, your own key, or a model on your computer) in Preferences › System › AI.</p>
      </Dialog>
    );
  }
  return (
    <Dialog title="Split a Specification With AI" width={rows ? 1000 : 640} height={rows ? 640 : undefined} onClose={closeDialog} class="rq-ai"
      footer={<>{rows ? <button class="btn default" disabled={!kept || busy} onClick={() => { setBusy(true); void add().finally(() => setBusy(false)); }}>Add Ticked ({kept})</button>
        : <button class="btn default" disabled={busy || !text.trim() || !info.runs || (mode !== 'konium' && !modelFor(mode))} onClick={() => void run()}>Split Into Requirements</button>}
        <span class="small rq-dlg-state">{state}</span><span class="spacer" />{rows && <button class="btn" onClick={() => { setRows(null); setState(''); }}>Back</button>}<button class="btn" onClick={closeDialog}>{rows ? 'Close' : 'Cancel'}</button></>}>
      {!rows ? (
        <div class="rq-dlg">
          <label class="rq-file">Open<input type="file" accept={SPEC_ACCEPT} aria-label="Specification file" disabled={busy} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void open(f); }} /><span class="small muted">text, Markdown, Word (.docx) or PDF</span></label>
          <label class="rq-field">Specification<textarea aria-label="Specification text" rows={14} placeholder="Paste the specification here, or open its file" value={text} onInput={(e) => { const v = (e.target as HTMLTextAreaElement).value; setText(v); if (!v.includes('[Picture ')) setPics([]); }} /></label>
          <label class="rq-file">Name<input aria-label="Specification name" value={title} placeholder="e.g. Customer spec rev B (kept as each requirement's source)" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
          <p class="small">{text.length ? `${text.length.toLocaleString()} characters. ` : ''}{text.length > MAX_SPEC ? `The first ${MAX_SPEC.toLocaleString()} go. ` : ''}Sends the specification's text and name, and nothing of the design, to {destination()}. {cost}</p>
          {pics.length > 0 && <p class="small">{pics.length} picture{pics.length === 1 ? '' : 's'} in it, marked [Picture 1] and on in the text: each goes with the requirements that refer to it (the pictures themselves are not sent).</p>}
          <p class="small muted">Each requirement keeps the specification's words and figures; the model is told never to add one the text doesn't state. Check them before you rely on them.</p>
          {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
        </div>
      ) : (
        <div class="rq-ai-scroll">
          <table class="sd-table rq-ai-rows" aria-label="Requirements found">
            <thead><tr><th><input type="checkbox" aria-label="Tick all" checked={kept === rows.length} onChange={() => setRows(rows.map((r) => ({ ...r, keep: kept !== rows.length })))} /></th><th>Section</th><th>Clause</th><th>Title</th><th>Requirement</th>{pics.length > 0 && <th>Pictures</th>}<th>Type</th><th>Priority</th><th>Method</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} class={r.keep ? '' : 'rq-ai-off'}>
                <td><input type="checkbox" aria-label={`Keep ${r.d.title}`} checked={r.keep} onChange={() => setRows(rows.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))} /></td>
                <td>{r.d.section}</td><td>{r.d.ref}</td><td><b>{r.d.title}</b></td><td class="rq-preview-text"><RichView text={r.d.text} html={isRich(textToHtml(r.d.text)) ? sanitiseHtml(textToHtml(r.d.text)) : undefined} /></td>
                {pics.length > 0 && <td class="rq-ai-pics">{r.d.pictures.filter((n) => thumbs.has(n)).map((n) => <img key={n} src={thumbs.get(n)} alt={`Picture ${n}`} title={`Picture ${n}`} />)}</td>}
                <td>{labelOf(REQ_TYPES, r.d.type)}</td><td>{labelOf(PRIORITIES, r.d.priority)}</td><td>{labelOf(METHODS, r.d.method)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
