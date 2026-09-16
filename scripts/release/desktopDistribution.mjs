import { assembleManualDistribution } from '../vite/offlineDistribution.mjs';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { desktopFileHash } from './desktopFileInventory.mjs';
import { inspectDesktopEntry } from './desktopEntryReferences.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const encode = value => new globalThis.TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
export function desktopJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 8_388_608) throw new Error('Missing or excessive desktop metadata');
  return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function inputFiles(files) {
  const result = new Map(), folded = new Set();
  for (const file of files) {
    offlineAssetUrl(file.path);
    if (folded.has(file.path.toLowerCase()) || !(file.bytes instanceof Uint8Array) || file.bytes.length === 0) {
      throw new Error('Invalid or duplicate desktop input: ' + file.path);
    }
    folded.add(file.path.toLowerCase()); result.set(file.path, file.bytes);
  }
  return result;
}
function readBuild(desktop) {
  const manifest = desktopJson(desktop.get('desktop-build.json'));
  if (!record(manifest) || manifest.format !== 'pointercad-desktop-build/1'
    || !record(manifest.inputs) || !record(manifest.outputs) || Object.keys(manifest.inputs).length === 0
    || desktop.size !== Object.keys(manifest.outputs).length + 1) throw new Error('Invalid desktop build inventory');
  for (const [name, hash] of Object.entries(manifest.outputs)) {
    offlineAssetUrl(name);
    if (!/^(main|preload|renderer)\//u.test(name) || !sha(hash) || !desktop.has(name)
      || desktopFileHash(desktop.get(name)) !== hash) throw new Error('Desktop build changed: ' + name);
  }
  for (const name of ['main/main.cjs', 'preload/preload.cjs']) inspectDesktopEntry(name, desktop.get(name));
  for (const name of ['renderer/index.html', 'renderer/fonts/LICENSES.txt', 'renderer/licenses/math-notices.json',
    'renderer/licenses/runtime/runtime-notices.json', 'renderer/LICENSE', 'renderer/NOTICE',
    'renderer/licenses/exact-math/manifest.json', 'renderer/exact-math/runtime/pyodide.asm.wasm']) {
    if (!desktop.has(name)) throw new Error('Missing desktop resource: ' + name);
  }
  for (const pattern of [/^renderer\/assets\/opencascade\.full-.+\.wasm$/u, /^renderer\/assets\/quickjs-pcad-.+\.wasm$/u]) {
    if ([...desktop.keys()].filter(name => pattern.test(name)).length !== 1) throw new Error('Missing or ambiguous desktop calculation binary');
  }
  return manifest;
}
function appMetadata(metadata) {
  if (!record(metadata) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(metadata.version)
    || !/^[a-f0-9]{40}$/u.test(metadata.sourceCommit) || !['win32', 'linux'].includes(metadata.platform)
    || metadata.arch !== 'x64' || !/^\d+\.\d+\.\d+$/u.test(metadata.electronVersion)
    || metadata.builderVersion !== '26.15.3') throw new Error('Invalid desktop package identity');
  return { name: 'pointercad', productName: 'PointerCAD', version: metadata.version, private: true,
    main: './dist/main/main.cjs', description: '座標と数式で作図するCAD',
    author: { name: 'PointerCAD contributors' }, license: 'Apache-2.0',
    homepage: 'https://github.com/oltotlo79-rgb/PointerCAD' };
}

/** Stage only generated runtime assets and one complete manual edition; no node_modules resolution. */
export function assembleDesktopDistribution(desktopFiles, manualFiles, pdfFiles, notices, metadata) {
  const desktop = inputFiles(desktopFiles), build = readBuild(desktop), application = appMetadata(metadata);
  const manual = inputFiles(manualFiles), manualManifest = desktopJson(manual.get('manifest.json'));
  if (!record(manualManifest.inputs)) throw new Error('Missing manual source inventory');
  for (const [name, hash] of Object.entries(manualManifest.inputs)) {
    if (Object.hasOwn(build.inputs, name) && build.inputs[name] !== hash) throw new Error('Manual and desktop source editions differ: ' + name);
  }
  const manuals = assembleManualDistribution(manualFiles, pdfFiles), files = new Map();
  const add = (name, bytes) => { if (files.has(name)) throw new Error('Desktop path collision'); files.set(name, bytes); };
  for (const [name, bytes] of desktop) if (name !== 'desktop-build.json') add('dist/' + name, bytes);
  for (const [name, bytes] of manuals.files) add('dist/renderer/' + name, bytes);
  for (const name of ['LICENSE', 'NOTICE']) {
    const bytes = notices.get(name);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Missing application notice: ' + name);
    add(name, bytes);
  }
  add('package.json', encode(application));
  const inventory = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: desktopFileHash(bytes) }));
  const manifest = { format: 'pointercad-desktop-package/1', ...metadata, signed: false, releaseCertified: false,
    manualBuildId: manuals.manualBuildId, pdfVolumes: manuals.pdfVolumes,
    inputs: build.inputs, files: inventory, application };
  add('desktop-package.json', encode(manifest));
  return { files, manifest };
}

/** Builder may reformat package.json; every value must remain identical. Other files are byte-exact. */
export function verifyDesktopDistribution(packagedFiles, expectedManifestBytes) {
  const files = inputFiles(packagedFiles), expected = desktopJson(expectedManifestBytes);
  if (!record(expected) || expected.format !== 'pointercad-desktop-package/1' || !Array.isArray(expected.files)
    || !record(expected.application) || files.size !== expected.files.length + 1
    || desktopFileHash(files.get('desktop-package.json') ?? new Uint8Array()) !== desktopFileHash(expectedManifestBytes)) {
    throw new Error('Packaged desktop inventory differs');
  }
  const seen = new Set();
  for (const item of expected.files) {
    if (!record(item) || seen.has(item.path) || !sha(item.sha256)) throw new Error('Invalid desktop inventory entry');
    offlineAssetUrl(item.path); seen.add(item.path);
    const bytes = files.get(item.path);
    if (!bytes) throw new Error('Packaged desktop file is missing: ' + item.path);
    if (item.path === 'package.json') {
      const actual = desktopJson(bytes), names = Object.keys(expected.application);
      if (!record(actual) || Object.keys(actual).length !== names.length
        || names.some(name => JSON.stringify(actual[name]) !== JSON.stringify(expected.application[name]))) {
        throw new Error('Packaged application metadata changed');
      }
    } else if (bytes.length !== item.bytes || desktopFileHash(bytes) !== item.sha256) {
      throw new Error('Packaged desktop file changed: ' + item.path);
    }
  }
  return { files: files.size, manualBuildId: expected.manualBuildId, pdfVolumes: expected.pdfVolumes,
    applicationMetadataSha256: desktopFileHash(files.get('package.json')), releaseCertified: false };
}
