import { locale } from '../core/locale';
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '../core/settings';
import { followSuccessors, shownId } from '../ai/models';
import { jobTokens,
  LOCAL_PRESETS, aiKey, destination, connection, listModels, monthUsage, money, serviceConfig, setAiKey, testConnection,
  modelFor, withModel, type AiMode, type ModelInfo, type ServiceConfig,
} from '../ai/client';

type SetDraft = (patch: Partial<Settings>) => void;

const MODES: [AiMode, string, string][] = [
  ['off', 'Off', 'No AI: nothing is sent anywhere.'],
  ['konium', 'Konium service', 'Free within a daily allowance of job tokens, paid for by Konium Designer\'s author. Jobs go to konium.app, then to the chosen model through OpenRouter; providers that train on what they\'re sent are excluded.'],
  ['key', 'Your own key', 'OpenRouter (every model with one key) or any endpoint that speaks OpenAI\'s chat completions. You pay your provider; the key stays in this browser and goes only to that endpoint.'],
  ['local', 'Local model', 'Ollama, LM Studio, llama.cpp … on this computer or your network. Nothing leaves it.'],
];

const price = (m: ModelInfo) => (m.priceIn !== undefined && m.priceOut !== undefined ? ` — $${fmt(m.priceIn)} / $${fmt(m.priceOut)} per M tokens` : '');
const fmt = (n: number) => (n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0));
const reads = (m: ModelInfo) => m.vision === true || (m.vision === null && m.visionGuess);

/**
 * Preferences › System › AI: how Konium's AI tools connect (off until chosen), the models for
 * reading text and drawings, a connection test, this month's use, and what each job sends.
 */
export function AiPreferences({ draft, set }: { draft: Settings; set: SetDraft }) {
  const mode = draft.aiMode;
  const [key, setKey] = useState(aiKey());
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [svc, setSvc] = useState<ServiceConfig | null>(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const usage = monthUsage();
  // A chosen model no longer listed: its successor chosen instead, quietly
  const follow = (list: ModelInfo[]) => { const moved = followSuccessors(draft.aiModels, mode, list, mode === 'konium'); if (moved) set({ aiModels: moved }); };

  // The Konium service's models and allowance, as soon as it's chosen
  useEffect(() => {
    setModels(null); setStatus(null);
    if (mode !== 'konium') return;
    let live = true;
    serviceConfig().then((c) => { if (live) { setSvc(c); setModels(c.models); follow(c.models); } }).catch((e) => { if (live) setStatus({ text: (e as Error).message, bad: true }); });
    return () => { live = false; };
  }, [mode]);

  const load = async () => {
    setBusy(true); setStatus(null);
    try { const list = await listModels(mode, draft); setModels(list); follow(list); setStatus({ text: `${list.length} model${list.length === 1 ? '' : 's'}` }); } catch (e) { setStatus({ text: (e as Error).message, bad: true }); }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true); setStatus({ text: 'Testing…' });
    try { setStatus({ text: await testConnection(mode, draft) }); } catch (e) { setStatus({ text: (e as Error).message, bad: true }); }
    setBusy(false);
  };
  // One model does every job, survey to footprint (a specification's requirements: the cheap text model, on the service and OpenRouter)
  const choose = (id: string) => set({ aiModels: withModel(draft.aiModels, mode, id) });
  const chosen = () => modelFor(mode, draft.aiModels);

  const picker = (label: string, help: string) => {
    const q = filter.trim().toLowerCase();
    const now = chosen();
    // It reads drawings: a model that takes pictures (or might)
    const list = (models ?? []).filter((m) => (reads(m) || m.id === now) && (!q || `${shownId(m.id)} ${m.name}`.toLowerCase().includes(q) || m.id === now));
    const def = mode === 'konium' ? svc?.defaults.model ?? svc?.defaults.vision : undefined;
    return (
      <label class="pref-row ai-model">{label}
        <select value={now} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>
          <option value="">{mode === 'konium' ? `Default${def ? ` (${models?.find((m) => m.id === def)?.name ?? def})` : ''}` : '(choose one)'}</option>
          {now && !list.some((m) => m.id === now) && <option value={now}>{shownId(now)}</option>}
          {list.map((m) => <option key={m.id} value={m.id}>{m.name !== m.id ? `${m.name} (${shownId(m.id)})` : shownId(m.id)}{price(m)}{mode === 'konium' && m.weight ? ` — ${jobTokens(m.weight)} a job` : ''}{m.vision === null && m.visionGuess ? ' — takes pictures?' : ''}</option>)}
        </select>
        <span class="pref-help">{help}</span>
      </label>
    );
  };

  return (
    <>
      <fieldset class="pref-section wide ai-modes">
        <legend>AI</legend>
        <p class="pref-help">Konium Designer's AI tools (Tools › Component Builder in the libraries) run only when you start them, and show what they will send before sending it.</p>
        {MODES.map(([m, label, help]) => (
          <label key={m} class="pref-row ai-mode">
            <input type="radio" name="ai-mode" checked={mode === m} onChange={() => set({ aiMode: m })} />
            <span><b>{label}</b><span class="pref-help">{help}</span></span>
          </label>
        ))}
      </fieldset>

      {mode === 'konium' && (
        <fieldset class="pref-section wide">
          <legend>Konium service</legend>
          <p class="pref-help">{svc ? `Today's job tokens: ${svc.allowance.left} of ${svc.allowance.jobs} left.${svc.allowance.weighed ? ' A job takes one on the cheapest model, and as many as it costs times more on a dearer one (beside each model), so a day\'s tokens cost about the same whichever model you choose.' : ''}` : 'Asking the service…'}</p>
          <label class="pref-row is-check"><input type="checkbox" checked={draft.aiShareCache} onChange={(e) => set({ aiShareCache: (e.target as HTMLInputElement).checked })} />
            Share what I accept, and use what others accepted</label>
          <p class="pref-help">What was read from a public datasheet (its packages, drawings, pins) and accepted in the review is kept by the datasheet's fingerprint, so the next person reading it gets it at once, with nothing used from the allowance. Nothing of your design is kept.</p>
        </fieldset>
      )}

      {mode === 'key' && (
        <fieldset class="pref-section wide">
          <legend>Your own key</legend>
          <label class="pref-row">Provider
            <select value={draft.aiProvider} onChange={(e) => set({ aiProvider: (e.target as HTMLSelectElement).value as Settings['aiProvider'] })}>
              <option value="openrouter">OpenRouter (openrouter.ai)</option>
              <option value="custom">Another endpoint (OpenAI's chat completions)</option>
            </select>
          </label>
          {draft.aiProvider === 'custom' && (
            <label class="pref-row">Address
              <input type="text" placeholder="https://api.openai.com/v1" value={draft.aiCustomBase} onChange={(e) => set({ aiCustomBase: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          <label class="pref-row ai-key">Key
            {showKey
              ? <input type="text" autocomplete="off" spellcheck={false} value={key} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setKey(v); setAiKey(v); }} />
              : <input type="password" autocomplete="off" value={key} placeholder={draft.aiProvider === 'openrouter' ? 'sk-or-…' : ''} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setKey(v); setAiKey(v); }} />}
            <button class="btn" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button>
          </label>
          <p class="pref-help">Kept in this browser only (not in exported preferences), and sent only to {destination(connection('key', draft)).replace(/, with your key$/, '')}. Saved as you type.{draft.aiProvider === 'openrouter' ? ' On OpenRouter a credit limit on the key keeps the bill in hand.' : ''}</p>
        </fieldset>
      )}

      {mode === 'local' && (
        <fieldset class="pref-section wide">
          <legend>Local model</legend>
          <label class="pref-row">Address
            <input type="text" value={draft.aiLocalBase} onChange={(e) => set({ aiLocalBase: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="sync-buttons">{LOCAL_PRESETS.map(([n, u]) => <button key={n} class="btn" onClick={() => set({ aiLocalBase: u })}>{n}</button>)}</div>
          <p class="pref-help">The server must accept requests from Konium Designer: Ollama — start it with OLLAMA_ORIGINS=* (and OLLAMA_CONTEXT_LENGTH=32768 for long datasheets); LM Studio — Developer › Enable CORS. From konium.app a model on another computer needs an https address; the downloaded Konium Designer reaches http addresses on your network. Reading drawings needs a model that takes pictures (Qwen-VL, Gemma 3, Llama 3.2 Vision, MiniCPM-V …).</p>
        </fieldset>
      )}

      {mode !== 'off' && (
        <fieldset class="pref-section wide">
          <legend>Models</legend>
          {mode !== 'konium' && (
            <div class="sync-buttons">
              <button class="btn" disabled={busy} onClick={() => void load()}>Load Models</button>
              {models && models.length > 12 && <input type="text" placeholder="Filter" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
            </div>
          )}
          {picker('Model', mode === 'konium' ? 'Every job, from the datasheet\'s survey to the footprint, on one model: the service offers the latest Claude Opus, GPT Sol, Gemini Pro and Gemini Flash, each always its family\'s newest — on a hard datasheet Opus made a usable footprint and the others came close; others fall short. Gemini Flash is the default, for its price. A specification split into requirements runs on Qwen Flash, a cheap text model (always its family\'s newest), whichever is chosen.' : draft.aiProvider === 'openrouter' && mode === 'key' ? 'Every job, from the datasheet\'s survey to the footprint, on one model: the latest Claude Opus, GPT Sol, Gemini Pro and Gemini Flash on OpenRouter, each always its family\'s newest (Opus reads land patterns best). A specification split into requirements runs on Qwen Flash, a cheap text model (always its family\'s newest), whichever is chosen.' : 'Every job, from the datasheet\'s survey to the footprint, on one model: it must take pictures, and a frontier model reads land patterns best.')}
          <div class="sync-buttons">
            <button class="btn" disabled={busy} onClick={() => void test()}>Test</button>
            {status && <span class={status.bad ? 'ai-status bad' : 'ai-status'}>{status.text}</span>}
          </div>
          <label class="pref-row">Footprint checks
            <select aria-label="Rounds of checking a footprint" value={String(draft.aiReviewRounds)} onChange={(e) => set({ aiReviewRounds: Number((e.target as HTMLSelectElement).value) })}>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? `up to ${n} round${n > 1 ? 's' : ''}` : 'none'}</option>)}
            </select>
          </label>
          <p class="pref-help">The footprint made is drawn and shown back to the model with the datasheet's drawing (its pads over the drawing too, when measured), and it puts right what doesn't match, until it finds nothing more or the rounds run out. Each round is a job.</p>
          <p class="pref-help">Settings take effect with Apply or OK; Load Models and Test use what is on this page.</p>
        </fieldset>
      )}

      <fieldset class="pref-section wide">
        <legend>This month</legend>
        <p class="pref-help">{usage.jobs} job{usage.jobs === 1 ? '' : 's'}, {usage.in.toLocaleString(locale())} tokens sent, {usage.out.toLocaleString(locale())} received{usage.cost ? `, ${money(usage.cost)} on your key` : ''} (counted in this browser).</p>
      </fieldset>
    </>
  );
}
