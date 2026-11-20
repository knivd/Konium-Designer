/** Print a menu tree: npx vite-node tests/tools/menutree.ts [sch|pcb|…|ctx:<context menu>] */
import { MENUBAR, CONTEXT } from '../../src/app/menus/ad17.gen';
type M = unknown;
function walk(list: M[], d: number, out: string[]): void {
  for (const m of list) {
    if (m === 0) { out.push(' '.repeat(d * 2) + '---'); continue; }
    const a = m as [string, M, string?];
    if (Array.isArray(a[1])) { out.push(' '.repeat(d * 2) + a[0]); walk(a[1] as M[], d + 1, out); }
    else out.push(' '.repeat(d * 2) + `${a[0]}  [${a[1] ?? ''}]`);
  }
}
const which = process.argv[2] ?? 'sch';
const out: string[] = [];
if (which.startsWith('ctx:')) { const s = (CONTEXT as Record<string, M>)[which.slice(4)] as [string, M[]]; walk(s[1], 0, out); }
else walk((MENUBAR as Record<string, M[]>)[which]!, 0, out);
console.log(out.join('\n'));
