/**
 * P13-1/P13-3: bind the already verified release records into one publication manifest.
 *
 * The existing records keep their own formats and are not changed here:
 * - release-manifest.json (pointercad-release/1) already binds both desktop candidate.json files, web-build.json,
 *   offline-assets.json and the manual/PDF edition, and is re-derived from those records and bytes first.
 * - sbom.json (CycloneDX, P13-6) is bound by hash, version, commit and its distributed-file facts.
 * - capture-manifest.json (the capture registry of the manual images) is bound by hash.
 * On top of that this adds what P13-3 needs from the distributed bytes themselves: the size of every Web file and
 * desktop download against the publishing limits, the explicit gzip restoration of the OCCT kernel back to the very
 * WebAssembly the desktop candidates ship, and the presence of the runtimes an offline Web edition needs.
 * The manifest never records its own hash, and releaseCertified stays false (P13-15/P13-20 certify later).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { verifyReleaseManifest } from './releaseManifest.mjs';
import { assertSbomMatchesReleaseManifest, assertSbomPublishable, matchSbomToReleaseManifest } from './sbom.mjs';
import { CAPTURE_IMAGE_FOLDER, CAPTURE_REGISTRY_FILE, CAPTURE_REGISTRY_FORMAT } from '../manual/captureRegistry.mjs';
import { OFFLINE_MAX_FILE_BYTES, offlineAssetUrl } from '../vite/offlineProtocol.mjs';

export const PUBLICATION_FORMAT = 'pointercad-publication/1';
/**
 * pagesFileBytes/pagesFiles: Cloudflare Pages direct upload from the dashboard, 25 MiB per file and 1,000 files
 * (docs/standards/cloudflare-pages.md; the same values as PAGES_MAX_FILE_BYTES/PAGES_MAX_FILES in
 * releaseReadiness.mjs, which a unit test keeps equal). releaseAssetBytes: GitHub Releases, "each file included in
 * a release must be under 2 GiB", so the largest accepted size is 2 GiB - 1 byte.
 */
export const PUBLICATION_LIMITS = Object.freeze({
  pagesFileBytes: OFFLINE_MAX_FILE_BYTES, pagesFiles: 1_000, releaseAssetBytes: 2_147_483_647,
});
/** Runtimes whose version must be readable from the SBOM (component version, or "<name> <version>" in the name). */
export const PUBLICATION_RUNTIMES = Object.freeze(['opencascade.js', 'Pyodide', 'sympy', 'mpmath', 'quickjs-pcad.wasm', 'mathlive']);
export const CAPTURE_REGISTRY_PATH = CAPTURE_IMAGE_FOLDER + '/' + CAPTURE_REGISTRY_FILE;

const OCCT_MANIFEST = 'occt/manifest.json';
const EXACT_MATH_WASM = 'exact-math/runtime/pyodide.asm.wasm';
const SCRIPT_VM_WASM = /^assets\/quickjs-pcad-[^/]+\.wasm$/u;
const DESKTOP_OCCT_WASM = /^dist\/renderer\/assets\/opencascade\.full-[^/]+\.wasm$/u;
const DESKTOP_EXACT_MATH_WASM = 'dist/renderer/' + EXACT_MATH_WASM;
const DESKTOP_SCRIPT_VM_WASM = /^dist\/renderer\/assets\/quickjs-pcad-[^/]+\.wasm$/u;
const FONT_FILE = /\.(?:otf|ttf|woff2?)$/iu;
const CONTROL_FILES = new Set(['offline-assets.json', 'service-worker.js', 'web-build.json', '_headers', '_redirects']);
const GZIP_MAGIC = [0x1f, 0x8b, 0x08];
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const HASH = /^[a-f0-9]{64}$/u;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const startsWith = (bytes, magic) => bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function parse(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 67_108_864) throw new Error('Missing or excessive ' + label);
  try { return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid ' + label); }
}
const fileRecord = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) });

/** One category per Web path; the first matching rule wins. */
export function publicationCategory(path) {
  if (CONTROL_FILES.has(path)) return 'control';
  if (path.startsWith('occt/')) return 'occt';
  if (path.startsWith('exact-math/')) return 'exact-math';
  if (SCRIPT_VM_WASM.test(path)) return 'script-vm';
  if (/^manual\/pdf\/[^/]+\.pdf$/u.test(path)) return 'manual-pdf';
  if (path.startsWith('manual/')) return 'manual';
  if (path.startsWith('licenses/')) return 'licenses';
  if (FONT_FILE.test(path)) return 'fonts';
  return 'application';
}

function largestOf(items) {
  return items.reduce((best, item) => best === null || item.bytes > best.bytes
    || (item.bytes === best.bytes && compare(item.path, best.path) < 0) ? item : best, null);
}
function summary(items) {
  const largest = largestOf(items);
  return { files: items.length, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    largest: largest === null ? null : { path: largest.path, bytes: largest.bytes } };
}
function sizeItems(items, label) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Missing ' + label + ' size records');
  return items.map(item => {
    const path = item?.path ?? item?.name;
    if (typeof path !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('Invalid ' + label + ' size record');
    return { path, bytes: item.bytes };
  });
}

/**
 * Measure the Web files (path/bytes) and the desktop downloads (name/bytes) against PUBLICATION_LIMITS.
 * Takes byte counts rather than bytes so that the limits themselves can be tested without allocating them.
 */
export function measurePublicationSizes(webFiles, desktop) {
  const web = sizeItems(webFiles, 'Web');
  const oversized = web.filter(item => item.bytes > PUBLICATION_LIMITS.pagesFileBytes).sort((a, b) => b.bytes - a.bytes);
  if (oversized.length > 0) {
    throw new Error('Web file exceeds ' + PUBLICATION_LIMITS.pagesFileBytes + ' bytes: '
      + oversized.map(item => item.path + ' (' + item.bytes + ')').join(', '));
  }
  if (web.length > PUBLICATION_LIMITS.pagesFiles) throw new Error('Web distribution has ' + web.length + ' files; limit ' + PUBLICATION_LIMITS.pagesFiles);
  const categories = {};
  for (const item of web) (categories[publicationCategory(item.path)] ??= []).push(item);
  const desktopSizes = {};
  for (const platform of ['windows', 'linux']) {
    const assets = sizeItems(desktop?.[platform], platform + ' desktop');
    const large = assets.filter(item => item.bytes > PUBLICATION_LIMITS.releaseAssetBytes);
    if (large.length > 0) {
      throw new Error('Desktop download exceeds ' + PUBLICATION_LIMITS.releaseAssetBytes + ' bytes: ' + large.map(item => item.path).join(', '));
    }
    desktopSizes[platform] = summary(assets);
  }
  const whole = summary(web);
  return { limits: { ...PUBLICATION_LIMITS },
    web: { ...whole, headroomBytes: PUBLICATION_LIMITS.pagesFileBytes - whole.largest.bytes,
      fileHeadroom: PUBLICATION_LIMITS.pagesFiles - whole.files,
      categories: Object.fromEntries(Object.keys(categories).sort(compare).map(name => [name, summary(categories[name])])) },
    desktop: desktopSizes };
}

/** Read Pages `_headers` blocks: an unindented URL pattern followed by indented `Name: value` lines. */
function headerBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(raw)) { current = { pattern: raw.trim(), headers: [] }; blocks.push(current); continue; }
    const match = /^\s+([^:\s]+)\s*:\s*(.*)$/u.exec(raw);
    if (current === null || match === null) throw new Error('Invalid deployment header line: ' + raw.trim());
    current.headers.push({ name: match[1].toLowerCase(), value: match[2].trim() });
  }
  return blocks;
}
function patternMatches(pattern, path) {
  if (!pattern.startsWith('/')) return false;
  const expression = pattern.split(/(\*|:[A-Za-z]\w*)/u).map(part => part === '*' ? '.*'
    : part.startsWith(':') && part.length > 1 ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('');
  return new RegExp('^' + expression + '$', 'u').test(path);
}
/** The compressed kernel must reach the loader as-is: octet-stream, never a Content-Encoding that decodes it on the way. */
export function checkKernelDeliveryHeaders(headersBytes, files) {
  const blocks = headerBlocks(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(headersBytes));
  for (const path of ['/' + OCCT_MANIFEST, ...files.map(file => '/' + file)]) {
    const applied = blocks.filter(block => patternMatches(block.pattern, path)).flatMap(block => block.headers);
    if (applied.some(header => header.name === 'content-encoding')) {
      throw new Error('Deployment headers set Content-Encoding for ' + path + ' (the kernel would be decoded twice)');
    }
    if (path === '/' + OCCT_MANIFEST) continue;
    const types = applied.filter(header => header.name === 'content-type').map(header => header.value.toLowerCase());
    if (types.length === 0 || types.at(-1) !== 'application/octet-stream') {
      throw new Error('Deployment headers must serve ' + path + ' as application/octet-stream');
    }
  }
}

/** Mirrors parseOcctAssetManifest (packages/kernel/src/occt/occtAssetManifest.ts), which the browser uses. */
function readOcctManifest(bytes) {
  const value = parse(bytes, OCCT_MANIFEST);
  if (!record(value) || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0
    || typeof value.sha256 !== 'string' || !HASH.test(value.sha256) || value.compression !== 'gzip'
    || !Array.isArray(value.parts) || value.parts.length === 0) throw new Error('Invalid ' + OCCT_MANIFEST);
  value.parts.forEach((part, index) => {
    if (!record(part) || part.order !== index || typeof part.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(part.file)
      || !Number.isSafeInteger(part.byteLength) || part.byteLength <= 0) throw new Error('Invalid OCCT part record: ' + index);
  });
  return value;
}

/**
 * Restore the kernel exactly like the Web loader (explicit gzip, parts in order) and compare it with the recorded
 * size and hash. Truncated or corrupt parts, a part that is not gzip (already decoded, e.g. by a Content-Encoding),
 * and a part compressed twice are each refused with their own reason.
 */
export function restoreOcctKernel(web) {
  const manifestBytes = web.get(OCCT_MANIFEST);
  if (manifestBytes === undefined) throw new Error('Missing Web kernel asset: ' + OCCT_MANIFEST);
  const manifest = readOcctManifest(manifestBytes);
  const parts = [], restored = [];
  let restoredBytes = 0;
  for (const part of manifest.parts) {
    const path = 'occt/' + part.file, bytes = web.get(path);
    if (bytes === undefined) throw new Error('Missing Web kernel asset: ' + path);
    if (bytes.length !== part.byteLength) throw new Error('OCCT part size differs: ' + path + ' ' + bytes.length + ' != ' + part.byteLength);
    if (!startsWith(bytes, GZIP_MAGIC)) throw new Error('OCCT part is not gzip (already decoded or re-encoded): ' + path);
    let output;
    try { output = gunzipSync(bytes, { maxOutputLength: manifest.byteLength - restoredBytes }); }
    catch (error) { throw new Error('OCCT part cannot be restored (truncated, corrupt or larger than recorded): ' + path, { cause: error }); }
    restoredBytes += output.length; restored.push(output); parts.push(fileRecord(path, bytes));
  }
  const wasm = Buffer.concat(restored);
  if (startsWith(wasm, GZIP_MAGIC)) throw new Error('OCCT kernel was compressed twice');
  if (!startsWith(wasm, WASM_MAGIC)) throw new Error('Restored OCCT kernel is not WebAssembly');
  if (wasm.length !== manifest.byteLength) throw new Error('Restored OCCT kernel size differs: ' + wasm.length + ' != ' + manifest.byteLength);
  const digest = sha256(wasm);
  if (digest !== manifest.sha256) throw new Error('Restored OCCT kernel hash differs from ' + OCCT_MANIFEST);
  return { manifest: fileRecord(OCCT_MANIFEST, manifestBytes), compression: 'gzip', parts,
    restored: { bytes: wasm.length, sha256: digest } };
}

function onlyFile(files, pattern, label) {
  const found = files.filter(file => typeof pattern === 'string' ? file.path === pattern : pattern.test(file.path));
  if (found.length !== 1) throw new Error((found.length === 0 ? 'Missing ' : 'Ambiguous ') + label);
  return found[0];
}
function runtimeVersions(sbom) {
  const versions = {};
  for (const name of PUBLICATION_RUNTIMES) {
    const found = [];
    for (const component of sbom.components) {
      if (!record(component) || typeof component.name !== 'string') continue;
      if (component.name === name && typeof component.version === 'string' && component.version !== '') found.push(component.version);
      else if (component.name.startsWith(name + ' ') && /^\S+$/u.test(component.name.slice(name.length + 1))) {
        found.push(component.name.slice(name.length + 1));
      }
    }
    if (found.length !== 1) throw new Error((found.length === 0 ? 'Missing' : 'Ambiguous') + ' SBOM runtime version: ' + name);
    versions[name] = found[0];
  }
  return versions;
}

/**
 * inputs.release: the same ReleaseManifestInput build-release-manifest.mjs used (candidates, Web files, current
 * sources). releaseManifestBytes/sbomBytes/captureRegistryBytes: the saved files, bound by their exact bytes.
 */
export async function createPublicationManifest({ release, releaseManifestBytes, sbomBytes, captureRegistryBytes }) {
  const saved = parse(releaseManifestBytes, 'release-manifest.json');
  if (!record(release)) throw new Error('Missing release inputs');
  const releaseManifest = await verifyReleaseManifest(saved, { ...release, tag: release.tag ?? null });

  const sbom = parse(sbomBytes, 'sbom.json');
  if (!record(sbom) || sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0
    || typeof sbom.serialNumber !== 'string') throw new Error('Invalid sbom.json');
  if (sbom.metadata?.component?.version !== releaseManifest.version) throw new Error('SBOM version differs from release');
  const sbomCommit = (Array.isArray(sbom.metadata?.properties) ? sbom.metadata.properties : [])
    .filter(property => property?.name === 'pointercad:sourceCommit').map(property => property.value);
  if (sbomCommit.length !== 1 || sbomCommit[0] !== releaseManifest.sourceCommit) throw new Error('SBOM commit differs from release');
  assertSbomPublishable(sbom);
  assertSbomMatchesReleaseManifest(sbom, releaseManifest);
  const sbomFiles = matchSbomToReleaseManifest(sbom, releaseManifest).checked;

  const registry = parse(captureRegistryBytes, CAPTURE_REGISTRY_FILE);
  if (!record(registry) || registry.format !== CAPTURE_REGISTRY_FORMAT) throw new Error('Invalid ' + CAPTURE_REGISTRY_FILE);

  const web = new Map();
  for (const file of release.webFiles) { offlineAssetUrl(file.path); web.set(file.path, file.bytes); }
  const webList = [...web].map(([path, bytes]) => ({ path, bytes }));
  const occt = restoreOcctKernel(web);
  const headers = web.get('_headers');
  if (headers === undefined) throw new Error('Missing Web deployment headers: _headers');
  checkKernelDeliveryHeaders(headers, occt.parts.map(part => part.path));
  const exactMath = onlyFile(webList, EXACT_MATH_WASM, 'Web exact-math runtime: ' + EXACT_MATH_WASM);
  const scriptVm = onlyFile(webList, SCRIPT_VM_WASM, 'Web script runtime (assets/quickjs-pcad-*.wasm)');
  for (const [label, file] of [['exact-math runtime', exactMath], ['script runtime', scriptVm]]) {
    if (!startsWith(file.bytes, WASM_MAGIC)) throw new Error('Web ' + label + ' is not WebAssembly: ' + file.path);
  }
  const fonts = webList.filter(file => FONT_FILE.test(file.path));
  if (fonts.length === 0) throw new Error('Missing Web font files');
  for (const volume of releaseManifest.manual.volumes) {
    if (!web.has(volume.pdf) || !web.has(volume.html)) throw new Error('Missing manual volume: ' + volume.id);
  }
  if (webList.filter(file => publicationCategory(file.path) === 'manual-pdf').length !== releaseManifest.manual.pdfVolumes) {
    throw new Error('Manual PDF files differ from the recorded volumes');
  }

  // The same kernel and virtual machines must reach both channels: Web restores what the desktop ships unpacked.
  for (const candidate of release.candidates) {
    const platform = parse(candidate.receiptBytes, 'candidate.json').platform;
    const staged = candidate.stagedFiles.map(file => ({ path: file.path, bytes: file.bytes }));
    if (sha256(onlyFile(staged, DESKTOP_OCCT_WASM, platform + ' desktop OCCT kernel').bytes) !== occt.restored.sha256) {
      throw new Error('Restored Web OCCT kernel differs from the ' + platform + ' desktop kernel');
    }
    if (sha256(onlyFile(staged, DESKTOP_EXACT_MATH_WASM, platform + ' desktop exact-math runtime').bytes) !== sha256(exactMath.bytes)) {
      throw new Error('Web exact-math runtime differs from the ' + platform + ' desktop runtime');
    }
    if (sha256(onlyFile(staged, DESKTOP_SCRIPT_VM_WASM, platform + ' desktop script runtime').bytes) !== sha256(scriptVm.bytes)) {
      throw new Error('Web script runtime differs from the ' + platform + ' desktop runtime');
    }
  }

  const need = path => { const bytes = web.get(path); if (bytes === undefined) throw new Error('Missing Web file: ' + path); return sha256(bytes); };
  const sizes = measurePublicationSizes(releaseManifest.web.files,
    { windows: releaseManifest.desktop.windows.assets, linux: releaseManifest.desktop.linux.assets });
  return {
    format: PUBLICATION_FORMAT, version: releaseManifest.version, tag: releaseManifest.tag, sourceCommit: releaseManifest.sourceCommit,
    releaseCertified: false, targets: [...releaseManifest.targets],
    records: {
      releaseManifest: { format: releaseManifest.format, sha256: sha256(releaseManifestBytes) },
      sbom: { format: 'CycloneDX', sha256: sha256(sbomBytes), serialNumber: sbom.serialNumber,
        components: sbom.components.length, distributedFilesChecked: sbomFiles },
      captureRegistry: { path: CAPTURE_REGISTRY_PATH, sha256: sha256(captureRegistryBytes) },
      desktop: { windows: releaseManifest.desktop.windows.candidateSha256, linux: releaseManifest.desktop.linux.candidateSha256 },
      web: { buildId: releaseManifest.web.buildId, webBuildSha256: releaseManifest.web.webBuildSha256,
        offlineAssetsSha256: releaseManifest.web.offlineAssetsSha256, serviceWorkerSha256: need('service-worker.js'),
        headersSha256: need('_headers') },
      manual: { buildId: releaseManifest.manual.buildId, pdfVolumes: releaseManifest.manual.pdfVolumes,
        manifestSha256: need('manual/manifest.json'), pdfManifestSha256: need('manual/pdf/pdf-manifest.json') },
    },
    versions: runtimeVersions(sbom),
    runtimes: {
      occt,
      exactMath: fileRecord(exactMath.path, exactMath.bytes),
      scriptVm: fileRecord(scriptVm.path, scriptVm.bytes),
      fonts: fonts.map(file => fileRecord(file.path, file.bytes)).sort((a, b) => compare(a.path, b.path)),
    },
    sizes,
  };
}

/** Recompute from the saved records and the distributed bytes; any difference refuses the saved publication manifest. */
export async function verifyPublicationManifest(manifest, inputs) {
  const expected = await createPublicationManifest(inputs);
  if (!equal(manifest, expected)) throw new Error('Publication manifest differs from distribution records');
  return expected;
}
