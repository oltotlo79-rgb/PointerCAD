import {MathWorkerClient, type MathWorkerPort, type MathWorkRequest} from '@pointercad/expression/math/client';
import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import {createBrowserMathWorker} from './browserMathWorker.js';

type Completion = Awaited<ReturnType<MathWorkerClient['evaluate']>>;
type Result = Extract<Completion, { readonly status: 'result' }>['result'];
/** Values of identical requests; each reader receives its own copy. */
export interface MathResultMemory {
  get(key: string): Result | undefined;
  remember(key: string, result: Result): void;
}
const MEMORY_ENTRIES = 64;
const MEMORY_ENTRY_CHARACTERS = 65_536;
const KEY_DEPTH = 64;

function plainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return !Array.isArray(value) && (prototype === Object.prototype || prototype === null);
}
/** Serialize plain request data with sorted keys; anything else (a class instance, a function, a
 * non-finite number or negative zero, which JSON would conflate) is never remembered. */
function canonical(value: unknown, depth: number): string | null {
  if (depth > KEY_DEPTH) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : null;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) { const text = canonical(item, depth + 1); if (text === null) return null; items.push(text); }
    return `[${items.join(',')}]`;
  }
  if (!plainRecord(value)) return null;
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field === undefined) continue;
    const text = canonical(field, depth + 1);
    if (text === null) return null;
    fields.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${fields.join(',')}}`;
}

/** Everything except the caller's identity decides a calculation's value (a `MathWorkRequest`). */
export function mathRequestMemoryKey(request: object): string | null {
  if (!plainRecord(request)) return null;
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(request)) if (key !== 'identity') content[key] = request[key];
  const key = canonical(content, 0);
  return key === null || key.length > MEMORY_ENTRY_CHARACTERS ? null : key;
}

/** A bounded, least-recently-used memory of validated values (not of stopped or failed calculations). */
export function createMathResultMemory(): MathResultMemory {
  const entries = new Map<string, Result>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key); entries.set(key, value);
      return structuredClone(value);
    },
    remember(key, result) {
      if (result.evaluation.status !== 'value' || JSON.stringify(result).length > MEMORY_ENTRY_CHARACTERS) return;
      entries.delete(key); entries.set(key, structuredClone(result));
      while (entries.size > MEMORY_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/**
 * The values of one page's formula editors and document recomputations (2026-09-27, P12-28). Applying an
 * edit calculated each formula in the editor, and the recomputation that followed calculated the same
 * formulas again (Firefox 3.3 s); reopening an editor or undoing calculated values already known. A
 * request whose every field except its identity equals a remembered one receives a copy of that value
 * with its own identity. Stopped, failed, cancelled and timed-out calculations are never remembered.
 */
export const pageMathResultMemory = createMathResultMemory();

class RememberingMathWorkerClient extends MathWorkerClient {
  private readonly memory: MathResultMemory;
  private readonly hasWorker?: () => boolean;
  constructor(options: ConstructorParameters<typeof MathWorkerClient>[0], memory: MathResultMemory, hasWorker?: () => boolean) {
    super(options);
    this.memory = memory;
    this.hasWorker = hasWorker;
  }
  override evaluate(request: MathWorkRequest, timeoutMs: number, signal?: AbortSignal): Promise<Completion> {
    const key = mathRequestMemoryKey(request);
    // A group without a live Worker yet must run its first request for real: Firefox's symbolic-import
    // cold start (tens of seconds) has to happen somewhere, and a later, differently-shaped request
    // (e.g. converting notation) budgets far less time for it (2026-09-27, structured input missing
    // after reopening a saved value: the remembered display hid the cold start until then).
    const warm = this.hasWorker === undefined || this.hasWorker();
    const remembered = key === null || !warm ? undefined : this.memory.get(key);
    if (remembered === undefined) {
      const pending = super.evaluate(request, timeoutMs, signal);
      return key === null ? pending : pending.then(completion => {
        if (completion.status === 'result') this.memory.remember(key, completion.result);
        return completion;
      });
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid math deadline');
    // The base client validates this request and its identity, and reports a closed client or the caller's
    // cancellation, exactly as for a calculation; the stopped signal keeps it from queuing any work.
    const stopped = new AbortController(); stopped.abort();
    return super.evaluate(request, timeoutMs, stopped.signal).then((checked): Completion =>
      checked.status === 'cancelled' && signal?.aborted !== true
        ? { status: 'result', identity: checked.identity, result: remembered } : checked);
  }
}

/** One client belongs to one document/editor owner; dispose it when that owner closes.
 * With `memory` (the page's editors and recomputation), identical requests reuse a validated value,
 * but only once `hasWorker` (the lease's shared group) reports a live Worker; omitting it keeps every
 * remembered value usable, for callers with no group of their own to ask. */
export function createBrowserMathClient(createWorker: () => MathWorkerPort = createBrowserMathWorker,
  memory?: MathResultMemory, hasWorker?: () => boolean): MathWorkerClient {
  const options: ConstructorParameters<typeof MathWorkerClient>[0] = {
    createWorker,
    decodeReply: (value, request) => decodeMathWorkReply(value, request, {
      operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)),
      declaredIds: new Set((request.declarations ?? request.definition?.declarations)?.map(value => value.id)),
    }),
  };
  return memory === undefined ? new MathWorkerClient(options) : new RememberingMathWorkerClient(options, memory, hasWorker);
}
