import type { AssemblyKernelBridge, PartProgressCallback } from '../kernelBridge.js';
import { recomputePart, type PartRecomputeResult } from '../part/recomputePart.js';
import type { ImportedShapeBytes, ResolvedSolidStep } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { applyScriptCommands,prepareScriptCommands } from './scriptCommands.js';
import type {ScriptFunctionCompiler} from './scriptFunctionCommands.js';
import type { ScriptModelReference } from './scriptCommandContext.js';
import { locateScriptError } from './scriptLocation.js';
import { scriptFailure, scriptInternalFailure, type ScriptCommand, type ScriptFailure, type ScriptLocation } from './scriptTypes.js';

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
function cancelled(): ScriptPreparation {
  return { ok: false, error: scriptFailure('cancelled') };
}

/** No app-state mutation. Every failing path releases its separate kernel owner. */
export async function prepareScriptTransaction(input: ScriptTransactionInput, bridge: AssemblyKernelBridge,
  shouldCancel: () => boolean, onProgress?: PartProgressCallback, calculate:typeof recomputePart=recomputePart,compile?:ScriptFunctionCompiler): Promise<ScriptPreparation> {
  if (shouldCancel()) return cancelled();
  const argumentsForCommands=[input.document,input.commands,input.references,input.commandNamespace,input.lengthUnit,input.sources]as const;
  const batch = compile===undefined?applyScriptCommands(...argumentsForCommands):await prepareScriptCommands(argumentsForCommands,compile,shouldCancel);
  if (!batch.ok) return batch;
  const candidate = input.placeDocument?.(batch.document) ?? batch.document;
  const partId = `script-preview:${input.requestId}`;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true; await bridge.releasePart(partId);
  };
  let location: ScriptLocation | null = null;
  let outcome: ScriptPreparation | undefined;
  let diagnostic: { cause: unknown } | undefined;
  try {
    outcome = await prepare(batch);
  } catch (cause) {
    if (!shouldCancel() || !(cause instanceof DOMException && cause.name === 'AbortError')) diagnostic = { cause };
  }
  if (outcome?.ok !== true) {
    try { await release(); }
    catch (cause) {
      diagnostic = { cause: diagnostic === undefined ? cause
        : new AggregateError([diagnostic.cause, cause], 'Script preparation and release failed') };
    }
  }
  const internal = diagnostic === undefined ? undefined : scriptInternalFailure(diagnostic.cause, location);
  if (outcome !== undefined) return outcome;
  if (shouldCancel()) return cancelled();
  return { ok: false, error: internal ?? scriptFailure('internal', location) };

  async function prepare(batch: Extract<Awaited<ReturnType<typeof prepareScriptCommands>>, { ok: true }>): Promise<ScriptPreparation> {
    let steps: readonly ResolvedSolidStep[] = [];
    const result = await calculate(candidate, bridge, { partId, generation: 1, shouldCancel, onProgress,
      importedShapes: input.importedShapes, onResolved: (resolved) => { steps = resolved.steps; } });
    if (shouldCancel() || result.cancelled) return cancelled();
    const firstError = result.errors[0];
    if (firstError !== undefined) return { ok: false, error: { kind: 'cad', partError: firstError,
      location: locateScriptError(batch.locations.get(firstError.featureId) ?? '', input.sources) } };
    // A cylinder outside its target must not report that a hole was created.
    const previousIds = new Set(input.document.solids.map((solid) => solid.id));
    for (const solid of batch.document.solids) {
      if (solid.kind !== 'boolean' || solid.operation !== 'subtract' || previousIds.has(solid.id)) continue;
      location = locateScriptError(batch.locations.get(solid.id) ?? '', input.sources);
      const before = await bridge.measure(steps, [{ bodyFeatureId: solid.targetFeatureId, subShape: null }], 'massProperties');
      if (shouldCancel()) return cancelled();
      const after = await bridge.measure(steps, [{ bodyFeatureId: solid.id, subShape: null }], 'massProperties');
      if (shouldCancel()) return cancelled();
      if (before.kind !== 'massProperties' || after.kind !== 'massProperties')
        throw new Error('Script hole volume measurement failed', { cause: { before, after } });
      if (!(after.volume > 0 && after.volume < before.volume))
        return { ok: false, error: scriptFailure('holeOutside', location) };
    }
    return { ok: true, prepared: { base: input.document, document: batch.document, result, release } };
  }
}
