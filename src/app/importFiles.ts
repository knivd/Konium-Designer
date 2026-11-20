/**
 * Importing other tools' files: what File › Import Wizard and File › Open (or a drop) of such
 * files do. The files are converted (formats/importers), written into the output folder when one
 * was chosen, and opened: each project with its documents (unsaved when there is no folder), the
 * libraries as free documents; the importer's report goes to Messages.
 */
import type { Importer, ImportResult } from '../formats/importers';
import { settings } from '../core/settings';
import { writeInto, type PickedFile } from '../platform/fs';
import { openBatch } from './actions';
import { log, markProjectDirty, notify, projects } from './state';

export interface ImportRun { only?: Set<string>; outDir?: FileSystemDirectoryHandle | null; progress?: (s: string) => void }

export async function importAndOpen(importer: Importer, files: PickedFile[], run: ImportRun = {}): Promise<ImportResult> {
  const r = await importer.run(files.map((f) => ({ path: f.path ?? f.name, bytes: f.bytes })), { only: run.only, progress: run.progress, orcadFootprintField: settings.orcadFootprintField });
  for (const m of r.messages) log(m.source, [{ level: m.level, message: m.message }], 'Import Wizard');
  for (const p of r.projects) {
    const docs = [p.prj, ...p.documents];
    if (run.outDir) {
      // Into its own folder under the output folder, then opened from there (as any project is)
      run.progress?.(`${p.name}: saving`);
      const dir = await run.outDir.getDirectoryHandle(p.name, { create: true });
      const picked: PickedFile[] = [];
      for (const d of docs) picked.push({ name: d.name, bytes: d.bytes, handle: await writeInto(dir, d.name, d.bytes), path: d.name });
      openBatch(picked, dir.name, dir);
    } else {
      openBatch(docs.map((d) => ({ name: d.name, bytes: d.bytes })));
      const opened = [...projects.value].reverse().find((x) => x.name === p.prj.name && !x.handle);
      if (opened) markProjectDirty(opened);
    }
  }
  if (r.libraries.length) {
    if (run.outDir) {
      const picked: PickedFile[] = [];
      for (const d of r.libraries) picked.push({ name: d.name, bytes: d.bytes, handle: await writeInto(run.outDir, d.name, d.bytes), path: d.name });
      openBatch(picked);
    } else openBatch(r.libraries.map((d) => ({ name: d.name, bytes: d.bytes })));
  }
  const made = r.projects.length + r.libraries.length;
  const errors = r.messages.filter((m) => m.level === 'error').length;
  const dgm = r.libraries.filter((d) => /\.dgmdoc$/i.test(d.name)).length, libs = r.libraries.length - dgm;
  notify(made ? `Imported ${[r.projects.length && `${r.projects.length} project${r.projects.length > 1 ? 's' : ''}`, libs && `${libs} librar${libs > 1 ? 'ies' : 'y'}`, dgm && `${dgm} diagram${dgm > 1 ? 's' : ''}`].filter(Boolean).join(' and ')}${errors ? ` (${errors} error${errors > 1 ? 's' : ''}: see Messages)` : ''}`
    : 'Nothing was imported: see Messages', made && !errors ? 'ok' : 'error');
  return r;
}
