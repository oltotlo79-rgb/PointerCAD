import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const HOSTS = ['functional', 'firefox', 'electron'];
const SCENARIOS = ['input', 'ADD-23', 'ADD-17', 'hemisphere'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Faithful run-local port of owned_job_cpu.py r3 (c627c799...). No cross-run population predicate.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isInteger(value);
const unicodeOrder = (a, b) => {
  const left = Array.from(a, character => character.codePointAt(0)), right = Array.from(b, character => character.codePointAt(0));
  for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
};
const equalRaw = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalRaw(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
    return equalRaw(keys, other) && keys.every(key => equalRaw(a[key], b[key]));
  }
  return false;
};
function rawIdentity(row) {
  const value = row?.identity;
  return value && integer(row.serial) && typeof value.documentId === 'string' && integer(value.documentVersion)
    && typeof value.editorId === 'string' && integer(value.inputRevision)
    ? [row.serial, value.documentId, value.documentVersion, value.editorId, value.inputRevision] : null;
}
const sameIdentity = (a, b) => rawIdentity(a) !== null && equalRaw(rawIdentity(a), rawIdentity(b));
const nonterminal = kind => ['math-pace', 'math-phase', 'math-worker-retire'].includes(kind);
function pairRawOccurrences(transport, phases, clients, editors) {
  const hosts = new Map(), pairs = new Map();
  for (const row of transport) {
    requireValue(finite(row.timeOrigin) && finite(row.at) && integer(row.worker) && row.worker >= 1, 'Invalid transport clock/Worker');
    const key = JSON.stringify([row.timeOrigin, row.worker]);
    requireValue(hosts.has(key) || row.event === 'request', 'Orphan transport event');
    if (!hosts.has(key)) hosts.set(key, { all: [], pending: [], at: -Infinity, terminated: false });
    const host = hosts.get(key);
    requireValue(row.at >= host.at && (!host.terminated || row.event === 'reply'), 'Transport order after termination');
    host.at = row.at;
    if (row.event === 'request') {
      requireValue(rawIdentity(row) && integer(row.occurrence) && row.occurrence === host.all.length + 1, 'Invalid actual occurrence');
      const pair = { request: row, events: [], phases: [] };
      host.all.push(pair); host.pending.push(pair); pairs.set(row, pair);
    } else if (row.event === 'terminate') {
      requireValue(equalRaw(row.pendingOccurrences, host.pending.map(pair => pair.request.occurrence)), 'Unproven termination');
      for (const pair of host.pending) pair.events.push(row);
      host.terminated = true;
    } else if (row.event === 'reply') {
      requireValue(row.kind !== 'math-failed' && typeof row.kind === 'string', 'Failed or invalid reply');
      requireValue(host.pending.length > 0 && row.occurrence === host.pending[0].request.occurrence, 'Unmatched or stale delivery');
      const pair = host.pending[0];
      requireValue(['math-pace', 'math-worker-retire'].includes(row.kind) || sameIdentity(row, pair.request), 'Reply identity mismatch');
      pair.events.push(row);
      if (!nonterminal(row.kind)) host.pending.shift();
    } else throw new Error('Invalid or failed transport event');
  }
  requireValue(clients.every(row => rawIdentity(row) && integer(row.client) && row.client >= 1 && finite(row.timeOrigin) && finite(row.at)
    && ['dispatch', 'dispatched', 'complete', 'finished'].includes(row.event)
    && (!['complete', 'finished'].includes(row.event) || ['result', 'cancelled', 'disposed'].includes(row.status))), 'Invalid or failed client evidence');
  requireValue(editors.every(row => rawIdentity({ ...row, serial: 0 }) && integer(row.session) && row.session >= 1
    && finite(row.timeOrigin) && finite(row.at) && ['abort', 'discard', 'apply'].includes(row.event)), 'Invalid editor evidence');
  const usedClients = new Set();
  for (const pair of pairs.values()) {
    const request = pair.request;
    const matches = clients.filter(row => row.event === 'dispatch' && sameIdentity(row, request) && row.timeOrigin === request.timeOrigin
      && finite(row.at) && row.at <= request.at && clients.some(end => end.client === row.client && end.serial === row.serial
        && end.timeOrigin === row.timeOrigin && end.event === 'complete' && finite(end.at) && end.at >= request.at));
    requireValue(matches.length === 1, 'Missing or ambiguous actual client');
    const dispatch = matches[0], clientKey = JSON.stringify([dispatch.timeOrigin, dispatch.client, dispatch.serial]);
    requireValue(!usedClients.has(clientKey), 'Client occurrence reused'); usedClients.add(clientKey);
    const rows = clients.filter(row => JSON.stringify([row.timeOrigin, row.client, row.serial]) === clientKey);
    const boundaries = ['dispatch', 'dispatched', 'complete', 'finished'].map(name => rows.filter(row => row.event === name));
    requireValue(rows.length === 4 && boundaries.every(items => items.length === 1) && rows.every(row => sameIdentity(row, request) && finite(row.at)), 'Missing actual client boundary');
    const [posted, completion, finished] = boundaries.slice(1).map(items => items[0]);
    requireValue(dispatch.at <= posted.at && posted.at <= completion.at && completion.at <= finished.at
      && completion.status === finished.status && completion.replaceWorker === finished.replaceWorker, 'Client completion order');
    pair.completion = completion;
    if (completion.status === 'result') continue;
    requireValue(['cancelled', 'disposed'].includes(completion.status) && completion.replaceWorker === true, 'Failed actual client completion');
    const terminated = pair.events.filter(row => row.event === 'terminate' && completion.at <= row.at && row.at <= finished.at);
    const evidence = editors.filter(row => row.timeOrigin === request.timeOrigin && sameIdentity({ ...row, serial: request.serial }, request) && finite(row.at));
    const aborts = evidence.filter(row => row.event === 'abort' && dispatch.at <= row.at && row.at <= completion.at);
    const discards = evidence.filter(row => row.event === 'discard' && row.at >= finished.at);
    const documentMath = request.identity.editorId === 'document-math';
    requireValue(terminated.length === 1 && (documentMath || (aborts.length === 1 && discards.length === 1 && aborts[0].session === discards[0].session))
      && !evidence.some(row => row.event === 'apply' && row.at >= dispatch.at), 'Unproven cancellation/non-adoption');
    pair.cancellation = { client: completion.client, status: completion.status, completedAt: completion.at, finishedAt: finished.at,
      terminationAt: terminated[0].at, nonAdoption: documentMath ? 'document-math-non-result-branch' : 'editor-discard',
      editorSession: documentMath ? null : aborts[0].session, abortAt: documentMath ? null : aborts[0].at, discardAt: documentMath ? null : discards[0].at };
  }
  const groups = new Map();
  for (const row of phases) {
    requireValue(row.failed !== true, 'Failed Worker request');
    if (['module-ready', 'backend-ready'].includes(row.phase)) continue;
    requireValue(typeof row.worker === 'string' && row.worker && finite(row.timeOrigin) && finite(row.atMs), 'Invalid phase clock/Worker');
    if (!groups.has(row.worker)) groups.set(row.worker, []);
    const worker = groups.get(row.worker), previous = worker.at(-1)?.at(-1);
    requireValue(!previous || (row.timeOrigin === previous.timeOrigin && row.atMs >= previous.atMs), 'Phase clock order');
    if (row.phase === 'request-received') worker.push([]);
    requireValue(worker.length > 0, 'Orphan request phase'); worker.at(-1).push(row);
  }
  const used = new Set();
  for (const host of hosts.values()) {
    const candidates = [];
    for (const [worker, rows] of groups) {
      if (rows.length > host.all.length) continue;
      const matches = rows.every((group, index) => {
        const pair = host.all[index], request = pair.request, received = group[0];
        return pair.events.length > 0 && group.every(row => sameIdentity(row, request))
          && request.timeOrigin + request.at <= received.timeOrigin + received.atMs
          && (pair.cancellation || received.timeOrigin + received.atMs <= request.timeOrigin + pair.events.at(-1).at);
      });
      if (matches && host.all.slice(rows.length).every(pair => pair.events.some(row => row.event === 'terminate'))) candidates.push([worker, rows]);
    }
    if (!candidates.length && host.all.every(pair => pair.events.some(row => row.event === 'terminate'))) continue;
    requireValue(candidates.length === 1 && !used.has(candidates[0][0]), 'Missing or ambiguous Worker occurrence sequence');
    const [worker, rows] = candidates[0]; used.add(worker);
    rows.forEach((group, index) => { host.all[index].phases = group; });
  }
  requireValue(used.size === groups.size, 'Unmatched diagnostic Worker');
  for (const pair of pairs.values()) {
    const pace = pair.events.filter(row => row.kind === 'math-pace'), termination = pair.events.find(row => row.event === 'terminate');
    const terminal = pair.events.find(row => row.event === 'reply' && !nonterminal(row.kind));
    const cancelled = Boolean(pair.cancellation), starts = pair.phases.filter(row => row.phase === 'request-start');
    const engine = pair.phases.filter(row => String(row.phase).startsWith('engine-')), progress = pair.events.filter(row => row.kind === 'math-phase');
    requireValue(cancelled || (!(pace.length && !pair.phases.length) && engine.length === progress.length
      && engine.every((row, index) => row.phase === 'engine-' + String(progress[index].phase))), 'Missing actual request phase');
    requireValue(!cancelled || (progress.length <= engine.length && progress.every((row, index) => engine[index].phase === 'engine-' + String(row.phase))
      && ['request-received', 'request-start', 'reply-ready', 'request-end'].every(name => pair.phases.filter(row => row.phase === name).length <= 1)), 'Ambiguous cancelled phase');
    requireValue(pace.length <= 1 && (cancelled || pace.length === 1) && (!pace.length || (finite(pace[0].pace) && pace[0].pace >= 1 && pace[0].pace <= 4
      && (cancelled || starts.length === 1) && starts.length <= 1 && (!starts.length || pace[0].pace === starts[0].pace))), 'Ambiguous pace delivery');
    requireValue(cancelled || !termination || terminal, 'Unproven termination');
    requireValue(cancelled || (terminal && Object.hasOwn(pair, 'completion') && !pair.phases.some(row => row.phase === 'reply-ready'
      && row.timeOrigin + row.atMs > pair.request.timeOrigin + pair.completion.at)), 'Client/Worker result clock mismatch');
  }
  return pairs;
}
function requireRawCompleteStages(sample) {
  const transport = sample.transport ?? [], phases = sample.phases ?? [], stages = sample.stageIntervals ?? [];
  const pairs = pairRawOccurrences(transport, phases, sample.clients ?? [], sample.editors ?? []);
  const requests = transport.filter(row => row.event === 'request');
  requireValue(requests.length > 0 && stages.length === requests.length, 'Every actual request requires a stage classification');
  let completed = 0;
  const used = new Set(), workerOwners = new Map(), hostWorkers = new Map();
  for (const request of requests) {
    const host = [request.timeOrigin, request.worker, request.occurrence], hostKey = JSON.stringify(host), hostWorker = JSON.stringify(host.slice(0, 2));
    requireValue(rawIdentity(request) && integer(request.worker) && request.worker >= 1 && !used.has(hostKey), 'Invalid or duplicate actual request'); used.add(hostKey);
    const pair = pairs.get(request), terminal = pair.events.filter(row => row.event === 'reply' && !nonterminal(row.kind));
    const matching = stages.filter(row => equalRaw([row.hostTimeOrigin, row.hostWorker, row.occurrence], host) && sameIdentity(row, request));
    requireValue(matching.length === 1, 'Stage/request correspondence is not one-to-one'); const stage = matching[0];
    if (pair.cancellation) {
      requireValue(stage.classification === 'cancelled-before-adoption' && stage.complete === false && equalRaw(stage.cancellation, pair.cancellation)
        && equalRaw(stage.observedPhases, pair.phases) && stage.terminalObserved === Boolean(terminal.length), 'Missing raw cancellation classification'); continue;
    }
    requireValue(terminal.length === 1 && sameIdentity(terminal[0], request) && stage.classification === 'completed' && stage.complete === true, 'Incomplete completed request or unproven termination');
    const worker = stage.worker;
    requireValue(typeof worker === 'string' && worker && (!workerOwners.has(worker) || workerOwners.get(worker) === hostWorker)
      && (!hostWorkers.has(hostWorker) || hostWorkers.get(hostWorker) === worker), 'Ambiguous Worker correspondence');
    workerOwners.set(worker, hostWorker); hostWorkers.set(hostWorker, worker); completed++;
    const samePhases = pair.phases;
    requireValue(samePhases.every(row => row.worker === worker), 'Stage Worker differs from paired diagnostics');
    const names = ['request-received', 'request-start', 'reply-ready', 'request-end'];
    requireValue(names.every(name => samePhases.filter(row => row.phase === name).length === 1), 'Missing or ambiguous actual request boundary');
    const workerPhases = phases.filter(row => row.worker === worker);
    requireValue(['module-ready', 'backend-ready'].every(name => workerPhases.filter(row => row.phase === name).length === 1), 'Missing actual Worker preparation boundary');
    const engine = samePhases.filter(row => String(row.phase).startsWith('engine-'));
    const progress = pair.events.filter(row => row.event === 'reply' && row.kind === 'math-phase');
    requireValue(engine.length === progress.length && engine.every((row, index) => row.phase === 'engine-' + String(progress[index].phase) && sameIdentity(progress[index], request)), 'Actual engine/progress observations differ');
    const boundaries = names.map(name => samePhases.find(row => row.phase === name)), origin = boundaries[0].timeOrigin, values = boundaries.map(row => row.atMs);
    requireValue([origin, request.timeOrigin, request.at, terminal[0].at, ...values].every(finite)
      && values.every((value, index) => index === 0 || value >= values[index - 1]) && samePhases.every(row => row.timeOrigin === origin)
      && origin + values[0] >= request.timeOrigin + request.at && origin + values[2] <= request.timeOrigin + terminal[0].at, 'Inconsistent actual request clocks');
    const loaded = workerPhases.find(row => row.phase === 'module-ready'), ready = workerPhases.find(row => row.phase === 'backend-ready');
    requireValue(finite(loaded.atMs) && finite(ready.atMs) && loaded.atMs <= ready.atMs && ready.atMs <= values[0]
      && loaded.timeOrigin === origin && ready.timeOrigin === origin, 'Inconsistent actual preparation clocks');
    let exactPreparation = 0, preparationStart = null, previous = values[1];
    for (const row of engine) {
      requireValue(finite(row.atMs) && previous <= row.atMs && row.atMs <= values[2], 'Inconsistent engine phase clocks'); previous = row.atMs;
      if (['engine-runtime-loading', 'engine-symbolic-import'].includes(row.phase) && preparationStart === null) preparationStart = row.atMs;
      if (row.phase === 'engine-calculating' && preparationStart !== null) { exactPreparation += row.atMs - preparationStart; preparationStart = null; }
    }
    requireValue(preparationStart === null && stage.engineMatched === true && stage.exactEngineObserved === Boolean(engine.length), 'Incomplete engine preparation');
    const posted = request.timeOrigin + request.at, end = request.timeOrigin + terminal[0].at;
    const startup = Math.max(0, Math.min(end, origin + ready.atMs) - Math.max(posted, origin + loaded.atMs));
    const preparation = startup + values[1] - values[0] + exactPreparation, calculation = values[2] - values[1] - exactPreparation, total = terminal[0].at - request.at;
    const derived = [total, preparation, calculation, total - preparation - calculation];
    const actual = ['totalMs', 'preparationMs', 'calculationMs', 'waitingAndTransportMs'].map(name => stage[name]);
    const close = (a, b) => Math.abs(a - b) <= Math.max(1e-9 * Math.max(Math.abs(a), Math.abs(b)), 1e-6);
    requireValue(stage.worker && stage.key && actual.every(value => finite(value) && value >= 0)
      && close(actual[0], actual.slice(1).reduce((sum, value) => sum + value, 0)) && actual.every((value, index) => close(value, derived[index])), 'Invalid or overlapping stage partition');
  }
  requireValue(completed > 0, 'No complete request stage partition');
  return pairs;
}
function validateTypedPayload(node) {
  requireValue(Array.isArray(node) && node.length > 0 && typeof node[0] === 'string', 'Missing typed payload');
  const [tag, value] = node;
  if (['null', 'undefined', 'negative-zero'].includes(tag) && node.length === 1) return;
  requireValue(node.length === 2, 'Invalid payload arity');
  if ((tag === 'string' && typeof value === 'string') || (tag === 'boolean' && typeof value === 'boolean')
    || (tag === 'number' && finite(value) && !Object.is(value, -0))) return;
  if (tag === 'array' && Array.isArray(value)) { value.forEach(validateTypedPayload); return; }
  if (tag === 'record' && Array.isArray(value)) {
    const keys = [];
    for (const item of value) { requireValue(Array.isArray(item) && item.length === 2 && typeof item[0] === 'string', 'Invalid payload property'); keys.push(item[0]); validateTypedPayload(item[1]); }
    requireValue(equalRaw(keys, [...new Set(keys)].sort(unicodeOrder)), 'Duplicate or unordered payload property'); return;
  }
  throw new Error('Unsupported typed payload');
}
function typedFields(node) {
  validateTypedPayload(node); requireValue(node[0] === 'record', 'Expected payload record'); return Object.fromEntries(node[1]);
}
function validateRawWork(sample) {
  const pairs = requireRawCompleteStages(sample);
  for (const request of sample.transport) {
    if (request.event !== 'request') continue;
    const pair = pairs.get(request), envelope = typedFields(request.payload);
    requireValue(equalRaw(Object.keys(envelope).sort(), ['kind', 'request', 'serial']) && equalRaw(envelope.kind, ['string', request.kind])
      && equalRaw(envelope.serial, ['number', request.serial]), 'Actual envelope differs from transport');
    requireValue(['evaluate-math', 'sample-function-curve', 'sample-function-surface', 'sample-function-implicit-surface', 'sample-function-implicit-curve',
      'solve-function-points', 'solve-curve-points', 'solve-surface-points', 'continue-curve-point', 'continue-surface-point', 'continue-function-point'].includes(request.kind), 'Unsupported actual request kind');
    const fields = typedFields(envelope.request), observed = typedFields(fields.identity);
    const identityFields = Object.fromEntries(Object.entries(request.identity).map(([key, value]) => [key, [typeof value === 'string' ? 'string' : 'number', value]]));
    requireValue(equalRaw(observed, identityFields), 'Actual payload identity differs');
    for (const terminal of pair.events.filter(row => row.event === 'reply' && !nonterminal(row.kind))) {
      requireValue(Object.keys(typedFields(terminal.outcomePayload)).every(key => ['status', 'reason'].includes(key)), 'Invalid terminal outcome');
    }
  }
}

/** Flatten the actual Playwright JSON schema, retaining suite titles for network identity. */
export function readDedicatedPlaywrightTests(report) {
  requireValue(Array.isArray(report?.suites) && Array.isArray(report.errors) && report.errors.length === 0, 'Invalid/failed Playwright report');
  const rows = [];
  const visit = (suite, parents) => {
    const titles = [...parents, suite.title];
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      requireValue(test.expectedStatus === 'passed' && test.timeout === 180_000 && test.results?.length === 1,
        'Unexpected status, deadline or retried test');
      const result = test.results[0];
      requireValue(result.status === 'passed' && result.retry === 0 && result.errors?.length === 0, 'Failed/partial/retried test');
      rows.push({ titles, title: spec.title, project: test.projectName, result });
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  };
  for (const suite of report.suites) visit(suite, []);
  return rows;
}

function body(row, name) {
  const attachments = row.result.attachments.filter(item => item.name === name);
  requireValue(attachments.length === 1 && attachments[0].contentType === 'application/json'
    && typeof attachments[0].body === 'string', `Missing unique body attachment: ${name}`);
  return JSON.parse(Buffer.from(attachments[0].body, 'base64').toString('utf8'));
}

/** Descriptor is a caller's path/digest index, never a successful acceptance receipt. */
export async function loadDedicatedPerformanceEvidence(root, path, expectedSha256, sourceInputs) {
  const readInside = async name => {
    const target = resolve(root, name), actual = await realpath(target), rel = relative(root, actual);
    requireValue(actual === target && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Evidence leaves current root or is redirected');
    return readFile(target);
  };
  const bytes = await readInside(path);
  requireValue(/^[a-f0-9]{64}$/u.test(expectedSha256) && digest(bytes) === expectedSha256, 'Evidence index digest mismatch');
  const index = JSON.parse(bytes.toString('utf8')), records = {};
  requireValue(index && typeof index.records === 'object' && !Object.hasOwn(index, 'accepted'), 'Expected raw path/digest index');
  for (const [id, ref] of Object.entries(index.records)) {
    const value = await readInside(ref.path);
    requireValue(digest(value) === ref.sha256, `Raw digest mismatch: ${id}`);
    records[id] = { ...ref, path: resolve(root, ref.path), bytes: value };
  }
  const manifest = JSON.parse(records[index.manifest].bytes.toString('utf8')), currentInputs = {};
  requireValue(manifest.schema_version === 1 && Array.isArray(manifest.files), 'Expected actual QA input manifest');
  const relevant = new Set(['pnpm-lock.yaml', ...Object.keys(sourceInputs?.web ?? {}), ...Object.keys(sourceInputs?.desktop ?? {})]);
  for (const path of relevant) {
    requireValue(manifest.files.filter(row => row.path === path).length === 1, `Missing/duplicate relevant source path: ${path}`);
    currentInputs[path] = digest(await readInside(path));
  }
  return { ...index, records, currentInputs };
}

export function checkDedicatedPerformanceEvidence(kind, evidence, sourceInputs) {
  if (!evidence) return { status: 'pending', summary: 'Dedicated raw evidence is missing; publication blocked' };
  try {
    requireValue(kind === 'w21-dedicated' || kind === 'w22-dedicated', 'Unknown dedicated condition');
    const get = id => {
      const ref = evidence.records?.[id];
      requireValue(ref?.bytes && digest(ref.bytes) === ref.sha256, `Missing/changed raw bytes: ${id}`);
      return JSON.parse(Buffer.from(ref.bytes).toString('utf8'));
    };
    const manifestRef = evidence.records[evidence.manifest], manifest = get(evidence.manifest);
    requireValue(manifest.schema_version === 1 && Array.isArray(manifest.files) && manifest.files.length > 0, 'Invalid actual Source manifest');
    requireValue(evidence.currentInputs?.['pnpm-lock.yaml'] && manifest.files.some(row => row.path === 'pnpm-lock.yaml'
      && row.copy_sha256 === evidence.currentInputs['pnpm-lock.yaml']), 'Current lock identity missing/different');
    requireValue(sourceInputs?.web && sourceInputs?.desktop, 'Current release build inputs missing');
    for (const inputs of [sourceInputs.web, sourceInputs.desktop]) for (const [path, hash] of Object.entries(inputs)) {
      requireValue(evidence.currentInputs[path] === hash && manifest.files.some(row => row.path === path && row.copy_sha256 === hash), `Release build/Source identity differs: ${path}`);
    }
    const terminal = cell => {
      requireValue(get(cell.result).exitCode === 0, 'Failed/missing terminal run');
      const command = get(cell.command);
      requireValue(command.exclusive === true && command.manifestSha256 === manifestRef.sha256, 'Run not bound to exclusive current inputs');
      return command;
    };
    const sourceRecord = (id, path) => {
      const ref = evidence.records[id];
      requireValue(ref?.bytes && digest(ref.bytes) === ref.sha256
        && manifest.files.some(row => row.path === path && row.copy_sha256 === ref.sha256), `Unbound executed test source: ${path}`);
      return Buffer.from(ref.bytes).toString('utf8');
    };
    const freshBuild = cell => {
      const config = sourceRecord(cell.config, 'e2e/playwright.config.ts');
      requireValue(config.includes('pnpm --filter @pointercad/desktop run build && pnpm --filter @pointercad/web run build && pnpm --filter @pointercad/web run preview')
        && /reuseExistingServer:\s*false/u.test(config), 'Canonical fresh build/preview chain missing');
    };
    if (kind === 'w21-dedicated') {
      const cells = evidence.w21 ?? [];
      if (cells.length !== 3) return { status: 'pending', summary: 'W21 requires all three hosts and original thirty pairs' };
      const seen = new Set();
      for (const cell of cells) {
        terminal(cell);
        const rows = readDedicatedPlaywrightTests(get(cell.report));
        requireValue(rows.length === 10 && HOSTS.includes(cell.project) && !seen.has(cell.project), 'W21 incomplete/duplicate host');
        seen.add(cell.project);
        const sharedFlow = sourceRecord(cell.flow, 'e2e/tests/occtCompileReuseFlow.ts');
        requireValue(sharedFlow.includes('await compareInSecondWorker(page, info, mode, app)')
          && sharedFlow.includes('.toBeCloseTo(expected, 6)'), 'W21 original real geometry assertion source missing');
        let build;
        if (cell.project === 'electron') {
          const launch = get(cell.launch), after = get(cell.inputsAfter);
          freshBuild(cell);
          requireValue(launch.cwd === manifest.checkout && launch.manifestSha256 === manifestRef.sha256
            && launch.argv.includes('test:e2e') && launch.argv.includes('electron-occt-compile-reuse.spec.ts')
            && launch.argv.includes('--project=electron') && launch.playwrightJson === evidence.records[cell.report].path
            && after.allManifestInputsUnchanged === true && after.manifestSha256 === manifestRef.sha256
            && after.commandExitCode === 0 && after.playwrightExitCode === 0
            && after.playwrightJson === launch.playwrightJson
            && after.playwrightJsonSha256 === evidence.records[cell.report].sha256,
          'W21 actual Electron launch/current build/report binding failed');
          const helper = sourceRecord(cell.electronHelper, 'e2e/tests/electronAppFlow.ts');
          const flow = sourceRecord(cell.flow, 'e2e/tests/occtCompileReuseFlow.ts');
          sourceRecord(cell.spec, 'e2e/tests/electron-occt-compile-reuse.spec.ts');
          requireValue(helper.includes("join(root, 'apps/desktop/dist/main/main.cjs')")
            && flow.includes('await app?.close()') && flow.includes("const cold = await run('cold'), warm = await run('warm')"),
          'W21 actual freshly built Electron target/full restart connection missing');
        } else {
          sourceRecord(cell.spec, 'e2e/tests/occt-compile-reuse-solid.spec.ts');
          build = get(cell.build);
          requireValue(build.format === 'pointercad-web-build/1' && same(build.inputs, sourceInputs.web), 'W21 executed Web build inputs differ');
        }
        for (const network of ['online', 'offline']) {
          const group = rows.filter(row => row.project === cell.project && row.titles.some(title => title === `W21 actual ${cell.project === 'electron' ? 'app:// ' : ''}OCCT ${network}`));
          requireValue(group.length === 5 && new Set(group.map(row => row.title)).size === 5, 'W21 original network/five pairs incomplete');
          const fifth = group.find(row => row.title.startsWith('cold/warm pair 5/5:'));
          requireValue(fifth, 'W21 fifth pair missing');
          const pairs = body(fifth, 'five-pair-raw-measurements'), medians = body(fifth, 'five-pair-medians');
          requireValue(pairs.length === 5 && new Set(pairs.map(pair => pair.profile)).size === 5
            && same(pairs.map(pair => pair.index).sort(), [1, 2, 3, 4, 5]), 'W21 restart/profile pair population differs');
          const median = mode => pairs.map(pair => pair[mode].startupMs).sort((a, b) => a - b)[2];
          requireValue(medians.requiredRatio === 0.8 && medians.cold === median('cold') && medians.warm === median('warm')
            && medians.cold > 0 && medians.warm <= medians.cold * 0.8, 'W21 original twenty-percent condition failed');
          for (const row of group) for (const mode of ['cold', 'warm']) {
            if (cell.project !== 'electron') {
              const distribution = body(row, 'actual-distribution-identity');
              requireValue(distribution.buildSha256 === evidence.records[cell.build].sha256
                && Object.entries(build.outputs).every(([path, sha256]) => distribution.files.some(file => file.path === path && file.sha256 === sha256)), 'W21 served distribution differs from source-bound build');
            }
            const measured = body(row, `${mode}-occt-observation`), window = body(row, `${mode}-two-worker-window`);
            const index = Number(/^cold\/warm pair ([1-5])\/5:/u.exec(row.title)?.[1]);
            const recorded = pairs.find(pair => pair.index === index);
            requireValue(recorded?.offline === (network === 'offline') && recorded[mode].startupMs === measured.measured.startupMs
              && recorded[mode].sha256 === measured.measured.sha256 && recorded.cold.sha256 === recorded.warm.sha256,
            'W21 median population differs from individual actual measurements');
            requireValue(Array.isArray(body(row, `${mode}-closed-profile`)), 'W21 closed process profile evidence missing');
            requireValue(measured.offline === (network === 'offline') && measured.observation.errors.length === 0
              && measured.measured.stages.workers.length === 2 && measured.measured.sha256?.length === 64
              && window.overlap.end > window.overlap.start && window.twoWorkerResources.unavailable.length === 0
              && window.twoWorkerResources.frames > 1 && window.twoWorkerResources.cpuMilliseconds > 0
              && window.twoWorkerResources.peakWorkingSetBytes > 0 && window.twoWorkerResources.peakPrivateBytes > 0,
            'W21 original measured workers/geometry evidence incomplete');
          }
        }
      }
      return { status: 'pass', summary: 'All thirty original W21 pairs match current inputs, actual distribution or canonical Electron build, and original median criterion' };
    }
    const pairs = evidence.w22 ?? [], seen = new Set();
    if (pairs.length !== 12) return { status: 'pending', summary: 'W22 requires all twelve normal/slow pairs' };
    for (const cell of pairs) {
      const command = terminal(cell);
      requireValue(command.cpuHelperSha256 === 'c627c7999e12a503594128e7a4ab1266e9e7e6282e98385c09cb15e6b389faa4', 'W22 original physical-work qualifier differs');
      const pair = get(cell.pair), key = `${pair.project}/${pair.scenario}`;
      requireValue(HOSTS.includes(pair.project) && SCENARIOS.includes(pair.scenario) && !seen.has(key)
        && pair.manifestSha256 === manifestRef.sha256, 'W22 duplicate/foreign/incomplete cell');
      seen.add(key);
      const samples = [];
      for (const condition of ['normal', 'slow']) {
        const refs = cell[condition], run = get(refs.run), launch = get(refs.launch), attachment = get(refs.attachment);
        const unchanged = get(refs.inputsAfter);
        freshBuild(cell);
        requireValue(unchanged.allManifestInputsUnchanged === true && launch.cwd === manifest.checkout
          && launch.argv.includes('test:e2e') && launch.argv.includes(`--project=${pair.project}`)
          && launch.environment.VITE_PCAD_E2E === '1', 'Executed generation/owned launch binding incomplete');
        const sampleRef = evidence.records[refs.sample], reportRef = evidence.records[refs.report], sample = get(refs.sample);
        const rows = readDedicatedPlaywrightTests(get(refs.report)), job = run.owned_job, flags = condition === 'normal' ? 0 : 5, rate = condition === 'normal' ? 0 : 600;
        requireValue(run.schema === 'pcad-w22-owned-run-v1' && run.exit_code === 0 && run.error === null
          && run.condition === condition && run.project === pair.project && run.scenario === pair.scenario
          && run.manifestSha256 === manifestRef.sha256 && launch.manifestSha256 === manifestRef.sha256
          && run.nonce === launch.nonce && run.cpu_rate === rate, 'W22 actual owned-run identity failed');
        requireValue(job.nonce === run.nonce && job.assigned_before_resume === true && job.cleanup_complete === true && job.forced_owned_cleanup === false
          && job.errors.length === 0 && job.qualification.descendant_identity_complete === true
          && job.cpu_control.flags === flags && job.cpu_control.rate === rate && job.cpu_control.readback_confirmed === true
          && job.cpu_control.policy_checked_before_create === true && job.cpu_control.set_before_create === (condition === 'slow'), 'W22 original owned CPU/cleanup failed');
        requireValue(rows.length === 1 && rows[0].project === pair.project && attachment.sha256 === sampleRef.sha256
          && attachment.reportSha256 === reportRef.sha256 && attachment.path === sampleRef.path, 'W22 attachment/raw digest mapping differs');
        const listed = rows[0].result.attachments.filter(item => item.name === 'w22-measurement');
        requireValue(listed.length === 1 && listed[0].path === attachment.path, 'W22 reporter does not reference actual sample');
        requireValue(sample.schema === 'pcad-w22-measurement-v1' && sample.nonce === run.nonce && sample.condition === condition
          && sample.project === pair.project && sample.scenario === pair.scenario && sample.scenarioPassed === true
          && sample.scenarioTimeoutMs === 180_000 && sample.recomputeTimeoutMs === 150_000 && sample.overflow === false
          && sample.malformed === false && sample.errors.length === 0, 'W22 original scenario/nonce/deadline failed');
        requireValue(sample.files && Object.keys(sample.files).length > 0 && Object.entries(sample.files).every(([path, sha256]) => manifest.files.some(row => row.path === (path.includes('/') ? path : `e2e/tests/${path}`)
          && row.copy_sha256 === sha256)), 'W22 measured source fingerprints differ');
        requireValue(Array.isArray(sample.referenceMs) && sample.referenceMs.length > 0 && sample.referenceMs.every(value => Number.isFinite(value) && value > 0)
          && sample.paceMessageCount > 0 && sample.phaseMessageCount > 0
          && sample.transport.some(row => row.kind === 'math-pace')
          && sample.transport.filter(row => row.kind === 'math-pace').every(row => Number.isFinite(row.pace) && row.pace >= 1 && row.pace <= 4)
          && sample.phases.some(row => row.phase === 'backend-ready' && Number.isFinite(row.elapsedMs))
          && sample.phases.some(row => row.phase === 'request-start')
          && sample.phases.some(row => row.phase === 'request-end' && Number.isFinite(row.elapsedMs))
          && sample.requestIntervals.some(row => Number.isFinite(row.waitingBeforePaceMs) && Number.isFinite(row.calculationAndTransportMs)),
        'W22 original actual preparation/calculation/pace observations missing');
        const requests = sample.transport.filter(row => row.event === 'request');
        requireValue(requests.length > 0 && requests.length === sample.stageIntervals.length
          && sample.stageIntervals.some(stage => stage.complete === true)
          && requests.every(request => sample.stageIntervals.filter(stage => stage.hostTimeOrigin === request.timeOrigin
            && stage.hostWorker === request.worker && stage.occurrence === request.occurrence && same(stage.identity, request.identity)).length === 1),
        'W22 actual request/stage population is incomplete or ambiguous');
        requireValue(sample.stageIntervals.length > 0 && sample.stageIntervals.every(stage => stage.complete === true
          || stage.classification === 'cancelled-before-adoption'), 'W22 physical stage evidence incomplete');
        validateRawWork(sample);
        samples.push(sample);
      }
      requireValue(samples[0].inputSha256 && samples[0].inputSha256 === samples[1].inputSha256
        && samples[0].nonce !== samples[1].nonce, 'W22 original input/independent-run correspondence differs');
      requireValue(pair.originalR26CellConfirmed === true && pair.slowConditionConfirmed === true, 'W22 original owned pair qualification failed');
    }
    return { status: 'pass', summary: 'All twelve original W22 owned normal/slow cells match current product inputs and canonical fresh build' };
  } catch (error) {
    return { status: 'fail', summary: 'Dedicated raw evidence refused', problems: [String(error?.message ?? error)] };
  }
}
