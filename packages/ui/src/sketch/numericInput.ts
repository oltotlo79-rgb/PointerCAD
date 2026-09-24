/**
 * その場数値入力ポップアップの状態機械(計画書 docs/plans/P1-式とスケッチ.md タスク16、§2.9)。
 * P2 でソリッドの3道具(押し出し・回転・縫合)を足した(P2 タスク19、§0.a-0.7 / 0.8 / 0.9)。
 * P3 で加工6種(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)とばね(2段)を足した
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク24、§2.11)。
 *
 * DOM にも React にも触れない純関数と不変な状態だけで作る。理由は2つ。
 * ① jsdom / testing-library を入れない方針(§0.a-0.8)の下でも、欄の巡回・確定・取消・
 *    エラー表示のすべてを Node の単体検査で固定できるようにするため。
 * ② 表示はタスク18 の React 部品が薄く包むだけにして、状態をストア1本へ寄せるため
 *    (rules/04-設計の規律.md「フロントの状態はZustandストア1本に一元化する」)。
 *
 * 表示する文言はここに持たず、必ず ja.json のキー(MessageKey)で返す(NFR-MA-5)。
 * 例外は範囲外の理由文だけで、限界値を差し込んだ文になるためキー1つでは組み立てられない
 * (packages/expression/src/errors.ts と同じ事情。describeRange の注釈を参照)。
 *
 * P3 で選択肢(NumericChoice)を「1つだけ」から「配列」へ広げた(§2.11)。
 * ねじ穴は「呼び」と「系列」の2つ、C面取りは「決め方」1つ、パターンは「向き/軸」1つを持つため。
 * P1・P2 の段の振る舞いは1つも変えていない(既存の検査はそのまま緑)。
 *
 * P4 タスク11 で新しい図形(円・2点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン)の段と、
 * 点列の並べ方(直線/円周/格子)の選択肢、構築線のつまみを足した
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク11、FR-314〜318 / FR-320 / FR-326 / FR-327)。
 *
 * P4 の新しい段は**欄を1段あたり2個まで**にする(統括の指示。NFR-UX-2「その場で」を保つため、
 * 欄が3個以上になる道具は段を分ける)。既存の P1 の段(円弧の形・点列の並べ方)は3欄のまま
 * 変えない。構築線(FR-320)は段を増やさず、要素を確定する最後の段のつまみとして持たせる。
 */

import {
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';
import { applyNumericDefaultSources, type NumericDefaultSources } from './numericDefaultSources.js';
import {
  DEFAULT_BOX_SIZE_MM,
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_CIRCULAR_PATTERN_COUNT,
  DEFAULT_CONE_BOTTOM_RADIUS_MM,
  DEFAULT_CONE_HEIGHT_MM,
  DEFAULT_CONE_TOP_RADIUS_MM,
  DEFAULT_COUNTERBORE_DEPTH_MM,
  DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES,
  DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_CUT_KEEP,
  DEFAULT_CYLINDER_HEIGHT_MM,
  DEFAULT_CYLINDER_RADIUS_MM,
  DEFAULT_DRAFT_ANGLE_DEGREES,
  DEFAULT_EMBOSS_HEIGHT_MM,
  DEFAULT_EMBOSS_RAISED,
  DEFAULT_EXTRUDE_THICKNESS_MM,
  DEFAULT_FILLET_RADIUS_END_MM,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  DEFAULT_PATTERN_COUNT,
  DEFAULT_PATTERN_SPACING_MM,
  DEFAULT_RIB_THICKNESS_MM,
  DEFAULT_RULED_TWIST,
  DEFAULT_SCALE_FACTOR,
  DEFAULT_SHELL_OUTWARD,
  DEFAULT_SHELL_THICKNESS_MM,
  DEFAULT_SPHERE_RADIUS_MM,
  DEFAULT_SPRING_COIL_DIAMETER_MM,
  DEFAULT_SPRING_PITCH_MM,
  DEFAULT_SPRING_TURNS,
  DEFAULT_SPRING_WIRE_DIAMETER_MM,
  DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM,
  DEFAULT_SURFACE_OFFSET_MM,
  DEFAULT_SWEEP_FRENET,
  DEFAULT_TAPER_ANGLE_DEGREES,
  DEFAULT_THREAD_DESIGNATION,
  DEFAULT_THREAD_SHAFT_LENGTH_MM,
  DEFAULT_TORUS_MAJOR_RADIUS_MM,
  DEFAULT_TORUS_MINOR_RADIUS_MM,
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
  DEFAULT_TRANSLATION_MM,
  findMetricThread,
  MAX_COPY_COUNT,
  MAX_DRAFT_ANGLE_DEGREES,
  MAX_PATTERN_COUNT,
  MAX_POINT_ARRAY_COUNT,
  MAX_SCALE,
  MAX_SPRING_TURNS,
  MAX_TAPER_ANGLE_DEGREES,
  metricThreadPitch,
  MIN_COPY_COUNT,
  MIN_SCALE,
  type ChamferSize,
  type CoordinateInput,
  type PointReference,
  type RevolveAxis,
  type RuledSphereSegments,
  type SketchLineRef,
  type SpringDerived,
  type SpringHandedness,
  type ThreadSeries,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

// 道具と入力段の契約は状態機械から独立した定義を参照する。
import {
  type SolidToolId,
  type ShapeToolId,
  type EditToolId,
  type ReferenceToolId,
  type NumericInputToolId,
  type CoordinateMode,
  type CoordinateNumericInputStep,
  type ShapeNumericInputStep,
  type SketchNumericInputStep,
  type SolidNumericInputStep,
  type ReferenceCoordinateStep,
  type ReferenceShapeStep,
  type ReferenceNumericInputStep,
  type EditNumericInputStep,
  type NumericInputStep,
} from './numericInputTools.js';
export * from './numericInputTools.js';

import { choicesFor, type MirrorAxisOptions, type ReferenceAxisOption } from './numericInputChoices.js';
export { DEFAULT_REVOLVE_AXIS, REFERENCE_AXIS_VALUE_PREFIX, type MirrorAxisOptions, type ReferenceAxisOption } from './numericInputChoices.js';

import type { FieldUnit } from './numericFieldUnits.js';
export { applyDisplayUnit, isLengthFieldUnit, type FieldUnit } from './numericFieldUnits.js';

import { pendingVariablesFor } from './numericMathValues.js';
import { fillDefaults, evaluateNumericInput, evaluateNumericField, commitValues,
  type NumericInputEvaluation, type DisplayUnitOptions } from './numericInputEvaluation.js';
export { rangeErrorFor, effectiveSource, fieldExpression, fillDefaults, evaluateNumericInput,
  commitValues, valueByFieldKey, type NumericFieldResult, type NumericInputEvaluation,
  type DisplayUnitOptions } from './numericInputEvaluation.js';

export { twoPointArcCenterOffset, twoPointArcRadiusRejection } from './twoPointArcInput.js';
import type { SplineDraft } from './splineInputDraft.js';
export { EMPTY_SPLINE_DRAFT, appendSplinePoint, removeLastSplinePoint, checkSplineDraft,
  type SplineDraft, type SplineDraftOutcome, type SplineDraftCheck } from './splineInputDraft.js';

/**
 * 欄が受け付ける値の範囲(NFR-UX-5)。
 * 範囲を持たない欄(P1 の座標・円弧・点列)は range を持たない。
 */
export interface NumericFieldRange {
  readonly min: number;
  /** min そのものを許すか。false なら min より大きい値だけを許す。 */
  readonly minInclusive: boolean;
  /** 上限。上限が無ければ null。 */
  readonly max: number | null;
  /** max そのものを許すか。 */
  readonly maxInclusive: boolean;
}

/**
 * 欄を出すかどうかを決めるのに使える材料(P5 タスク49)。
 *
 * いま同じ段に並んでいる選択肢とつまみだけを渡す。ほかの段の状態も文書も渡さないのは、
 * 「この欄が出るかどうか」を段 1 つの中で読み切れるようにするためで、`visibleWhen` を
 * 段をまたいだ条件に使えないようにしておくと、欄の出し分けが表の並びから追える。
 */
export interface NumericFieldVisibility {
  readonly choices: readonly NumericChoice[];
  readonly toggles: readonly NumericToggle[];
}

export interface NumericFieldDefinition {
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  /** 空欄のまま Enter を押したときに使う値(NFR-UX-4)。 */
  readonly defaultSource: string;
  /** 値の範囲(NFR-UX-5)。無ければどんな数でも受け付ける。 */
  readonly range?: NumericFieldRange;
  /**
   * 選択肢・つまみの値で欄を出し分ける(P5 タスク49、§2.15)。
   *
   * 省略すればいつでも出る。C 面取りの「等距離」で距離 2 を隠す(P3 の残件、
   * docs/報告記録.md 2026-09-04 03:20 の①)のも、拡大縮小の「軸ごと」で欄を
   * 1 つから 3 つへ増やすのも、穴の入口の種類で欄を入れ替えるのも、すべてこの 1 つの
   * 仕組みで済ませる。**効かない欄を出さない**のが NFR-UX-2 / NFR-UX-5 の要である。
   *
   * 欄が消えたときに輪(`numericFocusTargets`)から外れるのは、状態の `fields` から
   * そもそも取り除いているためで、輪の側に特別扱いは要らない。
   */
  readonly visibleWhen?: (visibility: NumericFieldVisibility) => boolean;
}

export interface NumericField extends NumericFieldDefinition {
  readonly source: string;
  /** A verified mathematical draft, invalidated by typing or snapping. Not a stored-value cache. */
  readonly mathValue?: ExpressionValue;
  /**
   * `source` を**利用者がこの欄へ打ち込んだ**か(P6 タスク3b、§0.a-0.63)。
   *
   * 表示が inch のとき `(<式>)in` で包むのは**打った文字だけ**にする。同じ欄の `source` には
   * 3 通りの出どころがあり、打った文字以外は**すでに内部の mm** だからである。
   *
   * - 既定値(`defaultSource`。`DEFAULT_*_MM` から来た mm の数)→ 包まない
   * - ビューポートで吸い付いた座標(`setValues`。カーネル/画面が出した mm)→ 包まない
   * - 利用者が打った文字 → 表示が inch なら包む
   *
   * 省略は「打っていない」。既存の呼び出し・検査は 1 つも書き換えずに mm のままになる。
   */
  readonly typed?: boolean;
}

/**
 * 入切だけのつまみ(押し出しの向き・両側、回転の向き、P3 の貫通・実らせん・両側へ・全周)。
 * 式ではないので値は真偽。
 */
export type NumericToggleKey =
  | 'reversed'
  | 'symmetric'
  | 'through'
  | 'modeledThread'
  | 'patternSymmetric'
  | 'fullCircle'
  /**
   * 構築線にするか(FR-320)。段を増やさず、要素を確定する最後の段へ付ける
   * (線分・円弧・円・2点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン)。既定は切。
   */
  | 'construction'
  | 'splitIntersections'
  /** 楕円を一部だけ(楕円弧)にするか(FR-318)。既定は切=全周。 */
  | 'ellipseArc'
  /** スプラインの最後の点から最初の点へ戻してつなぐか(FR-317)。既定は切。 */
  | 'splineClosed'
  /* ---- P5 タスク49: Should / Could 群のつまみ(§2.15 の段の表) ---- */
  /**
   * 押し出しの側面を傾けるか(FR-401、タスク50 で押し出しの段へ畳んだときに足した)。
   * 切(既定)なら傾き 0 のまっすぐな押し出しで、**傾きの欄そのものを出さない**。
   * 入にすると傾きの欄が出て、向きは `taperOutward` で決める。
   */
  | 'tapered'
  /** 押し出しの側面の傾きを外へ広げるか(FR-401)。既定は切=内へすぼめる。 */
  | 'taperOutward'
  /**
   * 押し出しを薄板にするか(FR-416、タスク50 で押し出しの段へ畳んだときに足した)。
   * 切(既定)なら中身の詰まった押し出しで、**厚みの欄そのものを出さない**。
   */
  | 'thinWalled'
  /** スイープで断面を曲がりに合わせて回すか(FR-409)。既定は切=ねじれを抑える。 */
  | 'sweepFrenet'
  | 'loftSmooth'
  /** エンボスを浮き出すか(FR-421)。既定は切=彫る。 */
  | 'raised'
  /** 拡大縮小を軸ごとの倍率にするか(FR-424)。入にすると欄が 1 つから 3 つへ増える。 */
  | 'scalePerAxis'
  /** くり抜きの肉を外向きに付けるか(FR-418)。既定は切=内向き(外形が変わらない)。 */
  | 'shellOutward'
  /** R 面取りの終わり側を別の半径にするか(FR-426)。入にすると終わりの半径の欄が出る。 */
  | 'variableRadius'
  /** 切断で法線の反対側を残すか(FR-432、§0.a-0.57)。既定は切=法線の側を残す。 */
  | 'cutKeepOpposite'
  /** 切断で両側とも残すか(§0.a-0.58。入にすると 2 つに分かれる)。既定は切。 */
  | 'cutKeepBoth';

export interface NumericToggle {
  readonly key: NumericToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/** 回転軸の選び方(§0.a-0.9)。line はスケッチの線分が選ばれているときだけ現れる。 */
export type RevolveAxisChoice = 'x' | 'y' | 'z' | 'line';

/**
 * 1つを選ぶつまみの種類(P3 §2.11)。
 * axis は回転・円形パターン・ばねの軸で共用する(いずれも「回転軸」の性質を持つ)。
 * patternDirection は直線パターン専用(向きであって回転軸ではないので別のキーにする)。
 */
export type NumericChoiceKey =
  | 'sweepGuide'
  | 'axis'
  | 'threadDesignation'
  | 'threadSeries'
  | 'chamferMode'
  | 'patternDirection'
  | 'springHandedness'
  | 'springDerived'
  /** 正多角形の半径の測り方(外接=頂点まで / 内接=辺まで、FR-315)。 */
  | 'polygonRadiusMode'
  /** 点列の並べ方(直線 / 円周 / 格子、FR-327)。選ぶと欄の並びが変わる。 */
  | 'pointArrayLayout'
  /** スプラインの点の使い方(通過点 / 制御点、FR-317)。 */
  | 'splineMode'
  /** 2 点+半径の円弧が、進む向きのどちら側へふくらむか(FR-326)。 */
  | 'arcBulge'
  /* ---- P4 タスク13: 基準ジオメトリ(FR-328、FR-329) ---- */
  /** オフセットのもとにする面(いまの作図面 / 基準の 3 面 / 選んだ面)。 */
  | 'referencePlaneBase'
  /** 軸の向き(ワールドの X・Y・Z、または文書にある基準軸)。傾け・座標系で使う。 */
  | 'referenceAxisSpec'
  /** 点を通る平面の決め方(辺に垂直 / 辺を含む / 面に平行 / 軸に垂直)。 */
  | 'referencePlaneThroughMode'
  /** 基準軸の決め方(2 点 / 辺 / 面の法線 / 2 面の交線)。 */
  | 'referenceAxisKind'
  /** 基準点の決め方(座標 / 頂点 / 辺の中点 / 面の中心)。 */
  | 'referencePointKind'
  /** 基準座標系の第 1 軸(X)。 */
  | 'referenceCsXAxis'
  /** 基準座標系の第 2 軸(Y)の手掛かり。 */
  | 'referenceCsYAxis'
  /* ---- P4 タスク21: オフセット(FR-321) ---- */
  /** オフセットの側。閉じた輪郭は外/内、開いた曲線は左/右と言葉を替える(値は共通)。 */
  | 'offsetSide'
  /** オフセットの角の作り方(丸める/尖らせる)。 */
  | 'offsetCorner'
  /* ---- P4 タスク24: ミラー(FR-324) ---- */
  /** 鏡にするもの(作図面の横軸 / 縦軸 / 選んだ線)。 */
  | 'mirrorBasis'
  /* ---- P5 タスク27: 面をつなぐ(FR-430) ---- */
  /**
   * 球へつなぐときのなめらかさ(24 / 48 / 72 点。§0.a-0.74、§0.a-0.87)。
   * **球を含まない断面では形に効かない**ので、そのときは選択肢ごと出さない。
   */
  | 'ruledSphereSegments'
  /* ---- P5 タスク49: Should / Could 群の選択肢(§2.15 の段の表) ---- */
  /** 押し出しの終わり方(距離 / 選んだ面まで / 次の面まで。FR-415)。 */
  | 'extrudeEnd'
  /** 薄板押し出しの厚みを付ける側(内 / 外 / 両側。FR-416)。 */
  | 'thicknessSide'
  /** ミラーの鏡にする面(XY / XZ / YZ / 選んだ面。FR-419)。 */
  | 'mirrorPlane'
  /** リブの厚みを付ける側(両側 / 表 / 裏。FR-420)。 */
  | 'ribSide'
  /** 穴の入口の広げ方(広げない / ざぐり / 皿もみ。FR-422)。 */
  | 'holeEntry'
  /** 外ねじを切り始める端(手前 / 奥。FR-423)。 */
  | 'threadShaftEnd'
  /** 曲面の作り方(掛ける / 回す / 平らに張る / つなぐ / 面を写す / 面を離す。FR-428)。 */
  | 'surfaceOperation'
  /** 切断面の決め方(基準の 3 面 / 選んだ面 / 3 点 / 点と辺 / 点と軸。FR-432)。 */
  | 'cutPlaneKind';

export interface NumericChoiceOption {
  readonly value: string;
  /**
   * 選択肢の見出し。ja.json のキーで持つのが原則だが、一覧が長いとき(呼び径28個)は
   * `label` に札の文字をそのまま入れて `labelKey` を持たない(ja.json に28個のキーを
   * 作らないため、§2.11「手順3」)。
   *
   * 計画書タスク24 の型宣言は `labelKey: MessageKey`(必須)のまま `label` を追加していたが、
   * 「labelKey が無い選択肢に使う」という同じ節の注釈と矛盾するため、labelKey を任意にした
   * (判断に迷った点として報告する)。
   */
  readonly labelKey?: MessageKey;
  readonly label?: string;
}

/** いくつかから1つを選ぶつまみ。 */
export interface NumericChoice {
  readonly presentation?: 'menu';
  readonly key: NumericChoiceKey;
  /** つまみの見出し(例:「回転軸」「決め方」「求める値」)。 */
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly options: readonly NumericChoiceOption[];
}

/** 選択肢の表示文字列。label があればそのまま、無ければ labelKey から引く(§2.11)。 */
export function numericChoiceOptionLabel(option: NumericChoiceOption): string {
  if (option.label !== undefined) {
    return option.label;
  }
  return option.labelKey === undefined ? option.value : t(option.labelKey);
}

export interface NumericInputState {
  /** A guided operation may finish once without changing the user's repeat setting. */
  readonly repeatAfterCommit?: boolean;
  /** この道具を開いた時点の既定値。次の段と選択肢変更へ持ち越す。 */
  readonly defaultSources?: NumericDefaultSources;
  /** 二段入力の修正先。文書や履歴へ保存しない入力中の状態。 */
  readonly previousStage?: NumericInputState;
  readonly textValue?: string;
  readonly textOrigin?: readonly [number, number, number];
  readonly toolId: NumericInputToolId;
  readonly step: NumericInputStep;
  readonly mode: CoordinateMode;
  readonly fields: readonly NumericField[];
  /**
   * 焦点の位置。欄・選択肢・つまみを並べた輪(numericFocusTargets)の添字で、
   * P1 の段は欄しか無いので「何番目の欄か」と一致する。
   */
  readonly focusedIndex: number;
  /** 入切のつまみ。持たない段は空配列。 */
  readonly toggles: readonly NumericToggle[];
  /**
   * 1つを選ぶつまみ。持たない段は空配列
   * (P2 の `choice: NumericChoice | null` から変わった、§2.11)。
   */
  readonly choices: readonly NumericChoice[];
  /**
   * 回転軸・パターンの向き・ばねの軸の選択肢に「選んだ線分」を含めるための元データ
   * (§0.a-0.9)。選択肢の 'line' を確定時に組み立て直すのに使う。持たない・
   * 選ばれていないときは undefined。
   */
  readonly axisLine?: SketchLineRef;
  /**
   * ばねの1段目(springShape)で確定した欄・選択肢・線分。2段目(springLength)の確定で
   * まとめて1つの SolidInputCommit にする(§2.11「1段目の値は2段目へ持ち越す」)。
   * ばね以外の道具・段では常に undefined。
   */
  readonly carriedStage1?: {
    readonly fields: readonly NumericField[];
    readonly choices: readonly NumericChoice[];
    readonly axisLine?: SketchLineRef;
    /**
     * 1 段目の位置の決め方(P4 タスク24)。1 段目が座標を聞く道具(円形配列の中心)でだけ
     * 入る。2 段目の確定で、持ち越した欄から中心の座標を組み立て直すのに要る。
     */
    readonly mode?: CoordinateMode;
  };
  /**
   * 軸の選択肢に並べる、文書にある基準軸(FR-329、タスク13)。`axisLine` と同じ役目で、
   * **次の段へ持ち越す**ために状態へ残す(基準座標系は原点の段の次に軸の段が来るので、
   * 開き直しのときに一覧が消えないようにする)。
   */
  readonly referenceAxes?: readonly ReferenceAxisOption[];
}

export type NumericInputEvent =
  | { readonly type: 'edit'; readonly index: number; readonly source: string }
  | { readonly type: 'focus'; readonly index: number }
  | { readonly type: 'tab'; readonly backwards: boolean }
  | { readonly type: 'setMode'; readonly mode: CoordinateMode }
  /** ビューポートをクリックしたときに、その座標を欄へ入れる(FR-107)。 */
  | { readonly type: 'setValues'; readonly values: readonly number[] }
  /** つまみの入切(Space、クリック)。 */
  | { readonly type: 'toggle'; readonly key: NumericToggleKey }
  /** 選択肢を直に選ぶ(クリック)。どのつまみかを key で指す(§2.11)。 */
  | { readonly type: 'choose'; readonly key: NumericChoiceKey; readonly value: string }
  /** 焦点がある選択肢を1つ隣へ動かす(← →)。端では回り込む。 */
  | { readonly type: 'moveChoice'; readonly backwards: boolean };

const COORDINATE_FIELDS: Readonly<Record<CoordinateMode, readonly NumericFieldDefinition[]>> = {
  absolute: [
    { key: 'x', labelKey: 'numericInput.field.x', tooltipKey: 'numericInput.tooltip.x', unit: 'mm', defaultSource: '0' },
    { key: 'y', labelKey: 'numericInput.field.y', tooltipKey: 'numericInput.tooltip.y', unit: 'mm', defaultSource: '0' },
    { key: 'z', labelKey: 'numericInput.field.z', tooltipKey: 'numericInput.tooltip.z', unit: 'mm', defaultSource: '0' },
  ],
  relative: [
    { key: 'dx', labelKey: 'numericInput.field.dx', tooltipKey: 'numericInput.tooltip.dx', unit: 'mm', defaultSource: '0' },
    { key: 'dy', labelKey: 'numericInput.field.dy', tooltipKey: 'numericInput.tooltip.dy', unit: 'mm', defaultSource: '0' },
    { key: 'dz', labelKey: 'numericInput.field.dz', tooltipKey: 'numericInput.tooltip.dz', unit: 'mm', defaultSource: '0' },
  ],
  polar: [
    { key: 'distance', labelKey: 'numericInput.field.distance', tooltipKey: 'numericInput.tooltip.distance', unit: 'mm', defaultSource: '10' },
    { key: 'azimuth', labelKey: 'numericInput.field.azimuth', tooltipKey: 'numericInput.tooltip.azimuth', unit: 'degree', defaultSource: '0' },
    { key: 'elevation', labelKey: 'numericInput.field.elevation', tooltipKey: 'numericInput.tooltip.elevation', unit: 'degree', defaultSource: '0' },
  ],
};

/**
 * P1 からある形の段の欄。P4 で足した段は `sketchShapeFieldDefinitionsFor` が返すので、
 * ここは `arcShape` / `pointArrayShape` の 2 つだけを持つ(P1 の欄は 1 つも変えない)。
 */
const SHAPE_FIELDS: Readonly<
  Record<'arcShape' | 'pointArrayShape', readonly NumericFieldDefinition[]>
> = {
  arcShape: [
    { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.radius', unit: 'mm', defaultSource: '10' },
    { key: 'startAngle', labelKey: 'numericInput.field.startAngle', tooltipKey: 'numericInput.tooltip.startAngle', unit: 'degree', defaultSource: '0' },
    { key: 'endAngle', labelKey: 'numericInput.field.endAngle', tooltipKey: 'numericInput.tooltip.endAngle', unit: 'degree', defaultSource: '90' },
  ],
  pointArrayShape: [
    { key: 'azimuth', labelKey: 'numericInput.field.azimuth', tooltipKey: 'numericInput.tooltip.azimuth', unit: 'degree', defaultSource: '0' },
    { key: 'spacing', labelKey: 'numericInput.field.spacing', tooltipKey: 'numericInput.tooltip.spacing', unit: 'mm', defaultSource: '10' },
    { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.count', unit: 'count', defaultSource: '5' },
  ],
};

/**
 * 0 より大きい値。上限なし。押し出しの距離・縫合の許容量のほか、P3 の直径・半径・距離・
 * 距離2・間隔・ねじ部の長さ・コイル径・線径・ばねのピッチ・全長がすべてこの範囲を使う
 * (計画書タスク24 の範囲表)。
 */
const POSITIVE: NumericFieldRange = { min: 0, minInclusive: false, max: null, maxInclusive: false };

/**
 * 0 以上、上限なし(円錐の上半径だけがこの範囲、§2.7.1 の表)。
 *
 * 円錐は上半径 0 で尖った円錐、0 より大きい値で円錐台になる(§0.a-0.16。円錐台を別の種類に
 * しないで済ませるための決め)。**両方 0** と **上下同径** は欄 1 つでは表せない断りなので、
 * ここではなく確定のとき(`primitiveCommands.ts` の `primitiveShapeRejection`)に見る。
 */
const NON_NEGATIVE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: null,
  maxInclusive: false,
};

/** 0 より大きく 360 以下(回転角・円形パターンの角度、§2.1、§0.a-0.21)。 */
const ANGLE_UP_TO_360: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 360,
  maxInclusive: true,
};

/** 0 より大きく 90 より小さい(C面取りの距離角度、model の ChamferSize の注釈どおり)。 */
const CHAMFER_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 90,
  maxInclusive: false,
};

/** 2 以上 MAX_PATTERN_COUNT 以下(パターンの個数、計画書タスク24 の範囲表)。 */
const PATTERN_COUNT_RANGE: NumericFieldRange = {
  min: 2,
  minInclusive: true,
  max: MAX_PATTERN_COUNT,
  maxInclusive: true,
};

/** 0 より大きく MAX_SPRING_TURNS 以下(ばねの巻数、§0.a-0.35)。 */
const SPRING_TURNS_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: MAX_SPRING_TURNS,
  maxInclusive: true,
};

/**
 * 3 以上(正多角形の辺数、FR-315)。整数かどうかはここでは見ない
 * (`NumericFieldRange` は上下限しか表せないため。整数の判定は model の解決が受け持つ
 *  — `resolveSketch.ts` の「辺の数は 3 以上にしてください。」。P3 のパターンの個数と同じ分担)。
 */
const POLYGON_SIDES_RANGE: NumericFieldRange = {
  min: 3,
  minInclusive: true,
  max: null,
  maxInclusive: false,
};

/**
 * 1 以上 MAX_POINT_ARRAY_COUNT 以下(円周上・格子の点の個数、FR-327)。
 * model の `MIN_POINT_ARRAY_COUNT` / `MAX_POINT_ARRAY_COUNT` と同じ範囲にする。
 * P1 からある直線の点列の「個数」の欄には範囲を足さない(既存の振る舞いを変えないため。
 * 検査「P1 の欄には範囲の縛りを足していない」の趣旨に合わせる)。
 */
const POINT_ARRAY_COUNT_RANGE: NumericFieldRange = {
  min: 1,
  minInclusive: true,
  max: MAX_POINT_ARRAY_COUNT,
  maxInclusive: true,
};

/**
 * 0 度以上 180 度未満(点+軸で決める平面の傾き角、FR-328)。
 * model の `resolvePlaneSpec`(geometry/planeSpec.ts)が同じ範囲で断るので、
 * 数を 2 か所に書かないよう**上限の意味もそちらの注釈に合わせる**
 * (180 度以上は裏返るだけで新しい平面にならない)。
 */
const TILT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 180,
  maxInclusive: false,
};

/* ---- P5 タスク49: Should / Could 群の範囲(§2.15、model の定数と同じ数を 2 か所に書かない) ---- */

/**
 * 押し出しの側面の傾き(度、FR-401)。0 以上 `MAX_TAPER_ANGLE_DEGREES` 以下。
 * 0 は「傾けない」で、P2 からの押し出しとまったく同じ形になる(model の注釈どおり)。
 */
const TAPER_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: MAX_TAPER_ANGLE_DEGREES,
  maxInclusive: true,
};

/**
 * 抜き勾配の角度(度、FR-417)。0 より大きく `MAX_DRAFT_ANGLE_DEGREES` 以下
 * (model の `DraftFeature.angle` の注釈と同じ向き。0 は「傾けない」= 何もしないので許さない)。
 */
const DRAFT_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: MAX_DRAFT_ANGLE_DEGREES,
  maxInclusive: true,
};

/** 拡大縮小の倍率(FR-424)。model の `MIN_SCALE` 以上 `MAX_SCALE` 以下。 */
const SCALE_RANGE: NumericFieldRange = {
  min: MIN_SCALE,
  minInclusive: true,
  max: MAX_SCALE,
  maxInclusive: true,
};

/**
 * 皿もみの開き角(度、FR-422)。0 より大きく 180 より小さい。
 * 180 度は平らになって「広げない」と同じ形、0 度は円錐が閉じないので、どちらも許さない。
 */
const COUNTERSINK_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 180,
  maxInclusive: false,
};

/* ---- P5 タスク49: 欄の出し分け(`visibleWhen`)の定型 ---- */

/**
 * 選択肢が並べた値のどれかのときだけ欄を出す。
 * 選択肢そのものが無い段(値が undefined)では出さない——欄の意味を決める材料が
 * 無いまま数を聞くことになるため。
 */
function whenChoiceIs(
  key: NumericChoiceKey,
  ...values: readonly string[]
): (visibility: NumericFieldVisibility) => boolean {
  return (visibility) => {
    const current = choiceValueFrom(visibility.choices, key);
    return current !== undefined && values.includes(current);
  };
}

/** つまみが入のときだけ欄を出す。持たないつまみは切として扱う(既定はすべて切)。 */
function whenToggleOn(
  key: NumericToggleKey,
): (visibility: NumericFieldVisibility) => boolean {
  return (visibility) => visibility.toggles.find((toggle) => toggle.key === key)?.value === true;
}

/** つまみが切のときだけ欄を出す。`whenToggleOn` の裏返し。 */
function whenToggleOff(
  key: NumericToggleKey,
): (visibility: NumericFieldVisibility) => boolean {
  return (visibility) => visibility.toggles.find((toggle) => toggle.key === key)?.value !== true;
}

/**
 * 押し出しの欄(FR-401、FR-415、FR-416)。
 *
 * **タスク50 で終わり方・側面の傾き・薄板の厚みをここへ畳んだ**(統括の決定 2026-09-06)。
 * 利用者から見て「押し出し」は 1 つの道具で、終わり方や板にするかは同じ操作の中の選び方
 * だからである(計画書 §2.15 の本来の形)。
 *
 * **段を開いた直後に出る欄は距離 1 つだけ**で、P2 からの押し出しと 1 つも変わらない。
 * 傾きは「側面を傾ける」、厚みは「薄板にする」を入にしたときだけ出て、距離は終わり方が
 * 「距離」のときだけ出る(「選んだ面まで」「次の面まで」では長さを決めるのが面だから)。
 */
const EXTRUDE_DISTANCE_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'distance',
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.extrudeDistance',
    unit: 'mm',
    defaultSource: '10',
    range: POSITIVE,
    visibleWhen: whenChoiceIs('extrudeEnd', 'distance'),
  },
  {
    key: 'taperAngle',
    labelKey: 'numericInput.field.taperAngle',
    tooltipKey: 'numericInput.tooltip.taperAngle',
    unit: 'degree',
    defaultSource: String(DEFAULT_TAPER_ANGLE_DEGREES),
    range: TAPER_ANGLE_RANGE,
    visibleWhen: whenToggleOn('tapered'),
  },
  {
    key: 'thickness',
    labelKey: 'numericInput.field.thickness',
    tooltipKey: 'numericInput.tooltip.extrudeThickness',
    unit: 'mm',
    defaultSource: String(DEFAULT_EXTRUDE_THICKNESS_MM),
    range: POSITIVE,
    visibleWhen: whenToggleOn('thinWalled'),
  },
];

const REVOLVE_ANGLE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.angle', tooltipKey: 'numericInput.tooltip.angle', unit: 'degree', defaultSource: '360', range: ANGLE_UP_TO_360 },
];

const SEW_TOLERANCE_FIELDS: readonly NumericFieldDefinition[] = [
  // 既定は model の DEFAULT_SEW_TOLERANCE_MM と同じ 0.01(§0.a-0.7)。
  { key: 'tolerance', labelKey: 'numericInput.field.tolerance', tooltipKey: 'numericInput.tooltip.tolerance', unit: 'mm', defaultSource: '0.01', range: POSITIVE },
];

/**
 * 穴の欄(FR-405、FR-422)。
 *
 * **タスク50 で入口の広げ方(ざぐり・皿もみ)をここへ畳んだ**(統括の決定 2026-09-06)。
 * 利用者から見て「穴の形が違うだけ」で、選ぶもの(面と点)も向きも同じだからである
 * (model が `HoleFeature.entry` の 1 欄で持っているのと同じ理屈、§0.a-0.39)。
 *
 * **段を開いた直後に出る欄は直径と深さの 2 つだけ**(入口の既定は「広げない」)。
 */
const HOLE_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'diameter', labelKey: 'numericInput.field.diameter', tooltipKey: 'numericInput.tooltip.diameter', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DIAMETER_MM), range: POSITIVE },
  { key: 'depth', labelKey: 'numericInput.field.depth', tooltipKey: 'numericInput.tooltip.depth', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
  { key: 'counterboreDiameter', labelKey: 'numericInput.field.counterboreDiameter', tooltipKey: 'numericInput.tooltip.counterboreDiameter', unit: 'mm', defaultSource: String(DEFAULT_COUNTERBORE_DIAMETER_MM), range: POSITIVE, visibleWhen: whenChoiceIs('holeEntry', 'counterbore') },
  { key: 'counterboreDepth', labelKey: 'numericInput.field.counterboreDepth', tooltipKey: 'numericInput.tooltip.counterboreDepth', unit: 'mm', defaultSource: String(DEFAULT_COUNTERBORE_DEPTH_MM), range: POSITIVE, visibleWhen: whenChoiceIs('holeEntry', 'counterbore') },
  { key: 'countersinkDiameter', labelKey: 'numericInput.field.countersinkDiameter', tooltipKey: 'numericInput.tooltip.countersinkDiameter', unit: 'mm', defaultSource: String(DEFAULT_COUNTERSINK_DIAMETER_MM), range: POSITIVE, visibleWhen: whenChoiceIs('holeEntry', 'countersink') },
  { key: 'countersinkAngle', labelKey: 'numericInput.field.countersinkAngle', tooltipKey: 'numericInput.tooltip.countersinkAngle', unit: 'degree', defaultSource: String(DEFAULT_COUNTERSINK_ANGLE_DEGREES), range: COUNTERSINK_ANGLE_RANGE, visibleWhen: whenChoiceIs('holeEntry', 'countersink') },
];

const THREAD_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'depth', labelKey: 'numericInput.field.depth', tooltipKey: 'numericInput.tooltip.depth', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
  // ねじ部の長さの既定値専用の model 定数は無いため、穴の深さの既定(10)と揃える
  // (計画書タスク24 §2.11 の表がどちらも既定 10 としているのに合わせた)。
  { key: 'threadLength', labelKey: 'numericInput.field.threadLength', tooltipKey: 'numericInput.tooltip.threadLength', unit: 'mm', defaultSource: String(DEFAULT_HOLE_DEPTH_MM), range: POSITIVE },
];

/**
 * R 面取りの欄(FR-407、FR-426)。
 *
 * **タスク50 で可変半径をここへ畳んだ**(統括の決定 2026-09-06)。model が
 * `FilletFeature.radiusEnd` の省略できる 1 欄で持っている(§0.a-0.48)のと同じ理屈で、
 * 利用者から見ても「角を丸める」道具は 1 つである。
 *
 * **段を開いた直後に出る欄は半径 1 つだけ**(つまみ「終わりを別の半径に」は既定で切)。
 */
const FILLET_RADIUS_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.filletRadius', unit: 'mm', defaultSource: String(DEFAULT_FILLET_RADIUS_MM), range: POSITIVE },
  {
    key: 'filletRadiusEnd',
    labelKey: 'numericInput.field.radiusEnd',
    tooltipKey: 'numericInput.tooltip.filletRadiusEnd',
    unit: 'mm',
    defaultSource: String(DEFAULT_FILLET_RADIUS_END_MM),
    range: POSITIVE,
    visibleWhen: whenToggleOn('variableRadius'),
  },
];

const CHAMFER_DISTANCE_FIELD: NumericFieldDefinition = {
  key: 'chamferDistance',
  labelKey: 'numericInput.field.chamferDistance',
  tooltipKey: 'numericInput.tooltip.chamferDistance',
  unit: 'mm',
  defaultSource: String(DEFAULT_CHAMFER_DISTANCE_MM),
  range: POSITIVE,
};
const CHAMFER_DISTANCE2_FIELD: NumericFieldDefinition = {
  key: 'chamferDistance2',
  labelKey: 'numericInput.field.chamferDistance2',
  tooltipKey: 'numericInput.tooltip.chamferDistance2',
  unit: 'mm',
  defaultSource: String(DEFAULT_CHAMFER_DISTANCE_MM),
  range: POSITIVE,
  // 「2つの距離」のときだけ出す。等距離では 2 つ目を聞かない(P3 の残件、下の注釈)。
  visibleWhen: whenChoiceIs('chamferMode', 'twoDistances'),
};
const CHAMFER_ANGLE_FIELD: NumericFieldDefinition = {
  key: 'chamferAngle',
  labelKey: 'numericInput.field.chamferAngle',
  tooltipKey: 'numericInput.tooltip.chamferAngle',
  unit: 'degree',
  defaultSource: String(DEFAULT_CHAMFER_ANGLE_DEGREES),
  range: CHAMFER_ANGLE_RANGE,
  visibleWhen: whenChoiceIs('chamferMode', 'distanceAngle'),
};

/**
 * C面取りの欄は「決め方」で変わる(計画書タスク24「C面取りは『決め方』で出る欄が変わる」)。
 * 2距離は距離・距離2、距離+角度は距離・角度、等距離は距離だけの1欄になる。
 *
 * タスク24 の実装では等距離でも距離2 の欄を出していた(見た目を2距離と共通にし、
 * machiningCommands.ts の commitChamfer 側で読み捨てる想定)。しかし利用者が
 * 「等距離」を選んだのに2つ目の距離を聞かれるのは分かりにくいため(NFR-UX-2)、
 * 統括の判断で等距離のときは距離2 の欄を出さないよう改めた。ChamferSize の
 * 'equal' が本来 distance 1つしか持たないことにも合う(model のChamferSize定義どおり)。
 *
 * **P5 タスク49 で `visibleWhen` へ寄せた。** 欄の出し分けを段ごとの専用関数で書いていると
 * 新しい段のたびに同じ形の関数が増える(P3 の残件が長く残った理由でもある)ので、
 * 出し分けの条件を欄の定義そのものへ置き、**表の並びから読める**ようにした。
 * 出る欄と並びは以前とまったく同じ(等距離=距離、2距離=距離・距離2、距離と角度=距離・角度)。
 */
const CHAMFER_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  CHAMFER_DISTANCE_FIELD,
  CHAMFER_DISTANCE2_FIELD,
  CHAMFER_ANGLE_FIELD,
];

const LINEAR_PATTERN_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'spacing', labelKey: 'numericInput.field.spacing', tooltipKey: 'numericInput.tooltip.patternSpacing', unit: 'mm', defaultSource: String(DEFAULT_PATTERN_SPACING_MM), range: POSITIVE },
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.patternCount', unit: 'count', defaultSource: String(DEFAULT_PATTERN_COUNT), range: PATTERN_COUNT_RANGE },
];

const CIRCULAR_PATTERN_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.patternAngle', tooltipKey: 'numericInput.tooltip.patternAngle', unit: 'degree', defaultSource: '360', range: ANGLE_UP_TO_360 },
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.patternCount', unit: 'count', defaultSource: String(DEFAULT_CIRCULAR_PATTERN_COUNT), range: PATTERN_COUNT_RANGE },
];

const SPRING_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'coilDiameter', labelKey: 'numericInput.field.coilDiameter', tooltipKey: 'numericInput.tooltip.coilDiameter', unit: 'mm', defaultSource: String(DEFAULT_SPRING_COIL_DIAMETER_MM), range: POSITIVE },
  { key: 'wireDiameter', labelKey: 'numericInput.field.wireDiameter', tooltipKey: 'numericInput.tooltip.wireDiameter', unit: 'mm', defaultSource: String(DEFAULT_SPRING_WIRE_DIAMETER_MM), range: POSITIVE },
];

const SPRING_PITCH_FIELD: NumericFieldDefinition = {
  key: 'springPitch',
  labelKey: 'numericInput.field.springPitch',
  tooltipKey: 'numericInput.tooltip.springPitch',
  unit: 'mm',
  defaultSource: String(DEFAULT_SPRING_PITCH_MM),
  range: POSITIVE,
};
/**
 * 巻数は 3.5 巻きのように整数でなくてよい(model の SpringFeature.turns の注釈)。
 * 単位札は mm / degree / count の3つしか無く(ja.json を増やせないため、§4「ja.json は
 * 触らない」)、「巻」に当たる単位が無いので count(「個」)を流用する。表示上の妥協点として
 * 報告する。
 */
const SPRING_TURNS_FIELD: NumericFieldDefinition = {
  key: 'springTurns',
  labelKey: 'numericInput.field.springTurns',
  tooltipKey: 'numericInput.tooltip.springTurns',
  unit: 'count',
  defaultSource: String(DEFAULT_SPRING_TURNS),
  range: SPRING_TURNS_RANGE,
};
/** 既定の全長はピッチ×巻数(model の DEFAULT_SPRING_PITCH_MM × DEFAULT_SPRING_TURNS = 20mm)。 */
const SPRING_LENGTH_FIELD: NumericFieldDefinition = {
  key: 'springLength',
  labelKey: 'numericInput.field.springLength',
  tooltipKey: 'numericInput.tooltip.springLength',
  unit: 'mm',
  defaultSource: String(DEFAULT_SPRING_PITCH_MM * DEFAULT_SPRING_TURNS),
  range: POSITIVE,
};

const SPRING_LENGTH_FIELD_DEFS: readonly NumericFieldDefinition[] = [
  SPRING_PITCH_FIELD,
  SPRING_TURNS_FIELD,
  SPRING_LENGTH_FIELD,
];

/**
 * 求める値(derived)が指す欄は出さない(§0.a-0.30。読み取り専用の欄をポップアップに
 * 置かないため、NFR-UX-4)。既定・未知の値は 'length' と同じ扱いにする(安全側)。
 */
function springLengthFieldDefinitions(derived: string | undefined): readonly NumericFieldDefinition[] {
  const excludedKey = derived === 'pitch' ? 'springPitch' : derived === 'turns' ? 'springTurns' : 'springLength';
  return SPRING_LENGTH_FIELD_DEFS.filter((definition) => definition.key !== excludedKey);
}

/* ---- P5 タスク18: 基本形状5種の欄(FR-429、§2.7.1・§2.15) ---- */

/*
  既定値はすべて model の定数(`createPartDocument.ts`)から引く。**同じ数を2か所に書かない**
  ため(段の既定と `defaultPrimitiveShape` がずれると、その場入力で作った形とプロパティの
  既定が食い違う)。範囲も model の `resolvePrimitiveShape` / kernel の `checkShapeSpec` と
  同じ向きで見る(欄1つで言える「0 より大きい」だけをここに置き、欄をまたぐ条件は確定側)。
*/

/** 球の半径(mm)。中心は選んでいるものから決まるので欄に出さない(§0.a-0.18)。 */
const SPHERE_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'sphereRadius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.sphereRadius', unit: 'mm', defaultSource: String(DEFAULT_SPHERE_RADIUS_MM), range: POSITIVE },
];

/** 箱の X / Y / Z の長さ(mm)。**欄3つの段**(§2.15)。基準点は中心(§0.a-0.17)。 */
const BOX_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'boxSizeX', labelKey: 'numericInput.field.boxSizeX', tooltipKey: 'numericInput.tooltip.boxSizeX', unit: 'mm', defaultSource: String(DEFAULT_BOX_SIZE_MM), range: POSITIVE },
  { key: 'boxSizeY', labelKey: 'numericInput.field.boxSizeY', tooltipKey: 'numericInput.tooltip.boxSizeY', unit: 'mm', defaultSource: String(DEFAULT_BOX_SIZE_MM), range: POSITIVE },
  { key: 'boxSizeZ', labelKey: 'numericInput.field.boxSizeZ', tooltipKey: 'numericInput.tooltip.boxSizeZ', unit: 'mm', defaultSource: String(DEFAULT_BOX_SIZE_MM), range: POSITIVE },
];

/** 円柱の半径と高さ(mm)。基準点は**底面の中心**(§0.a-0.17)。 */
const CYLINDER_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'cylinderRadius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.cylinderRadius', unit: 'mm', defaultSource: String(DEFAULT_CYLINDER_RADIUS_MM), range: POSITIVE },
  { key: 'cylinderHeight', labelKey: 'numericInput.field.height', tooltipKey: 'numericInput.tooltip.cylinderHeight', unit: 'mm', defaultSource: String(DEFAULT_CYLINDER_HEIGHT_MM), range: POSITIVE },
];

/**
 * 円錐の下半径・上半径・高さ(mm)。**欄3つの段**(§2.15)。
 * 上半径だけ 0 を許す(0 なら尖った円錐、0 より大きければ円錐台。§0.a-0.16)。
 */
const CONE_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'coneBottomRadius', labelKey: 'numericInput.field.bottomRadius', tooltipKey: 'numericInput.tooltip.coneBottomRadius', unit: 'mm', defaultSource: String(DEFAULT_CONE_BOTTOM_RADIUS_MM), range: NON_NEGATIVE },
  { key: 'coneTopRadius', labelKey: 'numericInput.field.topRadius', tooltipKey: 'numericInput.tooltip.coneTopRadius', unit: 'mm', defaultSource: String(DEFAULT_CONE_TOP_RADIUS_MM), range: NON_NEGATIVE },
  { key: 'coneHeight', labelKey: 'numericInput.field.height', tooltipKey: 'numericInput.tooltip.coneHeight', unit: 'mm', defaultSource: String(DEFAULT_CONE_HEIGHT_MM), range: POSITIVE },
];

/**
 * トーラスの主半径と管の半径(mm)。「管の半径 < 主半径」は欄をまたぐ条件なので
 * `NumericFieldRange` では表せない。確定のとき(`primitiveShapeRejection`)に断る。
 */
const TORUS_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'torusMajorRadius', labelKey: 'numericInput.field.torusMajorRadius', tooltipKey: 'numericInput.tooltip.torusMajorRadius', unit: 'mm', defaultSource: String(DEFAULT_TORUS_MAJOR_RADIUS_MM), range: POSITIVE },
  { key: 'torusMinorRadius', labelKey: 'numericInput.field.torusMinorRadius', tooltipKey: 'numericInput.tooltip.torusMinorRadius', unit: 'mm', defaultSource: String(DEFAULT_TORUS_MINOR_RADIUS_MM), range: POSITIVE },
];

/**
 * 緯度の範囲(度)。**両端を含む**(±90 は極そのもので、正しい点になる)。
 * 極を越えると裏側へ回り込んで利用者の意図と一致しないので、model の
 * `resolvePointReference` も同じ範囲で断る(`LATITUDE_RANGE_MESSAGE`)。
 * 同じ条件を欄の側でも見て、**決める前に赤くする**(NFR-UX-5)。
 */
const LATITUDE_RANGE: NumericFieldRange = { min: -90, minInclusive: true, max: 90, maxInclusive: true };

/**
 * 球面上の点の緯度・経度(FR-431、タスク22)。**欄 2 つの段**(§2.15 の表)。
 *
 * 経度は範囲を持たない。360 度回れば同じ点に戻るので、`450` と書いても `90` と同じ点になる
 * (model の `sphereGridPosition` が剰余を取らずそのまま三角関数へ渡す)。
 * 既定はどちらも 0(赤道の +X 側)で、空欄のまま Enter を押してもそこに点ができる
 * (NFR-UX-4)。
 */
const SPHERE_GRID_POINT_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'latitude', labelKey: 'numericInput.field.latitude', tooltipKey: 'numericInput.tooltip.latitude', unit: 'degree', defaultSource: '0', range: LATITUDE_RANGE },
  { key: 'longitude', labelKey: 'numericInput.field.longitude', tooltipKey: 'numericInput.tooltip.longitude', unit: 'degree', defaultSource: '0' },
];

/* ---- P5 タスク27: 面をつなぐ・ロフトの欄(FR-430、FR-410、§2.15) ---- */

/**
 * ねじれの補正(§0.a-0.28)。**2 つ目の輪郭の始点を何頂点ぶん回すか**で、既定は 0。
 *
 * 範囲を持たない。負の数は「逆向きに回す」意味で正しく、上限も輪郭の頂点数で決まる
 * (カーネルが頂点数で割った余りを使う)ためである。**整数であること**は
 * `NumericFieldRange`(上下限しか表せない)では言えないので、確定のとき
 * (`ruledTwistRejection`)に断る。正多角形の辺数・パターンの個数と同じ切り分け。
 *
 * 既定値は model の定数(`DEFAULT_RULED_TWIST`)から引く。同じ数を 2 か所に書かないため。
 */
const RULED_TWIST_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'ruledTwist',
    labelKey: 'numericInput.field.ruledTwist',
    tooltipKey: 'numericInput.tooltip.ruledTwist',
    unit: 'count',
    defaultSource: String(DEFAULT_RULED_TWIST),
  },
];

/* ---- P5 タスク49: Should / Could 群の欄(§2.15 の段の表) ---- */

/*
  既定値はすべて model の定数(`createPartDocument.ts`、タスク43・46・27c が置いた)から
  引く。**同じ数を 2 か所に書かない**ため(段の既定とフィーチャーの既定がずれると、
  その場で作った形とプロパティの既定が食い違う)。範囲も model の解決と同じ向きで見て、
  「欄 1 つで言えること」だけをここに置く(欄をまたぐ条件は確定側の断り)。
*/

/** 抜き勾配の角度(FR-417)。抜く向きはつまみ「向きを反転」で直す(§2.15 の段の表)。 */
const DRAFT_ANGLE_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'draftAngle',
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.draftAngle',
    unit: 'degree',
    defaultSource: String(DEFAULT_DRAFT_ANGLE_DEGREES),
    range: DRAFT_ANGLE_RANGE,
  },
];

/**
 * 移動/回転の 1 段目(FR-424)。X / Y / Z へ動かす量の**欄 3 つ**(§2.15「3 つまでは
 * 1 行に収まる」。箱・円錐と同じ)。回す角度と軸は 2 段目(`transformRotation`)。
 * 範囲を持たないのは、負の値(逆向きへ動かす)も 0(動かさない)も正しいため。
 */
const TRANSFORM_TRANSLATION_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'translationX', labelKey: 'numericInput.field.x', tooltipKey: 'numericInput.tooltip.translationX', unit: 'mm', defaultSource: String(DEFAULT_TRANSLATION_MM) },
  { key: 'translationY', labelKey: 'numericInput.field.y', tooltipKey: 'numericInput.tooltip.translationY', unit: 'mm', defaultSource: String(DEFAULT_TRANSLATION_MM) },
  { key: 'translationZ', labelKey: 'numericInput.field.z', tooltipKey: 'numericInput.tooltip.translationZ', unit: 'mm', defaultSource: String(DEFAULT_TRANSLATION_MM) },
];

/** 移動/回転の 2 段目(FR-424)。0 なら回さず動かすだけ(model の既定と同じ)。 */
const TRANSFORM_ROTATION_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'rotationAngle',
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.transformRotation',
    unit: 'degree',
    defaultSource: String(DEFAULT_TRANSFORM_ROTATION_DEGREES),
  },
];

/**
 * 拡大縮小の倍率(FR-424)。**つまみ「軸ごと」で欄が 1 つ ↔ 3 つに入れ替わる**
 * (§2.15。`visibleWhen` の主な使いどころ)。倍率に当たる単位札は無い(mm / 度 / 個の
 * 3 つしかない)ので、ばねの巻数と同じく「個」を流用する。表示上の妥協点として報告する。
 */
const SCALE_AMOUNT_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'scaleFactor',
    labelKey: 'numericInput.field.scaleFactor',
    tooltipKey: 'numericInput.tooltip.scaleFactor',
    unit: 'count',
    defaultSource: String(DEFAULT_SCALE_FACTOR),
    range: SCALE_RANGE,
    visibleWhen: whenToggleOff('scalePerAxis'),
  },
  { key: 'scaleX', labelKey: 'numericInput.field.scaleX', tooltipKey: 'numericInput.tooltip.scaleX', unit: 'count', defaultSource: String(DEFAULT_SCALE_FACTOR), range: SCALE_RANGE, visibleWhen: whenToggleOn('scalePerAxis') },
  { key: 'scaleY', labelKey: 'numericInput.field.scaleY', tooltipKey: 'numericInput.tooltip.scaleY', unit: 'count', defaultSource: String(DEFAULT_SCALE_FACTOR), range: SCALE_RANGE, visibleWhen: whenToggleOn('scalePerAxis') },
  { key: 'scaleZ', labelKey: 'numericInput.field.scaleZ', tooltipKey: 'numericInput.tooltip.scaleZ', unit: 'count', defaultSource: String(DEFAULT_SCALE_FACTOR), range: SCALE_RANGE, visibleWhen: whenToggleOn('scalePerAxis') },
];

/** リブの厚み(FR-420)。付ける側は選択肢(`ribSide`)。**向きのつまみは付けない**(タスク46)。 */
const RIB_THICKNESS_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'ribThickness',
    labelKey: 'numericInput.field.thickness',
    tooltipKey: 'numericInput.tooltip.ribThickness',
    unit: 'mm',
    defaultSource: String(DEFAULT_RIB_THICKNESS_MM),
    range: POSITIVE,
  },
];

/** エンボスの高さ(FR-421)。彫るときはそのぶんの深さになる(つまみ「浮き出す」で切り替え)。 */
const EMBOSS_HEIGHT_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'embossHeight',
    labelKey: 'numericInput.field.height',
    tooltipKey: 'numericInput.tooltip.embossHeight',
    unit: 'mm',
    defaultSource: String(DEFAULT_EMBOSS_HEIGHT_MM),
    range: POSITIVE,
  },
];

/**
 * 外ねじのピッチと長さ(FR-423)。**軸の径は面から測る**ので欄に出さない(NFR-UX-4)。
 * ピッチの既定は規格表(model の `metricThreadPitch`)から引く。同じ数を 2 か所に書かない。
 */
const DEFAULT_THREAD_SHAFT_SIZE = findMetricThread(DEFAULT_THREAD_DESIGNATION);
/** 規格表に既定の呼びが無いときだけ使う値(mm)。M6 並目のピッチと同じ。 */
const FALLBACK_THREAD_PITCH_MM = 1;
const DEFAULT_THREAD_SHAFT_PITCH_MM =
  DEFAULT_THREAD_SHAFT_SIZE === undefined
    ? FALLBACK_THREAD_PITCH_MM
    : metricThreadPitch(DEFAULT_THREAD_SHAFT_SIZE, 'coarse');

const THREAD_SHAFT_SIZE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'threadShaftPitch', labelKey: 'numericInput.field.pitch', tooltipKey: 'numericInput.tooltip.threadShaftPitch', unit: 'mm', defaultSource: String(DEFAULT_THREAD_SHAFT_PITCH_MM), range: POSITIVE },
  { key: 'threadShaftLength', labelKey: 'numericInput.field.length', tooltipKey: 'numericInput.tooltip.threadShaftLength', unit: 'mm', defaultSource: String(DEFAULT_THREAD_SHAFT_LENGTH_MM), range: POSITIVE },
];

/**
 * 曲面の作り方ごとの欄(FR-428)。選んだ作り方で入れ替わる。
 * 「平らに張る」「立体の面を写す」「つなぐ」は数を聞かないので欄が 0 個になる。
 * 回す軸は選んでいるものと選択肢から確定側(タスク50)が決める(ばねの傾き角と同じ扱い)。
 */
const SURFACE_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'surfaceDistance', labelKey: 'numericInput.field.distance', tooltipKey: 'numericInput.tooltip.surfaceDistance', unit: 'mm', defaultSource: String(DEFAULT_SURFACE_DISTANCE_MM), range: POSITIVE, visibleWhen: whenChoiceIs('surfaceOperation', 'extrude') },
  { key: 'surfaceAngle', labelKey: 'numericInput.field.angle', tooltipKey: 'numericInput.tooltip.surfaceAngle', unit: 'degree', defaultSource: String(DEFAULT_SURFACE_ANGLE_DEGREES), range: ANGLE_UP_TO_360, visibleWhen: whenChoiceIs('surfaceOperation', 'revolve') },
  // 離す距離は負でもよい(反対側へ離れる)ので範囲を持たない。0 は解決が断る(§2.11)。
  { key: 'surfaceOffset', labelKey: 'numericInput.field.surfaceOffset', tooltipKey: 'numericInput.tooltip.surfaceOffset', unit: 'mm', defaultSource: String(DEFAULT_SURFACE_OFFSET_MM), visibleWhen: whenChoiceIs('surfaceOperation', 'offset') },
];

/** くり抜きの壁の厚さ(FR-418)。開ける面は選択で決まるので欄に出さない。 */
const SHELL_THICKNESS_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'shellThickness',
    labelKey: 'numericInput.field.wallThickness',
    tooltipKey: 'numericInput.tooltip.wallThickness',
    unit: 'mm',
    defaultSource: String(DEFAULT_SHELL_THICKNESS_MM),
    range: POSITIVE,
  },
];

/**
 * 切断面の傾き(FR-432)。**「点と軸」で決めるときだけ**出す(§0.a-0.57 の段の表)。
 * 範囲は基準ジオメトリの傾け(`TILT_RANGE`)と同じ——同じ `PlaneSpec` を組み立てるので、
 * 受け付ける範囲が道具によって違ってはならない(NFR-UX-1)。
 */
const CUT_PLANE_FIELDS: readonly NumericFieldDefinition[] = [
  {
    key: 'cutTilt',
    labelKey: 'numericInput.field.planeTilt',
    tooltipKey: 'numericInput.tooltip.cutTilt',
    unit: 'degree',
    defaultSource: '0',
    range: TILT_RANGE,
    visibleWhen: whenChoiceIs('cutPlaneKind', 'pointAndAxis'),
  },
];

/* ---- P4 タスク11: 新しい図形の欄(FR-314〜318、FR-326、FR-327) ---- */

/** 正多角形の既定の辺数(FR-315。六角形が最もよく使われる)。 */
export const DEFAULT_POLYGON_SIDES = 6;

/**
 * 格子状の点列の行・列の向き(度、FR-327)。統括の指示で、格子の段は「間隔と個数」だけを
 * 聞いて欄を 1 段 2 個までに収める。向きは作図面の第1軸(行)とそれに直交する向き(列)へ
 * 固定し、傾けたいときはプロパティ(タスク33)で `rowAzimuth` / `colAzimuth` を直す。
 * model の `resolveGridPointArray` は 0 度を作図面の第1軸、90 度を第2軸として解決する。
 */
export const DEFAULT_GRID_ROW_AZIMUTH_DEGREES = 0;
export const DEFAULT_GRID_COLUMN_AZIMUTH_DEGREES = 90;

/** 円の半径(FR-326)。中心は前の段(circleCenter)で座標として聞く。 */
const CIRCLE_RADIUS_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.circleRadius', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

/**
 * 2 点+半径の円弧の半径(FR-326)。2 点の間の長さの半分より大きくないと中心が求まらないが、
 * その判定は 2 点が決まってからでないとできないので、ここでは「0 より大きい」だけを見る
 * (2 点との突き合わせは `twoPointArcRadiusRejection`)。
 */
const TWO_POINT_ARC_RADIUS_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.twoPointArcRadius', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

/** 正多角形の辺数と半径(FR-315)。半径の意味は選択肢 polygonRadiusMode で切り替える。 */
const POLYGON_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'sides', labelKey: 'numericInput.field.sides', tooltipKey: 'numericInput.tooltip.sides', unit: 'count', defaultSource: String(DEFAULT_POLYGON_SIDES), range: POLYGON_SIDES_RANGE },
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.polygonRadius', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

/** 長穴の幅(FR-316)。2 つの中心は前の 2 段で聞く。 */
const SLOT_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'width', labelKey: 'numericInput.field.width', tooltipKey: 'numericInput.tooltip.slotWidth', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

/**
 * 楕円の長半径・短軸半径(FR-318)。長半径 ≥ 短半径 の突き合わせは欄をまたぐので
 * `NumericFieldRange` では表せない。model の解決が「長軸の半径は短軸の半径より
 * 大きくしてください。」で断る(resolveSketch.ts)。
 */
const ELLIPSE_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'majorRadius', labelKey: 'numericInput.field.majorRadius', tooltipKey: 'numericInput.tooltip.majorRadius', unit: 'mm', defaultSource: '20', range: POSITIVE },
  { key: 'minorRadius', labelKey: 'numericInput.field.minorRadius', tooltipKey: 'numericInput.tooltip.minorRadius', unit: 'mm', defaultSource: '10', range: POSITIVE },
];

/** 楕円の傾き(FR-318)。負の角度も向きとして意味を持つので範囲は付けない(円弧の角度と同じ)。 */
const ELLIPSE_ANGLE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'rotation', labelKey: 'numericInput.field.rotation', tooltipKey: 'numericInput.tooltip.rotation', unit: 'degree', defaultSource: '0' },
];

/**
 * 楕円弧の開始角・終了角(FR-318)。長軸から測った方位角(度)で、model が保存するのも方位角
 * (タスク5 の申し送り)。既定は 0 と 360 で、そのまま Enter を押せば全周と同じ形になる。
 */
const ELLIPSE_ARC_ANGLE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'startAngle', labelKey: 'numericInput.field.startAngle', tooltipKey: 'numericInput.tooltip.ellipseStartAngle', unit: 'degree', defaultSource: '0' },
  { key: 'endAngle', labelKey: 'numericInput.field.endAngle', tooltipKey: 'numericInput.tooltip.ellipseEndAngle', unit: 'degree', defaultSource: '360' },
];

/**
 * 円周上の点列(FR-327)。開始角は作図面の第1軸に固定(model の PointArrayLayout どおり)。
 *
 * 個数の欄の名前を直線の `count` と分けて `circularCount` にしてある。同じ名前だと
 * `mergeFieldValues` が直線の値をそのまま引き継いでしまい(欄の並びが変わっても同じ名前の
 * 欄は値を保つ規則)、円周の既定値が画面に一度も出ないため。行・列の `rowCount` /
 * `colCount` と同じ考え方で、並べ方ごとに自分の既定値から始まるようにする(NFR-UX-4)。
 */
const POINT_ARRAY_CIRCULAR_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'radius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.pointArrayRadius', unit: 'mm', defaultSource: '10', range: POSITIVE },
  { key: 'circularCount', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.count', unit: 'count', defaultSource: '6', range: POINT_ARRAY_COUNT_RANGE },
];

/** 格子状の点列の 1 段目(行の間隔・行数、FR-327)。 */
const POINT_ARRAY_GRID_ROW_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'rowSpacing', labelKey: 'numericInput.field.rowSpacing', tooltipKey: 'numericInput.tooltip.rowSpacing', unit: 'mm', defaultSource: '10', range: POSITIVE },
  { key: 'rowCount', labelKey: 'numericInput.field.rowCount', tooltipKey: 'numericInput.tooltip.rowCount', unit: 'count', defaultSource: '3', range: POINT_ARRAY_COUNT_RANGE },
];

/** 格子状の点列の 2 段目(列の間隔・列数、FR-327)。 */
const POINT_ARRAY_GRID_COLUMN_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'colSpacing', labelKey: 'numericInput.field.colSpacing', tooltipKey: 'numericInput.tooltip.colSpacing', unit: 'mm', defaultSource: '10', range: POSITIVE },
  { key: 'colCount', labelKey: 'numericInput.field.colCount', tooltipKey: 'numericInput.tooltip.colCount', unit: 'count', defaultSource: '3', range: POINT_ARRAY_COUNT_RANGE },
];

/** 欄を持たない段(スプラインの決め方)。選択肢とつまみだけで決める。 */
const NO_FIELDS: readonly NumericFieldDefinition[] = [];

/* ---- P4 タスク21: 編集(オフセット、FR-321) ---- */

/** オフセットの距離(mm)。既定 5mm(NFR-UX-4)。側は選択肢(offsetSide)で決める。 */
const OFFSET_DISTANCE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'distance', labelKey: 'numericInput.field.offsetDistance', tooltipKey: 'numericInput.tooltip.offsetDistance', unit: 'mm', defaultSource: '5', range: POSITIVE },
];

/* ---- P4 タスク24: 複製系(ミラー・複写・配列複写、FR-324) ---- */

/**
 * 複製系の既定値(NFR-UX-4「Enter 連打だけでも意味のある結果になる」)。
 *
 * 欄の既定と `copyCommands.ts` の「欄が渡されなかったときの値」を**同じ数**にするため、
 * 段の側(このファイル)へ置いて `copyCommands.ts` から引く。逆向き(コマンド側に置く)に
 * すると、段の表がコマンドを輸入することになって輸入の向きが往復するため。
 */
/** 複写の既定の移動量(mm)。作図面の第1軸へ 20mm、図形の隣に並ぶ大きさ。 */
export const DEFAULT_COPY_DELTA_MM = 20;
/** 配列複写の既定の間隔(mm)。複写の既定と同じにして、道具を変えても勘が働くようにする。 */
export const DEFAULT_ARRAY_SPACING_MM = 20;
/** 直線配列の既定の個数(もとを含めた総数、統括の指示)。 */
export const DEFAULT_LINEAR_ARRAY_COUNT = 3;
/** 円形配列の既定の個数(もとを含めた総数、統括の指示)。 */
export const DEFAULT_CIRCULAR_ARRAY_COUNT = 4;
/** 円形配列の既定の角度(度)。既定は「全周」が入なので、切にしたときの出発点。 */
export const DEFAULT_ARRAY_ANGLE_DEGREES = 360;
/** 直線配列の既定の向き(度)。作図面の第1軸から測る角度で、0 は第1軸そのもの。 */
export const DEFAULT_ARRAY_DIRECTION_DEGREES = 0;

/**
 * 並べる個数(もとを含めた総数)の範囲。model の `MIN_COPY_COUNT` / `MAX_COPY_COUNT` を
 * そのまま使うので、上限・下限が 2 か所に分かれない。整数かどうかは欄では見ない
 * (`NumericFieldRange` は上下限しか表せない。判定は `copyCountRejection` と model)。
 */
const COPY_COUNT_RANGE: NumericFieldRange = {
  min: MIN_COPY_COUNT,
  minInclusive: true,
  max: MAX_COPY_COUNT,
  maxInclusive: true,
};

/**
 * 複写の移動量(mm、FR-324)。**作図面の第1軸・第2軸ぶん**で聞く(見出しは ΔX / ΔY を
 * 流用する)。ワールドの X / Y で聞くと、XZ 面にかいた図形を動かしたときに作図面から
 * 浮いてしまうため(`copyCommands.ts` の `planeDeltaCoordinate` の注釈)。
 * 既定は「第1軸へ 20mm」で、Enter を続けて押すだけで隣に 1 つ増える(NFR-UX-4)。
 */
const COPY_DELTA_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'dx', labelKey: 'numericInput.field.dx', tooltipKey: 'numericInput.tooltip.copyDx', unit: 'mm', defaultSource: String(DEFAULT_COPY_DELTA_MM) },
  { key: 'dy', labelKey: 'numericInput.field.dy', tooltipKey: 'numericInput.tooltip.copyDy', unit: 'mm', defaultSource: '0' },
];

/** 3D スケッチ(作図面なし)の複写。ワールドの 3 成分をそのまま聞く。 */
const COPY_DELTA_FREE_FIELDS: readonly NumericFieldDefinition[] = [
  ...COPY_DELTA_FIELDS,
  { key: 'dz', labelKey: 'numericInput.field.dz', tooltipKey: 'numericInput.tooltip.copyDz', unit: 'mm', defaultSource: '0' },
];

/**
 * 直線配列の 1 段目(向き・間隔、FR-324)。向きは作図面の第1軸から測った角度で、
 * 負の角度も逆向きとして意味を持つので範囲は付けない。
 */
const LINEAR_ARRAY_DIRECTION_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.arrayDirection', tooltipKey: 'numericInput.tooltip.arrayDirection', unit: 'degree', defaultSource: String(DEFAULT_ARRAY_DIRECTION_DEGREES) },
  { key: 'spacing', labelKey: 'numericInput.field.spacing', tooltipKey: 'numericInput.tooltip.arraySpacing', unit: 'mm', defaultSource: String(DEFAULT_ARRAY_SPACING_MM), range: POSITIVE },
];

/** 直線配列の 2 段目(個数、FR-324)。 */
const LINEAR_ARRAY_COUNT_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.arrayCount', unit: 'count', defaultSource: String(DEFAULT_LINEAR_ARRAY_COUNT), range: COPY_COUNT_RANGE },
];

/** 円形配列の 2 段目(角度・個数、FR-324)。中心は 1 段目で座標として聞く。 */
const CIRCULAR_ARRAY_SHAPE_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'angle', labelKey: 'numericInput.field.patternAngle', tooltipKey: 'numericInput.tooltip.arrayAngle', unit: 'degree', defaultSource: String(DEFAULT_ARRAY_ANGLE_DEGREES), range: ANGLE_UP_TO_360 },
  { key: 'count', labelKey: 'numericInput.field.count', tooltipKey: 'numericInput.tooltip.arrayCount', unit: 'count', defaultSource: String(DEFAULT_CIRCULAR_ARRAY_COUNT), range: COPY_COUNT_RANGE },
];

/* ---- P4 タスク23: スケッチの角の丸め・面取り(FR-323) ---- */

/**
 * 角を丸める半径の既定(mm、NFR-UX-4)。板物・ブラケットの角に使う手ごろな大きさで、
 * 統括の指示どおり 5mm から始める(立体の R 面取りの既定 2mm とは別の値。スケッチの角は
 * 輪郭そのものなので、立体の縁より大きめの丸めを置くことが多い)。
 */
export const DEFAULT_SKETCH_FILLET_RADIUS_MM = 5;

/** 角の面取りの距離の既定(mm、NFR-UX-4)。統括の指示どおり 3mm。 */
export const DEFAULT_SKETCH_CHAMFER_DISTANCE_MM = 3;

/** 角を丸める半径。0 より大きい数だけを許す(model の `filletCorner` と同じ判定)。 */
const SKETCH_FILLET_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'cornerRadius', labelKey: 'numericInput.field.radius', tooltipKey: 'numericInput.tooltip.filletRadius', unit: 'mm', defaultSource: String(DEFAULT_SKETCH_FILLET_RADIUS_MM), range: POSITIVE },
];

/** 面取りの距離(等距離)。1 欄だけで、2 本とも同じだけ削る。 */
const SKETCH_CHAMFER_EQUAL_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'cornerDistance1', labelKey: 'numericInput.field.chamferDistance', tooltipKey: 'numericInput.tooltip.chamferDistance', unit: 'mm', defaultSource: String(DEFAULT_SKETCH_CHAMFER_DISTANCE_MM), range: POSITIVE },
];

/** 面取りの距離(2 距離)。1 本目・2 本目の線を別々の距離だけ削る。 */
/**
 * 面取りの欄は「決め方」で変わる(立体の C 面取り `CHAMFER_SIZE_FIELDS` と同じ作り)。
 * 等距離なら 1 欄、2 距離なら 2 欄。スケッチの角には「距離と角度」を置かない
 * (model の `chamferCorner` が受け取るのは 2 つの距離だけで、角度から距離を出す式は
 * 角のなす角に依存し、立体の面取りの「距離と角度」とは意味が違うため)。
 *
 * P5 タスク49 で `visibleWhen` へ寄せた(立体の C 面取りと同じ理由)。出る欄と並びは同じ。
 */
const SKETCH_CHAMFER_FIELDS: readonly NumericFieldDefinition[] = [
  ...SKETCH_CHAMFER_EQUAL_FIELDS,
  {
    key: 'cornerDistance2',
    labelKey: 'numericInput.field.chamferDistance2',
    tooltipKey: 'numericInput.tooltip.chamferDistance2',
    unit: 'mm',
    defaultSource: String(DEFAULT_SKETCH_CHAMFER_DISTANCE_MM),
    range: POSITIVE,
    visibleWhen: whenChoiceIs('chamferMode', 'twoDistances'),
  },
];

/**
 * 整形系の段の欄(オフセット・複製系・角の丸め/面取り)。
 *
 * 複写だけ、作図面のあるスケッチ(2 欄)と 3D スケッチ(3 欄)で欄の数が変わるので
 * `options.freeSketch` を見る。面取りが選んだ決め方(`chamferMode`)で欄を出し分けるのは
 * `visibleWhen`(P5 タスク49)へ移したので、ここでは選択肢を見ない。
 * 座標の段(円形配列の中心)はここを通らない
 * (`definitionsFor` が座標の欄を返す)。
 */
function editFieldDefinitionsFor(
  step: Exclude<EditNumericInputStep, EditCoordinateStep>,
  options: NumericInputOptions,
): readonly NumericFieldDefinition[] {
  switch (step) {
    case 'offsetDistance':
      return OFFSET_DISTANCE_FIELDS;
    case 'mirrorBasis':
      // 鏡にするものは選択肢だけで決まる(欄は無い)。
      return NO_FIELDS;
    case 'copyDelta':
      return options.freeSketch === true ? COPY_DELTA_FREE_FIELDS : COPY_DELTA_FIELDS;
    case 'linearArrayDirection':
      return LINEAR_ARRAY_DIRECTION_FIELDS;
    case 'linearArrayCount':
      return LINEAR_ARRAY_COUNT_FIELDS;
    case 'circularArrayShape':
      return CIRCULAR_ARRAY_SHAPE_FIELDS;
    case 'sketchFilletRadius':
      return SKETCH_FILLET_FIELDS;
    case 'sketchChamferSize':
      return SKETCH_CHAMFER_FIELDS;
  }
}

/** 点列の並べ方ごとの欄。直線は P1 のまま(欄も既定値も変えない)。 */
function pointArrayFieldDefinitions(layout: string | undefined): readonly NumericFieldDefinition[] {
  if (layout === 'circular') {
    return POINT_ARRAY_CIRCULAR_FIELDS;
  }
  if (layout === 'grid') {
    return POINT_ARRAY_GRID_ROW_FIELDS;
  }
  return SHAPE_FIELDS.pointArrayShape;
}

/** 形の段(座標を聞かない段)の欄。点列だけが選択肢(並べ方)で欄の並びを変える。 */
function sketchShapeFieldDefinitionsFor(
  step: ShapeNumericInputStep,
  choices: readonly NumericChoice[],
): readonly NumericFieldDefinition[] {
  switch (step) {
    case 'arcShape':
      return SHAPE_FIELDS.arcShape;
    case 'pointArrayShape':
      return pointArrayFieldDefinitions(choiceValueFrom(choices, 'pointArrayLayout'));
    case 'pointArrayGridColumns':
      return POINT_ARRAY_GRID_COLUMN_FIELDS;
    case 'circleRadius':
      return CIRCLE_RADIUS_FIELDS;
    case 'twoPointArcRadius':
      return TWO_POINT_ARC_RADIUS_FIELDS;
    case 'polygonShape':
      return POLYGON_SHAPE_FIELDS;
    case 'slotShape':
      return SLOT_SHAPE_FIELDS;
    case 'ellipseShape':
      return ELLIPSE_SHAPE_FIELDS;
    case 'ellipseAngles':
      return ELLIPSE_ANGLE_FIELDS;
    case 'ellipseArcAngles':
      return ELLIPSE_ARC_ANGLE_FIELDS;
    case 'splineShape':
      return NO_FIELDS;
  }
}

/* ---- P4 タスク13: 基準ジオメトリの欄(FR-328、FR-329) ---- */

/**
 * もとにする面から離す距離(FR-328)。**負の値も向きの意味を持つ**(法線と逆へ離す)ので
 * 範囲は付けない。0 なら面そのものと同じ位置の平面になる。
 */
const REFERENCE_PLANE_OFFSET_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'planeOffset', labelKey: 'numericInput.field.planeOffset', tooltipKey: 'numericInput.tooltip.planeOffset', unit: 'mm', defaultSource: '10' },
];

/** 軸のまわりに傾ける角度(度、FR-328)。負の角度は逆まわりなので範囲は付けない。 */
const REFERENCE_PLANE_TILT_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'planeAngle', labelKey: 'numericInput.field.planeAngle', tooltipKey: 'numericInput.tooltip.planeAngle', unit: 'degree', defaultSource: '45' },
];

/**
 * 軸に垂直な平面をさらに倒す傾き角・方位角(度、FR-328 の「点+軸と角度」)。
 * 範囲(0 度以上 180 度未満)の判定は model の `resolvePlaneSpec` が受け持つので、
 * ここでは傾き角にだけ下限を置き、方位角は向きなので範囲を付けない。
 */
const REFERENCE_PLANE_AXIS_FIELDS: readonly NumericFieldDefinition[] = [
  { key: 'planeTilt', labelKey: 'numericInput.field.planeTilt', tooltipKey: 'numericInput.tooltip.planeTilt', unit: 'degree', defaultSource: '0', range: TILT_RANGE },
  { key: 'planeAzimuth', labelKey: 'numericInput.field.planeAzimuth', tooltipKey: 'numericInput.tooltip.planeAzimuth', unit: 'degree', defaultSource: '0' },
];

/**
 * 点を通る平面の段の欄。「軸に垂直」を選んだときだけ傾き角・方位角を聞く
 * (他の決め方では角度の意味が無いので欄を出さない、NFR-UX-2)。
 */
function referencePlaneThroughFieldDefinitions(
  mode: string | undefined,
): readonly NumericFieldDefinition[] {
  return mode === 'axis' ? REFERENCE_PLANE_AXIS_FIELDS : NO_FIELDS;
}

/** 基準ジオメトリの段の欄。座標を聞く段はここを通らない。 */
function referenceFieldDefinitionsFor(
  step: ReferenceShapeStep,
  choices: readonly NumericChoice[],
): readonly NumericFieldDefinition[] {
  switch (step) {
    case 'referencePlaneOffset':
      return REFERENCE_PLANE_OFFSET_FIELDS;
    case 'referencePlaneTilt':
      return REFERENCE_PLANE_TILT_FIELDS;
    case 'referencePlaneThrough':
      return referencePlaneThroughFieldDefinitions(
        choiceValueFrom(choices, 'referencePlaneThroughMode'),
      );
    case 'referenceAxisKind':
    case 'referencePointKind':
    case 'referenceCsAxes':
      // 決め方と軸の向きだけで決まる段。欄は持たない。
      return NO_FIELDS;
  }
}

/** 段ごとの静的な欄の並び。動的な段(chamferSize・springLength)はここを通らない。 */
function solidFieldDefinitionsFor(
  step: SolidNumericInputStep,
  choices: readonly NumericChoice[],
): readonly NumericFieldDefinition[] {
  switch (step) {
    case 'extrudeDistance':
      return EXTRUDE_DISTANCE_FIELDS;
    case 'revolveAngle':
      return REVOLVE_ANGLE_FIELDS;
    case 'sewTolerance':
      return SEW_TOLERANCE_FIELDS;
    case 'holeSize':
      return HOLE_SIZE_FIELDS;
    case 'threadSize':
      return THREAD_SIZE_FIELDS;
    case 'filletRadius':
      return FILLET_RADIUS_FIELDS;
    case 'chamferSize':
      return CHAMFER_SIZE_FIELDS;
    case 'linearPattern':
      return LINEAR_PATTERN_FIELDS;
    case 'circularPattern':
      return CIRCULAR_PATTERN_FIELDS;
    case 'springShape':
      return SPRING_SHAPE_FIELDS;
    case 'springLength':
      return springLengthFieldDefinitions(choiceValueFrom(choices, 'springDerived'));
    // 基本形状5種(FR-429、タスク18)。どれも選択肢(軸)で欄が変わらない静的な並び。
    case 'sphereSize':
      return SPHERE_SIZE_FIELDS;
    case 'boxSize':
      return BOX_SIZE_FIELDS;
    case 'cylinderSize':
      return CYLINDER_SIZE_FIELDS;
    case 'coneSize':
      return CONE_SIZE_FIELDS;
    case 'torusSize':
      return TORUS_SIZE_FIELDS;
    // 球面上の点(FR-431、タスク22)。緯度・経度の 2 欄で、選択肢もつまみも持たない。
    case 'sphereGridPoint':
      return SPHERE_GRID_POINT_FIELDS;
    // 面をつなぐ・ロフト(FR-430、FR-410、タスク27)。どちらも欄はねじれ 1 つだけで、
    // 罫線面の「なめらかさ」は選択肢(欄ではない)なのでここには出てこない。
    case 'ruledTwist':
    case 'loftTwist':
      return RULED_TWIST_FIELDS;
    /*
      P5 の Should / Could 群(タスク49)。**欄の出し分けは `visibleWhen` が受け持つ**ので、
      ここでは段ごとに「持ちうる欄の全部」を並びの順に返すだけでよい(C 面取り・ばねの
      長さのように段ごとの専用関数を増やさない)。
    */
    case 'draftAngle':
      return DRAFT_ANGLE_FIELDS;
    case 'transformTranslation':
      return TRANSFORM_TRANSLATION_FIELDS;
    case 'transformRotation':
      return TRANSFORM_ROTATION_FIELDS;
    case 'scaleAmount':
      return SCALE_AMOUNT_FIELDS;
    case 'ribThickness':
      return RIB_THICKNESS_FIELDS;
    case 'embossHeight':
      return EMBOSS_HEIGHT_FIELDS;
    case 'threadShaftSize':
      return THREAD_SHAFT_SIZE_FIELDS;
    case 'surfaceShape':
      return SURFACE_SHAPE_FIELDS;
    case 'shellThickness':
      return SHELL_THICKNESS_FIELDS;
    case 'cutPlane':
      return CUT_PLANE_FIELDS;
    /*
      欄を 1 つも持たない段。ミラーは鏡にする面(選択肢)だけ、スイープは向きの決め方
      (つまみ)だけ、点集合パターンは選んだ点の数で決まるので聞くことが無い(§2.15)。
    */
    case 'mirrorPlane':
    case 'sweepOptions':
    case 'pointPattern':
      return NO_FIELDS;
  }
}

/** 段階ごとの見出し。 */
export const STEP_TITLE_KEYS: Readonly<Record<NumericInputStep, MessageKey>> = {
  point: 'numericInput.title.point',
  lineStart: 'numericInput.title.lineStart',
  lineEnd: 'numericInput.title.lineEnd',
  arcCenter: 'numericInput.title.arcCenter',
  arcShape: 'numericInput.title.arc',
  pointArrayBase: 'numericInput.title.pointArrayBase',
  pointArrayShape: 'numericInput.title.pointArray',
  pointArrayGridColumns: 'numericInput.title.pointArrayGridColumns',
  circleCenter: 'numericInput.title.circleCenter',
  circleRadius: 'numericInput.title.circleRadius',
  twoPointArcStart: 'numericInput.title.twoPointArcStart',
  twoPointArcEnd: 'numericInput.title.twoPointArcEnd',
  twoPointArcRadius: 'numericInput.title.twoPointArcRadius',
  threePointArcStart: 'numericInput.title.threePointArcStart',
  threePointArcEnd: 'numericInput.title.threePointArcEnd',
  threePointArcVia: 'numericInput.title.threePointArcVia',
  rectangleCorner1: 'numericInput.title.rectangleCorner1',
  rectangleCorner2: 'numericInput.title.rectangleCorner2',
  polygonCenter: 'numericInput.title.polygonCenter',
  polygonShape: 'numericInput.title.polygonShape',
  slotCenter1: 'numericInput.title.slotCenter1',
  slotCenter2: 'numericInput.title.slotCenter2',
  slotShape: 'numericInput.title.slotShape',
  ellipseCenter: 'numericInput.title.ellipseCenter',
  ellipseShape: 'numericInput.title.ellipseShape',
  ellipseAngles: 'numericInput.title.ellipseAngles',
  ellipseArcAngles: 'numericInput.title.ellipseArcAngles',
  splinePoint: 'numericInput.title.splinePoint',
  splineShape: 'numericInput.title.splineShape',
  extrudeDistance: 'numericInput.title.extrude',
  revolveAngle: 'numericInput.title.revolve',
  sewTolerance: 'numericInput.title.sew',
  holeSize: 'numericInput.title.hole',
  threadSize: 'numericInput.title.threadHole',
  filletRadius: 'numericInput.title.fillet',
  chamferSize: 'numericInput.title.chamfer',
  linearPattern: 'numericInput.title.linearPattern',
  circularPattern: 'numericInput.title.circularPattern',
  springShape: 'numericInput.title.springShape',
  springLength: 'numericInput.title.springLength',
  sphereSize: 'numericInput.title.sphere',
  boxSize: 'numericInput.title.box',
  cylinderSize: 'numericInput.title.cylinder',
  coneSize: 'numericInput.title.cone',
  torusSize: 'numericInput.title.torus',
  sphereGridPoint: 'numericInput.title.sphereGridPoint',
  ruledTwist: 'numericInput.title.ruled',
  loftTwist: 'numericInput.title.loft',
  // P5 の Should / Could 群(タスク48 が ja.json へ足した見出し、タスク49 の段)。
  draftAngle: 'numericInput.title.draftAngle',
  mirrorPlane: 'numericInput.title.mirrorPlane',
  transformTranslation: 'numericInput.title.transformTranslation',
  transformRotation: 'numericInput.title.transformRotation',
  scaleAmount: 'numericInput.title.scaleAmount',
  sweepOptions: 'numericInput.title.sweepOptions',
  ribThickness: 'numericInput.title.ribThickness',
  embossHeight: 'numericInput.title.embossHeight',
  threadShaftSize: 'numericInput.title.threadShaftSize',
  pointPattern: 'numericInput.title.pointPattern',
  surfaceShape: 'numericInput.title.surfaceShape',
  shellThickness: 'numericInput.title.shellThickness',
  cutPlane: 'numericInput.title.cutPlane',
  referencePlanePoint1: 'numericInput.title.referencePlanePoint1',
  referencePlanePoint2: 'numericInput.title.referencePlanePoint2',
  referencePlanePoint3: 'numericInput.title.referencePlanePoint3',
  referencePlaneBasePoint: 'numericInput.title.referencePlaneBasePoint',
  referencePlaneThrough: 'numericInput.title.referencePlaneThrough',
  referencePlaneOffset: 'numericInput.title.referencePlaneOffset',
  referencePlaneTilt: 'numericInput.title.referencePlaneTilt',
  referenceAxisKind: 'numericInput.title.referenceAxisKind',
  referenceAxisStart: 'numericInput.title.referenceAxisStart',
  referenceAxisEnd: 'numericInput.title.referenceAxisEnd',
  referencePointKind: 'numericInput.title.referencePointKind',
  referencePointAt: 'numericInput.title.referencePointAt',
  referenceCsOrigin: 'numericInput.title.referenceCsOrigin',
  referenceCsAxes: 'numericInput.title.referenceCsAxes',
  offsetDistance: 'numericInput.title.offsetDistance',
  mirrorBasis: 'numericInput.title.mirrorBasis',
  copyDelta: 'numericInput.title.copyDelta',
  linearArrayDirection: 'numericInput.title.linearArrayDirection',
  linearArrayCount: 'numericInput.title.linearArrayCount',
  circularArrayCenter: 'numericInput.title.circularArrayCenter',
  circularArrayShape: 'numericInput.title.circularArrayShape',
  // 立体の R 面取り・C 面取りと同じ見出し。利用者から見ればどちらも「角を丸める」
  // 「面を取る」操作で、対象(線か立体の辺か)は選んでいる道具から分かる。
  sketchFilletRadius: 'numericInput.title.fillet',
  sketchChamferSize: 'numericInput.title.chamfer',
};

/** 段階の一覧。タスク18 の部品と、キーの網羅検査が舐めるために公開する。 */
export const NUMERIC_INPUT_STEPS: readonly NumericInputStep[] = [
  'point',
  'lineStart',
  'lineEnd',
  'arcCenter',
  'arcShape',
  'pointArrayBase',
  'pointArrayShape',
  'pointArrayGridColumns',
  'circleCenter',
  'circleRadius',
  'twoPointArcStart',
  'twoPointArcEnd',
  'twoPointArcRadius',
  'threePointArcStart',
  'threePointArcEnd',
  'threePointArcVia',
  'rectangleCorner1',
  'rectangleCorner2',
  'polygonCenter',
  'polygonShape',
  'slotCenter1',
  'slotCenter2',
  'slotShape',
  'ellipseCenter',
  'ellipseShape',
  'ellipseAngles',
  'ellipseArcAngles',
  'splinePoint',
  'splineShape',
  'extrudeDistance',
  'revolveAngle',
  'sewTolerance',
  'holeSize',
  'threadSize',
  'filletRadius',
  'chamferSize',
  'linearPattern',
  'circularPattern',
  'springShape',
  'springLength',
  'sphereSize',
  'boxSize',
  'cylinderSize',
  'coneSize',
  'torusSize',
  'sphereGridPoint',
  'ruledTwist',
  'loftTwist',
  'draftAngle',
  'mirrorPlane',
  'transformTranslation',
  'transformRotation',
  'scaleAmount',
  'sweepOptions',
  'ribThickness',
  'embossHeight',
  'threadShaftSize',
  'pointPattern',
  'surfaceShape',
  'shellThickness',
  'cutPlane',
  'referencePlanePoint1',
  'referencePlanePoint2',
  'referencePlanePoint3',
  'referencePlaneBasePoint',
  'referencePlaneThrough',
  'referencePlaneOffset',
  'referencePlaneTilt',
  'referenceAxisKind',
  'referenceAxisStart',
  'referenceAxisEnd',
  'referencePointKind',
  'referencePointAt',
  'referenceCsOrigin',
  'referenceCsAxes',
  'offsetDistance',
  'mirrorBasis',
  'copyDelta',
  'linearArrayDirection',
  'linearArrayCount',
  'circularArrayCenter',
  'circularArrayShape',
  'sketchFilletRadius',
  'sketchChamferSize',
];

/** ソリッドの道具が最初に聞く段階。ツールバーがここから開く。ばねは形(springShape)から。 */
export const SOLID_TOOL_STEPS: Readonly<Record<SolidToolId, SolidNumericInputStep>> = {
  extrude: 'extrudeDistance',
  revolve: 'revolveAngle',
  sew: 'sewTolerance',
  hole: 'holeSize',
  threadHole: 'threadSize',
  fillet: 'filletRadius',
  chamfer: 'chamferSize',
  linearPattern: 'linearPattern',
  circularPattern: 'circularPattern',
  spring: 'springShape',
  // 基本形状5種(FR-429、タスク18)。どれも寸法の1段だけで終わる。
  sphere: 'sphereSize',
  box: 'boxSize',
  cylinder: 'cylinderSize',
  cone: 'coneSize',
  torus: 'torusSize',
  // 球面上の点(FR-431、タスク22)。緯度・経度の 1 段だけで終わる。
  sphereGridPoint: 'sphereGridPoint',
  // 面をつなぐ・ロフト(FR-430、FR-410、タスク27)。どちらもねじれの 1 段だけで終わる。
  ruled: 'ruledTwist',
  loft: 'loftTwist',
  /*
    P5 の Should / Could 群(タスク49)。移動/回転だけが 2 段で、ここには 1 段目を書く
    (ばね・配列複写と同じ約束)。
  */
  draft: 'draftAngle',
  mirrorSolid: 'mirrorPlane',
  transform: 'transformTranslation',
  scale: 'scaleAmount',
  sweep: 'sweepOptions',
  rib: 'ribThickness',
  emboss: 'embossHeight',
  threadShaft: 'threadShaftSize',
  pointPattern: 'pointPattern',
  surface: 'surfaceShape',
  shell: 'shellThickness',
  cut: 'cutPlane',
};

/**
 * P4 の新しい図形の道具が最初に開く段(FR-314〜318、FR-326)。
 * ツールバー(タスク32)とビューポートの操作(タスク12)はここから開く。
 * `SOLID_TOOL_STEPS` と同じ役目で、道具の一覧の正本でもある(`isShapeTool` がこの表を使う)。
 */
export const SHAPE_TOOL_STEPS: Readonly<Record<ShapeToolId, NumericInputStep>> = {
  circle: 'circleCenter',
  twoPointArc: 'twoPointArcStart',
  threePointArc: 'threePointArcStart',
  rectangle: 'rectangleCorner1',
  polygon: 'polygonCenter',
  slot: 'slotCenter1',
  ellipse: 'ellipseCenter',
  spline: 'splinePoint',
};

/**
 * P4 の新しい図形の道具かどうか。一覧をここへ書き出さず `SHAPE_TOOL_STEPS` から引く
 * (P3 の `isSolidTool` が一覧の二重管理で追随漏れを起こした前例に合わせる、
 *  `attachSketchInteraction.ts` の注釈)。
 */
export function isShapeTool(tool: NumericInputToolId): tool is ShapeToolId {
  return tool in SHAPE_TOOL_STEPS;
}

/**
 * 基準ジオメトリの道具が最初に開く段(P4 タスク13、FR-328、FR-329)。
 * `SOLID_TOOL_STEPS` / `SHAPE_TOOL_STEPS` と同じ役目で、道具の一覧の正本でもある。
 */
export const REFERENCE_TOOL_STEPS: Readonly<Record<ReferenceToolId, ReferenceNumericInputStep>> = {
  referencePlaneThreePoints: 'referencePlanePoint1',
  referencePlaneOffset: 'referencePlaneOffset',
  referencePlaneTilted: 'referencePlaneTilt',
  referencePlaneThroughPoint: 'referencePlaneBasePoint',
  referenceAxis: 'referenceAxisKind',
  referencePoint: 'referencePointKind',
  referenceCoordinateSystem: 'referenceCsOrigin',
};

/** 基準ジオメトリの道具かどうか。一覧は `REFERENCE_TOOL_STEPS` の 1 か所だけに置く。 */
export function isReferenceTool(tool: NumericInputToolId): tool is ReferenceToolId {
  return tool in REFERENCE_TOOL_STEPS;
}

/** 段から道具を引く。確定結果へ入れる道具名の正本(`SOLID_STEP_TOOLS` と同じ役目)。 */
const REFERENCE_STEP_TOOLS: Readonly<Record<ReferenceNumericInputStep, ReferenceToolId>> = {
  referencePlanePoint1: 'referencePlaneThreePoints',
  referencePlanePoint2: 'referencePlaneThreePoints',
  referencePlanePoint3: 'referencePlaneThreePoints',
  referencePlaneBasePoint: 'referencePlaneThroughPoint',
  referencePlaneThrough: 'referencePlaneThroughPoint',
  referencePlaneOffset: 'referencePlaneOffset',
  referencePlaneTilt: 'referencePlaneTilted',
  referenceAxisKind: 'referenceAxis',
  referenceAxisStart: 'referenceAxis',
  referenceAxisEnd: 'referenceAxis',
  referencePointKind: 'referencePoint',
  referencePointAt: 'referencePoint',
  referenceCsOrigin: 'referenceCoordinateSystem',
  referenceCsAxes: 'referenceCoordinateSystem',
};

/** 段が基準ジオメトリのものかどうか。 */
export function isReferenceStep(step: NumericInputStep): step is ReferenceNumericInputStep {
  return step in REFERENCE_STEP_TOOLS;
}

/**
 * 基準ジオメトリの段のうち、座標を 1 点聞くもの(位置の決め方のタブを出す段)。
 * 一覧を 2 か所に書かないよう、`REFERENCE_COORDINATE_STEPS` の表だけを正本にする。
 */
const REFERENCE_COORDINATE_STEPS: Readonly<Record<ReferenceCoordinateStep, true>> = {
  referencePlanePoint1: true,
  referencePlanePoint2: true,
  referencePlanePoint3: true,
  referencePlaneBasePoint: true,
  referenceAxisStart: true,
  referenceAxisEnd: true,
  referencePointAt: true,
  referenceCsOrigin: true,
};

export function isReferenceCoordinateStep(
  step: NumericInputStep,
): step is ReferenceCoordinateStep {
  return step in REFERENCE_COORDINATE_STEPS;
}

/**
 * 整形系の道具が最初に開く段(P4 タスク21〜24、FR-321〜324)。
 * `SHAPE_TOOL_STEPS` / `REFERENCE_TOOL_STEPS` と同じ役目で、道具の一覧の正本でもある。
 */
export const EDIT_TOOL_STEPS: Readonly<Record<EditToolId, EditNumericInputStep>> = {
  offset: 'offsetDistance',
  mirror: 'mirrorBasis',
  copy: 'copyDelta',
  linearArray: 'linearArrayDirection',
  circularArray: 'circularArrayCenter',
  sketchFillet: 'sketchFilletRadius',
  sketchChamfer: 'sketchChamferSize',
};

/** 整形系の道具かどうか。一覧は `EDIT_TOOL_STEPS` の 1 か所だけに置く。 */
export function isEditTool(tool: NumericInputToolId): tool is EditToolId {
  return tool in EDIT_TOOL_STEPS;
}

/** 段から道具を引く。確定結果へ入れる道具名の正本(`SOLID_STEP_TOOLS` と同じ役目)。 */
const EDIT_STEP_TOOLS: Readonly<Record<EditNumericInputStep, EditToolId>> = {
  offsetDistance: 'offset',
  mirrorBasis: 'mirror',
  copyDelta: 'copy',
  linearArrayDirection: 'linearArray',
  linearArrayCount: 'linearArray',
  circularArrayCenter: 'circularArray',
  circularArrayShape: 'circularArray',
  sketchFilletRadius: 'sketchFillet',
  sketchChamferSize: 'sketchChamfer',
};

/** 段が整形系のものかどうか。 */
export function isEditStep(step: NumericInputStep): step is EditNumericInputStep {
  return step in EDIT_STEP_TOOLS;
}

/**
 * 整形系のうち、座標を 1 点聞く段(P4 タスク24)。いまは円形配列の中心だけ。
 * 基準ジオメトリの `REFERENCE_COORDINATE_STEPS` と同じ役目で、位置の決め方(絶対/相対/極)の
 * タブを出すかどうかもここで決まる(`asksCoordinate`)。
 */
const EDIT_COORDINATE_STEPS: Readonly<Record<'circularArrayCenter', true>> = {
  circularArrayCenter: true,
};

/** 座標を聞く整形系の段の型。欄の並びは座標の 3 欄になる。 */
export type EditCoordinateStep = keyof typeof EDIT_COORDINATE_STEPS;

export function isEditCoordinateStep(step: NumericInputStep): step is EditCoordinateStep {
  return step in EDIT_COORDINATE_STEPS;
}

/**
 * 1 段目を確定したら閉じずに次の段を開く整形系の道具(P4 タスク24)。
 * ばねの `springShape → springLength` と同じ作りで、1 段目の欄・選択肢・位置の決め方は
 * `carriedStage1` に持ち越して 2 段目の確定でまとめて 1 つの `EditInputCommit` にする。
 */
const EDIT_SECOND_STEPS: Readonly<Partial<Record<EditNumericInputStep, EditNumericInputStep>>> = {
  linearArrayDirection: 'linearArrayCount',
  circularArrayCenter: 'circularArrayShape',
};

/** 段階から道具を引く。確定結果へ入れる道具名の正本。ばねは springShape / springLength とも spring。 */
const SOLID_STEP_TOOLS: Readonly<Record<SolidNumericInputStep, SolidToolId>> = {
  extrudeDistance: 'extrude',
  revolveAngle: 'revolve',
  sewTolerance: 'sew',
  holeSize: 'hole',
  threadSize: 'threadHole',
  filletRadius: 'fillet',
  chamferSize: 'chamfer',
  linearPattern: 'linearPattern',
  circularPattern: 'circularPattern',
  springShape: 'spring',
  springLength: 'spring',
  sphereSize: 'sphere',
  boxSize: 'box',
  cylinderSize: 'cylinder',
  coneSize: 'cone',
  torusSize: 'torus',
  sphereGridPoint: 'sphereGridPoint',
  ruledTwist: 'ruled',
  loftTwist: 'loft',
  // P5 の Should / Could 群(タスク49)。移動/回転は 2 段とも同じ道具を指す(ばねと同じ)。
  draftAngle: 'draft',
  mirrorPlane: 'mirrorSolid',
  transformTranslation: 'transform',
  transformRotation: 'transform',
  scaleAmount: 'scale',
  sweepOptions: 'sweep',
  ribThickness: 'rib',
  embossHeight: 'emboss',
  threadShaftSize: 'threadShaft',
  pointPattern: 'pointPattern',
  surfaceShape: 'surface',
  shellThickness: 'shell',
  cutPlane: 'cut',
};

/** 段階ごとのつまみ。縫合・R面取り・C面取り・ばねは向きも両側も持たない(§2.11 の表)。 */
const STEP_TOGGLE_KEYS: Readonly<Record<SolidNumericInputStep, readonly NumericToggleKey[]>> = {
  // 押し出しは終わり方・傾き・薄板をここへ畳んだ(タスク50)。傾きと厚みの欄は
  // 「側面を傾ける」「薄板にする」を入にしたときだけ出るので、開いた直後は距離 1 欄のまま。
  extrudeDistance: ['reversed', 'symmetric', 'tapered', 'taperOutward', 'thinWalled'],
  revolveAngle: ['reversed'],
  sewTolerance: [],
  holeSize: ['through'],
  threadSize: ['through', 'modeledThread'],
  // R 面取りは可変半径をここへ畳んだ(タスク50)。終わりの半径の欄はつまみが入のときだけ。
  filletRadius: ['variableRadius'],
  chamferSize: [],
  linearPattern: ['patternSymmetric'],
  circularPattern: ['fullCircle'],
  springShape: [],
  springLength: [],
  // 基本形状5種はつまみを持たない(§2.15 の段の表。向きは選択肢の「軸」で決める)。
  sphereSize: [],
  boxSize: [],
  cylinderSize: [],
  coneSize: [],
  torusSize: [],
  // 球面上の点もつまみを持たない(緯度・経度の 2 欄だけ、§2.15 の段の表)。
  sphereGridPoint: [],
  // 面をつなぐ・ロフトもつまみを持たない(§2.15 の段の表。ロフトの「閉じる」は
  // 常に入で文書にも UI にも出さない決まりになった。タスク25 の統括の決定)。
  ruledTwist: [],
  loftTwist: ['loftSmooth'],
  /*
    P5 の Should / Could 群のつまみ(§2.15 の段の表)。
    リブは**向きのつまみを持たない**(輪郭の平面と対象の位置で向きが決まる規約。タスク46)。
    切断は「反対側を残す」と「反対側も残す(2 つに分ける)」の 2 つを持つ(§0.a-0.57・0.58)。
  */
  draftAngle: ['reversed'],
  mirrorPlane: [],
  transformTranslation: [],
  transformRotation: [],
  scaleAmount: ['scalePerAxis'],
  sweepOptions: ['sweepFrenet'],
  ribThickness: [],
  embossHeight: ['raised'],
  threadShaftSize: ['modeledThread'],
  pointPattern: [],
  surfaceShape: ['reversed'],
  shellThickness: ['shellOutward'],
  cutPlane: ['cutKeepOpposite', 'cutKeepBoth'],
};

/**
 * スケッチの段のつまみ(P4 タスク11)。
 *
 * 構築線(FR-320)は**要素が履歴へ積まれる最後の段**にだけ置く。前の段に置いても、
 * 段ごとに状態を作り直す作りなので確定のときに値が残らないため
 * (矩形は 2 つ目の角、長穴は幅、スプラインは決め方の段が「最後」になる)。
 * P1 の段のうち `lineEnd` と `arcShape` にもここで構築線が付く(FR-320 の主な使い道が
 * 補助の線・円であり、新しい図形だけに付けても要件を満たせないため)。
 */
const SKETCH_STEP_TOGGLE_KEYS: Readonly<
  Record<SketchNumericInputStep, readonly NumericToggleKey[]>
> = {
  point: [],
  lineStart: [],
  lineEnd: ['construction', 'splitIntersections'],
  arcCenter: [],
  arcShape: ['construction'],
  pointArrayBase: [],
  pointArrayShape: [],
  pointArrayGridColumns: [],
  circleCenter: [],
  circleRadius: ['construction'],
  twoPointArcStart: [],
  twoPointArcEnd: [],
  twoPointArcRadius: ['construction'],
  threePointArcStart: [],
  threePointArcEnd: [],
  // 3 点目(通過点)で確定するので、構築線のつまみはここに付く(FR-330、タスク36)。
  threePointArcVia: ['construction'],
  rectangleCorner1: [],
  rectangleCorner2: ['construction'],
  polygonCenter: [],
  polygonShape: ['construction'],
  slotCenter1: [],
  slotCenter2: [],
  slotShape: ['construction'],
  ellipseCenter: [],
  ellipseShape: [],
  // 「一部だけ」を入にすると、次に開始角・終了角の段(ellipseArcAngles)へ進む。
  ellipseAngles: ['ellipseArc', 'construction'],
  ellipseArcAngles: [],
  splinePoint: [],
  splineShape: ['splineClosed', 'construction'],
};

/**
 * 整形系の段のつまみ(P4 タスク21・24)。
 *
 * 構築線(FR-320)は**要素が履歴へ積まれる最後の段**にだけ置く(スケッチの段と同じ約束)。
 * 配列複写は 2 段あるので、つまみが付くのは 2 段目のほう。円形配列の「全周」は、入なら
 * 360 度を等分し、切なら「角度」の欄を個数 − 1 で等分する(P3 の円形パターンと同じ)。
 */
const EDIT_STEP_TOGGLE_KEYS: Readonly<
  Record<EditNumericInputStep, readonly NumericToggleKey[]>
> = {
  offsetDistance: [],
  mirrorBasis: ['construction'],
  copyDelta: ['construction'],
  linearArrayDirection: [],
  linearArrayCount: ['construction'],
  circularArrayCenter: [],
  circularArrayShape: ['fullCircle', 'construction'],
  /*
    角の丸め・面取り(タスク23)はつまみを持たない。足す円弧・線分が構築線になるかは
    利用者が選ぶことではなく、**丸める 2 本が両方とも構築線のときだけ構築線**と
    model 側(`cornerCommands.ts` の `addedConstruction`)が決める。片方でも実体の線なら、
    丸めた角も実体でないと輪郭が途切れるため(FR-320)。
  */
  sketchFilletRadius: [],
  sketchChamferSize: [],
};

/** つまみの見出し。 */
export const TOGGLE_LABEL_KEYS: Readonly<Record<NumericToggleKey, MessageKey>> = {
  reversed: 'numericInput.toggle.reversed',
  symmetric: 'numericInput.toggle.symmetric',
  through: 'numericInput.toggle.through',
  modeledThread: 'numericInput.toggle.modeledThread',
  patternSymmetric: 'numericInput.toggle.patternSymmetric',
  fullCircle: 'numericInput.toggle.fullCircle',
  construction: 'numericInput.toggle.construction',
  splitIntersections: 'numericInput.toggle.splitIntersections',
  ellipseArc: 'numericInput.toggle.ellipseArc',
  splineClosed: 'numericInput.toggle.splineClosed',
  // P5 の Should / Could 群(タスク48 が ja.json へ足した見出し)。
  tapered: 'numericInput.toggle.tapered',
  taperOutward: 'numericInput.toggle.taperOutward',
  thinWalled: 'numericInput.toggle.thinWalled',
  sweepFrenet: 'numericInput.toggle.sweepFrenet',
  loftSmooth: 'numericInput.toggle.loftSmooth',
  raised: 'numericInput.toggle.raised',
  scalePerAxis: 'numericInput.toggle.scalePerAxis',
  shellOutward: 'numericInput.toggle.shellOutward',
  variableRadius: 'numericInput.toggle.variableRadius',
  cutKeepOpposite: 'numericInput.toggle.cutKeepOpposite',
  cutKeepBoth: 'numericInput.toggle.cutKeepBoth',
};

/**
 * つまみの既定値。円形パターンの「全周」だけ既定で入(§0.a-0.21「円形『Z・全周・4』」)。
 * ほかはすべて既定で切。
 */
const TOGGLE_DEFAULT_VALUES: Readonly<Record<NumericToggleKey, boolean>> = {
  reversed: false,
  symmetric: false,
  through: false,
  modeledThread: false,
  patternSymmetric: false,
  fullCircle: true,
  // 構築線・楕円弧・閉じたスプラインは、いずれも「ふつうはしないこと」なので既定は切
  // (FR-320 の既定オフ、楕円は全周、スプラインは開いた曲線)。
  construction: false,
  splitIntersections: true,
  ellipseArc: false,
  splineClosed: false,
  /*
    P5 の Should / Could 群。**model の既定の定数から引く**(同じ真偽を 2 か所に書かない)。
    定数の無い 3 つ(側面を外へ広げる・軸ごとの倍率・終わりを別の半径に)は、いずれも
    「ふつうはしないこと」なので既定を切にする(構築線・楕円弧と同じ考え方)。
  */
  tapered: false,
  taperOutward: false,
  thinWalled: false,
  sweepFrenet: DEFAULT_SWEEP_FRENET,
  loftSmooth: false,
  raised: DEFAULT_EMBOSS_RAISED,
  scalePerAxis: false,
  shellOutward: DEFAULT_SHELL_OUTWARD,
  variableRadius: false,
  // 既定は法線の側を残す(§0.a-0.57)ので、「反対側を残す」は切から始まる。
  cutKeepOpposite: DEFAULT_CUT_KEEP === 'negative',
  cutKeepBoth: false,
};

export * from './numericInputPresentation.js';

/** 相対・極の基準点の既定。直前に作った点からの続きが自然(FR-302、FR-307)。 */
export const DEFAULT_COORDINATE_BASE: PointReference = { kind: 'previous' };

/**
 * 座標を聞く段の一覧。`Record<CoordinateNumericInputStep, true>` にすることで、
 * 段を足したときにここを直し忘れると型検査が落ちる(P4 で段が 5 個から 15 個に増えたため、
 * `||` の並びから表へ変えた)。
 */
const COORDINATE_STEPS: Readonly<Record<CoordinateNumericInputStep, true>> = {
  point: true,
  lineStart: true,
  lineEnd: true,
  arcCenter: true,
  pointArrayBase: true,
  circleCenter: true,
  twoPointArcStart: true,
  twoPointArcEnd: true,
  threePointArcStart: true,
  threePointArcEnd: true,
  threePointArcVia: true,
  rectangleCorner1: true,
  rectangleCorner2: true,
  polygonCenter: true,
  slotCenter1: true,
  slotCenter2: true,
  ellipseCenter: true,
  splinePoint: true,
};

/** 段階が座標を聞くものかどうか。円弧の半径・角度やソリッドの距離は座標モードを持たない。 */
export function isCoordinateStep(step: NumericInputStep): step is CoordinateNumericInputStep {
  return step in COORDINATE_STEPS;
}

/**
 * 段階がソリッドのものかどうか(P2 タスク19、P3 タスク24)。
 *
 * P5 タスク49 で `||` の並びから `SOLID_STEP_TOOLS`(段 → 道具の表)を引く形へ変えた。
 * 段が 18 個から 35 個へ増え、並びを書き足し忘れても型検査が落ちないのが危なかったため
 * (段を足したのに判定へ足し忘れる失敗は docs/報告記録.md 2026-09-04 03:20 の③と同じ形)。
 * `SOLID_STEP_TOOLS` は `Record<SolidNumericInputStep, SolidToolId>` なので、段を足して
 * この表へ書き忘れれば型検査が落ちる。**判定の結果は以前とまったく同じ**(表の鍵の集合が
 * `SolidNumericInputStep` そのものだから)。座標の段の `COORDINATE_STEPS` と同じ作り。
 */
export function isSolidStep(step: NumericInputStep): step is SolidNumericInputStep {
  return step in SOLID_STEP_TOOLS;
}

/**
 * 既定を相対にする段(FR-307)。「直前に決めた点からの続き」で入れるほうが自然な 2 点目
 * (線分の終点、矩形の対角、長穴の 2 つ目の中心、円弧の 2 点目)がこれに当たる。
 */
const RELATIVE_FIRST_STEPS: Readonly<Partial<Record<NumericInputStep, true>>> = {
  lineEnd: true,
  twoPointArcEnd: true,
  threePointArcEnd: true,
  threePointArcVia: true,
  rectangleCorner2: true,
  slotCenter2: true,
  // 基準ジオメトリの 2 点目以降も「1 つ前の点からの続き」で入れるほうが自然(タスク13)。
  // 基準は `referenceCommands.ts` が 1 つ前に作った基準点へ付け替える。
  referencePlanePoint2: true,
  referencePlanePoint3: true,
  referenceAxisEnd: true,
};

/** 段階ごとの既定の座標モード。2 点目を聞く段だけは相対が自然(FR-307)。 */
export function defaultModeForStep(step: NumericInputStep): CoordinateMode {
  return RELATIVE_FIRST_STEPS[step] === true ? 'relative' : 'absolute';
}

/**
 * 位置の決め方(絶対 / 相対 / 極)のタブを出す段かどうか。
 * スケッチの座標の段(`isCoordinateStep`)と基準ジオメトリの座標の段
 * (`isReferenceCoordinateStep`)の両方を含む。型の絞り込みが要る場所では、
 * 絞り込みができる元の 2 つを使う。
 */
export function asksCoordinate(step: NumericInputStep): boolean {
  return isCoordinateStep(step) || isReferenceCoordinateStep(step) || isEditCoordinateStep(step);
}

function definitionsFor(
  step: NumericInputStep,
  mode: CoordinateMode,
  choices: readonly NumericChoice[],
  options: NumericInputOptions = {},
): readonly NumericFieldDefinition[] {
  if (isSolidStep(step)) {
    return solidFieldDefinitionsFor(step, choices);
  }
  if (isReferenceCoordinateStep(step) || isCoordinateStep(step) || isEditCoordinateStep(step)) {
    return COORDINATE_FIELDS[mode];
  }
  if (isReferenceStep(step)) {
    return referenceFieldDefinitionsFor(step, choices);
  }
  if (isEditStep(step)) {
    return editFieldDefinitionsFor(step, options);
  }
  return sketchShapeFieldDefinitionsFor(step, choices);
}

/**
 * いまの選択肢・つまみで**出す欄だけ**に絞る(P5 タスク49、`visibleWhen`)。
 *
 * 絞ったあとの並びがそのまま状態の `fields` になるので、隠れた欄は Tab の輪
 * (`numericFocusTargets`)からも、確定の値(`solidValuesFor`)からも自動的に外れる。
 * 「隠すが値は持つ」ようにしないのは、見えない欄の値で形が変わると理由を追えないため。
 */
function visibleDefinitions(
  definitions: readonly NumericFieldDefinition[],
  choices: readonly NumericChoice[],
  toggles: readonly NumericToggle[],
): readonly NumericFieldDefinition[] {
  return definitions.filter(
    (definition) =>
      definition.visibleWhen === undefined || definition.visibleWhen({ choices, toggles }),
  );
}

function toFields(definitions: readonly NumericFieldDefinition[]): NumericField[] {
  return definitions.map((definition) => ({ ...definition, source: definition.defaultSource }));
}

function togglesFor(step: NumericInputStep): readonly NumericToggle[] {
  if (isReferenceStep(step)) {
    // 基準ジオメトリの段は入切のつまみを持たない(構築線も楕円弧も関わらない、タスク13)。
    return [];
  }
  if (isEditStep(step)) {
    // オフセットはつまみを持たない(構築線にする欄はタスク33 のプロパティへ譲る)。
    // 複製系(タスク24)は**要素が履歴へ積まれる最後の段**にだけ構築線のつまみを置く。
    return EDIT_STEP_TOGGLE_KEYS[step].map((key) => ({
      key,
      labelKey: TOGGLE_LABEL_KEYS[key],
      value: TOGGLE_DEFAULT_VALUES[key],
    }));
  }
  const keys = isSolidStep(step) ? STEP_TOGGLE_KEYS[step] : SKETCH_STEP_TOGGLE_KEYS[step];
  return keys.map((key) => ({
    key,
    labelKey: TOGGLE_LABEL_KEYS[key],
    value: TOGGLE_DEFAULT_VALUES[key],
  }));
}

/** つまみの現在値。持たない段・持たないつまみは false 扱い(既定はすべて切のため)。 */
export function toggleValueOf(state: NumericInputState, key: NumericToggleKey): boolean {
  return state.toggles.find((toggle) => toggle.key === key)?.value ?? false;
}

/** ポップアップを開くときに外から渡せるもの。無くても既定で成り立つ(NFR-UX-4)。 */
export interface NumericInputOptions {
  readonly repeatAfterCommit?: boolean;
  readonly defaultSources?: NumericDefaultSources;
  readonly sweepGuides?: readonly NumericChoiceOption[];
  /**
   * 回転軸・パターンの向き・ばねの軸に選べるスケッチの線分(§0.a-0.9)。
   * 線分が選ばれているときだけタスク21 が渡し、渡されなければ軸は X / Y / Z だけになる。
   */
  readonly axisLine?: SketchLineRef;
  /**
   * 文書にある基準軸(FR-329、タスク13)。傾けの軸・座標系の 2 軸の選択肢に並べる。
   * 渡されなければワールドの X / Y / Z だけになる。
   */
  readonly referenceAxes?: readonly ReferenceAxisOption[];
  /**
   * オフセットの元が開いた曲線かどうか(FR-321、タスク21)。ツールバーが選択から見込んで
   * 渡す(`editCommands.ts` の `offsetContourIsOpen`)。渡されなければ閉じた輪郭として扱い、
   * 側の見出しは「外/内」になる。
   */
  readonly offsetOpenContour?: boolean;
  /**
   * ミラーで鏡にできるもの(FR-324、タスク24)。ツールバーが作図面と選択から見込んで渡す。
   * 渡されなければ `DEFAULT_MIRROR_AXES`(作図面の軸が使える)として扱う。
   */
  readonly mirrorAxes?: MirrorAxisOptions;
  /**
   * 3D スケッチ(作図面なし、FR-330)かどうか。複写の移動量の欄を 2 つ(作図面の 2 軸)に
   * するか 3 つ(ワールドの 3 成分)にするかだけに使う。渡されなければ作図面がある扱い。
   */
  readonly freeSketch?: boolean;
  /**
   * 面をつなぐ(FR-430、タスク27)で、選んだ断面に**球が含まれるか**(§0.a-0.87)。
   * ツールバーが選択から見込んで渡す(`ruledCommands.ts` の `ruledSelectionHasSphere`)。
   * 渡されなければ球を含まない扱いにして「なめらかさ」の選択肢を伏せる
   * (球を含まない断面では点の数が形に効かないため)。
   */
  readonly ruledHasSphere?: boolean;
}

export function createNumericInput(
  toolId: NumericInputToolId,
  step: NumericInputStep,
  mode: CoordinateMode = defaultModeForStep(step),
  options: NumericInputOptions = {},
): NumericInputState {
  const choices = choicesFor(step, options);
  const toggles = togglesFor(step);
  return {
    toolId,
    step,
    mode,
    ...(options.defaultSources === undefined ? {} : { defaultSources: options.defaultSources }),
    ...(options.repeatAfterCommit === undefined ? {} : { repeatAfterCommit: options.repeatAfterCommit }),
    // 段を開いた時点の選択肢・つまみで出す欄を決める(`visibleWhen`、タスク49)。
    fields: toFields(
      applyNumericDefaultSources(step, mode,
        visibleDefinitions(definitionsFor(step, mode, choices, options), choices, toggles), options.defaultSources),
    ),
    focusedIndex: 0,
    toggles,
    choices,
    axisLine: options.axisLine,
    referenceAxes: options.referenceAxes,
  };
}

/** 状態を進める間に端末設定を読み直さず、開始時の既定値を保つ。 */
function createNextNumericInput(state: NumericInputState, step: NumericInputStep,
  mode?: CoordinateMode, options: NumericInputOptions = {}): NumericInputState {
  return createNumericInput(state.toolId, step, mode, { ...options, defaultSources: state.defaultSources,
    ...(state.repeatAfterCommit === undefined ? {} : { repeatAfterCommit: state.repeatAfterCommit }) });
}

/** 設定画面も実際の入力と同じ欄・範囲を読む。選択肢で現れる欄も含める。 */
export function numericDefaultDefinitions(step: NumericInputStep, mode: CoordinateMode): readonly NumericFieldDefinition[] {
  const choices = choicesFor(step, {});
  const variants = [choices, ...choices.flatMap(choice => choice.options.map(option =>
    choices.map(item => item.key === choice.key ? { ...item, value: option.value } : item)))];
  // 3D複写の3成分も設定できるようにし、表示条件や選択の意味は変更しない。
  const byKey = new Map<string, NumericFieldDefinition>();
  for (const variant of variants) {
    for (const field of definitionsFor(step, mode, variant, { freeSketch: true })) {
      if (!byKey.has(field.key)) byKey.set(field.key, field);
    }
  }
  return [...byKey.values()];
}

/**
 * 整形系の 2 段目を、1 段目(state)の入力を持ち越して開く(P4 タスク24)。
 * ばねの `springLengthStateFrom` と同じ役目で、**位置の決め方(mode)も持ち越す**のが違う
 * (円形配列の 1 段目は座標を聞くので、2 段目で中心を組み立て直すのに要る)。
 */
function editStage2StateFrom(
  state: NumericInputState,
  step: EditNumericInputStep,
): NumericInputState {
  const next = createNextNumericInput(state, step);
  return {
    ...next,
    previousStage: state,
    carriedStage1: { fields: state.fields, choices: state.choices, mode: state.mode },
  };
}

/**
 * ばねの2段目(springLength)の初期状態を、1段目(state)の入力を持ち越して作る
 * (§2.11「1段目の値は2段目へ持ち越す」)。springLength 自体は軸の選択肢を持たないので
 * axisLine は渡さず、carriedStage1 の中だけに残す。
 */
function springLengthStateFrom(state: NumericInputState): NumericInputState {
  return solidStage2StateFrom(state, 'springLength');
}

/**
 * 2 段で聞く立体の道具の 1 段目 → 2 段目(P3 のばね、P5 タスク49 の移動/回転)。
 *
 * 1 段目の欄・選択肢・選んだ線分を持ち越し、2 段目の確定でまとめて 1 つの
 * `SolidInputCommit` にする(§2.11「1段目の値は2段目へ持ち越す」)。2 段目そのものが
 * 軸の選択肢を持つ場合もあるので、`axisLine` は `carriedStage1` の中にも残す。
 */
function solidStage2StateFrom(
  state: NumericInputState,
  step: SolidNumericInputStep,
): NumericInputState {
  const next = createNextNumericInput(state, step, undefined, { axisLine: state.axisLine });
  return {
    ...next,
    previousStage: state,
    carriedStage1: { fields: state.fields, choices: state.choices, axisLine: state.axisLine },
  };
}

/**
 * 立体の道具で「1 段目を確定したら次に開く段」(P3 のばね、P5 タスク49 の移動/回転)。
 * ここに無い段は 1 段で終わる。表にしてあるのは、2 段の道具が 2 つになったときに
 * `commitNumericInput` と `nextNumericInput` で同じ条件を 2 度書かないため。
 */
const SOLID_SECOND_STEPS: Readonly<Partial<Record<SolidNumericInputStep, SolidNumericInputStep>>> =
  {
    springShape: 'springLength',
    transformTranslation: 'transformRotation',
  };

/**
 * スプラインの点を置き終えて「決め方」の段(splineShape)を開く(FR-317)。
 *
 * ばねの `springLengthStateFrom` と同じ役目だが、ばねと違って点の数が決まっていないので
 * 段の遷移(`nextNumericInput`)からは開かない。タスク12 が「点を置き終えた」合図
 * (ツールバーの決定・二重クリック等)を受けてここを呼ぶ。
 */
export function splineFinishStateFrom(state: NumericInputState): NumericInputState {
  return createNextNumericInput(state, 'splineShape');
}

/**
 * 基準ジオメトリの次の段を開く(タスク13)。軸の一覧(`referenceAxes`)を持ち越すためだけの
 * 薄い包み。段ごとに `createNumericInput` を素で呼ぶと一覧が空になり、原点の次の段で
 * 基準軸が選べなくなる。
 */
function referenceStep(
  state: NumericInputState,
  step: ReferenceNumericInputStep,
): NumericInputState {
  return createNextNumericInput(state, step, undefined, {
    referenceAxes: state.referenceAxes,
  });
}

/** 焦点が当たれる場所。並びは「欄 → 選択肢(順に)→ つまみ」で、画面の並びと同じにする。 */
export type NumericFocusTarget =
  | { readonly kind: 'field'; readonly index: number }
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'toggle'; readonly index: number };

/** Tab で巡る輪。P1 の段は欄しか無いので、輪の添字は欄の添字と一致する。 */
export function numericToggleEnabled(state: NumericInputState, key: NumericToggleKey): boolean {
  if (key !== 'sweepFrenet') return true;
  const guide = state.choices.find((choice) => choice.key === 'sweepGuide')?.value;
  return guide === undefined || guide === 'none';
}

export function numericFocusTargets(state: NumericInputState): readonly NumericFocusTarget[] {
  const targets: NumericFocusTarget[] = state.fields.map((_field, index) => ({
    kind: 'field',
    index,
  }));
  state.choices.forEach((_choice, index) => {
    targets.push({ kind: 'choice', index });
  });
  state.toggles.forEach((toggle, index) => {
    if (numericToggleEnabled(state, toggle.key)) targets.push({ kind: 'toggle', index });
  });
  return targets;
}

/** いま焦点が当たっている場所。輪の外を指していれば null。 */
export function focusedTarget(state: NumericInputState): NumericFocusTarget | null {
  return numericFocusTargets(state)[state.focusedIndex] ?? null;
}

function moveChoiceValue(choice: NumericChoice, backwards: boolean): string {
  const count = choice.options.length;
  const current = choice.options.findIndex((option) => option.value === choice.value);
  const next = ((backwards ? current - 1 : current + 1) + count) % count;
  return choice.options[next].value;
}

/** 欄の並びが変わっても、同じ key の欄は入力値を引き継ぐ。新しい欄は既定値(§2.11)。 */
function mergeFieldValues(
  previous: readonly NumericField[],
  definitions: readonly NumericFieldDefinition[],
): NumericField[] {
  return definitions.map((definition) => {
    const existing = previous.find((field) => field.key === definition.key);
    return existing === undefined
      ? { ...definition, source: definition.defaultSource }
      : { ...definition, source: existing.source, typed: existing.typed, mathValue: existing.mathValue };
  });
}

/**
 * 欄の数が変わったあと、輪の中で焦点が指す先を保つ(NFR-UX-2)。
 * ばねの長さ(springLength)は欄が常に2つのままなので実際には呼ばれないが、
 * C面取り(chamferSize)は「等距離」で欄が1つに減るため、輪の長さそのものが変わる
 * (§2.11・統括の判断「等距離のときは距離2 の欄を出さない」)。
 * 選択肢・つまみに焦点があったときはその同じ選択肢・つまみを指し直し、欄に
 * 焦点があったときは新しい欄の範囲へ収める(消えた欄を指し続けないようにする)。
 */
function reindexFocusAfterFieldCountChange(
  state: NumericInputState,
  newFieldsCount: number,
): number {
  const target = focusedTarget(state);
  if (target === null) {
    return 0;
  }
  switch (target.kind) {
    case 'field':
      return Math.min(target.index, Math.max(newFieldsCount - 1, 0));
    case 'choice':
      return newFieldsCount + target.index;
    case 'toggle':
      return newFieldsCount + state.choices.length + target.index;
  }
}

/**
 * 選んだ値で欄の並びが変わる段(C面取り・ばねの長さ・P4 の点列の並べ方)。
 * ここに無い段は選択肢を変えても欄が変わらない。
 */
const CHOICE_DEPENDENT_STEPS: Readonly<Partial<Record<NumericInputStep, true>>> = {
  chamferSize: true,
  springLength: true,
  // 直線(角度・間隔・個数)/ 円周(半径・個数)/ 格子(行の間隔・行数)で欄が入れ替わる。
  pointArrayShape: true,
  // 「軸に垂直」を選んだときだけ傾き角・方位角の欄が出る(タスク13)。
  referencePlaneThrough: true,
  // 「等距離」で 1 欄、「2つの距離」で 2 欄になる(タスク23)。
  sketchChamferSize: true,
  /*
    P5 タスク49。ここに挙げた段だけが選択肢で欄を入れ替える(`visibleWhen`)。
    表へ足し忘れると「選んだのに欄が変わらない」ので、`visibleWhen` を選択肢で書いた段は
    必ずここへも足す。**表を持たずに毎回組み直さない**のは、欄の並びが `options`
    (3D スケッチか・オフセットの元が開いているか)にも依るためで、`options` を持たない
    ここで組み直すと複写の 3 つ目の欄が消えてしまう。
  */
  extrudeDistance: true,
  holeSize: true,
  surfaceShape: true,
  cutPlane: true,
};

/**
 * つまみの入切で欄の並びが変わる段(P5 タスク49)。`CHOICE_DEPENDENT_STEPS` の
 * つまみ版で、役目も足し忘れたときの症状も同じ。
 */
const TOGGLE_DEPENDENT_STEPS: Readonly<Partial<Record<NumericInputStep, true>>> = {
  // 「軸ごと」で倍率の欄が 1 つ ↔ 3 つに入れ替わる(§2.15)。
  scaleAmount: true,
  // 「終わりを別の半径に」で終わりの半径の欄が出る(FR-426。タスク50 で R 面取りへ畳んだ)。
  filletRadius: true,
  // 「側面を傾ける」で傾きの欄、「薄板にする」で厚みの欄が出る(タスク50)。
  extrudeDistance: true,
};

/**
 * 選択肢の値を更新したあと、欄の並びがその選択肢に依存する段(C面取り・ばねの長さ・点列)だけ
 * 欄を組み替える。ばねの長さは欄が常に2つのままなので焦点の位置(focusedIndex)は
 * 動かさなくてよいが、C面取りは「等距離」で欄が1つに減り、点列は直線(3欄)と円周・格子(2欄)で
 * 数が変わるため、欄の数が変わったときだけ reindexFocusAfterFieldCountChange で
 * 輪の中の焦点を指し直す。
 */
function applyChoiceToFields(
  state: NumericInputState,
  choices: readonly NumericChoice[],
): NumericInputState {
  if (CHOICE_DEPENDENT_STEPS[state.step] !== true) {
    return { ...state, choices };
  }
  return { ...rebuiltFields(state, choices, state.toggles), choices };
}

/**
 * つまみを切り替えたあと、欄の並びがそのつまみに依存する段(拡大縮小・可変半径の R 面取り)
 * だけ欄を組み替える(P5 タスク49)。`applyChoiceToFields` のつまみ版。
 */
function applyToggleToFields(
  state: NumericInputState,
  toggles: readonly NumericToggle[],
): NumericInputState {
  if (TOGGLE_DEPENDENT_STEPS[state.step] !== true) {
    return { ...state, toggles };
  }
  return { ...rebuiltFields(state, state.choices, toggles), toggles };
}

/**
 * 新しい選択肢・つまみで欄を組み直し、入力済みの値と輪の中の焦点を保つ(P5 タスク49)。
 * 選択肢版とつまみ版で同じことを 2 度書かないための共通部分。
 */
function rebuiltFields(
  state: NumericInputState,
  choices: readonly NumericChoice[],
  toggles: readonly NumericToggle[],
): NumericInputState {
  const definitions = visibleDefinitions(
    definitionsFor(state.step, state.mode, choices),
    choices,
    toggles,
  );
  const fields = mergeFieldValues(state.fields,
    applyNumericDefaultSources(state.step, state.mode, definitions, state.defaultSources));
  const focusedIndex =
    fields.length === state.fields.length
      ? state.focusedIndex
      : reindexFocusAfterFieldCountChange(state, fields.length);
  return { ...state, fields, focusedIndex };
}

/** 欄の操作を 1 つ受けて次の状態を返す。副作用を持たないのでそのまま検査できる。 */
export function reduceNumericInput(
  state: NumericInputState,
  event: NumericInputEvent,
): NumericInputState {
  switch (event.type) {
    case 'edit': {
      if (event.index < 0 || event.index >= state.fields.length) {
        return state;
      }
      const fields = state.fields.map((field, index) =>
        // 打った欄だけ `typed` が立つ(表示が inch のときここだけが `(…)in` で包まれる)。
        index === event.index ? { ...field, source: event.source, typed: true, mathValue: undefined } : field,
      );
      return { ...state, fields, focusedIndex: event.index };
    }
    case 'focus': {
      if (event.index < 0 || event.index >= numericFocusTargets(state).length) {
        return state;
      }
      return { ...state, focusedIndex: event.index };
    }
    case 'tab': {
      const count = numericFocusTargets(state).length;
      // 最後の欄で Tab を押しても外へ出さず、先頭へ戻す(NFR-UX-2)。
      const next = event.backwards
        ? (state.focusedIndex - 1 + count) % count
        : (state.focusedIndex + 1) % count;
      return { ...state, focusedIndex: next };
    }
    case 'setMode': {
      if (!asksCoordinate(state.step) || state.mode === event.mode) {
        return state;
      }
      // モードが変わると欄の意味が変わるので、入力は引き継がず既定値へ戻す(§2.9)。
      return {
        ...state,
        mode: event.mode,
        fields: toFields(applyNumericDefaultSources(state.step, event.mode,
          definitionsFor(state.step, event.mode, state.choices), state.defaultSources)),
        focusedIndex: 0,
      };
    }
    case 'setValues': {
      const fields = state.fields.map((field, index) => {
        const value = event.values[index];
        // 吸い付いた座標は**内部の mm**なので、打った文字の印(`typed`)を必ず落とす。
        // 落とさないと、直前に打った欄へ吸い付いた値が入ったときに inch として包まれる。
        return value === undefined
          ? field
          : { ...field, source: expressionValueFromNumber(value).source, typed: false, mathValue: undefined };
      });
      return { ...state, fields };
    }
    case 'toggle': {
      if (!numericToggleEnabled(state, event.key)) return state;
      if (!state.toggles.some((toggle) => toggle.key === event.key)) {
        return state;
      }
      const toggles = state.toggles.map((toggle) =>
        toggle.key === event.key ? { ...toggle, value: !toggle.value } : toggle,
      );
      // つまみで欄が出入りする段(拡大縮小・可変半径の R 面取り)だけ欄を組み直す。
      return applyToggleToFields(state, toggles);
    }
    case 'choose': {
      const target = state.choices.find((choice) => choice.key === event.key);
      if (
        target === undefined ||
        target.value === event.value ||
        !target.options.some((option) => option.value === event.value)
      ) {
        return state;
      }
      const choices = state.choices.map((choice) =>
        choice.key === event.key ? { ...choice, value: event.value } : choice,
      );
      return applyChoiceToFields(state, choices);
    }
    case 'moveChoice': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'choice') {
        return state;
      }
      const choice = state.choices[target.index];
      if (choice === undefined || choice.options.length < 2) {
        return state;
      }
      const value = moveChoiceValue(choice, event.backwards);
      const choices = state.choices.map((entry, index) =>
        index === target.index ? { ...entry, value } : entry,
      );
      return applyChoiceToFields(state, choices);
    }
  }
}

/** つまみを入切する(§0.a-0.8)。持っていないつまみを指したときは何も起きない。 */
export function toggleNumericInput(
  state: NumericInputState,
  key: NumericToggleKey,
): NumericInputState {
  return reduceNumericInput(state, { type: 'toggle', key });
}

/** 選択肢を選ぶ(§0.a-0.9、§2.11)。選択肢に無い値、持っていないつまみは無視する。 */
export function chooseNumericInput(
  state: NumericInputState,
  key: NumericChoiceKey,
  value: string,
): NumericInputState {
  return reduceNumericInput(state, { type: 'choose', key, value });
}

function choiceValueFrom(choices: readonly NumericChoice[], key: NumericChoiceKey): string | undefined {
  return choices.find((choice) => choice.key === key)?.value;
}

/** 指定したつまみの現在値。持たない・見つからないときは null。 */
export function choiceValueOf(state: NumericInputState, key: NumericChoiceKey): string | null {
  return choiceValueFrom(state.choices, key) ?? null;
}

/**
 * 3 つの評価値から 1 点の指定を組み立てる(FR-301〜303)。
 * 式は文字列のまま、評価値と対で持つ(FR-202)。欄が足りなければ null を返す。
 */
export function buildCoordinateInput(
  mode: CoordinateMode,
  values: readonly ExpressionValue[],
  base: PointReference,
): CoordinateInput | null {
  const first = values[0];
  const second = values[1];
  const third = values[2];
  if (first === undefined || second === undefined || third === undefined) {
    return null;
  }
  switch (mode) {
    case 'absolute':
      return { mode: 'absolute', x: first, y: second, z: third };
    case 'relative':
      return { mode: 'relative', base, dx: first, dy: second, dz: third };
    case 'polar':
      return { mode: 'polar', base, distance: first, azimuth: second, elevation: third };
  }
}

/** 点列の並べ方(FR-327)。model の `PointArrayLayout` の種類と同じ 3 つ。 */
export type PointArrayLayoutChoice = 'linear' | 'circular' | 'grid';

/**
 * スケッチの段のつまみ(P4 タスク11)。持たない段では入らない。
 * 確定を受けるタスク12 は `commit.flags.construction ?? false` のように読む。
 */
export interface SketchCommitFlags {
  /** 構築線にするか(FR-320)。 */
  readonly construction?: boolean;
  /** 確定した線分の交点を共有点でつなぎ、区間ごとに編集できるようにする。 */
  readonly splitIntersections?: boolean;
  /** 楕円を一部だけ(楕円弧)にするか(FR-318)。 */
  readonly ellipseArc?: boolean;
  /** スプラインを閉じるか(FR-317)。 */
  readonly splineClosed?: boolean;
}

/** スケッチの段の選択肢(P4 タスク11)。持たない段では入らない。 */
export interface SketchCommitChoices {
  /** 正多角形の半径の測り方(FR-315)。 */
  readonly polygonRadiusMode?: 'circumscribed' | 'inscribed';
  /** 点列の並べ方(FR-327)。 */
  readonly pointArrayLayout?: PointArrayLayoutChoice;
  /** スプラインの点の使い方(FR-317)。 */
  readonly splineMode?: 'interpolate' | 'control';
  /** 2 点+半径の円弧のふくらむ向き(FR-326)。 */
  readonly arcBulge?: 'left' | 'right';
}

/**
 * 決めた後に外へ渡すもの(スケッチ)。座標を聞く段階かどうかで中身が変わる。
 * ソリッドの確定は形が違うので SolidInputCommit で別に返す。
 *
 * P4 タスク11 で `flags` / `choices` を両方の形へ足した。矩形のように**最後の段が座標**の
 * 道具があり(2 つ目の角で確定する)、構築線のつまみを座標の段にも置く必要があるため。
 */
export type NumericInputCommit =
  | {
      readonly kind: 'coordinate';
      readonly step: CoordinateNumericInputStep;
      readonly mode: CoordinateMode;
      readonly coordinate: CoordinateInput;
      /** 欄の並び順の評価値。`valueByFieldKey` で名前から引ける。 */
      readonly values: readonly ExpressionValue[];
      readonly flags: SketchCommitFlags;
      readonly choices: SketchCommitChoices;
    }
  | {
      readonly kind: 'shape';
      readonly step: ShapeNumericInputStep;
      readonly values: readonly ExpressionValue[];
      readonly flags: SketchCommitFlags;
      readonly choices: SketchCommitChoices;
    };

/** ソリッドの数値。道具ごとに使う欄だけが入る(§2.11 の表)。 */
export interface SolidCommitValues {
  /** 押し出しの長さ(mm)。 */
  readonly distance?: ExpressionValue;
  /** 回転の角度(度)。 */
  readonly angle?: ExpressionValue;
  /** 縫合の許容量(mm)。 */
  readonly tolerance?: ExpressionValue;
  /** 穴・ねじ穴の直径(mm)。 */
  readonly diameter?: ExpressionValue;
  /** 穴・ねじ穴の深さ(mm)。 */
  readonly depth?: ExpressionValue;
  /** R面取りの半径(mm)。 */
  readonly radius?: ExpressionValue;
  /** C面取りの距離(mm)。 */
  readonly chamferDistance?: ExpressionValue;
  /** C面取りの距離2(mm)。2距離のときだけ。 */
  readonly chamferDistance2?: ExpressionValue;
  /** C面取りの角度(度)。距離と角度のときだけ。 */
  readonly chamferAngle?: ExpressionValue;
  /** ねじ穴のねじ部の長さ(mm)。 */
  readonly threadLength?: ExpressionValue;
  /** 直線パターンの間隔(mm)。 */
  readonly spacing?: ExpressionValue;
  /** パターンの個数(直線・円形とも)。 */
  readonly count?: ExpressionValue;
  /** ばねのコイル径(mm、FR-414)。 */
  readonly coilDiameter?: ExpressionValue;
  /** ばねの線径(mm)。 */
  readonly wireDiameter?: ExpressionValue;
  /** ばねのピッチ(mm)。求める値が「ピッチ」のときは入らない。 */
  readonly springPitch?: ExpressionValue;
  /** ばねの巻数。求める値が「巻数」のときは入らない。 */
  readonly springTurns?: ExpressionValue;
  /** ばねの全長(mm)。求める値が「全長」のときは入らない。 */
  readonly springLength?: ExpressionValue;
  /*
    基本形状5種の寸法(FR-429、タスク18)。**欄の名前を形ごとに分けてある**のは、
    `radius` / `height` を共用すると `solidValuesFor` が「どの形の半径か」を型で示せず、
    `commitPrimitive` の組み立てで取り違えが起きうるため(C 面取りの距離と同じ考え方)。
  */
  /** 球の半径(mm)。 */
  readonly sphereRadius?: ExpressionValue;
  /** 箱の X / Y / Z の長さ(mm)。 */
  readonly boxSizeX?: ExpressionValue;
  readonly boxSizeY?: ExpressionValue;
  readonly boxSizeZ?: ExpressionValue;
  /** 円柱の半径・高さ(mm)。 */
  readonly cylinderRadius?: ExpressionValue;
  readonly cylinderHeight?: ExpressionValue;
  /** 円錐の下半径・上半径・高さ(mm)。上半径は 0 でよい(尖った円錐)。 */
  readonly coneBottomRadius?: ExpressionValue;
  readonly coneTopRadius?: ExpressionValue;
  readonly coneHeight?: ExpressionValue;
  /** トーラスの主半径・管の半径(mm)。 */
  readonly torusMajorRadius?: ExpressionValue;
  readonly torusMinorRadius?: ExpressionValue;
  /**
   * 球面上の点の緯度・経度(度。FR-431、タスク22)。緯度は −90〜90、経度は 360 で回る。
   * 名前を `latitude` / `longitude` と分けてあるのは、他の角度の欄(`angle`)と
   * 取り違えないため(基本形状の半径を形ごとに分けてあるのと同じ考え方)。
   */
  readonly latitude?: ExpressionValue;
  readonly longitude?: ExpressionValue;
  /**
   * 面をつなぐ・ロフトのねじれの補正(個。FR-430、FR-410、§0.a-0.28)。
   * 2 つの道具で意味も単位も同じなので欄の名前も 1 つにする(基本形状の半径のように
   * 「どの形の値か」で取り違える余地が無い)。
   */
  readonly ruledTwist?: ExpressionValue;
  /*
    P5 の Should / Could 群(タスク49)。**欄の名前をそのまま欄の名前にする**
    (基本形状と同じ考え方。`distance` / `radius` / `angle` のような共通の名前を使い回すと、
    確定側でどの道具の値か型で示せず、取り違えが起きうる)。
    隠れている欄(`visibleWhen` が false)は状態の `fields` に無いので、ここにも入らない。
  */
  /** 押し出しの側面の傾き(度、FR-401)。 */
  readonly taperAngle?: ExpressionValue;
  /** 薄板押し出しの厚み(mm、FR-416)。 */
  readonly thickness?: ExpressionValue;
  /** 抜き勾配の角度(度、FR-417)。 */
  readonly draftAngle?: ExpressionValue;
  /** 移動の量(mm、FR-424)。X / Y / Z の 3 つ。 */
  readonly translationX?: ExpressionValue;
  readonly translationY?: ExpressionValue;
  readonly translationZ?: ExpressionValue;
  /** 回す角度(度、FR-424)。 */
  readonly rotationAngle?: ExpressionValue;
  /** 拡大縮小の倍率(FR-424)。「軸ごと」が切なら scaleFactor、入なら X / Y / Z が入る。 */
  readonly scaleFactor?: ExpressionValue;
  readonly scaleX?: ExpressionValue;
  readonly scaleY?: ExpressionValue;
  readonly scaleZ?: ExpressionValue;
  /** リブの厚み(mm、FR-420)。 */
  readonly ribThickness?: ExpressionValue;
  /** エンボスの高さ(mm、FR-421)。彫るときは深さ。 */
  readonly embossHeight?: ExpressionValue;
  /** ざぐりの径・深さ(mm、FR-422)。入口が「ざぐり」のときだけ。 */
  readonly counterboreDiameter?: ExpressionValue;
  readonly counterboreDepth?: ExpressionValue;
  /** 皿もみの頭径(mm)・開き角(度、FR-422)。入口が「皿もみ」のときだけ。 */
  readonly countersinkDiameter?: ExpressionValue;
  readonly countersinkAngle?: ExpressionValue;
  /** 外ねじのピッチ・長さ(mm、FR-423)。 */
  readonly threadShaftPitch?: ExpressionValue;
  readonly threadShaftLength?: ExpressionValue;
  /** 曲面の距離(mm)・角度(度)・離す距離(mm、FR-428)。作り方で入るものが変わる。 */
  readonly surfaceDistance?: ExpressionValue;
  readonly surfaceAngle?: ExpressionValue;
  readonly surfaceOffset?: ExpressionValue;
  /** くり抜きの壁の厚さ(mm、FR-418)。 */
  readonly shellThickness?: ExpressionValue;
  /** 可変半径の R 面取りの終わり側の半径(mm、FR-426)。つまみが入のときだけ。 */
  readonly filletRadiusEnd?: ExpressionValue;
  /** 切断面の傾き(度、FR-432)。決め方が「点と軸」のときだけ。 */
  readonly cutTilt?: ExpressionValue;
}

/** ソリッドのつまみ。持たない道具では欄ごと現れない。 */
export interface SolidCommitFlags {
  /** 向きを反転するか(押し出し・回転)。 */
  readonly reversed?: boolean;
  /** 両側へ出すか(押し出しだけ)。 */
  readonly symmetric?: boolean;
  /** 貫通させるか(穴・ねじ穴)。 */
  readonly through?: boolean;
  /** 実際のねじ山を作るか(ねじ穴。false なら簡略表示)。 */
  readonly modeledThread?: boolean;
  /** 両側へ並べるか(直線パターン)。 */
  readonly patternSymmetric?: boolean;
  /** 全周へ等間隔で並べるか(円形パターン)。 */
  readonly fullCircle?: boolean;
  /* ---- P5 の Should / Could 群(タスク49、§2.15 の段の表) ---- */
  /** 押し出しの側面を傾けるか(FR-401)。切なら傾き 0 の押し出し。 */
  readonly tapered?: boolean;
  /** 押し出しの側面の傾きを外へ広げるか(FR-401)。 */
  readonly taperOutward?: boolean;
  /** 押し出しを薄板にするか(FR-416)。切なら中身の詰まった押し出し。 */
  readonly thinWalled?: boolean;
  /** スイープで断面を曲がりに合わせて回すか(FR-409)。 */
  readonly sweepFrenet?: boolean;
  readonly loftSmooth?: boolean;
  /** エンボスを浮き出すか(FR-421)。切なら彫る。 */
  readonly raised?: boolean;
  /** 拡大縮小を軸ごとの倍率にするか(FR-424)。 */
  readonly scalePerAxis?: boolean;
  /** くり抜きの肉を外向きに付けるか(FR-418)。 */
  readonly shellOutward?: boolean;
  /** R 面取りの終わり側を別の半径にするか(FR-426)。 */
  readonly variableRadius?: boolean;
  /** 切断で法線の反対側を残すか(FR-432、§0.a-0.57)。 */
  readonly cutKeepOpposite?: boolean;
  /** 切断で両側とも残すか(§0.a-0.58)。 */
  readonly cutKeepBoth?: boolean;
}

/**
 * ソリッドを決めたときに外へ渡すもの(§0.a-0.7 / 0.8 / 0.9、P3 §2.11)。
 * タスク21・タスク25・タスク25b がこれを受け取る。
 */
export interface SolidInputCommit {
  readonly kind: 'solid';
  readonly tool: SolidToolId;
  readonly step: SolidNumericInputStep;
  readonly values: SolidCommitValues;
  readonly flags: SolidCommitFlags;
  /**
   * 回転・パターン・ばねのときだけ入る(計画書の注釈は「回転・パターンのときだけ」だが、
   * タスク25b の commitSpring が axis を必須で要求するため、ばねにも入れた。
   * 判断に迷った点として報告する)。
   */
  readonly axis?: RevolveAxis;
  /** ねじ穴のときだけ入る。 */
  readonly threadDesignation?: string;
  readonly threadSeries?: ThreadSeries;
  /** C面取りのときだけ入る。 */
  readonly chamferMode?: ChamferSize['kind'];
  /** ばねのときだけ入る(FR-414)。 */
  readonly springHandedness?: SpringHandedness;
  readonly springDerived?: SpringDerived;
  /**
   * 面をつなぐで**球を含む断面を選んだときだけ**入る(FR-430、§0.a-0.74)。
   * 球を含まないときは選択肢そのものを出さないので undefined になり、確定側は既定
   * (`DEFAULT_RULED_SPHERE_SEGMENTS`)を使う。
   */
  readonly ruledSphereSegments?: RuledSphereSegments;
  /**
   * P5 の Should / Could 群の選択肢(タスク49、§2.15 の段の表)。
   *
   * **値は選択肢の文字列そのまま**で渡し、model の型(`ExtrudeEnd` / `ThicknessSide` /
   * `MirrorPlane` / `RibSide` / `HoleEntry` / `SurfaceOperation` / `PlaneSpec`)への
   * 読み替えは確定側(タスク50、切断はタスク27e)が行う。基準ジオメトリの
   * `ReferenceCommitChoices` と同じ約束で、そちらと同じ理由——選択肢の値から形を
   * 組み立てる規則は「作る側」に 1 か所だけ置き、段の側は文字列を運ぶだけにする。
   */
  readonly shapeChoices?: SolidShapeChoices;
}

/** P5 の Should / Could 群の選択肢の値(タスク49)。持たない段では欄ごと入らない。 */
export interface SolidShapeChoices {
  readonly sweepGuide?: string;
  /** 押し出しの終わり方('distance' / 'toFace' / 'toNext')。 */
  readonly extrudeEnd?: string;
  /** 薄板押し出しの厚みを付ける側('inner' / 'outer' / 'both')。 */
  readonly thicknessSide?: string;
  /** ミラーの鏡にする面('xy' / 'xz' / 'yz' / 'face')。 */
  readonly mirrorPlane?: string;
  /** リブの厚みを付ける側('both' / 'positive' / 'negative')。 */
  readonly ribSide?: string;
  /** 穴の入口('plain' / 'counterbore' / 'countersink')。 */
  readonly holeEntry?: string;
  /** 外ねじを切り始める端('first' / 'last')。 */
  readonly threadShaftEnd?: string;
  /** 曲面の作り方('extrude' / 'revolve' / 'planar' / 'loft' / 'face' / 'offset')。 */
  readonly surfaceOperation?: string;
  /** 切断面の決め方('xy' / 'xz' / 'yz' / 'face' / 'threePoints' / 'pointAndEdge' / 'pointAndAxis')。 */
  readonly cutPlaneKind?: string;
}

/** 基準ジオメトリの数値(P4 タスク13)。段ごとに使う欄だけが入る。 */
export interface ReferenceCommitValues {
  /** もとにする面から離す距離(mm、FR-328)。 */
  readonly offset?: ExpressionValue;
  /** 軸のまわりに傾ける角度(度、FR-328)。 */
  readonly angle?: ExpressionValue;
  /** 軸に垂直な平面をさらに倒す傾き角(度)。 */
  readonly tilt?: ExpressionValue;
  /** 倒す向き(方位角、度)。 */
  readonly azimuth?: ExpressionValue;
}

/**
 * 基準ジオメトリの選択肢(P4 タスク13)。値は選択肢の文字列そのままで、
 * `PlaneSpec` / `ReferenceAxisDefinition` への組み立ては `referenceCommands.ts` が行う
 * (「確定側で value から引き直す」§2.11 と同じ約束)。
 */
export interface ReferenceCommitChoices {
  readonly planeBase?: string;
  readonly axis?: string;
  readonly throughMode?: string;
  readonly axisKind?: string;
  readonly pointKind?: string;
  readonly csXAxis?: string;
  readonly csYAxis?: string;
}

/**
 * 基準ジオメトリを決めたときに外へ渡すもの(P4 タスク13、FR-328、FR-329)。
 * 積む先がスケッチではなく部品文書なので、`NumericInputCommit` とは別の形にする。
 */
export interface ReferenceInputCommit {
  readonly kind: 'reference';
  readonly tool: ReferenceToolId;
  readonly step: ReferenceNumericInputStep;
  /** 座標を聞く段のときだけ入る。 */
  readonly coordinate: CoordinateInput | null;
  readonly mode: CoordinateMode | null;
  readonly values: ReferenceCommitValues;
  readonly choices: ReferenceCommitChoices;
}

/** 整形系の道具の数値(P4 タスク21〜24)。段ごとに使う欄だけが入る。 */
export interface EditCommitValues {
  /** オフセットの距離(mm、FR-321)。 */
  readonly distance?: ExpressionValue;
  /* ---- P4 タスク24: 複製系(FR-324) ---- */
  /** 複写の移動量。作図面の第1軸ぶん(3D スケッチではワールドの X)。 */
  readonly dx?: ExpressionValue;
  /** 複写の移動量。作図面の第2軸ぶん(3D スケッチではワールドの Y)。 */
  readonly dy?: ExpressionValue;
  /** 複写の移動量。3D スケッチのときだけ入る(ワールドの Z)。 */
  readonly dz?: ExpressionValue;
  /** 直線配列の向き / 円形配列の全体の角度(度)。 */
  readonly angle?: ExpressionValue;
  /** 直線配列の間隔(mm)。 */
  readonly spacing?: ExpressionValue;
  /** 配列複写の個数(もとを含めた総数)。 */
  readonly count?: ExpressionValue;
  /* ---- P4 タスク23: 角の丸め・面取り(FR-323) ---- */
  /** 角を丸める半径(mm)。 */
  readonly cornerRadius?: ExpressionValue;
  /** 角から 1 本目の線に沿って削る距離(mm)。 */
  readonly cornerDistance1?: ExpressionValue;
  /** 角から 2 本目の線に沿って削る距離(mm)。等距離のときは欄が無く undefined。 */
  readonly cornerDistance2?: ExpressionValue;
}

/**
 * 整形系の道具の選択肢(P4 タスク21〜24)。値は選択肢の文字列そのままで、`editCommands.ts`
 * が組み立て直す(§2.11「確定側で value から引き直す」と同じ約束)。
 */
export interface EditCommitChoices {
  /** オフセットの側('outside' | 'inside'、FR-321)。 */
  readonly side?: string;
  /** オフセットの角の作り方('round' | 'sharp')。 */
  readonly corner?: string;
  /** 鏡にするもの('axisU' | 'axisV' | 'line'、FR-324)。 */
  readonly mirrorBasis?: string;
  /** 角の面取りの決め方('equal' | 'twoDistances'、FR-323、タスク23)。 */
  readonly chamferMode?: string;
}

/**
 * 整形系の道具のつまみ(P4 タスク21〜24)。スケッチのつまみ(構築線)に、複製系だけが持つ
 * 「全周」を足したもの。スケッチの確定(`SketchCommitFlags`)へ全周を混ぜないために分けた。
 */
export interface EditCommitFlags extends SketchCommitFlags {
  /** 円形配列を全周へ等間隔で並べるか(FR-324)。既定は入。 */
  readonly fullCircle?: boolean;
}

/**
 * 整形系の道具を決めたときに外へ渡すもの(P4 タスク21〜24、FR-321〜324)。積む先は
 * スケッチだが、選択から作る構図が `NumericInputCommit` の座標/形の段と違う
 * (対象はすでに選ばれている、§2.5)ので別の形にする。`flags` は構築線のつまみを
 * 将来の段(タスク23 のフィレット等)でも使えるよう `SketchCommitFlags` を再利用する。
 */
export interface EditInputCommit {
  readonly kind: 'edit';
  readonly tool: EditToolId;
  readonly step: EditNumericInputStep;
  readonly values: EditCommitValues;
  readonly flags: EditCommitFlags;
  readonly choices: EditCommitChoices;
  /**
   * 座標を聞く段で決めた 1 点(P4 タスク24)。いまは円形配列の中心だけで、2 段目の確定に
   * 1 段目(`carriedStage1`)の欄から組み立て直したものが入る。持たない道具では undefined。
   */
  readonly coordinate?: CoordinateInput;
}

/** ポップアップが返しうる確定結果のすべて。 */
export type AnyNumericInputCommit =
  | NumericInputCommit
  | SolidInputCommit
  | ReferenceInputCommit
  | EditInputCommit;

/**
 * 「決め方」の段(splineShape)の確定を下書きへ写す(FR-317)。
 * 選ばれていない項目は今の下書きの値を残す(NFR-UX-4)。
 */
export function applySplineShapeCommit(
  draft: SplineDraft,
  commit: NumericInputCommit,
): SplineDraft {
  if (commit.step !== 'splineShape') {
    return draft;
  }
  return {
    ...draft,
    mode: commit.choices.splineMode ?? draft.mode,
    closed: commit.flags.splineClosed ?? draft.closed,
  };
}

/**
 * ポップアップの次の姿。`open` は開いたまま(ばねの1段目→2段目の遷移もここを通る、
 * §2.11)、`committed` / `solidCommitted` は履歴へ積んでよい、`blocked` は不正な欄が
 * 残っているので決定させない(NFR-UX-5)、`cancelled` は取消。
 */
export type NumericInputTransition =
  | { readonly kind: 'open'; readonly state: NumericInputState }
  | {
      readonly kind: 'committed';
      readonly state: NumericInputState;
      readonly commit: NumericInputCommit;
    }
  | {
      readonly kind: 'solidCommitted';
      readonly state: NumericInputState;
      readonly commit: SolidInputCommit;
    }
  | {
      readonly kind: 'referenceCommitted';
      readonly state: NumericInputState;
      readonly commit: ReferenceInputCommit;
    }
  | {
      readonly kind: 'editCommitted';
      readonly state: NumericInputState;
      readonly commit: EditInputCommit;
    }
  | {
      readonly kind: 'blocked';
      readonly state: NumericInputState;
      readonly evaluation: NumericInputEvaluation;
    }
  | { readonly kind: 'cancelled' };

export interface NumericInputContext extends DisplayUnitOptions {
  /** 相対・極の基準点(FR-302、FR-303)。省略すると直前に作った点を指す。 */
  readonly base?: PointReference;
  /** 変数表(FR-206、§0.a-0.6)。P1 の UI は渡さない。 */
  readonly variables?: ReadonlyMap<string, number>;
}

function fieldValueMap(
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
): ReadonlyMap<string, ExpressionValue> {
  const map = new Map<string, ExpressionValue>();
  fields.forEach((field, index) => {
    const value = values[index];
    if (value !== undefined) {
      map.set(field.key, value);
    }
  });
  return map;
}

/**
 * ばねの1段目(carriedStage1)の欄を評価し、key から引ける表にする。
 * 1段目は確定済み(すでに canCommit だった)ので、通常は評価に失敗しない。
 */
function evaluateCarried(
  fields: readonly NumericField[] | undefined,
  variables: ReadonlyMap<string, number> | undefined,
  display: DisplayUnitOptions = {},
): ReadonlyMap<string, ExpressionValue> {
  const map = new Map<string, ExpressionValue>();
  if (fields === undefined) {
    return map;
  }
  for (const field of fields) {
    // 1 段目で打った文字も、2 段目の確定のときに同じ規則で包む(タスク3b)。
    const result = evaluateNumericField(field, variables ?? new Map(), display);
    if (result.ok) {
      map.set(field.key, result.value);
    }
  }
  return map;
}

function solidValuesFor(
  step: SolidNumericInputStep,
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
  carried: ReadonlyMap<string, ExpressionValue>,
): SolidCommitValues {
  const own = fieldValueMap(fields, values);
  const get = (key: string): ExpressionValue | undefined => own.get(key) ?? carried.get(key);
  switch (step) {
    // 押し出しは終わり方・傾き・薄板をここへ畳んだ(タスク50)。隠れている欄は
    // 状態の fields に無いので get が undefined を返し、確定側は model の既定を使う。
    case 'extrudeDistance':
      return {
        distance: get('distance'),
        taperAngle: get('taperAngle'),
        thickness: get('thickness'),
      };
    case 'revolveAngle':
      return { angle: get('angle') };
    case 'sewTolerance':
      return { tolerance: get('tolerance') };
    // 穴は入口の広げ方をここへ畳んだ(タスク50)。広げないときは 4 欄とも入らない。
    case 'holeSize':
      return {
        diameter: get('diameter'),
        depth: get('depth'),
        counterboreDiameter: get('counterboreDiameter'),
        counterboreDepth: get('counterboreDepth'),
        countersinkDiameter: get('countersinkDiameter'),
        countersinkAngle: get('countersinkAngle'),
      };
    case 'threadSize':
      return { depth: get('depth'), threadLength: get('threadLength') };
    // R 面取りは可変半径をここへ畳んだ(タスク50)。一定半径なら終わりの半径は入らない。
    case 'filletRadius':
      return { radius: get('radius'), filletRadiusEnd: get('filletRadiusEnd') };
    case 'chamferSize':
      return {
        chamferDistance: get('chamferDistance'),
        chamferDistance2: get('chamferDistance2'),
        chamferAngle: get('chamferAngle'),
      };
    case 'linearPattern':
      return { spacing: get('spacing'), count: get('count') };
    case 'circularPattern':
      return { angle: get('angle'), count: get('count') };
    case 'springShape':
      return { coilDiameter: get('coilDiameter'), wireDiameter: get('wireDiameter') };
    case 'springLength':
      return {
        coilDiameter: get('coilDiameter'),
        wireDiameter: get('wireDiameter'),
        springPitch: get('springPitch'),
        springTurns: get('springTurns'),
        springLength: get('springLength'),
      };
    // 基本形状5種(FR-429、タスク18)。欄の名前がそのまま形の欄の名前になる。
    case 'sphereSize':
      return { sphereRadius: get('sphereRadius') };
    case 'boxSize':
      return { boxSizeX: get('boxSizeX'), boxSizeY: get('boxSizeY'), boxSizeZ: get('boxSizeZ') };
    case 'cylinderSize':
      return { cylinderRadius: get('cylinderRadius'), cylinderHeight: get('cylinderHeight') };
    case 'coneSize':
      return {
        coneBottomRadius: get('coneBottomRadius'),
        coneTopRadius: get('coneTopRadius'),
        coneHeight: get('coneHeight'),
      };
    case 'torusSize':
      return {
        torusMajorRadius: get('torusMajorRadius'),
        torusMinorRadius: get('torusMinorRadius'),
      };
    // 球面上の点(FR-431、タスク22)。欄の名前がそのまま緯度・経度になる。
    case 'sphereGridPoint':
      return { latitude: get('latitude'), longitude: get('longitude') };
    // 面をつなぐ・ロフト(FR-430、FR-410、タスク27)。欄はねじれ 1 つだけ。
    case 'ruledTwist':
    case 'loftTwist':
      return { ruledTwist: get('ruledTwist') };
    /*
      P5 の Should / Could 群(タスク49)。隠れている欄は状態の `fields` に無いので
      `get` が undefined を返し、確定側は model の既定を使う(NFR-UX-4)。
    */
    case 'draftAngle':
      return { draftAngle: get('draftAngle') };
    case 'transformTranslation':
      return {
        translationX: get('translationX'),
        translationY: get('translationY'),
        translationZ: get('translationZ'),
      };
    // 2 段目は 1 段目の移動量も合わせて渡す(ばね・配列複写の 2 段目と同じ約束)。
    case 'transformRotation':
      return {
        translationX: get('translationX'),
        translationY: get('translationY'),
        translationZ: get('translationZ'),
        rotationAngle: get('rotationAngle'),
      };
    case 'scaleAmount':
      return {
        scaleFactor: get('scaleFactor'),
        scaleX: get('scaleX'),
        scaleY: get('scaleY'),
        scaleZ: get('scaleZ'),
      };
    case 'ribThickness':
      return { ribThickness: get('ribThickness') };
    case 'embossHeight':
      return { embossHeight: get('embossHeight') };
    case 'threadShaftSize':
      return {
        threadShaftPitch: get('threadShaftPitch'),
        threadShaftLength: get('threadShaftLength'),
      };
    case 'surfaceShape':
      return {
        surfaceDistance: get('surfaceDistance'),
        surfaceAngle: get('surfaceAngle'),
        surfaceOffset: get('surfaceOffset'),
      };
    case 'shellThickness':
      return { shellThickness: get('shellThickness') };
    case 'cutPlane':
      return { cutTilt: get('cutTilt') };
    // 欄を 1 つも持たない段(ミラー・スイープ・点集合パターン)。
    case 'mirrorPlane':
    case 'sweepOptions':
    case 'pointPattern':
      return {};
  }
}

/**
 * つまみを立体の確定結果の形へ写す。
 * P4 でスケッチ専用のつまみ(構築線・楕円弧・閉じる)が `NumericToggleKey` へ入ったので、
 * 「全部そのまま代入する」書き方をやめ、立体が持つつまみだけを明示して写す。
 */
function solidFlagsFor(toggles: readonly NumericToggle[]): SolidCommitFlags {
  const flags: {
    reversed?: boolean;
    symmetric?: boolean;
    through?: boolean;
    modeledThread?: boolean;
    patternSymmetric?: boolean;
    fullCircle?: boolean;
    tapered?: boolean;
    taperOutward?: boolean;
    thinWalled?: boolean;
    sweepFrenet?: boolean;
    loftSmooth?: boolean;
    raised?: boolean;
    scalePerAxis?: boolean;
    shellOutward?: boolean;
    variableRadius?: boolean;
    cutKeepOpposite?: boolean;
    cutKeepBoth?: boolean;
  } = {};
  for (const toggle of toggles) {
    switch (toggle.key) {
      case 'reversed':
        flags.reversed = toggle.value;
        break;
      case 'symmetric':
        flags.symmetric = toggle.value;
        break;
      case 'through':
        flags.through = toggle.value;
        break;
      case 'modeledThread':
        flags.modeledThread = toggle.value;
        break;
      case 'patternSymmetric':
        flags.patternSymmetric = toggle.value;
        break;
      case 'fullCircle':
        flags.fullCircle = toggle.value;
        break;
      /* ---- P5 の Should / Could 群(タスク49) ---- */
      case 'tapered':
        flags.tapered = toggle.value;
        break;
      case 'taperOutward':
        flags.taperOutward = toggle.value;
        break;
      case 'thinWalled':
        flags.thinWalled = toggle.value;
        break;
      case 'sweepFrenet':
        flags.sweepFrenet = toggle.value;
        break;
      case 'loftSmooth':
        flags.loftSmooth = toggle.value;
        break;
      case 'raised':
        flags.raised = toggle.value;
        break;
      case 'scalePerAxis':
        flags.scalePerAxis = toggle.value;
        break;
      case 'shellOutward':
        flags.shellOutward = toggle.value;
        break;
      case 'variableRadius':
        flags.variableRadius = toggle.value;
        break;
      case 'cutKeepOpposite':
        flags.cutKeepOpposite = toggle.value;
        break;
      case 'cutKeepBoth':
        flags.cutKeepBoth = toggle.value;
        break;
      default:
        // スケッチのつまみ(構築線・楕円弧・閉じる)は立体の確定には入らない。
        break;
    }
  }
  return flags;
}

/** 選択肢の文字列値から RevolveAxis を組み立て直す(§2.11「確定側で value から引き直す」)。 */
function axisFromChoiceValue(value: string, axisLine: SketchLineRef | undefined): RevolveAxis | undefined {
  switch (value) {
    case 'x':
    case 'y':
    case 'z':
      return { kind: 'world', axis: value };
    case 'line':
      return axisLine === undefined ? undefined : { kind: 'line', line: axisLine };
    default:
      return undefined;
  }
}

function toThreadSeries(value: string | undefined): ThreadSeries | undefined {
  switch (value) {
    case 'coarse':
      return 'coarse';
    case 'fine':
      return 'fine';
    default:
      return undefined;
  }
}

function toChamferMode(value: string | undefined): ChamferSize['kind'] | undefined {
  switch (value) {
    case 'equal':
      return 'equal';
    case 'twoDistances':
      return 'twoDistances';
    case 'distanceAngle':
      return 'distanceAngle';
    default:
      return undefined;
  }
}

function toSpringHandedness(value: string | undefined): SpringHandedness | undefined {
  switch (value) {
    case 'right':
      return 'right';
    case 'left':
      return 'left';
    default:
      return undefined;
  }
}

function toPolygonRadiusMode(value: string | undefined): 'circumscribed' | 'inscribed' | undefined {
  switch (value) {
    case 'circumscribed':
      return 'circumscribed';
    case 'inscribed':
      return 'inscribed';
    default:
      return undefined;
  }
}

function toPointArrayLayout(value: string | undefined): PointArrayLayoutChoice | undefined {
  switch (value) {
    case 'linear':
      return 'linear';
    case 'circular':
      return 'circular';
    case 'grid':
      return 'grid';
    default:
      return undefined;
  }
}

function toSplineMode(value: string | undefined): 'interpolate' | 'control' | undefined {
  switch (value) {
    case 'interpolate':
      return 'interpolate';
    case 'control':
      return 'control';
    default:
      return undefined;
  }
}

function toArcBulge(value: string | undefined): 'left' | 'right' | undefined {
  switch (value) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      return undefined;
  }
}

/** スケッチのつまみを確定結果の形へ写す。持たないつまみは欄ごと現れない。 */
function sketchFlagsFor(toggles: readonly NumericToggle[]): SketchCommitFlags {
  const flags: { construction?: boolean; splitIntersections?: boolean; ellipseArc?: boolean; splineClosed?: boolean } = {};
  for (const toggle of toggles) {
    switch (toggle.key) {
      case 'construction':
        flags.construction = toggle.value;
        break;
      case 'splitIntersections':
        flags.splitIntersections = toggle.value;
        break;
      case 'ellipseArc':
        flags.ellipseArc = toggle.value;
        break;
      case 'splineClosed':
        flags.splineClosed = toggle.value;
        break;
      default:
        // ソリッドのつまみ(反転・両側・貫通など)はスケッチの確定には入らない。
        break;
    }
  }
  return flags;
}

/** スケッチの選択肢を確定結果の形へ写す。持たない選択肢は undefined のままにする。 */
function sketchChoicesFor(choices: readonly NumericChoice[]): SketchCommitChoices {
  return {
    polygonRadiusMode: toPolygonRadiusMode(choiceValueFrom(choices, 'polygonRadiusMode')),
    pointArrayLayout: toPointArrayLayout(choiceValueFrom(choices, 'pointArrayLayout')),
    splineMode: toSplineMode(choiceValueFrom(choices, 'splineMode')),
    arcBulge: toArcBulge(choiceValueFrom(choices, 'arcBulge')),
  };
}

/**
 * なめらかさの選択肢の文字列を、点の数へ直す(§0.a-0.74)。知らない値は undefined にして
 * 確定側の既定へ落とす(`as` を使わずに絞り込む。ねじの系列・ばねの巻き方向と同じ形)。
 */
function toRuledSphereSegments(value: string | undefined): RuledSphereSegments | undefined {
  switch (value) {
    case '24':
      return 24;
    case '48':
      return 48;
    case '72':
      return 72;
    default:
      return undefined;
  }
}

function toSpringDerived(value: string | undefined): SpringDerived | undefined {
  switch (value) {
    case 'length':
      return 'length';
    case 'pitch':
      return 'pitch';
    case 'turns':
      return 'turns';
    default:
      return undefined;
  }
}

/**
 * ソリッドの確定を組み立てる。ばねの2段目(springLength)では1段目(carriedStage1)の
 * 欄・選択肢も合わせて読む(§2.11「1段目の値は2段目へ持ち越す」)。
 * 呼び出し元(commitNumericInput)がソリッドの段でだけ呼ぶので、step はここで
 * SolidNumericInputStep へ絞り込み済みのものを受け取る。
 */
function buildSolidCommit(
  step: SolidNumericInputStep,
  filled: NumericInputState,
  values: readonly ExpressionValue[],
  context: NumericInputContext,
): SolidInputCommit {
  const carried = evaluateCarried(filled.carriedStage1?.fields, context.variables, context);
  const combinedChoices = [...filled.choices, ...(filled.carriedStage1?.choices ?? [])];
  const axisValue =
    choiceValueFrom(combinedChoices, 'axis') ?? choiceValueFrom(combinedChoices, 'patternDirection');
  const axisLine = filled.axisLine ?? filled.carriedStage1?.axisLine;
  return {
    kind: 'solid',
    tool: SOLID_STEP_TOOLS[step],
    step,
    values: solidValuesFor(step, filled.fields, values, carried),
    flags: solidFlagsFor(filled.toggles),
    axis: axisValue === undefined ? undefined : axisFromChoiceValue(axisValue, axisLine),
    threadDesignation: choiceValueFrom(combinedChoices, 'threadDesignation'),
    threadSeries: toThreadSeries(choiceValueFrom(combinedChoices, 'threadSeries')),
    chamferMode: toChamferMode(choiceValueFrom(combinedChoices, 'chamferMode')),
    springHandedness: toSpringHandedness(choiceValueFrom(combinedChoices, 'springHandedness')),
    springDerived: toSpringDerived(choiceValueFrom(combinedChoices, 'springDerived')),
    ruledSphereSegments: toRuledSphereSegments(
      choiceValueFrom(combinedChoices, 'ruledSphereSegments'),
    ),
    shapeChoices: shapeChoicesFrom(combinedChoices),
  };
}

/**
 * P5 の Should / Could 群の選択肢を確定結果の形へ写す(タスク49)。
 * 読み替えずに文字列のまま運ぶ(`SolidShapeChoices` の注釈)。
 */
function shapeChoicesFrom(choices: readonly NumericChoice[]): SolidShapeChoices {
  return {
    sweepGuide: choiceValueFrom(choices, 'sweepGuide'),
    extrudeEnd: choiceValueFrom(choices, 'extrudeEnd'),
    thicknessSide: choiceValueFrom(choices, 'thicknessSide'),
    mirrorPlane: choiceValueFrom(choices, 'mirrorPlane'),
    ribSide: choiceValueFrom(choices, 'ribSide'),
    holeEntry: choiceValueFrom(choices, 'holeEntry'),
    threadShaftEnd: choiceValueFrom(choices, 'threadShaftEnd'),
    surfaceOperation: choiceValueFrom(choices, 'surfaceOperation'),
    cutPlaneKind: choiceValueFrom(choices, 'cutPlaneKind'),
  };
}

/** 基準ジオメトリの欄を、確定結果の形へ写す(P4 タスク13)。持たない欄は入らない。 */
function referenceValuesFor(
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
): ReferenceCommitValues {
  const own = fieldValueMap(fields, values);
  return {
    offset: own.get('planeOffset'),
    angle: own.get('planeAngle'),
    tilt: own.get('planeTilt'),
    azimuth: own.get('planeAzimuth'),
  };
}

/** 基準ジオメトリの選択肢を、確定結果の形へ写す(P4 タスク13)。 */
function referenceChoicesFor(choices: readonly NumericChoice[]): ReferenceCommitChoices {
  return {
    planeBase: choiceValueFrom(choices, 'referencePlaneBase'),
    axis: choiceValueFrom(choices, 'referenceAxisSpec'),
    throughMode: choiceValueFrom(choices, 'referencePlaneThroughMode'),
    axisKind: choiceValueFrom(choices, 'referenceAxisKind'),
    pointKind: choiceValueFrom(choices, 'referencePointKind'),
    csXAxis: choiceValueFrom(choices, 'referenceCsXAxis'),
    csYAxis: choiceValueFrom(choices, 'referenceCsYAxis'),
  };
}

/**
 * 整形系の欄を、確定結果の形へ写す(P4 タスク21・24)。
 * 配列複写の 2 段目は 1 段目(`carried`)の欄も合わせて読む(ばねの 2 段目と同じ約束)。
 */
function editValuesFor(
  step: EditNumericInputStep,
  fields: readonly NumericField[],
  values: readonly ExpressionValue[],
  carried: ReadonlyMap<string, ExpressionValue>,
): EditCommitValues {
  const own = fieldValueMap(fields, values);
  const get = (key: string): ExpressionValue | undefined => own.get(key) ?? carried.get(key);
  switch (step) {
    case 'offsetDistance':
      return { distance: get('distance') };
    case 'mirrorBasis':
    case 'circularArrayCenter':
      // 鏡にするものは選択肢だけ、円形配列の中心は座標だけで決まる(数の欄は無い)。
      return {};
    case 'copyDelta':
      return { dx: get('dx'), dy: get('dy'), dz: get('dz') };
    case 'linearArrayDirection':
      return { angle: get('angle'), spacing: get('spacing') };
    case 'linearArrayCount':
      return { angle: get('angle'), spacing: get('spacing'), count: get('count') };
    case 'circularArrayShape':
      return { angle: get('angle'), count: get('count') };
    case 'sketchFilletRadius':
      return { cornerRadius: get('cornerRadius') };
    case 'sketchChamferSize':
      // 等距離のときは 2 つ目の欄が無いので undefined のまま。距離をそろえるのは
      // `cornerCommands.ts` の役目(欄の有無と値の解釈を 1 か所に閉じる)。
      return { cornerDistance1: get('cornerDistance1'), cornerDistance2: get('cornerDistance2') };
  }
}

/** 整形系のつまみを確定結果の形へ写す(構築線と、複製系の「全周」)。 */
function editFlagsFor(toggles: readonly NumericToggle[]): EditCommitFlags {
  const fullCircle = toggles.find((toggle) => toggle.key === 'fullCircle');
  return fullCircle === undefined
    ? sketchFlagsFor(toggles)
    : { ...sketchFlagsFor(toggles), fullCircle: fullCircle.value };
}

/**
 * 1 段目(`carriedStage1`)の欄から、そのときの位置の決め方で 1 点を組み立て直す
 * (P4 タスク24、円形配列の中心)。1 段目が座標を聞く段でなければ undefined。
 */
function carriedCoordinateOf(
  filled: NumericInputState,
  context: NumericInputContext,
  base: PointReference,
): CoordinateInput | undefined {
  const carried = filled.carriedStage1;
  if (carried === undefined || carried.mode === undefined) {
    return undefined;
  }
  const evaluated = evaluateCarried(carried.fields, context.variables, context);
  const ordered: ExpressionValue[] = [];
  for (const definition of COORDINATE_FIELDS[carried.mode]) {
    const value = evaluated.get(definition.key);
    if (value === undefined) {
      return undefined;
    }
    ordered.push(value);
  }
  return buildCoordinateInput(carried.mode, ordered, base) ?? undefined;
}

/**
 * 整形系の確定を組み立てる(P4 タスク21〜24)。呼び出し元(commitNumericInput)が
 * 整形系の段でだけ呼ぶので、step はここで `EditNumericInputStep` へ絞り込み済み。
 */
function buildEditCommit(
  step: EditNumericInputStep,
  filled: NumericInputState,
  values: readonly ExpressionValue[],
  context: NumericInputContext,
): EditInputCommit {
  const carried = evaluateCarried(filled.carriedStage1?.fields, context.variables, context);
  return {
    kind: 'edit',
    tool: EDIT_STEP_TOOLS[step],
    step,
    values: editValuesFor(step, filled.fields, values, carried),
    flags: editFlagsFor(filled.toggles),
    choices: {
      side: choiceValueFrom(filled.choices, 'offsetSide'),
      corner: choiceValueFrom(filled.choices, 'offsetCorner'),
      mirrorBasis: choiceValueFrom(filled.choices, 'mirrorBasis'),
      chamferMode: choiceValueFrom(filled.choices, 'chamferMode'),
    },
    coordinate: carriedCoordinateOf(filled, context, context.base ?? DEFAULT_COORDINATE_BASE),
  };
}

/**
 * 「決定」を押したとき、または Enter を打ったときの処理。
 * 空欄を既定値で埋めてから評価し(NFR-UX-4)、1 つでも不正なら決定させずに
 * 最初の誤りへ焦点を移す(NFR-UX-5、FR-204)。
 *
 * ばねの1段目(springShape)だけは特別で、確定しても閉じずに2段目(springLength)を
 * 開く(`kind: 'open'`)。まだ利用者へ渡す完成した加工ではないため、`solidCommitted`
 * にはしない(§2.11「P1 の線分の始点→終点と同じ作り」)。
 */
export function commitNumericInput(
  state: NumericInputState,
  context: NumericInputContext = {},
): NumericInputTransition {
  // 表示・前の段の再評価・確定へ、同じ時点の計算待ちを渡す。
  context = { ...context, pendingVariables: context.pendingVariables ?? pendingVariablesFor(context.variables) };
  const filled = fillDefaults(state);
  const evaluation = evaluateNumericInput(filled, context.variables, context);
  const values = commitValues(evaluation);
  if (values === null) {
    return {
      kind: 'blocked',
      state: { ...filled, focusedIndex: Math.max(evaluation.firstErrorIndex, 0) },
      evaluation,
    };
  }
  const { step } = filled;
  if (isSolidStep(step)) {
    // 2 段で聞く道具(ばね・移動/回転)の 1 段目は、確定しても閉じずに 2 段目を開く。
    const secondStep = SOLID_SECOND_STEPS[step];
    if (secondStep !== undefined) {
      return { kind: 'open', state: solidStage2StateFrom(filled, secondStep) };
    }
    return {
      kind: 'solidCommitted',
      state: filled,
      commit: buildSolidCommit(step, filled, values, context),
    };
  }
  if (isReferenceStep(step)) {
    // 基準ジオメトリ(FR-328、FR-329)。座標を聞く段では 1 点を組み立て、
    // それ以外の段は距離・角度・決め方だけを渡す(組み立ては referenceCommands.ts)。
    if (!isReferenceCoordinateStep(step)) {
      return {
        kind: 'referenceCommitted',
        state: filled,
        commit: {
          kind: 'reference',
          tool: REFERENCE_STEP_TOOLS[step],
          step,
          coordinate: null,
          mode: null,
          values: referenceValuesFor(filled.fields, values),
          choices: referenceChoicesFor(filled.choices),
        },
      };
    }
    const point = buildCoordinateInput(
      filled.mode,
      values,
      context.base ?? DEFAULT_COORDINATE_BASE,
    );
    if (point === null) {
      return { kind: 'blocked', state: filled, evaluation };
    }
    return {
      kind: 'referenceCommitted',
      state: filled,
      commit: {
        kind: 'reference',
        tool: REFERENCE_STEP_TOOLS[step],
        step,
        coordinate: point,
        mode: filled.mode,
        values: referenceValuesFor(filled.fields, values),
        choices: referenceChoicesFor(filled.choices),
      },
    };
  }
  if (isEditStep(step)) {
    // 整形系(オフセット FR-321、複製系 FR-324)。対象はすでに選ばれているので、
    // 選択から `SketchOffsetFeature` / `SketchCopyFeature` を組み立てるのは
    // `editCommands.ts` / `copyCommands.ts` の役目。
    //
    // 配列複写だけは 1 段目で閉じずに 2 段目を開く(ばねの springShape と同じ扱い)。
    const secondStep = EDIT_SECOND_STEPS[step];
    if (secondStep !== undefined) {
      return { kind: 'open', state: editStage2StateFrom(filled, secondStep) };
    }
    return {
      kind: 'editCommitted',
      state: filled,
      commit: buildEditCommit(step, filled, values, context),
    };
  }
  const flags = sketchFlagsFor(filled.toggles);
  const choices = sketchChoicesFor(filled.choices);
  if (!isCoordinateStep(step)) {
    return {
      kind: 'committed',
      state: filled,
      commit: { kind: 'shape', step, values, flags, choices },
    };
  }
  const coordinate = buildCoordinateInput(
    filled.mode,
    values,
    context.base ?? DEFAULT_COORDINATE_BASE,
  );
  if (coordinate === null) {
    // 欄が 3 つ揃わない段階は今のところ無いが、揃わないまま履歴へ積むよりは止める。
    return { kind: 'blocked', state: filled, evaluation };
  }
  return {
    kind: 'committed',
    state: filled,
    commit: { kind: 'coordinate', step, mode: filled.mode, coordinate, values, flags, choices },
  };
}

/**
 * 決めた後に続けて聞くこと(§2.9 の「確定した後」)。閉じるなら null。
 *
 * 線分・円弧・点列は 2 段階でひと組なので、前半を決めたら連続描画の入切に関わらず後半へ進む。
 * 後半まで終わったときは、連続描画が入なら次の 1 本を同じ手順で聞き直し(FR-307)、切なら閉じる。
 * 相対・極の基準点は `DEFAULT_COORDINATE_BASE`(直前に作った点)なので、開き直すだけで
 * 直前の端点からの続きになる。
 *
 * ソリッドの段は連続描画の対象外なので、いつでも閉じる(面を選び直さないと次を作れない)。
 * 例外はばねの springShape で、これだけは chaining に関わらず springLength へ進む
 * (§2.11。commitNumericInput が springShape を `kind: 'open'` で返すのと同じ理由)。
 */
export function nextNumericInput(
  state: NumericInputState,
  requestedChaining: boolean,
): NumericInputState | null {
  const chaining = state.repeatAfterCommit ?? requestedChaining;
  switch (state.step) {
    case 'lineStart':
      return createNextNumericInput(state, 'lineEnd');
    case 'arcCenter':
      return createNextNumericInput(state, 'arcShape');
    case 'pointArrayBase':
      return createNextNumericInput(state, 'pointArrayShape');
    case 'circleCenter':
      return createNextNumericInput(state, 'circleRadius');
    case 'twoPointArcStart':
      return createNextNumericInput(state, 'twoPointArcEnd');
    case 'twoPointArcEnd':
      return createNextNumericInput(state, 'twoPointArcRadius');
    case 'threePointArcStart':
      return createNextNumericInput(state, 'threePointArcEnd');
    case 'threePointArcEnd':
      return createNextNumericInput(state, 'threePointArcVia');
    case 'rectangleCorner1':
      return createNextNumericInput(state, 'rectangleCorner2');
    case 'polygonCenter':
      return createNextNumericInput(state, 'polygonShape');
    case 'slotCenter1':
      return createNextNumericInput(state, 'slotCenter2');
    case 'slotCenter2':
      return createNextNumericInput(state, 'slotShape');
    case 'ellipseCenter':
      return createNextNumericInput(state, 'ellipseShape');
    case 'ellipseShape':
      return createNextNumericInput(state, 'ellipseAngles');
    case 'ellipseAngles':
      // 「一部だけ(楕円弧)」が入なら開始角・終了角を続けて聞く。切なら全周でここで終わる。
      if (toggleValueOf(state, 'ellipseArc')) {
        return createNextNumericInput(state, 'ellipseArcAngles');
      }
      return chaining ? createNextNumericInput(state, 'ellipseCenter') : null;
    case 'pointArrayShape':
      // 格子は「行」「列」の 2 段に分けてある(欄を 1 段 2 個までにするため)。
      if (choiceValueFrom(state.choices, 'pointArrayLayout') === 'grid') {
        return createNextNumericInput(state, 'pointArrayGridColumns');
      }
      return chaining ? createNextNumericInput(state, 'pointArrayBase') : null;
    case 'splinePoint':
      // 点は「続けてかく」の入切に関わらず積み上げる。曲線にするのは splineFinishStateFrom
      // が開く splineShape の段(タスク12 が Enter 以外の合図で呼ぶ)。
      return createNextNumericInput(state, 'splinePoint', state.mode);
    case 'point':
      // 点は 1 段階で終わるので、同じ指定方法のまま次の点を聞く。
      return chaining ? createNextNumericInput(state, 'point', state.mode) : null;
    case 'lineEnd': {
      if (!chaining) return null;
      const next = createNextNumericInput(state, 'lineEnd');
      const split = state.toggles.find((toggle) => toggle.key === 'splitIntersections');
      return split === undefined ? next : { ...next, toggles: next.toggles.map((toggle) =>
        toggle.key === 'splitIntersections' ? { ...toggle, value: split.value } : toggle) };
    }
    case 'arcShape':
      return chaining ? createNextNumericInput(state, 'arcCenter') : null;
    case 'circleRadius':
      return chaining ? createNextNumericInput(state, 'circleCenter') : null;
    case 'twoPointArcRadius':
      return chaining ? createNextNumericInput(state, 'twoPointArcStart') : null;
    case 'threePointArcVia':
      return chaining ? createNextNumericInput(state, 'threePointArcStart') : null;
    case 'rectangleCorner2':
      return chaining ? createNextNumericInput(state, 'rectangleCorner1') : null;
    case 'polygonShape':
      return chaining ? createNextNumericInput(state, 'polygonCenter') : null;
    case 'slotShape':
      return chaining ? createNextNumericInput(state, 'slotCenter1') : null;
    case 'ellipseArcAngles':
      return chaining ? createNextNumericInput(state, 'ellipseCenter') : null;
    case 'pointArrayGridColumns':
      return chaining ? createNextNumericInput(state, 'pointArrayBase') : null;
    case 'splineShape':
      return chaining ? createNextNumericInput(state, 'splinePoint') : null;
    case 'springShape':
      return springLengthStateFrom(state);
    // 移動/回転(FR-424、タスク49)。1 段目(動かす量)から 2 段目(回す角度)へ進む。
    case 'transformTranslation':
      return solidStage2StateFrom(state, 'transformRotation');
    /*
      基準ジオメトリ(FR-328、FR-329、タスク13)。1 つ作ったら閉じる(「続けてかく」は
      スケッチの要素のための入切なので、平面・軸・点・座標系には効かせない)。
      軸の一覧(referenceAxes)は次の段へ持ち越す(段ごとに作り直すと一覧が消えるため)。
    */
    case 'referencePlanePoint1':
      return referenceStep(state, 'referencePlanePoint2');
    case 'referencePlanePoint2':
      return referenceStep(state, 'referencePlanePoint3');
    case 'referencePlaneBasePoint':
      return referenceStep(state, 'referencePlaneThrough');
    case 'referenceAxisKind':
      // 2 点で決めるときだけ点を聞きに進む。辺・面から決めるときはその場で作って終わる。
      return choiceValueFrom(state.choices, 'referenceAxisKind') === 'twoPoints'
        ? referenceStep(state, 'referenceAxisStart')
        : null;
    case 'referenceAxisStart':
      return referenceStep(state, 'referenceAxisEnd');
    case 'referencePointKind':
      return choiceValueFrom(state.choices, 'referencePointKind') === 'coordinate'
        ? referenceStep(state, 'referencePointAt')
        : null;
    case 'referenceCsOrigin':
      return referenceStep(state, 'referenceCsAxes');
    case 'referencePlanePoint3':
    case 'referencePlaneThrough':
    case 'referencePlaneOffset':
    case 'referencePlaneTilt':
    case 'referenceAxisEnd':
    case 'referencePointAt':
    case 'referenceCsAxes':
      return null;
    case 'extrudeDistance':
    case 'revolveAngle':
    case 'sewTolerance':
    case 'holeSize':
    case 'threadSize':
    case 'filletRadius':
    case 'chamferSize':
    case 'linearPattern':
    case 'circularPattern':
    case 'springLength':
    case 'sphereSize':
    case 'boxSize':
    case 'cylinderSize':
    case 'coneSize':
    case 'torusSize':
    case 'sphereGridPoint':
    case 'ruledTwist':
    case 'loftTwist':
    case 'draftAngle':
    case 'mirrorPlane':
    case 'transformRotation':
    case 'scaleAmount':
    case 'sweepOptions':
    case 'ribThickness':
    case 'embossHeight':
    case 'threadShaftSize':
    case 'pointPattern':
    case 'surfaceShape':
    case 'shellThickness':
    case 'cutPlane':
      /*
        基本形状5種(FR-429、タスク18)も、面をつなぐ・ロフト(FR-430、FR-410、タスク27)も
        1段で終わる。「続けてかく」はスケッチの要素のための入切なので、立体を作る道具には
        効かせない(押し出し・回転と同じ扱い)。

        P5 の Should / Could 群(タスク49)も同じで、移動/回転の 2 段目まで含めて
        確定したら閉じる(対象を選び直さないと次を作れないため)。
      */
      return null;
    /*
      整形系(P4 タスク21・24)。対象を選び直さないと続けられないので、ソリッドの段と
      同じく「続けてかく」に関わらずいつでも閉じる(§2.5)。配列複写だけは 1 段目から
      2 段目へ進む(`commitNumericInput` が `kind: 'open'` を返すのと同じ理由)。
    */
    case 'linearArrayDirection':
      return editStage2StateFrom(state, 'linearArrayCount');
    case 'circularArrayCenter':
      return editStage2StateFrom(state, 'circularArrayShape');
    /*
      角の丸め・面取り(タスク23)も 1 段で終わる。道具は選んだまま残す(続けて別の角を
      指せる)が、次の角はビューポートで指し直すので段からは開かない。
    */
    case 'offsetDistance':
    case 'mirrorBasis':
    case 'copyDelta':
    case 'linearArrayCount':
    case 'circularArrayShape':
    case 'sketchFilletRadius':
    case 'sketchChamferSize':
      return null;
  }
}

/**
 * ポップアップの中で意味を持つキー操作(§2.9)。
 * DOM の KeyboardEvent をこれへ詰め替えるのはタスク18 の React 部品の役目で、
 * この層はキーの名前だけを知る。
 */
export type NumericInputKey =
  | 'Tab'
  | 'ShiftTab'
  | 'Enter'
  | 'Escape'
  | 'Alt1'
  | 'Alt2'
  | 'Alt3'
  /** 焦点があるつまみの入切。 */
  | 'Space'
  /** 焦点がある選択肢を1つ隣へ。 */
  | 'ArrowLeft'
  | 'ArrowRight';

function modeForKey(key: 'Alt1' | 'Alt2' | 'Alt3'): CoordinateMode {
  if (key === 'Alt1') {
    return 'absolute';
  }
  return key === 'Alt2' ? 'relative' : 'polar';
}

/**
 * キー操作を 1 つ受けて次の姿を返す。焦点はポップアップの外へ出さない(NFR-UX-2)。
 *
 * Space と ← → は、焦点がつまみ・選択肢にあるときだけ効く。欄に焦点があるときは
 * 空白の入力とカーソル移動を邪魔しないため、状態を変えずにそのまま返す。
 */
export function applyNumericInputKey(
  state: NumericInputState,
  key: NumericInputKey,
  context: NumericInputContext = {},
): NumericInputTransition {
  switch (key) {
    case 'Tab':
      return { kind: 'open', state: reduceNumericInput(state, { type: 'tab', backwards: false }) };
    case 'ShiftTab':
      return { kind: 'open', state: reduceNumericInput(state, { type: 'tab', backwards: true }) };
    case 'Alt1':
    case 'Alt2':
    case 'Alt3':
      return {
        kind: 'open',
        state: reduceNumericInput(state, { type: 'setMode', mode: modeForKey(key) }),
      };
    case 'Space': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'toggle') {
        return { kind: 'open', state };
      }
      const toggle = state.toggles[target.index];
      return { kind: 'open', state: toggleNumericInput(state, toggle.key) };
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const target = focusedTarget(state);
      if (target === null || target.kind !== 'choice') {
        return { kind: 'open', state };
      }
      return {
        kind: 'open',
        state: reduceNumericInput(state, {
          type: 'moveChoice',
          backwards: key === 'ArrowLeft',
        }),
      };
    }
    case 'Enter':
      return commitNumericInput(state, context);
    case 'Escape':
      // 作りかけの要素は履歴に積まない。ツールは選ばれたまま残す(NFR-UX-3)。
      return { kind: 'cancelled' };
  }
}
