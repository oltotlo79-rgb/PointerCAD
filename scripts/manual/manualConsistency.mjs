/** Compare an emitted manual with the current help, not merely its own mutable inventory. */
import { createHash } from 'node:crypto';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => typeof value === 'string' ? new globalThis.TextEncoder().encode(value) : value;
const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  return a === b;
};

/** Source freshness is checked by the caller before loading its live catalog and renderer. */
export function verifyManualConsistency(manualFiles, expected) {
  const files = new Map(), folded = new Set();
  for (const file of manualFiles) {
    offlineAssetUrl(file.path);
    if (folded.has(file.path.toLowerCase()) || !(file.bytes instanceof Uint8Array)) {
      throw new Error('Duplicate or invalid manual file: ' + file.path);
    }
    folded.add(file.path.toLowerCase()); files.set(file.path, file.bytes);
  }
  const source = files.get('manifest.json');
  if (!source || source.length > 8_388_608) throw new Error('Missing or excessive manual manifest');
  const manifest = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(source));
  if (!record(manifest) || manifest.format !== 'pointercad-manual/1' || !record(manifest.inputs)
    || !record(manifest.outputs) || !record(manifest.images)) throw new Error('Invalid manual manifest');
  if (hash(JSON.stringify({ inputs: manifest.inputs, outputs: manifest.outputs })) !== manifest.buildId) {
    throw new Error('Manual identity does not match its inputs and outputs');
  }
  for (const key of ['chapters', 'volumes', 'featureCoverage', 'commandCoverage', 'supplementaryCoverage', 'nativeControlCoverage']) {
    if (!Object.hasOwn(expected, key) || !same(manifest[key], expected[key])) {
      throw new Error('Manual differs from current help: ' + key);
    }
  }
  const expectedNames = [...expected.pages.keys()].sort();
  const actualNames = [...files.keys()].filter(name => name.endsWith('.html')).sort();
  if (!same(expectedNames, actualNames)) throw new Error('Manual HTML pages differ from the current chapter catalog');
  for (const [name, content] of expected.pages) {
    if (hash(files.get(name)) !== hash(bytes(content))) throw new Error('Manual text or controls differ from current help: ' + name);
  }
  const imageNames = [...expected.images.keys()].sort();
  if (!same(Object.keys(manifest.images).sort(), imageNames)
    || !same([...files.keys()].filter(name => name.startsWith('images/')).sort(), imageNames)) {
    throw new Error('Manual images differ from current help');
  }
  for (const [name, content] of expected.images) {
    if (!record(manifest.images[name]) || manifest.images[name].sha256 !== hash(content)
      || !files.has(name) || hash(files.get(name)) !== hash(content)) throw new Error('Manual image changed: ' + name);
  }
  const coverage = {
    format: 'pointercad-help-coverage/1', features: expected.featureCoverage,
    commands: expected.commandCoverage, supplementary: expected.supplementaryCoverage,
    nativeControls: expected.nativeControlCoverage, releaseCertified: false,
  };
  const coverageBytes = files.get('feature-coverage.json');
  if (!coverageBytes || coverageBytes.length > 8_388_608
    || !same(JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(coverageBytes)), coverage)) {
    throw new Error('Manual feature coverage differs from current help');
  }
  if (files.size !== Object.keys(manifest.outputs).length + 1 || Object.hasOwn(manifest.outputs, 'manifest.json')) {
    throw new Error('Unexpected manual output');
  }
  for (const [name, expectedHash] of Object.entries(manifest.outputs)) {
    offlineAssetUrl(name);
    if (!files.has(name) || hash(files.get(name)) !== expectedHash) throw new Error('Manual output changed: ' + name);
  }
  // This proves content equality, not that every instruction, screen or PDF page has been accepted.
  return { manualBuildId: manifest.buildId, chapters: expected.chapters.length,
    images: imageNames.length, contentMatchesCurrentHelp: true, releaseCertified: false };
}
