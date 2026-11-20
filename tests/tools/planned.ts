/** Commands still on the roadmap for a scope: npx vite-node tests/tools/planned.ts [sch|pcb|schlib|pcblib] */
import { commands } from '../../src/core/commands';
import '../../src/app/commands';
const want = process.argv[2] ?? 'sch';
const list = commands.all().filter((c) => c.planned && c.scopes?.includes(want as never));
console.log(list.length);
for (const c of list) console.log(c.id, '|', c.label);
