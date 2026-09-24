/** Read completed candidates and emit one release inventory; never build or publish assets. */
import { argv } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDesktopFiles } from './desktopFileInventory.mjs';
import { collectOfflineAssetFiles } from '../vite/offlineAssets.mjs';
import { captureDesktopBuildSources, captureWebBuildSources } from '../vite/webBuildSources.mjs';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { createReleaseManifest } from './releaseManifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const names = argv.slice(2);
if (names.length < 4 || names.length > 5 || names.some((name, index) => index !== 4 && !/^[a-z0-9][a-z0-9-]*$/u.test(name))) {
  throw new Error('Usage: node scripts/release/build-release-manifest.mjs <windows-stage> <linux-stage> <web-candidate> <new-output> [v<version>]');
}
const dist = join(root, 'dist');
if ((await lstat(dist)).isSymbolicLink()) throw new Error('Distribution parent must not be a link');
const [windowsName, linuxName, webName, outputName, tag = null] = names;
const folder = name => join(dist, name);
const digest = async path => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Invalid desktop artifact: ' + path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error('Desktop artifact changed while reading: ' + path);
  return { bytes: stat.size, sha256: hash.digest('hex') };
};
const candidates = [];
for (const name of [windowsName, linuxName]) {
  const stage = folder(name), app = join(stage, 'app'), artifactsFolder = join(stage, 'artifacts');
  const stagedFiles = await collectDesktopFiles(root, app);
  const packageManifestBytes = stagedFiles.find(file => file.path === 'desktop-package.json')?.bytes;
  const receiptBytes = await readFile(join(stage, 'candidate.json'));
  const entries = await readdir(artifactsFolder, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected desktop artifact entry: ' + entry.name);
    artifacts.push({ name: entry.name, ...await digest(join(artifactsFolder, entry.name)) });
  }
  candidates.push({ receiptBytes, packageManifestBytes, stagedFiles, artifacts });
}
const webFolder = folder(webName), collected = await collectOfflineAssetFiles(root, webFolder);
const webFiles = [...collected.files];
for (const name of collected.excluded) webFiles.push({ path: name, bytes: await readFile(join(webFolder, name)) });
const packageFiles = { root: await readFile(join(root, 'package.json')),
  desktop: await readFile(join(root, 'apps/desktop/package.json')),
  web: await readFile(join(root, 'apps/web/package.json')) };
const builderConfig = await readFile(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
const sourceCommit = execFileSync('git', ['--no-optional-locks', '-c', 'safe.directory=' + root.replaceAll('\\', '/'),
  'rev-parse', 'HEAD'],
  { cwd: root, env: localGitEnvironment(), encoding: 'utf8', windowsHide: true }).trim();
const manualBytes = webFiles.find(file => file.path === 'manual/manifest.json')?.bytes;
if (!manualBytes) throw new Error('Missing manual/manifest.json');
const manualRecord = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(manualBytes));
if (!manualRecord || !manualRecord.inputs || typeof manualRecord.inputs !== 'object' || Array.isArray(manualRecord.inputs)) {
  throw new Error('Invalid manual source inventory');
}
const manualInputs = {};
for (const name of Object.keys(manualRecord.inputs)) {
  offlineAssetUrl(name);
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Manual source is a link: ' + name);
  }
  if (!(await lstat(cursor)).isFile()) throw new Error('Missing manual source: ' + name);
  manualInputs[name] = createHash('sha256').update(await readFile(cursor)).digest('hex');
}
const sourceInputs = { web: await captureWebBuildSources(root), desktop: await captureDesktopBuildSources(root), manual: manualInputs };
const manifest = await createReleaseManifest({ packageFiles, builderConfig, tag, sourceCommit, sourceInputs, candidates, webFiles });
if (JSON.stringify(sourceInputs.web) !== JSON.stringify(await captureWebBuildSources(root))
  || JSON.stringify(sourceInputs.desktop) !== JSON.stringify(await captureDesktopBuildSources(root))) {
  throw new Error('Release source changed while reading candidates');
}
const output = folder(outputName);
await mkdir(output);
await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
log(JSON.stringify({ output, version: manifest.version, commit: manifest.sourceCommit,
  desktopArtifacts: manifest.desktop.windows.assets.length + manifest.desktop.linux.assets.length,
  webFiles: manifest.web.files.length, pdfVolumes: manifest.manual.pdfVolumes, releaseCertified: false }));
