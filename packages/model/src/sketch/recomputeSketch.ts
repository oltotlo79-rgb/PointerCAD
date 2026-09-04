/**
 * スケッチの再計算(計画書 docs/plans/P1-式とスケッチ.md タスク12、要件§6.3)。
 *
 * 履歴を解決し、面があればカーネルで三角形にする。点・線・円弧の表示に必要な情報は
 * 解決結果(ResolvedSketch)に入っているので、カーネルは面のときだけ呼ぶ
 * (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
 * どこで失敗しても例外を投げず、理由を errors へ入れて返す(FR-504、NFR-RE-1)。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type {
  KernelBridge,
  SketchOffsetEntry,
  SketchOffsetRequestItem,
} from '../kernelBridge.js';
import {
  closedOffsetDistance,
  createOffsetCache,
  offsetDisplacement,
  offsetSideOf,
  type OffsetCache,
} from './offsetMath.js';
import { curveEnd, curveStart, resolveSketch } from './resolveSketch.js';
import type {
  CoordinateInput,
  CopyPlacement,
  FreeArcOrientation,
  PendingOffset,
  PointArrayLayout,
  ResolvedCurve,
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

/** 再計算に添える設定。 */
export interface SketchRecomputeOptions {
  /**
   * 計算済みのオフセット(FR-321、タスク15)を覚えておく入れ物。
   *
   * 渡さないと呼び出しのたびに新しく作るので、毎回カーネルへ頼み直すことになる。
   * 画面から繰り返し呼ぶ側(ui、タスク21)は 1 つ作って持ち回る(NFR-PF-2)。
   */
  readonly offsets?: OffsetCache;
}

/** カーネルの失敗を利用者向けの一文にする。理由はカーネルが日本語で返す。 */
function kernelFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `面を作れませんでした: ${message}` };
}

/** オフセットの失敗。面とは別の言い回しにして、どの操作で失敗したかを分かるようにする。 */
function offsetFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `ずらした線を作れませんでした: ${message}` };
}

/**
 * 1 回目に頼む符号つき距離。
 *
 * 閉じた輪郭は「正が外側」で確定している(`offsetMath.ts` 冒頭の実測)。
 * 開いた曲線は OCCT がどちらを左と見るか外から分からないので、まず正で頼み、
 * 出来上がりを見て違っていれば反対で頼み直す。
 */
function firstDistanceOf(pending: PendingOffset): number {
  return pending.contour.closed
    ? closedOffsetDistance(pending.distance, pending.side)
    : pending.distance;
}

function toOffsetRequest(pending: PendingOffset, distance: number): SketchOffsetRequestItem {
  return {
    featureId: pending.featureId,
    curves: pending.curves,
    distance,
    corner: pending.corner,
  };
}

/** 輪郭が 2 本以上に分かれた場合も、たどる順に 1 本の列へつなげて覚える。 */
function flattenContours(entry: SketchOffsetEntry): readonly ResolvedCurve[] {
  return entry.contours.flatMap((contour) => contour.curves);
}

/**
 * 出来上がった開いた曲線が、頼んだ側と逆に乗っていないかを見る。
 *
 * 輪郭が 2 本以上に分かれたときと、ずれの向きが左右のどちらとも言えないとき
 * (距離 0 など)は判定しない(頼み直さない)。
 */
function isWrongSide(pending: PendingOffset, entry: SketchOffsetEntry): boolean {
  if (pending.contour.closed || entry.contours.length !== 1) {
    return false;
  }
  const curves = entry.contours[0].curves;
  if (curves.length === 0) {
    return false;
  }
  const displacement = offsetDisplacement(
    pending.contour.startPoint,
    curveStart(curves[0]),
    curveEnd(curves[curves.length - 1]),
  );
  const side = offsetSideOf(
    displacement,
    pending.contour.startDirection,
    pending.contour.normal,
  );
  return side !== null && side !== pending.side;
}

/**
 * まだ形の無いオフセットをカーネルへ頼み、結果を覚え書きへ入れる(FR-321、タスク15)。
 *
 * 往復は最大 2 回。1 回目で全件をまとめて頼み、開いた曲線が逆側に出たものだけを
 * 2 回目でまとめて頼み直す。返すのは失敗の一覧だけで、成功したものは覚え書きに入る
 * (呼び出し側が解決をやり直すと、そこから曲線が入る)。
 */
/**
 * `recomputePart.ts`(タスク21)が、部品の中の複数スケッチぶんの `pendingOffsets` を
 * まとめて 1 回のカーネル往復で埋めるのにも使うため、この関数だけは輸出する。
 * 他はスケッチ単体の再計算(`recomputeSketch`)の内側だけで完結させる。
 */
export async function fillOffsets(
  bridge: KernelBridge,
  pendingOffsets: readonly PendingOffset[],
  offsets: OffsetCache,
): Promise<readonly SketchError[]> {
  const byFeature = new Map(pendingOffsets.map((pending) => [pending.featureId, pending]));
  const errors: SketchError[] = [];
  const retries: SketchOffsetRequestItem[] = [];

  try {
    const outcome = await bridge.offsetSketchCurves(
      pendingOffsets.map((pending) => toOffsetRequest(pending, firstDistanceOf(pending))),
    );
    for (const failure of outcome.failures) {
      errors.push(offsetFailed(failure.featureId, failure.message));
    }
    for (const entry of outcome.results) {
      const pending = byFeature.get(entry.featureId);
      if (pending === undefined) {
        continue;
      }
      if (isWrongSide(pending, entry)) {
        retries.push(toOffsetRequest(pending, -firstDistanceOf(pending)));
        continue;
      }
      offsets.set(pending.key, flattenContours(entry));
    }
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだオフセットはすべて作れていない。
    const message = error instanceof Error ? error.message : String(error);
    return pendingOffsets.map((pending) => offsetFailed(pending.featureId, message));
  }

  if (retries.length === 0) {
    return errors;
  }

  try {
    const outcome = await bridge.offsetSketchCurves(retries);
    for (const failure of outcome.failures) {
      errors.push(offsetFailed(failure.featureId, failure.message));
    }
    for (const entry of outcome.results) {
      const pending = byFeature.get(entry.featureId);
      if (pending !== undefined) {
        offsets.set(pending.key, flattenContours(entry));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const retry of retries) {
      errors.push(offsetFailed(retry.featureId, message));
    }
  }

  return errors;
}

/**
 * スケッチを解決し、面があればカーネルで三角形にする(要件§6.3)。
 * 面が 1 枚失敗しても残りは描けるので、mesh と errors を両方返す(FR-504、NFR-RE-1)。
 *
 * オフセット(FR-321、タスク15)があるときは、**解決 → カーネルで形を作る → 解決し直す**
 * の順で進む。解決そのものは OCCT を呼ばない純関数のままで、形は覚え書き越しに差し込む。
 */
export async function recomputeSketch(
  document: SketchDocument,
  bridge: KernelBridge,
  options: SketchRecomputeOptions = {},
): Promise<SketchRecomputeResult> {
  const offsets = options.offsets ?? createOffsetCache();
  const offsetCurves = (key: string): readonly ResolvedCurve[] | null => offsets.get(key);
  let resolved = resolveSketch(document, { offsetCurves });
  const offsetErrors: SketchError[] = [];

  if (resolved.pendingOffsets.length > 0) {
    offsetErrors.push(...(await fillOffsets(bridge, resolved.pendingOffsets, offsets)));
    // 形が入ったので解決し直す。オフセットの曲線が面の境界にも使えるようになる。
    resolved = resolveSketch(document, { offsetCurves });
  }

  if (resolved.faces.length === 0) {
    return { resolved, mesh: null, errors: [...resolved.errors, ...offsetErrors] };
  }

  try {
    const outcome = await bridge.tessellateSketchFaces(resolved.faces);
    const failures = outcome.failures.map((failure) =>
      kernelFailed(failure.featureId, failure.message),
    );
    return {
      resolved,
      mesh: outcome.mesh,
      errors: [...resolved.errors, ...offsetErrors, ...failures],
    };
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだ面はすべて作れていない。
    const message = error instanceof Error ? error.message : String(error);
    const failures = resolved.faces.map((face) => kernelFailed(face.featureId, message));
    return { resolved, mesh: null, errors: [...resolved.errors, ...offsetErrors, ...failures] };
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

/**
 * 3D スケッチの円弧の向き(FR-330、タスク10)を評価し直す。向きは 2 つの座標指定なので、
 * 座標と同じ扱いでよい。**指定が無い(作図面がある)ときは無いままにする**
 * (`undefined` を返す。空の指定を作ると「向きを指定した円弧」に化けるため)。
 */
function reevaluateFreeOrientation(
  orientation: FreeArcOrientation | undefined,
  variables: ReadonlyMap<string, number>,
): FreeArcOrientation | undefined {
  if (orientation === undefined) {
    return undefined;
  }
  return {
    normal: reevaluateCoordinate(orientation.normal, variables),
    xAxis: reevaluateCoordinate(orientation.xAxis, variables),
  };
}

/**
 * 点列の並べ方(FR-327、タスク6)を種類ごとに評価し直す。`layout.kind` は式を持たないので
 * そのまま引き継ぎ、各欄の式だけを再評価する。
 */
function reevaluatePointArrayLayout(
  layout: PointArrayLayout,
  variables: ReadonlyMap<string, number>,
): PointArrayLayout {
  switch (layout.kind) {
    case 'linear':
      return {
        kind: 'linear',
        base: reevaluateCoordinate(layout.base, variables),
        azimuth: reevaluate(layout.azimuth, variables),
        spacing: reevaluate(layout.spacing, variables),
        count: reevaluate(layout.count, variables),
      };
    case 'circular':
      return {
        kind: 'circular',
        center: reevaluateCoordinate(layout.center, variables),
        radius: reevaluate(layout.radius, variables),
        count: reevaluate(layout.count, variables),
      };
    case 'grid':
      return {
        kind: 'grid',
        base: reevaluateCoordinate(layout.base, variables),
        rowAzimuth: reevaluate(layout.rowAzimuth, variables),
        rowSpacing: reevaluate(layout.rowSpacing, variables),
        rowCount: reevaluate(layout.rowCount, variables),
        colAzimuth: reevaluate(layout.colAzimuth, variables),
        colSpacing: reevaluate(layout.colSpacing, variables),
        colCount: reevaluate(layout.colCount, variables),
      };
  }
}

/**
 * 複製のしかた(FR-324、タスク20)を並べ方ごとに評価し直す。鏡像は式を持たない
 * (鏡にする軸・平面の参照だけ)ので、そのまま返す。
 */
function reevaluateCopyPlacement(
  placement: CopyPlacement,
  variables: ReadonlyMap<string, number>,
): CopyPlacement {
  switch (placement.kind) {
    case 'mirror':
      return placement;
    case 'translate':
      return { kind: 'translate', delta: reevaluateCoordinate(placement.delta, variables) };
    case 'linearArray':
      return {
        kind: 'linearArray',
        direction: reevaluateCoordinate(placement.direction, variables),
        spacing: reevaluate(placement.spacing, variables),
        count: reevaluate(placement.count, variables),
      };
    case 'circularArray':
      return {
        kind: 'circularArray',
        center: reevaluateCoordinate(placement.center, variables),
        angle: reevaluate(placement.angle, variables),
        count: reevaluate(placement.count, variables),
        fullCircle: placement.fullCircle,
      };
  }
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
        freeOrientation: reevaluateFreeOrientation(feature.freeOrientation, variables),
      };
    case 'pointArray':
      return { ...feature, layout: reevaluatePointArrayLayout(feature.layout, variables) };
    case 'face':
      // 面は式を持たない(境界の参照と色だけ)。
      return feature;
    case 'rectangle':
      return {
        ...feature,
        corner1: reevaluateCoordinate(feature.corner1, variables),
        corner2: reevaluateCoordinate(feature.corner2, variables),
      };
    case 'polygon':
      return {
        ...feature,
        center: reevaluateCoordinate(feature.center, variables),
        sides: reevaluate(feature.sides, variables),
        radius: reevaluate(feature.radius, variables),
      };
    case 'slot':
      return {
        ...feature,
        center1: reevaluateCoordinate(feature.center1, variables),
        center2: reevaluateCoordinate(feature.center2, variables),
        width: reevaluate(feature.width, variables),
      };
    case 'ellipse':
      return {
        ...feature,
        center: reevaluateCoordinate(feature.center, variables),
        majorRadius: reevaluate(feature.majorRadius, variables),
        minorRadius: reevaluate(feature.minorRadius, variables),
        rotation: reevaluate(feature.rotation, variables),
        startAngle: reevaluate(feature.startAngle, variables),
        endAngle: reevaluate(feature.endAngle, variables),
      };
    case 'spline':
      // スプラインが持つ式は点の座標だけ(通過点・制御点とも同じ扱い)。
      return {
        ...feature,
        points: feature.points.map((input) => reevaluateCoordinate(input, variables)),
      };
    case 'offset':
      // オフセットが持つ式は距離だけ(元の要素・側・角は式ではない)。
      return { ...feature, distance: reevaluate(feature.distance, variables) };
    case 'copy':
      return { ...feature, placement: reevaluateCopyPlacement(feature.placement, variables) };
    case 'projectedCurve':
    case 'planeSection':
      // 投影・交差が持つのは立体への参照と作図面だけで、式は 1 つも無い(FR-325)。
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
