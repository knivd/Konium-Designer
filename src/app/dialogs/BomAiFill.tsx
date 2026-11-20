/**
 * BOM document › Fill Part Numbers With AI: the model chosen (Preferences › System › AI) picks a
 * manufacturer part for each line — the lines with no part choices, or every line — from what the
 * line says (designators, comment, description, footprint, parameters; nothing else of the
 * design). Each suggestion is then looked up at JLCPCB (by its LCSC number, else its part number
 * exactly) before it is offered; the designer ticks the ones to keep, which become part choices.
 */
import { locale } from '../../core/locale';
import { useEffect, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { prefsPage, showPrefs } from '../state';
import { settings } from '../../core/settings';
import { MPN, type MpnInput, type MpnLine, type MpnSuggestion } from '../../ai/jobs';
import { AiError, NOT_YET, allowanceNote, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig } from '../../ai/client';
import { choiceBag, lcscUrl, lineChoices, unitPrice, type BomLine, type Choice } from '../../model/activeBom';
import { verifyPart, type JlcPart } from '../../platform/jlcSearch';
import type { PropertyBag } from '../../formats/altium/props';

interface Row { s: MpnSuggestion; line: BomLine; part: JlcPart | null; note: string; keep: boolean }
const SYM: Record<string, string> = { USD: '$' };

/** A line as the model sees it: what it says, nothing of the drawing or the nets. */
export function mpnLine(l: BomLine, id: string): MpnLine {
  const it = l.parts[0]!;
  const skip = /^(Designator|Comment|Description|Footprint|LibRef|Quantity|Fitted)$/i;
  const params = Object.entries(it).filter(([k, v]) => !skip.test(k) && v.trim() && v.trim() !== '*' && v.length < 120).slice(0, 20).map(([k, v]) => `${k}=${v}`).join('; ');
  return { id, designators: l.designators.join(', '), comment: it.Comment ?? '', description: it.Description ?? '', footprint: it.Footprint ?? '', params };
}

export function BomAiFillDialog({ lines, production, add }: { lines: BomLine[]; production: number; add: (line: BomLine, b: PropertyBag) => void }) {
  const mode = settings.aiMode;
  const empty = lines.filter((l) => !lineChoices(l).length);
  const [which, setWhich] = useState<'empty' | 'all'>(empty.length ? 'empty' : 'all');
  const [prefer, setPrefer] = useState<'jlcpcb' | 'any'>('jlcpcb');
  const [focus, setFocus] = useState('');
  const [state, setState] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'mpn'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const chosen = which === 'empty' ? empty : lines;
  const input: MpnInput = { lines: chosen.slice(0, 200).map((l, i) => mpnLine(l, `L${i + 1}`)), prefer, focus: focus.trim() };
  const cost = mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}.`
    : `Estimated cost: ${money(estimateCost(estimateTokens(MPN.messages(input)), 120 * input.lines.length + 2000, info.model))}.`;

  const run = async () => {
    setRows(null);
    setState('Asking the model…');
    try {
      const r = await runJob(MPN, input);
      const out: Row[] = [];
      const byId = new Map(input.lines.map((l, i) => [l.id, chosen[i]!]));
      let k = 0;
      for (const s of r.value.parts) {
        const line = byId.get(s.id);
        if (!line) continue;
        setState(`Looking the parts up at JLCPCB: ${++k} of ${r.value.parts.length}…`);
        let v: { part: JlcPart | null; note: string } = { part: null, note: s.mpn ? '' : 'no part suggested' };
        if (s.mpn || s.lcsc) { try { v = await verifyPart(s.mpn, s.lcsc); } catch (e) { v = { part: null, note: `JLCPCB couldn't be asked (${(e as Error).message})` }; } }
        out.push({ s, line, part: v.part, note: v.note, keep: !!s.mpn && (!!v.part || prefer === 'any') && s.confidence !== 'low' });
      }
      setRows(out);
      setState(`${out.length} suggestion${out.length === 1 ? '' : 's'} from ${r.model}; ${out.filter((x) => x.part).length} found at JLCPCB`);
    } catch (e) { setState(e instanceof AiError || e instanceof Error ? e.message : String(e)); }
  };
  const keep = () => {
    for (const r of rows ?? []) {
      if (!r.keep || !r.s.mpn) continue;
      const p = r.part;
      add(r.line, p ? choiceBag({ manufacturer: r.s.manufacturer, mpn: p.mpn, supplier: 'LCSC', spn: p.lcsc, stock: p.stock, prices: p.prices, currency: 'USD', lifecycle: '', url: lcscUrl(p.lcsc), description: p.description, library: p.library }, 'JLCPCB')
        : choiceBag({ manufacturer: r.s.manufacturer, mpn: r.s.mpn, supplier: '', spn: '', prices: [], currency: 'USD', lifecycle: '', url: '', description: '' }, 'AI'));
    }
    closeDialog();
  };

  if (mode === 'off') {
    return (
      <Dialog title="Fill Part Numbers With AI" width={520} onClose={closeDialog} footer={<><span class="spacer" /><button class="btn default" onClick={() => { closeDialog(); prefsPage.value = 'sys-ai'; showPrefs.value = true; }}>Open Preferences...</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
        <p>AI is off. Choose how Konium Designer reaches a model (the Konium service, your own key, or a model on your computer) in Preferences › System › AI.</p>
      </Dialog>
    );
  }
  return (
    <Dialog title="Fill Part Numbers With AI" width={rows ? 960 : 560} height={rows ? 600 : undefined} onClose={closeDialog} class="bom-ai"
      footer={<>{rows ? <button class="btn default" disabled={!rows.some((r) => r.keep)} onClick={keep}>Add Ticked ({rows.filter((r) => r.keep).length})</button>
        : <button class="btn default" disabled={!chosen.length || !info.runs || (mode !== 'konium' && !modelFor(mode))} onClick={() => void run()}>Suggest Parts</button>}
        <span class="bom-ai-state small">{state}</span><span class="spacer" /><button class="btn" onClick={closeDialog}>{rows ? 'Close' : 'Cancel'}</button></>}>
      {!rows ? (
        <div class="bom-ai-setup">
          <fieldset><legend>Lines</legend>
            <label><input type="radio" name="which" checked={which === 'empty'} disabled={!empty.length} onChange={() => setWhich('empty')} />Lines with no part choices ({empty.length})</label>
            <label><input type="radio" name="which" checked={which === 'all'} onChange={() => setWhich('all')} />Every line ({lines.length}): suggestions are added after the part choices a line has</label>
          </fieldset>
          <fieldset><legend>Assembly</legend>
            <label><input type="radio" name="prefer" checked={prefer === 'jlcpcb'} onChange={() => setPrefer('jlcpcb')} />At JLCPCB: parts it stocks, its Basic parts first, with their LCSC numbers</label>
            <label><input type="radio" name="prefer" checked={prefer === 'any'} onChange={() => setPrefer('any')} />Parts from any distributor</label>
          </fieldset>
          <label class="bom-ai-focus">Also<input value={focus} placeholder="e.g. automotive grade, 50 V capacitors, prefer Murata" onInput={(e) => setFocus((e.target as HTMLInputElement).value)} /></label>
          <p class="small">Sends each line's designators, comment, description, footprint and parameters — no drawings, no nets — to {destination()}. {cost}</p>
          <p class="small muted">Every suggestion is looked up at JLCPCB (jlcsearch.tscircuit.com) before it is offered: part numbers that aren't there are shown as such. Check the parts before ordering.</p>
          {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
          {lines.length > 200 && which === 'all' && <p class="small">The first 200 lines go.</p>}
        </div>
      ) : (
        <div class="bom-ai-scroll">
          <table class="sd-table bom-ai-rows" aria-label="Suggested parts">
            <thead><tr><th /><th>Line</th><th>Comment</th><th>Suggested part</th><th>Confidence</th><th>At JLCPCB</th><th>Why</th></tr></thead>
            <tbody>{rows.map((r, i) => {
              const units = r.line.quantity * production;
              const price = r.part ? unitPrice({ prices: r.part.prices } as Choice, units) : undefined;
              return (
                <tr key={i} class={r.part ? '' : 'bom-ai-miss'}>
                  <td><input type="checkbox" aria-label={`Keep ${r.s.mpn || r.s.id}`} checked={r.keep} disabled={!r.s.mpn} onChange={() => setRows(rows.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))} /></td>
                  <td>{r.line.designators.slice(0, 4).join(', ')}{r.line.designators.length > 4 ? '…' : ''}</td>
                  <td>{r.line.parts[0]!.Comment}</td>
                  <td>{r.s.mpn ? <><b>{r.s.mpn}</b><div class="muted">{r.s.manufacturer}</div></> : <span class="muted">none</span>}</td>
                  <td class={`bom-ai-conf ${r.s.confidence}`}>{r.s.confidence}</td>
                  <td>{r.part ? <><a href={lcscUrl(r.part.lcsc)} target="_blank" rel="noopener noreferrer">{r.part.lcsc}</a><span class={`bom-lib ${r.part.library.toLowerCase()}`}>{r.part.library}</span>
                    <div class="muted">stock {r.part.stock === undefined ? 'not given' : r.part.stock.toLocaleString(locale())}{price !== undefined ? ` · ${SYM.USD}${price < 1 ? price.toFixed(4) : price.toFixed(2)}` : ''}</div></> : <span class="muted">{r.note || 'not found'}</span>}
                    {r.part && r.note && <div class="muted small">{r.note}</div>}</td>
                  <td class="small">{r.s.why}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
