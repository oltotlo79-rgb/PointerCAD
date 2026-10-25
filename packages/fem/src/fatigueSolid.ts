import type { SolidAnalysisInput, SolidSource } from './solidAnalysisModel.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidArray, solidInputSha256, solidNumber, solidRecord, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS, validateFatigueInput,
  type FatigueError, type FatigueInput, type FatigueSequence, type FatigueSnCurve } from './fatigueModel.js';
import { FATIGUE_PROPORTIONAL_TENSOR_METHOD, FATIGUE_PROPORTIONAL_TENSOR_SCHEMA, FATIGUE_TENSOR_COMPONENTS,
  proportionalTensorFatigueInput, type FatigueReferenceTensor, type FatigueTensorConversion, type FatigueTensorError } from './fatigueTensor.js';

/** One constant element stress from an accepted native linear tet4 result, scaled by explicit user factors.
 * This uses the existing proportional elastic fatigue criterion; no transient stress history, remeshing transfer,
 * plastic fatigue or contact fatigue is inferred. Cauchy stresses already have MPa units and tensor shear.
 */
export const SOLID_FATIGUE_MEASURE = 'native-linear-tet4-element-cauchy-stress-proportional/1';

export interface SolidFatigueSelection {
  readonly source: SolidSource;
  readonly inputSha256: string;
  /** Zero-based element in this exact input/result pair; never reused across another mesh or revision. */
  readonly elementIndex: number;
  readonly historyId: string;
  /** Chronological signed multipliers of the reference load case, in the supplied order; never sorted. */
  readonly loadFactors: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly reference: string;
}
export interface SolidFatigueProvenance {
  readonly measure: typeof SOLID_FATIGUE_MEASURE;
  readonly source: SolidSource;
  readonly inputSha256: string;
  readonly elementIndex: number;
  readonly elementNodes: readonly [number, number, number, number];
  readonly materialId: string;
  readonly unit: 'MPa';
  readonly components: typeof FATIGUE_TENSOR_COMPONENTS;
  readonly reference: FatigueReferenceTensor;
  readonly loadFactors: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly historyId: string;
  readonly historyReference: string;
}
export interface SolidFatigueTensorInput {
  readonly schema: typeof FATIGUE_PROPORTIONAL_TENSOR_SCHEMA;
  readonly method: typeof FATIGUE_PROPORTIONAL_TENSOR_METHOD;
  readonly curve: FatigueSnCurve;
  readonly histories: readonly {
    readonly id: string;
    readonly reference: FatigueReferenceTensor;
    readonly loadFactors: readonly number[];
    readonly sequence: FatigueSequence;
    readonly repeats: number;
    readonly source: FatigueInput['histories'][number]['source'];
  }[];
}
export interface SolidFatigueError {
  readonly ok: false;
  readonly code: 'fatigue-solid-input' | 'fatigue-solid-selection' | 'fatigue-solid-binding' | 'fatigue-solid-element';
  readonly path: string;
}
export type SolidFatigueAdaptation =
  | { readonly ok: true; readonly input: FatigueInput; readonly tensorInput: SolidFatigueTensorInput;
    readonly provenance: SolidFatigueProvenance; readonly conversions: readonly FatigueTensorConversion[] }
  | SolidFatigueError | FatigueTensorError | FatigueError;

const fail = (code: SolidFatigueError['code'], path: string): SolidFatigueError => ({ ok: false, code, path });
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function readSolidFatigueSelection(value: unknown): SolidFatigueSelection | SolidFatigueError {
  try {
    const row = solidRecord(value, ['source', 'inputSha256', 'elementIndex', 'historyId', 'loadFactors', 'sequence', 'repeats', 'reference']);
    const source = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
    if (!text(source.documentId, 256) || !text(source.meshKey, 256) || typeof source.revision !== 'number'
      || !Number.isSafeInteger(source.revision) || source.revision < 0
      || typeof row.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.inputSha256)) {
      return fail('fatigue-solid-selection', 'selection.source');
    }
    if (typeof row.elementIndex !== 'number' || !Number.isSafeInteger(row.elementIndex) || row.elementIndex < 0) {
      return fail('fatigue-solid-element', 'selection.elementIndex');
    }
    if (!text(row.historyId, 64) || !text(row.reference, 512)) return fail('fatigue-solid-selection', 'selection.reference');
    if (row.sequence !== 'once' && row.sequence !== 'repeated-periodic') return fail('fatigue-solid-selection', 'selection.sequence');
    if (typeof row.repeats !== 'number' || !Number.isSafeInteger(row.repeats) || row.repeats < 1
      || row.repeats > MAX_FATIGUE_REPEATS || (row.sequence === 'once' && row.repeats !== 1)) {
      return fail('fatigue-solid-selection', 'selection.repeats');
    }
    const loadFactors = solidArray(row.loadFactors, MAX_FATIGUE_HISTORY_POINTS, 1).map(solidNumber);
    return { source: { documentId: source.documentId, revision: source.revision, meshKey: source.meshKey },
      inputSha256: row.inputSha256, elementIndex: row.elementIndex, historyId: row.historyId, loadFactors,
      sequence: row.sequence, repeats: row.repeats, reference: row.reference };
  } catch { return fail('fatigue-solid-selection', 'selection'); }
}

/** Revalidates the complete native result against an owned current input and its recomputed digest, not just its
 * metadata. The selected element's six Cauchy components pass unchanged to the existing tensor converter; the
 * converted curve/history goes through the existing scalar reader. No product solve is launched here.
 */
export async function solidFatigueInput(value: unknown, result: unknown, selection: unknown, curve: unknown): Promise<SolidFatigueAdaptation> {
  let input: SolidAnalysisInput;
  let hash: string;
  try {
    input = translateSolidAnalysis(value).input;
    hash = await solidInputSha256(input);
  } catch { return fail('fatigue-solid-input', 'input'); }
  const chosen = readSolidFatigueSelection(selection);
  if ('ok' in chosen) return chosen;
  if (chosen.source.documentId !== input.source.documentId || chosen.source.revision !== input.source.revision
    || chosen.source.meshKey !== input.source.meshKey || chosen.inputSha256 !== hash
    || !solidResultMatches(result, input, hash)) return fail('fatigue-solid-binding', 'result');
  const element = input.elements[chosen.elementIndex];
  const state = result.elements[chosen.elementIndex];
  if (element === undefined || state === undefined) return fail('fatigue-solid-element', 'selection.elementIndex');
  const [xx, yy, zz, yz, xz, xy] = state.stressMPa;
  const reference: FatigueReferenceTensor = { unit: 'MPa', components: FATIGUE_TENSOR_COMPONENTS, xx, yy, zz, yz, xz, xy };
  const history = { id: chosen.historyId, reference, loadFactors: [...chosen.loadFactors], sequence: chosen.sequence,
    repeats: chosen.repeats, source: { kind: 'user-supplied', reference: chosen.reference,
      condition: 'Chronological user factors scale one native linear tet4 element Cauchy stress; proportional elastic fatigue only; no transient or remesh transfer.' } };
  const converted = proportionalTensorFatigueInput({ schema: FATIGUE_PROPORTIONAL_TENSOR_SCHEMA,
    method: FATIGUE_PROPORTIONAL_TENSOR_METHOD, curve, histories: [history] });
  if (!converted.ok) return converted;
  const checked = validateFatigueInput(converted.input);
  if (!checked.ok) return checked;
  const tensorInput: SolidFatigueTensorInput = { schema: FATIGUE_PROPORTIONAL_TENSOR_SCHEMA,
    method: FATIGUE_PROPORTIONAL_TENSOR_METHOD, curve: checked.input.curve,
    histories: [{ ...history, source: checked.input.histories[0].source }] };
  return { ok: true, input: checked.input, tensorInput, conversions: converted.conversions,
    provenance: { measure: SOLID_FATIGUE_MEASURE, source: { ...input.source }, inputSha256: hash,
      elementIndex: chosen.elementIndex, elementNodes: [...element.nodes], materialId: element.materialId,
      unit: 'MPa', components: FATIGUE_TENSOR_COMPONENTS, reference: { ...reference }, loadFactors: [...chosen.loadFactors],
      sequence: chosen.sequence, repeats: chosen.repeats, historyId: chosen.historyId, historyReference: chosen.reference } };
}
