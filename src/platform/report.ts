/**
 * Help › Report a Bug: the report goes to Konium's report service on konium.app, which mails it
 * on (the address it goes to is kept there, not in Konium). Nothing is sent unless the person
 * presses Send; without a connection the report waits in this browser and goes when it can.
 */
import { SITE, online } from './distribution';
import { OFFLINE_NOTE, mayConnect } from './network';
import { adoptFormerDb } from './formerDb';
import { zipDeflated } from '../formats/zip';

export const REPORT_URL = `${SITE}api/report`;
/** Attachments that go as they are, together; above this they are zipped and go in parts. */
export const MAX_PLAIN = 8 * 1024 * 1024;
/** The most the zip may come to, and one part of it (as the report service has them). */
export const MAX_BULK = 40 * 1024 * 1024, PART_BYTES = 6 * 1024 * 1024;
/** The most that may be attached at all, before zipping (what a browser holds in memory with ease). */
export const MAX_ATTACH = 400 * 1024 * 1024;

export interface ReportFile { name: string; type: string; bytes: Uint8Array }
/** Large attachments zipped: what the zip holds, and its bytes. */
export interface ReportBulk { bytes: Uint8Array; holds: { name: string; size: number }[] }

/** Attachments too large to go as they are: zipped (board files come to a quarter of their size or less). */
export async function packFiles(files: ReportFile[]): Promise<ReportBulk> {
  // (two files of one name: the later ones numbered)
  const taken = new Set<string>();
  const named = files.map((f) => {
    let n = f.name || 'file', k = 2;
    while (taken.has(n.toLowerCase())) { const dot = f.name.lastIndexOf('.'); n = dot > 0 ? `${f.name.slice(0, dot)}-${k}${f.name.slice(dot)}` : `${f.name}-${k}`; k++; }
    taken.add(n.toLowerCase());
    return { name: n, bytes: f.bytes };
  });
  return { bytes: await zipDeflated(named), holds: named.map((f) => ({ name: f.name, size: f.bytes.length })) };
}
export interface Report {
  name: string;
  email: string;
  text: string;
  version: string;
  diagnostics: string;
  files: ReportFile[];
  /** A message to the author (Help › Contact the Author) rather than a bug report: mailed, not filed with the reports. */
  kind?: 'contact';
  /** What a message is about. */
  topic?: string;
  /** Large attachments, zipped: they follow the report in parts. */
  bulk?: ReportBulk;
}

export function reportForm(r: Report): FormData {
  const f = new FormData();
  f.set('text', r.text);
  f.set('name', r.name);
  f.set('email', r.email);
  f.set('version', r.version);
  if (r.diagnostics) f.set('diagnostics', r.diagnostics);
  if (r.kind) f.set('kind', r.kind);
  if (r.topic) f.set('topic', r.topic);
  // The bots' trap: left empty
  f.set('website', '');
  for (const x of r.files) f.append('file', new Blob([x.bytes as Uint8Array<ArrayBuffer>], { type: x.type || 'application/octet-stream' }), x.name);
  if (r.bulk) f.set('bulk', JSON.stringify({ size: r.bulk.bytes.length, parts: partsOf(r.bulk.bytes.length), holds: r.bulk.holds }));
  return f;
}
/** How many parts a zip of this size goes in. */
export const partsOf = (size: number): number => Math.ceil(size / PART_BYTES);

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** A part as the report service passes it on to the reports repository: a commit of that part, in base64. */
export const partBody = (id: string, k: number, bytes: Uint8Array): string => JSON.stringify({ message: `Report ${id}: attachments.zip.${String(k).padStart(3, '0')}`, content: base64(bytes) });

/** `note`: the report went, with something to say about it (its large attachments didn't). */
export type SendResult = { ok: true; note?: string } | { ok: false; offline: boolean; retry: boolean; error: string };

async function post(url: string, body: BodyInit, ms: number, type?: string): Promise<{ status: number; body: { ok?: boolean; error?: string; id?: string; upload?: { day: string; parts: number; pass: string } } }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { method: 'POST', body, ...(type ? { headers: { 'Content-Type': type } } : {}), credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    let json = {};
    try { json = await res.json() as object; } catch { /* not JSON */ }
    return { status: res.status, body: json };
  } finally { clearTimeout(timer); }
}

/**
 * Post a report; `offline` when the service couldn't be reached at all, `retry` when it may take
 * it later (busy, down). Large attachments follow in parts once the report itself is in: should
 * they fail, the report has still gone, and the result says so. `progress`: what is going now.
 */
export async function sendReport(r: Report, url = REPORT_URL, progress?: (step: string) => void, pause = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))): Promise<SendResult> {
  if (!mayConnect('report')) return { ok: false, offline: true, retry: true, error: OFFLINE_NOTE };
  let first: Awaited<ReturnType<typeof post>>;
  try {
    first = await post(url, reportForm(r), 60_000);
  } catch (e) {
    return { ok: false, offline: true, retry: true, error: (e as Error).name === 'AbortError' ? 'no answer from konium.app' : 'konium.app can\'t be reached' };
  }
  if (!(first.status >= 200 && first.status < 300 && first.body.ok)) return { ok: false, offline: false, retry: first.status === 429 || first.status >= 500, error: first.body.error ?? `the report service answered ${first.status}` };
  if (!r.bulk) return { ok: true };
  const up = first.body.upload, id = first.body.id;
  if (!up || !id) return { ok: true, note: 'the report was sent, but the report service takes no large attachments at the moment: they were left out' };
  const n = partsOf(r.bulk.bytes.length);
  for (let k = 1; k <= n; k++) {
    progress?.(`Sending the attachments: part ${k} of ${n}`);
    const body = partBody(id, k, r.bulk.bytes.subarray((k - 1) * PART_BYTES, k * PART_BYTES));
    let done = false, why = '';
    // (another report's commit can come between, or the line can drop: a part is tried three times)
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      if (attempt) await pause(1500 * attempt);
      try {
        const res = await post(`${url}?part=${k}&id=${encodeURIComponent(id)}&d=${encodeURIComponent(up.day)}&t=${encodeURIComponent(up.pass)}`, body, 300_000, 'application/json');
        if (res.status >= 200 && res.status < 300 && res.body.ok) done = true;
        else { why = res.body.error ?? `the report service answered ${res.status}`; if (res.status !== 409 && res.status < 500) break; }
      } catch (e) { why = (e as Error).name === 'AbortError' ? 'no answer from konium.app' : 'konium.app couldn\'t be reached'; }
    }
    if (!done) return { ok: true, note: `the report was sent, but its attachments were not (part ${k} of ${n}: ${why})` };
  }
  return { ok: true };
}

/* ─── Waiting reports (IndexedDB): sent when the connection is back ─────────────────────── */

const DB = 'konium-reports', STORE = 'waiting';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    let fresh = false;
    r.onupgradeneeded = (e) => { fresh = e.oldVersion === 0; r.result.createObjectStore(STORE, { autoIncrement: true }); };
    // Made just now: what the app kept under its earlier name copied in first
    r.onsuccess = () => { if (fresh) void adoptFormerDb(r.result).finally(() => ok(r.result)); else ok(r.result); };
    r.onerror = () => fail(r.error);
  });
}
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db();
  try {
    return await new Promise<T>((ok, fail) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  } finally { d.close(); }
};

export async function keepReport(r: Report): Promise<void> { await tx('readwrite', (s) => s.add(r)); }
export async function waitingReports(): Promise<number> {
  try { return await tx('readonly', (s) => s.count()); } catch { return 0; }
}

let flushing = false;
/** Send what's waiting; each one sent (or refused for good) goes from the list. Returns how many went. */
export async function flushReports(send = sendReport): Promise<number> {
  if (flushing || typeof indexedDB === 'undefined' || !online.value || !mayConnect('report')) return 0;
  flushing = true;
  let sent = 0;
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    for (const k of keys) {
      const r = await tx<Report | undefined>('readonly', (s) => s.get(k));
      if (!r) continue;
      const res = await send(r);
      if (!res.ok && res.retry) break;
      await tx('readwrite', (s) => s.delete(k));
      if (res.ok) sent++;
    }
  } catch { /* storage refused: try another time */ } finally { flushing = false; }
  return sent;
}
