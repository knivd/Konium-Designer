// After the build (website/build.mjs, from npm's postbuild): the SHA-256 of Konium's single file,
// dist/app/index.html (the file a download saves), stamped on this version's What's New entry, in public/ and dist/, so
// What's New gives it beside the version. The page doesn't carry the log, so stamping it leaves
// the file (and so its checksum) as it is. A pipeline that changes the file after the build runs
// this again on its final file: node tests/tools/stamp-sha.mjs <final index.html>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'dist/app/index.html';
const [major, minor] = JSON.parse(readFileSync('package.json', 'utf8')).version.split('.');
const version = `${major}.${String(minor).padStart(3, '0')}`;
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
for (const log of ['public/whats-new.json', 'dist/whats-new.json']) {
  if (!existsSync(log)) continue;
  const d = JSON.parse(readFileSync(log, 'utf8'));
  const i = d.releases.findIndex((r) => r.version === version);
  if (i < 0) { console.log(`stamp-sha: ${log} has no entry for ${version}`); continue; }
  const { title, items } = d.releases[i];
  d.releases[i] = { version, title, sha256, items };
  writeFileSync(log, `${JSON.stringify(d, null, 1)}\n`);
}
console.log(`stamp-sha: ${version} ${sha256} (${file})`);
