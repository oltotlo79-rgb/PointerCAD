/**
 * 立体1つを「モデルブラウザとプロパティが表に出せる形」へ直す
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク22、docs/plans/P3-加工フィーチャー.md タスク27・28)。
 *
 * 対応要件: FR-501(ツリーの種類と名前)、FR-502(参照は id で持つ)、FR-503(抑制・改名・削除)、
 * FR-504(失敗の明示)、FR-202(入れた式をそのまま再表示する)、FR-311(直すと下流が追従する)。
 *
 * `packages/ui/src/sketch/featureSummary.ts` と同じ作りにする。DOM にも React にもストアにも
 * 触れない純関数だけを置き、表示する文言は持たず必ず ja.json のキー(MessageKey)で返す
 * (NFR-MA-5)。書き戻しは元のフィーチャーを変えずに新しいフィーチャーを作る(FR-505 の土台)。
 *
 * P3 タスク27 で加工6種(穴・ねじ穴・R面取り・C面取り・直線/円形パターン)の欄・つまみ・
 * 選択肢・参照を足した。タスク28 でねじ穴の深さ(貫通/止まり)・傾き角・傾ける向きの欄と
 * 選択肢を仕上げた(§0.a-0.10、0.13、0.14)。ばね(spring)の節は§0.a-0.30の読み取り専用の欄
 * (derived)を要するためタスク29b がここへ追記する(この時点ではまだ空)。
 */

import { composeExpressionSource, evaluateExpression, expressionValueFromNumber, type ExpressionValue, type EvaluateOptions } from '@pointercad/expression';
import {
  consumedBodyIds,
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_COUNTERBORE_DEPTH_MM,
  DEFAULT_COUNTERBORE_DIAMETER_MM,
  DEFAULT_COUNTERSINK_ANGLE_DEGREES,
  DEFAULT_COUNTERSINK_DIAMETER_MM,
  DEFAULT_EXTRUDE_THICKNESS_MM,
  DEFAULT_FILLET_RADIUS_END_MM,
  DEFAULT_HOLE_DEPTH_MM,
  DEFAULT_SCALE_FACTOR,
  DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM,
  DEFAULT_SURFACE_OFFSET_MM,
  DEFAULT_THICKNESS_SIDE,
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
  extrudeShapingOf,
  filletRadiusOf,
  findFeature,
  findReference,
  findMetricThread,
  findSketch,
  findSolid,
  holeEntryOf,
  INCH_DISPLAY_DIGITS,
  MAX_DRAFT_ANGLE_DEGREES,
  MAX_SCALE,
  MAX_TAPER_ANGLE_DEGREES,
  METRIC_THREAD_DESIGNATIONS,
  metricThreadPitch,
  MIN_SCALE,
  MM_PER_INCH,
  referencedSketchIds,
  RULED_SPHERE_SEGMENT_CHOICES,
  threadMinorDiameter,
  type AxisSpec,
  type ChamferFeature,
  type ChamferSize,
  type CoordinateInput,
  type CutFeature,
  type ExtrudeEnd,
  type ExtrudeFeature,
  type PlaneSpec,
  type HoleDepth,
  type HoleEntry,
  type HoleFeature,
  type ImportedSource,
  type ImportedSourceFormat,
  type LengthUnit,
  type MetricThreadSize,
  type MirrorFeature,
  type PartDocument,
  type PartRecomputeError,
  type PatternDirection,
  type PatternFeature,
  type PointReference,
  type ReferenceAxisDefinition,
  type ReferenceError,
  type ReferenceFeature,
  type ReferenceFeatureKind,
  type ReferencePointDefinition,
  type RibSide,
  type RuledSection,
  type RuledSphereSegments,
  type ScaleFeature,
  type SketchCurveRef,
  type SketchDocument,
  type SketchError,
  type SketchFaceRef,
  type SketchFeature,
  type SketchLineRef,
  type SketchPointRef,
  type SolidFeature,
  type SolidLabelKey,
  type SpringDerived,
  type SpringFeature,
  type SpringHandedness,
  type SurfaceFeature,
  type SurfaceOperation,
  type ThicknessSide,
  type ThreadHoleFeature,
  type ThreadRepresentation,
  type ThreadSeries,
  type ThreadShaftFeature,
  type TransformFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { SHEET_FIELD_DEFINITIONS, setSheetField, sheetFieldValues, type SheetFieldKey } from '../sheetMetal/sheetFields.js';
import {
  baseSummary,
  coordinateSummaryFor,
  FEATURE_KIND_LABEL_KEYS,
  sketchTreeKindOf,
  type FeatureCoordinateSummary,
  type SketchTreeKind,
} from '../sketch/featureSummary.js';
import {
  TOGGLE_LABEL_KEYS,
  type FieldUnit,
  type NumericFieldRange,
  type NumericToggleKey,
} from '../sketch/numericInput.js';

import { findSketchFeatureAt } from './sketchRefs.js';

/**
 * プロパティ欄で式のまま直せる欄の種類。種類ごとに1つだけ持つ。
 * P3 タスク27 で加工6種の欄(直径・深さ・半径・面取りの距離2種・傾き2種・ピッチ・下穴径・
 * ねじ部の長さ・パターンの間隔・個数・角度)を足した。ばねの5つ(コイル径〜全長)は
 * タスク29b が使う欄で、型はここでまとめて広げる(計画書タスク27 の型宣言のとおり)。
 */
export type SolidFieldKey =
  | SheetFieldKey
  | 'distance'
  | 'angle'
  | 'tolerance'
  | 'diameter'
  | 'depth'
  | 'radius'
  | 'chamferDistance'
  | 'chamferDistance2'
  | 'chamferAngle'
  | 'pitch'
  | 'drillDiameter'
  | 'threadLength'
  | 'tiltAngle'
  | 'tiltAzimuth'
  | 'spacing'
  | 'count'
  | 'patternAngle'
  /** ばね(FR-414)。タスク29b が使う。 */
  | 'coilDiameter'
  | 'wireDiameter'
  | 'springPitch'
  | 'springTurns'
  | 'springLength'
  /**
   * 面をつなぐ・ロフトのねじれの補正(FR-430、FR-410、§0.a-0.28。P5 タスク27)。
   * 2 つの道具で意味も単位も同じなので欄の名前も 1 つにする(その場入力の
   * `SolidCommitValues.ruledTwist` と同じ名前)。
   */
  | 'ruledTwist'
  /* ---- P5 の Should / Could 群と切断(タスク52・27f・55、§2.11・§2.12・§2.9b) ---- */
  /** 押し出しの側面の傾き(度、FR-401)。向きは `taperOutward` のつまみが持つ。 */
  | 'taperAngle'
  /** 薄板押し出しの壁の厚み(mm、FR-416)。中実のときは欄ごと出さない。 */
  | 'extrudeThickness'
  /* 穴・ねじ穴の入口(FR-422)。入口の種類で出る欄が入れ替わる(§0.a-0.39)。 */
  | 'counterboreDiameter'
  | 'counterboreDepth'
  | 'countersinkDiameter'
  | 'countersinkAngle'
  /** 可変半径フィレットの終点側の半径(mm、FR-426)。一定半径のときは出さない。 */
  | 'radiusEnd'
  /** 抜き勾配の角度(度、FR-417)。 */
  | 'draftAngle'
  /* 移動/回転(FR-424)。平行移動 3 欄と回す角度。 */
  | 'translationX'
  | 'translationY'
  | 'translationZ'
  | 'rotationAngle'
  /* 拡大縮小(FR-424)。全体の倍率 1 欄と軸ごとの 3 欄を切り替える。 */
  | 'scaleFactor'
  | 'scaleX'
  | 'scaleY'
  | 'scaleZ'
  /** リブの壁の厚み(mm、FR-420)。 */
  | 'ribThickness'
  /** エンボスの高さ(mm、FR-421)。彫るときはその深さになる。 */
  | 'embossHeight'
  /* 曲面(FR-428)。作り方ごとに出る欄が違う。 */
  | 'surfaceDistance'
  | 'surfaceAngle'
  | 'surfaceOffset'
  /** くり抜きの壁の厚さ(mm、FR-418)。 */
  | 'shellThickness'
  /* 切断の切る面(FR-432)。面・作図面からずらす距離と、作図面を傾ける角度。 */
  | 'planeOffset'
  | 'planeAngle';

/**
 * プロパティ欄の1行。式は source をそのまま出す(FR-202)。
 *
 * 計画書は `unitKey: MessageKey` としていたが、欄を描く `ExpressionField` が受け取るのは
 * `FieldUnit`(numericInput.ts の UNIT_KEYS がキーへ直す)なので、同じ対応表を2度持たずに
 * 済むよう `unit: FieldUnit` で返す。スケッチ側の `FeatureFieldSummary` とも形がそろう。
 */
export interface SolidFieldSummary {
  readonly key: SolidFieldKey;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
  /**
   * 読み取り専用(既定 false)。ばねの `derived` が指す欄だけ true になる(§0.a-0.30)。
   * true のときプロパティは `ExpressionField` を無効化して値だけを見せる(タスク29b)。
   */
  readonly readOnly: boolean;
  /**
   * 受け付ける値の範囲(NFR-UX-5、P5 タスク52)。**上限・下限の数は model の定数が正本**で、
   * ここはその定数から組み立てるだけにする(同じ数を 2 か所に書かない)。
   *
   * P5 で足した欄にだけ付ける。P1〜P4 からある欄に後から付けると、いままで通っていた
   * 値が黙って弾かれる(その場入力の側で既に範囲を見ているので、二重に狭める理由も無い)。
   * 範囲を持たない欄では欄そのものを持たない(省略)。
   */
  readonly range?: NumericFieldRange;
}

/**
 * 立体側だけが持つつまみ(C面取りの「基準の面を入れ替える」、§0.a-0.18)。
 * その場入力の `NumericToggleKey`(numericInput.ts)には無い。numericInput.ts は
 * P1・P2 の振る舞いを1つも変えない約束(計画書 §4)なので、ここだけで型を広げる。
 */
export type SolidToggleKey =
  | NumericToggleKey
  | 'swapReferenceFace'
  /**
   * リブの「材料に届くまで伸ばす」(FR-420、P5 タスク52)。その場入力の段では既定のまま
   * 作らせる(欄を増やさない)ので `NumericToggleKey` に無く、プロパティでだけ切り替える。
   */
  | 'ribExtendToBody'
  /**
   * 曲面のロフトを「直線でつなぐ」か(FR-428、P5 タスク52)。同上でプロパティ専用。
   */
  | 'surfaceRuled';

/** 入切のつまみ(向きを反転・両側へ等)。式ではないので値は真偽。 */
export interface SolidToggleSummary {
  readonly key: SolidToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/**
 * 深さの種類・ねじの見せ方・面取りの決め方など、いくつかから1つを選ぶ欄(P3 §2.11)。
 * 直線パターンの「向き」と円形パターンの「軸」は、どちらも model の `PatternDirection` を
 * 使うため `patternDirection` 1つのキーを共用する(計画書タスク27 の型宣言のとおり)。
 */
export interface SolidChoiceSummary {
  /** 長い説明を横一列へ詰めず、1つのメニューで選ぶ。 */
  readonly presentation?: 'menu';
  readonly key:
    | 'depthKind'
    | 'threadDesignation'
    | 'threadSeries'
    | 'threadRepresentation'
    | 'chamferMode'
    | 'patternDirection'
    | 'patternKind'
    /** ばね(FR-414)。タスク29b が使う。 */
    | 'springAxis'
    | 'springHandedness'
    | 'springDerived'
    /**
     * 面をつなぐの「なめらかさ」(球へつなぐときの接点の数、§0.a-0.74。P5 タスク27)。
     * **球を含まない断面では形に効かない**ので、そのときは欄ごと出さない(§0.a-0.87)。
     */
    | 'ruledSphereSegments'
    /* ---- P5 の Should / Could 群と切断(タスク52・27f・55) ---- */
    /** 押し出しの終わり方(FR-415)。距離 / 両側へ / 選んだ面まで / 次の面まで。 */
    | 'extrudeEnd'
    /** 薄板押し出しの厚みの側(FR-416)。内側 / 外側 / 両側。 */
    | 'thicknessSide'
    /** 穴・ねじ穴の入口(FR-422)。広げない / ざぐり / 皿もみ。 */
    | 'holeEntry'
    /** ミラーの鏡にする面(FR-419)。XY / XZ / YZ、選んだ面のときはその 1 つだけ。 */
    | 'mirrorPlane'
    /** 移動/回転の回す軸(FR-424)。回さない / X / Y / Z。 */
    | 'transformAxis'
    /** リブの厚みを付ける側(FR-420)。 */
    | 'ribSide'
    /* 外ねじ(FR-423)。呼び・系列・切り始める端。 */
    | 'threadShaftNominal'
    | 'threadShaftSeries'
    | 'threadShaftFromEnd'
    /** 曲面の作り方(FR-428)。同じ材料で作り直せる範囲だけを選択肢に出す。 */
    | 'surfaceOperation'
    | 'sheetLengthBasis'
    | 'sheetFixedSide'
    | 'sheetReliefShape';
  readonly labelKey: MessageKey;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly labelKey?: MessageKey;
    readonly label?: string;
  }[];
}

/** 選んだ部分形状の数(「選んだ辺 4」のように出す)。個々の番号は利用者に意味が無いので数だけ出す。 */
export interface SolidSubShapeCountSummary {
  readonly labelKey: MessageKey;
  readonly count: number;
}

/**
 * 参照しているもの(もとの面・組み合わせる立体)。座標も形も複製せず、名前だけを引く(FR-311)。
 * 計画書の `{ labelKey, name }` に、クリックでその要素を選べるよう `elementId` を足した。
 */
export interface SolidReferenceSummary {
  readonly labelKey: MessageKey;
  /** 表示名。参照先が見つからないときは参照先の id をそのまま出す。 */
  readonly name: string;
  /** クリックで選べる要素の id。参照先が見つからなければ null(FR-504)。 */
  readonly elementId: string | null;
}

/**
 * 回転軸(FR-402、§0.a-0.9)。ワールドの軸は X / Y / Z を選び直せるが、
 * 線分を軸にしたものは線分そのものを選び直す操作が要るので、名前を読み取り専用で出す。
 */
export type SolidAxisSummary =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly name: string; readonly elementId: string | null };

/** ツリーの行とプロパティ欄が共有する、立体1つの見え方。 */
export interface SolidSummary {
  readonly featureId: string;
  readonly name: string;
  /** 連番の単位で見た種類。ブーリアンは演算ごとに分かれる(和・差・積)。 */
  readonly kind: SolidLabelKey;
  readonly kindLabelKey: MessageKey;
  /** 抑制中(FR-503)。true なら形は計算されない。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
  readonly fields: readonly SolidFieldSummary[];
  readonly toggles: readonly SolidToggleSummary[];
  readonly choices: readonly SolidChoiceSummary[];
  readonly references: readonly SolidReferenceSummary[];
  /** 選んだ部分形状の数(穴の面・中心点、面取りの辺)。持たない種類は空配列。 */
  readonly subShapeCounts: readonly SolidSubShapeCountSummary[];
  /** 回転軸。回転以外は null(パターンの向き・軸は choices の `patternDirection` で出す)。 */
  readonly axis: SolidAxisSummary | null;
}

/**
 * 立体の種類の名前。ツールバーの道具の名前と同じ言葉にする(FR-501)。
 *
 * P3 タスク13 で種類が13個に増え、タスク22 は暫定で7つを共通の「未対応」の文言(
 * `featureTree.unsupportedKind`)にしていた。タスク18(ja.json)・26(ツールバー)で
 * 加工6種+ばねの正式な文言が揃ったので、タスク27 で正式なキーへ置き換え、
 * 暫定キーは ja.json から削除した(統括の指示どおり)。
 */
export const SOLID_KIND_LABEL_KEYS: Readonly<Record<SolidLabelKey, MessageKey>> = {
  sheetBase: 'sheetMetal.base',
  sheetFlange: 'sheetMetal.flange',
  sheetBend: 'sheetMetal.lineBend',
  sheetRelief: 'sheetMetal.relief',
  extrude: 'toolbar.solid.extrude',
  revolve: 'toolbar.solid.revolve',
  sew: 'toolbar.solid.sew',
  union: 'toolbar.solid.union',
  subtract: 'toolbar.solid.subtract',
  intersect: 'toolbar.solid.intersect',
  hole: 'toolbar.machining.hole',
  threadHole: 'toolbar.machining.threadHole',
  fillet: 'toolbar.machining.fillet',
  chamfer: 'toolbar.machining.chamfer',
  linearPattern: 'toolbar.machining.linearPattern',
  circularPattern: 'toolbar.machining.circularPattern',
  spring: 'toolbar.solid.spring',
  // 基本形状5種(FR-429、P5 タスク15)。道具のボタンと案内は **タスク18**。
  sphere: 'toolbar.solid.sphere',
  box: 'toolbar.solid.box',
  cylinder: 'toolbar.solid.cylinder',
  cone: 'toolbar.solid.cone',
  torus: 'toolbar.solid.torus',
  // 面をつなぐ(FR-430)とロフト(FR-410)。P5 タスク25。道具のボタンと案内は **タスク27**。
  ruled: 'toolbar.solid.ruled',
  loft: 'toolbar.solid.loft',
  /*
    P5 の Should 群(§2.11、タスク43)。道具のボタン・案内・説明の文言は **タスク48・50**。
    ここは木とプロパティに種類の名前を出すための最小の割り当てで、
    「作る」の一覧に入る 3 つ(ミラー・スイープ・曲面)は `toolbar.solid.*`、
    「加工」の一覧に入る 6 つ(§2.15 の表)は `toolbar.machining.*` にする。
  */
  mirror: 'toolbar.solid.mirror',
  sweep: 'toolbar.solid.sweep',
  surface: 'toolbar.solid.surface',
  draft: 'toolbar.machining.draft',
  rib: 'toolbar.machining.rib',
  emboss: 'toolbar.machining.emboss',
  threadShaft: 'toolbar.machining.threadShaft',
  transform: 'toolbar.machining.transform',
  scale: 'toolbar.machining.scale',
  pointPattern: 'toolbar.machining.pointPattern',
  // くり抜き(FR-418、§2.12。P5 タスク46 で型・解決・読み書きを前倒しした)。
  // 道具のボタン・案内・説明の文言は **タスク55**。
  shell: 'toolbar.machining.shell',
  // 平面による切断(FR-432、§2.9b。P5 タスク27c)。「加工」の畳んだ一覧に入る
  // (§0.a-0.64)ので `toolbar.machining.*`。道具のボタン・案内・説明は **タスク27f**。
  cut: 'toolbar.machining.cut',
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。対象を取らず新しい
  // ボディを作る「作る」の仲間(基本形状・ばねと同じ)なので `toolbar.solid.*`。
  // 道具のボタン(File > 読み込み)はこのタスクの範囲外。
  importedSolid: 'toolbar.solid.importedSolid',
  importedMesh: 'toolbar.solid.importedMesh',
};

/** プロパティ欄で選び直せるワールドの軸(§0.a-0.9)。線分の軸はここでは選べない。 */
export const WORLD_AXIS_CHOICES: readonly {
  readonly axis: 'x' | 'y' | 'z';
  readonly labelKey: MessageKey;
}[] = [
  { axis: 'x', labelKey: 'numericInput.axis.x' },
  { axis: 'y', labelKey: 'numericInput.axis.y' },
  { axis: 'z', labelKey: 'numericInput.axis.z' },
];

/**
 * 欄の見出し・説明・単位。その場数値入力(numericInput.ts)と同じ言葉を使う。
 *
 * ピッチ・下穴径・傾き・傾ける向きはその場入力を持たない(§0.a-0.10「その場入力には出さず
 * プロパティでだけ編集」、下穴径はねじの呼びから自動で決まる)ので専用の tooltip キーが
 * 無い。ラベルと同じキーを tooltip にも使う(ja.json を増やさない、計画書 §4)。
 */
/** 0 より大きい数だけ(厚み・半径・長さ)。その場入力の `POSITIVE` と同じ形。 */
const POSITIVE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: null,
  maxInclusive: false,
};

/** 0 以上(押し出しの側面の傾きは 0 = まっすぐ)。上限は model の定数が正本。 */
const TAPER_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: MAX_TAPER_ANGLE_DEGREES,
  maxInclusive: true,
};

/** 抜き勾配は 0 度では意味が無いので 0 を含めない(model の `MAX_DRAFT_ANGLE_DEGREES` まで)。 */
const DRAFT_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: MAX_DRAFT_ANGLE_DEGREES,
  maxInclusive: true,
};

/** 皿もみの開き角(度)。0 度と 180 度は円錐にならない。 */
const COUNTERSINK_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 180,
  maxInclusive: false,
};

/** 拡大縮小の倍率。上下限は model の `MIN_SCALE` / `MAX_SCALE` が正本。 */
const SCALE_RANGE: NumericFieldRange = {
  min: MIN_SCALE,
  minInclusive: true,
  max: MAX_SCALE,
  maxInclusive: true,
};

/** 曲面を回す角度(度)。0 度では面にならず、360 度で全周。 */
const SURFACE_ANGLE_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: false,
  max: 360,
  maxInclusive: true,
};

/** 切る面の傾き(度)。§2.9b の断りと同じ 0 以上 180 度未満。 */
const PLANE_TILT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 180,
  maxInclusive: false,
};

const FIELD_DEFINITIONS: Readonly<
  Record<
    SolidFieldKey,
    {
      readonly labelKey: MessageKey;
      readonly tooltipKey: MessageKey;
      readonly unit: FieldUnit;
      readonly range?: NumericFieldRange;
    }
  >
> = {
  ...SHEET_FIELD_DEFINITIONS,
  distance: {
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.extrudeDistance',
    unit: 'mm',
  },
  angle: {
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.angle',
    unit: 'degree',
  },
  tolerance: {
    labelKey: 'numericInput.field.tolerance',
    tooltipKey: 'numericInput.tooltip.tolerance',
    unit: 'mm',
  },
  diameter: {
    labelKey: 'numericInput.field.diameter',
    tooltipKey: 'numericInput.tooltip.diameter',
    unit: 'mm',
  },
  depth: {
    labelKey: 'numericInput.field.depth',
    tooltipKey: 'numericInput.tooltip.depth',
    unit: 'mm',
  },
  radius: {
    labelKey: 'numericInput.field.radius',
    tooltipKey: 'numericInput.tooltip.filletRadius',
    unit: 'mm',
  },
  chamferDistance: {
    labelKey: 'numericInput.field.chamferDistance',
    tooltipKey: 'numericInput.tooltip.chamferDistance',
    unit: 'mm',
  },
  chamferDistance2: {
    labelKey: 'numericInput.field.chamferDistance2',
    tooltipKey: 'numericInput.tooltip.chamferDistance2',
    unit: 'mm',
  },
  chamferAngle: {
    labelKey: 'numericInput.field.chamferAngle',
    tooltipKey: 'numericInput.tooltip.chamferAngle',
    unit: 'degree',
  },
  pitch: { labelKey: 'propertyPanel.pitch', tooltipKey: 'propertyPanel.pitch', unit: 'mm' },
  drillDiameter: {
    labelKey: 'propertyPanel.drillDiameter',
    tooltipKey: 'propertyPanel.drillDiameter',
    unit: 'mm',
  },
  threadLength: {
    labelKey: 'numericInput.field.threadLength',
    tooltipKey: 'numericInput.tooltip.threadLength',
    unit: 'mm',
  },
  tiltAngle: {
    labelKey: 'propertyPanel.tiltAngle',
    tooltipKey: 'propertyPanel.tiltAngle',
    unit: 'degree',
  },
  tiltAzimuth: {
    labelKey: 'propertyPanel.tiltAzimuth',
    tooltipKey: 'propertyPanel.tiltAzimuth',
    unit: 'degree',
  },
  spacing: {
    labelKey: 'numericInput.field.spacing',
    tooltipKey: 'numericInput.tooltip.patternSpacing',
    unit: 'mm',
  },
  count: {
    labelKey: 'numericInput.field.count',
    tooltipKey: 'numericInput.tooltip.patternCount',
    unit: 'count',
  },
  patternAngle: {
    labelKey: 'numericInput.field.patternAngle',
    tooltipKey: 'numericInput.tooltip.patternAngle',
    unit: 'degree',
  },
  coilDiameter: {
    labelKey: 'numericInput.field.coilDiameter',
    tooltipKey: 'numericInput.tooltip.coilDiameter',
    unit: 'mm',
  },
  wireDiameter: {
    labelKey: 'numericInput.field.wireDiameter',
    tooltipKey: 'numericInput.tooltip.wireDiameter',
    unit: 'mm',
  },
  springPitch: {
    labelKey: 'numericInput.field.springPitch',
    tooltipKey: 'numericInput.tooltip.springPitch',
    unit: 'mm',
  },
  springTurns: {
    labelKey: 'numericInput.field.springTurns',
    tooltipKey: 'numericInput.tooltip.springTurns',
    unit: 'count',
  },
  springLength: {
    labelKey: 'numericInput.field.springLength',
    tooltipKey: 'numericInput.tooltip.springLength',
    unit: 'mm',
  },
  // 面をつなぐ・ロフトのねじれ(タスク27)。その場入力の欄とまったく同じ文言キーを使う
  // (同じ数を 2 通りの名前で呼ばない)。単位は個(頂点の数)。
  ruledTwist: {
    labelKey: 'numericInput.field.ruledTwist',
    tooltipKey: 'numericInput.tooltip.ruledTwist',
    unit: 'count',
  },
  /*
    P5 の Should / Could 群と切断(タスク52・27f・55)。見出し・説明・単位・範囲は
    **その場入力(numericInput.ts、タスク49・50・27e)とまったく同じ文言キー**にする。
    同じ数を 2 通りの名前で呼ばないための決めで、ばね・面をつなぐと同じ流儀。
  */
  taperAngle: {
    labelKey: 'propertyPanel.taperAngle',
    tooltipKey: 'numericInput.tooltip.taperAngle',
    unit: 'degree',
    range: TAPER_ANGLE_RANGE,
  },
  extrudeThickness: {
    labelKey: 'propertyPanel.extrudeThickness',
    tooltipKey: 'numericInput.tooltip.extrudeThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  counterboreDiameter: {
    labelKey: 'numericInput.field.counterboreDiameter',
    tooltipKey: 'numericInput.tooltip.counterboreDiameter',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  counterboreDepth: {
    labelKey: 'numericInput.field.counterboreDepth',
    tooltipKey: 'numericInput.tooltip.counterboreDepth',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  countersinkDiameter: {
    labelKey: 'numericInput.field.countersinkDiameter',
    tooltipKey: 'numericInput.tooltip.countersinkDiameter',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  countersinkAngle: {
    labelKey: 'numericInput.field.countersinkAngle',
    tooltipKey: 'numericInput.tooltip.countersinkAngle',
    unit: 'degree',
    range: COUNTERSINK_ANGLE_RANGE,
  },
  radiusEnd: {
    labelKey: 'propertyPanel.filletRadiusEnd',
    tooltipKey: 'numericInput.tooltip.filletRadiusEnd',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  draftAngle: {
    labelKey: 'propertyPanel.draftAngle',
    tooltipKey: 'numericInput.tooltip.draftAngle',
    unit: 'degree',
    range: DRAFT_ANGLE_RANGE,
  },
  translationX: {
    labelKey: 'numericInput.field.x',
    tooltipKey: 'numericInput.tooltip.translationX',
    unit: 'mm',
  },
  translationY: {
    labelKey: 'numericInput.field.y',
    tooltipKey: 'numericInput.tooltip.translationY',
    unit: 'mm',
  },
  translationZ: {
    labelKey: 'numericInput.field.z',
    tooltipKey: 'numericInput.tooltip.translationZ',
    unit: 'mm',
  },
  rotationAngle: {
    labelKey: 'propertyPanel.transformRotationAngle',
    tooltipKey: 'numericInput.tooltip.transformRotation',
    unit: 'degree',
  },
  scaleFactor: {
    labelKey: 'numericInput.field.scaleFactor',
    tooltipKey: 'numericInput.tooltip.scaleFactor',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleX: {
    labelKey: 'numericInput.field.scaleX',
    tooltipKey: 'numericInput.tooltip.scaleX',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleY: {
    labelKey: 'numericInput.field.scaleY',
    tooltipKey: 'numericInput.tooltip.scaleY',
    unit: 'count',
    range: SCALE_RANGE,
  },
  scaleZ: {
    labelKey: 'numericInput.field.scaleZ',
    tooltipKey: 'numericInput.tooltip.scaleZ',
    unit: 'count',
    range: SCALE_RANGE,
  },
  ribThickness: {
    labelKey: 'numericInput.field.wallThickness',
    tooltipKey: 'numericInput.tooltip.ribThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  embossHeight: {
    labelKey: 'numericInput.field.height',
    tooltipKey: 'numericInput.tooltip.embossHeight',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  surfaceDistance: {
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.surfaceDistance',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  surfaceAngle: {
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.surfaceAngle',
    unit: 'degree',
    range: SURFACE_ANGLE_RANGE,
  },
  surfaceOffset: {
    labelKey: 'numericInput.field.surfaceOffset',
    tooltipKey: 'numericInput.tooltip.surfaceOffset',
    unit: 'mm',
  },
  shellThickness: {
    labelKey: 'numericInput.field.wallThickness',
    tooltipKey: 'numericInput.tooltip.wallThickness',
    unit: 'mm',
    range: POSITIVE_RANGE,
  },
  planeOffset: {
    labelKey: 'numericInput.field.planeOffset',
    tooltipKey: 'numericInput.tooltip.planeOffset',
    unit: 'mm',
  },
  planeAngle: {
    labelKey: 'numericInput.field.planeAngle',
    tooltipKey: 'numericInput.tooltip.planeAngle',
    unit: 'degree',
  },
};

/**
 * readOnly は既定 false。既存の呼び出し(加工6種・パターン)は1つも変えない(タスク29b)。
 *
 * `range` は**持っている欄にだけ**足す(持たない欄の要約に `range: undefined` の欄を
 * 生やさない)。P1〜P4 からある欄は範囲を持たないので、要約の形もそのまま変わらない。
 */
function fieldSummary(
  key: SolidFieldKey,
  value: ExpressionValue,
  readOnly = false,
): SolidFieldSummary {
  const definition = FIELD_DEFINITIONS[key];
  const base = {
    key,
    labelKey: definition.labelKey,
    tooltipKey: definition.tooltipKey,
    unit: definition.unit,
    value,
    readOnly,
  };
  return definition.range === undefined ? base : { ...base, range: definition.range };
}

function toggleSummary(key: NumericToggleKey, value: boolean): SolidToggleSummary {
  return { key, labelKey: TOGGLE_LABEL_KEYS[key], value };
}

/** C面取りの「基準の面を入れ替える」(§0.a-0.18)。等距離では効かないので呼び出し側で外す。 */
function swapReferenceFaceToggle(value: boolean): SolidToggleSummary {
  return { key: 'swapReferenceFace', labelKey: 'propertyPanel.swapReferenceFace', value };
}

/**
 * 連番の単位で見た種類。ブーリアンは演算名(union / subtract / intersect)を返し、
 * パターンは配置名(linearPattern / circularPattern)を返す。
 * 名前(和1・差1・直線パターン1)を作る model の `SolidLabelKey` と同じ粒度にして、
 * ツリーの絵と種類の名前が実際の名前と食い違わないようにする。
 */
export function solidKindOf(feature: SolidFeature): SolidLabelKey {
  if (feature.kind === 'boolean') {
    return feature.operation;
  }
  if (feature.kind === 'pattern') {
    // 点集合(FR-425、P5 タスク43)も直線・円形と同じく配置ごとに別の連番にする
    // (model の `SolidLabelKey` と同じ粒度でないと、木の名前と種類の名前が食い違う)。
    switch (feature.placement.kind) {
      case 'linear':
        return 'linearPattern';
      case 'circular':
        return 'circularPattern';
      case 'points':
        return 'pointPattern';
    }
  }
  if (feature.kind === 'primitive') {
    // 基本形状(FR-429)はブーリアンと同じ理屈で、形ごとに別の連番・別の名前にする
    // (「球1」「箱1」…)。木を見て何を置いたのかが分かるようにするため。
    return feature.shape.kind;
  }
  return feature.kind;
}

/** 面の参照を「スケッチ名 / 面の名前」へ直す。見つからなければ id をそのまま出す(FR-504)。 */
function profileReference(document: PartDocument, ref: SketchFaceRef): SolidReferenceSummary {
  const sketch = findSketch(document, ref.sketchId);
  const face = sketch === undefined ? undefined : findFeature(sketch, ref.faceFeatureId);
  if (sketch === undefined || face === undefined || face.kind !== 'face') {
    return { labelKey: 'propertyPanel.profile', name: ref.faceFeatureId, elementId: null };
  }
  return {
    labelKey: 'propertyPanel.profile',
    name: `${sketch.name} / ${face.name}`,
    elementId: face.id,
  };
}

/**
 * 罫線面・ロフトの断面 1 つを、プロパティに出す参照へ直す(FR-430、FR-410、P5 タスク27)。
 *
 * スケッチの面は「スケッチ名 / 面の名前」、立体の面と球は名前だけを出す(面の通し番号は
 * プロパティに出す約束が無く、指紋の中身を利用者に見せても意味がないため)。
 *
 * 見出し(`labelKey`)は**呼び出し側が渡す**。罫線面は「1 つ目の面」「2 つ目の面」で
 * どちらがどちらか読めるようにし、ロフトは並びが意味を持つので全部「断面」にする
 * (タスク27。タスク25 の最小の枝は断面の種類で見出しを変えていたが、種類ではなく
 * **何番目か**のほうが利用者に要る情報である)。
 */
function ruledSectionReference(
  document: PartDocument,
  section: RuledSection,
  labelKey: MessageKey,
): SolidReferenceSummary {
  switch (section.kind) {
    case 'sketchFace': {
      const profile = profileReference(document, section.ref);
      return { ...profile, labelKey };
    }
    case 'solidFace':
      return bodyReference(document, labelKey, section.ref.bodyFeatureId);
    case 'sphere':
      return bodyReference(document, labelKey, section.sphereFeatureId);
  }
}

/** 立体の参照を名前へ直す。見つからなければ id をそのまま出す(FR-504)。 */
function bodyReference(
  document: PartDocument,
  labelKey: MessageKey,
  featureId: string,
): SolidReferenceSummary {
  const found = findSolid(document, featureId);
  return found === undefined
    ? { labelKey, name: featureId, elementId: null }
    : { labelKey, name: found.name, elementId: found.id };
}

/**
 * 読み込んだ形式の表示名(FR-802)。ねじの呼び('M6')と同じく、利用者の言語によらない
 * 技術的な記号なので ja.json を通さずそのまま出す(`threadDesignationChoice` と同じ扱い)。
 */
const IMPORTED_SOURCE_FORMAT_NAMES: Readonly<Record<ImportedSourceFormat, string>> = {
  step: 'STEP',
  stl: 'STL',
  obj: 'OBJ',
  '3mf': '3MF',
  gltf: 'glTF',
};

/** 読み込んだときの長さの単位の表示名(FR-811)。 */
const IMPORTED_SOURCE_UNIT_NAMES: Readonly<Record<LengthUnit, string>> = {
  mm: 'mm',
  inch: 'inch',
};

/**
 * 読み込んだ形の素性(ファイル名・形式・単位・バイト数、FR-802、P6 §2.8)を
 * 読み取り専用の参照へ直す(importedSolid / importedMesh が共有する)。
 *
 * **式の欄を1つも持たない**(履歴が無いので直せる寸法が無い、§0.a-0.9)ので、選び直しの
 * 操作もない。`elementId` はこのフィーチャー自身の id にして、押すと立体を選べるだけの
 * 行にする(`bodyReference` が対象の立体を指すのと同じ扱い。選び直しではなく確認のため)。
 */
function importedSourceReferences(
  featureId: string,
  source: ImportedSource,
): SolidReferenceSummary[] {
  return [
    { labelKey: 'propertyPanel.importedFileName', name: source.fileName, elementId: featureId },
    {
      labelKey: 'propertyPanel.importedFormat',
      name: IMPORTED_SOURCE_FORMAT_NAMES[source.format],
      elementId: featureId,
    },
    {
      labelKey: 'propertyPanel.importedUnit',
      name: IMPORTED_SOURCE_UNIT_NAMES[source.unit],
      elementId: featureId,
    },
    {
      labelKey: 'propertyPanel.importedSize',
      name: String(source.byteLength),
      elementId: featureId,
    },
  ];
}

/** スケッチの線分の名前。見つからなければ id をそのまま返す(FR-504)。 */
function lineReferenceName(document: PartDocument, ref: SketchLineRef): string {
  const sketch = findSketch(document, ref.sketchId);
  const found = sketch === undefined ? undefined : findFeature(sketch, ref.lineFeatureId);
  return found === undefined || found.kind !== 'line' ? ref.lineFeatureId : found.name;
}

/** 基準軸(FR-329)の名前。見つからなければ id をそのまま返す(FR-504)。 */
function referenceAxisName(document: PartDocument, referenceFeatureId: string): string {
  const found = findReference(document, referenceFeatureId);
  return found === undefined || found.kind !== 'referenceAxis' ? referenceFeatureId : found.name;
}

/**
 * 回転軸の見え方。線分の軸と基準軸(FR-329)は名前を引いて読み取り専用で出す(§0.a-0.9)。
 * 基準軸も「名前を出すだけ」で扱いが同じなので `kind: 'line'`(= 読み取り専用の名前)にまとめる。
 */
function axisSummary(document: PartDocument, feature: SolidFeature): SolidAxisSummary | null {
  if (feature.kind !== 'revolve') {
    return null;
  }
  if (feature.axis.kind === 'world') {
    return { kind: 'world', axis: feature.axis.axis };
  }
  if (feature.axis.kind === 'reference') {
    const { referenceFeatureId } = feature.axis;
    return {
      kind: 'line',
      name: referenceAxisName(document, referenceFeatureId),
      elementId: referenceFeatureId,
    };
  }
  const { line } = feature.axis;
  const sketch = findSketch(document, line.sketchId);
  const found = sketch === undefined ? undefined : findFeature(sketch, line.lineFeatureId);
  if (found === undefined || found.kind !== 'line') {
    return { kind: 'line', name: line.lineFeatureId, elementId: null };
  }
  return { kind: 'line', name: found.name, elementId: found.id };
}

/**
 * ほかの立体に取り込まれた立体の id(§0.a-0.5)。
 *
 * 文書だけを見る `consumedBodyIds` と違い、**失敗したブーリアンは何も取り込まない**ものとして
 * 数える。再計算(resolvePart)が失敗した段では消費を確定させないので、失敗を数に入れると
 * 画面には出ているのにツリーだけ「統合済み」と出て食い違う(FR-504)。
 * 失敗が分からないとき(errors を渡さないとき)は文書どおりの判定になる。
 */
function consumedIds(
  document: PartDocument,
  errors: readonly PartRecomputeError[],
): ReadonlySet<string> {
  if (errors.length === 0) {
    return consumedBodyIds(document);
  }
  const failed = new Set(errors.map((error) => error.featureId));
  const survivors = document.solids.filter(
    (feature) => feature.kind !== 'boolean' || !failed.has(feature.id),
  );
  return consumedBodyIds({ ...document, solids: survivors });
}

/** 穴・ねじ穴の「選んだ面 1」「中心の点 N」(subShapeCounts、§0.a-0.9)。 */
function holeSubShapeCounts(
  feature: HoleFeature | ThreadHoleFeature,
): readonly SolidSubShapeCountSummary[] {
  return [
    { labelKey: 'propertyPanel.selectedFaces', count: 1 },
    { labelKey: 'propertyPanel.centerPoints', count: feature.centers.length },
  ];
}

/** 穴の欄。直径・(止まりのときだけ深さ)・傾き・傾ける向き(§0.a-0.10、0.11)。 */
function holeFields(feature: HoleFeature): SolidFieldSummary[] {
  const fields = [fieldSummary('diameter', feature.diameter)];
  if (feature.depth.kind === 'blind') {
    fields.push(fieldSummary('depth', feature.depth.depth));
  }
  fields.push(
    fieldSummary('tiltAngle', feature.tiltAngle),
    fieldSummary('tiltAzimuth', feature.tiltAzimuth),
  );
  return fields;
}

/**
 * ねじ穴の欄。ピッチ・下穴径・ねじ部の長さ・(止まりのときだけ深さ)・傾き・傾ける向き
 * (§0.a-0.10、0.13、0.14。穴の `holeFields` と同じ並びに、規格から入る3つを前へ足す)。
 */
function threadHoleFields(feature: ThreadHoleFeature): SolidFieldSummary[] {
  const fields = [
    fieldSummary('pitch', feature.pitch),
    fieldSummary('drillDiameter', feature.drillDiameter),
    fieldSummary('threadLength', feature.threadLength),
  ];
  if (feature.depth.kind === 'blind') {
    fields.push(fieldSummary('depth', feature.depth.depth));
  }
  fields.push(
    fieldSummary('tiltAngle', feature.tiltAngle),
    fieldSummary('tiltAzimuth', feature.tiltAzimuth),
  );
  return fields;
}

/** 深さの種類(貫通/止まり)を選ぶ欄。穴・ねじ穴で共用する。 */
function depthKindChoice(kind: HoleDepth['kind']): SolidChoiceSummary {
  return {
    key: 'depthKind',
    labelKey: 'propertyPanel.depth',
    value: kind,
    options: [
      { value: 'through', labelKey: 'propertyPanel.through' },
      { value: 'blind', labelKey: 'propertyPanel.blind' },
    ],
  };
}

/** ねじの呼び(M2〜M64)。一覧が長いので `label` に文字をそのまま入れる(numericInput.ts と同じ流儀)。 */
function threadDesignationChoice(designation: string): SolidChoiceSummary {
  return {
    key: 'threadDesignation',
    labelKey: 'propertyPanel.threadDesignation',
    value: designation,
    options: METRIC_THREAD_DESIGNATIONS.map((value) => ({ value, label: value })),
  };
}

/** ねじの種類(並目/細目)。 */
function threadSeriesChoice(series: ThreadSeries): SolidChoiceSummary {
  return {
    key: 'threadSeries',
    labelKey: 'propertyPanel.threadSeries',
    value: series,
    options: [
      { value: 'coarse', labelKey: 'numericInput.threadSeries.coarse' },
      { value: 'fine', labelKey: 'numericInput.threadSeries.fine' },
    ],
  };
}

/** ねじの見せ方(簡略/実際のねじ山、§0.a-0.15、0.16)。 */
function threadRepresentationChoice(representation: ThreadRepresentation): SolidChoiceSummary {
  return {
    key: 'threadRepresentation',
    labelKey: 'propertyPanel.threadRepresentation',
    value: representation,
    options: [
      { value: 'simplified', labelKey: 'propertyPanel.simplified' },
      { value: 'modeled', labelKey: 'propertyPanel.modeled' },
    ],
  };
}

/** C面取りの決め方(等距離/2距離/距離と角度、FR-408)。 */
function chamferModeChoice(kind: ChamferSize['kind']): SolidChoiceSummary {
  return {
    key: 'chamferMode',
    labelKey: 'propertyPanel.chamferMode',
    value: kind,
    options: [
      { value: 'equal', labelKey: 'numericInput.chamferMode.equal' },
      { value: 'twoDistances', labelKey: 'numericInput.chamferMode.twoDistances' },
      { value: 'distanceAngle', labelKey: 'numericInput.chamferMode.distanceAngle' },
    ],
  };
}

/** C面取りの欄。決め方で出る欄が変わる(§0.a-0.18、計画書タスク27の検証表)。 */
function chamferFieldSummaries(size: ChamferSize): SolidFieldSummary[] {
  switch (size.kind) {
    case 'equal':
      return [fieldSummary('chamferDistance', size.distance)];
    case 'twoDistances':
      return [
        fieldSummary('chamferDistance', size.distance1),
        fieldSummary('chamferDistance2', size.distance2),
      ];
    case 'distanceAngle':
      return [
        fieldSummary('chamferDistance', size.distance),
        fieldSummary('chamferAngle', size.angle),
      ];
  }
}

/** ワールドの X / Y / Z(直線パターンの向き・円形パターンの軸で共用)。 */
function patternDirectionOptions(): SolidChoiceSummary['options'] {
  return [
    { value: 'x', labelKey: 'numericInput.axis.x' },
    { value: 'y', labelKey: 'numericInput.axis.y' },
    { value: 'z', labelKey: 'numericInput.axis.z' },
  ];
}

/**
 * 直線パターンの「向き」・円形パターンの「軸」・ばねの「軸」。model の `PatternDirection` と
 * `RevolveAxis`(ばねの軸、§0.a-0.29)は同じ形(`{kind:'world',axis}` / `{kind:'line',line}`)
 * なので、この1つの関数で組み立てる。返す `key` は既定 `patternDirection`(計画書タスク27の
 * 型宣言のとおり)だが、ばねだけは `SolidChoiceSummary.key` に予約されている `springAxis` を
 * 呼び出し側(タスク29b)が渡す。見出しも呼び出し側で使い分ける(直線は「向き」、円形は
 * 「回転軸」、ばねは「軸」)。線分を軸にしているときは、その線分の名前を選択肢に足して
 * 読み取れるようにする(選び直しの操作はタスク29が仕上げる)。
 */
function directionChoice(
  document: PartDocument,
  direction: PatternDirection,
  labelKey: MessageKey,
  key: SolidChoiceSummary['key'] = 'patternDirection',
): SolidChoiceSummary {
  if (direction.kind === 'world') {
    return { key, labelKey, value: direction.axis, options: patternDirectionOptions() };
  }
  // 線分の軸も基準軸(FR-329)も「名前を選択肢に足して読み取れるようにする」だけなので、
  // 同じ 'line' の値へまとめる(選び直しの操作はタスク29・33 が仕上げる)。
  const label =
    direction.kind === 'reference'
      ? referenceAxisName(document, direction.referenceFeatureId)
      : lineReferenceName(document, direction.line);
  return {
    key,
    labelKey,
    value: 'line',
    options: [...patternDirectionOptions(), { value: 'line', label }],
  };
}

/** ばねの始点(スケッチの点)の参照名。見つからなければ id をそのまま出す(FR-504)。 */
function springOriginReference(document: PartDocument, origin: SketchPointRef): SolidReferenceSummary {
  const sketch = findSketch(document, origin.sketchId);
  const point = sketch === undefined ? undefined : findFeature(sketch, origin.pointFeatureId);
  if (sketch === undefined || point === undefined || point.kind !== 'point') {
    return { labelKey: 'propertyPanel.springOrigin', name: origin.pointFeatureId, elementId: null };
  }
  return { labelKey: 'propertyPanel.springOrigin', name: point.name, elementId: point.id };
}

/**
 * ばねの欄(コイル径・線径・ピッチ・巻数・全長)。`derived` が指す欄だけ読み取り専用にする
 * (§0.a-0.30)。並びは §2.11 の表のとおり(コイル径・線径 → ピッチ・巻数 → 全長)。
 */
function springFields(feature: SpringFeature): SolidFieldSummary[] {
  return [
    fieldSummary('coilDiameter', feature.coilDiameter),
    fieldSummary('wireDiameter', feature.wireDiameter),
    fieldSummary('springPitch', feature.pitch, feature.derived === 'pitch'),
    fieldSummary('springTurns', feature.turns, feature.derived === 'turns'),
    fieldSummary('springLength', feature.length, feature.derived === 'length'),
  ];
}

/** ばねの巻き方向(右巻き/左巻き、§0.a-0.33)。 */
function springHandednessChoice(handedness: SpringHandedness): SolidChoiceSummary {
  return {
    key: 'springHandedness',
    labelKey: 'propertyPanel.springHandedness',
    value: handedness,
    options: [
      { value: 'right', labelKey: 'numericInput.springHandedness.right' },
      { value: 'left', labelKey: 'numericInput.springHandedness.left' },
    ],
  };
}

/** ばねの求める値(全長/ピッチ/巻数のうち、他の2つから計算するもの、§0.a-0.30)。 */
function springDerivedChoice(derived: SpringDerived): SolidChoiceSummary {
  return {
    key: 'springDerived',
    labelKey: 'propertyPanel.springDerived',
    value: derived,
    options: [
      { value: 'length', labelKey: 'numericInput.springDerived.length' },
      { value: 'pitch', labelKey: 'numericInput.springDerived.pitch' },
      { value: 'turns', labelKey: 'numericInput.springDerived.turns' },
    ],
  };
}

/**
 * 面をつなぐの「なめらかさ」(球へつなぐときの接点の数、§0.a-0.74)。
 *
 * 選べる数の正本は model の `RULED_SPHERE_SEGMENT_CHOICES`(= カーネルの
 * `SphereSegmentCount`)1 か所だけで、ここは見出しを日本語に付け替えるだけにする。
 * 見出しはその場入力の選択肢とまったく同じ文言キーを使う(同じものを 2 通りの名前で
 * 呼ばない。24b の文言案、docs/報告記録.md 2026-09-05 17:23)。
 */
function ruledSphereSegmentsChoice(segments: RuledSphereSegments): SolidChoiceSummary {
  return {
    key: 'ruledSphereSegments',
    labelKey: 'numericInput.choice.ruledSphereSegments',
    value: String(segments),
    options: RULED_SPHERE_SEGMENT_CHOICES.map((count) => ({
      value: String(count),
      labelKey: RULED_SPHERE_SEGMENT_LABEL_KEYS[count],
    })),
  };
}

/** なめらかさの選択肢の見出し(`numericInput.ts` の同名の表と同じ割り当て)。 */
const RULED_SPHERE_SEGMENT_LABEL_KEYS: Readonly<Record<RuledSphereSegments, MessageKey>> = {
  24: 'numericInput.choice.ruledSphereSegments24',
  48: 'numericInput.choice.ruledSphereSegments48',
  72: 'numericInput.choice.ruledSphereSegments72',
};

/* ------------------------------------------------------------------ *
 * P5 の Should / Could 群と切断の欄・つまみ・選択肢
 * (タスク52・27f・55。§2.11・§2.12・§2.9b)
 * ------------------------------------------------------------------ */

/** つまみ 1 つ。`NumericToggleKey` に無い、プロパティ専用のつまみもここで作れる。 */
function solidToggle(key: SolidToggleKey, labelKey: MessageKey, value: boolean): SolidToggleSummary {
  return { key, labelKey, value };
}

/**
 * 点の参照(拡大縮小の「動かさない点」・点集合パターンの点)を読める 1 行にする。
 *
 * スケッチの欄と**同じ言葉**(`baseSummary`)を使う。原点なら「原点」、かいた点なら
 * 「点1 / 点」、立体の頂点なら「押し出し1 / 立体の頂点」のように出る。
 *
 * **座標の式は出さない。** `PointReference` は座標を持たず「どこを指しているか」だけを
 * 持つ型なので(FR-330 の決め。上流が動けば指し先も動く)、ここで式の欄にできる中身が
 * そもそも無い。位置を数で決めたいときは、その点そのもの(スケッチの点・基準点)を
 * 選んで直す(押すとその要素が選ばれる)。
 */
function pointReferenceSummary(
  document: PartDocument,
  reference: PointReference,
  labelKey: MessageKey,
): SolidReferenceSummary {
  const base = baseSummary(reference, {
    document: findSketch(document, document.activeSketchId) ?? document.sketches[0],
    bodyName: (featureId) => findSolid(document, featureId)?.name ?? null,
  });
  return { labelKey, name: base.text, elementId: base.elementId };
}

/**
 * 押し出しの終わり方(FR-415)。
 *
 * **「選んだ面まで」はプロパティからは選べない**(面を指す操作が要る)ので、いまそれで
 * 作られているときだけ選択肢に出す。回転の線分の軸・穴の面と同じ切り分け。
 */
function extrudeEndChoice(end: ExtrudeEnd): SolidChoiceSummary {
  const options: SolidChoiceSummary['options'] = [
    { value: 'distance', labelKey: 'numericInput.extrudeEnd.distance' },
    { value: 'symmetric', labelKey: 'numericInput.toggle.symmetric' },
    ...(end.kind === 'toFace'
      ? [{ value: 'toFace', labelKey: 'numericInput.extrudeEnd.toFace' } as const]
      : []),
    { value: 'toNext', labelKey: 'numericInput.extrudeEnd.toNext' },
  ];
  return { key: 'extrudeEnd', labelKey: 'propertyPanel.extrudeEnd', value: end.kind, options };
}

/** 薄板の厚みをどちら側へ付けるか(FR-416)。 */
function thicknessSideChoice(side: ThicknessSide): SolidChoiceSummary {
  return {
    key: 'thicknessSide',
    labelKey: 'propertyPanel.thicknessSide',
    value: side,
    options: [
      { value: 'inner', labelKey: 'numericInput.thicknessSide.inner' },
      { value: 'outer', labelKey: 'numericInput.thicknessSide.outer' },
      { value: 'both', labelKey: 'numericInput.thicknessSide.both' },
    ],
  };
}

/** 穴・ねじ穴の入口の形(FR-422、§0.a-0.39)。 */
function holeEntryChoice(entry: HoleEntry): SolidChoiceSummary {
  return {
    key: 'holeEntry',
    labelKey: 'propertyPanel.holeEntry',
    value: entry.kind,
    options: [
      { value: 'plain', labelKey: 'numericInput.holeEntry.plain' },
      { value: 'counterbore', labelKey: 'numericInput.holeEntry.counterbore' },
      { value: 'countersink', labelKey: 'numericInput.holeEntry.countersink' },
    ],
  };
}

/** 入口の形ごとの欄(広げないときは 0 欄)。 */
function holeEntryFields(entry: HoleEntry): SolidFieldSummary[] {
  switch (entry.kind) {
    case 'plain':
      return [];
    case 'counterbore':
      return [
        fieldSummary('counterboreDiameter', entry.diameter),
        fieldSummary('counterboreDepth', entry.depth),
      ];
    case 'countersink':
      return [
        fieldSummary('countersinkDiameter', entry.diameter),
        fieldSummary('countersinkAngle', entry.angle),
      ];
  }
}

/** ミラーの鏡にする面(FR-419)。立体の面を鏡にしているときはその 1 つだけを出す。 */
function mirrorPlaneChoice(feature: MirrorFeature): SolidChoiceSummary {
  const { plane } = feature;
  const options: SolidChoiceSummary['options'] =
    plane.kind === 'face'
      ? [{ value: 'face', labelKey: 'numericInput.mirrorPlane.face' }]
      : [
          { value: 'xy', labelKey: 'numericInput.mirrorPlane.xy' },
          { value: 'xz', labelKey: 'numericInput.mirrorPlane.xz' },
          { value: 'yz', labelKey: 'numericInput.mirrorPlane.yz' },
        ];
  return {
    key: 'mirrorPlane',
    labelKey: 'propertyPanel.mirrorPlane',
    value: plane.kind === 'face' ? 'face' : plane.planeId,
    options,
  };
}

/** 移動/回転の回す軸(FR-424)。null は「回さない」。 */
function transformAxisChoice(axis: AxisSpec | null): SolidChoiceSummary {
  const value = axis === null ? 'none' : axis.kind === 'world' ? axis.axis : 'line';
  const options: SolidChoiceSummary['options'] = [
    { value: 'none', labelKey: 'propertyPanel.transformRotationNone' },
    ...patternDirectionOptions(),
    ...(value === 'line' ? [{ value: 'line', labelKey: 'numericInput.axis.line' } as const] : []),
  ];
  return {
    key: 'transformAxis',
    labelKey: 'propertyPanel.transformRotationAxis',
    value,
    options,
  };
}

/** 移動/回転の欄(FR-424)。回す軸を選んでいるときだけ角度の欄が出る(効かない欄を出さない)。 */
function transformFields(feature: TransformFeature): SolidFieldSummary[] {
  const [x, y, z] = feature.translation;
  const fields = [
    fieldSummary('translationX', x),
    fieldSummary('translationY', y),
    fieldSummary('translationZ', z),
  ];
  if (feature.rotationAxis !== null) {
    fields.push(fieldSummary('rotationAngle', feature.rotationAngle));
  }
  return fields;
}

/** 拡大縮小の欄(FR-424)。全体の倍率 1 欄か、軸ごとの 3 欄か。 */
function scaleFields(feature: ScaleFeature): SolidFieldSummary[] {
  const { factor } = feature;
  return factor.kind === 'uniform'
    ? [fieldSummary('scaleFactor', factor.value)]
    : [
        fieldSummary('scaleX', factor.x),
        fieldSummary('scaleY', factor.y),
        fieldSummary('scaleZ', factor.z),
      ];
}

/** リブの厚みを付ける側(FR-420)。 */
function ribSideChoice(side: RibSide): SolidChoiceSummary {
  return {
    key: 'ribSide',
    labelKey: 'propertyPanel.ribSide',
    value: side,
    options: [
      { value: 'both', labelKey: 'numericInput.ribSide.both' },
      { value: 'positive', labelKey: 'numericInput.ribSide.positive' },
      { value: 'negative', labelKey: 'numericInput.ribSide.negative' },
    ],
  };
}

/** 外ねじの選択肢 3 つ(FR-423)。呼びの一覧はねじ穴とまったく同じ規格表から作る。 */
function threadShaftChoices(feature: ThreadShaftFeature): SolidChoiceSummary[] {
  return [
    {
      key: 'threadShaftNominal',
      labelKey: 'propertyPanel.threadShaftNominal',
      value: feature.nominal,
      options: METRIC_THREAD_DESIGNATIONS.map((value) => ({ value, label: value })),
    },
    {
      key: 'threadShaftSeries',
      labelKey: 'propertyPanel.threadShaftSeries',
      value: feature.series,
      options: [
        { value: 'coarse', labelKey: 'numericInput.threadSeries.coarse' },
        { value: 'fine', labelKey: 'numericInput.threadSeries.fine' },
      ],
    },
    {
      key: 'threadShaftFromEnd',
      labelKey: 'propertyPanel.threadShaftFromEnd',
      value: feature.fromEnd,
      options: [
        { value: 'first', labelKey: 'numericInput.threadShaftEnd.first' },
        { value: 'last', labelKey: 'numericInput.threadShaftEnd.last' },
      ],
    },
  ];
}

/**
 * 曲面の作り方(FR-428)。
 *
 * **選び直せるのは「同じ材料で作り直せる」範囲だけ**にする。輪郭から作る 3 つ
 * (掛ける・回す・平らに張る)は輪郭 1 本をそのまま持ち越せるが、つなぐ(輪郭が複数)と
 * 立体の面から作る 2 つ(写す・離す)は材料そのものが違うので、その群の中だけで選べる。
 * 群をまたぐ切り替えは「選び直し」ではなく作り直しなので、道具から作る。
 */
const SURFACE_PROFILE_KINDS: readonly SurfaceOperation['kind'][] = ['extrude', 'revolve', 'planar'];
const SURFACE_FACE_KINDS: readonly SurfaceOperation['kind'][] = ['face', 'offset'];

const SURFACE_OPERATION_LABEL_KEYS: Readonly<Record<SurfaceOperation['kind'], MessageKey>> = {
  extrude: 'numericInput.surfaceOperation.extrude',
  revolve: 'numericInput.surfaceOperation.revolve',
  planar: 'numericInput.surfaceOperation.planar',
  loft: 'numericInput.surfaceOperation.loft',
  face: 'numericInput.surfaceOperation.face',
  offset: 'numericInput.surfaceOperation.offset',
};

function surfaceOperationChoice(operation: SurfaceOperation): SolidChoiceSummary {
  const kinds = SURFACE_PROFILE_KINDS.includes(operation.kind)
    ? SURFACE_PROFILE_KINDS
    : SURFACE_FACE_KINDS.includes(operation.kind)
      ? SURFACE_FACE_KINDS
      : [operation.kind];
  return {
    key: 'surfaceOperation',
    labelKey: 'propertyPanel.surfaceOperation',
    value: operation.kind,
    options: kinds.map((kind) => ({ value: kind, labelKey: SURFACE_OPERATION_LABEL_KEYS[kind] })),
  };
}

/** 曲面の作り方ごとの欄・つまみ・参照(FR-428)。 */
function surfaceSummaryParts(
  document: PartDocument,
  feature: SurfaceFeature,
): {
  readonly fields: readonly SolidFieldSummary[];
  readonly toggles: readonly SolidToggleSummary[];
  readonly references: readonly SolidReferenceSummary[];
  readonly subShapeCounts: readonly SolidSubShapeCountSummary[];
} {
  const { operation } = feature;
  switch (operation.kind) {
    case 'extrude':
      return {
        fields: [fieldSummary('surfaceDistance', operation.distance)],
        toggles: [toggleSummary('reversed', operation.reversed)],
        references: [],
        subShapeCounts: [
          { labelKey: 'propertyPanel.curveCount', count: operation.profile.curveIds.length },
        ],
      };
    case 'revolve':
      return {
        fields: [fieldSummary('surfaceAngle', operation.angle)],
        toggles: [toggleSummary('reversed', operation.reversed)],
        references: [],
        subShapeCounts: [
          { labelKey: 'propertyPanel.curveCount', count: operation.profile.curveIds.length },
        ],
      };
    case 'planar':
      return {
        fields: [],
        toggles: [],
        references: [],
        subShapeCounts: [
          { labelKey: 'propertyPanel.curveCount', count: operation.profile.curveIds.length },
        ],
      };
    case 'loft':
      return {
        fields: [],
        toggles: [solidToggle('surfaceRuled', 'propertyPanel.surfaceRuled', operation.ruled)],
        references: [],
        subShapeCounts: [
          {
            labelKey: 'propertyPanel.curveCount',
            count: operation.sections.reduce((total, section) => total + section.curveIds.length, 0),
          },
        ],
      };
    case 'face':
      return {
        fields: [],
        toggles: [],
        references: [
          bodyReference(document, 'propertyPanel.targetBody', operation.targetFeatureId),
        ],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedFaces', count: 1 }],
      };
    case 'offset':
      return {
        fields: [fieldSummary('surfaceOffset', operation.distance)],
        toggles: [],
        references: [
          bodyReference(document, 'propertyPanel.targetBody', operation.targetFeatureId),
        ],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedFaces', count: 1 }],
      };
  }
}

/**
 * 切る面の欄(FR-432)。決め方ごとに、式で直せるものだけを出す。
 *
 * 3 点・点と辺・点に平行な面は式を 1 つも持たない(位置と向きは指し先の要素が決める)。
 */
function cutPlaneFields(plane: PlaneSpec): SolidFieldSummary[] {
  switch (plane.kind) {
    case 'pointAndAxis':
      return [fieldSummary('tiltAngle', plane.tilt), fieldSummary('tiltAzimuth', plane.azimuth)];
    case 'face':
    case 'workPlane':
      return [fieldSummary('planeOffset', plane.offset)];
    case 'tilted':
      return [fieldSummary('planeAngle', plane.angle)];
    case 'threePoints':
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return [];
  }
}

/**
 * 切る面の傾きの欄だけは範囲を持たせる(§2.9b の断り「0 度以上 180 度未満」を
 * 押す前に出すため)。`FIELD_DEFINITIONS` の `tiltAngle` は穴と共用で、穴の傾きは
 * P3 からの範囲(その場入力側)に従うので、ここで切断のときだけ差し替える。
 */
function withPlaneTiltRange(field: SolidFieldSummary): SolidFieldSummary {
  return field.key === 'tiltAngle' ? { ...field, range: PLANE_TILT_RANGE } : field;
}

/** 立体1つの見え方をまとめる。ツリーの行とプロパティ欄の両方がこれを読む。 */
export function summarizeSolid(
  document: PartDocument,
  feature: SolidFeature,
  errors: readonly PartRecomputeError[] = [],
): SolidSummary {
  const kind = solidKindOf(feature);
  const base = {
    featureId: feature.id,
    name: feature.name,
    kind,
    kindLabelKey: SOLID_KIND_LABEL_KEYS[kind],
    suppressed: feature.suppressed,
    consumed: consumedIds(document, errors).has(feature.id),
    axis: axisSummary(document, feature),
  };

  switch (feature.kind) {
    case 'sheetRelief': return { ...base, fields: sheetFieldValues(feature).map(([key, value]) => fieldSummary(key, value)),
      toggles: [], choices: [{ key: 'sheetReliefShape', labelKey: 'sheetMetal.reliefShape', value: feature.shape, presentation: 'menu',
        options: [{ value: 'rectangle', labelKey: 'sheetMetal.rectangle' }, { value: 'slot', labelKey: 'sheetMetal.reliefSlot' }] }],
      references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)], subShapeCounts: [] };
    case 'sheetBend': return { ...base, fields: sheetFieldValues(feature).map(([key, value]) => fieldSummary(key, value)),
      toggles: [], choices: [{ key: 'sheetFixedSide', labelKey: 'sheetMetal.fixedSide', value: feature.fixedSide, presentation: 'menu',
        options: [{ value: 'right', labelKey: 'sheetMetal.fixedRight' }, { value: 'left', labelKey: 'sheetMetal.fixedLeft' }] }],
      references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)], subShapeCounts: [] };
    case 'sheetBase': return { ...base, fields: sheetFieldValues(feature).map(([key, value]) => fieldSummary(key, value)),
      toggles: [toggleSummary('reversed', feature.reversed)], choices: [],
      references: [feature.profile, ...feature.holes].map((ref) => profileReference(document, ref)), subShapeCounts: [] };
    case 'sheetFlange': return { ...base, fields: sheetFieldValues(feature).map(([key, value]) => fieldSummary(key, value)),
      toggles: [], choices: feature.profile === null ? [{ key: 'sheetLengthBasis', labelKey: 'sheetMetal.lengthBasis', value: feature.lengthBasis, presentation: 'menu',
        options: [{ value: 'tangent', labelKey: 'sheetMetal.basisTangent' }, { value: 'outer', labelKey: 'sheetMetal.basisOuter' }, { value: 'inner', labelKey: 'sheetMetal.basisInner' }] }] : [],
      references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId),
        ...(feature.profile === null ? [] : [feature.profile.face, ...feature.profile.holes].map((ref) => profileReference(document, ref)))], subShapeCounts: [] };
    case 'extrude': {
      /*
        押し出し(FR-401、FR-415、FR-416。タスク52・55)。**省略できる 5 欄は必ず
        `extrudeShapingOf` を通して読む**(既定値をここへ写さない。model の約束)。

        「両側へ」は P2 の `symmetric` つまみではなく**終わり方の選択肢**で選ぶ
        (同じことを 2 つの操作でできるようにしない。NFR-UX-1)。書き戻す側
        (`setSolidChoice`)が `end` と `symmetric` の両方を必ず揃えるので、
        古い文書(`end` を持たない)でも見え方と保存の中身が食い違わない。

        薄板の厚みと側は、**薄板にしているときだけ**出す(中実の押し出しで厚みの欄を
        出しても効かない。NFR-UX-2)。切り替えは「薄板にする」のつまみ。
      */
      const shaping = extrudeShapingOf(feature);
      const thin = shaping.thickness !== null;
      return {
        ...base,
        fields: [
          fieldSummary('distance', feature.distance),
          fieldSummary('taperAngle', shaping.taperAngle),
          ...(shaping.thickness === null ? [] : [fieldSummary('extrudeThickness', shaping.thickness)]),
        ],
        toggles: [
          toggleSummary('reversed', feature.reversed),
          toggleSummary('taperOutward', shaping.taperOutward),
          toggleSummary('thinWalled', thin),
        ],
        choices: [
          extrudeEndChoice(shaping.end),
          ...(thin ? [thicknessSideChoice(shaping.thicknessSide)] : []),
        ],
        references: [profileReference(document, feature.profile)],
        subShapeCounts: [],
      };
    }
    case 'revolve':
      return {
        ...base,
        fields: [fieldSummary('angle', feature.angle)],
        toggles: [toggleSummary('reversed', feature.reversed)],
        choices: [],
        references: [profileReference(document, feature.profile)],
        subShapeCounts: [],
      };
    case 'sew':
      return {
        ...base,
        fields: [fieldSummary('tolerance', feature.tolerance)],
        toggles: [],
        choices: [],
        references: feature.faces.map((face) => profileReference(document, face)),
        subShapeCounts: [],
      };
    case 'boolean':
      return {
        ...base,
        fields: [],
        toggles: [],
        choices: [],
        references: [
          bodyReference(document, 'propertyPanel.target', feature.targetFeatureId),
          bodyReference(document, 'propertyPanel.tool', feature.toolFeatureId),
        ],
        subShapeCounts: [],
      };
    case 'hole':
      // 入口(ざぐり・皿もみ、FR-422)は **`holeEntryOf` を通して**読む(既定は「広げない」)。
      return {
        ...base,
        fields: [...holeFields(feature), ...holeEntryFields(holeEntryOf(feature))],
        toggles: [],
        choices: [depthKindChoice(feature.depth.kind), holeEntryChoice(holeEntryOf(feature))],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: holeSubShapeCounts(feature),
      };
    case 'threadHole':
      // 深さの種類(貫通/止まり)は穴と同じ選択肢を先頭に置き、続けて呼び・種類・見せ方を出す
      // (§0.a-0.13、0.14。タスク28で深さ・傾きの欄と選択肢を仕上げた)。
      return {
        ...base,
        fields: [...threadHoleFields(feature), ...holeEntryFields(holeEntryOf(feature))],
        toggles: [],
        choices: [
          depthKindChoice(feature.depth.kind),
          holeEntryChoice(holeEntryOf(feature)),
          threadDesignationChoice(feature.designation),
          threadSeriesChoice(feature.series),
          threadRepresentationChoice(feature.representation),
        ],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: holeSubShapeCounts(feature),
      };
    case 'fillet': {
      /*
        R 面取り(FR-407)と可変半径(FR-426、タスク55)。**半径は `filletRadiusOf` を
        通して読む**(終点側の半径は省略できる欄で、既定は「一定半径」)。
        「終わりを別の半径に」を入にしたときだけ 2 欄になる(NFR-UX-2)。
      */
      const radius = filletRadiusOf(feature);
      const variable = radius.kind === 'variable';
      return {
        ...base,
        fields: variable
          ? [fieldSummary('radius', radius.start), fieldSummary('radiusEnd', radius.end)]
          : [fieldSummary('radius', radius.radius)],
        toggles: [toggleSummary('variableRadius', variable)],
        choices: [],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedEdges', count: feature.targets.length }],
      };
    }
    case 'chamfer':
      return {
        ...base,
        fields: chamferFieldSummaries(feature.size),
        // 基準面の入れ替えは2距離・距離+角度のときだけ効く(等距離では効かない、§0.a-0.18)。
        toggles:
          feature.size.kind === 'equal' ? [] : [swapReferenceFaceToggle(feature.swapReferenceFace)],
        choices: [chamferModeChoice(feature.size.kind)],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedEdges', count: feature.targets.length }],
      };
    case 'pattern': {
      const { placement } = feature;
      if (placement.kind === 'linear') {
        return {
          ...base,
          fields: [fieldSummary('spacing', placement.spacing), fieldSummary('count', placement.count)],
          toggles: [toggleSummary('patternSymmetric', placement.symmetric)],
          choices: [directionChoice(document, placement.direction, 'numericInput.choice.patternDirection')],
          references: [bodyReference(document, 'propertyPanel.patternSource', feature.sourceFeatureId)],
          subShapeCounts: [],
        };
      }
      if (placement.kind === 'points') {
        /*
          点の集まりへ複製(FR-425、P5 タスク43)。間隔・角度・個数の欄を持たず、
          置き場所は点そのものが決める。点の一覧をプロパティに並べるのは **タスク52** で、
          ここは `PatternPlacement` に case が増えたときにこの枝を落とさないための最小の
          形である(いまはもとの穴と点の数だけを出す)。
        */
        return {
          ...base,
          fields: [],
          toggles: [],
          choices: [],
          references: [bodyReference(document, 'propertyPanel.patternSource', feature.sourceFeatureId)],
          subShapeCounts: [
            { labelKey: 'propertyPanel.patternPoints', count: placement.points.length },
          ],
        };
      }
      // 全周(fullCircle)のときは角度が 360/個数 で自動なので欄を出さない(NFR-UX-4)。
      const fields = placement.fullCircle
        ? [fieldSummary('count', placement.count)]
        : [fieldSummary('patternAngle', placement.angle), fieldSummary('count', placement.count)];
      return {
        ...base,
        fields,
        toggles: [toggleSummary('fullCircle', placement.fullCircle)],
        choices: [directionChoice(document, placement.axis, 'numericInput.axisGroupLabel')],
        references: [bodyReference(document, 'propertyPanel.patternSource', feature.sourceFeatureId)],
        subShapeCounts: [],
      };
    }
    case 'spring':
      // ばね(FR-414)。始点(スケッチの点)は参照として出し、軸(§0.a-0.29)・巻き方向
      // (§0.a-0.33)・求める値(§0.a-0.30)は choices へ、対象を消費しないので subShapeCounts
      // は空(§0.a-0.36)。
      return {
        ...base,
        fields: springFields(feature),
        toggles: [],
        choices: [
          directionChoice(document, feature.axis, 'propertyPanel.springAxis', 'springAxis'),
          springHandednessChoice(feature.handedness),
          springDerivedChoice(feature.derived),
        ],
        references: [springOriginReference(document, feature.origin)],
        subShapeCounts: [],
      };
    case 'primitive':
      /*
        基本形状(FR-429)。寸法の欄・中心・向きをプロパティへ出すのは **タスク18** で、
        ここはタスク15 で `SolidFeature` の union が広がったときにこの網羅 switch を
        落とさないための最小の枝である。いまは種類と名前(base)だけを出す。
      */
      return {
        ...base,
        fields: [],
        toggles: [],
        choices: [],
        references: [],
        subShapeCounts: [],
      };
    case 'ruled':
      /*
        面をつなぐ(FR-430、P5 タスク27)。ねじれの式の欄と、球へつなぐときの
        「なめらかさ」の 3 択を出す。

        **なめらかさは球を含む断面のときだけ出す**(§0.a-0.87)。球を含まない断面では
        点の数が形に 1 つも効かないので、出すと「変えたのに形が変わらない」ことになる。
        「ねじれが立体の面には効かない」ほうは値が保存されるので欄は出したまま、
        プロパティが注記を添える(`ruledCommands.ts` の `ruledTwistNoteKey`)。
      */
      return {
        ...base,
        fields: [fieldSummary('ruledTwist', feature.twist)],
        toggles: [],
        choices:
          feature.first.kind === 'sphere' || feature.second.kind === 'sphere'
            ? [ruledSphereSegmentsChoice(feature.sphereSegments)]
            : [],
        references: [
          ruledSectionReference(document, feature.first, 'propertyPanel.ruledFirst'),
          ruledSectionReference(document, feature.second, 'propertyPanel.ruledSecond'),
        ],
        subShapeCounts: [],
      };
    case 'loft':
      /*
        ロフト(FR-410)。断面は 2 つ以上なので、**選んだ順のまま**参照として出す
        (並びが形の順そのものなので、順を読めることに意味がある)。球は置けないので
        なめらかさの選択肢は持たない。
      */
      return {
        ...base,
        fields: [fieldSummary('ruledTwist', feature.twist)],
        toggles: [],
        choices: [],
        references: feature.sections.map((section) =>
          ruledSectionReference(document, section, 'propertyPanel.loftSection'),
        ),
        subShapeCounts: [],
      };
    /*
      P5 の Should 群 9 種(§2.11、P5 タスク43)+ くり抜き(FR-418)+ 切断(FR-432)。
      式の欄・つまみ・選択肢はタスク52・27f・55 でここへ入れた。**選び直しに画面での
      指し示しが要るもの(面・辺・輪郭・経路)は欄にせず、数か名前だけを出す**
      (回転の線分の軸・穴の面と同じ切り分け。P2 からの流儀)。
    */
    case 'draft':
      return {
        ...base,
        fields: [fieldSummary('draftAngle', feature.angle)],
        toggles: [toggleSummary('reversed', feature.reversed)],
        choices: [],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [
          { labelKey: 'propertyPanel.draftNeutralFace', count: 1 },
          { labelKey: 'propertyPanel.draftFaces', count: feature.faces.length },
        ],
      };
    case 'mirror':
      return {
        ...base,
        fields: [],
        toggles: [],
        choices: [mirrorPlaneChoice(feature)],
        references: [bodyReference(document, 'propertyPanel.mirrorTarget', feature.targetFeatureId)],
        subShapeCounts:
          feature.plane.kind === 'face'
            ? [{ labelKey: 'propertyPanel.selectedFaces', count: 1 }]
            : [],
      };
    case 'transform':
      return {
        ...base,
        fields: transformFields(feature),
        toggles: [],
        choices: [transformAxisChoice(feature.rotationAxis)],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [],
      };
    case 'scale':
      return {
        ...base,
        fields: scaleFields(feature),
        toggles: [toggleSummary('scalePerAxis', feature.factor.kind === 'perAxis')],
        choices: [],
        references: [
          bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId),
          pointReferenceSummary(document, feature.origin, 'propertyPanel.scaleOrigin'),
        ],
        subShapeCounts: [],
      };
    case 'sweep':
      // スイープ(FR-409)。対象を取らないので断面と経路だけを出す。
      return {
        ...base,
        fields: [],
        toggles: [toggleSummary('sweepFrenet', feature.frenet)],
        choices: [],
        references: [profileReference(document, feature.profile)],
        subShapeCounts: [
          { labelKey: 'propertyPanel.sweepPath', count: feature.path.curveIds.length },
        ],
      };
    case 'rib':
      return {
        ...base,
        fields: [fieldSummary('ribThickness', feature.thickness)],
        toggles: [
          solidToggle('ribExtendToBody', 'propertyPanel.ribExtendToBody', feature.extendToBody),
        ],
        choices: [ribSideChoice(feature.side)],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [
          { labelKey: 'propertyPanel.curveCount', count: feature.profile.curveIds.length },
        ],
      };
    case 'threadShaft':
      return {
        ...base,
        fields: [fieldSummary('pitch', feature.pitch), fieldSummary('threadLength', feature.length)],
        toggles: [toggleSummary('modeledThread', feature.modeled)],
        choices: threadShaftChoices(feature),
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedFaces', count: 1 }],
      };
    case 'shell':
      // くり抜き(FR-418、タスク55)。開ける面は 0 枚でもよいので枚数だけを出す。
      return {
        ...base,
        fields: [fieldSummary('shellThickness', feature.thickness)],
        toggles: [toggleSummary('shellOutward', feature.outward)],
        choices: [],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [
          { labelKey: 'propertyPanel.shellOpenFaces', count: feature.openFaces.length },
        ],
      };
    case 'cut':
      /*
        平面による切断(FR-432、タスク27f)。**切断が持つ式は切る面の中にある**ので、
        決め方ごとに出る欄が変わる(§2.9b.1)。決め方そのものは読み取り専用で出し、
        選び直しはプロパティの「選び直す」ボタン(`PropertyPanel.tsx`)から行う——
        平面の材料(点・辺・面)は画面で指すものなので、欄では選べない。

        残す側は「反対側を残す」のつまみ 1 つで裏返す(§0.a-0.57)。対で作られた
        2 つ目(`pairedWith`)は、相手への案内を参照へ足す。
      */
      return {
        ...base,
        fields: cutPlaneFields(feature.plane).map(withPlaneTiltRange),
        toggles: [
          solidToggle(
            'cutKeepOpposite',
            'numericInput.toggle.cutKeepOpposite',
            feature.keep === 'negative',
          ),
        ],
        choices: [],
        references: [
          bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId),
          ...(feature.pairedWith === null
            ? []
            : [bodyReference(document, 'propertyPanel.cutPaired', feature.pairedWith)]),
        ],
        subShapeCounts: [],
      };
    case 'emboss':
      return {
        ...base,
        fields: [fieldSummary('embossHeight', feature.height)],
        toggles: [toggleSummary('raised', feature.raised)],
        choices: [],
        references: [
          bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId),
          profileReference(document, feature.profile),
        ],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedFaces', count: 1 }],
      };
    case 'surface': {
      // 曲面(FR-428)。作り方 6 種で欄が違うので、1 か所(`surfaceSummaryParts`)で出し分ける。
      const parts = surfaceSummaryParts(document, feature);
      return {
        ...base,
        fields: parts.fields,
        toggles: parts.toggles,
        choices: [surfaceOperationChoice(feature.operation)],
        references: parts.references,
        subShapeCounts: parts.subShapeCounts,
      };
    }
    case 'importedSolid':
      /*
        読み込んだ形(FR-802、P6 §2.8、タスク20)。履歴を持たないので式の欄は1つも無い
        (model の同コメントのとおり)。素性(ファイル名・形式・単位・バイト数)に加え、
        形の種類(solid / shell)も読み取り専用の参照として出す。
      */
      return {
        ...base,
        fields: [],
        toggles: [],
        choices: [],
        references: [
          ...importedSourceReferences(feature.id, feature.source),
          {
            labelKey: 'propertyPanel.importedBodyKind',
            name: feature.bodyKind === 'solid' ? 'Solid' : 'Shell',
            elementId: feature.id,
          },
        ],
        subShapeCounts: [],
      };
    case 'importedMesh':
      /*
        読み込んだ三角形の形(FR-802、P6 §2.8、タスク20)。B-rep にしないので式の欄も
        加工の対象にもならない。三角形の数は必ずあり、体積は閉じていない形では測れず
        省略できる(model の `ImportedMeshFeature.volume` の注釈のとおり)ので「—」を出す。
      */
      return {
        ...base,
        fields: [],
        toggles: [],
        choices: [],
        references: [
          ...importedSourceReferences(feature.id, feature.source),
          {
            labelKey: 'propertyPanel.triangleCount',
            name: String(feature.triangleCount),
            elementId: feature.id,
          },
          {
            labelKey: 'propertyPanel.volume',
            name: feature.volume === undefined ? '—' : formatVolume(feature.volume),
            elementId: feature.id,
          },
        ],
        subShapeCounts: [],
      };
  }
}

/**
 * 式の欄を書き戻した新しいフィーチャーを作る(元は変えない、FR-311)。
 * 妥当な式になったときだけ呼ぶ。その種類が持たない欄なら同じものを返す。
 *
 * `variables` はパラメータ表(FR-207)の変数表(任意引数、P4b タスク22a で追加)。
 * ばね以外の種類は自動生成した式を持たないので使わない。
 */
export function setSolidField(
  feature: SolidFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  switch (feature.kind) {
    case 'sheetBase': case 'sheetFlange': case 'sheetBend': case 'sheetRelief': return setSheetField(feature, key, value);
    case 'extrude':
      return setExtrudeField(feature, key, value);
    case 'revolve':
      return key === 'angle' ? { ...feature, angle: value } : feature;
    case 'sew':
      return key === 'tolerance' ? { ...feature, tolerance: value } : feature;
    case 'hole':
      return setHoleField(feature, key, value);
    case 'threadHole':
      return setThreadHoleField(feature, key, value);
    case 'fillet':
      if (key === 'radius') {
        return { ...feature, radius: value };
      }
      // 終点側の半径は、可変半径にしているときだけ書き戻す(一定半径のときは欄も無い)。
      return key === 'radiusEnd' && filletRadiusOf(feature).kind === 'variable'
        ? { ...feature, radiusEnd: value }
        : feature;
    case 'chamfer':
      return setChamferField(feature, key, value);
    case 'pattern':
      return setPatternField(feature, key, value);
    case 'spring':
      return setSpringField(feature, key, value, variables, options);
    case 'boolean':
      return feature;
    case 'primitive':
      // 基本形状の寸法の書き戻しは **タスク18**(プロパティに欄を出すのと同じ段)。
      // いまは欄が1つも無いので、そのまま返す。
      return feature;
    case 'ruled':
    case 'loft':
      /*
        面をつなぐ・ロフト(FR-430、FR-410、タスク27)。直せるのはねじれ 1 つだけで、
        断面(つなぐ面)はプロパティから選び直せない(選び直すには画面で面を指す操作が
        要る。回転の線分の軸・穴の面と同じ切り分け)。他の欄の名前が来たらそのまま返す
        (`setPrimitiveField` と同じ約束)。
      */
      return key === 'ruledTwist' ? { ...feature, twist: value } : feature;
    case 'draft':
      return key === 'draftAngle' ? { ...feature, angle: value } : feature;
    case 'transform':
      return setTransformField(feature, key, value);
    case 'scale':
      return setScaleField(feature, key, value);
    case 'rib':
      return key === 'ribThickness' ? { ...feature, thickness: value } : feature;
    case 'emboss':
      return key === 'embossHeight' ? { ...feature, height: value } : feature;
    case 'threadShaft':
      if (key === 'pitch') {
        return { ...feature, pitch: value };
      }
      return key === 'threadLength' ? { ...feature, length: value } : feature;
    case 'surface':
      return setSurfaceField(feature, key, value);
    case 'shell':
      return key === 'shellThickness' ? { ...feature, thickness: value } : feature;
    case 'cut':
      return setCutField(feature, key, value);
    case 'mirror':
    case 'sweep':
      // ミラー(FR-419)とスイープ(FR-409)は式の欄を 1 つも持たない
      // (鏡にする面は選択肢、経路と断面は画面で指すもの)。
      return feature;
    case 'importedSolid':
    case 'importedMesh':
      // 読み込んだ形 2 種(FR-802)は履歴を持たず、式の欄が1つも無い(model の
      // `rebuildSolidFeature` と同じ判断)。そのまま返す。
      return feature;
  }
}

/**
 * 押し出しの欄を書き戻す(FR-401、FR-415、FR-416)。
 *
 * 傾きと厚みは**省略できる欄**なので、書き戻すと欄が生える。省略のままにしておく理由が
 * 無い(利用者が値を入れた)ため、既定と同じ値でも欄として保存してよい。
 */
function setExtrudeField(
  feature: ExtrudeFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (key) {
    case 'distance':
      return { ...feature, distance: value };
    case 'taperAngle':
      return { ...feature, taperAngle: value };
    case 'extrudeThickness':
      // 中実の押し出しには厚みの欄が出ていないので、書き戻しも受け付けない
      // (「薄板にする」のつまみを入にしてから直す)。
      return extrudeShapingOf(feature).thickness === null ? feature : { ...feature, thickness: value };
    default:
      return feature;
  }
}

/** 移動/回転の欄を書き戻す(FR-424)。角度は回す軸を選んでいるときだけ効く。 */
function setTransformField(
  feature: TransformFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const [x, y, z] = feature.translation;
  switch (key) {
    case 'translationX':
      return { ...feature, translation: [value, y, z] };
    case 'translationY':
      return { ...feature, translation: [x, value, z] };
    case 'translationZ':
      return { ...feature, translation: [x, y, value] };
    case 'rotationAngle':
      return feature.rotationAxis === null ? feature : { ...feature, rotationAngle: value };
    default:
      return feature;
  }
}

/** 拡大縮小の欄を書き戻す(FR-424)。いまの倍率の持ち方に合う欄だけを受け付ける。 */
function setScaleField(
  feature: ScaleFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const { factor } = feature;
  if (factor.kind === 'uniform') {
    return key === 'scaleFactor' ? { ...feature, factor: { kind: 'uniform', value } } : feature;
  }
  switch (key) {
    case 'scaleX':
      return { ...feature, factor: { ...factor, x: value } };
    case 'scaleY':
      return { ...feature, factor: { ...factor, y: value } };
    case 'scaleZ':
      return { ...feature, factor: { ...factor, z: value } };
    default:
      return feature;
  }
}

/** 曲面の欄を書き戻す(FR-428)。作り方ごとに持っている欄が違う。 */
function setSurfaceField(
  feature: SurfaceFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const { operation } = feature;
  if (operation.kind === 'extrude' && key === 'surfaceDistance') {
    return { ...feature, operation: { ...operation, distance: value } };
  }
  if (operation.kind === 'revolve' && key === 'surfaceAngle') {
    return { ...feature, operation: { ...operation, angle: value } };
  }
  if (operation.kind === 'offset' && key === 'surfaceOffset') {
    return { ...feature, operation: { ...operation, distance: value } };
  }
  return feature;
}

/**
 * 切断の欄を書き戻す(FR-432)。**式は切る面(`PlaneSpec`)の中にある**ので、
 * 決め方ごとに受け付ける欄が変わる。合わない欄が来たら同じものを返す。
 */
function setCutField(
  feature: CutFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const { plane } = feature;
  if (plane.kind === 'pointAndAxis' && key === 'tiltAngle') {
    return { ...feature, plane: { ...plane, tilt: value } };
  }
  if (plane.kind === 'pointAndAxis' && key === 'tiltAzimuth') {
    return { ...feature, plane: { ...plane, azimuth: value } };
  }
  if ((plane.kind === 'face' || plane.kind === 'workPlane') && key === 'planeOffset') {
    return { ...feature, plane: { ...plane, offset: value } };
  }
  if (plane.kind === 'tilted' && key === 'planeAngle') {
    return { ...feature, plane: { ...plane, angle: value } };
  }
  return feature;
}

/**
 * derived が指す `SolidFieldKey`(§0.a-0.30)。`setSpringField` が読み取り専用の欄への
 * 書き戻しを防ぐのに使う。
 */
const SPRING_DERIVED_FIELD_KEY: Readonly<Record<SpringDerived, SolidFieldKey>> = {
  length: 'springLength',
  pitch: 'springPitch',
  turns: 'springTurns',
};

/**
 * 式 `source` を評価する(`solidCommands.ts` の `evaluatedExpressionValue` と同じ考え方。
 * 互いに独立した純関数のパッケージなので同じ小さな式をそれぞれに書く)。失敗しても止めず、
 * source は残して値 0 で作る(FR-504「止めずに警告する」)。
 *
 * `variables` はパラメータ表(FR-207)の変数表。渡さなければ空として扱う(§0.a-9 の申し送り①、
 * P4b タスク22a。ピッチ・巻数にパラメータ名を書いても、ここへ通さないと自動生成した式
 * `板厚*4` の `板厚` が読めず読み取り専用の全長欄だけ `= 0` になっていた)。
 */
function evaluatedExpressionValue(
  source: string,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): ExpressionValue {
  const result = evaluateExpression(source, { ...options, variables });
  return result.ok ? result.value : { source, value: 0, display: '0' };
}

/**
 * ばねの全長・ピッチ・巻数のうち、`derived` が指す1つを他の2つから自動生成した式で
 * 計算し直す(§0.a-0.30)。`solidCommands.ts` の `commitSpring` が使う式(タスク25b で
 * 固定済み)と同じものを、欄を書き換えた直後・求める値を切り替えた直後の書き戻しにも使う。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
function resolveSpringDerivedFields(
  derived: SpringDerived,
  length: ExpressionValue,
  pitch: ExpressionValue,
  turns: ExpressionValue,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): { readonly length: ExpressionValue; readonly pitch: ExpressionValue; readonly turns: ExpressionValue } {
  switch (derived) {
    case 'length':
      return {
        length: evaluatedExpressionValue(composeExpressionSource(pitch.source, turns.source, '*'), variables, options),
        pitch,
        turns,
      };
    case 'pitch':
      return {
        length,
        pitch: evaluatedExpressionValue(composeExpressionSource(length.source, turns.source, '/'), variables, options),
        turns,
      };
    case 'turns':
      return {
        length,
        pitch,
        turns: evaluatedExpressionValue(composeExpressionSource(length.source, pitch.source, '/'), variables, options),
      };
  }
}

/** derived が指す欄を計算し直した新しいばねフィーチャーを作る。 */
function recomputeSpringDerived(
  feature: SpringFeature,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SpringFeature {
  const { length, pitch, turns } = resolveSpringDerivedFields(
    feature.derived,
    feature.length,
    feature.pitch,
    feature.turns,
    variables,
    options,
  );
  return { ...feature, length, pitch, turns };
}

/**
 * ばねの欄を書き戻す(§0.a-0.30)。`derived` が指す欄は読み取り専用なので書き戻さない
 * (`ExpressionField` を無効化しているので onChange は来ないが、念のためここでも防ぐ)。
 * 全長・ピッチ・巻数のどれかを書き換えたときは、derived が指す欄を計算し直して画面の数字を
 * 合わせる(NFR-UX-4。E2E「巻数を書き換えると全長が変わる」の土台)。コイル径・線径は
 * `全長 = ピッチ × 巻数` の関係に関わらないので、書き換えても他の欄は変わらない。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
function setSpringField(
  feature: SpringFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  if (key === SPRING_DERIVED_FIELD_KEY[feature.derived]) {
    return feature;
  }
  switch (key) {
    case 'coilDiameter':
      return { ...feature, coilDiameter: value };
    case 'wireDiameter':
      return { ...feature, wireDiameter: value };
    case 'springPitch':
      return recomputeSpringDerived({ ...feature, pitch: value }, variables, options);
    case 'springTurns':
      return recomputeSpringDerived({ ...feature, turns: value }, variables, options);
    case 'springLength':
      return recomputeSpringDerived({ ...feature, length: value }, variables, options);
    default:
      return feature;
  }
}

/**
 * 入口(ざぐり・皿もみ、FR-422)の欄を書き戻す。いまの入口の形に合わない欄が来たら null を
 * 返し、呼び出し側は同じフィーチャーをそのまま返す。穴とねじ穴で同じ処理を 2 度書かない。
 */
function setHoleEntryField(
  entry: HoleEntry,
  key: SolidFieldKey,
  value: ExpressionValue,
): HoleEntry | null {
  if (entry.kind === 'counterbore' && key === 'counterboreDiameter') {
    return { ...entry, diameter: value };
  }
  if (entry.kind === 'counterbore' && key === 'counterboreDepth') {
    return { ...entry, depth: value };
  }
  if (entry.kind === 'countersink' && key === 'countersinkDiameter') {
    return { ...entry, diameter: value };
  }
  if (entry.kind === 'countersink' && key === 'countersinkAngle') {
    return { ...entry, angle: value };
  }
  return null;
}

function setHoleField(feature: HoleFeature, key: SolidFieldKey, value: ExpressionValue): SolidFeature {
  switch (key) {
    case 'diameter':
      return { ...feature, diameter: value };
    case 'depth':
      return feature.depth.kind === 'blind'
        ? { ...feature, depth: { kind: 'blind', depth: value } }
        : feature;
    case 'tiltAngle':
      return { ...feature, tiltAngle: value };
    case 'tiltAzimuth':
      return { ...feature, tiltAzimuth: value };
    default: {
      const entry = setHoleEntryField(holeEntryOf(feature), key, value);
      return entry === null ? feature : { ...feature, entry };
    }
  }
}

function setThreadHoleField(
  feature: ThreadHoleFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (key) {
    case 'pitch':
      return { ...feature, pitch: value };
    case 'drillDiameter':
      return { ...feature, drillDiameter: value };
    case 'threadLength':
      return { ...feature, threadLength: value };
    case 'depth':
      return feature.depth.kind === 'blind'
        ? { ...feature, depth: { kind: 'blind', depth: value } }
        : feature;
    case 'tiltAngle':
      return { ...feature, tiltAngle: value };
    case 'tiltAzimuth':
      return { ...feature, tiltAzimuth: value };
    default: {
      const entry = setHoleEntryField(holeEntryOf(feature), key, value);
      return entry === null ? feature : { ...feature, entry };
    }
  }
}

function setChamferField(
  feature: ChamferFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (feature.size.kind) {
    case 'equal':
      return key === 'chamferDistance' ? { ...feature, size: { kind: 'equal', distance: value } } : feature;
    case 'twoDistances':
      if (key === 'chamferDistance') {
        return { ...feature, size: { ...feature.size, distance1: value } };
      }
      if (key === 'chamferDistance2') {
        return { ...feature, size: { ...feature.size, distance2: value } };
      }
      return feature;
    case 'distanceAngle':
      if (key === 'chamferDistance') {
        return { ...feature, size: { ...feature.size, distance: value } };
      }
      if (key === 'chamferAngle') {
        return { ...feature, size: { ...feature.size, angle: value } };
      }
      return feature;
  }
}

function setPatternField(
  feature: PatternFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const { placement } = feature;
  if (placement.kind === 'linear') {
    if (key === 'spacing') {
      return { ...feature, placement: { ...placement, spacing: value } };
    }
    if (key === 'count') {
      return { ...feature, placement: { ...placement, count: value } };
    }
    return feature;
  }
  if (placement.kind === 'points') {
    // 点集合(FR-425、P5 タスク43)は式の欄を持たない(置き場所は点そのもの)。
    return feature;
  }
  if (key === 'patternAngle') {
    return { ...feature, placement: { ...placement, angle: value } };
  }
  if (key === 'count') {
    return { ...feature, placement: { ...placement, count: value } };
  }
  return feature;
}

/**
 * 深さの種類を切り替える(貫通 ↔ 止まり)。止まりへ切り替えたときの既定は
 * `DEFAULT_HOLE_DEPTH_MM`(前に止まりで打っていた値は引き継がない。常に既定へ戻す)。
 * 穴・ねじ穴以外は同じものを返す。
 */
export function setSolidDepthKind(feature: SolidFeature, kind: 'through' | 'blind'): SolidFeature {
  if (feature.kind !== 'hole' && feature.kind !== 'threadHole') {
    return feature;
  }
  if (feature.depth.kind === kind) {
    return feature;
  }
  const depth: HoleDepth =
    kind === 'through'
      ? { kind: 'through' }
      : { kind: 'blind', depth: expressionValueFromNumber(DEFAULT_HOLE_DEPTH_MM) };
  return { ...feature, depth };
}

/** 呼びからねじの寸法を引き、いまの系列でピッチ・下穴径を組み立て直す(FR-406)。 */
function applyThreadSize(
  feature: ThreadHoleFeature,
  size: MetricThreadSize,
  series: ThreadSeries,
): ThreadHoleFeature {
  const pitch = metricThreadPitch(size, series);
  return {
    ...feature,
    designation: size.designation,
    series,
    pitch: expressionValueFromNumber(pitch),
    drillDiameter: expressionValueFromNumber(threadMinorDiameter(size.diameter, pitch)),
  };
}

/**
 * ねじの呼びを変える。ピッチ・下穴径も規格表から一緒に変わる(FR-406)。
 * 利用者が個別に上書きしていても、呼びを変え直すとその上書きは失われる(この決めは
 * ヘルプ `thread.md`(タスク28)へ書く)。呼びが見つからない・ねじ穴以外なら同じものを返す。
 */
function setThreadDesignation(feature: SolidFeature, designation: string): SolidFeature {
  if (feature.kind !== 'threadHole') {
    return feature;
  }
  const size = findMetricThread(designation);
  return size === undefined ? feature : applyThreadSize(feature, size, feature.series);
}

/** ねじの種類(並目/細目)を変える。ピッチ・下穴径も一緒に変わる(FR-406)。 */
function setThreadSeries(feature: SolidFeature, series: ThreadSeries): SolidFeature {
  if (feature.kind !== 'threadHole') {
    return feature;
  }
  const size = findMetricThread(feature.designation);
  return size === undefined ? feature : applyThreadSize(feature, size, series);
}

/** ねじの見せ方(簡略/実際のねじ山)を変える。 */
function setThreadRepresentation(
  feature: SolidFeature,
  representation: ThreadRepresentation,
): SolidFeature {
  if (feature.kind !== 'threadHole' || feature.representation === representation) {
    return feature;
  }
  return { ...feature, representation };
}

/** もとの決め方から距離(1つ目)を引き継ぎ、2つ目は既定値で作り直す(§0.a-0.18)。 */
function convertChamferSize(size: ChamferSize, kind: ChamferSize['kind']): ChamferSize {
  const distance = size.kind === 'twoDistances' ? size.distance1 : size.distance;
  switch (kind) {
    case 'equal':
      return { kind: 'equal', distance };
    case 'twoDistances':
      return {
        kind: 'twoDistances',
        distance1: distance,
        distance2: expressionValueFromNumber(DEFAULT_CHAMFER_DISTANCE_MM),
      };
    case 'distanceAngle':
      return {
        kind: 'distanceAngle',
        distance,
        angle: expressionValueFromNumber(DEFAULT_CHAMFER_ANGLE_DEGREES),
      };
  }
}

/** C面取りの決め方を変える。C面取り以外・同じ決め方なら同じものを返す。 */
function setChamferMode(feature: SolidFeature, kind: ChamferSize['kind']): SolidFeature {
  if (feature.kind !== 'chamfer' || feature.size.kind === kind) {
    return feature;
  }
  return { ...feature, size: convertChamferSize(feature.size, kind) };
}

/**
 * パターンの向き・軸をワールドの X / Y / Z へ変える(回転の `setSolidAxis` と同じ扱い)。
 * 選んだ線分への切り替えはタスク29(プロパティの仕上げ)が行う。パターン以外は同じものを返す。
 */
function setPatternDirection(feature: SolidFeature, axis: 'x' | 'y' | 'z'): SolidFeature {
  if (feature.kind !== 'pattern') {
    return feature;
  }
  const direction: PatternDirection = { kind: 'world', axis };
  switch (feature.placement.kind) {
    case 'linear':
      return { ...feature, placement: { ...feature.placement, direction } };
    case 'circular':
      return { ...feature, placement: { ...feature.placement, axis: direction } };
    case 'points':
      // 点集合(FR-425、P5 タスク43)は向きの欄を持たない(置き場所は点そのもの)。
      return feature;
  }
}

/** ばねの軸をワールドの X / Y / Z へ変える(パターンの向き・回転軸と同じ扱い、§0.a-0.29)。 */
function setSpringAxis(feature: SolidFeature, axis: 'x' | 'y' | 'z'): SolidFeature {
  return feature.kind === 'spring' ? { ...feature, axis: { kind: 'world', axis } } : feature;
}

/** ばねの巻き方向を変える(§0.a-0.33)。見た目が左右反転するだけで体積は変わらない。 */
function setSpringHandedness(feature: SolidFeature, handedness: SpringHandedness): SolidFeature {
  return feature.kind === 'spring' ? { ...feature, handedness } : feature;
}

/**
 * 「求める値」を切り替える(§0.a-0.30)。切り替えた直後に、新しく derived になった欄を
 * 他の2つから計算し直して書き戻す(NFR-UX-4「切り替えた瞬間に画面の数字が合う」)。
 *
 * `variables` はパラメータ表の変数表(P4b タスク22a、追加のみ)。
 */
function setSpringDerived(
  feature: SolidFeature,
  derived: SpringDerived,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  if (feature.kind !== 'spring') {
    return feature;
  }
  return recomputeSpringDerived({ ...feature, derived }, variables, options);
}

/**
 * 選択肢の欄を書き戻した新しいフィーチャーを作る(元は変えない、FR-311)。
 * 妥当な値でない・その種類が持たない選択肢なら同じものを返す。
 *
 * `variables` はパラメータ表の変数表(任意引数、P4b タスク22a で追加)。`springDerived` の
 * 切り替え直後の書き戻しにだけ使う。
 */
export function setSolidChoice(
  feature: SolidFeature,
  key: SolidChoiceSummary['key'],
  value: string,
  variables?: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): SolidFeature {
  switch (key) {
    case 'sheetReliefShape': return feature.kind === 'sheetRelief' && (value === 'rectangle' || value === 'slot') ? { ...feature, shape: value } : feature;
    case 'sheetFixedSide': return feature.kind === 'sheetBend' && (value === 'left' || value === 'right') ? { ...feature, fixedSide: value } : feature;
    case 'sheetLengthBasis': return feature.kind === 'sheetFlange' && (value === 'tangent' || value === 'inner' || value === 'outer')
      ? { ...feature, lengthBasis: value } : feature;
    case 'depthKind':
      return value === 'through' || value === 'blind' ? setSolidDepthKind(feature, value) : feature;
    case 'threadDesignation':
      return setThreadDesignation(feature, value);
    case 'threadSeries':
      return value === 'coarse' || value === 'fine' ? setThreadSeries(feature, value) : feature;
    case 'threadRepresentation':
      return value === 'simplified' || value === 'modeled'
        ? setThreadRepresentation(feature, value)
        : feature;
    case 'chamferMode':
      return value === 'equal' || value === 'twoDistances' || value === 'distanceAngle'
        ? setChamferMode(feature, value)
        : feature;
    case 'patternDirection':
      return value === 'x' || value === 'y' || value === 'z'
        ? setPatternDirection(feature, value)
        : feature;
    case 'patternKind':
      // 直線⇔円形の切替は作らない(種類は作成時に決まる、§0.a-0.21)。
      return feature;
    case 'springAxis':
      return value === 'x' || value === 'y' || value === 'z' ? setSpringAxis(feature, value) : feature;
    case 'springHandedness':
      return value === 'right' || value === 'left' ? setSpringHandedness(feature, value) : feature;
    case 'springDerived':
      return value === 'length' || value === 'pitch' || value === 'turns'
        ? setSpringDerived(feature, value, variables, options)
        : feature;
    case 'ruledSphereSegments':
      // 面をつなぐの「なめらかさ」(§0.a-0.74)。3 択の外の値は黙って捨てる(他の選択肢と同じ)。
      return setRuledSphereSegments(feature, value);
    case 'extrudeEnd':
      return setExtrudeEnd(feature, value);
    case 'thicknessSide':
      return value === 'inner' || value === 'outer' || value === 'both'
        ? setThicknessSide(feature, value)
        : feature;
    case 'holeEntry':
      return value === 'plain' || value === 'counterbore' || value === 'countersink'
        ? setHoleEntryKind(feature, value)
        : feature;
    case 'mirrorPlane':
      return setMirrorPlane(feature, value);
    case 'transformAxis':
      return setTransformAxis(feature, value);
    case 'ribSide':
      return value === 'both' || value === 'positive' || value === 'negative'
        ? setRibSide(feature, value)
        : feature;
    case 'threadShaftNominal':
      return setThreadShaftNominal(feature, value);
    case 'threadShaftSeries':
      return value === 'coarse' || value === 'fine'
        ? setThreadShaftSeries(feature, value)
        : feature;
    case 'threadShaftFromEnd':
      return value === 'first' || value === 'last'
        ? setThreadShaftFromEnd(feature, value)
        : feature;
    case 'surfaceOperation':
      return setSurfaceOperationKind(feature, value);
  }
}

/**
 * 押し出しの終わり方を切り替える(FR-415)。
 *
 * **`end` と P2 からの `symmetric` を必ず同時に揃える。** `symmetric` は解決・その場入力・
 * 読み書きがまだ読んでいる欄で、片方だけ変えると同じ文書が 2 通りの意味を持ってしまう
 * (`extrudeShapingOf` は `end` が無いときにだけ `symmetric` を見る)。
 *
 * 「選んだ面まで」はここでは選べない(面を指す操作が要る)ので、来ても何もしない。
 */
function setExtrudeEnd(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'extrude') {
    return feature;
  }
  const end: ExtrudeEnd | null =
    value === 'distance'
      ? { kind: 'distance' }
      : value === 'symmetric'
        ? { kind: 'symmetric' }
        : value === 'toNext'
          ? { kind: 'toNext' }
          : null;
  if (end === null) {
    return feature;
  }
  return { ...feature, end, symmetric: end.kind === 'symmetric' };
}

/** 薄板の厚みの側を切り替える(FR-416)。中実の押し出しには効かない。 */
function setThicknessSide(feature: SolidFeature, side: ThicknessSide): SolidFeature {
  if (feature.kind !== 'extrude' || extrudeShapingOf(feature).thickness === null) {
    return feature;
  }
  return { ...feature, thicknessSide: side };
}

/**
 * 穴・ねじ穴の入口の形を切り替える(FR-422)。切り替えたときの欄は**既定へ戻す**
 * (前に入れていた値は引き継がない。深さの種類の切り替えとまったく同じ決め)。
 */
function setHoleEntryKind(feature: SolidFeature, kind: HoleEntry['kind']): SolidFeature {
  if (feature.kind !== 'hole' && feature.kind !== 'threadHole') {
    return feature;
  }
  if (holeEntryOf(feature).kind === kind) {
    return feature;
  }
  const entry: HoleEntry =
    kind === 'plain'
      ? { kind: 'plain' }
      : kind === 'counterbore'
        ? {
            kind: 'counterbore',
            diameter: expressionValueFromNumber(DEFAULT_COUNTERBORE_DIAMETER_MM),
            depth: expressionValueFromNumber(DEFAULT_COUNTERBORE_DEPTH_MM),
          }
        : {
            kind: 'countersink',
            diameter: expressionValueFromNumber(DEFAULT_COUNTERSINK_DIAMETER_MM),
            angle: expressionValueFromNumber(DEFAULT_COUNTERSINK_ANGLE_DEGREES),
          };
  return { ...feature, entry };
}

/** ミラーの鏡にする面を基準の 3 面へ切り替える(FR-419)。立体の面は画面で選び直す。 */
function setMirrorPlane(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'mirror') {
    return feature;
  }
  if (value !== 'xy' && value !== 'xz' && value !== 'yz') {
    return feature;
  }
  return { ...feature, plane: { kind: 'workPlane', planeId: value } };
}

/**
 * 移動/回転の回す軸を切り替える(FR-424)。`none` は「回さない」で、そのとき角度の欄も
 * 消える。線分の軸(`line`)はプロパティからは選べない(線分を指す操作が要る)。
 */
function setTransformAxis(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'transform') {
    return feature;
  }
  if (value === 'none') {
    return feature.rotationAxis === null ? feature : { ...feature, rotationAxis: null };
  }
  if (value !== 'x' && value !== 'y' && value !== 'z') {
    return feature;
  }
  const rotationAxis: AxisSpec = { kind: 'world', axis: value };
  // 回さない状態から軸を選んだときは、角度が 0 のままだと形が変わらないので既定へ戻す。
  const rotationAngle =
    feature.rotationAxis === null
      ? expressionValueFromNumber(DEFAULT_TRANSFORM_ROTATION_DEGREES)
      : feature.rotationAngle;
  return { ...feature, rotationAxis, rotationAngle };
}

/** リブの厚みを付ける側(FR-420)。 */
function setRibSide(feature: SolidFeature, side: RibSide): SolidFeature {
  return feature.kind === 'rib' ? { ...feature, side } : feature;
}

/** 外ねじの呼びを変える(FR-423)。ピッチも規格表から一緒に変わる(ねじ穴と同じ決め)。 */
function setThreadShaftNominal(feature: SolidFeature, nominal: string): SolidFeature {
  if (feature.kind !== 'threadShaft') {
    return feature;
  }
  const size = findMetricThread(nominal);
  return size === undefined ? feature : applyThreadShaftSize(feature, size, feature.series);
}

/** 外ねじの系列(並目/細目)を変える。ピッチも一緒に変わる。 */
function setThreadShaftSeries(feature: SolidFeature, series: ThreadSeries): SolidFeature {
  if (feature.kind !== 'threadShaft') {
    return feature;
  }
  const size = findMetricThread(feature.nominal);
  return size === undefined ? feature : applyThreadShaftSize(feature, size, series);
}

/**
 * 外ねじの呼び・系列からピッチを入れ直す(FR-406 と同じ規格表)。
 * 下穴径はめねじだけのものなので、外ねじでは触らない。
 */
function applyThreadShaftSize(
  feature: ThreadShaftFeature,
  size: MetricThreadSize,
  series: ThreadSeries,
): ThreadShaftFeature {
  return {
    ...feature,
    nominal: size.designation,
    series,
    pitch: expressionValueFromNumber(metricThreadPitch(size, series)),
  };
}

/** 外ねじを切り始める端(FR-423)。 */
function setThreadShaftFromEnd(feature: SolidFeature, fromEnd: 'first' | 'last'): SolidFeature {
  return feature.kind === 'threadShaft' ? { ...feature, fromEnd } : feature;
}

/**
 * 曲面の作り方を切り替える(FR-428)。**同じ材料で作り直せる範囲だけ**(輪郭から作る 3 つ、
 * 立体の面から作る 2 つ)。群をまたぐ値が来たら何もしない。
 */
function setSurfaceOperationKind(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'surface') {
    return feature;
  }
  const { operation } = feature;
  if (operation.kind === 'extrude' || operation.kind === 'revolve' || operation.kind === 'planar') {
    const profile = surfaceProfileOf(operation);
    switch (value) {
      case 'extrude':
        return {
          ...feature,
          operation: {
            kind: 'extrude',
            profile,
            distance: expressionValueFromNumber(DEFAULT_SURFACE_DISTANCE_MM),
            reversed: false,
          },
        };
      case 'revolve':
        return {
          ...feature,
          operation: {
            kind: 'revolve',
            profile,
            axis: { kind: 'world', axis: 'z' },
            angle: expressionValueFromNumber(DEFAULT_SURFACE_ANGLE_DEGREES),
            reversed: false,
          },
        };
      case 'planar':
        return { ...feature, operation: { kind: 'planar', profile } };
      default:
        return feature;
    }
  }
  if (operation.kind === 'face' && value === 'offset') {
    return {
      ...feature,
      operation: {
        kind: 'offset',
        targetFeatureId: operation.targetFeatureId,
        face: operation.face,
        distance: expressionValueFromNumber(DEFAULT_SURFACE_OFFSET_MM),
      },
    };
  }
  if (operation.kind === 'offset' && value === 'face') {
    return {
      ...feature,
      operation: {
        kind: 'face',
        targetFeatureId: operation.targetFeatureId,
        face: operation.face,
      },
    };
  }
  return feature;
}

/** 輪郭から作る 3 つの作り方が共通して持つ輪郭。 */
function surfaceProfileOf(
  operation: Extract<SurfaceOperation, { kind: 'extrude' | 'revolve' | 'planar' }>,
): SketchCurveRef {
  return operation.profile;
}

/**
 * なめらかさ(球へつなぐときの接点の数)を書き戻す(§0.a-0.74)。
 * 面をつなぐ以外のフィーチャー・3 択の外の値ならそのまま返す。
 */
function setRuledSphereSegments(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'ruled') {
    return feature;
  }
  const segments = RULED_SPHERE_SEGMENT_CHOICES.find((count) => String(count) === value);
  return segments === undefined ? feature : { ...feature, sphereSegments: segments };
}

/** つまみを切り替えた新しいフィーチャーを作る。持たないつまみなら同じものを返す。 */
export function setSolidToggle(
  feature: SolidFeature,
  key: SolidToggleKey,
  value: boolean,
): SolidFeature {
  if (feature.kind === 'extrude') {
    return setExtrudeToggle(feature, key, value);
  }
  if (feature.kind === 'revolve' || feature.kind === 'sheetBase') {
    return key === 'reversed' ? { ...feature, reversed: value } : feature;
  }
  if (feature.kind === 'chamfer') {
    return key === 'swapReferenceFace' ? { ...feature, swapReferenceFace: value } : feature;
  }
  if (feature.kind === 'pattern') {
    if (key === 'patternSymmetric' && feature.placement.kind === 'linear') {
      return { ...feature, placement: { ...feature.placement, symmetric: value } };
    }
    if (key === 'fullCircle' && feature.placement.kind === 'circular') {
      return { ...feature, placement: { ...feature.placement, fullCircle: value } };
    }
    return feature;
  }
  if (feature.kind === 'fillet') {
    /*
      可変半径(FR-426、タスク55)。入にすると終点側の半径の欄が出て、切ると省略へ戻す。
      **切ったときは `undefined` へ戻す**(model の約束: `radiusEnd` は「一定半径」を
      `undefined` で表し、`null` に別の意味を持たせていない)。
    */
    if (key !== 'variableRadius') {
      return feature;
    }
    if (value === (filletRadiusOf(feature).kind === 'variable')) {
      return feature;
    }
    return value
      ? { ...feature, radiusEnd: expressionValueFromNumber(DEFAULT_FILLET_RADIUS_END_MM) }
      : { ...feature, radiusEnd: undefined };
  }
  if (feature.kind === 'draft') {
    return key === 'reversed' ? { ...feature, reversed: value } : feature;
  }
  if (feature.kind === 'sweep') {
    return key === 'sweepFrenet' ? { ...feature, frenet: value } : feature;
  }
  if (feature.kind === 'rib') {
    return key === 'ribExtendToBody' ? { ...feature, extendToBody: value } : feature;
  }
  if (feature.kind === 'emboss') {
    return key === 'raised' ? { ...feature, raised: value } : feature;
  }
  if (feature.kind === 'threadShaft') {
    return key === 'modeledThread' ? { ...feature, modeled: value } : feature;
  }
  if (feature.kind === 'shell') {
    return key === 'shellOutward' ? { ...feature, outward: value } : feature;
  }
  if (feature.kind === 'scale') {
    // 軸ごと ⇔ 全体。切り替えたときは、いまの倍率(全体なら 1 つ、軸ごとなら X)を引き継ぐ。
    if (key !== 'scalePerAxis' || value === (feature.factor.kind === 'perAxis')) {
      return feature;
    }
    const kept =
      feature.factor.kind === 'uniform'
        ? feature.factor.value
        : (feature.factor.x ?? expressionValueFromNumber(DEFAULT_SCALE_FACTOR));
    return {
      ...feature,
      factor: value
        ? { kind: 'perAxis', x: kept, y: kept, z: kept }
        : { kind: 'uniform', value: kept },
    };
  }
  if (feature.kind === 'surface') {
    const { operation } = feature;
    return key === 'surfaceRuled' && operation.kind === 'loft'
      ? { ...feature, operation: { ...operation, ruled: value } }
      : feature;
  }
  if (feature.kind === 'cut') {
    // 反対側を残す(§0.a-0.57)。法線の向きは変えず、残す側だけを裏返す。
    return key === 'cutKeepOpposite'
      ? { ...feature, keep: value ? 'negative' : 'positive' }
      : feature;
  }
  return feature;
}

/**
 * 押し出しのつまみ(FR-401、FR-416)。
 *
 * 「薄板にする」は**厚みの欄そのものを出す/出さない**ためのつまみなので、入にしたときに
 * 既定の厚みを入れ、切ったときは `null`(= 中実)へ戻す。`null` は model が「壁を作らない」の
 * 積極的な指定として使う値で、`undefined`(値を決めていない)とは意味が違う。
 */
function setExtrudeToggle(
  feature: ExtrudeFeature,
  key: SolidToggleKey,
  value: boolean,
): SolidFeature {
  switch (key) {
    case 'reversed':
      return { ...feature, reversed: value };
    case 'taperOutward':
      return { ...feature, taperOutward: value };
    case 'thinWalled': {
      const shaping = extrudeShapingOf(feature);
      if (value === (shaping.thickness !== null)) {
        return feature;
      }
      return value
        ? {
            ...feature,
            thickness: expressionValueFromNumber(DEFAULT_EXTRUDE_THICKNESS_MM),
            thicknessSide: feature.thicknessSide ?? DEFAULT_THICKNESS_SIDE,
          }
        : { ...feature, thickness: null };
    }
    default:
      return feature;
  }
}

/** 回転軸をワールドの X / Y / Z へ変えた新しいフィーチャーを作る。回転以外は同じものを返す。 */
export function setSolidAxis(feature: SolidFeature, axis: 'x' | 'y' | 'z'): SolidFeature {
  if (feature.kind !== 'revolve') {
    return feature;
  }
  return { ...feature, axis: { kind: 'world', axis } };
}

/** 抑制を切り替えた新しいフィーチャーを作る(FR-503)。 */
export function setSolidSuppressed(feature: SolidFeature, suppressed: boolean): SolidFeature {
  return suppressed === feature.suppressed ? feature : { ...feature, suppressed };
}

/** 名前を変えた新しいフィーチャーを作る(FR-503)。空白だけの名前は受け付けず元のまま返す。 */
export function renameSolid(feature: SolidFeature, name: string): SolidFeature {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === feature.name ? feature : { ...feature, name: trimmed };
}

/** 選択中の要素 id から、プロパティ欄に出す立体を決める。立体でなければ null。 */
export function solidForSelection(
  document: PartDocument,
  selection: readonly string[],
): SolidFeature | null {
  const first = selection[0];
  if (first === undefined) {
    return null;
  }
  return findSolid(document, first) ?? null;
}

/** その id の失敗の理由。無ければ null(FR-504)。 */
export function partErrorMessage(
  errors: readonly PartRecomputeError[],
  featureId: string,
): string | null {
  const found = errors.find((error) => error.featureId === featureId);
  return found === undefined ? null : found.message;
}

/**
 * 体積や三角形の数が出せないときに、代わりに出す理由の文言キー(FR-504、NFR-UX-5)。
 * 「—」とだけ出すと利用者が原因を推し量れないため、必ず言葉で理由を出す。
 */
export function missingValueKey(summary: SolidSummary): MessageKey {
  if (summary.suppressed) {
    return 'featureTree.suppressed';
  }
  if (summary.consumed) {
    return 'featureTree.consumed';
  }
  return 'propertyPanel.notComputed';
}

/**
 * 体積の表示(P6 タスク3、FR-811)。**単位の記号は付けずに数だけ**を返す
 * (記号は呼び出し側が `VOLUME_UNIT_KEYS` を引いて添える。既存の呼び出しと同じ形)。
 *
 * - `unit` が `'mm'`(既定): mm³ のまま、有効数字 12 桁で指数表記にしない(§2.4)。
 *   式エンジンの表示規則をそのまま使い、欄ごとに丸め方が違う状態を作らない。
 *   **P5 までの見た目を 1 文字も変えない**ので、引数を省いた呼び出しは以前と同じ文字を返す。
 * - `unit` が `'inch'`: in³ へ換算して小数 `INCH_DISPLAY_DIGITS` 桁(§2.9 の inch の桁)。
 *   例: `formatVolume(8000, 'inch')` = `(20/25.4)³` = `0.488189952757…` → `'0.488'`。
 *   **inch の桁を長さと体積で変えない**(`formatDisplayLength` と同じ 1 つの定数を見る)。
 */
export function formatVolume(volume: number, unit: LengthUnit = 'mm'): string {
  switch (unit) {
    case 'mm':
      return expressionValueFromNumber(volume).display;
    case 'inch':
      return (volume / (MM_PER_INCH * MM_PER_INCH * MM_PER_INCH)).toFixed(INCH_DISPLAY_DIGITS);
  }
}

/**
 * 面積の表示(P6 タスク3、FR-811)。`formatVolume` と同じ書式で、**換算の次数だけが違う**
 * (面積は 25.4 の 2 乗、体積は 3 乗)。
 *
 * P5 までは面積も `formatVolume` に通していた(mm のままなら数を整えるだけなので同じ結果に
 * なる)。inch では次数が違うと値そのものが間違うので、ここで分ける。`unit` を省いた
 * 呼び出しは `formatVolume` と 1 文字も変わらない。
 */
export function formatArea(area: number, unit: LengthUnit = 'mm'): string {
  switch (unit) {
    case 'mm':
      return expressionValueFromNumber(area).display;
    case 'inch':
      return (area / (MM_PER_INCH * MM_PER_INCH)).toFixed(INCH_DISPLAY_DIGITS);
  }
}

/** 体積に添える単位の記号の文言キー(NFR-MA-5)。単位が増えたら型検査がここを落とす。 */
export const VOLUME_UNIT_KEYS: Readonly<Record<LengthUnit, MessageKey>> = {
  mm: 'propertyPanel.unitCubicMillimeter',
  inch: 'propertyPanel.unitCubicInch',
};

/** 面積に添える単位の記号の文言キー(NFR-MA-5)。 */
export const AREA_UNIT_KEYS: Readonly<Record<LengthUnit, MessageKey>> = {
  mm: 'propertyPanel.unitSquareMillimeter',
  inch: 'propertyPanel.unitSquareInch',
};

/** 選んでいるものの種類の見出しキー(重なりを除き、選んだ順)。複数選択のときに出す。 */
export function selectionKindLabelKeys(
  document: PartDocument,
  selection: readonly string[],
): readonly MessageKey[] {
  const keys: MessageKey[] = [];
  for (const id of selection) {
    const solid = findSolid(document, id);
    const key =
      solid === undefined
        ? sketchKindLabelKey(document, id)
        : SOLID_KIND_LABEL_KEYS[solidKindOf(solid)];
    if (key !== null && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * スケッチの要素 id から種類の見出しキーを引く。見つからなければ null。
 * 探す順は `findSketchFeatureAt`(`sketchRefs.ts`)に任せ、**編集中のスケッチを先に**見る。
 * 要素 id はスケッチをまたいで重なるため(P4 仕上げ (g))。
 */
function sketchKindLabelKey(document: PartDocument, elementId: string): MessageKey | null {
  const found = findSketchFeatureAt(document, elementId);
  return found === undefined ? null : FEATURE_KIND_LABEL_KEYS[sketchTreeKindOf(found.feature)];
}

/**
 * ツリーの節(FR-501)。スケッチ・ソリッドに加え、P4 タスク33 で基準ジオメトリの節
 * (作業平面・基準軸・基準点・座標系。FR-328、FR-329)を足した。
 *
 * 基準の節は `buildTreeSections` ではなく `buildReferenceSection` が別に作る。
 * `buildTreeSections` の戻り(スケッチ・ソリッドの 2 節)を変えると、その並びを
 * 前提にした既存の検査が意味を失うため。並べる順は呼び出し側(`FeatureTree.tsx`)が決める。
 */
export type TreeSectionKey = 'sketch' | 'solid' | 'reference';

/** ツリーの行。スケッチの要素・基準ジオメトリ・立体を同じ形で並べる。 */
export interface TreeRow {
  readonly id: string;
  readonly name: string;
  /**
   * 行の頭の絵と種類の名前を決める種類。立体のブーリアンは演算ごとに、
   * スケッチの複製は配置ごとに分かれる(`sketchTreeKindOf` / `solidKindOf`)。
   */
  readonly kind: SketchTreeKind | SolidLabelKey | ReferenceFeatureKind;
  readonly kindLabelKey: MessageKey;
  /** 計算できていない(FR-504)。 */
  readonly hasError: boolean;
  /** 計算できていない理由。ホバーの吹き出しに出す。無ければ null。 */
  readonly errorMessage: string | null;
  /** 抑制中(FR-503)。スケッチの要素と基準ジオメトリは常に false。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
  /**
   * 画面に出していない基準ジオメトリ(`visible: false`、FR-329)。
   * 平面や軸を決めるためだけに置かれた点がこれになる(`appendCoordinatePoints`)。
   * 行は消さずに薄く出し、「補助」の札を添える。消してしまうと、名前を変える・
   * 出し直す・消すの操作(FR-503)がどこからもできなくなるため。
   */
  readonly hidden: boolean;
}

export interface TreeSection {
  readonly key: TreeSectionKey;
  readonly titleKey: MessageKey;
  readonly rows: readonly TreeRow[];
}

/**
 * ツリーの並びを作る(FR-501)。節は必ず「スケッチ」「ソリッド」の2つを返す。
 * 中身が空でも節は返し、呼び手が空のときの案内を出せるようにする(NFR-UX-6)。
 */
export function buildTreeSections(
  document: PartDocument,
  activeSketchId: string,
  sketchErrors: readonly SketchError[],
  partErrors: readonly PartRecomputeError[],
): readonly TreeSection[] {
  // 指し先が消えていたら先頭のスケッチを使う(ストアの activeSketchOf と同じ決め方)。
  const sketch = findSketch(document, activeSketchId) ?? document.sketches[0];
  const sketchRows: readonly TreeRow[] = sketch.features.map((feature) =>
    sketchFeatureRow(feature, sketchErrors),
  );

  const consumed = consumedIds(document, partErrors);
  const solidRows: TreeRow[] = document.solids.map((feature) => {
    const message = partErrorMessage(partErrors, feature.id);
    const kind = solidKindOf(feature);
    return {
      id: feature.id,
      name: feature.name,
      kind,
      kindLabelKey: SOLID_KIND_LABEL_KEYS[kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: feature.suppressed,
      consumed: consumed.has(feature.id),
      hidden: false,
    };
  });

  return [
    { key: 'sketch', titleKey: 'featureTree.sketchGroup', rows: sketchRows },
    { key: 'solid', titleKey: 'featureTree.solidGroup', rows: solidRows },
  ];
}

/**
 * スケッチ 1 本ぶんの節の中身(P4 仕上げ (g)、FR-501)。
 *
 * 部品文書はもともと**複数のスケッチ**を持てる形だったが(`PartDocument.sketches`)、
 * ツリーは編集中の 1 本しか出していなかったので、新しいスケッチを作る・切り替える入口が
 * 画面のどこにも無かった(P4 タスク27 の報告 (A))。ここで文書内の全スケッチを親行として
 * 並べられるようにする。
 *
 * `buildTreeSections` の戻り(スケッチ・ソリッドの 2 節)は 1 行も変えない。あの形を
 * 前提にした既存の検査と、**スケッチが 1 本だけのときの見え方**(親行を出さない従来どおりの
 * 平らな並び)をそのまま残すため。親行を出すかどうかは呼び出し側(`FeatureTree.tsx`)が
 * 本数で決める。
 */
export interface SketchTreeGroup {
  readonly sketchId: string;
  readonly name: string;
  /** いま作図しているスケッチか(親行を太字にし、押すと切り替える)。 */
  readonly active: boolean;
  /** そのスケッチの要素の行。履歴順のまま。 */
  readonly rows: readonly TreeRow[];
  /**
   * このスケッチの要素を参照している立体があるか(FR-504)。
   * true のときは消せない(消すと参照先が消えた立体だけが残る)ので、一覧の「削除」を断る。
   */
  readonly inUse: boolean;
}

/** スケッチの要素 1 つを木の行へ直す。`buildTreeSections` と同じ組み立て。 */
function sketchFeatureRow(feature: SketchFeature, errors: readonly SketchError[]): TreeRow {
  const message = partErrorMessage(errors, feature.id);
  // 複製(FR-324)は配置ごとに絵と名前を変える(P4 タスク33、タスク20 の申し送り)。
  const kind = sketchTreeKindOf(feature);
  return {
    id: feature.id,
    name: feature.name,
    kind,
    kindLabelKey: FEATURE_KIND_LABEL_KEYS[kind],
    hasError: message !== null,
    errorMessage: message,
    suppressed: false,
    consumed: false,
    hidden: false,
  };
}

/**
 * 文書内の全スケッチを、木に出せる形へ並べる(P4 仕上げ (g)、FR-501)。
 *
 * 失敗の理由(`sketchErrors`)を添えるのは**編集中のスケッチだけ**。ストアが持っている
 * `sketchErrors` は編集中の 1 本ぶんしかないため(`useAppStore.ts` の `activeSketchErrors`)、
 * 他のスケッチへ当てはめると、たまたま同じ要素 id を持つ行に他人の理由が出てしまう。
 */
export function buildSketchGroups(
  document: PartDocument,
  sketchErrors: readonly SketchError[] = [],
): readonly SketchTreeGroup[] {
  const usedSketchIds = new Set(document.solids.flatMap((feature) => referencedSketchIds(feature)));
  return document.sketches.map((sketch) => {
    const active = sketch.id === document.activeSketchId;
    return {
      sketchId: sketch.id,
      name: sketch.name,
      active,
      rows: sketch.features.map((feature) =>
        sketchFeatureRow(feature, active ? sketchErrors : []),
      ),
      inUse: usedSketchIds.has(sketch.id),
    };
  });
}

/** 名前を変えたスケッチを作る(FR-503)。空白だけの名前は受け付けず元のまま返す。 */
export function renameSketch(sketch: SketchDocument, name: string): SketchDocument {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === sketch.name ? sketch : { ...sketch, name: trimmed };
}

/** 基準ジオメトリの種類の名前(FR-328、FR-329)。道具の名前と同じ言葉にする。 */
export const REFERENCE_KIND_LABEL_KEYS: Readonly<Record<ReferenceFeatureKind, MessageKey>> = {
  // 作業平面は決め方が 7 通りあるので、道具の名前(「作業平面(3 点)」など)ではなく
  // 種類そのものの名前を使う。決め方は `definitionLabelKey` が別に持つ。
  referencePlane: 'propertyPanel.kind.referencePlane',
  referenceAxis: 'toolbar.reference.axis',
  referencePoint: 'toolbar.reference.point',
  referenceCoordinateSystem: 'toolbar.reference.coordinateSystem',
};

/**
 * 基準ジオメトリの節(FR-328、FR-329、P4 タスク33)。
 *
 * 履歴順にそのまま並べ、`visible: false` のものも薄く(`hidden`)出す。
 * 節を `buildTreeSections` の戻りへ足さず別に作るのは、既に固定してある
 * 「スケッチ・ソリッドの 2 節」という約束を崩さないため(並べる順は呼び出し側が決める)。
 */
export function buildReferenceSection(
  document: PartDocument,
  errors: readonly ReferenceError[] = [],
): TreeSection {
  const rows: TreeRow[] = document.references.map((feature) => {
    const found = errors.find((error) => error.featureId === feature.id);
    const message = found === undefined ? null : found.message;
    return {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      kindLabelKey: REFERENCE_KIND_LABEL_KEYS[feature.kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: false,
      consumed: false,
      hidden: !feature.visible,
    };
  });
  return { key: 'reference', titleKey: 'featureTree.referenceGroup', rows };
}

/**
 * 平面の決め方の名前(FR-328、FR-329、切断は FR-432)。その場入力の言葉と同じものを使う。
 *
 * 基準ジオメトリ(作業平面)と切断の切る面は**同じ `PlaneSpec`** なので、名前の表も
 * 1 つだけにする(同じものを 2 通りの名前で呼ばない)。切断のプロパティ(タスク27f)が
 * 「切る面の決め方」を読み取り専用で出すのに使う。
 */
export const PLANE_SPEC_LABEL_KEYS: Readonly<Record<PlaneSpec['kind'], MessageKey>> = {
  threePoints: 'propertyPanel.planeSpec.threePoints',
  pointAndEdge: 'propertyPanel.planeSpec.pointAndEdge',
  pointAndAxis: 'propertyPanel.planeSpec.pointAndAxis',
  pointAndParallelFace: 'propertyPanel.planeSpec.pointAndParallelFace',
  face: 'propertyPanel.planeSpec.face',
  workPlane: 'propertyPanel.planeSpec.workPlane',
  tilted: 'propertyPanel.planeSpec.tilted',
};

const AXIS_DEFINITION_LABEL_KEYS: Readonly<
  Record<ReferenceAxisDefinition['kind'], MessageKey>
> = {
  twoPoints: 'numericInput.referenceAxisKind.twoPoints',
  edge: 'numericInput.referenceAxisKind.edge',
  faceNormal: 'numericInput.referenceAxisKind.faceNormal',
  faceIntersection: 'numericInput.referenceAxisKind.faceIntersection',
};

const POINT_DEFINITION_LABEL_KEYS: Readonly<
  Record<ReferencePointDefinition['kind'], MessageKey>
> = {
  coordinate: 'numericInput.referencePointKind.coordinate',
  vertex: 'numericInput.referencePointKind.vertex',
  edgeMidpoint: 'numericInput.referencePointKind.edgeMidpoint',
  faceCenter: 'numericInput.referencePointKind.faceCenter',
};

/** 基準ジオメトリで式のまま直せる欄(FR-328)。持たない決め方では空になる。 */
export type ReferenceFieldKey = 'planeOffset' | 'planeTilt' | 'planeAzimuth' | 'planeAngle';

export interface ReferenceFieldSummary {
  readonly key: ReferenceFieldKey;
  readonly labelKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
}

const REFERENCE_FIELD_DEFINITIONS: Readonly<
  Record<ReferenceFieldKey, { readonly labelKey: MessageKey; readonly unit: FieldUnit }>
> = {
  planeOffset: { labelKey: 'numericInput.field.planeOffset', unit: 'mm' },
  planeTilt: { labelKey: 'numericInput.field.planeTilt', unit: 'degree' },
  planeAzimuth: { labelKey: 'numericInput.field.planeAzimuth', unit: 'degree' },
  planeAngle: { labelKey: 'numericInput.field.planeAngle', unit: 'degree' },
};

function referenceField(key: ReferenceFieldKey, value: ExpressionValue): ReferenceFieldSummary {
  const definition = REFERENCE_FIELD_DEFINITIONS[key];
  return { key, labelKey: definition.labelKey, unit: definition.unit, value };
}

/** ツリーの行とプロパティ欄が共有する、基準ジオメトリ 1 つの見え方(FR-328、FR-329)。 */
export interface ReferenceSummary {
  readonly featureId: string;
  readonly name: string;
  readonly kind: ReferenceFeatureKind;
  readonly kindLabelKey: MessageKey;
  /** 画面に出しているか(FR-329)。 */
  readonly visible: boolean;
  /** どうやって決めたか(3 点・辺・面の法線…)。 */
  readonly definitionLabelKey: MessageKey;
  /** 式のまま直せる欄。持たない決め方では空。 */
  readonly fields: readonly ReferenceFieldSummary[];
  /** 座標で置いた基準点(FR-329)の位置。それ以外は null。 */
  readonly coordinate: FeatureCoordinateSummary | null;
  /** 決まらなかった理由。問題が無ければ null(FR-504)。 */
  readonly errorMessage: string | null;
}

/** 平面の決め方が持つ、式のまま直せる欄(FR-328)。 */
function planeSpecFields(spec: PlaneSpec): readonly ReferenceFieldSummary[] {
  switch (spec.kind) {
    case 'face':
    case 'workPlane':
      return [referenceField('planeOffset', spec.offset)];
    case 'pointAndAxis':
      return [
        referenceField('planeTilt', spec.tilt),
        referenceField('planeAzimuth', spec.azimuth),
      ];
    case 'tilted':
      return [referenceField('planeAngle', spec.angle)];
    case 'threePoints':
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return [];
  }
}

/** 基準ジオメトリ 1 つの見え方をまとめる(FR-328、FR-329、P4 タスク33)。 */
export function summarizeReference(
  feature: ReferenceFeature,
  errors: readonly ReferenceError[] = [],
): ReferenceSummary {
  const found = errors.find((error) => error.featureId === feature.id);
  const base = {
    featureId: feature.id,
    name: feature.name,
    kind: feature.kind,
    kindLabelKey: REFERENCE_KIND_LABEL_KEYS[feature.kind],
    visible: feature.visible,
    errorMessage: found === undefined ? null : found.message,
  };
  switch (feature.kind) {
    case 'referencePlane':
      return {
        ...base,
        definitionLabelKey: PLANE_SPEC_LABEL_KEYS[feature.plane.kind],
        fields: planeSpecFields(feature.plane),
        coordinate: null,
      };
    case 'referenceAxis':
      return {
        ...base,
        definitionLabelKey: AXIS_DEFINITION_LABEL_KEYS[feature.definition.kind],
        fields: [],
        coordinate: null,
      };
    case 'referencePoint':
      return {
        ...base,
        definitionLabelKey: POINT_DEFINITION_LABEL_KEYS[feature.definition.kind],
        fields: [],
        coordinate:
          feature.definition.kind === 'coordinate'
            ? coordinateSummaryFor('at', feature.definition.at)
            : null,
      };
    case 'referenceCoordinateSystem':
      return {
        ...base,
        definitionLabelKey: 'propertyPanel.planeSpec.coordinateSystem',
        fields: [],
        coordinate: null,
      };
  }
}

/** 平面の決め方の欄を書き戻す(FR-328)。持たない欄なら同じものを返す。 */
function setPlaneSpecField(
  spec: PlaneSpec,
  key: ReferenceFieldKey,
  value: ExpressionValue,
): PlaneSpec {
  if ((spec.kind === 'face' || spec.kind === 'workPlane') && key === 'planeOffset') {
    return { ...spec, offset: value };
  }
  if (spec.kind === 'pointAndAxis' && key === 'planeTilt') {
    return { ...spec, tilt: value };
  }
  if (spec.kind === 'pointAndAxis' && key === 'planeAzimuth') {
    return { ...spec, azimuth: value };
  }
  if (spec.kind === 'tilted' && key === 'planeAngle') {
    return { ...spec, angle: value };
  }
  return spec;
}

/** 式の欄を書き戻した新しい基準ジオメトリを作る(FR-202、FR-311)。 */
export function setReferenceField(
  feature: ReferenceFeature,
  key: ReferenceFieldKey,
  value: ExpressionValue,
): ReferenceFeature {
  if (feature.kind !== 'referencePlane') {
    return feature;
  }
  const plane = setPlaneSpecField(feature.plane, key, value);
  return plane === feature.plane ? feature : { ...feature, plane };
}

/** 座標で置いた基準点(FR-329)の 1 欄を書き戻す。それ以外は同じものを返す。 */
export function setReferenceCoordinate(
  feature: ReferenceFeature,
  at: CoordinateInput,
): ReferenceFeature {
  if (feature.kind !== 'referencePoint' || feature.definition.kind !== 'coordinate') {
    return feature;
  }
  return at === feature.definition.at
    ? feature
    : { ...feature, definition: { kind: 'coordinate', at } };
}

/** 名前を変えた新しい基準ジオメトリを作る(FR-503)。空白だけの名前は受け付けない。 */
export function renameReference(feature: ReferenceFeature, name: string): ReferenceFeature {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === feature.name ? feature : { ...feature, name: trimmed };
}

/** 表示・非表示を切り替えた新しい基準ジオメトリを作る(FR-329)。 */
export function setReferenceVisible(
  feature: ReferenceFeature,
  visible: boolean,
): ReferenceFeature {
  return feature.visible === visible ? feature : { ...feature, visible };
}
