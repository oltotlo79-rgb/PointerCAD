/** 基準面・基準軸・基準点・座標系の表示項目と、原式を保持する編集を担当する。 */
import type { ExpressionValue } from '@pointercad/expression';
import type {
  CoordinateInput, PlaneSpec, ReferenceAxisDefinition, ReferenceError,
  ReferenceFeature, ReferenceFeatureKind, ReferencePointDefinition,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { coordinateSummaryFor, type FeatureCoordinateSummary } from '../sketch/featureSummary.js';
import type { FieldUnit } from '../sketch/numericInput.js';

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
