/**
 * Assemble the raw path/digest index that scripts/check-release-ready.ps1 takes as -PerformanceEvidence (and its SHA-256
 * as -PerformanceEvidenceSha256) for the W21/W22 dedicated measurements. It never judges: the index carries no `accepted`
 * field, and scripts/release/dedicatedPerformanceEvidence.mjs decides from the raw files themselves (imported, not copied).
 * Every file hash is the release build's sourceFileHash (CRLF read as LF), so a CRLF checkout (core.autocrlf=true, such as
 * the send copy) and inputs stored in Git with CRLF compare on the same terms as the release check.
 *
 *   manifest      Before measuring: write the QA input manifest of this checkout ({ schema_version: 1, checkout, files:
 *                 [{ path, copy_sha256 }] }): every Web and Desktop build input (captureWebBuildSources/captureDesktopBuildSources),
 *                 pnpm-lock.yaml and every file under e2e/. Each run must then record this manifest's SHA-256 (command
 *                 receipt manifestSha256, exclusive: true).
 *   inputs-after  After a run: compare every manifest row with the current file and write { manifestSha256,
 *                 allManifestInputsUnchanged, changed } (with --report and --exit-code, also the Playwright JSON binding).
 *   index         After measuring: read a plan naming, per W21 host and W22 project × scenario, the raw files of each run
 *                 and write the index. The executed test sources the release check binds by path are copied (as Git holds
 *                 them) next to the index. Missing roles, duplicate cells, a run that is not exclusive or not bound to the
 *                 manifest, a failed terminal run and a source changed after the manifest are refused here. --verify then
 *                 runs the release check's own loader and judgement on the written index.
 *
 * Usage (paths are inside this checkout; outputs are never overwritten):
 *   node scripts/performance-evidence/build-dedicated-evidence-index.mjs manifest --out <manifest.json>
 *   node scripts/performance-evidence/build-dedicated-evidence-index.mjs inputs-after --manifest <manifest.json> --out <file>
 *     [--report <playwright.json> --exit-code <n>]
 *   node scripts/performance-evidence/build-dedicated-evidence-index.mjs index --plan <plan.json> --out <index.json> [--verify]
 * Exit codes: 0 done (with --verify: W21 and W22 accepted), 3 with --verify only the W21 original ratio refused (the v1.0.3
 * exception of scripts/release/README.md may apply), 1 refused, 64 usage. Builds, measures and publishes nothing.
 */
import process, { argv } from 'node:process';
import { log } from 'node:console';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';
import { checkDedicatedPerformanceEvidence, loadDedicatedPerformanceEvidence } from '../release/dedicatedPerformanceEvidence.mjs';
import { sourceFileHash } from '../release/desktopFileInventory.mjs';
import { captureDesktopBuildSources, captureWebBuildSources } from '../vite/webBuildSources.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const DEDICATED_EVIDENCE_PLAN_FORMAT = 'pointercad-dedicated-evidence-plan/1';
export const DEDICATED_W21_HOSTS = Object.freeze(['functional', 'firefox', 'electron']);
export const DEDICATED_W22_SCENARIOS = Object.freeze(['input', 'ADD-23', 'ADD-17', 'hemisphere']);
export const DEDICATED_EVIDENCE_EXIT = Object.freeze({ done: 0, refused: 1, ratioOnly: 3, usage: 64 });
/** The executed test sources the release check binds by path (sourceRecord), per role. */
export const DEDICATED_SOURCE_ROLES = Object.freeze({
  config: 'e2e/playwright.config.ts', flow: 'e2e/tests/occtCompileReuseFlow.ts', electronHelper: 'e2e/tests/electronAppFlow.ts',
  electronSpec: 'e2e/tests/electron-occt-compile-reuse.spec.ts', browserSpec: 'e2e/tests/occt-compile-reuse-solid.spec.ts',
});
const W21_RUN_ROLES = Object.freeze({ electron: ['result', 'command', 'report', 'launch', 'inputsAfter'], browser: ['result', 'command', 'report', 'build'] });
const W22_CELL_ROLES = Object.freeze(['result', 'command', 'pair']);
const W22_RUN_ROLES = Object.freeze(['run', 'launch', 'attachment', 'sample', 'report', 'inputsAfter']);

export class DedicatedEvidenceUsageError extends Error {}

/**
 * A source as Git holds it: the bytes whose plain SHA-256 is sourceFileHash of the checkout bytes (text without NUL:
 * every CRLF read as LF; binary content unchanged). The release check compares a copied source's plain SHA-256 with
 * its manifest row, so the copy must carry exactly these bytes.
 */
export function sourceCopyBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Source file bytes are required');
  if (bytes.includes(0) || !bytes.includes(0x0d)) return Uint8Array.from(bytes);
  const text = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    text[length] = bytes[index]; length += 1;
  }
  return text.slice(0, length);
}

/**
 * The QA input manifest: the current build inputs ({ web, desktop } as the release build captures them: path →
 * sourceFileHash) and test sources (path → checkout bytes, hashed the same way). One row per path, sorted.
 */
export function dedicatedQaManifest({ web, desktop, sources, checkout }) {
  if (!isRecord(web) || !isRecord(desktop) || !isRecord(sources)) throw new Error('Build inputs and test sources are required');
  if (typeof checkout !== 'string' || checkout === '') throw new Error('The checkout folder is required');
  const files = new Map();
  const put = (path, hash, origin) => {
    if (files.has(path) && files.get(path) !== hash) throw new Error(`${origin} differs for one path: ${path}`);
    files.set(path, hash);
  };
  for (const inputs of [web, desktop]) for (const [path, hash] of Object.entries(inputs)) put(path, hash, 'Build input');
  for (const [path, bytes] of Object.entries(sources)) put(path, sourceFileHash(bytes), 'Test source');
  if (!files.has('pnpm-lock.yaml')) throw new Error('pnpm-lock.yaml must be listed (the release check binds the lock)');
  return { schema_version: 1, checkout, hash: 'sourceFileHash (CRLF read as LF)',
    files: [...files].sort(([left], [right]) => compare(left, right)).map(([path, copy_sha256]) => ({ path, copy_sha256 })) };
}

/** Rows of the manifest whose current hash (readHash: path → sourceFileHash, or null when missing) differs. */
export function changedManifestInputs(manifest, readHash) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Expected a QA input manifest');
  return manifest.files.filter(row => readHash(row.path) !== row.copy_sha256).map(row => row.path);
}

/** A plan cell names exactly these file roles (and the listed other keys); anything else is refused. */
function cellRoles(cell, roles, label, others = []) {
  if (!isRecord(cell)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(cell).filter(key => !roles.includes(key) && !others.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown roles: ${unknown.join(', ')}`);
  for (const role of roles) if (typeof cell[role] !== 'string' || cell[role] === '') throw new Error(`${label} needs the ${role} file`);
}

/**
 * Pure assembly of the index from a plan, a reader of the raw files (path → bytes) and the copied test sources
 * (role path → { path, bytes } as written next to the index). Throws with the first refused condition.
 */
export function assembleDedicatedEvidenceIndex(plan, readBytes, sourceCopies) {
  if (!isRecord(plan) || plan.format !== DEDICATED_EVIDENCE_PLAN_FORMAT || typeof plan.manifest !== 'string'
    || !Array.isArray(plan.w21) || !Array.isArray(plan.w22)) {
    throw new Error(`Plan must be ${DEDICATED_EVIDENCE_PLAN_FORMAT} with manifest, w21 and w22`);
  }
  const unknown = Object.keys(plan).filter(key => !['format', 'manifest', 'w21', 'w22'].includes(key));
  if (unknown.length > 0) throw new Error(`Plan has unknown fields: ${unknown.join(', ')}`);
  const records = {};
  const add = (path, bytes = readBytes(path)) => {
    if (!Object.hasOwn(records, path)) records[path] = { path, sha256: digest(bytes), bytes };
    return path;
  };
  const json = id => {
    try { return JSON.parse(Buffer.from(records[id].bytes).toString('utf8')); }
    catch { throw new Error(`Not JSON: ${records[id].path}`); }
  };
  const manifestId = add(plan.manifest), manifestSha256 = records[manifestId].sha256, manifest = json(manifestId);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Expected a QA input manifest');
  const source = role => {
    const path = DEDICATED_SOURCE_ROLES[role], copy = sourceCopies[path];
    if (copy === undefined) throw new Error(`Missing copy of the executed test source: ${path}`);
    const rows = manifest.files.filter(row => row.path === path);
    if (rows.length !== 1 || rows[0].copy_sha256 !== digest(copy.bytes)) throw new Error(`Executed test source changed after the manifest: ${path}`);
    return add(copy.path, copy.bytes);
  };
  const terminal = (label, cell) => {
    const command = json(add(cell.command)), result = json(add(cell.result));
    if (command.exclusive !== true) throw new Error(`${label}: the run is not exclusive (overlapping runs are not dedicated evidence): ${cell.command}`);
    if (command.manifestSha256 !== manifestSha256) throw new Error(`${label}: the run is not bound to this manifest: ${cell.command}`);
    if (result.exitCode !== 0) throw new Error(`${label}: the run did not end with exit code 0: ${cell.result}`);
  };
  const hosts = new Set();
  const w21 = plan.w21.map(cell => {
    const project = cell?.project;
    if (!DEDICATED_W21_HOSTS.includes(project) || hosts.has(project)) throw new Error(`W21 needs each of ${DEDICATED_W21_HOSTS.join(', ')} exactly once: ${String(project)}`);
    hosts.add(project);
    const roles = W21_RUN_ROLES[project === 'electron' ? 'electron' : 'browser'];
    cellRoles(cell, roles, `W21 ${project}`, ['project']);
    terminal(`W21 ${project}`, cell);
    const entry = { project, ...Object.fromEntries(roles.map(role => [role, add(cell[role])])), flow: source('flow') };
    if (project === 'electron') Object.assign(entry, { config: source('config'), electronHelper: source('electronHelper'), spec: source('electronSpec') });
    else entry.spec = source('browserSpec');
    return entry;
  });
  if (w21.length !== DEDICATED_W21_HOSTS.length) throw new Error(`W21 needs ${DEDICATED_W21_HOSTS.length} hosts, got ${w21.length}`);
  const cells = new Set();
  const w22 = plan.w22.map(cell => {
    cellRoles(cell, W22_CELL_ROLES, 'W22 cell', ['normal', 'slow']);
    const pair = json(add(cell.pair)), key = `${String(pair.project)}/${String(pair.scenario)}`;
    if (!DEDICATED_W21_HOSTS.includes(pair.project) || !DEDICATED_W22_SCENARIOS.includes(pair.scenario) || cells.has(key)) {
      throw new Error(`W22 needs each project × scenario exactly once: ${key}`);
    }
    cells.add(key);
    terminal(`W22 ${key}`, cell);
    const entry = { ...Object.fromEntries(W22_CELL_ROLES.map(role => [role, add(cell[role])])), config: source('config') };
    for (const condition of ['normal', 'slow']) {
      cellRoles(cell[condition], W22_RUN_ROLES, `W22 ${key} ${condition}`);
      entry[condition] = Object.fromEntries(W22_RUN_ROLES.map(role => [role, add(cell[condition][role])]));
    }
    return entry;
  });
  const expected = DEDICATED_W21_HOSTS.length * DEDICATED_W22_SCENARIOS.length;
  if (w22.length !== expected) throw new Error(`W22 needs ${expected} cells, got ${w22.length}`);
  const index = { records: Object.fromEntries(Object.entries(records).map(([id, ref]) => [id, { path: ref.path, sha256: ref.sha256 }])),
    manifest: manifestId, w21, w22 };
  return { index, records };
}

function insideRoot(root, path) {
  if (typeof path !== 'string' || path === '') throw new Error('A checkout-relative path is required');
  const target = resolve(root, path), local = relative(root, target);
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Path must stay inside the checkout: ${path}`);
  return { target, local: local.split(sep).join('/') };
}

function readInside(root, path) {
  const { target, local } = insideRoot(root, path);
  // The same native resolution as loadDedicatedPerformanceEvidence (fs/promises realpath), so both accept the same paths.
  if (realpathSync.native(target) !== target) throw new Error(`Path must be a real file inside the checkout (no link): ${path}`);
  return { target, local };
}

function listE2eSourceNames(root) {
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + realpathSync(root).replaceAll('\\', '/'), 'ls-files', '-z', ...args],
    { cwd: root, env: localGitEnvironment(), encoding: 'utf8', maxBuffer: 16_777_216, windowsHide: true }).split('\0').filter(Boolean);
  const deleted = new Set(git(['--deleted', '--', 'e2e']));
  return [...new Set(git(['--cached', '--others', '--exclude-standard', '--', 'e2e']))].filter(name => !deleted.has(name)).sort();
}

function option(args, name, required = true) {
  const at = args.indexOf(name);
  if (at === -1) {
    if (required) throw new DedicatedEvidenceUsageError(`${name} is required`);
    return undefined;
  }
  const value = args[at + 1];
  if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new DedicatedEvidenceUsageError(`${name} needs a value`);
  return value;
}

async function writeNew(root, path, bytes) {
  const { target, local } = insideRoot(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  return { target, local, sha256: digest(bytes) };
}

const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

const captureReleaseInputs = async root => ({ web: await captureWebBuildSources(root), desktop: await captureDesktopBuildSources(root) });

/**
 * Run one step; returns the exit code (DEDICATED_EVIDENCE_EXIT). Errors other than usage propagate as refusals.
 * captureInputs (the release build inputs) and listTestSources (the e2e files) default to the Git listing of root.
 */
export async function runBuildDedicatedEvidenceIndex(args, { root = repositoryRoot, write = text => log(text),
  captureInputs = captureReleaseInputs, listTestSources = listE2eSourceNames } = {}) {
  const [step, ...rest] = args;
  if (step === 'manifest') {
    const sources = {};
    for (const name of await listTestSources(root)) sources[name] = await readFile(readInside(root, name).target);
    const manifest = dedicatedQaManifest({ ...await captureInputs(root), sources, checkout: root });
    const written = await writeNew(root, option(rest, '--out'), jsonBytes(manifest));
    write(`QA の入力の一覧: ${written.local}（${manifest.files.length} 件）\nmanifestSha256 ${written.sha256}`);
    return DEDICATED_EVIDENCE_EXIT.done;
  }
  if (step === 'inputs-after') {
    const manifestBytes = await readFile(readInside(root, option(rest, '--manifest')).target);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const hashes = new Map();
    for (const row of manifest.files ?? []) {
      try { hashes.set(row.path, sourceFileHash(await readFile(readInside(root, row.path).target))); } catch { hashes.set(row.path, null); }
    }
    const changed = changedManifestInputs(manifest, path => hashes.get(path) ?? null);
    const value = { manifestSha256: digest(manifestBytes), allManifestInputsUnchanged: changed.length === 0, changed };
    const report = option(rest, '--report', false), exitCode = option(rest, '--exit-code', false);
    if ((report === undefined) !== (exitCode === undefined)) throw new DedicatedEvidenceUsageError('--report and --exit-code go together');
    if (report !== undefined) {
      if (!/^-?\d+$/u.test(exitCode)) throw new DedicatedEvidenceUsageError('--exit-code needs an integer');
      const { target } = readInside(root, report);
      Object.assign(value, { commandExitCode: Number(exitCode), playwrightExitCode: Number(exitCode), playwrightJson: target,
        playwrightJsonSha256: digest(await readFile(target)) });
    }
    const written = await writeNew(root, option(rest, '--out'), jsonBytes(value));
    write(`実行の後の入力: ${written.local}（変わったファイル ${changed.length} 件）`);
    return changed.length === 0 ? DEDICATED_EVIDENCE_EXIT.done : DEDICATED_EVIDENCE_EXIT.refused;
  }
  if (step === 'index') {
    const plan = JSON.parse(await readFile(readInside(root, option(rest, '--plan')).target, 'utf8'));
    const out = insideRoot(root, option(rest, '--out'));
    const cache = new Map();
    const readBytes = path => {
      if (!cache.has(path)) throw new Error(`Unread file: ${path}`);
      return cache.get(path);
    };
    for (const path of collectPlanPaths(plan)) {
      const { local, target } = readInside(root, path);
      if (local !== path) throw new Error(`Plan paths must be checkout-relative with "/" separators: ${path}`);
      cache.set(path, await readFile(target));
    }
    const sourceCopies = {};
    for (const path of Object.values(DEDICATED_SOURCE_ROLES)) {
      const copyPath = `${dirname(out.local)}/sources/${path}`.replace(/^\.\//u, '');
      sourceCopies[path] = { path: copyPath, bytes: sourceCopyBytes(await readFile(readInside(root, path).target)) };
    }
    const { index } = assembleDedicatedEvidenceIndex(plan, readBytes, sourceCopies);
    for (const copy of Object.values(sourceCopies)) await writeNew(root, copy.path, copy.bytes);
    const written = await writeNew(root, out.local, jsonBytes(index));
    write(`専用の測定の証拠の索引: ${written.local}\n-PerformanceEvidence ${written.local} -PerformanceEvidenceSha256 ${written.sha256}`);
    if (!rest.includes('--verify')) return DEDICATED_EVIDENCE_EXIT.done;
    const sourceInputs = await captureInputs(root);
    const evidence = await loadDedicatedPerformanceEvidence(root, written.local, written.sha256, sourceInputs);
    const outcomes = Object.fromEntries(['w21-dedicated', 'w22-dedicated'].map(kind => [kind, checkDedicatedPerformanceEvidence(kind, evidence, sourceInputs)]));
    for (const [kind, outcome] of Object.entries(outcomes)) {
      write(`${kind}: ${outcome.status} — ${outcome.summary}${outcome.problems ? `（${outcome.problems.join(' / ')}）` : ''}`);
      for (const row of outcome.w21Ratios ?? []) {
        write(`  ${row.project} ${row.network}: cold ${row.coldMedianMs} ms・warm ${row.warmMedianMs} ms・比 ${row.ratio.toFixed(3)}`);
      }
      // The exact rows for the measurements of a v1.0.3 W21 ratio exception (scripts/release/README.md), unrounded.
      if (outcome.ratioOnly === true) {
        write(`measurements ${JSON.stringify(outcome.w21Ratios.map(({ project, network, coldMedianMs, warmMedianMs, ratio }) => ({ project, network, coldMedianMs, warmMedianMs, ratio })))}`);
      }
    }
    const w21 = outcomes['w21-dedicated'], w22 = outcomes['w22-dedicated'];
    if (w21.status === 'pass' && w22.status === 'pass') return DEDICATED_EVIDENCE_EXIT.done;
    return w21.ratioOnly === true && w22.status === 'pass' ? DEDICATED_EVIDENCE_EXIT.ratioOnly : DEDICATED_EVIDENCE_EXIT.refused;
  }
  throw new DedicatedEvidenceUsageError('Step must be manifest, inputs-after or index');
}

/** Every raw file path a plan names (manifest, W21 roles, W22 cell and run roles), for reading before assembly. */
export function collectPlanPaths(plan) {
  const paths = new Set();
  const visit = (value, key) => {
    if (key === 'format' || key === 'project') return;
    if (typeof value === 'string') { paths.add(value); return; }
    if (Array.isArray(value)) { value.forEach(item => visit(item)); return; }
    if (isRecord(value)) for (const [name, item] of Object.entries(value)) visit(item, name);
  };
  visit(plan);
  return [...paths];
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  try { process.exitCode = await runBuildDedicatedEvidenceIndex(argv.slice(2)); }
  catch (error) {
    log(`build-dedicated-evidence-index: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof DedicatedEvidenceUsageError ? DEDICATED_EVIDENCE_EXIT.usage : DEDICATED_EVIDENCE_EXIT.refused;
  }
}
