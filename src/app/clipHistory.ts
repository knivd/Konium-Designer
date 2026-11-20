/**
 * The Clipboard panel's list: each copy made in Konium (what, from which document, when), and —
 * with System › General › Monitor clipboard content within this application only off — text
 * other applications copied, read when Konium's window comes back to the front (once the
 * browser lets it read the clipboard). The newest first, twenty kept.
 */
import { signal } from '@preact/signals';
import { settings } from '../core/settings';
import { clipboardListeners, setClipboard, type CamClip, type PcbClip, type SchClip } from '../editors/clipboard';
import { active } from './state';

export interface ClipEntry { id: number; what: string; from: string; at: number; clip?: SchClip | PcbClip | CamClip; text?: string }
export const clipHistory = signal<ClipEntry[]>([]);
let seq = 0;
const MAX = 20;
const push = (e: Omit<ClipEntry, 'id' | 'at'>) => { clipHistory.value = [{ ...e, id: ++seq, at: Date.now() }, ...clipHistory.value].slice(0, MAX); };

const count = (c: SchClip | PcbClip | CamClip) => c.kind === 'sch' ? c.items.filter((i) => i.owner < 0).length
  : c.kind === 'pcb' ? c.records.length + c.components.length + c.polygons.length
  : c.layers.reduce((n, l) => n + l.objects.length + l.hits.length, 0);
const kindName = { sch: 'Schematic', pcb: 'PCB', cam: 'CAM' } as const;

clipboardListeners.add((c) => {
  const n = count(c);
  push({ what: `${kindName[c.kind]}: ${n} object${n === 1 ? '' : 's'}`, from: active.value?.name ?? '', clip: c });
});

/** Make an entry the one Paste takes. */
export function useEntry(e: ClipEntry): void { if (e.clip) setClipboard(e.clip, true); }
export function clearHistory(): void { clipHistory.value = []; }

let lastText = '';
/** Konium's window back in front: what another application copied, when monitoring them is on and the browser allows reading it. */
export async function noticeOutsideCopy(): Promise<void> {
  if (settings.clipboardAppOnly || typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
  try {
    const st = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    if (st && st.state !== 'granted') return;
    const t = (await navigator.clipboard.readText()).trim();
    if (!t || t === lastText) return;
    lastText = t;
    push({ what: `Text: ${t.length > 40 ? `${t.slice(0, 40)}…` : t}`, from: 'Another application', text: t });
  } catch { /* not allowed: nothing to list */ }
}
if (typeof window !== 'undefined') window.addEventListener('focus', () => { void noticeOutsideCopy(); });
