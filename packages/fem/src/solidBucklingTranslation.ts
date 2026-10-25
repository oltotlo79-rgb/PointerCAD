import type { SolidBucklingInput, SolidBucklingPlan } from './solidBucklingModel.js';
import { solidNumber, solidRecord, translateSolidAnalysis } from './solidAnalysisTranslation.js';

export const SOLID_BUCKLING_MAX_MODES = 12;

/** The reference state is validated by the unchanged static contract (strict fields,
 * positive tetrahedra, shared-face connectivity, six rigid modes restrained per
 * component). Loads only on prescribed DOFs produce no stress and are refused. */
export function translateSolidBuckling(value: unknown): { input: SolidBucklingInput; plan: SolidBucklingPlan } {
  const row = solidRecord(value, ['schema', 'reference', 'modeCount']);
  if (row.schema !== 'pointercad-solid-tet4-buckling/1') throw new Error('solid-buckling-schema: unsupported input');
  const reference = translateSolidAnalysis(row.reference);
  const modeCount = solidNumber(row.modeCount);
  if (!Number.isSafeInteger(modeCount) || modeCount < 1 || modeCount > SOLID_BUCKLING_MAX_MODES) {
    throw new Error(`solid-buckling-modes: expected an integer from 1 to ${SOLID_BUCKLING_MAX_MODES}`);
  }
  const { forcesN, fixed } = reference.plan;
  const freeDofs = fixed.reduce((sum, flags) => sum + flags.filter(flag => !flag).length, 0);
  if (freeDofs < modeCount) throw new Error('solid-buckling-supports: insufficient free degrees of freedom');
  if (!forcesN.some((force, node) => force.some((component, axis) => component !== 0 && !fixed[node][axis]))) {
    throw new Error('solid-buckling-load: zero reference load on free degrees of freedom');
  }
  const input: SolidBucklingInput = { schema: 'pointercad-solid-tet4-buckling/1', reference: reference.input, modeCount };
  return { input, plan: { schema: 'pointercad-solid-tet4-buckling-plan/1', input, reference: reference.plan, freeDofs } };
}

export async function solidBucklingInputSha256(value: unknown): Promise<string> {
  const owned = translateSolidBuckling(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(owned)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
