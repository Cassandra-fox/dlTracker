import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
const references = [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.action.default_popup, manifest.options_page, manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css ?? [])]),
];
const root = path.resolve('dist');
for (const reference of references) {
  assert.ok(typeof reference === 'string' && !reference.endsWith('.ts'));
  const target = path.resolve(root, reference);
  assert.ok(target.startsWith(root + path.sep), 'Manifest reference must stay inside dist');
  await access(target);
}
console.log(`Verified MV3 manifest and ${references.length} resource references.`);
