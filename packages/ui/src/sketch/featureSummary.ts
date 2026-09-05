/**
 * スケッチの 1 要素を「モデルブラウザとプロパティが表に出せる形」へ直す
 * (計画書 docs/plans/P1-式とスケッチ.md タスク22 手順1)。
 *
 * 対応要件: FR-202(入れた式をそのまま再表示する)、FR-311(後から変えると下流が追従する)、
 * FR-501(ツリーの種類と名前)、FR-504(失敗の明示)。
 *
 * DOM にも React にもストアにも触れない純関数だけを置く。表示する文言は持たず、
 * 必ず ja.json のキー(MessageKey)で返す(NFR-MA-5)。書き戻しは元の要素を変えずに
 * 新しい要素を作る(P2 の Undo の土台、FR-505)。
 */

import {
  addExpression,
  divideExpression,
  expressionValueFromNumber,
  subtractExpression,
  type ExpressionValue,
} from '@pointercad/expression';
import {
  distanceVec3,
  type CopyPlacement,
  type CoordinateInput,
  type OffsetCornerKind,
  type OffsetSide,
  type PointArrayLayout,
  type PointReference,
  type ResolvedCurve,
  type ResolvedSketch,
  type SketchCopyFeature,
  type SketchDocument,
  type SketchElementRef,
  type SketchEllipseFeature,
  type SketchError,
  type SketchFaceFeature,
  type SketchFeature,
  type SketchFeatureKind,
  type SketchMesh,
  type SketchOffsetFeature,
  type SketchPointArrayFeature,
  type SketchPolygonFeature,
  type SketchRectangleFeature,
  type SketchSlotFeature,
  type SketchSplineFeature,
  type Vec3,
  type WorkPlaneId,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { DEFAULT_COORDINATE_BASE, type CoordinateMode, type FieldUnit } from './numericInput.js';
import { sampleCurve } from './sampleCurve.js';

/** プロパティ欄の 1 行。式は source をそのまま出す(FR-202)。 */
export interface FeatureFieldSummary {
  /** 書き戻すときに使う道筋。例: "at.x"、"radius"、"to.dy"。 */
  readonly path: string;
  readonly labelKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
}

/**
 * 座標を指定する場所。要素の種類ごとに持てる場所が決まっている。
 *
 * P4 タスク33 で新しい図形ぶんを足した。スプラインの点だけは個数が決まらないので
 * `points.0` のような文字列になり、この union には入らない(`FeatureCoordinateSummary.path`
 * は文字列で持つ)。
 */
export type CoordinateSlot =
  | 'at'
  | 'from'
  | 'to'
  | 'center'
  | 'base'
  /** 矩形の対角 2 点(FR-314)。 */
  | 'corner1'
  | 'corner2'
  /** 長穴の 2 つの中心(FR-316)。 */
  | 'center1'
  | 'center2'
  /** 3D スケッチの円弧の向き(FR-330)。 */
  | 'normal'
  | 'xAxis'
  /** 複製の移動量・並べる向き(FR-324)。 */
  | 'delta'
  | 'direction';

/** スプラインの n 番目の点の道筋(`points.0`)。 */
export function splinePointSlot(index: number): string {
  return `points.${String(index)}`;
}

/**
 * 座標の基準(FR-302、FR-303、FR-330)の読める表示。
 * 「押し出し1 / 立体の頂点」のように、参照先の名前と何を指しているかを並べて出す。
 */
export interface CoordinateBaseSummary {
  /** 何を指しているか(原点・直前の点・立体の頂点など)。 */
  readonly labelKey: MessageKey;
  /** 参照先の名前。名前を引けないときは null。 */
  readonly name: string | null;
  /** 押すとその要素を選べる id。選べないときは null。 */
  readonly elementId: string | null;
  /** 画面にそのまま出す 1 行(名前 + 種類)。 */
  readonly text: string;
}

/** 1 点ぶんの欄のまとまり。指定方法(絶対・相対・極)を切り替える単位でもある。 */
export interface FeatureCoordinateSummary {
  /** `at`・`corner1` などの場所。スプラインの点だけ `points.0` の形になる。 */
  readonly path: string;
  readonly labelKey: MessageKey;
  readonly mode: CoordinateMode;
  readonly fields: readonly FeatureFieldSummary[];
  /**
   * 見出しに添える番号(スプラインの点は 1 から数える)。番号を持たない場所は null。
   */
  readonly ordinal: number | null;
  /** 基準の点(相対・極のときだけ)。絶対座標では null。 */
  readonly base: CoordinateBaseSummary | null;
  /** 消せる点(スプラインの点)なら true。 */
  readonly removable: boolean;
  /**
   * 拘束で決まった、いまの位置(FR-313、P4b タスク22b (g))。拘束が動かしていなければ null。
   *
   * 拘束で解いた座標は文書に書かない(`rules/04-設計の規律.md`「導出できるものは保存しない」)
   * ので、上の欄には**保存された式と指定方法**しか出ない。形は動いているのに数字が変わらない
   * と読めてしまうため、動いたときだけ「= (x, y, z)(拘束で決まった値)」を欄の下へ添える
   * (NFR-UX-7)。編集の入口は上の欄のままで、ここは読むだけ。
   */
  readonly solvedText: string | null;
}

/** 入切のつまみ(構築線・閉じる)。式ではないので値は真偽。 */
export type FeatureToggleKey = 'construction' | 'splineClosed' | 'fullCircle';

export interface FeatureToggleSummary {
  readonly key: FeatureToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/** いくつかから 1 つを選ぶ欄(半径の測り方・点の使い方・オフセットの側と角など)。 */
export type FeatureChoiceKey =
  /** 矩形の見せ方(対角 2 点 / 中心+幅+高さ)。履歴には残らない画面だけの切替。 */
  | 'rectangleMode'
  | 'polygonRadiusMode'
  | 'splineMode'
  | 'offsetSide'
  | 'offsetCorner';

export interface FeatureChoiceOption {
  readonly value: string;
  readonly labelKey: MessageKey;
}

export interface FeatureChoiceSummary {
  readonly key: FeatureChoiceKey;
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly options: readonly FeatureChoiceOption[];
}

/** 参照しているもの(オフセット元・複製元・鏡の軸)。名前だけを引く(FR-311)。 */
export interface FeatureReferenceSummary {
  readonly labelKey: MessageKey;
  readonly name: string;
  /** 押すとその要素を選べる id。引けないときは null(FR-504)。 */
  readonly elementId: string | null;
}

/** 矩形の見せ方(FR-314、計画書タスク33)。履歴の形(対角 2 点)は変わらない。 */
export type RectangleView = 'corners' | 'centerSize';

export const RECTANGLE_VIEWS: readonly RectangleView[] = ['corners', 'centerSize'];

/** 要約を組み立てるときの手掛かり。渡さなければ従来どおりの要約になる。 */
export interface FeatureSummaryOptions {
  /** 基準の点・参照先の名前を引くためのスケッチ文書。 */
  readonly document?: SketchDocument;
  /** 立体の名前を引く(頂点参照の「押し出し1 / 立体の頂点」)。 */
  readonly bodyName?: (featureId: string) => string | null;
  /** 矩形の見せ方。既定は対角 2 点。 */
  readonly rectangleView?: RectangleView;
}

/** ツリーの行とプロパティ欄が共有する、要素 1 つの見え方。 */
export interface FeatureSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: SketchFeatureKind;
  readonly kindLabelKey: MessageKey;
  readonly coordinates: readonly FeatureCoordinateSummary[];
  /** 座標ではない数の欄(半径・角度・間隔・個数)。 */
  readonly scalars: readonly FeatureFieldSummary[];
  /** 入切のつまみ(構築線・閉じる)。持たない種類は空。 */
  readonly toggles: readonly FeatureToggleSummary[];
  /** いくつかから 1 つを選ぶ欄。持たない種類は空。 */
  readonly choices: readonly FeatureChoiceSummary[];
  /** 参照しているもの(オフセット元・複製元・鏡の軸)。持たない種類は空。 */
  readonly references: readonly FeatureReferenceSummary[];
  /** 計算できていない理由。問題が無ければ null(FR-504)。 */
  readonly errorMessage: string | null;
}

/**
 * ツリーの行に出す種類(絵と名前を決める粒度)。複製は配置ごとに分ける。
 * 立体側の `solidKindOf`(ブーリアンを演算ごとに分ける)と同じ考え方で、
 * 「ミラー1」「直線配列1」のような名前と絵が食い違わないようにする(FR-501)。
 */
export type SketchTreeKind =
  | SketchFeatureKind
  | 'copyMirror'
  | 'copyTranslate'
  | 'copyLinearArray'
  | 'copyCircularArray';

/** 複製(FR-324)は配置ごとに、それ以外はそのままの種類を返す。 */
export function sketchTreeKindOf(feature: SketchFeature): SketchTreeKind {
  if (feature.kind !== 'copy') {
    return feature.kind;
  }
  switch (feature.placement.kind) {
    case 'mirror':
      return 'copyMirror';
    case 'translate':
      return 'copyTranslate';
    case 'linearArray':
      return 'copyLinearArray';
    case 'circularArray':
      return 'copyCircularArray';
  }
}

/** ツリーの行に出す種類の名前。道具の名前と同じ言葉にする。 */
export const FEATURE_KIND_LABEL_KEYS: Readonly<Record<SketchTreeKind, MessageKey>> = {
  point: 'toolbar.tool.point',
  line: 'toolbar.tool.line',
  arc: 'toolbar.tool.arc',
  pointArray: 'toolbar.tool.pointArray',
  face: 'toolbar.tool.face',
  rectangle: 'toolbar.tool.rectangle',
  polygon: 'toolbar.tool.polygon',
  slot: 'toolbar.tool.slot',
  ellipse: 'toolbar.tool.ellipse',
  spline: 'toolbar.tool.spline',
  offset: 'toolbar.tool.offset',
  copy: 'toolbar.tool.copy',
  // 投影・交差(FR-325、P4 タスク25)。道具そのものはタスク27 で足す。
  projectedCurve: 'toolbar.tool.projectedCurve',
  planeSection: 'toolbar.tool.planeSection',
  // 複製(FR-324)の 4 通り。木の行の名前(ミラー1・複写1・直線配列1・円形配列1)と
  // 同じ言葉にする(P4 タスク33、タスク20 の申し送り)。
  copyMirror: 'toolbar.tool.mirror',
  copyTranslate: 'toolbar.tool.copyMove',
  copyLinearArray: 'toolbar.tool.linearArray',
  copyCircularArray: 'toolbar.tool.circularArray',
};

/** 座標のまとまりの見出し。 */
const COORDINATE_LABEL_KEYS: Readonly<Record<CoordinateSlot, MessageKey>> = {
  at: 'propertyPanel.coordinate.at',
  from: 'propertyPanel.coordinate.from',
  to: 'propertyPanel.coordinate.to',
  center: 'propertyPanel.coordinate.center',
  base: 'propertyPanel.coordinate.base',
  corner1: 'propertyPanel.coordinate.corner1',
  corner2: 'propertyPanel.coordinate.corner2',
  center1: 'propertyPanel.coordinate.center1',
  center2: 'propertyPanel.coordinate.center2',
  normal: 'propertyPanel.coordinate.normal',
  xAxis: 'propertyPanel.coordinate.xAxis',
  delta: 'propertyPanel.coordinate.delta',
  direction: 'propertyPanel.coordinate.direction',
};

/** スプラインの点の見出し(番号は `ordinal` が持つ)。 */
const SPLINE_POINT_LABEL_KEY: MessageKey = 'propertyPanel.coordinate.splinePoint';

/** 欄の見出し。その場数値入力(numericInput.ts)と同じ言葉を使う。 */
const FIELD_LABEL_KEYS = {
  x: 'numericInput.field.x',
  y: 'numericInput.field.y',
  z: 'numericInput.field.z',
  dx: 'numericInput.field.dx',
  dy: 'numericInput.field.dy',
  dz: 'numericInput.field.dz',
  distance: 'numericInput.field.distance',
  azimuth: 'numericInput.field.azimuth',
  elevation: 'numericInput.field.elevation',
  radius: 'numericInput.field.radius',
  startAngle: 'numericInput.field.startAngle',
  endAngle: 'numericInput.field.endAngle',
  spacing: 'numericInput.field.spacing',
  count: 'numericInput.field.count',
  // P4 の新しい図形(FR-314〜318、FR-321、FR-324、FR-327)。
  sides: 'numericInput.field.sides',
  width: 'numericInput.field.width',
  height: 'propertyPanel.height',
  majorRadius: 'numericInput.field.majorRadius',
  minorRadius: 'numericInput.field.minorRadius',
  rotation: 'numericInput.field.rotation',
  rowAzimuth: 'propertyPanel.rowAzimuth',
  rowSpacing: 'numericInput.field.rowSpacing',
  rowCount: 'numericInput.field.rowCount',
  colAzimuth: 'propertyPanel.colAzimuth',
  colSpacing: 'numericInput.field.colSpacing',
  colCount: 'numericInput.field.colCount',
  offsetDistance: 'numericInput.field.offsetDistance',
  angle: 'numericInput.field.angle',
} as const satisfies Record<string, MessageKey>;

/**
 * 指定方法を切り替えたときの初期値。欄の意味が変わるので値は引き継がない(§2.9)。
 * 数は numericInput.ts の COORDINATE_FIELDS の既定値(0 / 距離 10)にそろえる。
 */
const ZERO: ExpressionValue = expressionValueFromNumber(0);
const DEFAULT_DISTANCE: ExpressionValue = expressionValueFromNumber(10);

function field(
  path: string,
  labelKey: MessageKey,
  unit: FieldUnit,
  value: ExpressionValue,
): FeatureFieldSummary {
  return { path, labelKey, unit, value };
}

/** 基準の点の見出し。「何を指しているか」だけを言い、名前は別に添える。 */
const BASE_LABEL_KEYS = {
  origin: 'propertyPanel.base.origin',
  previous: 'propertyPanel.base.previous',
  point: 'propertyPanel.base.point',
  vertexStart: 'propertyPanel.base.vertexStart',
  vertexEnd: 'propertyPanel.base.vertexEnd',
  vertexCenter: 'propertyPanel.base.vertexCenter',
  solidVertex: 'propertyPanel.base.solidVertex',
  solidEdge: 'propertyPanel.base.solidEdge',
  solidFace: 'propertyPanel.base.solidFace',
  sphereGrid: 'propertyPanel.base.sphereGrid',
} as const satisfies Record<string, MessageKey>;

/** スケッチの中の要素の名前。見つからなければ null(FR-504 は名前でなく印で伝える)。 */
function featureNameOf(document: SketchDocument | undefined, featureId: string): string | null {
  const found = document?.features.find((candidate) => candidate.id === featureId);
  return found === undefined ? null : found.name;
}

/** 名前の無い基準(原点・直前の点)。 */
function plainBase(labelKey: MessageKey): CoordinateBaseSummary {
  return { labelKey, name: null, elementId: null, text: t(labelKey) };
}

/**
 * 名前のある基準。「押し出し1 / 立体の頂点」のように、参照先の名前と何を指すかを並べる
 * (タスク10 の申し送り「頂点参照の基準の表示」)。名前を引けないときは種類だけを出す。
 */
function namedBase(
  labelKey: MessageKey,
  name: string | null,
  elementId: string | null,
): CoordinateBaseSummary {
  return {
    labelKey,
    name,
    elementId,
    text: name === null ? t(labelKey) : `${name} / ${t(labelKey)}`,
  };
}

/** 立体の部分形状の種類ごとの見出し。 */
function solidSubShapeLabelKey(kind: 'vertex' | 'edge' | 'face'): MessageKey {
  switch (kind) {
    case 'vertex':
      return BASE_LABEL_KEYS.solidVertex;
    case 'edge':
      return BASE_LABEL_KEYS.solidEdge;
    case 'face':
      return BASE_LABEL_KEYS.solidFace;
  }
}

/** 座標の基準を読める 1 行にする(FR-302、FR-303、FR-330)。 */
export function baseSummary(
  reference: PointReference,
  options: FeatureSummaryOptions = {},
): CoordinateBaseSummary {
  switch (reference.kind) {
    case 'origin':
      return plainBase(BASE_LABEL_KEYS.origin);
    case 'previous':
      return plainBase(BASE_LABEL_KEYS.previous);
    case 'point':
      return namedBase(
        BASE_LABEL_KEYS.point,
        featureNameOf(options.document, featureIdOf(reference.pointId)),
        reference.pointId,
      );
    case 'vertex': {
      const labelKey =
        reference.vertex === 'start'
          ? BASE_LABEL_KEYS.vertexStart
          : reference.vertex === 'end'
            ? BASE_LABEL_KEYS.vertexEnd
            : BASE_LABEL_KEYS.vertexCenter;
      return namedBase(
        labelKey,
        featureNameOf(options.document, reference.featureId),
        reference.featureId,
      );
    }
    case 'subShape': {
      const { bodyFeatureId, fingerprint } = reference.ref;
      // 立体の名前は部品文書にしかないので、呼び出し側(プロパティ欄)が引いて渡す。
      const name = options.bodyName?.(bodyFeatureId) ?? null;
      return namedBase(solidSubShapeLabelKey(fingerprint.kind), name, null);
    }
    case 'sphereGrid': {
      // 球面上の点(FR-431、P5 タスク19)。球の名前も部品文書にしかないので同じ口で引く。
      // 緯度・経度そのものの欄はタスク22 が足す(ここは基準の 1 行だけ)。
      const name = options.bodyName?.(reference.sphereFeatureId) ?? null;
      return namedBase(BASE_LABEL_KEYS.sphereGrid, name, null);
    }
  }
}

/** 見出しと番号を明示して 1 点の指定を欄の並びへ直す(スプラインの点で使う)。 */
function coordinateSummaryAt(
  slot: string,
  labelKey: MessageKey,
  input: CoordinateInput,
  options: FeatureSummaryOptions,
  ordinal: number | null = null,
  removable = false,
): FeatureCoordinateSummary {
  const fields: readonly FeatureFieldSummary[] =
    input.mode === 'absolute'
      ? [
          field(`${slot}.x`, FIELD_LABEL_KEYS.x, 'mm', input.x),
          field(`${slot}.y`, FIELD_LABEL_KEYS.y, 'mm', input.y),
          field(`${slot}.z`, FIELD_LABEL_KEYS.z, 'mm', input.z),
        ]
      : input.mode === 'relative'
        ? [
            field(`${slot}.dx`, FIELD_LABEL_KEYS.dx, 'mm', input.dx),
            field(`${slot}.dy`, FIELD_LABEL_KEYS.dy, 'mm', input.dy),
            field(`${slot}.dz`, FIELD_LABEL_KEYS.dz, 'mm', input.dz),
          ]
        : [
            field(`${slot}.distance`, FIELD_LABEL_KEYS.distance, 'mm', input.distance),
            field(`${slot}.azimuth`, FIELD_LABEL_KEYS.azimuth, 'degree', input.azimuth),
            field(`${slot}.elevation`, FIELD_LABEL_KEYS.elevation, 'degree', input.elevation),
          ];
  return {
    path: slot,
    labelKey,
    mode: input.mode,
    fields,
    ordinal,
    base: input.mode === 'absolute' ? null : baseSummary(input.base, options),
    removable,
    // 拘束で動いたかは解決結果を 2 つ突き合わせないと分からないので、ここでは付けない。
    // 呼び出し側(`PropertyPanel.tsx`)が `withSolvedCoordinates` で後から差し込む。
    solvedText: null,
  };
}

/** 1 点の指定を欄の並びへ直す。並びはその場数値入力と同じ順にする。 */
function coordinateSummary(
  slot: CoordinateSlot,
  input: CoordinateInput,
  options: FeatureSummaryOptions = {},
): FeatureCoordinateSummary {
  return coordinateSummaryAt(slot, COORDINATE_LABEL_KEYS[slot], input, options);
}

/**
 * スケッチの外(基準ジオメトリ、FR-329)からも同じ形の欄を作れるようにした口
 * (`solidSummary.ts` の `summarizeReference` が使う。同じ組み立てを 2 か所に書かないため)。
 */
export function coordinateSummaryFor(
  slot: CoordinateSlot,
  input: CoordinateInput,
  options: FeatureSummaryOptions = {},
): FeatureCoordinateSummary {
  return coordinateSummary(slot, input, options);
}

/** その要素が計算できていない理由。無ければ null(FR-504)。 */
export function featureErrorMessage(
  errors: readonly SketchError[],
  featureId: string,
): string | null {
  const found = errors.find((error) => error.featureId === featureId);
  return found === undefined ? null : found.message;
}

/** 要約の「種類ごとに変わらない部分」。 */
type FeatureSummaryBase = Omit<
  FeatureSummary,
  'coordinates' | 'scalars' | 'toggles' | 'choices' | 'references'
>;

/** 種類ごとに変わる部分。持たないものは書かなくてよい(空で埋める)。 */
interface FeatureSummaryParts {
  readonly coordinates?: readonly FeatureCoordinateSummary[];
  readonly scalars?: readonly FeatureFieldSummary[];
  readonly toggles?: readonly FeatureToggleSummary[];
  readonly choices?: readonly FeatureChoiceSummary[];
  readonly references?: readonly FeatureReferenceSummary[];
}

function summaryOf(base: FeatureSummaryBase, parts: FeatureSummaryParts = {}): FeatureSummary {
  return {
    ...base,
    coordinates: parts.coordinates ?? [],
    scalars: parts.scalars ?? [],
    toggles: parts.toggles ?? [],
    choices: parts.choices ?? [],
    references: parts.references ?? [],
  };
}

/** 構築線(FR-320)のつまみ。線・円弧・矩形などが共通で持つ。 */
function constructionToggle(value: boolean): FeatureToggleSummary {
  return { key: 'construction', labelKey: 'numericInput.toggle.construction', value };
}

/** 正多角形の半径の測り方(FR-315)。 */
function polygonRadiusModeChoice(mode: 'circumscribed' | 'inscribed'): FeatureChoiceSummary {
  return {
    key: 'polygonRadiusMode',
    labelKey: 'numericInput.choice.polygonRadiusMode',
    value: mode,
    options: [
      { value: 'circumscribed', labelKey: 'numericInput.polygonRadiusMode.circumscribed' },
      { value: 'inscribed', labelKey: 'numericInput.polygonRadiusMode.inscribed' },
    ],
  };
}

/** スプラインの点の使い方(FR-317)。 */
function splineModeChoice(mode: 'interpolate' | 'control'): FeatureChoiceSummary {
  return {
    key: 'splineMode',
    labelKey: 'numericInput.choice.splineMode',
    value: mode,
    options: [
      { value: 'interpolate', labelKey: 'numericInput.splineMode.interpolate' },
      { value: 'control', labelKey: 'numericInput.splineMode.control' },
    ],
  };
}

/**
 * オフセットの側(FR-321)。閉じた輪郭は外/内、開いた曲線は左/右を意味するが、
 * どちらかは解決結果を見ないと分からないので、履歴が持つ言葉(外/内)をそのまま出す。
 */
function offsetSideChoice(side: OffsetSide): FeatureChoiceSummary {
  return {
    key: 'offsetSide',
    labelKey: 'numericInput.choice.offsetSide',
    value: side,
    options: [
      { value: 'outside', labelKey: 'numericInput.offsetSide.outside' },
      { value: 'inside', labelKey: 'numericInput.offsetSide.inside' },
    ],
  };
}

/** オフセットの角の作り方(FR-321)。 */
function offsetCornerChoice(corner: OffsetCornerKind): FeatureChoiceSummary {
  return {
    key: 'offsetCorner',
    labelKey: 'numericInput.choice.offsetCorner',
    value: corner,
    options: [
      { value: 'round', labelKey: 'numericInput.offsetCorner.round' },
      { value: 'sharp', labelKey: 'numericInput.offsetCorner.sharp' },
    ],
  };
}

/** 矩形の見せ方(FR-314、計画書タスク33)。履歴は対角 2 点のまま変わらない。 */
function rectangleModeChoice(view: RectangleView): FeatureChoiceSummary {
  return {
    key: 'rectangleMode',
    labelKey: 'propertyPanel.rectangleMode',
    value: view,
    options: [
      { value: 'corners', labelKey: 'propertyPanel.rectangleMode.corners' },
      { value: 'centerSize', labelKey: 'propertyPanel.rectangleMode.centerSize' },
    ],
  };
}

/** 参照している要素 1 つ(オフセット元・複製元)。n 番目の曲線なら番号も付ける。 */
function elementReference(
  document: SketchDocument | undefined,
  labelKey: MessageKey,
  reference: SketchElementRef,
): FeatureReferenceSummary {
  const name = featureNameOf(document, reference.featureId) ?? reference.featureId;
  if (reference.index === undefined) {
    return { labelKey, name, elementId: reference.featureId };
  }
  return {
    labelKey,
    // 何番目かは 1 から数える。記号だけなので言葉の資源は要らない(面の境界と同じ流儀)。
    name: `${name} #${String(reference.index + 1)}`,
    elementId: `${reference.featureId}#${String(reference.index)}`,
  };
}

/**
 * 矩形を「中心+幅+高さ」で見るための軸の組(FR-314、計画書タスク33)。
 * 幅は第 1 軸、高さは第 2 軸。任意の作業平面は世界の軸と一致しないので XY と同じ組にする
 * (対角 2 点の見せ方はどの平面でも正しいので、そちらへ切り替えれば編集できる)。
 */
function planeAxisIndices(planeId: WorkPlaneId): readonly [number, number, number] {
  switch (planeId) {
    case 'xz':
      return [0, 2, 1];
    case 'yz':
      return [1, 2, 0];
    default:
      return [0, 1, 2];
  }
}

/** 絶対座標の成分を並びで引く(0=X、1=Y、2=Z)。 */
function absoluteComponents(
  input: CoordinateInput,
): readonly [ExpressionValue, ExpressionValue, ExpressionValue] | null {
  return input.mode === 'absolute' ? [input.x, input.y, input.z] : null;
}

/** 式の中の定数 2(半分にする・倍にするときの割り算・掛け算の相手)。作るたびに作り直さない。 */
const TWO: ExpressionValue = expressionValueFromNumber(2);

/**
 * (a + b) / 2 の式(FR-202「式は文字列のまま」)。expression 層の合成関数(`combineExpression.ts`)
 * を使い、有理数どうしは厳密に、それ以外は括弧つきで連結する(P4 仕上げ (f)、
 * 統括の目視 2026-09-04「矩形の換算式 `((0)+(40))/2` が読みにくい」への対応)。
 */
function midpointExpression(a: ExpressionValue, b: ExpressionValue): ExpressionValue {
  return divideExpression(addExpression(a, b), TWO);
}

/** b − a の式。 */
function spanExpression(a: ExpressionValue, b: ExpressionValue): ExpressionValue {
  return subtractExpression(b, a);
}

/** 中心 ± 大きさ/2 の式。 */
function halfOffsetExpression(
  center: ExpressionValue,
  size: ExpressionValue,
  sign: '+' | '-',
): ExpressionValue {
  const half = divideExpression(size, TWO);
  return sign === '+' ? addExpression(center, half) : subtractExpression(center, half);
}

/** 矩形を「中心+幅+高さ」で見た値。対角 2 点が絶対座標のときだけ作れる。 */
export interface RectangleCenterSize {
  readonly center: readonly [ExpressionValue, ExpressionValue, ExpressionValue];
  readonly width: ExpressionValue;
  readonly height: ExpressionValue;
  readonly axes: readonly [number, number, number];
}

export function rectangleCenterSize(feature: SketchRectangleFeature): RectangleCenterSize | null {
  const first = absoluteComponents(feature.corner1);
  const second = absoluteComponents(feature.corner2);
  if (first === null || second === null) {
    return null;
  }
  const axes = planeAxisIndices(feature.planeId);
  return {
    center: [
      midpointExpression(first[0], second[0]),
      midpointExpression(first[1], second[1]),
      midpointExpression(first[2], second[2]),
    ],
    width: spanExpression(first[axes[0]], second[axes[0]]),
    height: spanExpression(first[axes[1]], second[axes[1]]),
    axes,
  };
}

/** 中心+幅+高さから対角 2 点へ戻す(履歴の形は対角 2 点のまま、§2.3)。 */
export function rectangleFromCenterSize(
  feature: SketchRectangleFeature,
  value: RectangleCenterSize,
): SketchRectangleFeature {
  const [u, v, w] = value.axes;
  const low: ExpressionValue[] = [value.center[0], value.center[1], value.center[2]];
  const high: ExpressionValue[] = [value.center[0], value.center[1], value.center[2]];
  low[u] = halfOffsetExpression(value.center[u], value.width, '-');
  high[u] = halfOffsetExpression(value.center[u], value.width, '+');
  low[v] = halfOffsetExpression(value.center[v], value.height, '-');
  high[v] = halfOffsetExpression(value.center[v], value.height, '+');
  // 平面に垂直な向きは厚みを持たないので、中心の値をそのまま両方の角へ入れる。
  low[w] = value.center[w];
  high[w] = value.center[w];
  return {
    ...feature,
    corner1: { mode: 'absolute', x: low[0], y: low[1], z: low[2] },
    corner2: { mode: 'absolute', x: high[0], y: high[1], z: high[2] },
  };
}

/** 矩形(FR-314)。対角 2 点と「中心+幅+高さ」を切り替えられる。 */
function summarizeRectangle(
  base: FeatureSummaryBase,
  feature: SketchRectangleFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  const centerSize = rectangleCenterSize(feature);
  const toggles = [constructionToggle(feature.construction)];
  if (centerSize === null) {
    // 対角の点が相対・極で入っているときは変換できないので、切替そのものを出さない。
    return summaryOf(base, {
      coordinates: [
        coordinateSummary('corner1', feature.corner1, options),
        coordinateSummary('corner2', feature.corner2, options),
      ],
      toggles,
    });
  }
  const view = options.rectangleView ?? 'corners';
  const choices = [rectangleModeChoice(view)];
  if (view === 'corners') {
    return summaryOf(base, {
      coordinates: [
        coordinateSummary('corner1', feature.corner1, options),
        coordinateSummary('corner2', feature.corner2, options),
      ],
      toggles,
      choices,
    });
  }
  return summaryOf(base, {
    coordinates: [
      coordinateSummaryAt(
        'center',
        COORDINATE_LABEL_KEYS.center,
        {
          mode: 'absolute',
          x: centerSize.center[0],
          y: centerSize.center[1],
          z: centerSize.center[2],
        },
        options,
      ),
    ],
    scalars: [
      field('width', FIELD_LABEL_KEYS.width, 'mm', centerSize.width),
      field('height', FIELD_LABEL_KEYS.height, 'mm', centerSize.height),
    ],
    toggles,
    choices,
  });
}

/** 点列(FR-308、FR-327)。並べ方(直線・円周・格子)で欄が変わる。 */
function summarizePointArray(
  base: FeatureSummaryBase,
  layout: PointArrayLayout,
  options: FeatureSummaryOptions,
): FeatureSummary {
  if (layout.kind === 'linear') {
    return summaryOf(base, {
      coordinates: [coordinateSummary('base', layout.base, options)],
      scalars: [
        field('azimuth', FIELD_LABEL_KEYS.azimuth, 'degree', layout.azimuth),
        field('spacing', FIELD_LABEL_KEYS.spacing, 'mm', layout.spacing),
        field('count', FIELD_LABEL_KEYS.count, 'count', layout.count),
      ],
    });
  }
  if (layout.kind === 'circular') {
    return summaryOf(base, {
      coordinates: [coordinateSummary('center', layout.center, options)],
      scalars: [
        field('radius', FIELD_LABEL_KEYS.radius, 'mm', layout.radius),
        field('count', FIELD_LABEL_KEYS.count, 'count', layout.count),
      ],
    });
  }
  return summaryOf(base, {
    coordinates: [coordinateSummary('base', layout.base, options)],
    scalars: [
      field('rowAzimuth', FIELD_LABEL_KEYS.rowAzimuth, 'degree', layout.rowAzimuth),
      field('rowSpacing', FIELD_LABEL_KEYS.rowSpacing, 'mm', layout.rowSpacing),
      field('rowCount', FIELD_LABEL_KEYS.rowCount, 'count', layout.rowCount),
      field('colAzimuth', FIELD_LABEL_KEYS.colAzimuth, 'degree', layout.colAzimuth),
      field('colSpacing', FIELD_LABEL_KEYS.colSpacing, 'mm', layout.colSpacing),
      field('colCount', FIELD_LABEL_KEYS.colCount, 'count', layout.colCount),
    ],
  });
}

/** 楕円・楕円弧(FR-318)。 */
function summarizeEllipse(
  base: FeatureSummaryBase,
  feature: SketchEllipseFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  return summaryOf(base, {
    coordinates: [coordinateSummary('center', feature.center, options)],
    scalars: [
      field('majorRadius', FIELD_LABEL_KEYS.majorRadius, 'mm', feature.majorRadius),
      field('minorRadius', FIELD_LABEL_KEYS.minorRadius, 'mm', feature.minorRadius),
      field('rotation', FIELD_LABEL_KEYS.rotation, 'degree', feature.rotation),
      field('startAngle', FIELD_LABEL_KEYS.startAngle, 'degree', feature.startAngle),
      field('endAngle', FIELD_LABEL_KEYS.endAngle, 'degree', feature.endAngle),
    ],
    toggles: [constructionToggle(feature.construction)],
  });
}

/** スプライン(FR-317)。点の一覧は追加・削除ができる(`addSplinePoint` / `removeSplinePoint`)。 */
function summarizeSpline(
  base: FeatureSummaryBase,
  feature: SketchSplineFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  // 開いた曲線は 2 点、閉じた曲線は 3 点までしか減らせない(model の約束)。
  const least = feature.closed ? 3 : 2;
  const removable = feature.points.length > least;
  return summaryOf(base, {
    coordinates: feature.points.map((point, index) =>
      coordinateSummaryAt(
        splinePointSlot(index),
        SPLINE_POINT_LABEL_KEY,
        point,
        options,
        index + 1,
        removable,
      ),
    ),
    toggles: [
      { key: 'splineClosed', labelKey: 'numericInput.toggle.splineClosed', value: feature.closed },
      constructionToggle(feature.construction),
    ],
    choices: [splineModeChoice(feature.mode)],
  });
}

/** オフセット(FR-321)。 */
function summarizeOffset(
  base: FeatureSummaryBase,
  feature: SketchOffsetFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  return summaryOf(base, {
    scalars: [field('distance', FIELD_LABEL_KEYS.offsetDistance, 'mm', feature.distance)],
    toggles: [constructionToggle(feature.construction)],
    choices: [offsetSideChoice(feature.side), offsetCornerChoice(feature.corner)],
    references: feature.source.map((reference) =>
      elementReference(options.document, 'propertyPanel.offsetSource', reference),
    ),
  });
}

/** 複製の配置(FR-324)ごとの欄。 */
function copyPlacementParts(
  placement: CopyPlacement,
  options: FeatureSummaryOptions,
): FeatureSummaryParts {
  switch (placement.kind) {
    case 'mirror':
      return {
        references:
          placement.basis.kind === 'axis'
            ? [
                elementReference(
                  options.document,
                  'propertyPanel.mirrorAxis',
                  placement.basis.axis,
                ),
              ]
            : [
                {
                  labelKey: 'propertyPanel.mirrorPlane',
                  name: placement.basis.planeId,
                  elementId: null,
                },
              ],
      };
    case 'translate':
      return { coordinates: [coordinateSummary('delta', placement.delta, options)] };
    case 'linearArray':
      return {
        coordinates: [coordinateSummary('direction', placement.direction, options)],
        scalars: [
          field('spacing', FIELD_LABEL_KEYS.spacing, 'mm', placement.spacing),
          field('count', FIELD_LABEL_KEYS.count, 'count', placement.count),
        ],
      };
    case 'circularArray':
      return {
        coordinates: [coordinateSummary('center', placement.center, options)],
        // 全周のときは角度が 360/個数 で決まるので欄を出さない(立体のパターンと同じ、NFR-UX-4)。
        scalars: placement.fullCircle
          ? [field('count', FIELD_LABEL_KEYS.count, 'count', placement.count)]
          : [
              field('angle', FIELD_LABEL_KEYS.angle, 'degree', placement.angle),
              field('count', FIELD_LABEL_KEYS.count, 'count', placement.count),
            ],
        toggles: [
          {
            key: 'fullCircle',
            labelKey: 'numericInput.toggle.fullCircle',
            value: placement.fullCircle,
          },
        ],
      };
  }
}

/** ミラー・複写・配列複写(FR-324)。 */
function summarizeCopy(
  base: FeatureSummaryBase,
  feature: SketchCopyFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  const parts = copyPlacementParts(feature.placement, options);
  return summaryOf(base, {
    ...parts,
    toggles: [...(parts.toggles ?? []), constructionToggle(feature.construction)],
    references: [
      ...feature.source.map((reference) =>
        elementReference(options.document, 'propertyPanel.copySource', reference),
      ),
      ...(parts.references ?? []),
    ],
  });
}

/** 長穴(FR-316)。 */
function summarizeSlot(
  base: FeatureSummaryBase,
  feature: SketchSlotFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  return summaryOf(base, {
    coordinates: [
      coordinateSummary('center1', feature.center1, options),
      coordinateSummary('center2', feature.center2, options),
    ],
    scalars: [field('width', FIELD_LABEL_KEYS.width, 'mm', feature.width)],
    toggles: [constructionToggle(feature.construction)],
  });
}

/** 正多角形(FR-315)。 */
function summarizePolygon(
  base: FeatureSummaryBase,
  feature: SketchPolygonFeature,
  options: FeatureSummaryOptions,
): FeatureSummary {
  return summaryOf(base, {
    coordinates: [coordinateSummary('center', feature.center, options)],
    scalars: [
      field('sides', FIELD_LABEL_KEYS.sides, 'count', feature.sides),
      field('radius', FIELD_LABEL_KEYS.radius, 'mm', feature.radius),
    ],
    toggles: [constructionToggle(feature.construction)],
    choices: [polygonRadiusModeChoice(feature.radiusMode)],
  });
}

/** 要素 1 つの見え方をまとめる。ツリーの行とプロパティ欄の両方がこれを読む。 */
export function summarizeFeature(
  feature: SketchFeature,
  errors: readonly SketchError[] = [],
  options: FeatureSummaryOptions = {},
): FeatureSummary {
  const base: FeatureSummaryBase = {
    id: feature.id,
    name: feature.name,
    kind: feature.kind,
    kindLabelKey: FEATURE_KIND_LABEL_KEYS[sketchTreeKindOf(feature)],
    errorMessage: featureErrorMessage(errors, feature.id),
  };

  switch (feature.kind) {
    case 'point':
      return summaryOf(base, { coordinates: [coordinateSummary('at', feature.at, options)] });
    case 'line':
      return summaryOf(base, {
        coordinates: [
          coordinateSummary('from', feature.from, options),
          coordinateSummary('to', feature.to, options),
        ],
        toggles: [constructionToggle(feature.construction)],
      });
    case 'arc': {
      // 3D スケッチ(FR-330)の円弧だけが自分の向きを持つ。プロパティ欄でだけ編集させ、
      // その場入力には出さない(P3 の穴の傾き角と同じ判断、計画書タスク33)。
      const orientation = feature.freeOrientation;
      return summaryOf(base, {
        coordinates:
          orientation === undefined
            ? [coordinateSummary('center', feature.center, options)]
            : [
                coordinateSummary('center', feature.center, options),
                coordinateSummary('normal', orientation.normal, options),
                coordinateSummary('xAxis', orientation.xAxis, options),
              ],
        scalars: [
          field('radius', FIELD_LABEL_KEYS.radius, 'mm', feature.radius),
          field('startAngle', FIELD_LABEL_KEYS.startAngle, 'degree', feature.startAngle),
          field('endAngle', FIELD_LABEL_KEYS.endAngle, 'degree', feature.endAngle),
        ],
        toggles: [constructionToggle(feature.construction)],
      });
    }
    case 'pointArray':
      return summarizePointArray(base, feature.layout, options);
    case 'face':
      // 面が持つのは境界と色だけ。数の欄は無い(FR-309、FR-310)。
      return summaryOf(base);
    case 'rectangle':
      return summarizeRectangle(base, feature, options);
    case 'polygon':
      return summarizePolygon(base, feature, options);
    case 'slot':
      return summarizeSlot(base, feature, options);
    case 'ellipse':
      return summarizeEllipse(base, feature, options);
    case 'spline':
      return summarizeSpline(base, feature, options);
    case 'offset':
      return summarizeOffset(base, feature, options);
    case 'copy':
      return summarizeCopy(base, feature, options);
    case 'projectedCurve':
      // 投影(FR-325)は式を 1 つも持たない。参照先の立体の名前は呼び出し側が引く。
      return summaryOf(base, {
        toggles: [constructionToggle(feature.construction)],
        references: [
          {
            labelKey: 'propertyPanel.projectionSource',
            name: options.bodyName?.(feature.source.bodyFeatureId) ?? feature.source.bodyFeatureId,
            elementId: null,
          },
        ],
      });
    case 'planeSection':
      return summaryOf(base, {
        toggles: [constructionToggle(feature.construction)],
        references: [
          {
            labelKey: 'propertyPanel.sectionTargetBody',
            name: options.bodyName?.(feature.targetFeatureId) ?? feature.targetFeatureId,
            elementId: null,
          },
        ],
      });
  }
}

/**
 * 座標のまとまりを差し替えた別の要素を作る。
 * 種類ごとに明示して組み立てるので `as` による強制変換が要らない(rules/02-禁止事項.md)。
 */
function withCoordinate(
  feature: SketchFeature,
  slot: string,
  map: (input: CoordinateInput) => CoordinateInput,
): SketchFeature {
  // 中身が変わらなかったときは同じものを返す。要素の同一性で「変わっていない」を
  // 見分けられるようにして、無駄な再計算と再描画を起こさないため。
  if (feature.kind === 'point' && slot === 'at') {
    const next = map(feature.at);
    return next === feature.at ? feature : { ...feature, at: next };
  }
  if (feature.kind === 'line' && slot === 'from') {
    const next = map(feature.from);
    return next === feature.from ? feature : { ...feature, from: next };
  }
  if (feature.kind === 'line' && slot === 'to') {
    const next = map(feature.to);
    return next === feature.to ? feature : { ...feature, to: next };
  }
  if (feature.kind === 'arc' && slot === 'center') {
    const next = map(feature.center);
    return next === feature.center ? feature : { ...feature, center: next };
  }
  // 3D スケッチ(FR-330)の円弧だけが持つ向き。プロパティ欄でだけ編集できる。
  if (feature.kind === 'arc' && feature.freeOrientation !== undefined) {
    const orientation = feature.freeOrientation;
    if (slot === 'normal') {
      const next = map(orientation.normal);
      return next === orientation.normal
        ? feature
        : { ...feature, freeOrientation: { ...orientation, normal: next } };
    }
    if (slot === 'xAxis') {
      const next = map(orientation.xAxis);
      return next === orientation.xAxis
        ? feature
        : { ...feature, freeOrientation: { ...orientation, xAxis: next } };
    }
  }
  // 直線状・格子状の点列は基準点を「base」に持ち、円周上は「center」に持つ(§2.3)。
  if (feature.kind === 'pointArray') {
    const layout = feature.layout;
    if (slot === 'base' && layout.kind !== 'circular') {
      const next = map(layout.base);
      return next === layout.base ? feature : { ...feature, layout: { ...layout, base: next } };
    }
    if (slot === 'center' && layout.kind === 'circular') {
      const next = map(layout.center);
      return next === layout.center ? feature : { ...feature, layout: { ...layout, center: next } };
    }
    return feature;
  }
  if (feature.kind === 'rectangle' && slot === 'corner1') {
    const next = map(feature.corner1);
    return next === feature.corner1 ? feature : { ...feature, corner1: next };
  }
  if (feature.kind === 'rectangle' && slot === 'corner2') {
    const next = map(feature.corner2);
    return next === feature.corner2 ? feature : { ...feature, corner2: next };
  }
  if (feature.kind === 'polygon' && slot === 'center') {
    const next = map(feature.center);
    return next === feature.center ? feature : { ...feature, center: next };
  }
  if (feature.kind === 'slot' && slot === 'center1') {
    const next = map(feature.center1);
    return next === feature.center1 ? feature : { ...feature, center1: next };
  }
  if (feature.kind === 'slot' && slot === 'center2') {
    const next = map(feature.center2);
    return next === feature.center2 ? feature : { ...feature, center2: next };
  }
  if (feature.kind === 'ellipse' && slot === 'center') {
    const next = map(feature.center);
    return next === feature.center ? feature : { ...feature, center: next };
  }
  if (feature.kind === 'spline' && slot.startsWith('points.')) {
    const index = Number.parseInt(slot.slice('points.'.length), 10);
    const point = feature.points[index];
    if (point === undefined) {
      return feature;
    }
    const next = map(point);
    if (next === point) {
      return feature;
    }
    const points = feature.points.map((current, position) =>
      position === index ? next : current,
    );
    return { ...feature, points };
  }
  if (feature.kind === 'copy') {
    const { placement } = feature;
    if (placement.kind === 'translate' && slot === 'delta') {
      const next = map(placement.delta);
      return next === placement.delta
        ? feature
        : { ...feature, placement: { ...placement, delta: next } };
    }
    if (placement.kind === 'linearArray' && slot === 'direction') {
      const next = map(placement.direction);
      return next === placement.direction
        ? feature
        : { ...feature, placement: { ...placement, direction: next } };
    }
    if (placement.kind === 'circularArray' && slot === 'center') {
      const next = map(placement.center);
      return next === placement.center
        ? feature
        : { ...feature, placement: { ...placement, center: next } };
    }
    return feature;
  }
  // 知らない道筋なら何も変えない(黙って壊さない)。
  return feature;
}

/**
 * 1 点の指定の中の 1 欄を差し替える。指定方法に無い欄なら元のまま。
 * 基準ジオメトリ(FR-329)の座標も同じ形なので輸出する(同じ分岐を 2 か所に書かない)。
 */
export function setCoordinateField(
  input: CoordinateInput,
  key: string,
  value: ExpressionValue,
): CoordinateInput {
  if (input.mode === 'absolute') {
    if (key === 'x') {
      return { ...input, x: value };
    }
    if (key === 'y') {
      return { ...input, y: value };
    }
    if (key === 'z') {
      return { ...input, z: value };
    }
    return input;
  }
  if (input.mode === 'relative') {
    if (key === 'dx') {
      return { ...input, dx: value };
    }
    if (key === 'dy') {
      return { ...input, dy: value };
    }
    if (key === 'dz') {
      return { ...input, dz: value };
    }
    return input;
  }
  if (key === 'distance') {
    return { ...input, distance: value };
  }
  if (key === 'azimuth') {
    return { ...input, azimuth: value };
  }
  if (key === 'elevation') {
    return { ...input, elevation: value };
  }
  return input;
}

/**
 * 「中心+幅+高さ」の見せ方で入れた値を、対角 2 点へ書き戻す(FR-314、計画書タスク33)。
 * その見せ方に無い道筋なら null を返し、呼び出し側が普通の書き戻しへ進む。
 */
function setRectangleCenterSizeField(
  feature: SketchRectangleFeature,
  path: string,
  value: ExpressionValue,
): SketchRectangleFeature | null {
  const current = rectangleCenterSize(feature);
  if (current === null) {
    return null;
  }
  if (path === 'width') {
    return rectangleFromCenterSize(feature, { ...current, width: value });
  }
  if (path === 'height') {
    return rectangleFromCenterSize(feature, { ...current, height: value });
  }
  // `null` との比較で分けると、残る 0 / 1 / 2 だけが並びの番号として通る(範囲外を型で防ぐ)。
  const axis = path === 'center.x' ? 0 : path === 'center.y' ? 1 : path === 'center.z' ? 2 : null;
  if (axis === null) {
    return null;
  }
  const center: [ExpressionValue, ExpressionValue, ExpressionValue] = [
    current.center[0],
    current.center[1],
    current.center[2],
  ];
  center[axis] = value;
  return rectangleFromCenterSize(feature, { ...current, center });
}

/** 点列(FR-327)の数の欄。並べ方ごとに持つ欄が違う。 */
function setPointArrayField(
  feature: SketchPointArrayFeature,
  path: string,
  value: ExpressionValue,
): SketchFeature {
  const layout = feature.layout;
  if (layout.kind === 'linear') {
    if (path === 'azimuth') {
      return { ...feature, layout: { ...layout, azimuth: value } };
    }
    if (path === 'spacing') {
      return { ...feature, layout: { ...layout, spacing: value } };
    }
    if (path === 'count') {
      return { ...feature, layout: { ...layout, count: value } };
    }
    return feature;
  }
  if (layout.kind === 'circular') {
    if (path === 'radius') {
      return { ...feature, layout: { ...layout, radius: value } };
    }
    if (path === 'count') {
      return { ...feature, layout: { ...layout, count: value } };
    }
    return feature;
  }
  switch (path) {
    case 'rowAzimuth':
      return { ...feature, layout: { ...layout, rowAzimuth: value } };
    case 'rowSpacing':
      return { ...feature, layout: { ...layout, rowSpacing: value } };
    case 'rowCount':
      return { ...feature, layout: { ...layout, rowCount: value } };
    case 'colAzimuth':
      return { ...feature, layout: { ...layout, colAzimuth: value } };
    case 'colSpacing':
      return { ...feature, layout: { ...layout, colSpacing: value } };
    case 'colCount':
      return { ...feature, layout: { ...layout, colCount: value } };
    default:
      return feature;
  }
}

/** 複製(FR-324)の数の欄。配置ごとに持つ欄が違う。 */
function setCopyField(
  feature: SketchCopyFeature,
  path: string,
  value: ExpressionValue,
): SketchFeature {
  const { placement } = feature;
  if (placement.kind === 'linearArray') {
    if (path === 'spacing') {
      return { ...feature, placement: { ...placement, spacing: value } };
    }
    if (path === 'count') {
      return { ...feature, placement: { ...placement, count: value } };
    }
    return feature;
  }
  if (placement.kind === 'circularArray') {
    if (path === 'angle') {
      return { ...feature, placement: { ...placement, angle: value } };
    }
    if (path === 'count') {
      return { ...feature, placement: { ...placement, count: value } };
    }
  }
  return feature;
}

/**
 * 道筋の場所へ新しい式を入れた、別の要素を作る(元は変えない)。
 * 妥当な式になったときだけ呼ぶ。下流は再計算で追従する(FR-311)。
 */
export function setFeatureField(
  feature: SketchFeature,
  path: string,
  value: ExpressionValue,
): SketchFeature {
  // 矩形の「中心+幅+高さ」は履歴に無い見せ方なので、対角 2 点へ直してから書き戻す。
  if (feature.kind === 'rectangle') {
    const converted = setRectangleCenterSizeField(feature, path, value);
    if (converted !== null) {
      return converted;
    }
  }
  const separator = path.indexOf('.');
  if (separator >= 0) {
    // スプラインの点は `points.3.x` の 3 段になるので、最後の 1 段だけを欄の名前にする。
    const lastSeparator = path.lastIndexOf('.');
    const slot = path.slice(0, lastSeparator);
    const key = path.slice(lastSeparator + 1);
    return withCoordinate(feature, slot, (input) => setCoordinateField(input, key, value));
  }
  if (feature.kind === 'arc') {
    if (path === 'radius') {
      return { ...feature, radius: value };
    }
    if (path === 'startAngle') {
      return { ...feature, startAngle: value };
    }
    if (path === 'endAngle') {
      return { ...feature, endAngle: value };
    }
    return feature;
  }
  if (feature.kind === 'pointArray') {
    return setPointArrayField(feature, path, value);
  }
  if (feature.kind === 'polygon') {
    if (path === 'sides') {
      return { ...feature, sides: value };
    }
    if (path === 'radius') {
      return { ...feature, radius: value };
    }
    return feature;
  }
  if (feature.kind === 'slot') {
    return path === 'width' ? { ...feature, width: value } : feature;
  }
  if (feature.kind === 'ellipse') {
    switch (path) {
      case 'majorRadius':
        return { ...feature, majorRadius: value };
      case 'minorRadius':
        return { ...feature, minorRadius: value };
      case 'rotation':
        return { ...feature, rotation: value };
      case 'startAngle':
        return { ...feature, startAngle: value };
      case 'endAngle':
        return { ...feature, endAngle: value };
      default:
        return feature;
    }
  }
  if (feature.kind === 'offset') {
    return path === 'distance' ? { ...feature, distance: value } : feature;
  }
  if (feature.kind === 'copy') {
    return setCopyField(feature, path, value);
  }
  return feature;
}

/**
 * 入切のつまみ(構築線・閉じる・全周)を切り替えた別の要素を作る(FR-320、FR-317、FR-324)。
 * 持たないつまみなら同じものを返す。
 */
export function setFeatureToggle(
  feature: SketchFeature,
  key: FeatureToggleKey,
  value: boolean,
): SketchFeature {
  if (key === 'construction') {
    switch (feature.kind) {
      case 'line':
      case 'arc':
      case 'rectangle':
      case 'polygon':
      case 'slot':
      case 'ellipse':
      case 'spline':
      case 'offset':
      case 'copy':
      case 'projectedCurve':
      case 'planeSection':
        return feature.construction === value ? feature : { ...feature, construction: value };
      case 'point':
      case 'pointArray':
      case 'face':
        // 点・点列・面は実体を作らないので構築線の別が無い(model の型どおり)。
        return feature;
    }
  }
  if (key === 'splineClosed' && feature.kind === 'spline') {
    if (feature.closed === value) {
      return feature;
    }
    // 閉じるには 3 点が要る(model の約束)。足りないまま閉じさせない(NFR-UX-5)。
    if (value && feature.points.length < 3) {
      return feature;
    }
    return { ...feature, closed: value };
  }
  if (key === 'fullCircle' && feature.kind === 'copy') {
    const { placement } = feature;
    if (placement.kind !== 'circularArray' || placement.fullCircle === value) {
      return feature;
    }
    return { ...feature, placement: { ...placement, fullCircle: value } };
  }
  return feature;
}

/**
 * いくつかから 1 つを選ぶ欄を書き戻した別の要素を作る(FR-315、FR-317、FR-321)。
 * 矩形の見せ方(`rectangleMode`)は履歴に残らない画面だけの切替なので、ここでは扱わない。
 */
export function setFeatureChoice(
  feature: SketchFeature,
  key: FeatureChoiceKey,
  value: string,
): SketchFeature {
  if (key === 'polygonRadiusMode' && feature.kind === 'polygon') {
    if (value !== 'circumscribed' && value !== 'inscribed') {
      return feature;
    }
    return feature.radiusMode === value ? feature : { ...feature, radiusMode: value };
  }
  if (key === 'splineMode' && feature.kind === 'spline') {
    if (value !== 'interpolate' && value !== 'control') {
      return feature;
    }
    return feature.mode === value ? feature : { ...feature, mode: value };
  }
  if (key === 'offsetSide' && feature.kind === 'offset') {
    if (value !== 'outside' && value !== 'inside') {
      return feature;
    }
    return feature.side === value ? feature : { ...feature, side: value };
  }
  if (key === 'offsetCorner' && feature.kind === 'offset') {
    if (value !== 'round' && value !== 'sharp') {
      return feature;
    }
    return feature.corner === value ? feature : { ...feature, corner: value };
  }
  return feature;
}

/**
 * スプライン(FR-317)の点を 1 つ足す。足す場所は `index` の**次**で、値は前後の中点。
 * 末尾へ足すときは最後の点をそのまま写す(そのあと座標を直せばよい、NFR-UX-4)。
 */
export function addSplinePoint(feature: SketchFeature, index: number): SketchFeature {
  if (feature.kind !== 'spline') {
    return feature;
  }
  const current = feature.points[index];
  if (current === undefined) {
    return feature;
  }
  const following = feature.points[index + 1];
  const inserted =
    following === undefined ? current : midpointCoordinate(current, following) ?? current;
  const points = [
    ...feature.points.slice(0, index + 1),
    inserted,
    ...feature.points.slice(index + 1),
  ];
  return { ...feature, points };
}

/** 2 点の中点(どちらも絶対座標のときだけ)。作れなければ null。 */
function midpointCoordinate(a: CoordinateInput, b: CoordinateInput): CoordinateInput | null {
  const first = absoluteComponents(a);
  const second = absoluteComponents(b);
  if (first === null || second === null) {
    return null;
  }
  return {
    mode: 'absolute',
    x: midpointExpression(first[0], second[0]),
    y: midpointExpression(first[1], second[1]),
    z: midpointExpression(first[2], second[2]),
  };
}

/**
 * スプライン(FR-317)の点を 1 つ消す。開いた曲線は 2 点、閉じた曲線は 3 点まで減らせる
 * (model の約束。これ以上減らすと曲線が作れなくなるので断る、NFR-UX-5)。
 */
export function removeSplinePoint(feature: SketchFeature, index: number): SketchFeature {
  if (feature.kind !== 'spline') {
    return feature;
  }
  const least = feature.closed ? 3 : 2;
  if (feature.points.length <= least || feature.points[index] === undefined) {
    return feature;
  }
  return { ...feature, points: feature.points.filter((_, position) => position !== index) };
}

/**
 * 構築線(FR-320)として引く要素の id(P4 タスク33)。
 *
 * **model は解決済みの曲線(`ResolvedCurve`)に construction を持たせない**
 * (`resolveSketch.ts` の注釈。面の境界に選べるかの判定にしか使っていない)。
 * 破線で引くかどうかは履歴を見れば決まるので、model の型も既存の期待値も変えずに
 * ここ(ui)で履歴から引く。曲線を持つ種類だけが `construction` を持つので、
 * 種類ごとに明示して数え、`as` による強制変換を使わない(rules/02-禁止事項.md)。
 */
export function constructionFeatureIds(document: SketchDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const feature of document.features) {
    switch (feature.kind) {
      case 'line':
      case 'arc':
      case 'rectangle':
      case 'polygon':
      case 'slot':
      case 'ellipse':
      case 'spline':
      case 'offset':
      case 'copy':
      case 'projectedCurve':
      case 'planeSection':
        if (feature.construction) {
          ids.add(feature.id);
        }
        break;
      case 'point':
      case 'pointArray':
      case 'face':
        break;
    }
  }
  return ids;
}

/** 名前を変えた新しい要素を作る(FR-503)。空白だけの名前は受け付けず元のまま返す。 */
export function renameFeature(feature: SketchFeature, name: string): SketchFeature {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === feature.name ? feature : { ...feature, name: trimmed };
}

/** 指定方法を変えても基準の点は引き継ぐ。絶対座標は基準を持たないので既定へ戻す。 */
function baseOf(input: CoordinateInput): PointReference {
  return input.mode === 'absolute' ? DEFAULT_COORDINATE_BASE : input.base;
}

function coordinateInMode(input: CoordinateInput, mode: CoordinateMode): CoordinateInput {
  if (input.mode === mode) {
    return input;
  }
  switch (mode) {
    case 'absolute':
      return { mode: 'absolute', x: ZERO, y: ZERO, z: ZERO };
    case 'relative':
      return { mode: 'relative', base: baseOf(input), dx: ZERO, dy: ZERO, dz: ZERO };
    case 'polar':
      return {
        mode: 'polar',
        base: baseOf(input),
        distance: DEFAULT_DISTANCE,
        azimuth: ZERO,
        elevation: ZERO,
      };
  }
}

/**
 * 位置の決め方(絶対・相対・極)を切り替えた別の要素を作る(FR-301〜303)。
 * 欄の意味が変わるので入力は引き継がず既定値へ戻す(§2.9)。
 */
export function setFeatureCoordinateMode(
  feature: SketchFeature,
  slot: string,
  mode: CoordinateMode,
): SketchFeature {
  // 変わらないとき(同じ指定方法・知らない道筋)は同じものを返し、無駄な再計算を起こさない。
  return withCoordinate(feature, slot, (input) => coordinateInMode(input, mode));
}

/** 選択中の要素 id(点列の 1 点は `featureId#n`)から、元の要素の id を取り出す。 */
export function featureIdOf(elementId: string): string {
  const separator = elementId.indexOf('#');
  return separator < 0 ? elementId : elementId.slice(0, separator);
}

/** 選択中の要素 id から、プロパティ欄に出す要素を決める。無ければ null。 */
export function featureForSelection(
  document: SketchDocument,
  selection: readonly string[],
): SketchFeature | null {
  const first = selection[0];
  if (first === undefined) {
    return null;
  }
  const featureId = featureIdOf(first);
  return document.features.find((feature) => feature.id === featureId) ?? null;
}

/** 面の境界に並ぶ要素 1 つ。表示名は元の要素の名前で、点列だけ何番目かを付ける。 */
export interface FaceBoundaryEntry {
  readonly elementId: string;
  readonly label: string;
}

/** 面の境界の一覧(FR-309)。並び順がそのまま囲む順になる。 */
export function faceBoundaryEntries(
  document: SketchDocument,
  feature: SketchFaceFeature,
): FaceBoundaryEntry[] {
  return feature.boundary.map((reference) => {
    const found = document.features.find((candidate) => candidate.id === reference.featureId);
    const name = found?.name ?? reference.featureId;
    if (reference.index === undefined) {
      return { elementId: reference.featureId, label: name };
    }
    return {
      elementId: `${reference.featureId}#${String(reference.index)}`,
      // 何番目かは 1 から数える。記号だけなので言葉の資源は要らない。
      label: `${name} #${String(reference.index + 1)}`,
    };
  });
}

/** 読み取り専用で出す計算結果の 1 行。数字は等幅で右へそろえる。 */
export interface ResolvedFieldSummary {
  readonly labelKey: MessageKey;
  readonly text: string;
}

/** 表示用の数の文字列。有効数字 12 桁で、指数表記にしない(§2.4)。 */
function formatNumber(value: number): string {
  return expressionValueFromNumber(value).display;
}

/* ---------------------------------------------------------------------------
 * 拘束で決まった座標(FR-313、P4b タスク22b (g))
 * ------------------------------------------------------------------------- */

/** 座標の欄と解決結果の点の対応。ここに無い場所(矩形の角など)は規則から作られる点。 */
function coordinateSlotPosition(
  feature: SketchFeature,
  slotPath: string,
  resolved: ResolvedSketch,
): Vec3 | null {
  if (feature.kind === 'point' && slotPath === 'at') {
    return resolved.points.find((point) => point.id === feature.id)?.position ?? null;
  }
  if (feature.kind === 'line' && (slotPath === 'from' || slotPath === 'to')) {
    const segment = resolved.segments.find((entry) => entry.featureId === feature.id);
    if (segment === undefined) {
      return null;
    }
    return slotPath === 'from' ? segment.from : segment.to;
  }
  if (feature.kind === 'arc' && slotPath === 'center') {
    return resolved.arcs.find((entry) => entry.featureId === feature.id)?.center ?? null;
  }
  if (feature.kind === 'ellipse' && slotPath === 'center') {
    return resolved.ellipses.find((entry) => entry.featureId === feature.id)?.center ?? null;
  }
  if (feature.kind === 'spline' && slotPath.startsWith('points.')) {
    const index = Number(slotPath.slice('points.'.length));
    if (!Number.isInteger(index)) {
      return null;
    }
    const spline = resolved.splines.find((entry) => entry.featureId === feature.id);
    return spline?.points[index] ?? null;
  }
  return null;
}

/** 拘束が動かしたと見なす最小の差(mm)。解の許容量(1e-9)より粗く、表示の桁より細かい。 */
const SOLVED_COORDINATE_EPSILON_MM = 1e-7;

/** 2 点が同じ位置か(上の許容量で)。 */
function samePosition(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a[0] - b[0]) <= SOLVED_COORDINATE_EPSILON_MM &&
    Math.abs(a[1] - b[1]) <= SOLVED_COORDINATE_EPSILON_MM &&
    Math.abs(a[2] - b[2]) <= SOLVED_COORDINATE_EPSILON_MM
  );
}

/**
 * 拘束で決まった、いまの位置の 1 文(FR-313、P4b タスク22b (g))。
 *
 * `stored` は**保存された式だけで解いた形**、`solved` は**拘束を解いた後の形**(いま
 * 描いている形)。2 つが同じなら拘束は何も動かしていないので null(欄の下は今までどおり
 * 式の評価値だけ)。動いていれば「= (x, y, z)(拘束で決まった値)」を返す。
 *
 * 数の書き方は読み取り専用の欄(`resolvedFields`)と同じ `formatNumber` にそろえる
 * (同じ画面の中で桁の出方が 2 通りにならないようにする)。
 */
export function solvedCoordinateText(
  feature: SketchFeature,
  slotPath: string,
  stored: ResolvedSketch,
  solved: ResolvedSketch,
): string | null {
  const after = coordinateSlotPosition(feature, slotPath, solved);
  if (after === null) {
    return null;
  }
  const before = coordinateSlotPosition(feature, slotPath, stored);
  if (before !== null && samePosition(before, after)) {
    return null;
  }
  const listed = [after[0], after[1], after[2]].map(formatNumber).join(t('propertyPanel.solvedSeparator'));
  return `${t('propertyPanel.solvedPrefix')}${listed}${t('propertyPanel.solvedSuffix')}`;
}

/**
 * 座標の欄へ「拘束で決まった、いまの位置」を差し込む(FR-313、タスク22b (g))。
 * 動いた欄が 1 つも無ければ**元の要約をそのまま返す**(無駄な描き直しを起こさない)。
 */
export function withSolvedCoordinates(
  summary: FeatureSummary,
  feature: SketchFeature,
  stored: ResolvedSketch,
  solved: ResolvedSketch,
): FeatureSummary {
  let changed = false;
  const coordinates = summary.coordinates.map((coordinate) => {
    const solvedText = solvedCoordinateText(feature, coordinate.path, stored, solved);
    if (solvedText === null) {
      return coordinate;
    }
    changed = true;
    return { ...coordinate, solvedText };
  });
  return changed ? { ...summary, coordinates } : summary;
}

/**
 * 履歴から導いた値を読み取り専用で出す(位置・長さ・個数・三角形の数)。
 * 解決できていない要素では何も出さない。理由はステータスバーとツリーの印が伝える。
 */
export function resolvedFields(
  feature: SketchFeature,
  resolved: ResolvedSketch,
  mesh: SketchMesh | null,
): ResolvedFieldSummary[] {
  switch (feature.kind) {
    case 'point': {
      const point = resolved.points.find((candidate) => candidate.id === feature.id);
      if (point === undefined) {
        return [];
      }
      return [
        { labelKey: FIELD_LABEL_KEYS.x, text: formatNumber(point.position[0]) },
        { labelKey: FIELD_LABEL_KEYS.y, text: formatNumber(point.position[1]) },
        { labelKey: FIELD_LABEL_KEYS.z, text: formatNumber(point.position[2]) },
      ];
    }
    case 'line': {
      const segment = resolved.segments.find((candidate) => candidate.featureId === feature.id);
      if (segment === undefined) {
        return [];
      }
      return [
        {
          labelKey: 'propertyPanel.length',
          text: formatNumber(distanceVec3(segment.from, segment.to)),
        },
      ];
    }
    case 'arc': {
      const arc = resolved.arcs.find((candidate) => candidate.featureId === feature.id);
      if (arc === undefined) {
        return [];
      }
      return [
        {
          labelKey: 'propertyPanel.arcLength',
          text: formatNumber(arc.radius * Math.abs(arc.endAngle - arc.startAngle)),
        },
      ];
    }
    case 'pointArray': {
      const count = resolved.points.filter(
        (candidate) => candidate.featureId === feature.id,
      ).length;
      return count === 0 ? [] : [{ labelKey: 'propertyPanel.pointCount', text: String(count) }];
    }
    case 'face': {
      const face = mesh?.faces.find((candidate) => candidate.featureId === feature.id);
      if (face === undefined) {
        return [];
      }
      return [
        { labelKey: 'propertyPanel.triangleCount', text: String(face.triangleCount) },
      ];
    }
    case 'ellipse': {
      const ellipse = resolved.ellipses.find((candidate) => candidate.featureId === feature.id);
      if (ellipse === undefined) {
        return [];
      }
      return [
        { labelKey: FIELD_LABEL_KEYS.majorRadius, text: formatNumber(ellipse.majorRadius) },
        { labelKey: FIELD_LABEL_KEYS.minorRadius, text: formatNumber(ellipse.minorRadius) },
      ];
    }
    case 'spline': {
      const spline = resolved.splines.find((candidate) => candidate.featureId === feature.id);
      return spline === undefined
        ? []
        : [{ labelKey: 'propertyPanel.pointCount', text: String(spline.points.length) }];
    }
    case 'rectangle':
    case 'polygon':
    case 'slot':
    case 'offset':
    case 'copy':
    case 'projectedCurve':
    case 'planeSection': {
      // 1 フィーチャーが複数の曲線を生むものは、できた曲線の本数と長さの合計を出す
      // (§0.a-0.8 の `curvesByFeature` がそのまま「何本できたか」の答えになる)。
      const curves = resolved.curvesByFeature.get(feature.id);
      if (curves === undefined || curves.length === 0) {
        // 複製は点だけを写すこともある(点列を複製したとき)。そのときは点の数を出す。
        const count = resolved.points.filter(
          (candidate) => candidate.featureId === feature.id,
        ).length;
        return count === 0 ? [] : [{ labelKey: 'propertyPanel.pointCount', text: String(count) }];
      }
      return [
        { labelKey: 'propertyPanel.curveCount', text: String(curves.length) },
        { labelKey: 'propertyPanel.length', text: formatNumber(totalCurveLength(curves)) },
      ];
    }
  }
}

/** 曲線の並びの長さの合計(mm)。楕円・スプラインは折れ線の標本で近似する。 */
function totalCurveLength(curves: readonly ResolvedCurve[]): number {
  let total = 0;
  for (const curve of curves) {
    const points = sampleCurve(curve);
    for (let index = 0; index + 1 < points.length; index += 1) {
      total += distanceVec3(points[index], points[index + 1]);
    }
  }
  return total;
}
