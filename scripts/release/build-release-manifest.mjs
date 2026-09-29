/**
 * Read completed candidates and emit one release inventory; never build or publish assets.
 * With --sbom <sbom-output> (a finished dist/<name>/sbom.json), the same inputs also produce publication-manifest.json
 * (publicationManifest.mjs): SBOM, capture registry, sizes against the publishing limits and the restored OCCT kernel.
 */
import { argv } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDesktopFiles, sourceFileHash } from './desktopFileInventory.mjs';
import { collectOfflineAssetFiles } from '../vite/offlineAssets.mjs';
import { captureDesktopBuildSources, captureWebBuildSources } from '../vite/webBuildSources.mjs';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { createReleaseManifest } from './releaseManifest.mjs';
import { CAPTURE_REGISTRY_PATH, createPublicationManifest } from './publicationManifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const names = argv.slice(2);
const sbomFlag = names.indexOf('--sbom');
const sbomName = sbomFlag === -1 ? null : names.splice(sbomFlag, 2)[1] ?? '';
if (names.length < 4 || names.length > 5 || names.some((name, index) => index !== 4 && !/^[a-z0-9][a-z0-9-]*$/u.test(name))
  || (sbomName !== null && !/^[a-z0-9][a-z0-9-]*$/u.test(sbomName))) {
  throw new Error('Usage: node scripts/release/build-release-manifest.mjs <windows-stage> <linux-stage> <web-candidate> <new-output> [v<version>] [--sbom <sbom-output>]');
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
  manualInputs[name] = sourceFileHash(await readFile(cursor)); // As scripts/manual/generate.mjs records it.
}
const sourceInputs = { web: await captureWebBuildSources(root), desktop: await captureDesktopBuildSources(root), manual: manualInputs };
const manifest = await createReleaseManifest({ packageFiles, builderConfig, tag, sourceCommit, sourceInputs, candidates, webFiles });
if (JSON.stringify(sourceInputs.web) !== JSON.stringify(await captureWebBuildSources(root))
  || JSON.stringify(sourceInputs.desktop) !== JSON.stringify(await captureDesktopBuildSources(root))) {
  throw new Error('Release source changed while reading candidates');
}
const output = folder(outputName);
const manifestBytes = new globalThis.TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
let publication = null;
if (sbomName !== null) {
  const sbomFolder = folder(sbomName);
  for (const path of [sbomFolder, join(sbomFolder, 'sbom.json')]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('SBOM must not be a link: ' + path);
  }
  const registryPath = join(root, ...CAPTURE_REGISTRY_PATH.split('/'));
  if ((await lstat(registryPath)).isSymbolicLink()) throw new Error('Capture registry must not be a link');
  publication = await createPublicationManifest({ release: { packageFiles, builderConfig, tag, sourceCommit, sourceInputs, candidates, webFiles },
    releaseManifestBytes: manifestBytes, sbomBytes: await readFile(join(sbomFolder, 'sbom.json')),
    captureRegistryBytes: await readFile(registryPath) });
}
await mkdir(output);
await writeFile(join(output, 'release-manifest.json'), manifestBytes, { flag: 'wx' });
if (publication !== null) {
  await writeFile(join(output, 'publication-manifest.json'), JSON.stringify(publication, null, 2) + '\n', { flag: 'wx' });
}
log(JSON.stringify({ output, version: manifest.version, commit: manifest.sourceCommit,
  desktopArtifacts: manifest.desktop.windows.assets.length + manifest.desktop.linux.assets.length,
  webFiles: manifest.web.files.length, pdfVolumes: manifest.manual.pdfVolumes, releaseCertified: false,
  ...(publication === null ? {} : { publication: { largestWebFile: publication.sizes.web.largest,
    webFiles: publication.sizes.web.files, occtRestoredBytes: publication.runtimes.occt.restored.bytes } }) }));
