import type { ShellAnalysisInput } from './shellAnalysisModel.js';
import { SHELL_NATIVE_ELEMENT, SHELL_NATIVE_SCHEMA, type ShellAnalysisPlan } from './shellTranslation.js';
import { sha256Hex } from './sha256.js';
import { isRecord } from './valueGuards.js';

/**
 * Wire form of the fixed shellAnalysis.py answer between the FEM Worker and its client.
 *
 * `raw` is the parsed native JSON, not a decoded ShellAnalysisResult: the numerical checks of decodeShellAnalysis
 * (finite values, restraint/reaction split, native residual, balance, pivot and refactorization bounds, integration
 * points inside their triangle, tangent DKT resultants, linear moment field) run exactly once, at the consumer
 * (decodeCadShellAnalysis against the same plan). The wire only carries the answer and binds it to one plan:
 * `planSha256` is the SHA-256 of the exact plan JSON the Worker wrote to /pcad_fem/shell-input.json. That plan holds
 * the full validated input (source, nodes, elements, materials, constraints, loads) plus the restraint/load/normal
 * arrays derived from it, so the digest fingerprints the complete input the Worker solved. The client computes its own
 * digest of its own translation and never trusts a digest supplied by the caller or the Worker alone.
 */
export const SHELL_NATIVE_KIND = 'oofem-shell-tr-shell02-native';
export interface ShellNativeWireResult {
  readonly kind: typeof SHELL_NATIVE_KIND;
  readonly planSha256: string;
  readonly raw: unknown;
}

const NATIVE_FIELDS = ['schema', 'source', 'elementRecord', 'elementClasses', 'crossSectionClasses', 'displacement',
  'reactions', 'freeResidualRelative', 'balanceRelative', 'minimumScaledPivot', 'refactorizationDifferenceRelative',
  'integrationPoints'] as const;

/** SHA-256 of the plan JSON exactly as written for the native wrapper. */
export function shellPlanSha256(plan: ShellAnalysisPlan): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(plan)));
}

/**
 * Upper bound of the JSON text of run_shell_analysis for this input (json.dumps, default separators ', ' and ': ',
 * ensure_ascii). Every number is a Python float repr of at most 24 characters (-2.2250738585072014e-308), so with
 * its separator at most 26.
 * - Node: displacement and reactions, 2 x (6 numbers + '[]' + ', ') = 2 x (156 + 4) = 320.
 * - Element: 4 integration points x (3 + 4 x 6 = 27 numbers) = 108 numbers = 2808; per point the five keys xyzMm,
 *   IST_ShellForceTensor, IST_ShellMomentTensor, IST_ShellStrainTensor, IST_CurvatureTensor are 86 characters plus
 *   5 x ('""' + ': ' + '[]' + ', ') = 40 and '{}' + ', ' = 4, i.e. 130 per point, 520 per element; the points list
 *   '[]' + ', ' = 4; '"TR_SHELL02", ' = 14 and '"SimpleCrossSection", ' = 22. Total 3368.
 * - Fixed: twelve top-level keys, the schema and record strings and four check numbers stay below 1024; the echoed
 *   source is at most 6 x its JSON length (ensure_ascii writes one UTF-16 unit as at most \uXXXX).
 * At the existing caps of 20000 nodes and 40000 elements this is 6.4 + 134.72 million characters (about 141 million);
 * the bound follows the native shape and caps, it is not a measured or promised capacity.
 */
export function shellNativeResponseBound(input: ShellAnalysisInput): number {
  return 1024 + 6 * JSON.stringify(input.source).length + 320 * input.nodes.length + 3368 * input.elements.length;
}

/** Structural admission of the wire only (used by the reply guard); it does not bind the answer to any input. */
export function isShellNativeWireResult(value: unknown): value is ShellNativeWireResult {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.kind !== SHELL_NATIVE_KIND
    || typeof value.planSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.planSha256)) return false;
  const raw = value.raw;
  return isRecord(raw) && !Array.isArray(raw) && Object.keys(raw).length === NATIVE_FIELDS.length
    && NATIVE_FIELDS.every(key => Object.hasOwn(raw, key))
    && raw.schema === SHELL_NATIVE_SCHEMA && raw.elementRecord === SHELL_NATIVE_ELEMENT.record;
}

/** The wire for exactly this input and plan digest: same source (document, revision, meshKey), one displacement row
 * per node and one integration-point list per element. Returns null for anything else; never decodes. */
export function shellNativeWireMatches(value: unknown, input: ShellAnalysisInput, planSha256: string): ShellNativeWireResult | null {
  if (!isShellNativeWireResult(value) || value.planSha256 !== planSha256) return null;
  const raw = value.raw;
  if (!isRecord(raw)) return null;
  const source = raw.source;
  if (!isRecord(source) || Object.keys(source).length !== 3 || source.documentId !== input.source.documentId
    || source.revision !== input.source.revision || source.meshKey !== input.source.meshKey) return null;
  if (!Array.isArray(raw.displacement) || raw.displacement.length !== input.nodes.length
    || !Array.isArray(raw.integrationPoints) || raw.integrationPoints.length !== input.elements.length) return null;
  return value;
}
