/** Bind the existing desktop, Web and offline inventories to one release edition. */
import { createHash } from 'node:crypto';
import { verifyDesktopPackageArtifacts } from './desktopPackageTargets.mjs';
import { verifyDesktopDistribution } from './desktopDistribution.mjs';
import { assembleManualDistribution } from '../vite/offlineDistribution.mjs';
import { readOfflineAssetManifest, offlineAssetUrl } from '../vite/offlineProtocol.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
const parse = (bytes, label) => {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 8_388_608) throw new Error('Missing or excessive ' + label);
  try { return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid ' + label); }
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = value => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

function sourceInventory(value, label) {
  if (!record(value) || Object.keys(value).length === 0) throw new Error('Missing ' + label + ' input fingerprints');
  for (const [name, digest] of Object.entries(value)) {
    offlineAssetUrl(name);
    if (!hash(digest)) throw new Error('Invalid ' + label + ' input fingerprint: ' + name);
  }
  return sorted(value);
}
function filesByPath(files, label, key) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Missing ' + label + ' files');
  const found = new Map(), folded = new Set();
  for (const item of files) {
    const name = item?.[key];
    offlineAssetUrl(name);
    if (folded.has(name.toLowerCase()) || !(item.bytes instanceof Uint8Array) || item.bytes.length === 0) {
      throw new Error('Invalid or duplicate ' + label + ' file: ' + name);
    }
    folded.add(name.toLowerCase()); found.set(name, item.bytes);
  }
  return found;
}
function packageVersion(value, label, expected) {
  if (!record(value) || !version(value.version)) throw new Error('Invalid ' + label + ' package version');
  if (value.version !== expected) throw new Error(label + ' package version differs: ' + value.version + ' != ' + expected);
}
function builderSettings(value, expected) {
  if (typeof value !== 'string') throw new Error('Missing desktop builder configuration');
  for (const line of [
    /^\s*win:\s*$/mu, /^\s*linux:\s*$/mu, /^\s*- target: nsis\s*$/mu,
    /^\s*- target: portable\s*$/mu, /^\s*- target: AppImage\s*$/mu,
  ]) if (!line.test(value)) throw new Error('Desktop builder target differs');
  const arches = [...value.matchAll(/^\s*arch:\s*\[([^\]]+)\]\s*$/gmu)];
  if (arches.length !== 3 || arches.some(match => match[1].trim() !== 'x64')) throw new Error('Desktop builder architecture differs');
  const explicit = value.match(/^version:\s*['"]?([^'"\s#]+)['"]?\s*$/mu);
  if (explicit && explicit[1] !== expected) throw new Error('Desktop builder version differs');
  const names = [...value.matchAll(/^\s*artifactName:\s*(\S+)\s*$/gmu)].map(match => match[1]);
  if (!equal(names, [
    'PointerCAD-${version}-windows-${arch}-setup.${ext}',
    'PointerCAD-${version}-windows-${arch}-portable.${ext}',
    'PointerCAD-${version}-linux-${arch}.${ext}',
  ])) throw new Error('Desktop builder artifact names differ');
}

/** Inputs are read-only snapshots; artifact bytes are checked against candidate.json. */
export async function createReleaseManifest({ packageFiles, builderConfig, tag = null, sourceCommit, sourceInputs, candidates, webFiles }) {
  const packages = { root: parse(packageFiles?.root, 'root package.json'),
    desktop: parse(packageFiles?.desktop, 'desktop package.json'), web: parse(packageFiles?.web, 'Web package.json') };
  const releaseVersion = packages?.root?.version;
  if (!version(releaseVersion)) throw new Error('Invalid root package version');
  packageVersion(packages.desktop, 'Desktop', releaseVersion);
  packageVersion(packages.web, 'Web', releaseVersion);
  builderSettings(builderConfig, releaseVersion);
  if (!commit(sourceCommit)) throw new Error('Invalid release commit');
  if (tag !== null && tag !== 'v' + releaseVersion) throw new Error('Release tag version differs');
  const currentWeb = sourceInventory(sourceInputs?.web, 'current Web');
  const currentDesktop = sourceInventory(sourceInputs?.desktop, 'current desktop');
  const currentManual = sourceInventory(sourceInputs?.manual, 'current manual');
  for (const name of ['package.json', 'apps/web/package.json']) {
    if (currentWeb[name] === undefined) throw new Error('Missing Web version source: ' + name);
  }
  for (const name of ['package.json', 'apps/desktop/package.json', 'apps/desktop/electron-builder.yml']) {
    if (currentDesktop[name] === undefined) throw new Error('Missing desktop version source: ' + name);
  }
  for (const [name, value] of [['package.json', packageFiles.root], ['apps/web/package.json', packageFiles.web]]) {
    if (currentWeb[name] !== sha256(value)) throw new Error('Web package source fingerprint differs: ' + name);
  }
  for (const [name, value] of [['package.json', packageFiles.root], ['apps/desktop/package.json', packageFiles.desktop]]) {
    if (currentDesktop[name] !== sha256(value)) throw new Error('Desktop package source fingerprint differs: ' + name);
  }
  if (currentDesktop['apps/desktop/electron-builder.yml'] !== sha256(builderConfig)) throw new Error('Desktop builder source fingerprint differs');
  for (const name of Object.keys(currentWeb)) {
    if (currentDesktop[name] !== undefined && currentDesktop[name] !== currentWeb[name]) throw new Error('Web and desktop input fingerprints differ: ' + name);
  }
  if (!Array.isArray(candidates) || candidates.length !== 2) throw new Error('Both desktop candidates are required');
  const desktop = {};
  for (const candidate of candidates) {
    const receipt = parse(candidate?.receiptBytes, 'candidate.json');
    const staged = parse(candidate?.packageManifestBytes, 'desktop-package.json');
    if (!record(receipt) || receipt.format !== 'pointercad-desktop-candidate/1'
      || !['win32', 'linux'].includes(receipt.platform) || desktop[receipt.platform]
      || receipt.arch !== 'x64' || receipt.version !== releaseVersion || receipt.sourceCommit !== sourceCommit
      || receipt.signed !== false || receipt.releaseCertified !== false || receipt.installed !== false) {
      throw new Error('Desktop candidate target, version or commit differs');
    }
    if (!record(staged) || staged.format !== 'pointercad-desktop-package/1'
      || staged.platform !== receipt.platform || staged.arch !== 'x64' || staged.version !== releaseVersion
      || staged.sourceCommit !== sourceCommit || staged.signed !== false || staged.releaseCertified !== false
      || !record(staged.application) || staged.application.version !== releaseVersion) {
      throw new Error('Desktop staged package target, version or commit differs');
    }
    const inputs = sourceInventory(staged.inputs, 'desktop package');
    if (!equal(inputs, currentDesktop)) throw new Error('Desktop package input fingerprints differ from release commit');
    if (!Array.isArray(candidate.stagedFiles)) throw new Error('Missing staged desktop files');
    const verified = verifyDesktopDistribution(candidate.stagedFiles, candidate.packageManifestBytes);
    if (!equal(receipt.application, verified) || receipt.application.manualBuildId !== staged.manualBuildId
      || receipt.application.pdfVolumes !== staged.pdfVolumes || receipt.application.releaseCertified !== false) {
      throw new Error('Desktop candidate and staged application differ');
    }
    if (!Array.isArray(candidate.artifacts)) throw new Error('Missing desktop artifacts');
    const artifacts = new Map();
    for (const asset of candidate.artifacts) {
      offlineAssetUrl(asset?.name);
      if (artifacts.has(asset.name) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !hash(asset.sha256)) {
        throw new Error('Invalid or duplicate desktop artifact: ' + asset?.name);
      }
      artifacts.set(asset.name, asset);
    }
    if (!Array.isArray(receipt.assets) || receipt.assets.length !== artifacts.size) throw new Error('Unrecorded desktop artifact');
    for (const asset of receipt.assets) {
      if (!record(asset) || !hash(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
        || !artifacts.has(asset.name) || artifacts.get(asset.name).bytes !== asset.bytes
        || artifacts.get(asset.name).sha256 !== asset.sha256) throw new Error('Desktop artifact differs: ' + asset?.name);
    }
    const planned = verifyDesktopPackageArtifacts(receipt.platform, releaseVersion, receipt.assets);
    if (!equal(receipt.packages, planned)) throw new Error('Desktop candidate package targets differ');
    desktop[receipt.platform] = { platform: receipt.platform, arch: 'x64', candidate: receipt,
      candidateSha256: sha256(candidate.receiptBytes), packageManifestSha256: sha256(candidate.packageManifestBytes),
      assets: [...receipt.assets].sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (!desktop.win32 || !desktop.linux) throw new Error('Windows and Linux desktop candidates are required');

  const web = filesByPath(webFiles, 'Web distribution', 'path');
  const buildBytes = web.get('web-build.json'), offlineBytes = web.get('offline-assets.json');
  const build = parse(buildBytes, 'web-build.json'), offline = await readOfflineAssetManifest(parse(offlineBytes, 'offline-assets.json'));
  if (!record(build) || build.format !== 'pointercad-web-build/1'
    || !equal(sourceInventory(build.inputs, 'Web build'), currentWeb) || !record(build.outputs)) {
    throw new Error('Web build input fingerprints differ from release commit');
  }
  // A missing sourceCommit/dirtySources means a pre-P13-1b record; only a recorded mismatch or dirty build is refused.
  if (build.sourceCommit !== undefined && build.sourceCommit !== sourceCommit) throw new Error('Web build source commit differs');
  if (build.dirtySources === true) throw new Error('Web build was generated from dirty sources');
  for (const [name, digest] of Object.entries(build.outputs)) {
    offlineAssetUrl(name);
    if (!hash(digest) || !web.has(name) || sha256(web.get(name)) !== digest) throw new Error('Web build output differs: ' + name);
  }
  for (const name of ['index.html', 'service-worker.js', '_headers']) {
    if (!Object.hasOwn(build.outputs, name)) throw new Error('Missing Web build control file: ' + name);
  }
  const expectedWeb = new Set(['offline-assets.json', 'service-worker.js', '_headers']);
  for (const asset of offline.assets) {
    const name = decodeURIComponent(asset.url);
    expectedWeb.add(name);
    if (!web.has(name) || web.get(name).length !== asset.byteLength || sha256(web.get(name)) !== asset.sha256) {
      throw new Error('Offline asset differs: ' + name);
    }
  }
  for (const name of web.keys()) {
    if (name === '_redirects') {
      if (!Object.hasOwn(build.outputs, name)) throw new Error('Unrecorded Web deployment file: ' + name);
      expectedWeb.add(name);
    }
    if (!expectedWeb.has(name)) throw new Error('Unrecorded Web file: ' + name);
  }
  for (const name of expectedWeb) if (!web.has(name)) throw new Error('Missing Web file: ' + name);
  const manualFiles = [], pdfFiles = [];
  for (const [name, bytes] of web) {
    if (name.startsWith('manual/pdf/')) pdfFiles.push({ path: name.slice('manual/pdf/'.length), bytes });
    else if (name.startsWith('manual/')) manualFiles.push({ path: name.slice('manual/'.length), bytes });
  }
  const manual = assembleManualDistribution(manualFiles, pdfFiles);
  if (manual.files.size !== manualFiles.length + pdfFiles.length) throw new Error('Unrecorded manual file');
  for (const [name, bytes] of manual.files) {
    if (!web.has(name) || sha256(web.get(name)) !== sha256(bytes)) throw new Error('Manual file differs: ' + name);
  }
  for (const entry of Object.values(desktop)) {
    if (entry.candidate.application.manualBuildId !== manual.manualBuildId
      || entry.candidate.application.pdfVolumes !== manual.pdfVolumes) throw new Error('Desktop and Web manual editions differ');
  }
  const manualManifest = parse(web.get('manual/manifest.json'), 'manual/manifest.json');
  if (manualManifest.sourceCommit !== undefined && manualManifest.sourceCommit !== sourceCommit) {
    throw new Error('Manual source commit differs');
  }
  if (manualManifest.dirtySources === true) throw new Error('Manual was generated from dirty sources');
  if (!equal(sourceInventory(manualManifest.inputs, 'manual'), currentManual)) throw new Error('Manual input fingerprints differ');
  for (const [name, digest] of Object.entries(currentManual)) {
    if ((currentWeb[name] !== undefined && currentWeb[name] !== digest)
      || (currentDesktop[name] !== undefined && currentDesktop[name] !== digest)) throw new Error('Manual and application input fingerprints differ: ' + name);
  }
  const inventory = [...web].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { format: 'pointercad-release/1', version: releaseVersion, tag, sourceCommit, releaseCertified: false,
    targets: ['windows-x64-nsis', 'windows-x64-portable', 'linux-x64-AppImage', 'cloudflare-pages'],
    inputs: { webSha256: sha256(JSON.stringify(currentWeb)), desktopSha256: sha256(JSON.stringify(currentDesktop)),
      manualSha256: sha256(JSON.stringify(currentManual)) },
    desktop: { windows: desktop.win32, linux: desktop.linux },
    web: { platform: 'cloudflare-pages', buildId: offline.buildId, webBuildSha256: sha256(buildBytes),
      offlineAssetsSha256: sha256(offlineBytes), totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0), files: inventory },
    manual: { buildId: manual.manualBuildId, pdfVolumes: manual.pdfVolumes,
      volumes: manualManifest.volumes.map(volume => ({ id: volume.id, title: volume.title,
        html: 'manual/volumes/' + volume.id + '.html', pdf: 'manual/pdf/' + volume.id + '.pdf' })) } };
}

/** Recompute from the original records and bytes before publishing a saved release-manifest.json. */
export async function verifyReleaseManifest(manifest, inputs) {
  const expected = await createReleaseManifest(inputs);
  if (!equal(manifest, expected)) throw new Error('Release manifest differs from distribution records');
  return expected;
}
