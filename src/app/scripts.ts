/**
 * Running a script on the board or footprint in front (R8): a snapshot of it to the sandbox, the
 * changes it asked for made as one step Undo takes back, what it printed and the files it made
 * for the Scripts panel. Writing a script with AI (the 'script' job).
 */
import { signal } from '@preact/signals';
import { active, notify } from './state';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { applyScript, scriptLayers, snapshot } from '../scripting/board';
import { runInSandbox } from '../scripting/sandbox';
import type { ScriptFile } from '../scripting/runtime';
import { L, isCopper } from '../model/layers';
import { NO_NET } from '../model/pcb';
import { userScripts } from '../scripting/store';
import { EXAMPLES } from '../scripting/examples';

export interface LogLine { kind: 'out' | 'error' | 'info'; text: string; line?: number }

/** The script the Scripts panel shows (kept while the panel moves or closes). */
export const currentScript = signal<string>(userScripts.value[0]?.id ?? EXAMPLES[0]!.id);
export function showScript(id: string): void { currentScript.value = id; }

export const scriptLog = signal<LogLine[]>([]);
export const scriptFiles = signal<ScriptFile[]>([]);
export const scriptRunning = signal<AbortController | null>(null);

/** The board or footprint editor a script would run on, and what it is. */
export function scriptTarget(): { ed: PcbEditor; kind: 'board' | 'footprint'; title: string } | null {
  const ed = active.value?.editor;
  if (!(ed instanceof PcbEditor)) return null;
  if (ed instanceof PcbLibEditor) return { ed, kind: 'footprint', title: ed.entry.name };
  return { ed, kind: 'board', title: ed.title() };
}

/** Run `code` on the board or footprint in front. */
export async function runScript(code: string, name: string): Promise<void> {
  const t = scriptTarget();
  if (!t) { scriptLog.value = [{ kind: 'error', text: 'Open a board or a PCB library to run a script on' }]; return; }
  const { ed, kind } = t;
  const doc = ed.doc, rev = ed.undo.revision;
  const stop = new AbortController();
  scriptRunning.value = stop;
  scriptFiles.value = [];
  scriptLog.value = [{ kind: 'info', text: `${name}: running on ${t.title}…` }];
  const started = performance.now();
  try {
    const r = await runInSandbox(code, snapshot(doc, kind, ed.selection), { signal: stop.signal });
    const out: LogLine[] = r.log.map((text) => ({ kind: 'out', text }));
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (r.type === 'error') {
      out.push({ kind: 'error', text: `${r.line ? `Line ${r.line}: ` : ''}${r.message}. Nothing was changed.`, line: r.line ?? undefined });
      scriptLog.value = out;
      return;
    }
    const { files, ops } = r;
    let summary = 'nothing changed';
    if (ops.length) {
      if (ed.doc !== doc || ed.undo.revision !== rev) {
        out.push({ kind: 'error', text: `The ${kind} changed while the script ran: nothing was changed. Run it again.` });
        scriptLog.value = out;
        return;
      }
      const why = ed.undo.guard?.();
      if (why) {
        out.push({ kind: 'error', text: `${why}: nothing was changed.` });
        scriptLog.value = out;
        return;
      }
      let res: ReturnType<typeof applyScript> | null = null;
      try {
        ed.undo.transact('Run script', (tx) => { res = applyScript(doc, ops, tx); });
      } catch (e) {
        out.push({ kind: 'error', text: `${(e as Error).message}. Nothing was changed.` });
        scriptLog.value = out;
        return;
      }
      const done = res as ReturnType<typeof applyScript> | null;
      if (!done) {
        out.push({ kind: 'error', text: `The ${kind} can’t be changed just now: nothing was changed.` });
        scriptLog.value = out;
        return;
      }
      summary = done.summary;
      if (done.select) ed.selection = new Set(done.select);
      ed.invalidate(); ed.invalidateOverlay();
    }
    scriptFiles.value = files;
    out.push({ kind: 'info', text: `Done in ${secs} s: ${summary}${files.length ? `; ${files.length} file${files.length === 1 ? '' : 's'} to save` : ''}${ops.length && summary !== 'nothing changed' ? ' (Undo takes it all back)' : ''}.` });
    scriptLog.value = out;
    if (ops.length && summary !== 'nothing changed') notify(`${name}: ${summary}`);
  } finally {
    if (scriptRunning.value === stop) scriptRunning.value = null;
  }
}

/** A little about the board for the AI writing a script: names it may use, never the design itself. */
export function scriptContext(): { kind: 'board' | 'footprint'; context: string } {
  const t = scriptTarget();
  if (!t) return { kind: 'board', context: '' };
  const { ed, kind } = t, doc = ed.doc;
  const lines: string[] = [];
  const layers = scriptLayers(doc);
  lines.push(`Copper layers: ${layers.filter((l) => isCopper(l.id)).map((l) => l.name).join(', ')}`);
  const used = new Set(doc.prims.map((p) => ('layer' in p ? p.layer : L.MULTI)));
  lines.push(`Other layers in use: ${layers.filter((l) => !isCopper(l.id) && used.has(l.id)).map((l) => l.name).join(', ') || 'none'}`);
  if (kind === 'board') {
    const prefixes = new Map<string, number>();
    for (const c of doc.components) { const m = /^[A-Za-z_]+/.exec(c.designator); if (m) prefixes.set(m[0], (prefixes.get(m[0]) ?? 0) + 1); }
    lines.push(`${doc.components.length} parts; designator prefixes: ${[...prefixes].map(([p, n]) => `${p} (${n})`).join(', ') || 'none'}`);
    const nets = doc.nets.map((n) => n.name);
    lines.push(`${nets.length} nets${nets.length ? `: ${nets.slice(0, 80).join(', ')}${nets.length > 80 ? ' …' : ''}` : ''}`);
  }
  const count = (k: string) => doc.prims.filter((p) => p.kind === k && !('polygon' in p && p.polygon !== NO_NET)).length;
  lines.push(`Pads ${count('pad')}, tracks ${count('track')}, arcs ${count('arc')}, vias ${count('via')}, texts ${count('text')}, regions ${count('region')}, fills ${count('fill')}`);
  const snap = snapshot(doc, kind, ed.selection);
  const sel = new Map<string, number>();
  for (const id of snap.selection) { const k = id.startsWith('c') && /^c\d+$/.test(id) ? 'part' : id.split(':')[0]!.replace(/6$/, '').toLowerCase(); sel.set(k, (sel.get(k) ?? 0) + 1); }
  lines.push(`Selected: ${[...sel].map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`);
  return { kind, context: lines.join('\n') };
}
