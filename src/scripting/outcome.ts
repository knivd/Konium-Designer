/**
 * What a script's frame sends back, rebuilt from checked values before the program uses any of it.
 *
 * The frame and its worker run the script, and a script can post a message of its own making, so
 * a message is the script's word and nothing more. None of it is used as it came: every text is
 * made a string, every number a finite number, every list has an end, and a change that is not
 * one of the changes a script can ask for (runtime.ts, ScriptOp) fails the run. In particular an
 * object can never stand where a text is shown: the page would take a well-made one for an
 * element of its own.
 */
import type { ScriptFile, ScriptOp } from './runtime';

export const MAX_LOG_LINES = 5001, MAX_LINE = 20_000, MAX_OPS = 200_000, MAX_FILES = 20, MAX_FILE_CHARS = 64 << 20, MAX_POINTS = 100_000;

export type Checked =
  | { type: 'ready' }
  | { type: 'done'; ops: ScriptOp[]; files: ScriptFile[]; log: string[] }
  | { type: 'error'; message: string; line?: number; stack?: string; log: string[] };

class NotAChange extends Error {}
const bad = (what: string): never => { throw new NotAChange(what); };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cut = (s: string, most: number) => (s.length > most ? `${s.slice(0, most)}…` : s);
/** A line of the log: a text, a number or a truth as text; anything else is not a line. */
const line = (v: unknown): string | null => (typeof v === 'string' ? cut(v, MAX_LINE) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
export function checkedLog(v: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) for (const x of v) { if (out.length >= MAX_LOG_LINES) break; const s = line(x); if (s !== null) out.push(s); }
  return out;
}

const ID = /^(?:c\d{1,7}|new\d{1,7}|[A-Za-z][A-Za-z0-9]{0,30}:\d{1,9})$/;
const id = (v: unknown): string => (typeof v === 'string' && ID.test(v) ? v : bad('an object\'s id'));
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad(what));
/** A name or a text: a string within its length, with no control characters but a text's own line breaks and tabs. */
const str = (v: unknown, what: string, most: number, lines = false): string => {
  if (typeof v !== 'string' || v.length > most) return bad(what);
  // eslint-disable-next-line no-control-regex
  if ((lines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/).test(v)) return bad(what);
  return v;
};
const net = (v: unknown): string | null => (v === null || v === undefined ? null : str(v, 'a net\'s name', 255));
const SHAPES = ['round', 'rect', 'roundrect', 'octagon'];

function fieldsOf(kind: string, f: Record<string, unknown>): Record<string, unknown> {
  const n = (k: string) => num(f[k], k), layer = () => str(f.layer, 'a layer\'s name', 100);
  switch (kind) {
    case 'track': return { x1: n('x1'), y1: n('y1'), x2: n('x2'), y2: n('y2'), width: n('width'), layer: layer(), net: net(f.net) };
    case 'arc': return { x: n('x'), y: n('y'), radius: n('radius'), start: n('start'), end: n('end'), width: n('width'), layer: layer(), net: net(f.net) };
    case 'via': return { x: n('x'), y: n('y'), diameter: n('diameter'), hole: n('hole'), net: net(f.net) };
    case 'text': return { x: n('x'), y: n('y'), text: str(f.text, 'a text', 32_000, true), height: n('height'), layer: layer(), rotation: n('rotation') };
    case 'pad': return {
      x: n('x'), y: n('y'), name: str(f.name, 'a pad\'s name', 255), width: n('width'), height: n('height'),
      shape: typeof f.shape === 'string' && SHAPES.includes(f.shape) ? f.shape : bad('a pad\'s shape'), hole: n('hole'), layer: layer(), rotation: n('rotation'), net: net(f.net),
    };
    case 'region': {
      if (!Array.isArray(f.points) || f.points.length < 3 || f.points.length > MAX_POINTS) return bad('a region\'s points');
      return { points: f.points.map((q) => (isObj(q) ? { x: num(q.x, 'x'), y: num(q.y, 'y') } : bad('a point'))), layer: layer(), net: net(f.net) };
    }
    default: return bad('a kind of object');
  }
}

function opOf(v: unknown): ScriptOp {
  if (!isObj(v)) return bad('a change');
  switch (v.op) {
    case 'compMove': return { op: 'compMove', id: id(v.id), x: num(v.x, 'x'), y: num(v.y, 'y') };
    case 'compRotate': return { op: 'compRotate', id: id(v.id), rotation: num(v.rotation, 'rotation') };
    case 'designator': { const s = str(v.value, 'a designator', 255); return s.trim() ? { op: 'designator', id: id(v.id), value: s.trim() } : bad('a designator'); }
    case 'remove': return { op: 'remove', id: id(v.id) };
    case 'net': return { op: 'net', id: id(v.id), net: net(v.net) };
    case 'move': return { op: 'move', id: id(v.id), dx: num(v.dx, 'dx'), dy: num(v.dy, 'dy') };
    case 'width': return { op: 'width', id: id(v.id), width: num(v.width, 'width') };
    case 'add': {
      const kind = v.kind as 'track' | 'arc' | 'via' | 'text' | 'region' | 'pad';
      return { op: 'add', id: id(v.id), kind, fields: fieldsOf(typeof v.kind === 'string' ? v.kind : '', isObj(v.fields) ? v.fields : bad('an object\'s fields')) };
    }
    case 'select': return { op: 'select', ids: Array.isArray(v.ids) && v.ids.length <= MAX_OPS ? v.ids.map(id) : bad('a selection') };
    default: return bad('a change');
  }
}

/** A message from the frame, checked; null for anything that is not one of its three. */
export function checkedMessage(data: unknown): Checked | null {
  if (!isObj(data)) return null;
  if (data.type === 'ready') return { type: 'ready' };
  if (data.type === 'error') {
    return {
      type: 'error', message: cut(typeof data.message === 'string' && data.message ? data.message : 'The script failed', 2000),
      line: typeof data.line === 'number' && Number.isFinite(data.line) ? data.line : undefined,
      stack: typeof data.stack === 'string' ? data.stack.slice(0, 20_000) : undefined, log: checkedLog(data.log),
    };
  }
  if (data.type !== 'done') return null;
  const log = checkedLog(data.log);
  try {
    if (data.ops !== undefined && (!Array.isArray(data.ops) || data.ops.length > MAX_OPS)) bad('a list of changes');
    const ops = ((data.ops as unknown[] | undefined) ?? []).map(opOf);
    const files: ScriptFile[] = [];
    let chars = 0;
    for (const f of Array.isArray(data.files) ? data.files.slice(0, MAX_FILES) : []) {
      if (!isObj(f) || typeof f.name !== 'string' || typeof f.text !== 'string') continue;
      // A file's name is a name: no folders, no control characters
      // eslint-disable-next-line no-control-regex
      const name = f.name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 200);
      chars += f.text.length;
      if (!name || chars > MAX_FILE_CHARS) continue;
      files.push({ name, text: f.text });
    }
    return { type: 'done', ops, files, log };
  } catch (e) {
    if (!(e instanceof NotAChange)) throw e;
    return { type: 'error', message: `The script sent back something that is not ${e.message}`, log };
  }
}
