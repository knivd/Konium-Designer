import { signal } from '@preact/signals';
import type { CompiledProject, SheetInput } from '../model/compile';

/** The last compile (Project › Compile): what Messages, the Navigator and the sheets' markers show. */
export interface CompileResult { projectId: string | null; name: string; at: number; result: CompiledProject; sheets: SheetInput[] }
export const compiled = signal<CompileResult | null>(null);

/**
 * The objects of one sheet in violation after the last compile (Preferences › Compiler ›
 * Errors & Warnings draws them underlined), worst first; none once the sheet changed since.
 */
export function sheetViolations(sheet: string, editedAt: number): Map<number, 'fatal' | 'error' | 'warning'> | null {
  const res = compiled.value;
  if (!res || res.at < editedAt) return null;
  const rank = { fatal: 3, error: 2, warning: 1 } as const;
  const out = new Map<number, 'fatal' | 'error' | 'warning'>();
  for (const m of res.result.messages) {
    if (m.level === 'info') continue;
    const lv = m.fatal ? 'fatal' : m.level === 'error' ? 'error' : 'warning';
    for (const r of m.refs) {
      if (r.sheet.toLowerCase() !== sheet.toLowerCase()) continue;
      const was = out.get(r.index);
      if (!was || rank[lv] > rank[was]) out.set(r.index, lv);
    }
  }
  return out.size ? out : null;
}

