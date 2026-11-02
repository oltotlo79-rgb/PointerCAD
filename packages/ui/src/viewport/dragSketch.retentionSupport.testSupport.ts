import { recomputePart, type KernelBridge, type PartDocument, type PartRecomputeResult } from '@pointercad/model';
import { expect, vi } from 'vitest';

/** Point/line-only documents have no kernel work. All geometry is recomputed by the real model. */
export async function recomputeRetention(document: PartDocument): Promise<PartRecomputeResult> {
  const unexpected = vi.fn((): never => { throw new Error('Unexpected kernel request in sketch-only retention proof'); });
  const bridge: KernelBridge = {
    tessellateSketchFaces: unexpected, recomputeSolids: unexpected, offsetSketchCurves: unexpected,
    projectSketchCurves: unexpected, sectionSketchCurves: unexpected, measure: unexpected,
    exportShapes: unexpected, importShape: unexpected, inspectPrintability: unexpected, dispose: unexpected,
  };
  const result = await recomputePart(document, bridge, { generation: 2 });
  expect(unexpected).not.toHaveBeenCalled();
  expect(result.errors).toEqual([]);
  return result;
}
