/**
 * The Scripts panel (R8): the project's scripts, yours and the examples; the script's text, Run on
 * the board or footprint in front, what it printed and the files it made, and Write with AI. Your
 * scripts and the project's save as you type; changing an example makes it yours first. Help (F1)
 * opens the Scripting Reference.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { active, notify, openHelp, prefsPage, showPrefs, tick } from '../state';
import { settings } from '../../core/settings';
import { SCRIPT } from '../../ai/jobs';
import { AiError, NOT_YET, allowanceNote, destination, estimateCost, estimateTokens, listModels, modelFor, money, runJob, serviceConfig, serviceRuns, type ModelInfo, type ServiceConfig } from '../../ai/client';
import { EXAMPLES, NEW_SCRIPT, type ScriptDef } from '../../scripting/examples';
import { deleteScript, freeName, fromFile, saveScript, scriptFile, userScripts } from '../../scripting/store';
import { currentScript, runScript, scriptContext, scriptFiles, scriptLog, scriptRunning, scriptTarget } from '../scripts';
import { SCRIPTS_FOLDER, deleteProjectScript, editProjectScript, freeProjectName, loadProjectScripts, projectScripts, saveProjectScript, scriptProject } from '../projectScripts';
import { vcsInfo } from '../vcs';
import { showDialog } from '../dialogs';
import { ConfirmDialog } from '../dialogs/Confirm';
import { pickFile, saveFileAs } from '../../platform/fs';

const showAi = signal(false);
const utf8 = (s: string) => new TextEncoder().encode(s);

export function ScriptsPanel() {
  void tick.value; void active.value; void userScripts.value; void projectScripts.value;
  const project = scriptProject();
  const ofProject = project ? projectScripts.value[project.id] ?? [] : [];
  const all: ScriptDef[] = [...ofProject, ...userScripts.value, ...EXAMPLES];
  const s = all.find((x) => x.id === currentScript.value) ?? all[0]!;
  const mine = !s.builtIn;
  const [code, setCode] = useState(s.code);
  const [name, setName] = useState(s.name);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setCode(s.code); setName(s.name); }, [s.id]);
  // The project's Scripts folder read when its project comes to the front, and after the others' changes arrive
  const head = project ? vcsInfo.value[project.id]?.head : null;
  useEffect(() => { if (project?.dir) void loadProjectScripts(project).catch(() => undefined); }, [project?.id, project?.dir, head]);
  const target = scriptTarget();
  const running = !!scriptRunning.value;

  /** Saved as it is edited: a project's to its file, yours in the browser; an example becomes your own copy first. */
  const edit = (next: { code?: string; name?: string }) => {
    const c = next.code ?? code, n = next.name ?? name;
    setCode(c); setName(n);
    if (s.projectId && project) editProjectScript(project, s, n, c);
    else if (mine) saveScript({ id: s.id, name: n, code: c });
    else currentScript.value = saveScript({ name: freeName(n), code: c });
  };
  const run = () => { if (!running && target) void runScript(code, name); };
  const goToLine = (line: number) => {
    const t = area.current;
    if (!t) return;
    const lines = t.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    t.focus();
    t.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    const lh = parseFloat(getComputedStyle(t).lineHeight) || 16;
    t.scrollTop = Math.max(0, (line - 3) * lh);
  };
  const keyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    const t = e.currentTarget as HTMLTextAreaElement;
    if (e.key === 'F1') { e.preventDefault(); openHelp('scripting'); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); return; }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const a = t.selectionStart, b = t.selectionEnd;
      const next = t.value.slice(0, a) + '  ' + t.value.slice(b);
      edit({ code: next });
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
    }
  };
  const importJs = async () => {
    const f = await pickFile('.js,.mjs,.txt');
    if (!f) return;
    const r = fromFile(f.name, new TextDecoder().decode(f.bytes));
    currentScript.value = saveScript({ name: freeName(r.name), code: r.code });
    notify(`${f.name} added to your scripts`);
  };
  const exportJs = async () => {
    const f = scriptFile({ ...s, name, code });
    await saveFileAs(f.name, utf8(f.text));
  };
  const toProject = async () => {
    if (!project) return;
    try {
      const def = await saveProjectScript(project, { name: freeProjectName(project, name), code });
      currentScript.value = def.id;
      notify(`${def.file} added to ${project.name}’s ${SCRIPTS_FOLDER} folder`);
    } catch (e) { notify((e as Error).message, 'error'); }
  };
  const remove = () => {
    if (!mine) return;
    const after = () => { currentScript.value = all.find((x) => x.id !== s.id)?.id ?? EXAMPLES[0]!.id; };
    if (s.projectId && project) {
      showDialog(ConfirmDialog, {
        title: 'Delete Script', message: `Delete ${s.file} from ${project.name}’s ${SCRIPTS_FOLDER} folder?`, detail: 'The file goes from the folder (version control keeps its history).', yes: 'Delete', no: 'Cancel',
        onYes: () => { void deleteProjectScript(project, s).then(() => { after(); notify(`${s.file} deleted`); }, (e) => notify((e as Error).message, 'error')); },
      });
      return;
    }
    // One's own script, kept in this browser only: there is no way back, so it is asked first
    showDialog(ConfirmDialog, {
      title: 'Delete Script', message: `Delete the script “${s.name}”?`, detail: 'It is kept in this browser only: once deleted it cannot be brought back. Export keeps a copy as a file first.', yes: 'Delete', no: 'Cancel',
      onYes: () => { deleteScript(s.id); after(); notify(`${s.name} deleted`); },
    });
  };

  return (
    <section class="panel docked scripts" aria-label="Scripts">
      <div class="scr-bar">
        <select aria-label="Script" value={s.id} onChange={(e) => { currentScript.value = (e.currentTarget as HTMLSelectElement).value; }}>
          {ofProject.length > 0 && <optgroup label={`${project!.name} (project)`}>{ofProject.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
          {userScripts.value.length > 0 && <optgroup label="Your scripts">{userScripts.value.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
          <optgroup label="Examples">{EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
        </select>
        <button class="link small" title="A new script of your own" onClick={() => { currentScript.value = saveScript({ name: freeName('Script'), code: NEW_SCRIPT }); }}>New</button>
        {project?.dir && !s.projectId && <button class="link small" title={`Copy this script into ${project.name}’s ${SCRIPTS_FOLDER} folder, to go with the project`} onClick={() => void toProject()}>Add to Project</button>}
        <button class="link small" title="Add a .js file to your scripts" onClick={() => void importJs()}>Import</button>
        <button class="link small" title="Save this script as a .js file" onClick={() => void exportJs()}>Export</button>
        {mine && <button class="link small" title={s.projectId ? 'Delete this script from the project' : 'Delete this script of yours'} onClick={remove}>Delete</button>}
        <span class="spacer" />
        <button class="link small" title="The Scripting Reference (F1)" onClick={() => openHelp('scripting')}>Help</button>
      </div>
      {mine
        ? <input class="scr-name" aria-label="Name" value={name} onInput={(e) => edit({ name: (e.currentTarget as HTMLInputElement).value })} />
        : <p class="small muted scr-note">An example: change it and it becomes yours.</p>}
      {s.projectId && <p class="small muted scr-note">{project?.name}’s {SCRIPTS_FOLDER}/{s.file}: saved to the file as you type.</p>}
      <textarea ref={area} class="scr-code" aria-label="Script" spellcheck={false} autocomplete="off" wrap="off" value={code}
        onInput={(e) => edit({ code: (e.currentTarget as HTMLTextAreaElement).value })} onKeyDown={keyDown} />
      <div class="scr-run">
        <button class="btn default" disabled={!target || running} title={target ? 'Ctrl+Enter' : 'Open a board or a PCB library to run a script on'} onClick={run}>
          {target ? `Run on ${target.kind === 'footprint' ? target.title : 'the board'}` : 'Run'}
        </button>
        {running && <button class="btn" onClick={() => scriptRunning.value?.abort()}>Stop</button>}
        <span class="spacer" />
        <button class={`link small${showAi.value ? ' on' : ''}`} aria-pressed={showAi.value} onClick={() => { showAi.value = !showAi.value; }}>Write with AI</button>
      </div>
      {showAi.value && <AiWriter code={code} mine={mine} onCode={(c, n, asNew) => {
        if (asNew) currentScript.value = saveScript({ name: freeName(n), code: c });
        else edit({ code: c });
      }} />}
      <div class="scr-log" role="log" aria-label="Script output">
        {scriptLog.value.map((l, i) => (
          <div key={i} class={`scr-line ${l.kind}`}>
            {l.line ? <button class="link" title="Show the line" onClick={() => goToLine(l.line!)}>{l.text}</button> : l.text}
          </div>
        ))}
        {scriptFiles.value.map((f, i) => (
          <div key={`f${i}`} class="scr-line file">
            <span>{f.name} ({utf8(f.text).length.toLocaleString()} bytes)</span>
            <button class="link small" onClick={() => void saveFileAs(f.name, utf8(f.text))}>Save...</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Write with AI: what the script is to do, a new script or the one shown changed. */
function AiWriter({ code, mine, onCode }: { code: string; mine: boolean; onCode: (code: string, name: string, asNew: boolean) => void }) {
  const mode = settings.aiMode;
  const [ask, setAsk] = useState('');
  const [change, setChange] = useState(mine && code.trim() !== NEW_SCRIPT.trim());
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState('');
  const [info, setInfo] = useState<{ model?: ModelInfo; runs: boolean; allowance?: ServiceConfig['allowance'] }>({ runs: true });
  useEffect(() => {
    if (mode === 'off') return;
    let live = true;
    if (mode === 'konium') void serviceConfig().then((c) => { if (live) setInfo({ runs: serviceRuns(c, 'script'), allowance: c.allowance, model: c.models.find((m) => m.id === (modelFor(mode) || c.defaults.model)) }); }).catch(() => undefined);
    else void listModels(mode).then((ms) => { if (live) setInfo({ runs: true, model: ms.find((m) => m.id === modelFor(mode)) }); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (mode === 'off') {
    return (
      <div class="scr-ai">
        <p class="small">AI is off: choose how Konium Designer reaches a model in Preferences › System › AI.</p>
        <button class="btn" onClick={() => { prefsPage.value = 'sys-ai'; showPrefs.value = true; }}>Open Preferences...</button>
      </div>
    );
  }
  const input = () => ({ request: ask.trim(), code: change ? code : undefined, ...scriptContext() });
  // The board's names add a few hundred tokens at most: not worked out on every key pressed
  const cost = !ask.trim() ? '' : mode === 'local' ? 'Free: it runs on your model.' : mode === 'konium' ? `${allowanceNote(info.allowance, info.model)}.`
    : `Estimated cost: ${money(estimateCost(estimateTokens(SCRIPT.messages({ request: ask.trim(), code: change ? code : undefined, kind: 'board' })) + 800, 3000, info.model))}.`;
  const write = async () => {
    setBusy(true); setState('Writing the script…');
    try {
      const r = await runJob(SCRIPT, input());
      onCode(r.value.code, r.value.name, !change);
      setState(`${change ? 'Changed' : `"${r.value.name}"`} by ${r.model}${r.value.explanation ? `: ${r.value.explanation}` : ''} Read it through before you run it.`);
    } catch (e) { setState(e instanceof AiError || e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <div class="scr-ai">
      <textarea class="scr-ask" aria-label="What the script is to do" placeholder="What is the script to do? (e.g. put a via on every unrouted GND pad)" value={ask}
        onInput={(e) => setAsk((e.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ask.trim() && !busy) void write(); }} />
      <label class="small"><input type="checkbox" checked={change} onChange={(e) => setChange((e.currentTarget as HTMLInputElement).checked)} /> Change the script shown (else a new one)</label>
      <p class="small muted">Sends what you ask, {change ? 'the script shown, ' : ''}and the names of the {scriptTarget()?.kind ?? 'board'}'s layers and nets, its designator prefixes, how many objects of each kind it has and what is selected (not the design itself) to {destination()}. {cost}</p>
      {!info.runs && <p class="small ai-error">{NOT_YET}.</p>}
      <div class="scr-run"><button class="btn" disabled={busy || !ask.trim() || !info.runs} onClick={() => void write()}>{busy ? 'Writing…' : 'Write'}</button></div>
      {state && <p class="small" role="status">{state}</p>}
    </div>
  );
}
