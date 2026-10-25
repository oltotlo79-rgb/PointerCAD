import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ConsoleMessage, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { RECOMPUTE_TIMEOUT_MS } from '../../packages/test-utils/src/releasePerformance.js';
import { mathInputFlow } from './mathInputFlow.js';
import { functionVectorCalculusFlow } from './functionVectorCalculusFlow.js';
import { functionHyperbolicFlow } from './functionHyperbolicFlow.js';
import { functionDomainSurfaceFlow } from './functionPiecewiseDomainFlow.js';

export const W22_SCENARIOS = [
  { id: 'input', run: mathInputFlow },
  { id: 'ADD-23', run: functionVectorCalculusFlow },
  { id: 'ADD-17', run: functionHyperbolicFlow },
  { id: 'hemisphere', run: functionDomainSurfaceFlow },
] as const;
type Scenario = typeof W22_SCENARIOS[number];
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' ? value as RecordValue : null;

/** Runs in the page, including after reopen/reload. Never changes a message or a deadline. */
function installTransportObserver(): void {
  const marker = Symbol.for('pcad.w22.transport-observer');
  if (Reflect.get(globalThis, marker) === true) return;
  Reflect.set(globalThis, marker, true);
  Reflect.set(globalThis, Symbol.for('pcad.w22.completion-observer'), true);
  const original = Worker.prototype.postMessage, terminate = Worker.prototype.terminate;
  const workers = new WeakMap<Worker, { id: number; next: number; pending: { occurrence: number; serial: number; identity: unknown }[] }>();
  let nextWorker = 0;
  const asObject = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  const record = (data: object): void => {
    console.debug('[pcad:w22-transport]', JSON.stringify({
      timeOrigin: performance.timeOrigin, at: performance.now(), ...data,
    }));
  };
  // Typed trees distinguish absent properties, explicit undefined, -0 and user arrays/records.
  const encode = (value: unknown, ancestors = new Set<object>()): unknown => {
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Nonfinite payload number');
      return Object.is(value, -0) ? ['negative-zero'] : ['number', value];
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Unsupported or cyclic payload');
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Special payload prototype');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new Error('Symbol payload key');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(property => !Object.hasOwn(property, 'value'))) throw new Error('Accessor payload');
    ancestors.add(value);
    try {
      if (array) {
        if (keys.length !== value.length + 1 || !keys.includes('length')) throw new Error('Sparse or extended payload array');
        const entries: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const property = descriptors[String(index)];
          if (property === undefined) throw new Error('Sparse payload array');
          const item: unknown = property.value;
          entries.push(encode(item, ancestors));
        }
        return ['array', entries];
      }
      return ['record', (keys as string[]).sort().map(key => {
        const item: unknown = descriptors[key]?.value;
        return [key, encode(item, ancestors)];
      })];
    } finally { ancestors.delete(value); }
  };
  const observationFailure = (): void => {
    Reflect.set(globalThis, Symbol.for('pcad.w22.observation-failed'), true);
    try { record({ event: 'observation-error', reason: 'unsupported-or-failed-payload-observation' }); }
    catch { /* A missing request/phase also refuses qualification if console itself fails. */ }
  };
  const identityKey = (value: unknown): string => {
    const row = asObject(value);
    return JSON.stringify([row?.documentId, row?.documentVersion, row?.editorId, row?.inputRevision]);
  };
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
    try {
      const request = asObject(args[0]);
      const kind: unknown = request === null ? undefined : Object.getOwnPropertyDescriptor(request, 'kind')?.value;
      const serial: unknown = request === null ? undefined : Object.getOwnPropertyDescriptor(request, 'serial')?.value;
      if (request !== null && typeof kind === 'string' && typeof serial === 'number') {
        const payload = encode(request);
        let state = workers.get(this);
        if (state === undefined) {
          state = { id: ++nextWorker, next: 0, pending: [] };
          workers.set(this, state);
          const current = state;
          this.addEventListener('message', event => {
            try {
              const reply = asObject(event.data);
              if (reply === null) { record({ event: 'messageerror', worker: current.id }); return; }
              const result = asObject(reply.result ?? reply.evaluation);
              const outcome: Record<string, unknown> = {};
              if (result !== null) for (const key of ['status', 'reason']) {
                const property = Object.getOwnPropertyDescriptor(result, key);
                if (property === undefined) continue;
                if (!Object.hasOwn(property, 'value')) throw new Error('Accessor outcome');
                const value: unknown = property.value;
                outcome[key] = value;
              }
              // The group can synchronously post its next work before this listener sees the old reply.
              // Only the FIFO head owns this delivery; never clear the newest posted request.
              const head = current.pending[0];
              const terminal = !['math-phase', 'math-pace', 'math-worker-retire'].includes(String(reply.kind));
              record({ event: 'reply', worker: current.id, kind: reply.kind, serial: reply.serial,
                identity: reply.identity,
                occurrence: head?.occurrence ?? null,
                pace: reply.pace, phase: reply.phase, status: result?.status, reason: result?.reason,
                outcomePayload: encode(outcome) });
              if (terminal && head !== undefined && reply.serial === head.serial
                && identityKey(reply.identity) === identityKey(head.identity)) current.pending.shift();
            } catch { observationFailure(); }
          }, { capture: true });
          this.addEventListener('error', event => record({ event: 'error', worker: current.id, message: event.message }));
          this.addEventListener('messageerror', () => record({ event: 'messageerror', worker: current.id }));
        }
        const occurrence = ++state.next;
        state.pending.push({ occurrence, serial, identity: asObject(request.request)?.identity });
        record({ event: 'request', worker: state.id, kind, serial,
          occurrence, identity: asObject(request.request)?.identity, payload });
      }
    } catch { observationFailure(); }
    Reflect.apply(original, this, args);
  };
  Worker.prototype.terminate = function (this: Worker): void {
    try {
      const worker = workers.get(this);
      if (worker !== undefined) record({ event: 'terminate', worker: worker.id,
        pendingOccurrences: worker.pending.map(row => row.occurrence) });
    } catch { observationFailure(); }
    Reflect.apply(terminate, this, []);
  };
}

/** Host-delivery intervals, including scheduling/transport; never claimed as CPU execution time. */
function intervals(records: readonly RecordValue[]): RecordValue[] {
  const requests = new Map<string, { request: RecordValue; pace: number | null; firstPhase: number | null; calculating: number | null }>();
  const result: RecordValue[] = [];
  for (const record of records) {
    if (typeof record.at !== 'number') continue;
    const key = `${String(record.timeOrigin)}/${String(record.worker)}/${String(record.occurrence)}`;
    if (record.event === 'request') {
      requests.set(key, { request: record, pace: null, firstPhase: null, calculating: null });
      continue;
    }
    const pending = requests.get(key);
    if (pending === undefined) continue;
    if (record.kind === 'math-pace') {
      pending.pace ??= record.at;
    } else if (record.kind === 'math-phase') {
      pending.firstPhase ??= record.at;
      if (record.phase === 'calculating') pending.calculating ??= record.at;
    } else if (record.event === 'reply' && typeof record.serial === 'number') {
      const start = pending.request.at;
      if (typeof start !== 'number') throw new Error('Missing observed request timestamp');
      result.push({ key, kind: pending.request.kind, terminalKind: record.kind, status: record.status,
        totalMs: record.at - start,
        waitingBeforePaceMs: pending.pace === null ? null : pending.pace - start,
        exactPreparationMs: pending.firstPhase === null || pending.calculating === null ? null : pending.calculating - pending.firstPhase,
        calculationAndTransportMs: pending.pace === null ? null : record.at - pending.pace,
        exactCalculationAndTransportMs: pending.calculating === null ? null : record.at - pending.calculating });
      requests.delete(key);
    }
  }
  for (const [key, value] of requests) result.push({ key, kind: value.request.kind, incomplete: true,
    totalMs: null, waitingBeforePaceMs: null, exactPreparationMs: null,
    calculationAndTransportMs: null, exactCalculationAndTransportMs: null });
  return result;
}

function requestKey(row: RecordValue): string | null {
  const identity = object(row.identity);
  if (typeof row.serial !== 'number' || !Number.isSafeInteger(row.serial) || identity === null || typeof identity.documentId !== 'string'
    || typeof identity.documentVersion !== 'number' || typeof identity.editorId !== 'string'
    || typeof identity.inputRevision !== 'number' || !Number.isSafeInteger(identity.documentVersion)
    || !Number.isSafeInteger(identity.inputRevision)) return null;
  return JSON.stringify([row.serial, identity.documentId, identity.documentVersion, identity.editorId, identity.inputRevision]);
}

type Occurrence = { request: RecordValue; events: RecordValue[]; phases: RecordValue[]; completion?: RecordValue; cancellation?: RecordValue };
/** Independently check the observer's occurrence labels against actual FIFO delivery. */
function pairOccurrences(transport: readonly RecordValue[], phases: readonly RecordValue[], clients: readonly RecordValue[], editors: readonly RecordValue[]): Map<RecordValue, Occurrence> {
  const hosts = new Map<string, { all: Occurrence[]; pending: Occurrence[]; at: number; terminated: boolean }>();
  const pairs = new Map<RecordValue, Occurrence>();
  for (const row of transport) {
    if (typeof row.timeOrigin !== 'number' || !Number.isFinite(row.timeOrigin) || typeof row.at !== 'number'
      || !Number.isFinite(row.at) || typeof row.worker !== 'number' || !Number.isSafeInteger(row.worker) || row.worker < 1) throw new Error('Invalid transport clock/Worker');
    const hostKey = JSON.stringify([row.timeOrigin, row.worker]);
    let host = hosts.get(hostKey);
    if (host === undefined && row.event !== 'request') throw new Error('Orphan transport event');
    if (host === undefined) { host = { all: [], pending: [], at: -Infinity, terminated: false }; hosts.set(hostKey, host); }
    if (row.at < host.at || (host.terminated && row.event !== 'reply')) throw new Error('Transport order after termination');
    host.at = row.at;
    if (row.event === 'request') {
      if (requestKey(row) === null || row.occurrence !== host.all.length + 1) throw new Error('Invalid actual occurrence');
      const pair = { request: row, events: [], phases: [] };
      host.all.push(pair); host.pending.push(pair); pairs.set(row, pair);
    } else if (row.event === 'terminate') {
      if (JSON.stringify(row.pendingOccurrences) !== JSON.stringify(host.pending.map(pair => pair.request.occurrence))) throw new Error('Unproven termination');
      for (const pair of host.pending) pair.events.push(row);
      // Production onmessage can terminate before our later listener observes its terminal.
      // Retain pending deliveries; an actual matching terminal still wins over cancellation.
      host.terminated = true;
    } else if (row.event === 'reply') {
      const head = host.pending[0];
      if (row.kind === 'math-failed' || typeof row.kind !== 'string') throw new Error('Failed or invalid reply');
      if (head === undefined || row.occurrence !== head.request.occurrence) throw new Error('Unmatched or stale delivery');
      if (row.kind !== 'math-pace' && row.kind !== 'math-worker-retire' && requestKey(row) !== requestKey(head.request)) throw new Error('Reply identity mismatch');
      head.events.push(row);
      if (!['math-pace', 'math-phase', 'math-worker-retire'].includes(String(row.kind))) host.pending.shift();
    } else throw new Error('Invalid or failed transport event');
  }
  const usedClients = new Set<string>();
  if (clients.some(row => requestKey(row) === null || typeof row.client !== 'number' || !Number.isSafeInteger(row.client) || row.client < 1
    || typeof row.timeOrigin !== 'number' || !Number.isFinite(row.timeOrigin) || typeof row.at !== 'number' || !Number.isFinite(row.at)
    || !['dispatch', 'dispatched', 'complete', 'finished'].includes(String(row.event))
    || ((row.event === 'complete' || row.event === 'finished') && !['result', 'cancelled', 'disposed'].includes(String(row.status))))) throw new Error('Invalid or failed client evidence');
  if (editors.some(row => requestKey({ ...row, serial: 0 }) === null || typeof row.session !== 'number' || !Number.isSafeInteger(row.session) || row.session < 1
    || typeof row.timeOrigin !== 'number' || !Number.isFinite(row.timeOrigin) || typeof row.at !== 'number' || !Number.isFinite(row.at)
    || !['abort', 'discard', 'apply'].includes(String(row.event)))) throw new Error('Invalid editor evidence');
  for (const pair of pairs.values()) {
    const request = pair.request, key = requestKey(request);
    const matches = clients.filter(row => row.event === 'dispatch' && requestKey(row) === key
      && row.timeOrigin === request.timeOrigin && typeof row.at === 'number' && row.at <= Number(request.at))
      .filter(dispatch => clients.some(row => row.client === dispatch.client && row.serial === dispatch.serial
        && row.timeOrigin === dispatch.timeOrigin && row.event === 'complete' && typeof row.at === 'number' && row.at >= Number(request.at)));
    if (matches.length !== 1) throw new Error('Missing or ambiguous actual client');
    const dispatch = matches[0]!;
    const clientKey = JSON.stringify([dispatch.timeOrigin, dispatch.client, dispatch.serial]);
    if (usedClients.has(clientKey)) throw new Error('Client occurrence reused');
    usedClients.add(clientKey);
    const same = clients.filter(row => row.timeOrigin === dispatch.timeOrigin && row.client === dispatch.client && row.serial === dispatch.serial);
    const boundaries = ['dispatch', 'dispatched', 'complete', 'finished'].map(event => same.filter(row => row.event === event));
    if (boundaries.some(rows => rows.length !== 1) || same.length !== 4 || same.some(row => requestKey(row) !== key
      || typeof row.at !== 'number' || !Number.isFinite(row.at))) throw new Error('Missing actual client boundary');
    const posted = boundaries[1]![0]!, completion = boundaries[2]![0]!, finished = boundaries[3]![0]!;
    if (!(Number(dispatch.at) <= Number(posted.at) && Number(posted.at) <= Number(completion.at) && Number(completion.at) <= Number(finished.at))
      || completion.status !== finished.status || completion.replaceWorker !== finished.replaceWorker) throw new Error('Client completion order');
    pair.completion = completion;
    if (completion.status === 'result') continue;
    if (!['cancelled', 'disposed'].includes(String(completion.status)) || completion.replaceWorker !== true) throw new Error('Failed actual client completion');
    const termination = pair.events.filter(row => row.event === 'terminate' && Number(row.at) >= Number(completion.at) && Number(row.at) <= Number(finished.at));
    const editorIdentity = (row: RecordValue): string | null => requestKey({ ...row, serial: request.serial });
    const evidence = editors.filter(row => row.timeOrigin === request.timeOrigin && editorIdentity(row) === key
      && typeof row.at === 'number' && Number.isFinite(row.at));
    const aborts = evidence.filter(row => row.event === 'abort' && Number(row.at) <= Number(completion.at) && Number(row.at) >= Number(dispatch.at));
    const discards = evidence.filter(row => row.event === 'discard' && Number(row.at) >= Number(finished.at));
    const documentMath = object(request.identity)?.editorId === 'document-math';
    if (termination.length !== 1 || (!documentMath && (aborts.length !== 1 || discards.length !== 1 || aborts[0]?.session !== discards[0]?.session))
      || evidence.some(row => row.event === 'apply' && Number(row.at) >= Number(dispatch.at))) throw new Error('Unproven cancellation/non-adoption');
    pair.cancellation = { client: completion.client, status: completion.status, completedAt: completion.at,
      finishedAt: finished.at, terminationAt: termination[0]?.at, nonAdoption: documentMath ? 'document-math-non-result-branch' : 'editor-discard',
      editorSession: documentMath ? null : aborts[0]?.session,
      abortAt: documentMath ? null : aborts[0]?.at, discardAt: documentMath ? null : discards[0]?.at };
  }
  const groups = new Map<string, RecordValue[][]>();
  for (const row of phases) {
    if (row.failed === true) throw new Error('Failed Worker request');
    if (row.phase === 'module-ready' || row.phase === 'backend-ready') continue;
    if (typeof row.worker !== 'string' || !row.worker || typeof row.atMs !== 'number' || !Number.isFinite(row.atMs)
      || typeof row.timeOrigin !== 'number' || !Number.isFinite(row.timeOrigin)) throw new Error('Invalid phase clock/Worker');
    let worker = groups.get(row.worker);
    if (worker === undefined) { worker = []; groups.set(row.worker, worker); }
    const precedingGroup = worker[worker.length - 1];
    const preceding = precedingGroup?.[precedingGroup.length - 1];
    if (preceding !== undefined && (row.timeOrigin !== preceding.timeOrigin || row.atMs < Number(preceding.atMs))) throw new Error('Phase clock order');
    if (row.phase === 'request-received') worker.push([]);
    const group = worker[worker.length - 1];
    if (group === undefined) throw new Error('Orphan request phase');
    group.push(row);
  }
  const used = new Set<string>();
  for (const host of hosts.values()) {
    const candidates = [...groups].filter(([, rows]) => rows.length <= host.all.length && rows.every((group, index) => {
      const pair = host.all[index], received = group[0], end = pair?.events[pair.events.length - 1];
      return pair !== undefined && received !== undefined && end !== undefined
        && group.every(row => requestKey(row) === requestKey(pair.request))
        && Number(received.timeOrigin) + Number(received.atMs) >= Number(pair.request.timeOrigin) + Number(pair.request.at)
        && (pair.cancellation !== undefined || Number(received.timeOrigin) + Number(received.atMs) <= Number(pair.request.timeOrigin) + Number(end.at));
    }) && host.all.slice(rows.length).every(pair => pair.events.some(row => row.event === 'terminate')));
    if (candidates.length === 0 && host.all.every(pair => pair.events.some(row => row.event === 'terminate'))) continue;
    if (candidates.length !== 1) throw new Error('Missing or ambiguous Worker occurrence sequence');
    const candidate = candidates[0];
    if (candidate === undefined || used.has(candidate[0])) throw new Error('Worker reused across hosts');
    used.add(candidate[0]);
    candidate[1].forEach((rows, index) => { const pair = host.all[index]; if (pair !== undefined) pair.phases = rows; });
  }
  if (used.size !== groups.size) throw new Error('Unmatched diagnostic Worker');
  for (const pair of pairs.values()) {
    const pace = pair.events.filter(row => row.kind === 'math-pace');
    const termination = pair.events.find(row => row.event === 'terminate');
    const terminal = pair.events.find(row => row.event === 'reply' && !['math-pace', 'math-phase', 'math-worker-retire'].includes(String(row.kind)));
    const terminated = pair.cancellation !== undefined;
    const start = pair.phases.filter(row => row.phase === 'request-start');
    const engine = pair.phases.filter(row => String(row.phase).startsWith('engine-'));
    const progress = pair.events.filter(row => row.kind === 'math-phase');
    if (!terminated && ((pace.length > 0 && pair.phases.length === 0) || engine.length !== progress.length
      || engine.some((row, index) => row.phase !== `engine-${String(progress[index]?.phase)}`))) throw new Error('Missing actual request phase');
    if (terminated && (progress.length > engine.length || progress.some((row, index) => engine[index]?.phase !== `engine-${String(row.phase)}`)
      || ['request-received', 'request-start', 'reply-ready', 'request-end'].some(name => pair.phases.filter(row => row.phase === name).length > 1))) throw new Error('Ambiguous cancelled phase');
    if (pace.length > 1 || (!terminated && pace.length !== 1) || (pace.length === 1 &&
      (typeof pace[0]?.pace !== 'number' || !Number.isFinite(pace[0].pace) || Number(pace[0].pace) < 1 || Number(pace[0].pace) > 4
        || (!terminated && start.length !== 1) || start.length > 1 || (start.length > 0 && pace[0].pace !== start[0]?.pace)))) throw new Error('Ambiguous pace delivery');
    if (!terminated && termination !== undefined && terminal === undefined) throw new Error('Unproven termination');
    // The passive capture listener and the production onmessage callback can run in
    // either order. Their timestamps share the host clock, but neither callback is
    // causally required to precede the other. Keep the independently matched client
    // completion and the Worker's reply-ready boundary; do not add a clock tolerance.
    if (!terminated && (terminal === undefined || pair.completion === undefined
      || pair.phases.some(row => row.phase === 'reply-ready' && Number(row.timeOrigin) + Number(row.atMs)
        > Number(pair.request.timeOrigin) + Number(pair.completion?.at)))) throw new Error('Client/Worker result clock mismatch');
  }
  return pairs;
}

/** Partition one observed post-to-reply interval. No phase is borrowed from another request/Worker. */
function stageIntervals(transport: readonly RecordValue[], phases: readonly RecordValue[], clients: readonly RecordValue[], editors: readonly RecordValue[]): RecordValue[] {
  const result: RecordValue[] = [];
  let pairs: Map<RecordValue, Occurrence>;
  try { pairs = pairOccurrences(transport, phases, clients, editors); }
  catch (error) { return transport.filter(row => row.event === 'request').map(row => ({
    hostWorker: row.worker, hostTimeOrigin: row.timeOrigin, occurrence: row.occurrence,
    serial: row.serial, identity: row.identity, complete: false, reason: String(error) })); }
  for (const request of transport.filter(row => row.event === 'request')) {
    const key = requestKey(request);
    const transportKey = JSON.stringify([request.timeOrigin, request.worker, request.occurrence]);
    const pair = pairs.get(request);
    const related = pair?.events ?? [];
    const requests = [request];
    const terminals = related.filter(row => row.event === 'reply'
      && !['math-phase', 'math-pace', 'math-worker-retire'].includes(String(row.kind)));
    const diagnostic = { key, transportKey, hostWorker: request.worker, hostTimeOrigin: request.timeOrigin,
      serial: request.serial, occurrence: request.occurrence, identity: request.identity, complete: false };
    if (pair?.cancellation !== undefined) {
      result.push({ ...diagnostic, classification: 'cancelled-before-adoption', cancellation: pair.cancellation,
        terminalObserved: terminals.length === 1, observedPhases: pair.phases }); continue;
    }
    if (requests.length !== 1 || key === null || typeof request.worker !== 'number' || !Number.isSafeInteger(request.worker) || request.worker < 1) {
      result.push({ ...diagnostic, reason: 'invalid-or-duplicate-request' }); continue;
    }
    const terminal = terminals[0];
    const receivedRows = (pair?.phases ?? []).filter(row => row.phase === 'request-received' && requestKey(row) === key
      && typeof row.timeOrigin === 'number' && typeof row.atMs === 'number'
      && typeof request.timeOrigin === 'number' && typeof request.at === 'number' && typeof terminal?.at === 'number'
      && row.timeOrigin + row.atMs >= request.timeOrigin + request.at
      && row.timeOrigin + row.atMs <= request.timeOrigin + terminal.at);
    const received = receivedRows[0];
    if (receivedRows.length !== 1 || received === undefined || typeof received.worker !== 'string' || received.worker.length === 0
      || terminals.length !== 1 || terminal === undefined || requestKey(terminal) !== key) {
      result.push({ ...diagnostic, reason: 'missing-or-ambiguous-receive-or-terminal' }); continue;
    }
    const same = pair?.phases ?? [];
    const starts = same.filter(row => row.phase === 'request-start'), replies = same.filter(row => row.phase === 'reply-ready');
    const ends = same.filter(row => row.phase === 'request-end');
    const module = phases.filter(row => row.worker === received.worker && row.phase === 'module-ready');
    const backend = phases.filter(row => row.worker === received.worker && row.phase === 'backend-ready');
    const unique = [starts, replies, ends, module, backend].every(rows => rows.length === 1);
    if (!unique) {
      result.push({ ...diagnostic, complete: false, reason: 'missing-or-ambiguous-boundary',
        counts: [requests.length, starts.length, replies.length, module.length, backend.length, terminals.length] });
      continue;
    }
    const start = starts[0], reply = replies[0], ready = backend[0], loaded = module[0], requestEnd = ends[0];
    if (start === undefined || reply === undefined || ready === undefined || loaded === undefined || requestEnd === undefined || terminal === undefined) {
      result.push({ ...diagnostic, reason: 'missing-boundary' }); continue;
    }
    const numbers = [request.at, request.timeOrigin, terminal.at, received.atMs, received.timeOrigin,
      start.atMs, reply.atMs, loaded.atMs, ready.atMs, requestEnd.atMs];
    if (!numbers.every(value => typeof value === 'number' && Number.isFinite(value))) {
      result.push({ ...diagnostic, complete: false, reason: 'missing-clock' }); continue;
    }
    // Number() only follows a finite-number check; never turns a missing reading into zero.
    const posted = Number(request.at) + Number(request.timeOrigin);
    const origin = Number(received.timeOrigin), end = Number(terminal.at) + Number(request.timeOrigin);
    const receivedAt = Number(received.atMs), startAt = Number(start.atMs), replyAt = Number(reply.atMs);
    const moduleAt = Number(loaded.atMs), readyAt = Number(ready.atMs);
    let exactPreparationMs = 0, preparationStart: number | null = null, ordered = true, previous = startAt;
    const engine = same.filter(row => typeof row.phase === 'string' && row.phase.startsWith('engine-'));
    const progress = related.filter(row => row.event === 'reply' && row.kind === 'math-phase' && row.serial === request.serial);
    const engineMatched = engine.length === progress.length && engine.every((row, index) =>
      row.phase === `engine-${String(progress[index]?.phase)}` && requestKey(progress[index]!) === key);
    for (const phase of engine) {
      if (typeof phase.atMs !== 'number' || !Number.isFinite(phase.atMs) || phase.atMs < previous || phase.atMs > replyAt) {
        ordered = false; break;
      }
      previous = phase.atMs;
      if (phase.phase === 'engine-runtime-loading' || phase.phase === 'engine-symbolic-import') preparationStart ??= phase.atMs;
      if (phase.phase === 'engine-calculating' && preparationStart !== null) {
        exactPreparationMs += phase.atMs - preparationStart; preparationStart = null;
      }
    }
    const startupPreparationMs = Math.max(0, Math.min(end, origin + readyAt) - Math.max(posted, origin + moduleAt));
    const pacePreparationMs = startAt - receivedAt;
    const calculationMs = replyAt - startAt - exactPreparationMs;
    const preparationMs = startupPreparationMs + pacePreparationMs + exactPreparationMs;
    const totalMs = Number(terminal.at) - Number(request.at);
    const waitingAndTransportMs = totalMs - preparationMs - calculationMs;
    const complete = engineMatched && ordered && preparationStart === null && moduleAt <= readyAt && readyAt <= receivedAt
      && receivedAt <= startAt && startAt <= replyAt
      && Number(requestEnd.atMs) >= replyAt && same.every(row => row.timeOrigin === received.timeOrigin)
      && loaded.timeOrigin === received.timeOrigin && ready.timeOrigin === received.timeOrigin
      && origin + receivedAt >= posted && origin + replyAt <= end
      && [totalMs, preparationMs, calculationMs, waitingAndTransportMs].every(value => Number.isFinite(value) && value >= 0);
    result.push({ ...diagnostic, worker: received.worker, classification: 'completed', complete,
      reason: complete ? null : 'inconsistent-clock-or-phase-order', engineMatched,
      // Signed host-local observation difference, not Worker execution/transport time.
      deliveryObservation: { transportReplyAt: Number(terminal.at), clientCompleteAt: Number(pair?.completion?.at),
        clientMinusTransportMs: Number(pair?.completion?.at) - Number(terminal.at) },
      totalMs, preparationMs, calculationMs, waitingAndTransportMs, startupPreparationMs, pacePreparationMs,
      exactPreparationMs, exactEngineObserved: engine.length > 0,
      boundaries: { posted, moduleAt: origin + moduleAt, readyAt: origin + readyAt,
        receivedAt: origin + receivedAt, startAt: origin + startAt, replyAt: origin + replyAt, end } });
  }
  for (const row of result.filter(row => row.classification === 'completed')) {
    const host = JSON.stringify([row.hostTimeOrigin, row.hostWorker]);
    if (result.some(other => other.classification === 'completed' &&
      ((other.worker === row.worker && JSON.stringify([other.hostTimeOrigin, other.hostWorker]) !== host)
        || (JSON.stringify([other.hostTimeOrigin, other.hostWorker]) === host && other.worker !== row.worker)))) {
      row.complete = false; row.reason = 'ambiguous-worker-correspondence';
    }
  }
  return result;
}

/** Kept identical across conditions; hashes cover inputs, assertions and measurement implementation. */
async function inputFingerprint(): Promise<{ inputSha256: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  for (const name of ['mathPaceSlowFlow.ts', 'mathInputFlow.ts', 'mathCoordinateFlow.ts', 'mathStatisticsFlow.ts', 'mathBinomialFlow.ts',
    'functionVectorCalculusFlow.ts', 'functionHyperbolicFlow.ts', 'functionPiecewiseDomainFlow.ts',
    'mathEditorReady.ts', 'waitForFunctionPreview.ts', 'recompute.ts', 'scriptsFlow.ts', 'reopenPart.ts']) {
    files[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
  }
  files['packages/ui/src/math/math.worker.ts'] = createHash('sha256')
    .update(await readFile(new URL('../../packages/ui/src/math/math.worker.ts', import.meta.url))).digest('hex');
  for (const name of ['packages/expression/src/math/boundedCalculationClient.ts', 'packages/ui/src/math/mathEditorSession.ts',
    'packages/model/src/part/evaluateDocumentMath.ts', 'packages/ui/src/math/recomputePartWithMath.ts']) {
    files[name] = createHash('sha256').update(await readFile(new URL(`../../${name}`, import.meta.url))).digest('hex');
  }
  return { files, inputSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export async function mathPaceSlowFlow(page: Page, info: TestInfo, scenario: Scenario, app?: ElectronApplication,
  open?: () => Promise<void>): Promise<void> {
  // Ordinary suite runs still execute all assertions; only owned paired runs can qualify W22.
  const condition = process.env.PCAD_W22_CONDITION ?? 'uncontrolled', nonce = process.env.PCAD_W22_NONCE ?? null;
  if (condition !== 'uncontrolled' && ((condition !== 'normal' && condition !== 'slow') || !nonce)) {
    throw new Error('Use the Root-owned W22 runner for explicit normal/slow conditions');
  }
  expect(info.timeout, 'Original scenario deadline').toBe(180_000);
  expect(RECOMPUTE_TIMEOUT_MS, 'Original recompute deadline').toBe(150_000);
  const fingerprint = await inputFingerprint();
  const transport: RecordValue[] = [], phases: RecordValue[] = [], clients: RecordValue[] = [], editors: RecordValue[] = [], errors: string[] = [];
  let overflow = false, malformed = false, passed = false;
  const listen = (message: ConsoleMessage): void => {
    const text = message.text();
    const prefix = text.startsWith('[pcad:w22-transport]') ? '[pcad:w22-transport]' :
      text.startsWith('[pcad:math-phase]') ? '[pcad:math-phase]' :
      text.startsWith('[pcad:math-client]') ? '[pcad:math-client]' : text.startsWith('[pcad:math-editor]') ? '[pcad:math-editor]' : null;
    if (prefix === null) return;
    if (transport.length + phases.length + clients.length + editors.length >= 10_000) { overflow = true; return; }
    try {
      const value = object(JSON.parse(text.slice(prefix.length).trim()));
      if (value === null) { malformed = true; return; }
      if (value.event === 'observation-error') malformed = true;
      (prefix === '[pcad:w22-transport]' ? transport : prefix === '[pcad:math-phase]' ? phases :
        prefix === '[pcad:math-client]' ? clients : editors).push({ receivedAt: Date.now(), ...value });
    } catch { malformed = true; }
  };
  const onError = (error: Error): void => { errors.push(error.message); };
  page.on('console', listen); page.on('pageerror', onError);
  const startedAt = new Date().toISOString(), start = performance.now();
  try {
    await page.addInitScript(installTransportObserver);
    await page.evaluate(installTransportObserver);
    await open?.();
    await scenario.run(page, info, app);
    expect(await page.evaluate(() => Reflect.get(globalThis, Symbol.for('pcad.w22.observation-failed')) === true),
      'Payload observer failed; evidence refused').toBe(false);
    expect(errors).toEqual([]);
    expect(overflow, 'Observation capacity exceeded; measurement incomplete').toBe(false);
    expect(malformed, 'Malformed observed records').toBe(false);
    expect(transport.some(row => row.kind === 'math-pace')).toBe(true);
    expect(phases.some(row => row.phase === 'backend-ready' && typeof row.referenceMs === 'number' && row.referenceMs > 0)).toBe(true);
    expect(phases.some(row => row.phase === 'request-start')).toBe(true);
    expect(phases.some(row => row.phase === 'request-end' && typeof row.elapsedMs === 'number')).toBe(true);
    expect(intervals(transport).some(row => typeof row.waitingBeforePaceMs === 'number' && typeof row.calculationAndTransportMs === 'number')).toBe(true);
    const stages = stageIntervals(transport, phases, clients, editors);
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.filter(row => row.classification === 'completed').length).toBeGreaterThan(0);
    expect(stages.every(row => row.complete === true || row.classification === 'cancelled-before-adoption'),
      'Every actual request must have complete timing or actual active-request termination').toBe(true);
    passed = true;
  } finally {
    page.off('console', listen); page.off('pageerror', onError);
    const measurement = { schema: 'pcad-w22-measurement-v1', nonce, condition, project: info.project.name,
      scenario: scenario.id, ...fingerprint, startedAt, finishedAt: new Date().toISOString(),
      elapsedMs: performance.now() - start, scenarioPassed: passed, scenarioTimeoutMs: info.timeout,
      recomputeTimeoutMs: RECOMPUTE_TIMEOUT_MS, overflow, malformed, errors,
      // backend-ready is one actual measurement per initialized Worker, not cached per-request repetitions.
      referenceMs: phases.filter(row => row.phase === 'backend-ready').map(row => row.referenceMs),
      paceMessageCount: transport.filter(row => row.kind === 'math-pace').length,
      phaseMessageCount: phases.length,
      exactPhaseMessageCount: transport.filter(row => row.kind === 'math-phase').length,
      preparationSamples: phases.filter(row => row.phase === 'backend-ready'),
      calculationSamples: phases.filter(row => row.phase === 'request-end'),
      intervalMeaning: 'stageIntervals partitions one post-to-reply interval by exact serial/identity and diagnostic Worker UUID. Preparation includes overlapping module/backend initialization, request pace preparation and observed exact runtime/import preparation. Calculation excludes these preparation intervals. Waiting/transport is the non-overlapping residual, including uninstrumented pre-module load/scheduling/serialization; it is not pure CPU idle. Pre-postMessage queue waiting is unobserved. requestIntervals is separate raw host transport evidence and must not be summed with stageIntervals.',
      stageIntervals: stageIntervals(transport, phases, clients, editors),
      requestIntervals: intervals(transport), transport, phases, clients, editors };
    const path = info.outputPath('w22-measurement.json');
    await writeFile(path, JSON.stringify(measurement, null, 2), { flag: 'wx' });
    // outputPath is permanent and already saved; avoid copying it again under the body deadline.
    info.attachments.push({ name: 'w22-measurement', path, contentType: 'application/json' });
  }
}
