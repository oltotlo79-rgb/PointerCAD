/** Pure measurement request/result conversion; no Worker or mutable cache. */
import type { MeasureRequest, MeasureResult, MeasureTargetSpec } from '@pointercad/kernel';
import type { ResolvedSolidStep } from '../part/resolvePart.js';
import type { MeasureTarget, MeasureOutcome } from './analysisContracts.js';
import { toSubShapeQuery } from './subShapeQuery.js';

/**
 * 測定の依頼を kernel の言葉へ詰め替える。対象の立体を「段の鍵」へ引き直す
 * (`toAppearanceQueries` と同じ流儀)。**1 つでも鍵が引けなければ null を返し**、
 * 呼び出し側はカーネルを呼ばずに断る(§0.a-0.30)。
 */
export function toMeasureRequest(
  steps: readonly ResolvedSolidStep[],
  targets: readonly MeasureTarget[],
  kind: 'distance' | 'massProperties',
): MeasureRequest | null {
  const keyByFeatureId = new Map(steps.map((step) => [step.featureId, step.key]));
  const specs: MeasureTargetSpec[] = [];
  for (const target of targets) {
    const bodyKey = target.bodyKey ?? keyByFeatureId.get(target.bodyFeatureId);
    if (bodyKey === undefined) {
      return null;
    }
    specs.push({
      bodyKey,
      subShape: target.subShape === null ? null : toSubShapeQuery(target.subShape),
      ...(target.placement === undefined ? {} : { placement: {
        position: [...target.placement.position], rotation: [...target.placement.rotation],
      } }),
    });
  }
  return { targets: specs, kind };
}

/** 測定の結果を model の言葉へ詰め替える(kernel の型を外へ出さない、NFR-MA-1)。 */
export function toMeasureOutcome(result: MeasureResult): MeasureOutcome {
  switch (result.kind) {
    case 'distance':
      return {
        kind: 'distance',
        distance: result.distance,
        pointA: result.pointA,
        pointB: result.pointB,
        inner: result.inner,
      };
    case 'massProperties':
      return {
        kind: 'massProperties',
        volume: result.volume,
        area: result.area,
        centreOfMass: result.centreOfMass,
        principalMoments: result.principalMoments,
        principalAxes: result.principalAxes,
      };
    case 'failed':
      return { kind: 'failed', message: result.message };
  }
}
