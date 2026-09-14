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

import {
  setHoleField,
  setThreadHoleField,
  setSolidDepthKind,
  setThreadDesignation,
  setThreadSeries,
  setThreadRepresentation,
  setHoleEntryKind,
  setThreadShaftNominal,
  setThreadShaftSeries,
  setThreadShaftFromEnd,
} from './holeThreadPropertyUpdates.js';
export { setSolidDepthKind } from './holeThreadPropertyUpdates.js';
import { setChamferField, setChamferMode } from './chamferPropertyUpdates.js';
import { expressionValueFromNumber, type ExpressionValue, type EvaluateOptions } from '@pointercad/expression';
import { setSpringField, setSpringAxis, setSpringHandedness, setSpringDerived } from './springPropertyUpdates.js';
import { setSweepGuide, sweepGuideDisplayCandidates, sweepGuideValue } from './sweepGuideChoices.js';
import {
  DEFAULT_EXTRUDE_THICKNESS_MM,
  DEFAULT_FILLET_RADIUS_END_MM,
  DEFAULT_SCALE_FACTOR,
  DEFAULT_SURFACE_ANGLE_DEGREES,
  DEFAULT_SURFACE_DISTANCE_MM,
  DEFAULT_SURFACE_OFFSET_MM,
  DEFAULT_THICKNESS_SIDE,
  DEFAULT_TRANSFORM_ROTATION_DEGREES,
  extrudeShapingOf,
  filletRadiusOf,
  findSolid,
  holeEntryOf,
  INCH_DISPLAY_DIGITS,
  METRIC_THREAD_DESIGNATIONS,
  MM_PER_INCH,
  RULED_SPHERE_SEGMENT_CHOICES,
  type AxisSpec,
  type ChamferSize,
  type CutFeature,
  type ExtrudeEnd,
  type ExtrudeFeature,
  type PlaneSpec,
  type HoleDepth,
  type HoleEntry,
  type HoleFeature,
  type LengthUnit,
  type MirrorFeature,
  type PartDocument,
  type PartRecomputeError,
  type PatternDirection,
  type PatternFeature,
  type RibSide,
  type RuledSphereSegments,
  type ScaleFeature,
  type SketchCurveRef,
  type SolidFeature,
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
import { fieldSummary, PLANE_TILT_RANGE } from './solidPropertyFields.js';
import {
  profileReference, ruledSectionReference, bodyReference, importedSourceReferences,
  lineReferenceName, referenceAxisName, axisSummary, springOriginReference, pointReferenceSummary,
} from './solidReferenceNames.js';
import type {
  SolidFieldKey, SolidFieldSummary, SolidToggleKey,
  SolidToggleSummary, SolidChoiceSummary, SolidSubShapeCountSummary,
  SolidReferenceSummary, SolidSummary
} from './solidPropertyContracts.js';
export type {
  SolidFieldKey, SolidFieldSummary, SolidToggleKey,
  SolidToggleSummary, SolidChoiceSummary, SolidSubShapeCountSummary,
  SolidReferenceSummary, SolidAxisSummary, SolidSummary
} from './solidPropertyContracts.js';
import { SOLID_KIND_LABEL_KEYS, solidKindOf } from './solidLabels.js';
import { consumedIds } from './solidHistoryState.js';
export { SOLID_KIND_LABEL_KEYS, solidKindOf } from './solidLabels.js';
export { partErrorMessage } from './solidHistoryState.js';
export { selectionKindLabelKeys, buildTreeSections, buildSketchGroups, renameSketch, buildReferenceSection } from './treeSummary.js';
export type { TreeSectionKey, TreeRow, TreeSection, SketchTreeGroup } from './treeSummary.js';
import { setSheetField, sheetFieldValues } from '../sheetMetal/sheetFields.js';
import {
  TOGGLE_LABEL_KEYS,
  type NumericToggleKey,
} from '../sketch/numericInput.js';

export {
  REFERENCE_KIND_LABEL_KEYS, PLANE_SPEC_LABEL_KEYS, summarizeReference,
  setReferenceField, setReferenceCoordinate, renameReference, setReferenceVisible,
} from './referenceSummary.js';
export type { ReferenceFieldKey, ReferenceFieldSummary, ReferenceSummary } from './referenceSummary.js';

/** プロパティ欄で選び直せるワールドの軸(§0.a-0.9)。線分の軸はここでは選べない。 */
export const WORLD_AXIS_CHOICES: readonly {
  readonly axis: 'x' | 'y' | 'z';
  readonly labelKey: MessageKey;
}[] = [
  { axis: 'x', labelKey: 'numericInput.axis.x' },
  { axis: 'y', labelKey: 'numericInput.axis.y' },
  { axis: 'z', labelKey: 'numericInput.axis.z' },
];

function toggleSummary(key: NumericToggleKey, value: boolean): SolidToggleSummary {
  return { key, labelKey: TOGGLE_LABEL_KEYS[key], value };
}

/** C面取りの「基準の面を入れ替える」(§0.a-0.18)。等距離では効かないので呼び出し側で外す。 */
function swapReferenceFaceToggle(value: boolean): SolidToggleSummary {
  return { key: 'swapReferenceFace', labelKey: 'propertyPanel.swapReferenceFace', value };
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
        (並びが形の順そのものなので、順を読めることに意味がある)。
      */
      return {
        ...base,
        fields: [fieldSummary('ruledTwist', feature.twist)],
        toggles: [toggleSummary('loftSmooth', feature.smooth)],
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
        toggles: feature.guide === undefined ? [toggleSummary('sweepFrenet', feature.frenet)] : [],
        choices: [{ key: 'sweepGuide', labelKey: 'numericInput.choice.sweepGuide', presentation: 'menu',
          value: feature.guide === undefined ? 'none' : sweepGuideValue(feature.guide),
          options: [{ value: 'none', labelKey: 'numericInput.sweepGuide.none' }, ...sweepGuideDisplayCandidates(document, feature)] }],
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
    case 'functionSurface':
      return { ...base, fields: [], toggles: [], choices: [], references: [], subShapeCounts: [] };
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
            name: feature.bodyKind === 'solid' ? 'Solid' : feature.bodyKind === 'mixed' ? 'Solid + Shell' : 'Shell',
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
    case 'functionSurface':
      return feature;
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
  document?: PartDocument,
): SolidFeature {
  switch (key) {
    case 'sweepGuide': return feature.kind === 'sweep' && document !== undefined ? setSweepGuide(feature, value, document) : feature;
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
  if (feature.kind === 'loft') {
    return key === 'loftSmooth' ? { ...feature, smooth: value } : feature;
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
