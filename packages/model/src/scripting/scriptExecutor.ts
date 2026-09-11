import type { AssemblyKernelBridge } from '../kernelBridge.js';
import type { ImportedShapeBytes } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { createScriptSnapshot } from './scriptSnapshot.js';
import { sha256ScriptSource, validateScriptProgram } from './scriptModules.js';
import { prepareScriptTransaction, type PreparedScriptTransaction } from './scriptTransaction.js';
import { runScriptWorker, type ScriptWorkerFactory } from './scriptWorkerClient.js';
import { SCRIPT_LIMITS, type ScriptConsoleLine, type ScriptFailure, type ScriptProgram } from './scriptTypes.js';

export interface ScriptRequest {
  readonly requestId: string; readonly documentEpoch: string; readonly document: PartDocument;
  readonly program: ScriptProgram; readonly lengthUnit: LengthUnit; readonly seed: number; readonly timeMs: number;
  readonly importedShapes: ImportedShapeBytes;
  readonly placeDocument?: (document: PartDocument) => PartDocument;
}
export type ScriptPhase = 'running' | 'validating' | 'evaluating';
export type ScriptRunResult =
  | { readonly ok: true; readonly prepared: PreparedScriptTransaction | null; readonly console: readonly ScriptConsoleLine[];
      readonly commandCount: number; readonly initializationMs: number; readonly javascriptMs: number; readonly cadMs: number }
  | { readonly ok: false; readonly error: ScriptFailure; readonly console: readonly ScriptConsoleLine[] };
export type ScriptExecutor = (request: ScriptRequest, signal: AbortSignal, onPhase: (phase: ScriptPhase) => void) => Promise<ScriptRunResult>;

export function createScriptExecutor(bridge: AssemblyKernelBridge, factory?: ScriptWorkerFactory): ScriptExecutor {
  return async (request, signal, onPhase) => {
    const controller = new AbortController(); let timedOut = false;
    const cancel = (): void => { controller.abort(); };
    const failure = (kind: ScriptFailure['kind'], message: string): ScriptRunResult => ({ ok: false, error: { kind, message, location: null }, console: [] });
    if (signal.aborted) return failure('cancelled', '処理を中止しました。');
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SCRIPT_LIMITS.totalMs);
    const stopped = (): ScriptRunResult => failure(timedOut ? 'timeout' : 'cancelled', timedOut ? '実行全体の上限30秒を超えました。' : '処理を中止しました。');
    try {
      onPhase('validating');
      const checked = await validateScriptProgram(request.program);
      if (!checked.ok) return failure('source', '処理の内容・版・照合値が一致しません。');
      if (controller.signal.aborted) return stopped();
      // The UI checks epoch separately. Reopening identical content must not change generated IDs.
      const snapshotNamespace = await sha256ScriptSource(JSON.stringify(request.document));
      const snapshot = createScriptSnapshot(request.document, snapshotNamespace, request.lengthUnit);
      const commandNamespace = await sha256ScriptSource(JSON.stringify([snapshot.json, request.program, request.seed, request.timeMs]));
      if (controller.signal.aborted) return stopped();
      onPhase('running');
      const result = await runScriptWorker({ executionId: request.requestId, commandNamespace, program: request.program,
        snapshot: snapshot.json, seed: request.seed, timeMs: request.timeMs }, controller.signal, factory);
      if (controller.signal.aborted) return stopped();
      if (!result.ok) return result;
      if (result.commands.length === 0) return { ok: true, prepared: null, console: result.console, commandCount: 0,
        initializationMs: result.initializationMs, javascriptMs: result.javascriptMs, cadMs: 0 };
      onPhase('evaluating');
      const cadStarted = performance.now();
      const sources = new Map(request.program.modules.map((module) => [module.name, module.source])); sources.set('user-script.js', request.program.source);
      const prepared = await prepareScriptTransaction({ requestId: request.requestId, document: request.document, commandNamespace,
        commands: result.commands, references: snapshot.references, lengthUnit: request.lengthUnit, sources, importedShapes: request.importedShapes, placeDocument: request.placeDocument },
      bridge, () => controller.signal.aborted);
      if (controller.signal.aborted) { if (prepared.ok) await prepared.prepared.release(); return stopped(); }
      if (!prepared.ok) return { ...prepared, console: result.console };
      return { ok: true, prepared: prepared.prepared, console: result.console, commandCount: result.commands.length,
        initializationMs: result.initializationMs, javascriptMs: result.javascriptMs, cadMs: performance.now() - cadStarted };
    } catch (error) {
      if (controller.signal.aborted) return stopped();
      return failure('worker', error instanceof Error ? error.message : '処理を実行できませんでした。');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  };
}
