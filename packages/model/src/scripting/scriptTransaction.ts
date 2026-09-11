import type { AssemblyKernelBridge, PartProgressCallback } from '../kernelBridge.js';
import { recomputePart, type PartRecomputeResult } from '../part/recomputePart.js';
import type { ImportedShapeBytes, ResolvedSolidStep } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { applyScriptCommands } from './scriptCommands.js';
import type { ScriptModelReference } from './scriptCommandContext.js';
import { locateScriptError } from './scriptLocation.js';
import type { ScriptCommand, ScriptFailure } from './scriptTypes.js';

export interface ScriptTransactionInput {
  readonly requestId: string; readonly document: PartDocument; readonly commandNamespace: string;
  readonly commands: readonly ScriptCommand[]; readonly references: ReadonlyMap<string, ScriptModelReference>;
  readonly lengthUnit: LengthUnit; readonly sources: ReadonlyMap<string, string>; readonly importedShapes: ImportedShapeBytes;
  /** Pure host placement (e.g. the current timeline position), applied before validation. */
  readonly placeDocument?: (document: PartDocument) => PartDocument;
}
export interface PreparedScriptTransaction {
  readonly base: PartDocument; readonly document: PartDocument; readonly result: PartRecomputeResult;
  /** Hold until ordinary recompute retains the successful definitions, or the result is discarded. */
  readonly release: () => Promise<void>;
}
export type ScriptPreparation = { readonly ok: true; readonly prepared: PreparedScriptTransaction }
  | { readonly ok: false; readonly error: ScriptFailure };
function failure(kind: ScriptFailure['kind'], message: string): ScriptPreparation {
  return { ok: false, error: { kind, message, location: null } };
}

/** No app-state mutation. Every failing path releases its separate kernel owner. */
export async function prepareScriptTransaction(input: ScriptTransactionInput, bridge: AssemblyKernelBridge,
  shouldCancel: () => boolean, onProgress?: PartProgressCallback): Promise<ScriptPreparation> {
  if (shouldCancel()) return failure('cancelled', '処理を中止しました。');
  const batch = applyScriptCommands(input.document, input.commands, input.references, input.commandNamespace, input.lengthUnit, input.sources);
  if (!batch.ok) return batch;
  const candidate = input.placeDocument?.(batch.document) ?? batch.document;
  const partId = `script-preview:${input.requestId}`;
  let released = false, handedOff = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true; await bridge.releasePart(partId);
  };
  try {
    let steps: readonly ResolvedSolidStep[] = [];
    const result = await recomputePart(candidate, bridge, { partId, generation: 1, shouldCancel, onProgress,
      importedShapes: input.importedShapes, onResolved: (resolved) => { steps = resolved.steps; } });
    if (shouldCancel() || result.cancelled) return failure('cancelled', '処理を中止しました。');
    const firstError = result.errors[0];
    if (firstError !== undefined) return { ok: false, error: { kind: 'cad', message: firstError.message,
      location: locateScriptError(batch.locations.get(firstError.featureId) ?? '', input.sources) } };
    // A cylinder outside its target must not report that a hole was created.
    const previousIds = new Set(input.document.solids.map((solid) => solid.id));
    for (const solid of batch.document.solids) {
      if (solid.kind !== 'boolean' || solid.operation !== 'subtract' || previousIds.has(solid.id)) continue;
      const before = await bridge.measure(steps, [{ bodyFeatureId: solid.targetFeatureId, subShape: null }], 'massProperties');
      if (shouldCancel()) return failure('cancelled', '処理を中止しました。');
      const after = await bridge.measure(steps, [{ bodyFeatureId: solid.id, subShape: null }], 'massProperties');
      if (shouldCancel()) return failure('cancelled', '処理を中止しました。');
      if (before.kind !== 'massProperties' || after.kind !== 'massProperties' || !(after.volume > 0 && after.volume < before.volume))
        return { ok: false, error: { kind: 'cad', message: '穴の位置・向き・深さを確認してください。対象の内側に穴を作れません。',
          location: locateScriptError(batch.locations.get(solid.id) ?? '', input.sources) } };
    }
    handedOff = true;
    return { ok: true, prepared: { base: input.document, document: batch.document, result, release } };
  } catch (error) {
    return failure(shouldCancel() ? 'cancelled' : 'cad', error instanceof Error ? error.message : '形を計算できませんでした。');
  } finally { if (!handedOff) await release(); }
}
