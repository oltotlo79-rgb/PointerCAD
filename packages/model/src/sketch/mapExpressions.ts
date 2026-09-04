/**
 * スケッチ文書の中の式を1つずつ写して回る道具
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク3、FR-202・FR-207・FR-502)。
 *
 * **「スケッチのどこに式があるか」を知っているのはこの1か所だけ**にする。
 * 変数表つきで評価し直す(`recomputeSketch.ts` の `reevaluateDocument`)、
 * 式の文字列を集める(パラメータの「未使用」の判定)、変数名を書き換える(改名の追従)は、
 * どれも「式1つを別の式へ写す規則」が違うだけなので、歩き方を3回書かない。
 *
 * 種類が増えたときに黙って素通りしないよう、**`switch` に `default` を書かない**
 * (新しい要素の種類が増えたら型検査で落ちる)。
 *
 * 立体・基準ジオメトリの側は `part/reevaluatePart.ts` が同じ形で歩く。置き場を分けているのは、
 * `part` は `sketch` に依存してよいが逆はできないため(NFR-MA-1 の依存方向)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { SketchConstraint } from './constraints/types.js';
import type {
  CoordinateInput,
  CopyPlacement,
  FreeArcOrientation,
  PointArrayLayout,
  SketchDocument,
  SketchFeature,
} from './types.js';

/**
 * 式1つを別の式へ写す規則。`ownerId` はその式を持つフィーチャー(または拘束)の id で、
 * 失敗の一覧へ「どこの式か」を添えるために渡す(`part/reevaluatePart.ts`)。
 */
export type ExpressionMapper = (value: ExpressionValue, ownerId: string) => ExpressionValue;

/** `ownerId` を束ねた後の規則。1つのフィーチャーの中ではこちらを使う。 */
export type ValueMapper = (value: ExpressionValue) => ExpressionValue;

/**
 * 配列の各要素を写す。**1つも入れ替わらなければ元の配列をそのまま返す。**
 *
 * 中身が変わっていないのに新しい配列を作ると、下流が「変わった」と見なして形状キャッシュの
 * 鍵を作り直すことになる(`part/shiftOrigin.ts` の「直す必要が無い平面は元のまま返す」と
 * 同じ約束)。
 */
export function mapKeepingIdentity<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  let changed = false;
  const next = items.map((item) => {
    const mapped = map(item);
    if (mapped !== item) {
      changed = true;
    }
    return mapped;
  });
  return changed ? next : items;
}

/** 座標の指定(絶対・相対・極)の式を写す。 */
export function mapCoordinateExpressions(input: CoordinateInput, map: ValueMapper): CoordinateInput {
  if (input.mode === 'absolute') {
    return { mode: 'absolute', x: map(input.x), y: map(input.y), z: map(input.z) };
  }
  if (input.mode === 'relative') {
    return {
      mode: 'relative',
      base: input.base,
      dx: map(input.dx),
      dy: map(input.dy),
      dz: map(input.dz),
    };
  }
  return {
    mode: 'polar',
    base: input.base,
    distance: map(input.distance),
    azimuth: map(input.azimuth),
    elevation: map(input.elevation),
  };
}

/**
 * 3D スケッチの円弧の向き(FR-330)の式を写す。向きは2つの座標指定なので座標と同じ扱いでよい。
 * **指定が無い(作図面がある)ときは無いままにする**(空の指定を作ると「向きを指定した円弧」に
 * 化けるため)。
 */
function mapFreeOrientation(
  orientation: FreeArcOrientation | undefined,
  map: ValueMapper,
): FreeArcOrientation | undefined {
  if (orientation === undefined) {
    return undefined;
  }
  return {
    normal: mapCoordinateExpressions(orientation.normal, map),
    xAxis: mapCoordinateExpressions(orientation.xAxis, map),
  };
}

/**
 * 点列の並べ方(FR-327)の式を種類ごとに写す。`layout.kind` は式を持たないのでそのまま引き継ぎ、
 * 各欄の式だけを写す。
 */
function mapPointArrayLayout(layout: PointArrayLayout, map: ValueMapper): PointArrayLayout {
  switch (layout.kind) {
    case 'linear':
      return {
        kind: 'linear',
        base: mapCoordinateExpressions(layout.base, map),
        azimuth: map(layout.azimuth),
        spacing: map(layout.spacing),
        count: map(layout.count),
      };
    case 'circular':
      return {
        kind: 'circular',
        center: mapCoordinateExpressions(layout.center, map),
        radius: map(layout.radius),
        count: map(layout.count),
      };
    case 'grid':
      return {
        kind: 'grid',
        base: mapCoordinateExpressions(layout.base, map),
        rowAzimuth: map(layout.rowAzimuth),
        rowSpacing: map(layout.rowSpacing),
        rowCount: map(layout.rowCount),
        colAzimuth: map(layout.colAzimuth),
        colSpacing: map(layout.colSpacing),
        colCount: map(layout.colCount),
      };
  }
}

/**
 * 複製のしかた(FR-324)の式を並べ方ごとに写す。鏡像は式を持たない(鏡にする軸・平面の
 * 参照だけ)のでそのまま返す。
 */
function mapCopyPlacement(placement: CopyPlacement, map: ValueMapper): CopyPlacement {
  switch (placement.kind) {
    case 'mirror':
      return placement;
    case 'translate':
      return { kind: 'translate', delta: mapCoordinateExpressions(placement.delta, map) };
    case 'linearArray':
      return {
        kind: 'linearArray',
        direction: mapCoordinateExpressions(placement.direction, map),
        spacing: map(placement.spacing),
        count: map(placement.count),
      };
    case 'circularArray':
      return {
        kind: 'circularArray',
        center: mapCoordinateExpressions(placement.center, map),
        angle: map(placement.angle),
        count: map(placement.count),
        fullCircle: placement.fullCircle,
      };
  }
}

/** フィーチャー14種の式の欄を写す(網羅。`default` を書かない)。 */
function rebuildFeature(feature: SketchFeature, map: ValueMapper): SketchFeature {
  switch (feature.kind) {
    case 'point':
      return { ...feature, at: mapCoordinateExpressions(feature.at, map) };
    case 'line':
      return {
        ...feature,
        from: mapCoordinateExpressions(feature.from, map),
        to: mapCoordinateExpressions(feature.to, map),
      };
    case 'arc':
      return {
        ...feature,
        center: mapCoordinateExpressions(feature.center, map),
        radius: map(feature.radius),
        startAngle: map(feature.startAngle),
        endAngle: map(feature.endAngle),
        freeOrientation: mapFreeOrientation(feature.freeOrientation, map),
      };
    case 'pointArray':
      return { ...feature, layout: mapPointArrayLayout(feature.layout, map) };
    case 'face':
      // 面は式を持たない(境界の参照と色だけ)。
      return feature;
    case 'rectangle':
      return {
        ...feature,
        corner1: mapCoordinateExpressions(feature.corner1, map),
        corner2: mapCoordinateExpressions(feature.corner2, map),
      };
    case 'polygon':
      return {
        ...feature,
        center: mapCoordinateExpressions(feature.center, map),
        sides: map(feature.sides),
        radius: map(feature.radius),
      };
    case 'slot':
      return {
        ...feature,
        center1: mapCoordinateExpressions(feature.center1, map),
        center2: mapCoordinateExpressions(feature.center2, map),
        width: map(feature.width),
      };
    case 'ellipse':
      return {
        ...feature,
        center: mapCoordinateExpressions(feature.center, map),
        majorRadius: map(feature.majorRadius),
        minorRadius: map(feature.minorRadius),
        rotation: map(feature.rotation),
        startAngle: map(feature.startAngle),
        endAngle: map(feature.endAngle),
      };
    case 'spline':
      // スプラインが持つ式は点の座標だけ(通過点・制御点とも同じ扱い)。
      return {
        ...feature,
        points: feature.points.map((input) => mapCoordinateExpressions(input, map)),
      };
    case 'offset':
      // オフセットが持つ式は距離だけ(元の要素・側・角は式ではない)。
      return { ...feature, distance: map(feature.distance) };
    case 'copy':
      return { ...feature, placement: mapCopyPlacement(feature.placement, map) };
    case 'projectedCurve':
    case 'planeSection':
      // 投影・交差が持つのは立体への参照と作図面だけで、式は1つも無い(FR-325)。
      return feature;
  }
}

/** 拘束14種のうち、目標値の式を持つ4種(距離・角度・半径・直径)を写す(FR-313、§2.2)。 */
function rebuildConstraint(constraint: SketchConstraint, map: ValueMapper): SketchConstraint {
  switch (constraint.kind) {
    case 'coincident':
    case 'horizontal':
    case 'vertical':
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'concentric':
    case 'equal':
    case 'symmetric':
    case 'fix':
      // 幾何拘束と「固定」は目標値を持たない(指す先だけ)。
      return constraint;
    case 'distance':
      return { ...constraint, length: map(constraint.length) };
    case 'angle':
      return { ...constraint, angle: map(constraint.angle) };
    case 'radius':
    case 'diameter':
      return { ...constraint, size: map(constraint.size) };
  }
}

/**
 * フィーチャー1つの式を写す。**式が1つも入れ替わらなければ元のフィーチャーを返す**
 * (`mapKeepingIdentity` と同じ理由)。
 */
export function mapSketchFeatureExpressions(
  feature: SketchFeature,
  map: ExpressionMapper,
): SketchFeature {
  let changed = false;
  const mapValue: ValueMapper = (value) => {
    const next = map(value, feature.id);
    if (next !== value) {
      changed = true;
    }
    return next;
  };
  const next = rebuildFeature(feature, mapValue);
  return changed ? next : feature;
}

/** 拘束1つの目標値の式を写す。入れ替わらなければ元の拘束を返す。 */
export function mapSketchConstraintExpressions(
  constraint: SketchConstraint,
  map: ExpressionMapper,
): SketchConstraint {
  let changed = false;
  const mapValue: ValueMapper = (value) => {
    const next = map(value, constraint.id);
    if (next !== value) {
      changed = true;
    }
    return next;
  };
  const next = rebuildConstraint(constraint, mapValue);
  return changed ? next : constraint;
}

/**
 * スケッチ文書の中の全ての式を写す(フィーチャーの式と、拘束の目標値の式)。
 * 何も入れ替わらなければ元の文書をそのまま返す。
 *
 * 拘束の欄が**無い**文書(版4までの `.pcad`)は無いままにする。`?? []` で補うと、
 * 拘束を1つも持たない文書に空の配列が生えて、保存の往復で形が変わってしまう。
 */
export function mapSketchExpressions(
  document: SketchDocument,
  map: ExpressionMapper,
): SketchDocument {
  const features = mapKeepingIdentity(document.features, (feature) =>
    mapSketchFeatureExpressions(feature, map),
  );
  const constraints =
    document.constraints === undefined
      ? undefined
      : mapKeepingIdentity(document.constraints, (constraint) =>
          mapSketchConstraintExpressions(constraint, map),
        );
  if (features === document.features && constraints === document.constraints) {
    return document;
  }
  return constraints === undefined
    ? { ...document, features }
    : { ...document, features, constraints };
}
