/**
 * ミラー・複写・配列複写の変換(FR-324、計画書 P4 §2.5・§0.a-0.21、タスク20)。
 *
 * ## カーネルを呼ばない
 *
 * 統括の決定 §0.a-0.21 のとおり、鏡映・平行移動・回転はすべて model の `Vec3` 演算で解く。
 * OCCT の `gp_Trsf` は使わない(往復の待ち時間も、失敗の経路も増やさないため)。
 *
 * ## 元は残し、複製だけを作る
 *
 * 複製系(§0.a-0.10)なので、もとの要素には触れない。`SketchCopyFeature` は
 * **もとの要素を id で参照する 1 つのフィーチャー**で、解決のたびに元の形を写し直す
 * (`types.ts` の `SketchCopyFeature` の注釈に判断の理由)。
 *
 * ## 円弧・楕円弧は鏡映で向きが裏返る
 *
 * 鏡映は右手系を左手系へ裏返す(行列式が −1)。円弧の点は
 *   P(t) = 中心 + 半径(cos t · xAxis + sin t · (normal × xAxis))
 * で決まるので、鏡映 M をかけると M(normal × xAxis) = −(M(normal) × M(xAxis)) になり、
 * 「法線と第1軸をそのまま写した円弧の、角度 −t の点」に一致する。だから
 * **法線・第1軸は普通に写し、開始角・終了角の符号だけを反転する**。
 * 法線を反転して角度を据え置く書き方でも同じ形になるが、そうすると 2 次元スケッチで
 * 「円弧の法線 = 作図面の法線」という下流(トリムの角度の測り直し、オフセットの左右)の
 * 前提が崩れるので採らない。始点が始点へ写る(端点の対応が保たれる)利点もある。
 *
 * すべて純関数で、DOM にもカーネルにも触れない。
 */

import {
  baseWorkPlane,
  degreesToRadians,
  type WorkPlane,
  type WorkPlaneId,
} from './planeMath.js';
import { resolveCoordinate, type ResolveContext } from './resolveCoordinate.js';
import type {
  MirrorBasis,
  ResolvedCurve,
  ResolvedPoint,
  SketchCopyFeature,
  SketchElementRef,
  SketchError,
  SketchErrorCode,
} from './types.js';
import {
  addVec3,
  cleanZeroVec3,
  crossVec3,
  lengthVec3,
  mirrorVec3,
  normalizeVec3,
  ORIGIN,
  rotateAboutAxis,
  rotateDirection,
  scaleVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';

/** 1 周(度)。全周の配列複写の刻みを出すのに使う。 */
const FULL_TURN_DEGREES = 360;

/**
 * 複製で作れる個数の下限・上限(もとを含めた総数)。
 * P3 のパターン(`part/createPartDocument.ts` の `MAX_PATTERN_COUNT`)と同じ 2〜100 に
 * そろえる。`sketch` から `part` を import すると依存が逆流するので値だけ合わせる。
 */
export const MIN_COPY_COUNT = 2;
export const MAX_COPY_COUNT = 100;

/**
 * 複製にかける 1 つぶんの変換。
 *
 * `rigid` は「軸まわりに回してから平行移動する」剛体変換で、P3 の `RigidTransform`
 * (`part/resolvePart.ts`)と同じ欄立て。`mirror` は平面に対する鏡映で、剛体ではない
 * (向きが裏返る)ので種類を分ける。
 */
export type SketchTransform =
  | {
      readonly kind: 'rigid';
      readonly translation: Vec3;
      readonly rotationOrigin: Vec3;
      readonly rotationAxis: Vec3;
      /** 回転角(ラジアン)。0 なら平行移動だけ。 */
      readonly rotationAngle: number;
    }
  | {
      readonly kind: 'mirror';
      readonly origin: Vec3;
      readonly normal: Vec3;
    };

/** 複製のもとを引くための、解決済みの要素の索引(`resolveSketch` が育てているもの)。 */
export interface CopySourceLookup {
  readonly curveByFeature: ReadonlyMap<string, ResolvedCurve>;
  readonly curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>;
  readonly pointsByFeature: ReadonlyMap<string, readonly ResolvedPoint[]>;
}

/** 複製の結果。点だけ、または曲線だけが入る(両方が空でないことはない)。 */
export type CopyOutcome =
  | {
      readonly ok: true;
      readonly points: readonly ResolvedPoint[];
      readonly curves: readonly ResolvedCurve[];
    }
  | { readonly ok: false; readonly error: SketchError };

type TransformsOutcome =
  | { readonly ok: true; readonly transforms: readonly SketchTransform[] }
  | { readonly ok: false; readonly error: SketchError };

type SourceOutcome =
  | {
      readonly ok: true;
      readonly points: readonly ResolvedPoint[];
      readonly curves: readonly ResolvedCurve[];
    }
  | { readonly ok: false; readonly error: SketchError };

function fail(featureId: string, code: SketchErrorCode, message: string): { readonly ok: false; readonly error: SketchError } {
  return { ok: false, error: { featureId, code, message } };
}

/** 断りの文言に出す要素の名前。`featureId#n` の形(`trimExtend.ts` の `parseElementId` と対)。 */
function elementIdText(reference: SketchElementRef): string {
  return reference.index === undefined
    ? reference.featureId
    : `${reference.featureId}#${String(reference.index)}`;
}

/* ------------------------------------------------------------------ *
 * 変換の作り方
 * ------------------------------------------------------------------ */

/** 平行移動だけの変換。 */
export function translateTransform(delta: Vec3): SketchTransform {
  return {
    kind: 'rigid',
    translation: cleanZeroVec3(delta),
    rotationOrigin: ORIGIN,
    // 回転角 0 なので軸は使われない。長さ 0 の軸は `rotateDirection` が素通しする。
    rotationAxis: ORIGIN,
    rotationAngle: 0,
  };
}

/** 平面(点+法線)に対する鏡映の変換。 */
export function mirrorTransform(origin: Vec3, normal: Vec3): SketchTransform {
  return { kind: 'mirror', origin, normal };
}

/**
 * 直線状の配列複写の変換の一覧(FR-324)。もとの位置ぶんは作らないので `count − 1` 個
 * (P3 の `resolvePatternTransforms` と同じ規則)。
 */
export function linearArrayTransforms(
  direction: Vec3,
  spacing: number,
  count: number,
): readonly SketchTransform[] {
  const transforms: SketchTransform[] = [];
  for (let step = 1; step <= count - 1; step += 1) {
    transforms.push(translateTransform(scaleVec3(direction, spacing * step)));
  }
  return transforms;
}

/**
 * 円形の配列複写の変換の一覧(FR-324)。`stepAngle`(ラジアン)ずつ回した `count − 1` 個。
 * 回す軸は中心を通る `axis`(2 次元のスケッチでは作図面の法線)。
 */
export function circularArrayTransforms(
  center: Vec3,
  axis: Vec3,
  stepAngle: number,
  count: number,
): readonly SketchTransform[] {
  const transforms: SketchTransform[] = [];
  for (let step = 1; step <= count - 1; step += 1) {
    transforms.push({
      kind: 'rigid',
      translation: ORIGIN,
      rotationOrigin: center,
      rotationAxis: axis,
      rotationAngle: stepAngle * step,
    });
  }
  return transforms;
}

/* ------------------------------------------------------------------ *
 * 変換のかけ方
 * ------------------------------------------------------------------ */

/** 点を写す。 */
export function transformPoint(transform: SketchTransform, point: Vec3): Vec3 {
  if (transform.kind === 'mirror') {
    return mirrorVec3(point, transform.origin, transform.normal);
  }
  return addVec3(
    rotateAboutAxis(point, transform.rotationOrigin, transform.rotationAxis, transform.rotationAngle),
    transform.translation,
  );
}

/** 向き(法線・第1軸など)を写す。位置を持たないので平行移動は効かない。 */
export function transformDirection(transform: SketchTransform, direction: Vec3): Vec3 {
  if (transform.kind === 'mirror') {
    // 原点を通る平面で折り返すと、向きの鏡像そのものになる(`mirrorVec3` の注釈)。
    return mirrorVec3(direction, ORIGIN, transform.normal);
  }
  return rotateDirection(direction, transform.rotationAxis, transform.rotationAngle);
}

/** 鏡映のときだけ角度の符号を反転する(このファイル冒頭の「向きが裏返る」)。 */
function sweptAngle(transform: SketchTransform, angle: number): number {
  return transform.kind === 'mirror' ? -angle : angle;
}

/** 曲線 1 本を写す。`featureId` は複製フィーチャー自身の id を渡す(元の id を引き継がない)。 */
export function transformCurve(
  transform: SketchTransform,
  curve: ResolvedCurve,
  featureId: string,
): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return {
        kind: 'segment',
        featureId,
        from: transformPoint(transform, curve.from),
        to: transformPoint(transform, curve.to),
      };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: transformPoint(transform, curve.center),
        normal: transformDirection(transform, curve.normal),
        xAxis: transformDirection(transform, curve.xAxis),
        radius: curve.radius,
        startAngle: sweptAngle(transform, curve.startAngle),
        endAngle: sweptAngle(transform, curve.endAngle),
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        featureId,
        center: transformPoint(transform, curve.center),
        normal: transformDirection(transform, curve.normal),
        majorAxis: transformDirection(transform, curve.majorAxis),
        majorRadius: curve.majorRadius,
        minorRadius: curve.minorRadius,
        startAngle: sweptAngle(transform, curve.startAngle),
        endAngle: sweptAngle(transform, curve.endAngle),
      };
    case 'spline':
      // 補間も制御点も点の一次結合(アフィン結合)なので、点を写せば曲線ごと写る。
      return {
        kind: 'spline',
        featureId,
        mode: curve.mode,
        points: curve.points.map((point) => transformPoint(transform, point)),
        closed: curve.closed,
      };
  }
}

/* ------------------------------------------------------------------ *
 * もとの要素を集める
 * ------------------------------------------------------------------ */

/** 単体の曲線か、複数曲線フィーチャーの n 番目(省略なら先頭)を 1 本だけ引く。 */
function findSingleCurve(
  reference: SketchElementRef,
  lookup: CopySourceLookup,
): ResolvedCurve | null {
  const single = lookup.curveByFeature.get(reference.featureId);
  if (single !== undefined) {
    return single;
  }
  const group = lookup.curvesByFeature.get(reference.featureId);
  if (group === undefined) {
    return null;
  }
  return group[reference.index ?? 0] ?? null;
}

/**
 * 複製するもとの要素を、選んだ順に広げる(FR-324、タスク20)。
 *
 * 参照の解き方はオフセット元(`resolveSketch.ts` の `collectOffsetSource`)と同じ約束で、
 * 単体の線・円弧・楕円・スプラインはそのまま 1 本、矩形などは `index` を省けば全体、
 * 指定すれば n 番目だけ。**点・点列も選べる**(`index` を省けば全部の点)。
 * 点と曲線が混じると `featureId#n` の番号がどちらの並びか決まらないので断る。
 */
export function collectCopySource(
  featureId: string,
  source: readonly SketchElementRef[],
  lookup: CopySourceLookup,
): SourceOutcome {
  if (source.length === 0) {
    return fail(featureId, 'tooFewPoints', '複製するもとの要素が選ばれていません。');
  }
  const points: ResolvedPoint[] = [];
  const curves: ResolvedCurve[] = [];
  for (const reference of source) {
    const single = lookup.curveByFeature.get(reference.featureId);
    if (single !== undefined) {
      curves.push(single);
      continue;
    }
    const group = lookup.curvesByFeature.get(reference.featureId);
    if (group !== undefined) {
      if (reference.index === undefined) {
        curves.push(...group);
        continue;
      }
      const selected = group[reference.index];
      if (selected === undefined) {
        return fail(
          featureId,
          'missingBase',
          `複製するもとの要素が見つかりません: ${elementIdText(reference)}`,
        );
      }
      curves.push(selected);
      continue;
    }
    const pointGroup = lookup.pointsByFeature.get(reference.featureId);
    if (pointGroup === undefined) {
      return fail(
        featureId,
        'missingBase',
        `複製するもとの要素が見つかりません: ${elementIdText(reference)}`,
      );
    }
    if (reference.index === undefined) {
      points.push(...pointGroup);
      continue;
    }
    const selectedPoint = pointGroup[reference.index];
    if (selectedPoint === undefined) {
      return fail(
        featureId,
        'missingBase',
        `複製するもとの点が見つかりません: ${elementIdText(reference)}`,
      );
    }
    points.push(selectedPoint);
    continue;
  }
  if (points.length > 0 && curves.length > 0) {
    return fail(featureId, 'mixedBoundary', '点と線を混ぜて複製することはできません。');
  }
  return { ok: true, points, curves };
}

/* ------------------------------------------------------------------ *
 * 複製のしかたを解く
 * ------------------------------------------------------------------ */

/** 複製する個数(もとを含めた総数)の妥当性。P3 のパターンと同じ 2〜100 の整数。 */
export function checkCopyCount(featureId: string, count: number): SketchError | null {
  if (
    !Number.isFinite(count) ||
    !Number.isInteger(count) ||
    count < MIN_COPY_COUNT ||
    count > MAX_COPY_COUNT
  ) {
    return {
      featureId,
      code: 'invalidValue',
      message: `並べる個数は ${String(MIN_COPY_COUNT)} 以上 ${String(MAX_COPY_COUNT)} 以下の整数にしてください。`,
    };
  }
  return null;
}

/** 鏡にする平面(点+単位法線)を決める。 */
function resolveMirrorTransform(
  featureId: string,
  basis: MirrorBasis,
  plane: WorkPlane | null,
  lookup: CopySourceLookup,
  lookupWorkPlane: (planeId: WorkPlaneId) => WorkPlane | null,
): TransformsOutcome {
  if (basis.kind === 'plane') {
    const mirrorPlane = lookupWorkPlane(basis.planeId);
    if (mirrorPlane === null) {
      return fail(featureId, 'missingBase', `鏡にする平面が見つかりません: ${basis.planeId}`);
    }
    return { ok: true, transforms: [mirrorTransform(mirrorPlane.origin, mirrorPlane.normal)] };
  }
  // 線を軸にした鏡像は「その線を含み作図面に垂直な平面」で折り返すので、作図面が要る。
  if (plane === null) {
    return fail(
      featureId,
      'missingBase',
      '3D スケッチでは線を軸にした鏡像は作れません。鏡にする平面を選んでください。',
    );
  }
  const axis = findSingleCurve(basis.axis, lookup);
  if (axis === null) {
    return fail(
      featureId,
      'missingBase',
      `鏡にする軸の線が見つかりません: ${elementIdText(basis.axis)}`,
    );
  }
  if (axis.kind !== 'segment') {
    return fail(featureId, 'invalidValue', '鏡にできるのは線分だけです。まっすぐな線を選んでください。');
  }
  const along = subVec3(axis.to, axis.from);
  // 作図面の法線と軸の向きの両方に垂直な向きが、折り返す平面の法線になる。
  const normal = crossVec3(plane.normal, along);
  if (lengthVec3(normal) <= SKETCH_TOLERANCE_MM) {
    return fail(featureId, 'degenerate', '鏡にする軸の向きが定まりません。');
  }
  return { ok: true, transforms: [mirrorTransform(axis.from, normalizeVec3(normal))] };
}

/**
 * 複製のしかたから変換の一覧を作る(FR-324、タスク20)。
 * 変換は「もとの位置ぶんを含めない」ので、鏡像・移動は 1 個、配列は `count − 1` 個。
 */
export function resolveCopyTransforms(
  feature: SketchCopyFeature,
  plane: WorkPlane | null,
  context: ResolveContext,
  lookup: CopySourceLookup,
  lookupWorkPlane: (planeId: WorkPlaneId) => WorkPlane | null = baseWorkPlane,
): TransformsOutcome {
  const placement = feature.placement;
  const featureId = feature.id;
  switch (placement.kind) {
    case 'mirror':
      return resolveMirrorTransform(featureId, placement.basis, plane, lookup, lookupWorkPlane);
    case 'translate': {
      // 移動量は「原点から見た向きベクトル」として解く(`types.ts` の約束)。
      const delta = resolveCoordinate(placement.delta, context, featureId);
      if (!delta.ok) {
        return delta;
      }
      if (lengthVec3(delta.value) <= SKETCH_TOLERANCE_MM) {
        return fail(featureId, 'degenerate', '移動量が 0 です。動かす向きと距離を入れてください。');
      }
      return { ok: true, transforms: [translateTransform(delta.value)] };
    }
    case 'linearArray': {
      const direction = resolveCoordinate(placement.direction, context, featureId);
      if (!direction.ok) {
        return direction;
      }
      if (lengthVec3(direction.value) <= SKETCH_TOLERANCE_MM) {
        return fail(featureId, 'degenerate', '並べる向きが定まりません。');
      }
      const countError = checkCopyCount(featureId, placement.count.value);
      if (countError !== null) {
        return { ok: false, error: countError };
      }
      const spacing = placement.spacing.value;
      if (!Number.isFinite(spacing) || spacing <= 0) {
        return fail(featureId, 'invalidValue', '並べる間隔は 0 より大きい数にしてください。');
      }
      return {
        ok: true,
        transforms: linearArrayTransforms(
          normalizeVec3(direction.value),
          spacing,
          placement.count.value,
        ),
      };
    }
    case 'circularArray': {
      // 回す軸が作図面の法線なので、円形の配列は作図面のあるスケッチだけで作れる。
      if (plane === null) {
        return fail(
          featureId,
          'missingBase',
          '3D スケッチでは円形に並べられません。作図面を選んでから作ってください。',
        );
      }
      const center = resolveCoordinate(placement.center, context, featureId);
      if (!center.ok) {
        return center;
      }
      const countError = checkCopyCount(featureId, placement.count.value);
      if (countError !== null) {
        return { ok: false, error: countError };
      }
      const count = placement.count.value;
      let stepDegrees: number;
      if (placement.fullCircle) {
        stepDegrees = FULL_TURN_DEGREES / count;
      } else {
        const angle = placement.angle.value;
        if (!Number.isFinite(angle) || angle <= 0 || angle > FULL_TURN_DEGREES) {
          return fail(featureId, 'invalidValue', '並べる角度は 0 より大きく 360 以下にしてください。');
        }
        // 全周でないときは、指定した角度を「もとを含めた個数 − 1」で等分する(P3 と同じ)。
        stepDegrees = angle / (count - 1);
      }
      return {
        ok: true,
        transforms: circularArrayTransforms(
          center.value,
          plane.normal,
          degreesToRadians(stepDegrees),
          count,
        ),
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * まとめ
 * ------------------------------------------------------------------ */

/**
 * 複製フィーチャーを解決する(FR-324、タスク20)。
 *
 * 並び順は**変換が外側、もとの要素が内側**。もとが 4 辺の矩形で複製が 2 個なら
 * `#0`〜`#3` が 1 個目の複製、`#4`〜`#7` が 2 個目になる。こうすると 1 個ぶんが
 * ひとまとまりで並ぶので、面の境界に「1 個目の全周」を選びやすい。
 */
export function resolveCopyFeature(
  feature: SketchCopyFeature,
  plane: WorkPlane | null,
  context: ResolveContext,
  lookup: CopySourceLookup,
  lookupWorkPlane: (planeId: WorkPlaneId) => WorkPlane | null = baseWorkPlane,
): CopyOutcome {
  const source = collectCopySource(feature.id, feature.source, lookup);
  if (!source.ok) {
    return source;
  }
  const transforms = resolveCopyTransforms(feature, plane, context, lookup, lookupWorkPlane);
  if (!transforms.ok) {
    return transforms;
  }
  const points: ResolvedPoint[] = [];
  const curves: ResolvedCurve[] = [];
  for (const transform of transforms.transforms) {
    for (const point of source.points) {
      points.push({
        id: `${feature.id}#${String(points.length)}`,
        featureId: feature.id,
        position: transformPoint(transform, point.position),
      });
    }
    for (const curve of source.curves) {
      curves.push(transformCurve(transform, curve, feature.id));
    }
  }
  if (points.length === 0 && curves.length === 0) {
    // 変換が 1 つも無いことは無い(個数は 2 以上)ので、ここへ来るのはもとが空のときだけ。
    return fail(feature.id, 'tooFewPoints', '複製するもとの要素が選ばれていません。');
  }
  return { ok: true, points, curves };
}
