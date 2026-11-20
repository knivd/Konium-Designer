/** Write the built-in demo projects to disk: npx vite-node tests/tools/write-samples.ts [dir] (the simulation demo in its own folder) */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoFiles } from '../../src/formats/synthetic/demo';
import { simDemoFiles } from '../../src/formats/synthetic/simDemo';

const dir = process.argv[2] ?? 'samples';
for (const [sub, files] of [['', demoFiles()], ['Sim Demo', simDemoFiles()]] as const) {
  const at = join(dir, sub);
  mkdirSync(at, { recursive: true });
  for (const f of files) { writeFileSync(join(at, f.name), f.bytes); console.log(join(at, f.name), f.bytes.length); }
}
