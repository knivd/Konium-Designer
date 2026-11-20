/**
 * Design Workspaces (.DsnWrk) and Create Projects from Path. A workspace lists its projects by
 * path relative to the workspace file, as AD17 writes it:
 *   [ProjectGroup]  Version=1.0
 *   [Project1]      ProjectPath=..\Libraries\Passives.LibPkg
 *   [Project2]      ProjectPath=Board\Board.PrjPcb
 */

/** The projects of a workspace file, in its order (paths as written, backslashes kept). */
export function readDsnWrk(text: string): string[] {
  const out: { n: number; path: string }[] = [];
  let n = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[Project(\d+)\]$/i.exec(line);
    if (sec) { n = Number(sec[1]); continue; }
    if (/^\[/.test(line)) { n = -1; continue; }
    const kv = /^ProjectPath=(.*)$/i.exec(line);
    if (kv && n >= 0 && kv[1]!.trim()) out.push({ n, path: kv[1]!.trim() });
  }
  return out.sort((a, b) => a.n - b.n).map((x) => x.path);
}

export function writeDsnWrk(paths: string[]): string {
  const lines = ['[ProjectGroup]', 'Version=1.0'];
  paths.forEach((p, i) => lines.push(`[Project${i + 1}]`, `ProjectPath=${p.replace(/\//g, '\\')}`));
  return `${lines.join('\r\n')}\r\n`;
}

/** A relative path (either slash, `..` allowed) from a folder ('/'-separated, '' for the root); null when it climbs above the root. */
export function resolvePath(folder: string, rel: string): string | null {
  const segs = folder ? folder.split('/').filter(Boolean) : [];
  for (const s of rel.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!segs.length) return null; segs.pop(); } else segs.push(s);
  }
  return segs.join('/');
}

/** The path from the folder holding a file at `from` to `to` (both '/'-separated, relative to one root), in AD's backslash form. */
export function relativeTo(from: string, to: string): string {
  const a = from.split('/').slice(0, -1), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i]!.toLowerCase() === b[i]!.toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('\\');
}

const DESIGN = /\.(schdoc|pcbdoc|schlib|pcblib|outjob|harness)$/i;
const PROJECT = /\.(prjpcb|libpkg)$/i;
const SOURCE = /\.(schdoc|pcbdoc)$/i;

export interface PathProject { folder: string; name: string; documents: string[] }

/**
 * Create Projects from Path: a project for each folder that holds design documents and no
 * project of its own, named after the folder — a PCB project, or an Integrated Library package
 * when the folder holds only libraries [est]. Documents are listed by name (beside the project).
 */
export function projectsFromPath(files: { path: string }[], rootName: string): PathProject[] {
  const byFolder = new Map<string, string[]>();
  const hasProject = new Set<string>();
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/');
    const i = path.lastIndexOf('/');
    const folder = i < 0 ? '' : path.slice(0, i), name = path.slice(i + 1);
    if (PROJECT.test(name)) { hasProject.add(folder.toLowerCase()); continue; }
    if (!DESIGN.test(name)) continue;
    const list = byFolder.get(folder) ?? [];
    list.push(name);
    byFolder.set(folder, list);
  }
  const out: PathProject[] = [];
  for (const [folder, docs] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (hasProject.has(folder.toLowerCase())) continue;
    const stem = (folder.split('/').pop() || rootName).replace(/[\\/:*?"<>|]/g, '_');
    const ext = docs.some((d) => SOURCE.test(d)) ? 'PrjPcb' : /\.(schlib|pcblib)$/i.test(docs.join('\n')) ? 'LibPkg' : 'PrjPcb';
    const order = (d: string) => ['schdoc', 'pcbdoc', 'schlib', 'pcblib', 'harness', 'outjob'].indexOf(d.split('.').pop()!.toLowerCase());
    out.push({ folder, name: `${stem}.${ext}`, documents: docs.sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { numeric: true })) });
  }
  return out;
}
