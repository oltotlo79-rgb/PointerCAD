/**
 * スケッチの再計算(計画書 docs/plans/P1-式とスケッチ.md タスク12、要件§6.3)。
 *
 * 履歴を解決し、面があればカーネルで三角形にする。点・線・円弧の表示に必要な情報は
 * 解決結果(ResolvedSketch)に入っているので、カーネルは面のときだけ呼ぶ
 * (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
 * どこで失敗しても例外を投げず、理由を errors へ入れて返す(FR-504、NFR-RE-1)。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type { KernelBridge } from '../kernelBridge.js';
import { resolveSketch } from './resolveSketch.js';
import type {
  CoordinateInput,
  ResolvedSketch,
  SketchDocument,
  SketchError,
  SketchFeature,
  SketchMesh,
} from './types.js';

export interface SketchRecomputeResult {
  readonly resolved: ResolvedSketch;
  /** 面が 1 枚も無いとき(カーネルを呼ばないとき)と、呼び出しごと失敗したときは null。 */
  readonly mesh: SketchMesh | null;
  /** 解決の失敗とカーネルの失敗を合わせたもの(FR-504)。 */
  readonly errors: readonly SketchError[];
}

/** カーネルの失敗を利用者向けの一文にする。理由はカーネルが日本語で返す。 */
function kernelFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `面を作れませんでした: ${message}` };
}

/**
 * スケッチを解決し、面があればカーネルで三角形にする(要件§6.3)。
 * 面が 1 枚失敗しても残りは描けるので、mesh と errors を両方返す(FR-504、NFR-RE-1)。
 */
export async function recomputeSketch(
  document: SketchDocument,
  bridge: KernelBridge,
): Promise<SketchRecomputeResult> {
  const resolved = resolveSketch(document);
  if (resolved.faces.length === 0) {
    return { resolved, mesh: null, errors: resolved.errors };
  }

  try {
    const outcome = await bridge.tessellateSketchFaces(resolved.faces);
    const failures = outcome.failures.map((failure) =>
      kernelFailed(failure.featureId, failure.message),
    );
    return { resolved, mesh: outcome.mesh, errors: [...resolved.errors, ...failures] };
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだ面はすべて作れていない。
    const message = error instanceof Error ? error.message : String(error);
    const failures = resolved.faces.map((face) => kernelFailed(face.featureId, message));
    return { resolved, mesh: null, errors: [...resolved.errors, ...failures] };
  }
}

/** 1 つの式を評価し直す。評価できなくなったら元の値を残す。 */
function reevaluate(value: ExpressionValue, variables: ReadonlyMap<string, number>): ExpressionValue {
  const result = evaluateExpression(value.source, { variables });
  // 評価できない式で文書を壊さない。解決の段で invalidValue として拾われる(FR-504)。
  return result.ok ? result.value : value;
}

function reevaluateCoordinate(
  input: CoordinateInput,
  variables: ReadonlyMap<string, number>,
): CoordinateInput {
  if (input.mode === 'absolute') {
    return {
      mode: 'absolute',
      x: reevaluate(input.x, variables),
      y: reevaluate(input.y, variables),
      z: reevaluate(input.z, variables),
    };
  }
  if (input.mode === 'relative') {
    return {
      mode: 'relative',
      base: input.base,
      dx: reevaluate(input.dx, variables),
      dy: reevaluate(input.dy, variables),
      dz: reevaluate(input.dz, variables),
    };
  }
  return {
    mode: 'polar',
    base: input.base,
    distance: reevaluate(input.distance, variables),
    azimuth: reevaluate(input.azimuth, variables),
    elevation: reevaluate(input.elevation, variables),
  };
}

function reevaluateFeature(
  feature: SketchFeature,
  variables: ReadonlyMap<string, number>,
): SketchFeature {
  switch (feature.kind) {
    case 'point':
      return { ...feature, at: reevaluateCoordinate(feature.at, variables) };
    case 'line':
      return {
        ...feature,
        from: reevaluateCoordinate(feature.from, variables),
        to: reevaluateCoordinate(feature.to, variables),
      };
    case 'arc':
      return {
        ...feature,
        center: reevaluateCoordinate(feature.center, variables),
        radius: reevaluate(feature.radius, variables),
        startAngle: reevaluate(feature.startAngle, variables),
        endAngle: reevaluate(feature.endAngle, variables),
      };
    case 'pointArray':
      return {
        ...feature,
        base: reevaluateCoordinate(feature.base, variables),
        azimuth: reevaluate(feature.azimuth, variables),
        spacing: reevaluate(feature.spacing, variables),
        count: reevaluate(feature.count, variables),
      };
    case 'face':
      // 面は式を持たない(境界の参照と色だけ)。
      return feature;
  }
}

/**
 * すべての式を評価し直す(FR-206 の変数変更、FR-502 の下流再計算の土台)。
 * 式文字列は変えない。変わるのは評価値と表示用の文字列だけ(FR-202)。
 */
export function reevaluateDocument(
  document: SketchDocument,
  variables: ReadonlyMap<string, number>,
): SketchDocument {
  return {
    ...document,
    features: document.features.map((feature) => reevaluateFeature(feature, variables)),
  };
}
