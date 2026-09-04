/**
 * P4 の新しい図形(円・2 点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン・
 * 点列の円周/格子)を、その場数値入力の確定から履歴へ積む純関数
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク12)。
 *
 * 対応要件: FR-314(矩形)、FR-315(正多角形)、FR-316(長穴)、FR-317(スプライン)、
 * FR-318(楕円・楕円弧)、FR-320(構築線)、FR-326(円・2 点+半径の円弧)、FR-327(点列の拡張)。
 *
 * `sketchCommands.ts`(P1 の点・線分・円弧・点列・面)と同じ流儀にそろえる。DOM にも
 * ストアにも触れず、文書は不変で、確定できないときは元の文書をそのまま返して断る理由だけを
 * 添える(FR-504、NFR-UX-5)。段の遷移と欄の中身は `numericInput.ts`(タスク11)が決め、
 * ここは「決まった値を履歴の形へ直す」ことだけを受け持つ。
 *
 * **要素の種類は id の接頭辞ではなく文書への所属で見分ける**
 * (`docs/報告記録.md` 2026-09-03 13:05 の②)。ここで足す仮の点も「文書へ足して解いて捨てる」
 * 形にしてあり、id の形で本物と見分けさせない。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  baseWorkPlane,
  DEFAULT_WORK_PLANE_ID,
  nextFeatureId,
  nextFeatureName,
  planeToWorld,
  radiansToDegrees,
  resolveSketch,
  WORK_PLANES,
  worldToPlane,
  type CoordinateInput,
  type PointReference,
  type SketchDocument,
  type Vec3,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import {
  appendSplinePoint,
  applySplineShapeCommit,
  checkSplineDraft,
  DEFAULT_GRID_COLUMN_AZIMUTH_DEGREES,
  DEFAULT_GRID_ROW_AZIMUTH_DEGREES,
  twoPointArcCenterOffset,
  twoPointArcRadiusRejection,
  valueByFieldKey,
  type CoordinateNumericInputStep,
  type NumericInputCommit,
  type NumericInputState,
  type SketchCommitChoices,
  type SketchCommitFlags,
  type SplineDraft,
} from './numericInput.js';

/** 全周(度)。円と全周の楕円は開始角 0・終了角 360 で表す(model の `isFullCircle` と同じ約束)。 */
const FULL_TURN_DEGREES = 360;
const FULL_TURN_RADIANS = 2 * Math.PI;

const ZERO_DEGREES: ExpressionValue = expressionValueFromNumber(0);
const FULL_TURN: ExpressionValue = expressionValueFromNumber(FULL_TURN_DEGREES);

/** 2 点+半径の円弧が、1 点目から 2 点目へ進む向きのどちら側へふくらむか(FR-326)。 */
export type ArcBulge = 'left' | 'right';

/* ---------------------------------------------------------------------------
 * 1 つの図形を履歴へ積む
 * ------------------------------------------------------------------------- */

/**
 * 円(中心+半径、FR-326)。model に円の種類は無いので、既存の円弧を全周(0°〜360°)で作る
 * (§2.3「円は既存の `arc` kind で startAngle=0, endAngle=360」)。名前も円弧の連番になる。
 */
export function commitCircle(
  document: SketchDocument,
  planeId: WorkPlaneId,
  center: CoordinateInput,
  radius: ExpressionValue,
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'arc'),
    name: nextFeatureName(document, 'arc'),
    planeId,
    kind: 'arc',
    center,
    radius,
    startAngle: ZERO_DEGREES,
    endAngle: FULL_TURN,
    construction,
  });
}

/** 2 点+半径の円弧を作れなかったときは理由を返す(NFR-UX-5)。 */
export type TwoPointArcOutcome =
  | { readonly ok: true; readonly document: SketchDocument }
  | { readonly ok: false; readonly reason: string };

/**
 * 2 点+半径の円弧(FR-326、§0.a-0.18)。中心を自前で求めてから既存の円弧として積む。
 *
 * model の円弧は「中心・半径・開始角・終了角」で持つので、通した 2 点は保存できない。
 * ここで求めた中心を絶対座標として保存する(2 点を後から動かして追従させることはできない)。
 */
export function commitTwoPointArc(
  document: SketchDocument,
  planeId: WorkPlaneId,
  start: CoordinateInput,
  end: CoordinateInput,
  radius: ExpressionValue,
  bulge: ArcBulge,
  construction = false,
): TwoPointArcOutcome {
  const positions = resolveShapePoints(document, planeId, [start, end]);
  if (positions === null) {
    return { ok: false, reason: t('shape.error.unresolvedPoint') };
  }
  const plane = shapePlane(planeId);
  const geometry = twoPointArcGeometry(plane, positions[0], positions[1], radius.value, bulge);
  if (geometry === null) {
    const [startU, startV] = worldToPlane(plane, positions[0]);
    const [endU, endV] = worldToPlane(plane, positions[1]);
    const chord = Math.hypot(endU - startU, endV - startV);
    return {
      ok: false,
      reason: twoPointArcRadiusRejection(chord, radius.value) ?? t('shape.error.unresolvedPoint'),
    };
  }
  return {
    ok: true,
    document: appendFeature(document, {
      id: nextFeatureId(document, 'arc'),
      name: nextFeatureName(document, 'arc'),
      planeId,
      kind: 'arc',
      center: absoluteCoordinate(geometry.center[0], geometry.center[1], geometry.center[2]),
      radius,
      startAngle: expressionValueFromNumber(geometry.startAngleDegrees),
      endAngle: expressionValueFromNumber(geometry.endAngleDegrees),
      construction,
    }),
  };
}

/**
 * 矩形(FR-314)。対角の 2 点をそのまま保存する(中心+幅+高さの指定はプロパティ側、§2.3)。
 * 2 点目の基準は 1 点目にそろえる(`resolveSketch` が矩形の 2 点目を
 * 「1 点目を直前の点として」解くため)。
 */
export function commitRectangle(
  document: SketchDocument,
  planeId: WorkPlaneId,
  corner1: CoordinateInput,
  corner2: CoordinateInput,
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'rectangle'),
    name: nextFeatureName(document, 'rectangle'),
    planeId,
    kind: 'rectangle',
    corner1,
    corner2: rebaseToPrevious(corner2),
    construction,
  });
}

/** 正多角形(FR-315)。半径の測り方の既定は外接(頂点を通る)で、選択肢で内接へ変えられる。 */
export function commitPolygon(
  document: SketchDocument,
  planeId: WorkPlaneId,
  center: CoordinateInput,
  sides: ExpressionValue,
  radius: ExpressionValue,
  radiusMode: 'circumscribed' | 'inscribed',
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'polygon'),
    name: nextFeatureName(document, 'polygon'),
    planeId,
    kind: 'polygon',
    center,
    sides,
    radius,
    radiusMode,
    construction,
  });
}

/** 長穴(FR-316)。2 つの中心と幅で持つ。2 つ目の中心の基準は 1 つ目にそろえる。 */
export function commitSlot(
  document: SketchDocument,
  planeId: WorkPlaneId,
  center1: CoordinateInput,
  center2: CoordinateInput,
  width: ExpressionValue,
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'slot'),
    name: nextFeatureName(document, 'slot'),
    planeId,
    kind: 'slot',
    center1,
    center2: rebaseToPrevious(center2),
    width,
    construction,
  });
}

/**
 * 楕円・楕円弧(FR-318)。角度はすべて度で、開始角と終了角は長軸から測った方位角
 * (model が保存するのも方位角。パラメータ角への変換は `resolveSketch` が行う)。
 * 「一部だけ」を使わないときは 0°〜360° を渡して全周にする。
 */
export function commitEllipse(
  document: SketchDocument,
  planeId: WorkPlaneId,
  center: CoordinateInput,
  majorRadius: ExpressionValue,
  minorRadius: ExpressionValue,
  rotation: ExpressionValue,
  startAngle: ExpressionValue,
  endAngle: ExpressionValue,
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'ellipse'),
    name: nextFeatureName(document, 'ellipse'),
    planeId,
    kind: 'ellipse',
    center,
    majorRadius,
    minorRadius,
    rotation,
    startAngle,
    endAngle,
    construction,
  });
}

/**
 * スプライン(FR-317)。置いた順がそのまま曲線の向きになる。
 * 閉じるときも最初の点を末尾へ重ねない(model が輪として扱う)。
 */
export function commitSpline(
  document: SketchDocument,
  planeId: WorkPlaneId,
  mode: 'interpolate' | 'control',
  points: readonly CoordinateInput[],
  closed = false,
  construction = false,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'spline'),
    name: nextFeatureName(document, 'spline'),
    planeId,
    kind: 'spline',
    mode,
    points,
    closed,
    construction,
  });
}

/** 円周上の点列(FR-327)。開始角は作図面の第1軸に固定(model の `PointArrayLayout`)。 */
export function commitCircularPointArray(
  document: SketchDocument,
  planeId: WorkPlaneId,
  center: CoordinateInput,
  radius: ExpressionValue,
  count: ExpressionValue,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'pointArray'),
    name: nextFeatureName(document, 'pointArray'),
    planeId,
    kind: 'pointArray',
    layout: { kind: 'circular', center, radius, count },
  });
}

/** 格子状の点列(FR-327)。行と列の向きは既定(第1軸と第2軸)で、傾けるのはプロパティ側。 */
export function commitGridPointArray(
  document: SketchDocument,
  planeId: WorkPlaneId,
  base: CoordinateInput,
  rowAzimuth: ExpressionValue,
  rowSpacing: ExpressionValue,
  rowCount: ExpressionValue,
  colAzimuth: ExpressionValue,
  colSpacing: ExpressionValue,
  colCount: ExpressionValue,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'pointArray'),
    name: nextFeatureName(document, 'pointArray'),
    planeId,
    kind: 'pointArray',
    layout: {
      kind: 'grid',
      base,
      rowAzimuth,
      rowSpacing,
      rowCount,
      colAzimuth,
      colSpacing,
      colCount,
    },
  });
}

/* ---------------------------------------------------------------------------
 * 2 点+半径の円弧の幾何(§0.a-0.18)
 * ------------------------------------------------------------------------- */

/**
 * 2 点と半径から円弧の中心を求める(FR-326、§0.a-0.18)。
 *
 * 中心は 2 点を結ぶ弦の垂直二等分線上にあり、中点から
 * √(半径² − (弦の半分)²)(`twoPointArcCenterOffset`)だけ離れている。解は 2 つあり、
 * どちらを採るかは「ふくらむ向き」で決める。**弧が左へふくらむとき中心は進む向きの右側**
 * にあるので、左を選んだら中点から右へ、右を選んだら中点から左へ進む。
 * 半径が弦の半分より小さいと 2 点を通る円が引けないので null を返す。
 *
 * 2 点は作図面へ落としてから測る(矩形・長穴と同じ扱い)。指定が作図面から多少ずれても
 * 円弧は作図面の上に乗る。
 */
export function arcCenterFromTwoPointsAndRadius(
  plane: WorkPlane,
  start: Vec3,
  end: Vec3,
  radius: number,
  bulge: ArcBulge,
): Vec3 | null {
  const [startU, startV] = worldToPlane(plane, start);
  const [endU, endV] = worldToPlane(plane, end);
  const deltaU = endU - startU;
  const deltaV = endV - startV;
  const chord = Math.hypot(deltaU, deltaV);
  const offset = twoPointArcCenterOffset(chord, radius);
  if (offset === null) {
    return null;
  }
  // 進む向きを作図面の中で 90 度回した向き(第1軸から第2軸へ回る向きが正なので「左」)。
  const leftU = -deltaV / chord;
  const leftV = deltaU / chord;
  const side = bulge === 'left' ? -1 : 1;
  return planeToWorld(
    plane,
    (startU + endU) / 2 + side * offset * leftU,
    (startV + endV) / 2 + side * offset * leftV,
  );
}

/** 2 点+半径の円弧を、model の円弧(中心・開始角・終了角)の形で表したもの。 */
export interface TwoPointArcGeometry {
  readonly center: Vec3;
  /** 度。作図面の第1軸から測る(model の円弧と同じ約束)。 */
  readonly startAngleDegrees: number;
  readonly endAngleDegrees: number;
}

/**
 * 2 点+半径の円弧の中心と角度(FR-326)。
 *
 * **開始角は必ず終了角より小さくする**(反時計回りに進む形へそろえる)。カーネルの
 * `BRepBuilderAPI_MakeEdge_9` へ逆回りの角度を渡したときの振る舞いを当てにしないため。
 * 左へふくらむときは 2 点目から 1 点目へ回るほうが短い弧になるので、その向きで始まりと
 * 終わりを入れ替える(見える形は同じで、曲線の向きだけが変わる)。
 */
export function twoPointArcGeometry(
  plane: WorkPlane,
  start: Vec3,
  end: Vec3,
  radius: number,
  bulge: ArcBulge,
): TwoPointArcGeometry | null {
  const center = arcCenterFromTwoPointsAndRadius(plane, start, end, radius, bulge);
  if (center === null) {
    return null;
  }
  const startAzimuth = planeAzimuth(plane, center, start);
  const endAzimuth = planeAzimuth(plane, center, end);
  const first = bulge === 'left' ? endAzimuth : startAzimuth;
  const second = bulge === 'left' ? startAzimuth : endAzimuth;
  return {
    center,
    startAngleDegrees: radiansToDegrees(first),
    endAngleDegrees: radiansToDegrees(first + counterClockwiseSweep(first, second)),
  };
}

/** 作図面の中で、中心から見た点の方位角(ラジアン)。第1軸から第2軸へ回る向きが正。 */
function planeAzimuth(plane: WorkPlane, center: Vec3, point: Vec3): number {
  const [centerU, centerV] = worldToPlane(plane, center);
  const [pointU, pointV] = worldToPlane(plane, point);
  return Math.atan2(pointV - centerV, pointU - centerU);
}

/** `from` から `to` まで反時計回りに測った角度(0 より大きく 2π 以下)。 */
function counterClockwiseSweep(from: number, to: number): number {
  const sweep = (to - from) % FULL_TURN_RADIANS;
  return sweep <= 0 ? sweep + FULL_TURN_RADIANS : sweep;
}

/* ---------------------------------------------------------------------------
 * 図形の途中経過(下書き)
 * ------------------------------------------------------------------------- */

/** 前の段で決めた欄の値。欄の名前で引く(並び順の取り違えを防ぐ)。 */
export interface ShapeDraftValue {
  readonly key: string;
  readonly value: ExpressionValue;
}

/**
 * 新しい図形の途中経過(タスク12)。
 *
 * P1 の道具は「1 点覚えて次の段で使う」だけだったので `pendingStart`(座標 1 つ)で足りたが、
 * P4 の図形には**点を 2 つ以上置く**もの(長穴・2 点+半径の円弧・スプライン)と、
 * **欄の値を段をまたいで持ち越す**もの(楕円の半径と傾き、格子の行)があるため、
 * 置いた点・前の段の値・つまみ・選択肢をまとめてここへ積む。
 * 道具を変える・ポップアップを閉じると空へ戻る(取りかけを持ち越さない、NFR-UX-3)。
 */
export interface ShapeDraft {
  /** 置いた順の座標。1 点目から積む。 */
  readonly points: readonly CoordinateInput[];
  /** 前の段で決めた欄の値。 */
  readonly values: readonly ShapeDraftValue[];
  /** これまでの段で決めたつまみ(構築線・一部だけ・閉じる)。 */
  readonly flags: SketchCommitFlags;
  /** これまでの段で決めた選択肢(半径の測り方・並べ方・点の使い方・ふくらむ向き)。 */
  readonly choices: SketchCommitChoices;
}

/** 何も置いていない下書き。 */
export const EMPTY_SHAPE_DRAFT: ShapeDraft = {
  points: [],
  values: [],
  flags: {},
  choices: {},
};

/** 下書きから、前の段で決めた欄の値を名前で引く。無ければ undefined。 */
export function draftValue(draft: ShapeDraft, key: string): ExpressionValue | undefined {
  return draft.values.find((entry) => entry.key === key)?.value;
}

/* ---------------------------------------------------------------------------
 * 段の確定を下書きと履歴へ反映する
 * ------------------------------------------------------------------------- */

export interface ShapeCommitContext {
  readonly document: SketchDocument;
  readonly planeId: WorkPlaneId;
  /** 点列の基準点(P1 の道具と共有する取りかけ)。新しい図形の点は `draft.points`。 */
  readonly pendingStart: CoordinateInput | null;
  readonly draft: ShapeDraft;
  /**
   * 確定した段のポップアップの状態。欄の値を名前で引く(`valueByFieldKey`)のに要る。
   * 渡されなければ履歴を変えずに何もしない(渡し忘れを黙って形にしない)。
   */
  readonly input: NumericInputState | null;
}

export interface ShapeCommitOutcome {
  readonly document: SketchDocument;
  readonly pendingStart: CoordinateInput | null;
  readonly draft: ShapeDraft;
  /** 断った理由(NFR-UX-5)。断っていなければ null。 */
  readonly rejection: string | null;
}

/**
 * 新しい図形の 1 段を下書き・履歴へ反映する(FR-314〜318、FR-326、FR-327)。
 *
 * 途中の段は履歴を変えずに下書きへ積み、要素が決まる最後の段でだけ履歴へ足す。
 * 断るときは履歴も下書きも作りかけのまま残さず、理由だけを返す(FR-504)。
 */
export function commitShapeInput(
  commit: NumericInputCommit,
  context: ShapeCommitContext,
): ShapeCommitOutcome {
  const draft: ShapeDraft = {
    ...context.draft,
    flags: mergeFlags(context.draft.flags, commit.flags),
    choices: mergeChoices(context.draft.choices, commit.choices),
  };
  const next: ShapeCommitContext = { ...context, draft };
  return commit.kind === 'coordinate'
    ? placeShapePoint(commit.step, commit.coordinate, next)
    : buildShapeFeature(commit, next);
}

/** 座標を 1 点決めた段。1 点で決まる図形は無いので、最後の 1 点でだけ履歴へ足す。 */
function placeShapePoint(
  step: CoordinateNumericInputStep,
  coordinate: CoordinateInput,
  context: ShapeCommitContext,
): ShapeCommitOutcome {
  switch (step) {
    case 'circleCenter':
    case 'twoPointArcStart':
    case 'rectangleCorner1':
    case 'polygonCenter':
    case 'slotCenter1':
    case 'ellipseCenter':
      // 図形の 1 点目。前の取りかけは持ち越さず、ここから作り直す(NFR-UX-3)。
      return unchanged(withDraft(context, { points: [coordinate], values: [] }));

    case 'twoPointArcEnd':
    case 'slotCenter2':
      return unchanged(withDraft(context, { points: [...context.draft.points, coordinate] }));

    case 'rectangleCorner2': {
      const corner1 = context.draft.points[0];
      if (corner1 === undefined) {
        return unchanged(context);
      }
      return finished(
        commitRectangle(
          context.document,
          context.planeId,
          corner1,
          coordinate,
          context.draft.flags.construction ?? false,
        ),
      );
    }

    case 'splinePoint': {
      // 点の数の上限(model の MAX_SPLINE_POINTS)は タスク11 の規則をそのまま使う。
      const outcome = appendSplinePoint(splineDraftOf(context.draft), coordinate);
      if (!outcome.ok) {
        return rejected(context, outcome.reason);
      }
      return unchanged(withDraft(context, { points: outcome.draft.points }));
    }

    case 'point':
    case 'lineStart':
    case 'lineEnd':
    case 'arcCenter':
    case 'pointArrayBase':
      // P1 の道具の段。履歴へ積むのは sketchCommands.ts の受け持ちなので何もしない。
      return unchanged(context);
  }
}

/** 欄の値を決めた段。要素が決まるものはここで履歴へ足す。 */
function buildShapeFeature(
  commit: Extract<NumericInputCommit, { readonly kind: 'shape' }>,
  context: ShapeCommitContext,
): ShapeCommitOutcome {
  const { document, planeId, draft, input } = context;
  if (input === null) {
    // 段の状態が無いと欄の値を名前で引けない。壊れた形を黙って作らない。
    return unchanged(context);
  }
  const value = (key: string): ExpressionValue | undefined =>
    valueByFieldKey(input, commit.values, key);
  const construction = draft.flags.construction ?? false;
  const first = draft.points[0];

  switch (commit.step) {
    case 'circleRadius': {
      const radius = value('radius');
      if (first === undefined || radius === undefined) {
        return unchanged(context);
      }
      return finished(commitCircle(document, planeId, first, radius, construction));
    }

    case 'twoPointArcRadius': {
      const radius = value('radius');
      const second = draft.points[1];
      if (first === undefined || second === undefined || radius === undefined) {
        return unchanged(context);
      }
      const outcome = commitTwoPointArc(
        document,
        planeId,
        first,
        second,
        radius,
        draft.choices.arcBulge ?? 'left',
        construction,
      );
      return outcome.ok ? finished(outcome.document) : rejected(context, outcome.reason);
    }

    case 'polygonShape': {
      const sides = value('sides');
      const radius = value('radius');
      if (first === undefined || sides === undefined || radius === undefined) {
        return unchanged(context);
      }
      return finished(
        commitPolygon(
          document,
          planeId,
          first,
          sides,
          radius,
          draft.choices.polygonRadiusMode ?? 'circumscribed',
          construction,
        ),
      );
    }

    case 'slotShape': {
      const width = value('width');
      const second = draft.points[1];
      if (first === undefined || second === undefined || width === undefined) {
        return unchanged(context);
      }
      return finished(commitSlot(document, planeId, first, second, width, construction));
    }

    case 'ellipseShape': {
      const majorRadius = value('majorRadius');
      const minorRadius = value('minorRadius');
      if (majorRadius === undefined || minorRadius === undefined) {
        return unchanged(context);
      }
      // 楕円は 2 段目(半径)→ 3 段目(傾き)→ 必要なら 4 段目(角度)なので値を持ち越す。
      return unchanged(
        withDraft(context, {
          values: [
            { key: 'majorRadius', value: majorRadius },
            { key: 'minorRadius', value: minorRadius },
          ],
        }),
      );
    }

    case 'ellipseAngles': {
      const rotation = value('rotation');
      if (rotation === undefined) {
        return unchanged(context);
      }
      const carried = withDraft(context, {
        values: [...draft.values, { key: 'rotation', value: rotation }],
      });
      // 「一部だけ(楕円弧)」が入なら次の段で開始角・終了角を聞く。切ならここで全周にする。
      return draft.flags.ellipseArc === true
        ? unchanged(carried)
        : finishEllipse(carried, ZERO_DEGREES, FULL_TURN);
    }

    case 'ellipseArcAngles': {
      const startAngle = value('startAngle');
      const endAngle = value('endAngle');
      if (startAngle === undefined || endAngle === undefined) {
        return unchanged(context);
      }
      return finishEllipse(context, startAngle, endAngle);
    }

    case 'splineShape': {
      const spline = applySplineShapeCommit(splineDraftOf(draft), commit);
      const check = checkSplineDraft(spline);
      if (!check.ok) {
        return rejected(context, check.reason);
      }
      return finished(
        commitSpline(document, planeId, spline.mode, spline.points, spline.closed, construction),
      );
    }

    case 'pointArrayShape':
      return buildPointArray(context, value);

    case 'pointArrayGridColumns': {
      const colSpacing = value('colSpacing');
      const colCount = value('colCount');
      const rowSpacing = draftValue(draft, 'rowSpacing');
      const rowCount = draftValue(draft, 'rowCount');
      const base = context.pendingStart;
      if (
        base === null ||
        colSpacing === undefined ||
        colCount === undefined ||
        rowSpacing === undefined ||
        rowCount === undefined
      ) {
        return unchanged(context);
      }
      return finished(
        commitGridPointArray(
          document,
          planeId,
          base,
          expressionValueFromNumber(DEFAULT_GRID_ROW_AZIMUTH_DEGREES),
          rowSpacing,
          rowCount,
          expressionValueFromNumber(DEFAULT_GRID_COLUMN_AZIMUTH_DEGREES),
          colSpacing,
          colCount,
        ),
      );
    }

    case 'arcShape':
      // P1 の円弧の段。履歴へ積むのは sketchCommands.ts の受け持ち。
      return unchanged(context);
  }
}

/** 点列の並べ方が円周・格子のときの段(FR-327)。直線状は sketchCommands.ts のまま。 */
function buildPointArray(
  context: ShapeCommitContext,
  value: (key: string) => ExpressionValue | undefined,
): ShapeCommitOutcome {
  const base = context.pendingStart;
  const layout = context.draft.choices.pointArrayLayout;
  if (base === null) {
    return unchanged(context);
  }
  if (layout === 'circular') {
    const radius = value('radius');
    const count = value('circularCount');
    if (radius === undefined || count === undefined) {
      return unchanged(context);
    }
    return finished(
      commitCircularPointArray(context.document, context.planeId, base, radius, count),
    );
  }
  if (layout !== 'grid') {
    // 直線状はここへ来ない(sketchCommands.ts が P1 のまま受け持つ)。
    return unchanged(context);
  }
  const rowSpacing = value('rowSpacing');
  const rowCount = value('rowCount');
  if (rowSpacing === undefined || rowCount === undefined) {
    return unchanged(context);
  }
  // 格子は「行」「列」の 2 段。行の値を持ち越して列の段へ進む。
  return unchanged(
    withDraft(context, {
      values: [
        { key: 'rowSpacing', value: rowSpacing },
        { key: 'rowCount', value: rowCount },
      ],
    }),
  );
}

/** 下書きに積んだ中心・半径・傾きと、渡された角度で楕円を作る(FR-318)。 */
function finishEllipse(
  context: ShapeCommitContext,
  startAngle: ExpressionValue,
  endAngle: ExpressionValue,
): ShapeCommitOutcome {
  const { document, planeId, draft } = context;
  const center = draft.points[0];
  const majorRadius = draftValue(draft, 'majorRadius');
  const minorRadius = draftValue(draft, 'minorRadius');
  const rotation = draftValue(draft, 'rotation');
  if (
    center === undefined ||
    majorRadius === undefined ||
    minorRadius === undefined ||
    rotation === undefined
  ) {
    return unchanged(context);
  }
  return finished(
    commitEllipse(
      document,
      planeId,
      center,
      majorRadius,
      minorRadius,
      rotation,
      startAngle,
      endAngle,
      draft.flags.construction ?? false,
    ),
  );
}

/* ---------------------------------------------------------------------------
 * 小道具
 * ------------------------------------------------------------------------- */

/** 履歴も下書きも変えない。 */
function unchanged(context: ShapeCommitContext): ShapeCommitOutcome {
  return {
    document: context.document,
    pendingStart: context.pendingStart,
    draft: context.draft,
    rejection: null,
  };
}

/** 履歴も下書きも変えずに理由だけを返す(NFR-UX-5)。 */
function rejected(context: ShapeCommitContext, reason: string): ShapeCommitOutcome {
  return {
    document: context.document,
    pendingStart: context.pendingStart,
    draft: context.draft,
    rejection: reason,
  };
}

/** 要素を積み終えた。取りかけは空へ戻す。 */
function finished(document: SketchDocument): ShapeCommitOutcome {
  return { document, pendingStart: null, draft: EMPTY_SHAPE_DRAFT, rejection: null };
}

/** 下書きの一部を差し替えた文脈。 */
function withDraft(context: ShapeCommitContext, patch: Partial<ShapeDraft>): ShapeCommitContext {
  return { ...context, draft: { ...context.draft, ...patch } };
}

/** 下書きを、タスク11 のスプラインの規則(`checkSplineDraft` 等)が読める形にする。 */
function splineDraftOf(draft: ShapeDraft): SplineDraft {
  return {
    points: draft.points,
    mode: draft.choices.splineMode ?? 'interpolate',
    closed: draft.flags.splineClosed ?? false,
  };
}

/**
 * つまみの持ち越し。持たない段からは `undefined` で届くので、前の段の値を残す
 * (楕円の構築線は 3 段目のつまみだが、確定するのは 4 段目のことがある)。
 */
function mergeFlags(base: SketchCommitFlags, next: SketchCommitFlags): SketchCommitFlags {
  return {
    construction: next.construction ?? base.construction,
    ellipseArc: next.ellipseArc ?? base.ellipseArc,
    splineClosed: next.splineClosed ?? base.splineClosed,
  };
}

/** 選択肢の持ち越し。つまみと同じ理由で、持たない段の `undefined` で消さない。 */
function mergeChoices(
  base: SketchCommitChoices,
  next: SketchCommitChoices,
): SketchCommitChoices {
  return {
    polygonRadiusMode: next.polygonRadiusMode ?? base.polygonRadiusMode,
    pointArrayLayout: next.pointArrayLayout ?? base.pointArrayLayout,
    splineMode: next.splineMode ?? base.splineMode,
    arcBulge: next.arcBulge ?? base.arcBulge,
  };
}

/** 相対・極の基準を「直前の点」にそろえる(線分の終点と同じ扱い、FR-307)。 */
function rebaseToPrevious(coordinate: CoordinateInput): CoordinateInput {
  const base: PointReference = { kind: 'previous' };
  if (coordinate.mode === 'relative') {
    return { ...coordinate, base };
  }
  if (coordinate.mode === 'polar') {
    return { ...coordinate, base };
  }
  return coordinate;
}

/**
 * 操作に使う作図面。任意の作業平面(FR-328)は部品文書を見ないと決まらないので、
 * ここでは基準の 3 面だけを引き、それ以外は既定の XY に落とす
 * (`attachSketchInteraction.ts` の `interactionPlane` と同じ扱い。任意平面の配線はタスク13)。
 */
function shapePlane(planeId: WorkPlaneId): WorkPlane {
  return baseWorkPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID];
}

/** 世界座標を求めるためだけに履歴へ足す仮の点の id の頭。文書には残さない。 */
const PROBE_ID_PREFIX = 'shape-probe-';

/**
 * まだ履歴に無い座標(いま置いた点)を世界座標へ直す。
 *
 * 座標は「直前の点からの相対」や「距離と角度」でも指定できるので、`resolveSketch` が
 * 履歴を解くのと同じ手掛かりが要る。仮の点を履歴の末尾へ足して解き、位置だけを取り出す
 * (足した文書は捨てるので履歴は汚れない)。2 点目以降は 1 つ前の点を「直前の点」として
 * 解けるので、矩形の対角・長穴の 2 中心・スプラインの点の並びが、出来上がった
 * フィーチャーを `resolveSketch` が解くときと同じ位置になる。
 */
export function resolveShapePoints(
  document: SketchDocument,
  planeId: WorkPlaneId,
  points: readonly CoordinateInput[],
): readonly Vec3[] | null {
  let probed = document;
  const ids: string[] = [];
  points.forEach((at, index) => {
    const id = `${PROBE_ID_PREFIX}${String(index)}`;
    ids.push(id);
    probed = appendFeature(probed, { id, name: id, planeId, kind: 'point', at });
  });
  const resolved = resolveSketch(probed);
  const positions: Vec3[] = [];
  for (const id of ids) {
    const found = resolved.points.find((point) => point.id === id);
    if (found === undefined) {
      return null;
    }
    positions.push(found.position);
  }
  return positions;
}
