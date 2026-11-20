/**
 * The current variant of each open project (Projects panel / Variant Management): parts not
 * fitted in it are crossed out on its sheets. Kept for the session.
 */
import { effect, signal } from '@preact/signals';
import { SchEditor } from '../editors/sch/SchEditor';
import { isFitted, readVariants } from '../model/variants';
import { docs, projects, tick } from './state';

const current = signal<Record<string, string>>({});
export const currentVariant = (projectId: string): string => current.value[projectId] ?? '';

export function setCurrentVariant(projectId: string, name: string): void {
  current.value = { ...current.value, [projectId]: name };
  applyVariantView();
}

/** Point each open sheet of a project at its current variant. */
export function applyVariantView(): void {
  for (const d of docs.value) {
    const e = d.editor;
    if (!(e instanceof SchEditor) || e.libraryMode) continue;
    const p = projects.value.find((x) => x.id === d.projectId);
    const name = p ? currentVariant(p.id) : '';
    const v = name && p ? readVariants(p.prj).find((x) => x.name === name) : undefined;
    const had = !!e.notFitted;
    e.notFitted = v ? () => {
      const out = new Set<number>();
      for (const o of e.doc.objects) if (o.kind === 'component' && !isFitted(v, o.designator, e.doc.records[o.index + 1]?.bag?.get('UNIQUEID') ?? '')) out.add(o.index);
      return out;
    } : null;
    if (had || v) e.invalidate();
  }
  tick.value++;
}

// Sheets opened later show their project's current variant too
let seen = 0;
effect(() => {
  const n = docs.value.length;
  if (n !== seen) { seen = n; queueMicrotask(applyVariantView); }
});
