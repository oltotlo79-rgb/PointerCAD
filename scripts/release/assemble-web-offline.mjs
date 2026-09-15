/** Assemble a new local candidate after Web, HTML and PDF generation. Never publish or certify it. */
import { argv } from 'node:process';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { collectOfflineAssetFiles, offlineAssetUrl } from '../vite/offlineAssets.mjs';
import { assembleOfflineDistribution } from '../vite/offlineDistribution.mjs';
import { captureWebBuildSources } from '../vite/webBuildSources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = argv.slice(2);
if (args.length !== 4 || args.some(value => !/^[a-z0-9][a-z0-9-]*$/u.test(value))) {
  throw new Error('Usage: node scripts/release/assemble-web-offline.mjs <web-output> <manual-output> <pdf-output> <new-output>; all folders are under dist/.');
}
const paths = args.map(name => join(root, 'dist', name)), hash = value => createHash('sha256').update(value).digest('hex');
if ((await lstat(join(root, 'dist'))).isSymbolicLink()) throw new Error('Output parent must not be a link');
const groups = [];
for (const folder of paths.slice(0, 3)) {
  const result = await collectOfflineAssetFiles(root, folder);
  const files = [...result.files];
  for (const name of result.excluded) files.push({ path: name, bytes: await readFile(join(folder, name)) });
  groups.push(files);
}
// Both the executable and the manual must come from the current implementation.
for (const [index, marker] of [[0, 'web-build.json'], [1, 'manifest.json']]) {
  const sourceFile = groups[index].find(file => file.path === marker);
  if (sourceFile === undefined) throw new Error('Missing source inventory: ' + marker);
  const source = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(sourceFile.bytes));
  if (typeof source?.inputs !== 'object' || source.inputs === null || Array.isArray(source.inputs)) throw new Error('Missing source records');
  if (index === 0 && JSON.stringify(await captureWebBuildSources(root)) !== JSON.stringify(source.inputs)) {
    throw new Error('Web sources were changed, added or removed after generation');
  }
  for (const [name, expected] of Object.entries(source.inputs)) {
    offlineAssetUrl(name);
    let cursor = root;
    for (const component of name.split('/')) {
      cursor = join(cursor, component);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Source must not be a link');
    }
    if (hash(await readFile(cursor)) !== expected) throw new Error('Source changed: ' + name);
  }
}
const assembled = assembleOfflineDistribution(groups[0], groups[1], groups[2]);
// Re-read the source outputs before making a destination; no stale HTML/PDF is silently accepted.
for (const [index, files] of groups.entries()) for (const file of files) {
  if (hash(await readFile(join(paths[index], file.path))) !== hash(file.bytes)) throw new Error('Output changed during assembly');
}
const destination = paths[3]; await mkdir(destination); // Refuse an existing or partially written candidate.
for (const [name, bytes] of assembled.files) {
  if (name === 'offline-assets.json') continue;
  const target = join(destination, name); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  if (hash(await readFile(target)) !== hash(bytes)) throw new Error('Written candidate differs: ' + name);
}
await writeFile(join(destination, 'offline-assets.json'), assembled.files.get('offline-assets.json'), { flag: 'wx' });
log(JSON.stringify({ destination, buildId: assembled.manifest.buildId, bytes: assembled.manifest.totalBytes,
  files: assembled.manifest.assets.length, pdfVolumes: assembled.pdfVolumes, releaseCertified: false }));
