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

import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  consumedBodyIds,
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_HOLE_DEPTH_MM,
  findFeature,
  findMetricThread,
  findSketch,
  findSolid,
  METRIC_THREAD_DESIGNATIONS,
  metricThreadPitch,
  threadMinorDiameter,
  type ChamferFeature,
  type ChamferSize,
  type HoleDepth,
  type HoleFeature,
  type MetricThreadSize,
  type PartDocument,
  type PartRecomputeError,
  type PatternDirection,
  type PatternFeature,
  type SketchError,
  type SketchFaceRef,
  type SketchFeatureKind,
  type SketchLineRef,
  type SketchPointRef,
  type SolidFeature,
  type SolidLabelKey,
  type SpringDerived,
  type SpringFeature,
  type SpringHandedness,
  type ThreadHoleFeature,
  type ThreadRepresentation,
  type ThreadSeries,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { FEATURE_KIND_LABEL_KEYS } from '../sketch/featureSummary.js';
import { TOGGLE_LABEL_KEYS, type FieldUnit, type NumericToggleKey } from '../sketch/numericInput.js';

/**
 * プロパティ欄で式のまま直せる欄の種類。種類ごとに1つだけ持つ。
 * P3 タスク27 で加工6種の欄(直径・深さ・半径・面取りの距離2種・傾き2種・ピッチ・下穴径・
 * ねじ部の長さ・パターンの間隔・個数・角度)を足した。ばねの5つ(コイル径〜全長)は
 * タスク29b が使う欄で、型はここでまとめて広げる(計画書タスク27 の型宣言のとおり)。
 */
export type SolidFieldKey =
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
  | 'springLength';

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
}

/**
 * 立体側だけが持つつまみ(C面取りの「基準の面を入れ替える」、§0.a-0.18)。
 * その場入力の `NumericToggleKey`(numericInput.ts)には無い。numericInput.ts は
 * P1・P2 の振る舞いを1つも変えない約束(計画書 §4)なので、ここだけで型を広げる。
 */
export type SolidToggleKey = NumericToggleKey | 'swapReferenceFace';

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
    | 'springDerived';
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
const FIELD_DEFINITIONS: Readonly<
  Record<
    SolidFieldKey,
    { readonly labelKey: MessageKey; readonly tooltipKey: MessageKey; readonly unit: FieldUnit }
  >
> = {
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
};

/** readOnly は既定 false。既存の呼び出し(加工6種・パターン)は1つも変えない(タスク29b)。 */
function fieldSummary(
  key: SolidFieldKey,
  value: ExpressionValue,
  readOnly = false,
): SolidFieldSummary {
  const definition = FIELD_DEFINITIONS[key];
  return {
    key,
    labelKey: definition.labelKey,
    tooltipKey: definition.tooltipKey,
    unit: definition.unit,
    value,
    readOnly,
  };
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
    return feature.placement.kind === 'linear' ? 'linearPattern' : 'circularPattern';
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

/** スケッチの線分の名前。見つからなければ id をそのまま返す(FR-504)。 */
function lineReferenceName(document: PartDocument, ref: SketchLineRef): string {
  const sketch = findSketch(document, ref.sketchId);
  const found = sketch === undefined ? undefined : findFeature(sketch, ref.lineFeatureId);
  return found === undefined || found.kind !== 'line' ? ref.lineFeatureId : found.name;
}

/** 回転軸の見え方。線分の軸は名前を引いて読み取り専用で出す(§0.a-0.9)。 */
function axisSummary(document: PartDocument, feature: SolidFeature): SolidAxisSummary | null {
  if (feature.kind !== 'revolve') {
    return null;
  }
  if (feature.axis.kind === 'world') {
    return { kind: 'world', axis: feature.axis.axis };
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
  return {
    key,
    labelKey,
    value: 'line',
    options: [
      ...patternDirectionOptions(),
      { value: 'line', label: lineReferenceName(document, direction.line) },
    ],
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
    case 'extrude':
      return {
        ...base,
        fields: [fieldSummary('distance', feature.distance)],
        toggles: [
          toggleSummary('reversed', feature.reversed),
          toggleSummary('symmetric', feature.symmetric),
        ],
        choices: [],
        references: [profileReference(document, feature.profile)],
        subShapeCounts: [],
      };
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
      return {
        ...base,
        fields: holeFields(feature),
        toggles: [],
        choices: [depthKindChoice(feature.depth.kind)],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: holeSubShapeCounts(feature),
      };
    case 'threadHole':
      // 深さの種類(貫通/止まり)は穴と同じ選択肢を先頭に置き、続けて呼び・種類・見せ方を出す
      // (§0.a-0.13、0.14。タスク28で深さ・傾きの欄と選択肢を仕上げた)。
      return {
        ...base,
        fields: threadHoleFields(feature),
        toggles: [],
        choices: [
          depthKindChoice(feature.depth.kind),
          threadDesignationChoice(feature.designation),
          threadSeriesChoice(feature.series),
          threadRepresentationChoice(feature.representation),
        ],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: holeSubShapeCounts(feature),
      };
    case 'fillet':
      return {
        ...base,
        fields: [fieldSummary('radius', feature.radius)],
        toggles: [],
        choices: [],
        references: [bodyReference(document, 'propertyPanel.targetBody', feature.targetFeatureId)],
        subShapeCounts: [{ labelKey: 'propertyPanel.selectedEdges', count: feature.targets.length }],
      };
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
  }
}

/**
 * 式の欄を書き戻した新しいフィーチャーを作る(元は変えない、FR-311)。
 * 妥当な式になったときだけ呼ぶ。その種類が持たない欄なら同じものを返す。
 */
export function setSolidField(
  feature: SolidFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (feature.kind) {
    case 'extrude':
      return key === 'distance' ? { ...feature, distance: value } : feature;
    case 'revolve':
      return key === 'angle' ? { ...feature, angle: value } : feature;
    case 'sew':
      return key === 'tolerance' ? { ...feature, tolerance: value } : feature;
    case 'hole':
      return setHoleField(feature, key, value);
    case 'threadHole':
      return setThreadHoleField(feature, key, value);
    case 'fillet':
      return key === 'radius' ? { ...feature, radius: value } : feature;
    case 'chamfer':
      return setChamferField(feature, key, value);
    case 'pattern':
      return setPatternField(feature, key, value);
    case 'spring':
      return setSpringField(feature, key, value);
    case 'boolean':
      return feature;
  }
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
 */
function evaluatedExpressionValue(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  return result.ok ? result.value : { source, value: 0, display: '0' };
}

/**
 * ばねの全長・ピッチ・巻数のうち、`derived` が指す1つを他の2つから自動生成した式で
 * 計算し直す(§0.a-0.30)。`solidCommands.ts` の `commitSpring` が使う式(タスク25b で
 * 固定済み)と同じものを、欄を書き換えた直後・求める値を切り替えた直後の書き戻しにも使う。
 */
function resolveSpringDerivedFields(
  derived: SpringDerived,
  length: ExpressionValue,
  pitch: ExpressionValue,
  turns: ExpressionValue,
): { readonly length: ExpressionValue; readonly pitch: ExpressionValue; readonly turns: ExpressionValue } {
  switch (derived) {
    case 'length':
      return { length: evaluatedExpressionValue(`${pitch.source}*${turns.source}`), pitch, turns };
    case 'pitch':
      return { length, pitch: evaluatedExpressionValue(`${length.source}/${turns.source}`), turns };
    case 'turns':
      return { length, pitch, turns: evaluatedExpressionValue(`${length.source}/${pitch.source}`) };
  }
}

/** derived が指す欄を計算し直した新しいばねフィーチャーを作る。 */
function recomputeSpringDerived(feature: SpringFeature): SpringFeature {
  const { length, pitch, turns } = resolveSpringDerivedFields(
    feature.derived,
    feature.length,
    feature.pitch,
    feature.turns,
  );
  return { ...feature, length, pitch, turns };
}

/**
 * ばねの欄を書き戻す(§0.a-0.30)。`derived` が指す欄は読み取り専用なので書き戻さない
 * (`ExpressionField` を無効化しているので onChange は来ないが、念のためここでも防ぐ)。
 * 全長・ピッチ・巻数のどれかを書き換えたときは、derived が指す欄を計算し直して画面の数字を
 * 合わせる(NFR-UX-4。E2E「巻数を書き換えると全長が変わる」の土台)。コイル径・線径は
 * `全長 = ピッチ × 巻数` の関係に関わらないので、書き換えても他の欄は変わらない。
 */
function setSpringField(
  feature: SpringFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
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
      return recomputeSpringDerived({ ...feature, pitch: value });
    case 'springTurns':
      return recomputeSpringDerived({ ...feature, turns: value });
    case 'springLength':
      return recomputeSpringDerived({ ...feature, length: value });
    default:
      return feature;
  }
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
    default:
      return feature;
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
    default:
      return feature;
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
  return feature.placement.kind === 'linear'
    ? { ...feature, placement: { ...feature.placement, direction } }
    : { ...feature, placement: { ...feature.placement, axis: direction } };
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
 */
function setSpringDerived(feature: SolidFeature, derived: SpringDerived): SolidFeature {
  if (feature.kind !== 'spring') {
    return feature;
  }
  return recomputeSpringDerived({ ...feature, derived });
}

/**
 * 選択肢の欄を書き戻した新しいフィーチャーを作る(元は変えない、FR-311)。
 * 妥当な値でない・その種類が持たない選択肢なら同じものを返す。
 */
export function setSolidChoice(
  feature: SolidFeature,
  key: SolidChoiceSummary['key'],
  value: string,
): SolidFeature {
  switch (key) {
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
        ? setSpringDerived(feature, value)
        : feature;
  }
}

/** つまみを切り替えた新しいフィーチャーを作る。持たないつまみなら同じものを返す。 */
export function setSolidToggle(
  feature: SolidFeature,
  key: SolidToggleKey,
  value: boolean,
): SolidFeature {
  if (feature.kind === 'extrude') {
    if (key === 'reversed') {
      return { ...feature, reversed: value };
    }
    return key === 'symmetric' ? { ...feature, symmetric: value } : feature;
  }
  if (feature.kind === 'revolve') {
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
  return feature;
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
 * 体積の表示(mm³)。有効数字 12 桁で、指数表記にしない(§2.4)。
 * 式エンジンの表示規則をそのまま使い、欄ごとに丸め方が違う状態を作らない。
 */
export function formatVolume(volume: number): string {
  return expressionValueFromNumber(volume).display;
}

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

/** スケッチの要素 id から種類の見出しキーを引く。見つからなければ null。 */
function sketchKindLabelKey(document: PartDocument, elementId: string): MessageKey | null {
  const separator = elementId.indexOf('#');
  const featureId = separator < 0 ? elementId : elementId.slice(0, separator);
  for (const sketch of document.sketches) {
    const found = findFeature(sketch, featureId);
    if (found !== undefined) {
      return FEATURE_KIND_LABEL_KEYS[found.kind];
    }
  }
  return null;
}

/** ツリーの節。スケッチの節とソリッドの節に分ける(FR-501)。 */
export type TreeSectionKey = 'sketch' | 'solid';

/** ツリーの行。スケッチの要素と立体を同じ形で並べる。 */
export interface TreeRow {
  readonly id: string;
  readonly name: string;
  /** 行の頭の絵と種類の名前を決める種類。立体のブーリアンは演算ごとに分かれる。 */
  readonly kind: SketchFeatureKind | SolidLabelKey;
  readonly kindLabelKey: MessageKey;
  /** 計算できていない(FR-504)。 */
  readonly hasError: boolean;
  /** 計算できていない理由。ホバーの吹き出しに出す。無ければ null。 */
  readonly errorMessage: string | null;
  /** 抑制中(FR-503)。スケッチの要素は常に false。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
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
  const sketchRows: TreeRow[] = sketch.features.map((feature) => {
    const message = partErrorMessage(sketchErrors, feature.id);
    return {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      kindLabelKey: FEATURE_KIND_LABEL_KEYS[feature.kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: false,
      consumed: false,
    };
  });

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
    };
  });

  return [
    { key: 'sketch', titleKey: 'featureTree.sketchGroup', rows: sketchRows },
    { key: 'solid', titleKey: 'featureTree.solidGroup', rows: solidRows },
  ];
}
