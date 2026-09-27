/**
 * One registry for every help image: its SHA-256, screen size and recorded capture provenance
 * (script, fixture hash, capture time, application build), or an explicit reason why a value is unknown.
 *
 * The registry is `capture-manifest.json` itself. Its former array entries are kept verbatim as
 * `capture-manifest` records; the capture records `*-capture-details.json` and `*-image-sources.json`
 * are only read. `node scripts/manual/captureRegistry.mjs register` rebuilds the registry from those
 * records and the actual images (adding unregistered images); `check` compares without writing.
 */
import { createHash } from 'node:crypto';
import { log } from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureWebBuildSources } from '../vite/webBuildSources.mjs';

export const CAPTURE_REGISTRY_FORMAT = 'pointercad-capture-registry/1';
export const CAPTURE_CHAPTER_FOLDER = 'packages/help-content/docs/ja';
export const CAPTURE_IMAGE_FOLDER = 'packages/help-content/docs/ja/images';
export const CAPTURE_REGISTRY_FILE = 'capture-manifest.json';

const deepFreeze = value => {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

/** Coordinator decision of 2026-09-24: 1440×900 is standard; only tall screens such as dialogs may use 1440×1100. */
export const CAPTURE_VIEWPORT_POLICY = deepFreeze({
  standard: [1440, 900],
  tallException: [1440, 1100],
  rule: '1440×900 を標準とする。縦に長い画面（ダイアログ等）だけ 1440×1100 を例外として認める。それ以外の大きさは撮り直す。',
});

/** Why a provenance value is null. Stored in the registry so every null carries its reason. */
export const CAPTURE_UNKNOWN_REASONS = deepFreeze({
  'no-capture-record': '撮影の記録なし。撮影した台本・fixture・日時・版の来歴が残っていない。',
  'no-capture-time': '撮影の記録に撮影の日時の欄が無い。',
  'build-id-null': '撮影の記録の版の識別子（applicationBuildId）が null。撮影した版を記録する仕組みがまだ無い。',
  'legacy-no-hash': '旧形式の撮影記録（capture-manifest.json の配列の項目）に台本と fixture の SHA-256 の欄が無い。',
  'legacy-no-build-id': '旧形式の撮影記録（capture-manifest.json の配列の項目）に版の欄が無い。',
  'no-script-path': '撮影の記録に台本のパスが無い（Playwright の出力の場所だけが残っている）。',
  'image-source-no-hash': '画像の出所の記録（*-image-sources.json）に台本または fixture の SHA-256 が無い。',
  'image-source-no-build-id': '画像の出所の記録（*-image-sources.json）に版の識別子の欄が無い。',
});

const PROVENANCE_FIELDS = ['script', 'scriptSha256', 'fixtureSha256', 'capturedAt', 'applicationBuildId'];
const ENTRY_KEYS = ['file', 'sha256', 'viewport', 'viewportClass', 'viewportSource', ...PROVENANCE_FIELDS, 'unknown', 'records'];
const LEGACY_KEYS = ['file', 'testRun', 'testSource', 'viewport', 'sha256', 'kind', 'edited'];
const VIEWPORT_SOURCES = new Set(['capture-details', 'image-sources', 'capture-manifest', 'png-size']);
const DETAILS_FORMATS = new Set([1, 'pointercad-math-help-captures/1']);
const IMAGE_SOURCES_FORMAT = 'pointercad-manual-image-sources/1';
const SHA256 = /^[0-9a-f]{64}$/u;
/** Same image name rule as the manual generator (scripts/manual/generate.mjs). */
const IMAGE_NAME = /^[a-zA-Z0-9_-]+\.png$/u;
const IMAGE_LINK = /!\[[^\]]*\]\(([^\s)]+)\)/gu;
const CAPTURE_NAME = /^[a-z][a-z0-9-]*$/u;
const SCRIPT_PATH = /^e2e\/tests\/[A-Za-z0-9_.-]+\.ts$/u;
const DETAILS_FILE = /^[a-z0-9][a-z0-9-]*-capture-details\.json$/u;
const IMAGE_SOURCES_FILE = /^[a-z0-9][a-z0-9-]*-image-sources\.json$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Folder thumbnails the OS may create; .gitignore excludes them, so they are never part of the help. */
const OS_METADATA_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSha256 = value => typeof value === 'string' && SHA256.test(value);
const isPixelCount = value => Number.isInteger(value) && value > 0 && value <= 100_000;
const isSize = value => Array.isArray(value) && value.length === 2 && value.every(isPixelCount);
const isTimestamp = value => typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};
const sameSize = (left, right) => left[0] === right[0] && left[1] === right[1];
const utf8 = new globalThis.TextDecoder('utf-8', { fatal: true });

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * packages/help-content/docs/**: the manual's own chapter text and images (and capture-manifest.json
 * itself). Never the running application's own code or assets.
 */
const MANUAL_DOCS_PREFIX = 'packages/help-content/docs/';

/**
 * A stable fingerprint of the Web app's own build inputs, for `e2e/tests/captureManualDetail.ts` to
 * record as `applicationBuildId` (instead of a Git commit id: committing a new screenshot and its
 * capture record changes HEAD, which would immediately mark every previously captured image as
 * belonging to an "old" build again).
 *
 * Reuses `captureWebBuildSources` (scripts/vite/webBuildSources.mjs; the same Web input inventory
 * `scripts/release/build-web-offline.mjs` and `scripts/release/build-release-manifest.mjs` record),
 * minus everything under `packages/help-content/docs/` (the manual's own chapter text and images).
 * Excluding the manual's docs is required for the same reason a Git commit id does not work: without
 * it, registering a newly captured image (which edits files under
 * packages/help-content/docs/ja/images/ and capture-manifest.json) would change this digest and mark
 * every other already-registered image as stale again.
 *
 * The per-file digests come straight from `captureWebBuildSources` (unmodified); only the combining
 * step is this function's own, and it always joins with a single `'\n'` (never the host OS's line
 * separator), the same way Git's own plumbing commands (e.g. `git ls-files`) always emit LF-separated
 * output regardless of platform. That keeps the result identical across machines and checkouts.
 */
export async function applicationInputDigest(root) {
  const inputs = await captureWebBuildSources(root);
  const manifest = Object.entries(inputs)
    .filter(([path]) => !path.startsWith(MANUAL_DOCS_PREFIX))
    .sort(([left], [right]) => compare(left, right))
    .map(([path, digest]) => `${path} ${digest}`)
    .join('\n');
  return sha256Hex(new globalThis.TextEncoder().encode(manifest));
}

export class CaptureRegistryError extends Error {
  constructor(problems) {
    super(`Capture registry problems (${problems.length}):\n- ${problems.join('\n- ')}`);
    this.name = 'CaptureRegistryError';
    this.problems = Object.freeze([...problems]);
  }
}

/** Pixel width and height from the PNG header (IHDR). */
export function readPngSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error('Not a PNG image');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new Error('PNG header is missing');
  const size = [view.getUint32(16), view.getUint32(20)];
  if (!isSize(size)) throw new Error('PNG size is out of range');
  return size;
}

export function classifyCaptureViewport(viewport) {
  if (sameSize(viewport, CAPTURE_VIEWPORT_POLICY.standard)) return 'standard';
  if (sameSize(viewport, CAPTURE_VIEWPORT_POLICY.tallException)) return 'tall-exception';
  return 'needs-recapture';
}

/** Image name → chapters that show it. Accepts `images/x.png` and `./images/x.png`, like the manual generator. */
export function collectChapterImageReferences(chapters) {
  const references = new Map();
  for (const { name, text } of chapters) {
    for (const match of text.matchAll(IMAGE_LINK)) {
      const target = match[1].replace(/^\.\//u, '');
      const image = target.startsWith('images/') ? target.slice('images/'.length) : '';
      if (!IMAGE_NAME.test(image)) throw new Error(`Unsupported chapter image link in ${name}: ${match[1]}`);
      const shownIn = references.get(image) ?? [];
      if (!shownIn.includes(name)) shownIn.push(name);
      references.set(image, shownIn);
    }
  }
  return new Map([...references].sort(([left], [right]) => compare(left, right)));
}

function parseJson(name, bytes, problems) {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch (error) {
    problems.push(`${name}: unreadable JSON (${error.message})`);
    return undefined;
  }
}

const describeRef = ref => (ref.kind === 'capture-details' ? `${ref.file} (${ref.name})` : `${ref.file} (${ref.image})`);

/** The screen, script, fixture and build fields written by e2e/tests/captureManualDetail.ts. */
function readManualDetailCapture(capture, where, problems) {
  if (!isObject(capture) || capture.format !== 'pointercad-manual-detail/1') {
    problems.push(`${where}: not a pointercad-manual-detail/1 capture`);
    return null;
  }
  const state = capture.screenState;
  if (!isObject(state) || !isSize([state.width, state.height]) || state.deviceScaleFactor !== 1) {
    problems.push(`${where}: the screen size at scale 1 is not recorded`);
    return null;
  }
  if (!isSha256(capture.scriptSha256) || !isObject(capture.fixture) || !isSha256(capture.fixture.sha256)) {
    problems.push(`${where}: the script or fixture SHA-256 is not recorded`);
    return null;
  }
  const build = capture.applicationBuildId;
  if (build !== null && (typeof build !== 'string' || build.trim() === '')) {
    problems.push(`${where}: invalid applicationBuildId`);
    return null;
  }
  if (capture.capturedAt !== undefined && !isTimestamp(capture.capturedAt)) {
    problems.push(`${where}: invalid capturedAt`);
    return null;
  }
  return {
    viewport: [state.width, state.height], scriptSha256: capture.scriptSha256, fixtureSha256: capture.fixture.sha256,
    capturedAt: capture.capturedAt ?? null, applicationBuildId: build,
    reasons: { capturedAt: 'no-capture-time', applicationBuildId: 'build-id-null' },
  };
}

function readCaptureDetails(file, json, problems) {
  const records = [];
  if (!isObject(json) || !DETAILS_FORMATS.has(json.format) || !Array.isArray(json.captures) || json.captures.length === 0) {
    problems.push(`${file}: unsupported capture details`);
    return records;
  }
  json.captures.forEach((entry, index) => {
    const where = `${file} captures[${index}]`;
    if (!isObject(entry) || typeof entry.name !== 'string' || !CAPTURE_NAME.test(entry.name)
      || typeof entry.script !== 'string' || !SCRIPT_PATH.test(entry.script)) {
      problems.push(`${where}: the capture name or script is not recorded`);
      return;
    }
    const selected = entry.selectedImage ?? 'detail';
    if (selected !== 'detail' && selected !== 'screen') {
      problems.push(`${where}: unsupported selectedImage`);
      return;
    }
    const capture = readManualDetailCapture(entry.capture, where, problems);
    if (capture === null) return;
    const image = entry.capture[selected];
    if (!isObject(image) || image.filename !== `${entry.name}-${selected}.png` || !isSha256(image.sha256)) {
      problems.push(`${where}: the adopted ${selected} image is not recorded`);
      return;
    }
    records.push({ ...capture, image: image.filename, sha256: image.sha256, script: entry.script,
      ref: { kind: 'capture-details', file, name: entry.name, image: selected } });
  });
  return records;
}

function readImageSources(file, json, problems) {
  const records = [];
  const withoutCapture = { viewport: null, script: null, scriptSha256: null, fixtureSha256: null, capturedAt: null,
    applicationBuildId: null, reasons: { script: 'no-script-path', scriptSha256: 'image-source-no-hash',
      fixtureSha256: 'image-source-no-hash', capturedAt: 'no-capture-time', applicationBuildId: 'image-source-no-build-id' } };
  const ref = image => ({ kind: 'image-sources', file, image });
  if (Array.isArray(json)) {
    // Adopted images renamed from a test result; a copied capture.json sidecar may hold the screen record.
    json.forEach((entry, index) => {
      const where = `${file}[${index}]`;
      if (!isObject(entry) || typeof entry.image !== 'string' || !IMAGE_NAME.test(entry.image) || !isSha256(entry.sha256)
        || !isObject(entry.sidecars)) {
        problems.push(`${where}: the image or its SHA-256 is not recorded`);
        return;
      }
      const sidecar = entry.sidecars['-capture.json'];
      if (sidecar === undefined) {
        records.push({ ...withoutCapture, image: entry.image, sha256: entry.sha256, ref: ref(entry.image) });
        return;
      }
      const capture = readManualDetailCapture(sidecar, where, problems);
      if (capture === null) return;
      if (![sidecar.detail, sidecar.screen].some(part => isObject(part) && part.sha256 === entry.sha256)) {
        problems.push(`${where}: the capture sidecar does not describe ${entry.image}`);
        return;
      }
      records.push({ ...capture, script: null, reasons: { ...capture.reasons, script: 'no-script-path' },
        image: entry.image, sha256: entry.sha256, ref: ref(entry.image) });
    });
    return records;
  }
  if (!isObject(json) || json.format !== IMAGE_SOURCES_FORMAT || !Array.isArray(json.images)) {
    problems.push(`${file}: unsupported image sources`);
    return records;
  }
  json.images.forEach((entry, index) => {
    const where = `${file} images[${index}]`;
    if (!isObject(entry) || typeof entry.filename !== 'string' || !IMAGE_NAME.test(entry.filename) || !isSha256(entry.sha256)
      || (entry.fixtureSha256 !== undefined && !isSha256(entry.fixtureSha256))) {
      problems.push(`${where}: the image or its SHA-256 is not recorded`);
      return;
    }
    // A reason is only consulted for a null value, so a recorded fixture hash simply replaces the null.
    records.push({ ...withoutCapture, fixtureSha256: entry.fixtureSha256 ?? null, image: entry.filename, sha256: entry.sha256,
      ref: ref(entry.filename) });
  });
  return records;
}

function validateLegacyEntry(value, where, problems) {
  if (!isObject(value) || !hasExactKeys(value, LEGACY_KEYS) || typeof value.file !== 'string' || !IMAGE_NAME.test(value.file)
    || typeof value.testRun !== 'string' || value.testRun === '' || typeof value.testSource !== 'string'
    || !SCRIPT_PATH.test(value.testSource) || !isSize(value.viewport) || !isSha256(value.sha256)
    || typeof value.kind !== 'string' || value.kind === '' || typeof value.edited !== 'boolean') {
    problems.push(`${where}: invalid capture-manifest entry`);
    return null;
  }
  // Rebuilt in a fixed key order so the stored copy stays canonical.
  return { file: value.file, testRun: value.testRun, testSource: value.testSource, viewport: [...value.viewport],
    sha256: value.sha256, kind: value.kind, edited: value.edited };
}

function validateRecordRef(ref, entry, where, problems) {
  if (!isObject(ref)) {
    problems.push(`${where}: invalid record`);
    return;
  }
  if (ref.kind === 'capture-details') {
    if (!hasExactKeys(ref, ['kind', 'file', 'name', 'image']) || typeof ref.file !== 'string' || !DETAILS_FILE.test(ref.file)
      || typeof ref.name !== 'string' || !CAPTURE_NAME.test(ref.name) || (ref.image !== 'detail' && ref.image !== 'screen')
      || `${ref.name}-${ref.image}.png` !== entry.file) problems.push(`${where}: invalid capture-details record`);
  } else if (ref.kind === 'image-sources') {
    if (!hasExactKeys(ref, ['kind', 'file', 'image']) || typeof ref.file !== 'string' || !IMAGE_SOURCES_FILE.test(ref.file)
      || ref.image !== entry.file) problems.push(`${where}: invalid image-sources record`);
  } else if (ref.kind === 'capture-manifest') {
    const legacy = hasExactKeys(ref, ['kind', 'entry']) ? validateLegacyEntry(ref.entry, where, problems) : null;
    if (legacy === null || legacy.file !== entry.file || legacy.sha256 !== entry.sha256) {
      problems.push(`${where}: the capture-manifest record does not describe this image`);
    }
  } else {
    problems.push(`${where}: unknown record kind`);
  }
}

function validateEntry(entry, where, problems) {
  if (!isObject(entry) || !hasExactKeys(entry, ENTRY_KEYS)) {
    problems.push(`${where}: registry entries must have exactly ${ENTRY_KEYS.join(', ')}`);
    return;
  }
  if (typeof entry.file !== 'string' || !IMAGE_NAME.test(entry.file)) problems.push(`${where}: invalid file`);
  if (!isSha256(entry.sha256)) problems.push(`${where}: invalid sha256`);
  if (!isSize(entry.viewport)) problems.push(`${where}: the screen size is missing`);
  else if (entry.viewportClass !== classifyCaptureViewport(entry.viewport)) problems.push(`${where}: wrong viewportClass`);
  if (!VIEWPORT_SOURCES.has(entry.viewportSource)) problems.push(`${where}: invalid viewportSource`);
  if (entry.script !== null && (typeof entry.script !== 'string' || !SCRIPT_PATH.test(entry.script))) problems.push(`${where}: invalid script`);
  for (const field of ['scriptSha256', 'fixtureSha256']) {
    if (entry[field] !== null && !isSha256(entry[field])) problems.push(`${where}: invalid ${field}`);
  }
  if (entry.capturedAt !== null && !isTimestamp(entry.capturedAt)) problems.push(`${where}: invalid capturedAt`);
  if (entry.applicationBuildId !== null && (typeof entry.applicationBuildId !== 'string' || entry.applicationBuildId.trim() === '')) {
    problems.push(`${where}: invalid applicationBuildId`);
  }
  // Every null provenance value carries exactly one known reason, and nothing else does.
  const unknownFields = PROVENANCE_FIELDS.filter(field => entry[field] === null);
  if (!isObject(entry.unknown) || !hasExactKeys(entry.unknown, unknownFields)
    || !unknownFields.every(field => Object.hasOwn(CAPTURE_UNKNOWN_REASONS, entry.unknown[field]))) {
    problems.push(`${where}: every null value needs one known reason in unknown`);
  }
  if (!Array.isArray(entry.records)) {
    problems.push(`${where}: records must be a list`);
    return;
  }
  entry.records.forEach((ref, index) => validateRecordRef(ref, entry, `${where} records[${index}]`, problems));
  const kinds = entry.records.map(ref => (isObject(ref) ? ref.kind : undefined));
  const primary = kinds.filter(kind => kind === 'capture-details' || kind === 'image-sources').length;
  const manifest = kinds.filter(kind => kind === 'capture-manifest').length;
  if (primary > 1 || manifest > 1 || (primary === 1 && kinds[0] === 'capture-manifest')) {
    problems.push(`${where}: at most one capture record, listed before the capture-manifest record`);
  }
  if (entry.viewportSource !== 'png-size' && !kinds.includes(entry.viewportSource)) {
    problems.push(`${where}: the screen size source is not among the records`);
  }
  const unrecorded = entry.records.length === 0;
  if (unrecorded !== Object.values(isObject(entry.unknown) ? entry.unknown : {}).includes('no-capture-record')
    || (unrecorded && !(unknownFields.length === PROVENANCE_FIELDS.length
      && unknownFields.every(field => entry.unknown[field] === 'no-capture-record')))) {
    problems.push(`${where}: no-capture-record is used exactly for images without any capture record`);
  }
}

/** Validate an already parsed registry object; throws CaptureRegistryError listing every problem. */
export function validateCaptureRegistry(value) {
  const problems = [];
  if (!isObject(value) || !hasExactKeys(value, ['format', 'viewportPolicy', 'unknownReasons', 'images'])
    || value.format !== CAPTURE_REGISTRY_FORMAT) {
    throw new CaptureRegistryError([`The registry must be a ${CAPTURE_REGISTRY_FORMAT} object`]);
  }
  if (JSON.stringify(value.viewportPolicy) !== JSON.stringify(CAPTURE_VIEWPORT_POLICY)) {
    problems.push('viewportPolicy differs from the decided policy in captureRegistry.mjs');
  }
  if (JSON.stringify(value.unknownReasons) !== JSON.stringify(CAPTURE_UNKNOWN_REASONS)) {
    problems.push('unknownReasons differ from captureRegistry.mjs');
  }
  if (!Array.isArray(value.images)) problems.push('images must be a list');
  else {
    value.images.forEach((entry, index) => validateEntry(entry, `images[${index}]`, problems));
    for (let index = 1; index < value.images.length; index += 1) {
      if (!(compare(value.images[index - 1]?.file, value.images[index]?.file) < 0)) {
        problems.push(`images must be sorted by file without duplicates: ${String(value.images[index]?.file)}`);
      }
    }
  }
  if (problems.length > 0) throw new CaptureRegistryError(problems);
  return value;
}

export function parseCaptureRegistry(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CaptureRegistryError([`${CAPTURE_REGISTRY_FILE}: unreadable JSON (${error.message})`]);
  }
  return validateCaptureRegistry(value);
}

/** file → { sha256, legacy } from either the former array or the current registry. */
function readPreviousRegistry(bytes, problems) {
  const previous = new Map();
  const json = parseJson(CAPTURE_REGISTRY_FILE, bytes, problems);
  if (json === undefined) return previous;
  if (Array.isArray(json)) {
    json.forEach((value, index) => {
      const legacy = validateLegacyEntry(value, `${CAPTURE_REGISTRY_FILE}[${index}]`, problems);
      if (legacy === null) return;
      if (previous.has(legacy.file)) problems.push(`${CAPTURE_REGISTRY_FILE}: duplicate entry ${legacy.file}`);
      else previous.set(legacy.file, { sha256: legacy.sha256, legacy });
    });
    return previous;
  }
  try {
    for (const entry of validateCaptureRegistry(json).images) {
      const legacy = entry.records.find(ref => ref.kind === 'capture-manifest')?.entry;
      previous.set(entry.file, { sha256: entry.sha256, legacy: legacy === undefined ? null : validateLegacyEntry(legacy, entry.file, problems) });
    }
  } catch (error) {
    if (!(error instanceof CaptureRegistryError)) throw error;
    problems.push(...error.problems.map(problem => `${CAPTURE_REGISTRY_FILE}: ${problem}`));
  }
  return previous;
}

function makeEntry(file, image, record, legacy) {
  const unrecorded = record === null && legacy === null;
  const source = record ?? (legacy === null ? null : {
    viewport: legacy.viewport, script: legacy.testSource, scriptSha256: null, fixtureSha256: null, capturedAt: null,
    applicationBuildId: null, reasons: { scriptSha256: 'legacy-no-hash', fixtureSha256: 'legacy-no-hash',
      capturedAt: 'no-capture-time', applicationBuildId: 'legacy-no-build-id' },
  });
  let viewport = image.size, viewportSource = 'png-size';
  if (record?.viewport) [viewport, viewportSource] = [record.viewport, record.ref.kind];
  else if (legacy !== null) [viewport, viewportSource] = [legacy.viewport, 'capture-manifest'];
  const values = {
    script: source?.script ?? legacy?.testSource ?? null, scriptSha256: source?.scriptSha256 ?? null,
    fixtureSha256: source?.fixtureSha256 ?? null, capturedAt: source?.capturedAt ?? null,
    applicationBuildId: source?.applicationBuildId ?? null,
  };
  const unknown = {};
  for (const field of PROVENANCE_FIELDS) {
    if (values[field] === null) unknown[field] = unrecorded ? 'no-capture-record' : source.reasons[field];
  }
  return {
    file, sha256: image.sha256, viewport: [...viewport], viewportClass: classifyCaptureViewport(viewport), viewportSource,
    ...values, unknown,
    records: [...(record === null ? [] : [record.ref]), ...(legacy === null ? [] : [{ kind: 'capture-manifest', entry: legacy }])],
  };
}

/**
 * Build the registry from every file of the image folder: PNG images, capture records and the current
 * registry (former array or registry object). Throws CaptureRegistryError instead of guessing.
 */
export function buildCaptureRegistry(files) {
  const problems = [], images = new Map(), details = [], sources = [], names = new Set();
  let registryBytes = null;
  for (const { name, bytes } of files) {
    if (names.has(name)) {
      problems.push(`Duplicate file: ${name}`);
      continue;
    }
    names.add(name);
    if (name === CAPTURE_REGISTRY_FILE) registryBytes = bytes;
    else if (IMAGE_NAME.test(name)) {
      try {
        images.set(name, { sha256: sha256Hex(bytes), size: readPngSize(bytes) });
      } catch (error) {
        problems.push(`${name}: ${error.message}`);
      }
    } else if (DETAILS_FILE.test(name)) details.push({ name, bytes });
    else if (IMAGE_SOURCES_FILE.test(name)) sources.push({ name, bytes });
    else problems.push(`Unexpected file in the capture image folder: ${name}`);
  }
  // Each capture record vouches for the exact bytes of one adopted image.
  const recorded = new Map();
  const addRecords = records => {
    for (const record of records) {
      const other = recorded.get(record.image);
      if (other === undefined) recorded.set(record.image, record);
      else problems.push(`Several capture records name ${record.image}: ${describeRef(other.ref)} and ${describeRef(record.ref)}`);
    }
  };
  for (const { name, bytes } of details) {
    const json = parseJson(name, bytes, problems);
    if (json !== undefined) addRecords(readCaptureDetails(name, json, problems));
  }
  for (const { name, bytes } of sources) {
    const json = parseJson(name, bytes, problems);
    if (json !== undefined) addRecords(readImageSources(name, json, problems));
  }
  for (const [name, record] of recorded) {
    const image = images.get(name);
    if (image === undefined) problems.push(`${describeRef(record.ref)} names a missing image ${name}`);
    else if (image.sha256 !== record.sha256) problems.push(`${describeRef(record.ref)} does not match the bytes of ${name}`);
  }
  const previous = registryBytes === null ? new Map() : readPreviousRegistry(registryBytes, problems);
  for (const name of previous.keys()) {
    if (!images.has(name)) problems.push(`Registered image is missing: ${name} (restore it or remove its registry entry)`);
  }
  const entries = [];
  for (const name of [...images.keys()].sort(compare)) {
    const image = images.get(name), record = recorded.get(name) ?? null, before = previous.get(name);
    if (record === null && before !== undefined && before.sha256 !== image.sha256) {
      problems.push(`${name} changed after registration without a capture record for the new bytes`);
      continue;
    }
    // A former manifest entry describes the image only while its bytes are unchanged.
    const legacy = before?.legacy && before.legacy.sha256 === image.sha256 ? before.legacy : null;
    if (record !== null && legacy !== null) {
      if (record.viewport !== null && !sameSize(record.viewport, legacy.viewport)) {
        problems.push(`Capture records disagree on the screen size of ${name}`);
      }
      if (record.script !== null && record.script !== legacy.testSource) problems.push(`Capture records disagree on the script of ${name}`);
    }
    entries.push(makeEntry(name, image, record, legacy));
  }
  if (problems.length > 0) throw new CaptureRegistryError(problems);
  return validateCaptureRegistry(JSON.parse(JSON.stringify({ format: CAPTURE_REGISTRY_FORMAT,
    viewportPolicy: CAPTURE_VIEWPORT_POLICY, unknownReasons: CAPTURE_UNKNOWN_REASONS, images: entries })));
}

/** Compare the registry with the actual images and the chapters' image links. Reports; never throws for findings. */
export function auditCaptureRegistry(registry, { files, chapters }) {
  const actual = new Map(files.filter(({ name }) => IMAGE_NAME.test(name)).map(({ name, bytes }) => [name, bytes]));
  const names = [...actual.keys()].sort(compare);
  const references = collectChapterImageReferences(chapters);
  const entries = new Map(registry.images.map(entry => [entry.file, entry]));
  const shaMismatches = [], pixelConflicts = [];
  for (const entry of registry.images) {
    const bytes = actual.get(entry.file);
    if (bytes === undefined) continue;
    const sha256 = sha256Hex(bytes);
    if (sha256 !== entry.sha256) shaMismatches.push({ file: entry.file, registered: entry.sha256, actual: sha256 });
    let pixels;
    try {
      pixels = readPngSize(bytes);
    } catch {
      pixels = null;
    }
    // A capture is the whole screen or a part of it; a size taken from the pixels must be exact.
    if (pixels === null || pixels[0] > entry.viewport[0] || pixels[1] > entry.viewport[1]
      || (entry.viewportSource === 'png-size' && !sameSize(pixels, entry.viewport))) {
      pixelConflicts.push({ file: entry.file, pixels, viewport: entry.viewport });
    }
  }
  const count = values => Object.fromEntries([...values.reduce((totals, value) => totals.set(value, (totals.get(value) ?? 0) + 1),
    new Map())].sort(([left], [right]) => compare(left, right)));
  return {
    images: names.length, registered: registry.images.length, referenced: references.size,
    unregistered: names.filter(name => !entries.has(name)),
    missingImages: registry.images.map(entry => entry.file).filter(name => !actual.has(name)),
    shaMismatches, pixelConflicts,
    missingReferencedImages: [...references].filter(([image]) => !actual.has(image)).map(([image, shownIn]) => ({ image, chapters: shownIn })),
    unreferenced: names.filter(name => !references.has(name)),
    viewportOutsidePolicy: registry.images.filter(entry => entry.viewportClass === 'needs-recapture').map(entry => entry.file),
    withoutCaptureRecord: registry.images.filter(entry => entry.records.length === 0).map(entry => entry.file),
    viewportClasses: count(registry.images.map(entry => entry.viewportClass)),
    viewportSources: count(registry.images.map(entry => entry.viewportSource)),
  };
}

/**
 * Release check of "images of the current version": every given image (bare file name → bytes) must be
 * registered with the same SHA-256 and captured from `applicationBuildId`; with `scripts` (path → bytes),
 * the recorded capture script must also be unchanged.
 */
export function assessCaptureImages(registry, images, { applicationBuildId, scripts } = {}) {
  if (typeof applicationBuildId !== 'string' || applicationBuildId.trim() === '') throw new Error('applicationBuildId is required');
  const entries = new Map(registry.images.map(entry => [entry.file, entry]));
  const report = { checked: 0, unregistered: [], mismatched: [], buildUnknown: [], buildMismatch: [], scriptChanged: [], scriptMissing: [] };
  const seen = new Set();
  for (const { name, bytes } of [...images].sort((left, right) => compare(left.name, right.name))) {
    if (seen.has(name)) throw new Error(`Duplicate image: ${name}`);
    seen.add(name);
    report.checked += 1;
    const entry = entries.get(name);
    if (entry === undefined) {
      report.unregistered.push(name);
      continue;
    }
    if (sha256Hex(bytes) !== entry.sha256) report.mismatched.push(name);
    if (entry.applicationBuildId === null) report.buildUnknown.push(name);
    else if (entry.applicationBuildId !== applicationBuildId) report.buildMismatch.push(name);
    if (scripts !== undefined && entry.script !== null && entry.scriptSha256 !== null) {
      const script = scripts.get(entry.script);
      if (script === undefined) report.scriptMissing.push(name);
      else if (sha256Hex(script) !== entry.scriptSha256) report.scriptChanged.push(name);
    }
  }
  const current = ['unregistered', 'mismatched', 'buildUnknown', 'buildMismatch', 'scriptChanged', 'scriptMissing']
    .every(key => report[key].length === 0);
  return { ...report, current };
}

/** Every file of the image folder and every chapter, read from the repository. */
export async function readCaptureFolder(root) {
  const imageFolder = join(root, CAPTURE_IMAGE_FOLDER), chapterFolder = join(root, CAPTURE_CHAPTER_FOLDER);
  const files = [], chapters = [];
  for (const entry of await readdir(imageFolder, { withFileTypes: true })) {
    if (OS_METADATA_FILES.has(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`The capture image folder must contain only plain files: ${entry.name}`);
    files.push({ name: entry.name, bytes: await readFile(join(imageFolder, entry.name)) });
  }
  for (const entry of await readdir(chapterFolder, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile()) throw new Error(`Chapters must be plain files: ${entry.name}`);
    chapters.push({ name: entry.name, text: await readFile(join(chapterFolder, entry.name), 'utf8') });
  }
  files.sort((left, right) => compare(left.name, right.name));
  chapters.sort((left, right) => compare(left.name, right.name));
  return { files, chapters };
}

export async function readCaptureRegistry(root) {
  return parseCaptureRegistry(await readFile(join(root, CAPTURE_IMAGE_FOLDER, CAPTURE_REGISTRY_FILE), 'utf8'));
}

/** Current bytes of the recorded capture scripts (for assessCaptureImages); absent scripts are left out. */
export async function readCaptureScripts(root, registry) {
  const scripts = new Map();
  for (const path of new Set(registry.images.map(entry => entry.script).filter(path => path !== null))) {
    try {
      scripts.set(path, await readFile(join(root, path)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return scripts;
}

/** JSON text of the registry; keeps CRLF line ends when the stored file already uses them. */
export function formatCaptureRegistry(registry, previousBytes = null) {
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  const crlf = previousBytes !== null && utf8.decode(previousBytes).includes('\r\n');
  return crlf ? text.replaceAll('\n', '\r\n') : text;
}

async function main(args) {
  const [command, ...extra] = args;
  if (extra.length > 0 || (command !== 'register' && command !== 'check')) {
    throw new Error('Usage: node scripts/manual/captureRegistry.mjs <register|check>');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const folder = await readCaptureFolder(root);
  const storedBytes = folder.files.find(file => file.name === CAPTURE_REGISTRY_FILE)?.bytes ?? null;
  const previousProblems = [];
  const previousFiles = storedBytes === null ? new Set() : new Set(readPreviousRegistry(storedBytes, previousProblems).keys());
  const registry = buildCaptureRegistry(folder.files);
  let stored;
  try {
    stored = storedBytes === null ? null : parseCaptureRegistry(utf8.decode(storedBytes));
  } catch {
    stored = null; // The former array or a broken file is reported as outdated below.
  }
  const upToDate = stored !== null && JSON.stringify(stored) === JSON.stringify(registry);
  // `check` audits the stored registry when it is valid; otherwise it shows what `register` would store.
  const audited = command === 'check' && stored !== null ? 'stored' : 'rebuilt';
  const audit = auditCaptureRegistry(audited === 'stored' ? stored : registry, folder);
  let written = false;
  if (command === 'register' && !upToDate) {
    const target = join(root, CAPTURE_IMAGE_FOLDER, CAPTURE_REGISTRY_FILE);
    const current = await readFile(target).catch(error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    if ((current === null) !== (storedBytes === null) || (current !== null && sha256Hex(current) !== sha256Hex(storedBytes))) {
      throw new Error(`${CAPTURE_REGISTRY_FILE} changed while registering; run the command again`);
    }
    await writeFile(target, formatCaptureRegistry(registry, storedBytes));
    written = true;
  }
  const failures = ['unregistered', 'missingImages', 'shaMismatches', 'pixelConflicts', 'missingReferencedImages']
    .filter(key => audit[key].length > 0);
  if (command === 'check' && !upToDate) failures.unshift('registryOutdated');
  log(JSON.stringify({
    command, registry: `${CAPTURE_IMAGE_FOLDER}/${CAPTURE_REGISTRY_FILE}`, written, upToDate: upToDate || written, audited,
    [command === 'register' ? 'added' : 'toAdd']: registry.images.map(entry => entry.file).filter(name => !previousFiles.has(name)),
    ...audit, failures,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath) {
  await main(process.argv.slice(2));
}
