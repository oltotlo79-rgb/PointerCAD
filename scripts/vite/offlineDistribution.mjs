/** Assemble emitted Web/manual/PDF bytes, then publish one inventory. This does not certify a release. */
import { createHash } from 'node:crypto';
import { createOfflineAssetManifest } from './offlineAssets.mjs';
import { OFFLINE_CONTROL_FILES, OFFLINE_DEPLOYMENT_FILES, offlineAssetUrl } from './offlineProtocol.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function parse(bytes, name) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8_388_608) throw new Error('Missing or excessive ' + name);
  return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function fileMap(files) {
  const result = new Map(), folded = new Set();
  for (const { path, bytes } of files) {
    offlineAssetUrl(path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || folded.has(path.toLowerCase())) {
      throw new Error('Duplicate or empty distribution file: ' + path);
    }
    folded.add(path.toLowerCase()); result.set(path, bytes);
  }
  return result;
}
function verifiedFiles(files, expected, label) {
  if (!record(expected) || Object.keys(expected).length === 0) throw new Error('Missing ' + label + ' output inventory');
  const selected = new Map();
  for (const [name, hash] of Object.entries(expected)) {
    offlineAssetUrl(name);
    const bytes = files.get(name);
    if (!sha(hash) || bytes === undefined || sha256(bytes) !== hash) throw new Error(label + ' output changed: ' + name);
    selected.set(name, bytes);
  }
  return selected;
}

/** All volumes come from the same HTML edition. Source and capture certification remain separate. */
export function assembleOfflineDistribution(webFiles, manualFiles, pdfFiles) {
  const web = fileMap(webFiles), manual = fileMap(manualFiles), pdf = fileMap(pdfFiles);
  if (!web.has('index.html') || !web.has('service-worker.js') || !web.has('_headers')) {
    throw new Error('Web entry, offline worker and deployment headers are required');
  }
  if (web.has('offline-assets.json')) throw new Error('Refuse to reuse an earlier offline inventory');
  const webManifest = parse(web.get('web-build.json'), 'Web build manifest');
  if (!record(webManifest) || webManifest.format !== 'pointercad-web-build/1' || !record(webManifest.inputs)
    || Object.keys(webManifest.inputs).length === 0) throw new Error('Invalid Web build inputs');
  const verifiedWeb = verifiedFiles(web, webManifest.outputs, 'Web');
  if (web.size !== verifiedWeb.size + 1 || verifiedWeb.has('web-build.json')) throw new Error('Unexpected Web output');
  for (const name of web.keys()) if (name.startsWith('manual/')) throw new Error('Web output already contains a manual');
  const manualBytes = manual.get('manifest.json'), manualManifest = parse(manualBytes, 'manual manifest');
  if (!record(manualManifest) || manualManifest.format !== 'pointercad-manual/1'
    || !sha(manualManifest.buildId) || !record(manualManifest.inputs) || !record(manualManifest.outputs)
    || !Array.isArray(manualManifest.volumes) || manualManifest.volumes.length === 0
    || !Array.isArray(manualManifest.chapters) || manualManifest.chapters.length === 0) throw new Error('Invalid manual manifest');
  if (sha256(JSON.stringify({ inputs: manualManifest.inputs, outputs: manualManifest.outputs })) !== manualManifest.buildId) {
    throw new Error('Manual identity does not match its inputs and outputs');
  }
  const chapters = new Set();
  for (const chapter of manualManifest.chapters) {
    if (!record(chapter) || typeof chapter.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(chapter.id)
      || chapters.has(chapter.id)) throw new Error('Missing or duplicate manual chapter');
    chapters.add(chapter.id);
  }
  const assigned = new Set();
  const selectedManual = verifiedFiles(manual, manualManifest.outputs, 'Manual');
  if (!selectedManual.has('index.html') || !selectedManual.has('fonts/LICENSES.txt')) throw new Error('Incomplete manual entry or notices');
  if (manual.size !== selectedManual.size + 1) throw new Error('Unexpected manual output');
  const pdfBytes = pdf.get('pdf-manifest.json'), pdfManifest = parse(pdfBytes, 'PDF manifest');
  if (!record(pdfManifest) || pdfManifest.format !== 'pointercad-manual-pdf/1' || pdfManifest.completed !== true
    || pdfManifest.manualBuildId !== manualManifest.buildId || pdfManifest.manualManifestSha256 !== sha256(manualBytes)
    || !Array.isArray(pdfManifest.volumes) || pdfManifest.volumes.length !== manualManifest.volumes.length
    || pdfManifest.fontNoticeSha256 !== manualManifest.outputs['fonts/LICENSES.txt']) throw new Error('PDF and HTML editions differ');
  const expectedPdf = { 'LICENSES.txt': pdfManifest.fontNoticeSha256 }, ids = new Set();
  for (const [index, volume] of manualManifest.volumes.entries()) {
    const printed = pdfManifest.volumes[index];
    if (!record(volume) || typeof volume.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(volume.id)
      || ids.has(volume.id) || !Array.isArray(volume.topics) || !record(printed) || printed.id !== volume.id
      || printed.title !== volume.title || printed.name !== volume.id + '.pdf'
      || printed.source !== 'volumes/' + volume.id + '.html'
      || !selectedManual.has(printed.source) || !Number.isSafeInteger(printed.bytes)
      || pdf.get(printed.name)?.byteLength !== printed.bytes || !sha(printed.sha256)
      || !record(printed.content) || !Array.isArray(printed.content.chapters)
      || JSON.stringify(printed.content.chapters) !== JSON.stringify(volume.topics.map(id => 'chapter-' + id))) {
      throw new Error('Missing, reordered or changed PDF volume');
    }
    for (const id of volume.topics) {
      if (!chapters.has(id) || assigned.has(id) || !selectedManual.has('chapters/' + id + '.html')) {
        throw new Error('Missing or duplicate chapter in a manual volume');
      }
      assigned.add(id);
    }
    ids.add(volume.id); expectedPdf[printed.name] = printed.sha256;
  }
  if (assigned.size !== chapters.size) throw new Error('Some manual chapters have no PDF volume');
  const selectedPdf = verifiedFiles(pdf, expectedPdf, 'PDF');
  if (pdf.size !== selectedPdf.size + 1) throw new Error('Unexpected PDF output');
  const assembled = new Map(web);
  const add = (name, bytes) => { if (assembled.has(name)) throw new Error('Distribution path collision'); assembled.set(name, bytes); };
  for (const [name, bytes] of selectedManual) add('manual/' + name, bytes);
  add('manual/manifest.json', manualBytes);
  for (const [name, bytes] of selectedPdf) add('manual/pdf/' + name, bytes);
  add('manual/pdf/pdf-manifest.json', pdfBytes);
  const assets = [...assembled].filter(([path]) => !OFFLINE_CONTROL_FILES.includes(path) && !OFFLINE_DEPLOYMENT_FILES.includes(path))
    .map(([path, bytes]) => ({ path, bytes }));
  const manifest = createOfflineAssetManifest(assets, assets.map(file => file.path));
  add('offline-assets.json', new globalThis.TextEncoder().encode(JSON.stringify(manifest)));
  return { files: assembled, manifest, manualBuildId: manualManifest.buildId,
    pdfVolumes: pdfManifest.volumes.length, releaseCertified: false };
}
