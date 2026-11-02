import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256, translateSolidAnalysis } from './solidAnalysisTranslation.js';

/** Display-only yield/stress ratios, not a design allowable, pass decision or certification.
 * Missing capacity prevents an overall ratio. Exact zero stress is explicit, never Infinity. */
export interface SolidYieldSummary {
  readonly inputSha256: string;
  readonly structuralCertification: false;
  readonly minimumYieldRatio: number | null;
  readonly missingMaterialIds: readonly string[];
  readonly elements: readonly {
    readonly elementIndex: number;
    readonly materialId: string;
    readonly vonMisesMPa: number;
    readonly capacity: AnalysisMaterialCapacity | null;
    readonly yieldRatio: number | null;
    readonly zeroStress: boolean;
  }[];
}

/** Decode capacity and revalidate the actual native actions against the current complete input.
 * No caller-supplied digest or material fallback can authorize stale results. Caller UI ownership
 * must also reject a late response after changing its current document/session. */
export async function summarizeSolidYield(value: SolidAnalysisInput, result: unknown): Promise<SolidYieldSummary> {
  const input = translateSolidAnalysis(value).input;
  const captured = JSON.stringify(input);
  const ownedResult: unknown = structuredClone(result);
  const resultBytes = JSON.stringify(ownedResult);
  const hash = await solidInputSha256(input);
  if (JSON.stringify(translateSolidAnalysis(value).input) !== captured || JSON.stringify(result) !== resultBytes
    || !solidResultMatches(ownedResult, input, hash)) throw new Error('solid-yield: current input/result mismatch');
  const materials = new Map(input.materials.map(material => [material.id, material]));
  const missing = new Set<string>();
  let minimum: number | null = null;
  const elements = input.elements.map((element, elementIndex) => {
    const material = materials.get(element.materialId);
    if (material === undefined) throw new Error('solid-yield: missing material');
    const [x, y, z, yz, xz, xy] = ownedResult.elements[elementIndex].stressMPa;
    const vonMisesMPa = Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2,
      (z - x) / Math.SQRT2, Math.sqrt(3) * yz, Math.sqrt(3) * xz, Math.sqrt(3) * xy);
    if (!Number.isFinite(vonMisesMPa)) throw new Error('solid-yield: unresolved stress scale');
    const capacity = material.capacity ?? null;
    if (capacity === null) missing.add(material.id);
    const zeroStress = vonMisesMPa === 0;
    const yieldRatio = capacity === null || zeroStress ? null : capacity.yieldMPa / vonMisesMPa;
    if (yieldRatio !== null) {
      if (!Number.isFinite(yieldRatio) || yieldRatio <= 0) throw new Error('solid-yield: unresolved ratio scale');
      minimum = minimum === null ? yieldRatio : Math.min(minimum, yieldRatio);
    }
    return { elementIndex, materialId: material.id, vonMisesMPa, capacity, yieldRatio, zeroStress };
  });
  return { inputSha256: hash, structuralCertification: false,
    minimumYieldRatio: missing.size === 0 ? minimum : null, missingMaterialIds: [...missing], elements };
}
