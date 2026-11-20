/**
 * What a bug report carries besides the person's words, when they leave "Include diagnostics"
 * ticked: the version and how Konium runs, the browser, the open documents' names and kinds,
 * the last errors it showed, the last files it saved (name, size, how) and the last lines of the
 * Messages panel. Nothing from the files.
 */
import { APP_VERSION, fromFile, installed, served } from '../platform/distribution';

const errors: { at: string; text: string }[] = [];
/** An error Konium showed (the status line, a failed command, an unhandled one): the last 30 are kept. */
export function noteError(text: string): void {
  errors.push({ at: new Date().toISOString().slice(11, 19), text: text.slice(0, 500) });
  if (errors.length > 30) errors.shift();
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => noteError(`${e.message} (${(e.filename ?? '').split('/').pop()}:${e.lineno ?? ''})`));
}

const saves: { at: string; text: string }[] = [];
/** A file written (its name, size and how it went out): the last 10 are kept, so a report says whether a save went through. */
export function noteSave(name: string, bytes: number, how: string): void {
  saves.push({ at: new Date().toISOString().slice(11, 19), text: `${name.slice(0, 120)}: ${bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`}, ${how}` });
  if (saves.length > 10) saves.shift();
}

export interface DiagnosticsInput {
  docs: { name: string; kind: string; dirty: boolean }[];
  messages: { level: string; doc: string; message: string }[];
}

export function diagnosticsText(d: DiagnosticsInput): string {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const gl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
  const how = installed() ? 'installed app' : served ? `browser tab (${location.host})` : fromFile ? 'file opened from disk' : 'other';
  const lines = [
    `Konium Designer ${APP_VERSION}, ${how}`,
    `Browser: ${nav?.userAgent ?? '?'}`,
    `Language: ${nav?.language ?? '?'}; screen ${typeof screen !== 'undefined' ? `${screen.width}×${screen.height} @${devicePixelRatio}` : '?'}; WebGL 2 ${gl ? 'yes' : 'no'}`,
    `Open documents: ${d.docs.length ? d.docs.map((x) => `${x.name} (${x.kind}${x.dirty ? ', unsaved' : ''})`).join(', ') : 'none'}`,
    '',
    `Last errors (${errors.length}):`,
    ...(errors.length ? errors.map((e) => `  ${e.at} ${e.text}`) : ['  none']),
    '',
    `Last saves (${saves.length}):`,
    ...(saves.length ? saves.map((e) => `  ${e.at} ${e.text}`) : ['  none']),
    '',
    `Messages panel (last ${Math.min(30, d.messages.length)} of ${d.messages.length}):`,
    ...(d.messages.length ? d.messages.slice(-30).map((m) => `  [${m.level}] ${m.doc}: ${m.message}`) : ['  none']),
  ];
  return lines.join('\n');
}
