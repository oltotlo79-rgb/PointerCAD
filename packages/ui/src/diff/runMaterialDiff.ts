import { IO_LIMITS, readPcadFile } from '@pointercad/io';
import type { MaterialComparisonResult, PartRecomputeResult } from '@pointercad/model';
import { DEFINITION_DIFF_MAX_FILE_BYTES } from './definitionDiffProtocol.js';
import { createMaterialDiffSession, type MaterialDiffSession } from './materialDiffSession.js';
import { t } from '../i18n/t.js';

export type MaterialDiffPhase = 'before' | 'after' | 'compare';
export const MATERIAL_DIFF_TIMEOUT_MS = 180_000;
const limits = { ...IO_LIMITS, archiveCompressedBytes: DEFINITION_DIFF_MAX_FILE_BYTES,
  archiveEntryExpandedBytes: 32 * 1024 * 1024, archiveTotalExpandedBytes: 64 * 1024 * 1024 };
function read(bytes: Uint8Array) {
  const result = readPcadFile(bytes, { limits });
  if (!result.ok) throw new Error(result.error.message);
  if (result.kind !== 'part') throw new Error(t('materialDiff.requiresPart'));
  return result;
}
function keysOf(result: PartRecomputeResult, resolvedKeys: ReadonlyMap<string, string>): readonly string[] {
  if (result.errors.length > 0) throw new Error(result.errors[0].message);
  const keys: string[] = [];
  for (const body of result.bodies) {
    if (!body.isValid || body.bodyKind !== 'solid') throw new Error(t('materialDiff.requiresSolid'));
    const key = resolvedKeys.get(body.featureId);
    if (key === undefined) throw new Error(t('materialDiff.missingBody'));
    keys.push(key);
  }
  return keys;
}

/** 独立した2所有者で保存内容を再計算する。途中結果・失敗を「形の一致」にしない。 */
export function runMaterialDiff(beforeBytes: Uint8Array, afterBytes: Uint8Array, signal: AbortSignal,
  onPhase: (phase: MaterialDiffPhase) => void,
  createSession: () => MaterialDiffSession = createMaterialDiffSession,
): Promise<MaterialComparisonResult> {
  if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
  return new Promise(resolve => {
    let settled = false, session: MaterialDiffSession | undefined;
    const started = performance.now();
    const finish = (result: MaterialComparisonResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
      try { session?.dispose(); }
      catch (error) { result = { kind: 'failed', message: t('materialDiff.releaseFailed').replace('{reason}', error instanceof Error ? error.message : String(error)) }; }
      resolve(result);
    };
    const abort = (): void => finish({ kind: 'cancelled' });
    const timeout = setTimeout(() => finish({ kind: 'failed', message: t('materialDiff.timeout') }), MATERIAL_DIFF_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    const cancelled = (): boolean => settled || signal.aborted;
    const checkpoint = (): boolean => {
      if (cancelled()) { abort(); return false; }
      if (performance.now() - started >= MATERIAL_DIFF_TIMEOUT_MS) {
        finish({ kind: 'failed', message: t('materialDiff.timeout') }); return false;
      }
      return true;
    };
    async function run(): Promise<void> {
      try {
        if (!checkpoint()) return;
        onPhase('before'); const before = read(beforeBytes);
        if (!checkpoint()) return;
        const owned = createSession(); session = owned;
        if (settled) { owned.dispose(); return; }
        if (!checkpoint()) return;
        const previousKeys = new Map<string, string>();
        const previous = await owned.compute(before.document, { partId: 'comparison:before', generation: 1,
          importedShapes: before.attachments.shapes, shouldCancel: cancelled,
          onResolved: resolved => { for (const step of resolved.steps) previousKeys.set(step.featureId, step.key); } });
        if (!checkpoint()) return;
        if (previous.cancelled) { abort(); return; }
        const beforeKeys = keysOf(previous, previousKeys);
        onPhase('after'); const after = read(afterBytes);
        if (!checkpoint()) return;
        const nextKeys = new Map<string, string>();
        const next = await owned.compute(after.document, { partId: 'comparison:after', generation: 1,
          importedShapes: after.attachments.shapes, shouldCancel: cancelled,
          onResolved: resolved => { for (const step of resolved.steps) nextKeys.set(step.featureId, step.key); } });
        if (!checkpoint()) return;
        if (next.cancelled) { abort(); return; }
        const afterKeys = keysOf(next, nextKeys);
        onPhase('compare');
        if (!checkpoint()) return;
        const result = await owned.compare(beforeKeys, afterKeys, cancelled);
        if (checkpoint()) finish(result);
      } catch (error) {
        if (!settled) finish(signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    void run();
  });
}
