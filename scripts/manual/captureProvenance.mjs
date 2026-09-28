/**
 * Adopt manual captures from one Playwright run into the help image folder, bundled into one provenance
 * record (plan P12-16): the application build, the SHA-256 of every capture script and, per image, the
 * capture record written by `e2e/tests/captureManualDetail.ts` with its fixture document.
 *
 * `plan` only reports what would change; `adopt` writes the images, the bundle
 * (`<bundle>-capture-details.json`, format CAPTURE_PROVENANCE_FORMAT), removes the replaced images from the
 * older capture records and rewrites `capture-manifest.json` — only after every check passed, in one go.
 * A capture is refused when its test failed, a file differs from its recorded SHA-256, it was taken from
 * another application build or with a since changed script, its screen is outside the fixed conditions,
 * the recompute or the 3D drawing had not finished, or no chapter shows the image.
 */
import { log } from 'node:console';
import { lstat, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  applicationInputDigest, auditCaptureRegistry, buildCaptureRegistry, CAPTURE_IMAGE_FOLDER, CAPTURE_PROVENANCE_FORMAT,
  CAPTURE_REGISTRY_FILE, collectChapterImageReferences, formatCaptureRegistry, inspectAdoptableCapture, readCaptureFolder, sha256Hex,
} from './captureRegistry.mjs';

/** What Playwright leaves in a test's output folder when the test failed (e2e/playwright.config.ts: screenshot/trace on failure). */
export const CAPTURE_FAILURE_ARTIFACT = /^(?:test-failed-\d+\.png|error-context\.md|trace\.zip)$/u;
/** Kept out of the bundle: the rendered control descriptions are a check of the test, not provenance, and large. */
const OMITTED_CAPTURE_KEYS = new Set(['controlDescriptions']);

const CAPTURE_RECORD = /^([a-z][a-z0-9-]*)-capture\.json$/u;
const BUNDLE_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const SELECTION = /^([a-z][a-z0-9-]*)(?::(detail|screen))?$/u;
const BUILD_ID = /^[0-9a-f]{64}$/u;
const DETAILS_FILE = /^[a-z0-9][a-z0-9-]*-capture-details\.json$/u;
const IMAGE_SOURCES_FILE = /^[a-z0-9][a-z0-9-]*-image-sources\.json$/u;
const RESULT_FILE = /(?:-capture\.json|-fixture\.json|\.png)$/u;
const utf8 = new globalThis.TextDecoder('utf-8', { fatal: true });
const encoder = new globalThis.TextEncoder();
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

export class CaptureAdoptionError extends Error {
  constructor(problems) {
    super(`Capture adoption problems (${problems.length}):\n- ${problems.join('\n- ')}`);
    this.name = 'CaptureAdoptionError';
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * Every `<name>-capture.json` of a Playwright output folder (`files`: path relative to it with `/`, and bytes)
 * with its fixture and images, and why it cannot be adopted (empty `problems` when it can).
 */
export function collectCaptureRun(files) {
  const byPath = new Map(), folders = new Map();
  for (const { path, bytes } of files) {
    if (byPath.has(path)) throw new Error(`Duplicate result file: ${path}`);
    byPath.set(path, bytes);
    const cut = path.lastIndexOf('/'), folder = cut < 0 ? '' : path.slice(0, cut);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(path.slice(cut + 1));
  }
  const captures = [];
  for (const [folder, names] of [...folders].sort(([left], [right]) => compare(left, right))) {
    const at = name => (folder === '' ? name : `${folder}/${name}`);
    const failed = names.filter(name => CAPTURE_FAILURE_ARTIFACT.test(name)).sort(compare);
    for (const fileName of [...names].sort(compare)) {
      const match = CAPTURE_RECORD.exec(fileName);
      if (match === null) continue;
      const name = match[1], problems = [], parts = {};
      if (failed.length > 0) problems.push(`the test that took it failed (${failed.join(', ')})`);
      let capture = null;
      try {
        capture = JSON.parse(utf8.decode(byPath.get(at(fileName))));
      } catch (error) {
        problems.push(`unreadable capture record (${error.message})`);
      }
      if (capture !== null) {
        problems.push(...inspectAdoptableCapture(capture, name));
        for (const [part, extension] of [['fixture', 'json'], ['screen', 'png'], ['detail', 'png']]) {
          const bytes = byPath.get(at(`${name}-${part}.${extension}`)), recorded = isObject(capture) ? capture[part] : undefined;
          if (bytes === undefined) problems.push(`${name}-${part}.${extension} is missing`);
          else if (!isObject(recorded) || sha256Hex(bytes) !== recorded.sha256) problems.push(`${name}-${part}.${extension} differs from the recorded SHA-256`);
          else parts[part] = bytes;
        }
      }
      captures.push({ path: at(fileName), name, project: isObject(capture) && typeof capture.project === 'string' ? capture.project : null,
        capture, fixture: parts.fixture ?? null, screen: parts.screen ?? null, detail: parts.detail ?? null, problems });
    }
  }
  return captures;
}

/** JSON text in the registry's style; keeps CRLF line ends when the replaced file used them. */
function formatJson(value, previousBytes) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return encoder.encode(previousBytes !== null && utf8.decode(previousBytes).includes('\r\n') ? text.replaceAll('\n', '\r\n') : text);
}

/** An older capture record without the entries for the adopted images (null when nothing is left). */
function withoutAdopted(json, adopted) {
  const removed = [];
  const keep = image => {
    if (!adopted.has(image)) return true;
    removed.push(image);
    return false;
  };
  if (Array.isArray(json)) {
    const images = json.filter(entry => !isObject(entry) || keep(entry.image));
    return { removed, json: images.length === 0 ? null : images };
  }
  if (isObject(json) && Array.isArray(json.captures)) {
    const captures = json.captures.filter(entry => !isObject(entry) || keep(`${entry.name}-${entry.selectedImage ?? 'detail'}.png`));
    if (captures.length === 0) return { removed, json: null };
    if (json.format !== CAPTURE_PROVENANCE_FORMAT) return { removed, json: { ...json, captures } };
    // A bundle lists only the scripts its remaining captures use.
    const used = new Set(captures.map(entry => entry.script));
    return { removed, json: { ...json, scripts: Object.fromEntries(Object.entries(json.scripts).filter(([path]) => used.has(path))), captures } };
  }
  if (isObject(json) && Array.isArray(json.images)) {
    const images = json.images.filter(entry => !isObject(entry) || keep(entry.filename));
    return { removed, json: images.length === 0 ? null : { ...json, images } };
  }
  return { removed, json };
}

/**
 * Selections for every capture of `project` whose detail or screen image a chapter shows; the other
 * captures are returned as `skipped`.
 */
export function referencedSelections(captures, project, chapters) {
  const references = collectChapterImageReferences(chapters), selections = [], skipped = [];
  for (const name of [...new Set(captures.filter(capture => capture.project === project).map(capture => capture.name))].sort(compare)) {
    const shown = ['detail', 'screen'].filter(part => references.has(`${name}-${part}.png`));
    if (shown.length === 0) skipped.push(name);
    selections.push(...shown.map(part => (part === 'detail' ? name : `${name}:${part}`)));
  }
  return { selections, skipped };
}

/**
 * Everything `adopt` would write, checked as a whole: `captures` from collectCaptureRun, `selections`
 * (`name` for the detail image or `name:screen`), `scripts` (path → current bytes), `folder` from
 * readCaptureFolder. Throws CaptureAdoptionError (or CaptureRegistryError from rebuilding the registry)
 * listing every problem instead of adopting a part.
 */
export function planCaptureAdoption({ captures, selections, bundle, project = 'functional', applicationBuildId, scripts, folder, adoptedAt }) {
  if (typeof bundle !== 'string' || !BUNDLE_NAME.test(bundle)) throw new CaptureAdoptionError([`invalid bundle name: ${String(bundle)}`]);
  if (typeof applicationBuildId !== 'string' || !BUILD_ID.test(applicationBuildId)) {
    throw new CaptureAdoptionError([`invalid current applicationBuildId: ${String(applicationBuildId)}`]);
  }
  if (typeof adoptedAt !== 'string' || Number.isNaN(Date.parse(adoptedAt))) throw new CaptureAdoptionError([`invalid adoptedAt: ${String(adoptedAt)}`]);
  if (selections.length === 0) throw new CaptureAdoptionError(['nothing selected']);
  const problems = [], chosen = [], images = new Set();
  for (const text of selections) {
    const match = SELECTION.exec(text);
    if (match === null) {
      problems.push(`invalid selection ${text} (use name or name:screen)`);
      continue;
    }
    const [, name, selectedImage = 'detail'] = match, image = `${name}-${selectedImage}.png`;
    if (images.has(image)) {
      problems.push(`${image} is selected twice`);
      continue;
    }
    images.add(image);
    const found = captures.filter(capture => capture.name === name && capture.project === project);
    if (found.length !== 1) {
      problems.push(found.length === 0 ? `no capture ${name} of project ${project}`
        : `several captures ${name} of project ${project} (${found.map(capture => capture.path).join(', ')}); adopt from one run`);
      continue;
    }
    const [candidate] = found, where = candidate.path;
    if (candidate.problems.length > 0) {
      problems.push(...candidate.problems.map(problem => `${where}: ${problem}`));
      continue;
    }
    const { capture } = candidate;
    if (capture.applicationBuildId !== applicationBuildId) {
      problems.push(`${where}: captured from another application build (${capture.applicationBuildId.slice(0, 12)}; now ${applicationBuildId.slice(0, 12)})`);
    }
    const script = scripts.get(capture.script);
    if (script === undefined) problems.push(`${where}: the capture script ${capture.script} is missing`);
    else if (sha256Hex(script) !== capture.scriptSha256) problems.push(`${where}: ${capture.script} changed after the capture`);
    if (Date.parse(capture.capturedAt) > Date.parse(adoptedAt)) problems.push(`${where}: captured after ${adoptedAt}`);
    let fixture;
    try {
      fixture = JSON.parse(utf8.decode(candidate.fixture));
    } catch (error) {
      problems.push(`${where}: unreadable fixture (${error.message})`);
      continue;
    }
    // The registry hashes JSON.stringify(fixture) again, exactly as captureManualDetail wrote the file.
    if (sha256Hex(encoder.encode(JSON.stringify(fixture))) !== capture.fixture.sha256) problems.push(`${where}: the fixture is not in its written form`);
    chosen.push({ name, selectedImage, image, capture, fixture, bytes: candidate[selectedImage] });
  }
  const references = collectChapterImageReferences(folder.chapters);
  for (const { image } of chosen) if (!references.has(image)) problems.push(`${image} is not shown by any chapter; link it from its chapter first`);
  const bundleFile = `${bundle}-capture-details.json`;
  if (folder.files.some(file => file.name === bundleFile)) problems.push(`${bundleFile} already exists; choose a new bundle name`);
  if (problems.length > 0) throw new CaptureAdoptionError(problems);

  chosen.sort((left, right) => compare(left.image, right.image));
  const scriptTable = Object.fromEntries([...new Map(chosen.map(entry => [entry.capture.script, entry.capture.scriptSha256]))]
    .sort(([left], [right]) => compare(left, right)));
  const provenance = {
    format: CAPTURE_PROVENANCE_FORMAT, releaseCertified: false, applicationBuildId, adoptedAt, scripts: scriptTable,
    captures: chosen.map(entry => ({ name: entry.name, selectedImage: entry.selectedImage, script: entry.capture.script,
      capture: Object.fromEntries(Object.entries(entry.capture).filter(([key]) => !OMITTED_CAPTURE_KEYS.has(key))), fixture: entry.fixture })),
  };
  const registryBytes = folder.files.find(file => file.name === CAPTURE_REGISTRY_FILE)?.bytes ?? null;
  const files = new Map(folder.files.map(file => [file.name, file.bytes]));
  const adopted = new Set(chosen.map(entry => entry.image)), rewrites = [];
  for (const file of folder.files) {
    if (!DETAILS_FILE.test(file.name) && !IMAGE_SOURCES_FILE.test(file.name)) continue;
    let json;
    try {
      json = JSON.parse(utf8.decode(file.bytes));
    } catch (error) {
      throw new CaptureAdoptionError([`${file.name}: unreadable JSON (${error.message})`]);
    }
    const result = withoutAdopted(json, adopted);
    if (result.removed.length === 0) continue;
    const bytes = result.json === null ? null : formatJson(result.json, file.bytes);
    rewrites.push({ name: file.name, bytes, removed: result.removed });
    if (bytes === null) files.delete(file.name);
    else files.set(file.name, bytes);
  }
  const bundleBytes = formatJson(provenance, registryBytes);
  files.set(bundleFile, bundleBytes);
  for (const entry of chosen) files.set(entry.image, entry.bytes);
  const next = [...files].map(([name, bytes]) => ({ name, bytes })).sort((left, right) => compare(left.name, right.name));
  const registry = buildCaptureRegistry(next);
  for (const entry of registry.images.filter(item => adopted.has(item.file))) {
    if (entry.applicationBuildId !== applicationBuildId || entry.records[0]?.file !== bundleFile) {
      throw new CaptureAdoptionError([`${entry.file} is not registered from ${bundleFile}`]);
    }
  }
  const registryText = formatCaptureRegistry(registry, registryBytes);
  const withRegistry = next.map(file => (file.name === CAPTURE_REGISTRY_FILE ? { name: file.name, bytes: encoder.encode(registryText) } : file));
  if (registryBytes === null) withRegistry.push({ name: CAPTURE_REGISTRY_FILE, bytes: encoder.encode(registryText) });
  const audit = auditCaptureRegistry(registry, { files: withRegistry, chapters: folder.chapters });
  const failures = ['unregistered', 'missingImages', 'shaMismatches', 'pixelConflicts', 'missingReferencedImages'].filter(key => audit[key].length > 0);
  if (failures.length > 0) throw new CaptureAdoptionError(failures.map(key => `after adopting, ${key}: ${JSON.stringify(audit[key])}`));
  return {
    bundle: { name: bundleFile, bytes: bundleBytes },
    images: chosen.map(entry => ({ name: entry.image, bytes: entry.bytes, replaced: folder.files.some(file => file.name === entry.image) })),
    rewrites,
    registry: { name: CAPTURE_REGISTRY_FILE, bytes: encoder.encode(registryText), previous: registryBytes },
    summary: {
      bundle: bundleFile, applicationBuildId, adopted: chosen.map(entry => entry.image),
      scripts: Object.keys(scriptTable), rewritten: rewrites.filter(item => item.bytes !== null).map(item => item.name),
      removedRecords: rewrites.filter(item => item.bytes === null).map(item => item.name),
    },
  };
}

/** Files of a Playwright output folder that collectCaptureRun reads (failure artifacts only by name). */
export async function readCaptureRun(folder) {
  const files = [];
  const walk = async (path, prefix) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name), relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Result folders must not contain links: ${relativePath}`);
      if (entry.isDirectory()) await walk(full, relativePath);
      else if (CAPTURE_FAILURE_ARTIFACT.test(entry.name)) files.push({ path: relativePath, bytes: new Uint8Array(0) });
      else if (entry.isFile() && RESULT_FILE.test(entry.name)) files.push({ path: relativePath, bytes: await readFile(full) });
    }
  };
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not a result folder: ${folder}`);
  await walk(folder, '');
  return files;
}

/** Write a plan, refusing when any touched file changed since it was planned. The registry is written last. */
export async function writeCaptureAdoption(root, plan, folder) {
  const imageFolder = join(root, CAPTURE_IMAGE_FOLDER);
  const planned = new Map(folder.files.map(file => [file.name, file.bytes]));
  const touched = [plan.bundle.name, ...plan.images.map(image => image.name), ...plan.rewrites.map(item => item.name), plan.registry.name];
  for (const name of touched) {
    const current = await readFile(join(imageFolder, name)).catch(error => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    const before = planned.get(name) ?? null;
    if ((current === null) !== (before === null) || (current !== null && sha256Hex(current) !== sha256Hex(before))) {
      throw new Error(`${name} changed while adopting; run the command again`);
    }
  }
  for (const image of plan.images) await writeFile(join(imageFolder, image.name), image.bytes);
  await writeFile(join(imageFolder, plan.bundle.name), plan.bundle.bytes, { flag: 'wx' });
  for (const item of plan.rewrites) {
    if (item.bytes === null) await unlink(join(imageFolder, item.name));
    else await writeFile(join(imageFolder, item.name), item.bytes);
  }
  await writeFile(join(imageFolder, plan.registry.name), plan.registry.bytes);
}

function parseArguments(args) {
  const [command, ...rest] = args, options = { project: 'functional', referenced: false, selections: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--results' || value === '--bundle' || value === '--project') {
      if (index + 1 >= rest.length) throw new Error(`${value} needs a value`);
      options[value.slice(2)] = rest[index + 1];
      index += 1;
    } else if (value === '--referenced') options.referenced = true;
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else options.selections.push(value);
  }
  if ((command !== 'plan' && command !== 'adopt') || options.results === undefined || options.bundle === undefined
    || options.referenced === (options.selections.length > 0)) {
    throw new Error('Usage: node scripts/manual/captureProvenance.mjs <plan|adopt> --results <Playwright output folder> --bundle <name> '
      + '[--project functional] (--referenced | <name[:detail|screen]>...)');
  }
  return { command, ...options };
}

async function main(args) {
  const options = parseArguments(args);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const captures = collectCaptureRun(await readCaptureRun(resolve(options.results)));
  const folder = await readCaptureFolder(root);
  const { selections, skipped } = options.referenced ? referencedSelections(captures, options.project, folder.chapters)
    : { selections: options.selections, skipped: [] };
  const scripts = new Map();
  for (const path of new Set(captures.map(capture => (isObject(capture.capture) ? capture.capture.script : undefined)).filter(path => typeof path === 'string'))) {
    try {
      scripts.set(path, await readFile(join(root, path)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const plan = planCaptureAdoption({ captures, selections, bundle: options.bundle, project: options.project,
    applicationBuildId: await applicationInputDigest(root), scripts, folder, adoptedAt: new Date().toISOString() });
  if (options.command === 'adopt') await writeCaptureAdoption(root, plan, folder);
  log(JSON.stringify({ command: options.command, written: options.command === 'adopt', ...plan.summary,
    replacedImages: plan.images.filter(image => image.replaced).map(image => image.name), skipped,
    notAdoptable: captures.filter(capture => capture.problems.length > 0).map(capture => ({ path: capture.path, problems: capture.problems })) }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.exitCode = 1;
    log(error instanceof CaptureAdoptionError || error?.name === 'CaptureRegistryError'
      ? JSON.stringify({ error: error.name, problems: error.problems }, null, 2) : String(error?.stack ?? error));
  }
}
