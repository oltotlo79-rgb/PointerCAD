/**
 * 選択とその場入力から基本形状(球・箱・円柱・円錐・トーラス)を作る純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク18、§2.7、§2.15)。
 *
 * 対応要件: FR-429(基本形状5種と3通りの基準点)、FR-201/202(式のまま持つ)、
 * FR-502(あとから式で直せる)、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できない操作は実行前に理由を示す)。
 *
 * `solidCommands.ts`(P2 タスク18)・`machiningCommands.ts`(P3 タスク25)と同じ流儀に揃える。
 * ストアにも DOM にも触れない純関数だけを置き、操作の判断を Node の単体検査で固定できる
 * ようにする(`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、断るときは元の
 * 文書をそのまま返す(FR-504)。
 *
 * **基本形状は対象を消費しない**(§0.a-0.19)。中心に立体の頂点を借りても、貸した立体は
 * そのまま画面に残る。だから加工(`machiningCommands.ts`)ではなく「作る」側に置く。
 *
 * **押せない条件を持たない**(`primitiveToolReadiness` は常に押せる)。何も選ばずに押して
 * そのまま Enter を打てば、原点に既定の大きさの形ができる(NFR-UX-4)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  createPrimitiveFeature,
  DEFAULT_BOX_SIZE_MM,
  DEFAULT_CONE_BOTTOM_RADIUS_MM,
  DEFAULT_CONE_HEIGHT_MM,
  DEFAULT_CONE_TOP_RADIUS_MM,
  DEFAULT_CYLINDER_HEIGHT_MM,
  DEFAULT_CYLINDER_RADIUS_MM,
  DEFAULT_PRIMITIVE_AXIS,
  DEFAULT_SPHERE_RADIUS_MM,
  DEFAULT_TORUS_MAJOR_RADIUS_MM,
  DEFAULT_TORUS_MINOR_RADIUS_MM,
  defaultPrimitiveOrigin,
  findSolid,
  type AxisSpec,
  type PartDocument,
  type PrimitiveFeature,
  type PrimitiveShape,
  type PrimitiveShapeKind,
  type SketchFeature,
  type SolidOrigin,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { FieldUnit, SolidCommitValues, SolidInputCommit } from '../sketch/numericInput.js';

import { findSketchFeatureAt } from './sketchRefs.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import { selectedSubShapeRefs, type SubShapeBody } from './subShapeSelection.js';

/**
 * 基本形状の道具(§2.15 のツールバー「作る」の一覧のうち5種)。
 * `SolidToolId`(`numericInput.ts` が正本)から基本形状だけに絞った型で、model の
 * `PrimitiveShapeKind` とまったく同じ語にしてある(道具 id がそのまま形の種類になる)。
 */
export type PrimitiveToolId = PrimitiveShapeKind;

/** 基本形状のコマンドが必要とする文脈。 */
export interface PrimitiveContext {
  readonly document: PartDocument;
  /**
   * カーネルが返した立体の一覧。中心に立体の頂点を指したときの指紋を作るのに要る
   * (`machiningCommands.ts` の `MachiningContext` と同じ欄・同じ理由)。
   */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。部分形状の id も入る。 */
  readonly selection: readonly string[];
}

/*
  計画書タスク18 の宣言は `PrimitiveContext` に `selectionKind` と `sketch` も持たせているが、
  どちらもこの層では読まない。中心の決め方は「選択の中に頂点があるか / スケッチの点があるか」
  だけで決まり(`selectedPrimitiveOrigin`)、スケッチは部品文書からたどれる
  (`findSketchFeatureAt` が編集中のスケッチを先に見る、`sketchRefs.ts`)。
  使わない欄を文脈に置くと呼び出し側が値を作る手間だけが増えるので、実装を正とした
  (判断に迷った点として報告する)。
*/

/** 押せる。基本形状は選択を要らないので、断る枝を持たない(NFR-UX-4)。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/** 部分形状のうち、中心にできるのは頂点だけ(FR-429、§0.a-0.18)。 */
const ORIGIN_SUB_SHAPE_KIND = 'vertex';

/** 中心にできるスケッチの要素の種類。ばねの始点と同じく**点フィーチャーだけ**(§0.a-0.29)。 */
const POINT_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['point']);

/* ------------------------------------------------------------------ *
 * 既定値(model の定数を式へ直したもの)
 * ------------------------------------------------------------------ */

/*
  欄が空のまま決めたときに使う値(NFR-UX-4)。**数そのものは model の定数だけを見る**ので、
  段の既定(`numericInput.ts`)・プロパティの既定(`defaultPrimitiveShape`)と必ず同じになる。
*/
export const DEFAULT_SPHERE_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SPHERE_RADIUS_MM,
);
export const DEFAULT_BOX_SIZE: ExpressionValue = expressionValueFromNumber(DEFAULT_BOX_SIZE_MM);
export const DEFAULT_CYLINDER_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CYLINDER_RADIUS_MM,
);
export const DEFAULT_CYLINDER_HEIGHT: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CYLINDER_HEIGHT_MM,
);
export const DEFAULT_CONE_BOTTOM_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CONE_BOTTOM_RADIUS_MM,
);
export const DEFAULT_CONE_TOP_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CONE_TOP_RADIUS_MM,
);
export const DEFAULT_CONE_HEIGHT: ExpressionValue = expressionValueFromNumber(
  DEFAULT_CONE_HEIGHT_MM,
);
export const DEFAULT_TORUS_MAJOR_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_TORUS_MAJOR_RADIUS_MM,
);
export const DEFAULT_TORUS_MINOR_RADIUS: ExpressionValue = expressionValueFromNumber(
  DEFAULT_TORUS_MINOR_RADIUS_MM,
);

/* ------------------------------------------------------------------ *
 * 中心(基準点)を選択から決める(FR-429 の3通り、§0.a-0.18)
 * ------------------------------------------------------------------ */

/**
 * 選んでいるものから中心を決める(FR-429、§0.a-0.18)。
 *
 * 見る順は **立体の頂点 → スケッチの点 → 原点**。頂点を先に見るのは、基本形状の道具が選ぶ
 * 種類を頂点にする決め(§2.15 の表)に合わせたためで、どちらも選ばれているときは
 * 「いま選ぶ種類として画面で光っているほう」を採る。
 *
 * **どれも選ばれていなければ原点の座標**(`defaultPrimitiveOrigin`、絶対座標の 0,0,0)を返す。
 * これが NFR-UX-4「Enter 連打だけで意味のある結果になる」の要で、道具を押してそのまま
 * Enter を打てば原点に既定の大きさの形ができる。座標なのであとからプロパティで式に直せる
 * (FR-202、FR-502)。
 */
export function selectedPrimitiveOrigin(context: PrimitiveContext): SolidOrigin {
  const vertices = selectedSubShapeRefs(context.bodies, context.selection, ORIGIN_SUB_SHAPE_KIND);
  const vertex = vertices[0];
  if (vertex !== undefined) {
    return { kind: 'vertex', ref: vertex };
  }
  for (const elementId of context.selection) {
    // 面・線分と同じく、編集中のスケッチを先に見る(`sketchRefs.ts` の説明)。
    const found = findSketchFeatureAt(context.document, elementId, POINT_KINDS);
    if (found !== undefined) {
      return { kind: 'sketchPoint', ref: { sketchId: found.sketchId, pointFeatureId: found.featureId } };
    }
  }
  return defaultPrimitiveOrigin();
}

/* ------------------------------------------------------------------ *
 * 寸法の先出し検査(§2.7.1 の断りの条件、NFR-UX-5)
 * ------------------------------------------------------------------ */

/**
 * 寸法が作れる形になっているかを**カーネルを呼ぶ前に**確かめる(§2.7.1、NFR-UX-5)。
 * 作れないときは断りの文言キー、作れるなら null。
 *
 * 見る順は model の `resolvePrimitiveShape`(`resolvePart.ts`)とまったく同じにしてある。
 * 同じ入力からは必ず同じ理由が出るようにするためで、片方だけ順序を変えると「画面は赤いのに
 * 保存したファイルを開くと別の理由が出る」ことになる。文言も同じ内容の日本語を ja.json に
 * 置いてある(こちらは文言キーで持つ決まり、NFR-MA-5)。
 *
 * 欄1つで言える「0 より大きい」は段の `NumericFieldRange` がすでに赤くしている(FR-204)ので、
 * ここが実際に効くのは**欄をまたぐ条件**(円錐の両方 0・上下同径、トーラスの管の半径)と、
 * プロパティから式を直したときである。
 */
export function primitiveShapeRejection(shape: PrimitiveShape): MessageKey | null {
  switch (shape.kind) {
    case 'sphere':
      return isPositiveFinite(shape.radius.value) ? null : 'primitiveError.sphereRadius';
    case 'box':
      return isPositiveFinite(shape.sizeX.value) &&
        isPositiveFinite(shape.sizeY.value) &&
        isPositiveFinite(shape.sizeZ.value)
        ? null
        : 'primitiveError.boxSize';
    case 'cylinder':
      return isPositiveFinite(shape.radius.value) && isPositiveFinite(shape.height.value)
        ? null
        : 'primitiveError.cylinderSize';
    case 'cone':
      return coneRejection(shape.bottomRadius.value, shape.topRadius.value, shape.height.value);
    case 'torus':
      return torusRejection(shape.majorRadius.value, shape.minorRadius.value);
  }
}

/** 0 より大きい有限の数か(model の `isPositiveFinite` と同じ判定)。 */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 円錐の断り(§2.7.1 の表)。高さ → 半径が負 → 両方 0 → 上下同径 の順で見る
 * (model・カーネルと同じ順)。**上半径 0 は正しい形**(尖った円錐)なので断らない。
 */
function coneRejection(bottomRadius: number, topRadius: number, height: number): MessageKey | null {
  if (!isPositiveFinite(height)) {
    return 'primitiveError.coneHeight';
  }
  // 非数は「0 以上か」を判定できないので、負と同じ理由で断る(model と同じ順)。
  if (!Number.isFinite(bottomRadius) || bottomRadius < 0) {
    return 'primitiveError.coneRadiusNegative';
  }
  if (!Number.isFinite(topRadius) || topRadius < 0) {
    return 'primitiveError.coneRadiusNegative';
  }
  if (bottomRadius <= 0 && topRadius <= 0) {
    return 'primitiveError.coneRadiusBothZero';
  }
  // 上下が同じ半径の円錐は OCCT が作れない(§2.7.1 の実測)ので円柱を促す。
  return bottomRadius === topRadius ? 'primitiveError.coneRadiusSame' : null;
}

/** トーラスの断り(§2.7.1)。管の半径が主半径以上だと中心の穴を食いつぶして自己交差する。 */
function torusRejection(majorRadius: number, minorRadius: number): MessageKey | null {
  if (!isPositiveFinite(majorRadius) || !isPositiveFinite(minorRadius)) {
    return 'primitiveError.torusRadius';
  }
  return minorRadius >= majorRadius ? 'primitiveError.torusMinorTooLarge' : null;
}

/* ------------------------------------------------------------------ *
 * 確定(その場入力 → フィーチャー)
 * ------------------------------------------------------------------ */

/**
 * その場入力の値から形の寸法を組み立てる(§2.15 の段の表)。
 * 欄が渡されなかったときは既定値を使う(空欄のまま Enter、NFR-UX-4)。
 */
export function primitiveShapeFrom(
  kind: PrimitiveToolId,
  values: SolidCommitValues,
): PrimitiveShape {
  switch (kind) {
    case 'sphere':
      return { kind: 'sphere', radius: values.sphereRadius ?? DEFAULT_SPHERE_RADIUS };
    case 'box':
      return {
        kind: 'box',
        sizeX: values.boxSizeX ?? DEFAULT_BOX_SIZE,
        sizeY: values.boxSizeY ?? DEFAULT_BOX_SIZE,
        sizeZ: values.boxSizeZ ?? DEFAULT_BOX_SIZE,
      };
    case 'cylinder':
      return {
        kind: 'cylinder',
        radius: values.cylinderRadius ?? DEFAULT_CYLINDER_RADIUS,
        height: values.cylinderHeight ?? DEFAULT_CYLINDER_HEIGHT,
      };
    case 'cone':
      return {
        kind: 'cone',
        bottomRadius: values.coneBottomRadius ?? DEFAULT_CONE_BOTTOM_RADIUS,
        topRadius: values.coneTopRadius ?? DEFAULT_CONE_TOP_RADIUS,
        height: values.coneHeight ?? DEFAULT_CONE_HEIGHT,
      };
    case 'torus':
      return {
        kind: 'torus',
        majorRadius: values.torusMajorRadius ?? DEFAULT_TORUS_MAJOR_RADIUS,
        minorRadius: values.torusMinorRadius ?? DEFAULT_TORUS_MINOR_RADIUS,
      };
  }
}

/**
 * 道具 id が基本形状5種かどうか(`as` を使わずに絞り込む)。
 * `SolidInputCommit.tool` は押し出し・加工も含む `SolidToolId` なので、確定を受けるときに
 * ここで 1 度だけ絞る(`machiningCommands.ts` が `MachiningToolId` を別に持つのと同じ形)。
 */
export function primitiveToolOf(tool: string): PrimitiveToolId | null {
  switch (tool) {
    case 'sphere':
    case 'box':
    case 'cylinder':
    case 'cone':
    case 'torus':
      return tool;
    default:
      return null;
  }
}

/**
 * 基本形状がいま押せるか(NFR-UX-5)。**常に押せる。**
 *
 * 中心も向きも選ばずに置けるので、断る理由が1つも無い(§0.a-0.18 の既定は原点、
 * §0.a-0.16 の既定は Z 軸)。引数に道具を取るのは、押せる条件が形ごとに違わないことを
 * 呼び出し側から見て明らかにするためで、`solidToolReadiness` が5種とも同じようにここへ
 * 委譲できる(押せる条件は1か所、2026-09-05 16:35 の申し送り)。
 */
export function primitiveToolReadiness(
  _context: PrimitiveContext,
  tool: PrimitiveToolId,
): SolidToolReadiness {
  // 選択(`_context`)は一切見ない(名前の頭の `_` はそれを表す)。断るのは
  // 「基本形状でない道具が回ってきた」ときだけで、
  // これは呼び出し側の振り分けの誤り(`commitPrimitive` の同じ守りと対になっている)。
  return primitiveToolOf(tool) === null
    ? { ready: false, reasonKey: 'primitiveError.notPrimitive' }
    : READY;
}

/**
 * 基本形状を1つ作って履歴へ積む(FR-429)。**履歴は1段**(押し出し・ばねと同じ)。
 *
 * 中心は**決めた時点の選択**から拾い直す(ポップアップを開いたまま選び直せるので、
 * 最後に選ばれていたものを使うのが利用者の期待に合う。NFR-UX-1)。
 * 寸法が作れない形なら**履歴を変えずに断る**(§2.7.1、NFR-UX-5)。
 */
export function commitPrimitive(
  context: PrimitiveContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const tool = primitiveToolOf(commit.tool);
  if (tool === null) {
    // 基本形状でない道具の確定が回ってきた(呼び出し側の振り分けの誤り)。履歴は変えない。
    return { ok: false, reasonKey: 'primitiveError.notPrimitive' };
  }
  const shape = primitiveShapeFrom(tool, commit.values);
  const rejection = primitiveShapeRejection(shape);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const origin = selectedPrimitiveOrigin(context);
  // 向きは回転軸と同じ `AxisSpec`(§0.a-0.16)。選ばれていなければ既定の Z。
  const axis: AxisSpec = commit.axis ?? DEFAULT_PRIMITIVE_AXIS;
  const base = createPrimitiveFeature(context.document, tool, origin, axis);
  const feature: PrimitiveFeature = { ...base, shape };
  return {
    ok: true,
    document: appendSolid(context.document, feature),
    featureId: feature.id,
  };
}

/* ------------------------------------------------------------------ *
 * プロパティ(FR-502、FR-201)
 * ------------------------------------------------------------------ */

/**
 * プロパティに出す寸法の欄の名前(FR-502)。段の欄の名前(`numericInput.ts`)と**同じ語**に
 * してある。同じ数を指す名前が2通りあると、段で入れた値とプロパティで直す値の対応を
 * 読み手が追えなくなるため。
 */
export type PrimitiveFieldKey =
  | 'sphereRadius'
  | 'boxSizeX'
  | 'boxSizeY'
  | 'boxSizeZ'
  | 'cylinderRadius'
  | 'cylinderHeight'
  | 'coneBottomRadius'
  | 'coneTopRadius'
  | 'coneHeight'
  | 'torusMajorRadius'
  | 'torusMinorRadius';

/** プロパティに出す寸法の欄1つぶん。 */
export interface PrimitiveFieldSummary {
  readonly key: PrimitiveFieldKey;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
}

/** 長さの欄はすべて mm(基本形状に角度の欄は無い)。 */
const MILLIMETRE: FieldUnit = 'mm';

function lengthField(
  key: PrimitiveFieldKey,
  labelKey: MessageKey,
  tooltipKey: MessageKey,
  value: ExpressionValue,
): PrimitiveFieldSummary {
  return { key, labelKey, tooltipKey, unit: MILLIMETRE, value };
}

/**
 * プロパティに出す寸法の欄(FR-502、球1・箱3・円柱2・円錐3・トーラス2)。
 * 見出しとツールチップは段の欄と同じ文言キーを使う(同じ数を2通りの名前で呼ばない)。
 */
export function primitiveFieldSummaries(
  feature: PrimitiveFeature,
): readonly PrimitiveFieldSummary[] {
  const shape = feature.shape;
  switch (shape.kind) {
    case 'sphere':
      return [
        lengthField('sphereRadius', 'numericInput.field.radius', 'numericInput.tooltip.sphereRadius', shape.radius),
      ];
    case 'box':
      return [
        lengthField('boxSizeX', 'numericInput.field.boxSizeX', 'numericInput.tooltip.boxSizeX', shape.sizeX),
        lengthField('boxSizeY', 'numericInput.field.boxSizeY', 'numericInput.tooltip.boxSizeY', shape.sizeY),
        lengthField('boxSizeZ', 'numericInput.field.boxSizeZ', 'numericInput.tooltip.boxSizeZ', shape.sizeZ),
      ];
    case 'cylinder':
      return [
        lengthField('cylinderRadius', 'numericInput.field.radius', 'numericInput.tooltip.cylinderRadius', shape.radius),
        lengthField('cylinderHeight', 'numericInput.field.height', 'numericInput.tooltip.cylinderHeight', shape.height),
      ];
    case 'cone':
      return [
        lengthField('coneBottomRadius', 'numericInput.field.bottomRadius', 'numericInput.tooltip.coneBottomRadius', shape.bottomRadius),
        lengthField('coneTopRadius', 'numericInput.field.topRadius', 'numericInput.tooltip.coneTopRadius', shape.topRadius),
        lengthField('coneHeight', 'numericInput.field.height', 'numericInput.tooltip.coneHeight', shape.height),
      ];
    case 'torus':
      return [
        lengthField('torusMajorRadius', 'numericInput.field.torusMajorRadius', 'numericInput.tooltip.torusMajorRadius', shape.majorRadius),
        lengthField('torusMinorRadius', 'numericInput.field.torusMinorRadius', 'numericInput.tooltip.torusMinorRadius', shape.minorRadius),
      ];
  }
}

/**
 * 寸法の欄を1つ書き戻す(FR-502)。形に無い欄の名前が来たらそのまま返す
 * (`setSolidField` と同じ約束。呼び出し側が形と欄の対応を数え直さずに済む)。
 */
export function setPrimitiveField(
  feature: PrimitiveFeature,
  key: PrimitiveFieldKey,
  value: ExpressionValue,
): PrimitiveFeature {
  const shape = feature.shape;
  switch (shape.kind) {
    case 'sphere':
      return key === 'sphereRadius' ? { ...feature, shape: { ...shape, radius: value } } : feature;
    case 'box':
      switch (key) {
        case 'boxSizeX':
          return { ...feature, shape: { ...shape, sizeX: value } };
        case 'boxSizeY':
          return { ...feature, shape: { ...shape, sizeY: value } };
        case 'boxSizeZ':
          return { ...feature, shape: { ...shape, sizeZ: value } };
        default:
          return feature;
      }
    case 'cylinder':
      switch (key) {
        case 'cylinderRadius':
          return { ...feature, shape: { ...shape, radius: value } };
        case 'cylinderHeight':
          return { ...feature, shape: { ...shape, height: value } };
        default:
          return feature;
      }
    case 'cone':
      switch (key) {
        case 'coneBottomRadius':
          return { ...feature, shape: { ...shape, bottomRadius: value } };
        case 'coneTopRadius':
          return { ...feature, shape: { ...shape, topRadius: value } };
        case 'coneHeight':
          return { ...feature, shape: { ...shape, height: value } };
        default:
          return feature;
      }
    case 'torus':
      switch (key) {
        case 'torusMajorRadius':
          return { ...feature, shape: { ...shape, majorRadius: value } };
        case 'torusMinorRadius':
          return { ...feature, shape: { ...shape, minorRadius: value } };
        default:
          return feature;
      }
  }
}

/** 中心の座標の欄の名前(座標で置いたときだけ出る3欄、FR-429・FR-202)。 */
export type PrimitiveOriginAxis = 'x' | 'y' | 'z';

/**
 * 中心の座標を1つ書き戻す(FR-502)。中心が座標**でない**(スケッチの点・立体の頂点)ときは
 * そのまま返す。座標の指定方法(絶対・相対・極)は作ったときのものを保つ。
 */
export function setPrimitiveOriginCoordinate(
  feature: PrimitiveFeature,
  axis: PrimitiveOriginAxis,
  value: ExpressionValue,
): PrimitiveFeature {
  const origin = feature.origin;
  if (origin.kind !== 'coordinate' || origin.value.mode !== 'absolute') {
    // 相対・極で置いた中心はここでは直せない(欄の意味が距離と角度になるため)。
    // いまの入り口(`selectedPrimitiveOrigin`)は必ず絶対座標で作るので実際には通らない。
    return feature;
  }
  const { x, y, z } = origin.value;
  const next = {
    mode: 'absolute',
    x: axis === 'x' ? value : x,
    y: axis === 'y' ? value : y,
    z: axis === 'z' ? value : z,
  } as const;
  return { ...feature, origin: { kind: 'coordinate', value: next } };
}

/** 向き(軸)を世界の X / Y / Z へ差し替える(FR-502)。線分の軸は選び直せない。 */
export function setPrimitiveAxis(
  feature: PrimitiveFeature,
  axis: PrimitiveOriginAxis,
): PrimitiveFeature {
  return { ...feature, axis: { kind: 'world', axis } };
}

/**
 * プロパティに出す中心の要約(FR-429 の3通り)。
 *
 * - 座標 … 3 つの式の欄をそのまま出せるので `fields` に入れる。
 * - スケッチの点 / 立体の頂点 … 参照なので**名前だけ**を出す(見つからなければ null にして
 *   「見つかりません」と出す。FR-504)。頂点の通し番号は利用者に意味が無いので出さない
 *   (`solidSummary.ts` の `subShapeCounts` と同じ考え方)。
 */
export interface PrimitiveOriginField {
  readonly axis: PrimitiveOriginAxis;
  readonly labelKey: MessageKey;
  readonly value: ExpressionValue;
}

export type PrimitiveOriginSummary =
  /**
   * 座標で置いた中心。`fields` は**絶対座標のときだけ**3 つ入る。相対・極で置かれた中心
   * (いまの入り口では作られないが、型としては表せる)は欄の意味が距離と角度になるので、
   * 空にして名前だけを出す(直すのはタスク19b 以降の課題として残す)。
   */
  | { readonly kind: 'coordinate'; readonly fields: readonly PrimitiveOriginField[] }
  | { readonly kind: 'sketchPoint'; readonly name: string | null }
  | { readonly kind: 'vertex'; readonly name: string | null };

/** 中心の要約を作る。名前を引くために文書を見る(`solidSummary.ts` の参照の作り方と同じ)。 */
export function primitiveOriginSummary(
  document: PartDocument,
  feature: PrimitiveFeature,
): PrimitiveOriginSummary {
  const origin = feature.origin;
  switch (origin.kind) {
    case 'coordinate': {
      const value = origin.value;
      if (value.mode !== 'absolute') {
        return { kind: 'coordinate', fields: [] };
      }
      return {
        kind: 'coordinate',
        fields: [
          { axis: 'x', labelKey: 'numericInput.field.x', value: value.x },
          { axis: 'y', labelKey: 'numericInput.field.y', value: value.y },
          { axis: 'z', labelKey: 'numericInput.field.z', value: value.z },
        ],
      };
    }
    case 'sketchPoint': {
      const found = findSketchFeatureAt(document, origin.ref.pointFeatureId, POINT_KINDS);
      return {
        kind: 'sketchPoint',
        name: found === undefined ? null : found.feature.name,
      };
    }
    case 'vertex': {
      const body = findSolid(document, origin.ref.bodyFeatureId);
      return { kind: 'vertex', name: body === undefined ? null : body.name };
    }
  }
}
