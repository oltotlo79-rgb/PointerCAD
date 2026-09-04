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

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  distanceVec3,
  type CoordinateInput,
  type PointReference,
  type ResolvedSketch,
  type SketchDocument,
  type SketchError,
  type SketchFaceFeature,
  type SketchFeature,
  type SketchFeatureKind,
  type SketchMesh,
  type SketchPointArrayFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { DEFAULT_COORDINATE_BASE, type CoordinateMode, type FieldUnit } from './numericInput.js';

/** プロパティ欄の 1 行。式は source をそのまま出す(FR-202)。 */
export interface FeatureFieldSummary {
  /** 書き戻すときに使う道筋。例: "at.x"、"radius"、"to.dy"。 */
  readonly path: string;
  readonly labelKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
}

/** 座標を指定する場所。要素の種類ごとに持てる場所が決まっている。 */
export type CoordinateSlot = 'at' | 'from' | 'to' | 'center' | 'base';

/** 1 点ぶんの欄のまとまり。指定方法(絶対・相対・極)を切り替える単位でもある。 */
export interface FeatureCoordinateSummary {
  readonly path: CoordinateSlot;
  readonly labelKey: MessageKey;
  readonly mode: CoordinateMode;
  readonly fields: readonly FeatureFieldSummary[];
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
  /** 計算できていない理由。問題が無ければ null(FR-504)。 */
  readonly errorMessage: string | null;
}

/** ツリーの行に出す種類の名前。道具の名前と同じ言葉にする。 */
export const FEATURE_KIND_LABEL_KEYS: Readonly<Record<SketchFeatureKind, MessageKey>> = {
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
};

/** 座標のまとまりの見出し。 */
const COORDINATE_LABEL_KEYS: Readonly<Record<CoordinateSlot, MessageKey>> = {
  at: 'propertyPanel.coordinate.at',
  from: 'propertyPanel.coordinate.from',
  to: 'propertyPanel.coordinate.to',
  center: 'propertyPanel.coordinate.center',
  base: 'propertyPanel.coordinate.base',
};

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

/** 1 点の指定を欄の並びへ直す。並びはその場数値入力と同じ順にする。 */
function coordinateSummary(
  slot: CoordinateSlot,
  input: CoordinateInput,
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
  return { path: slot, labelKey: COORDINATE_LABEL_KEYS[slot], mode: input.mode, fields };
}

/** その要素が計算できていない理由。無ければ null(FR-504)。 */
export function featureErrorMessage(
  errors: readonly SketchError[],
  featureId: string,
): string | null {
  const found = errors.find((error) => error.featureId === featureId);
  return found === undefined ? null : found.message;
}

/**
 * 点列(FR-308、FR-327)のプロパティ欄。既存の直線状(`layout.kind === 'linear'`)は
 * 従来どおりの欄をそのまま出す。円周上・格子状の欄の配線はタスク33(ui: ツリー・プロパティの
 * 対応)の範囲(型の網羅性のためだけに空で満たす、矩形等の新図形と同じ扱い)。
 */
function summarizePointArray(
  base: Omit<FeatureSummary, 'coordinates' | 'scalars'>,
  feature: SketchPointArrayFeature,
): FeatureSummary {
  const layout = feature.layout;
  if (layout.kind !== 'linear') {
    return { ...base, coordinates: [], scalars: [] };
  }
  return {
    ...base,
    coordinates: [coordinateSummary('base', layout.base)],
    scalars: [
      field('azimuth', FIELD_LABEL_KEYS.azimuth, 'degree', layout.azimuth),
      field('spacing', FIELD_LABEL_KEYS.spacing, 'mm', layout.spacing),
      field('count', FIELD_LABEL_KEYS.count, 'count', layout.count),
    ],
  };
}

/** 要素 1 つの見え方をまとめる。ツリーの行とプロパティ欄の両方がこれを読む。 */
export function summarizeFeature(
  feature: SketchFeature,
  errors: readonly SketchError[] = [],
): FeatureSummary {
  const base = {
    id: feature.id,
    name: feature.name,
    kind: feature.kind,
    kindLabelKey: FEATURE_KIND_LABEL_KEYS[feature.kind],
    errorMessage: featureErrorMessage(errors, feature.id),
  };

  switch (feature.kind) {
    case 'point':
      return { ...base, coordinates: [coordinateSummary('at', feature.at)], scalars: [] };
    case 'line':
      return {
        ...base,
        coordinates: [
          coordinateSummary('from', feature.from),
          coordinateSummary('to', feature.to),
        ],
        scalars: [],
      };
    case 'arc':
      return {
        ...base,
        coordinates: [coordinateSummary('center', feature.center)],
        scalars: [
          field('radius', FIELD_LABEL_KEYS.radius, 'mm', feature.radius),
          field('startAngle', FIELD_LABEL_KEYS.startAngle, 'degree', feature.startAngle),
          field('endAngle', FIELD_LABEL_KEYS.endAngle, 'degree', feature.endAngle),
        ],
      };
    case 'pointArray':
      return summarizePointArray(base, feature);
    case 'face':
      // 面が持つのは境界と色だけ。数の欄は無い(FR-309、FR-310)。
      return { ...base, coordinates: [], scalars: [] };
    case 'rectangle':
    case 'polygon':
    case 'slot':
    case 'ellipse':
    case 'spline':
    case 'offset':
    case 'copy':
      // P4 タスク4・5・15・20(model)は型と解決だけを足す。ツリー・プロパティ欄への表示・編集の
      // 配線はタスク33(ui: ツリー・プロパティの対応)の範囲(型の網羅性のためだけに空で満たす)。
      return { ...base, coordinates: [], scalars: [] };
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
  // 直線状・格子状の点列は基準点を「base」に持つ(円周上は「center」、§2.3)。
  // タスク33 で全種の書き戻しを配線するまでは、既存どおり直線状だけを対象にする。
  if (feature.kind === 'pointArray' && slot === 'base' && feature.layout.kind === 'linear') {
    const layout = feature.layout;
    const next = map(layout.base);
    return next === layout.base ? feature : { ...feature, layout: { ...layout, base: next } };
  }
  // 知らない道筋なら何も変えない(黙って壊さない)。
  return feature;
}

/** 1 点の指定の中の 1 欄を差し替える。指定方法に無い欄なら元のまま。 */
function setCoordinateField(
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
 * 道筋の場所へ新しい式を入れた、別の要素を作る(元は変えない)。
 * 妥当な式になったときだけ呼ぶ。下流は再計算で追従する(FR-311)。
 */
export function setFeatureField(
  feature: SketchFeature,
  path: string,
  value: ExpressionValue,
): SketchFeature {
  const separator = path.indexOf('.');
  if (separator >= 0) {
    const slot = path.slice(0, separator);
    const key = path.slice(separator + 1);
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
  }
  if (feature.kind === 'pointArray' && feature.layout.kind === 'linear') {
    const layout = feature.layout;
    if (path === 'azimuth') {
      return { ...feature, layout: { ...layout, azimuth: value } };
    }
    if (path === 'spacing') {
      return { ...feature, layout: { ...layout, spacing: value } };
    }
    if (path === 'count') {
      return { ...feature, layout: { ...layout, count: value } };
    }
  }
  return feature;
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
    case 'rectangle':
    case 'polygon':
    case 'slot':
    case 'ellipse':
    case 'spline':
    case 'offset':
    case 'copy':
      // タスク33(ui: ツリー・プロパティの対応)の範囲(型の網羅性のためだけに空で満たす)。
      return [];
  }
}
