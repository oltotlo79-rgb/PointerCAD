/**
 * スケッチ文書の生成と履歴操作(計画書 docs/plans/P1-式とスケッチ.md タスク9)。
 *
 * 履歴を書き換えず、変更のたびに新しい配列を作る。P2 の Undo / Redo(FR-505)は
 * この不変性の上に乗る。参照は id で持ち、座標を複製しない(FR-311、FR-502 の土台)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import { DEFAULT_WORK_PLANE_ID, type WorkPlaneId } from './planeMath.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFeature,
  SketchFeatureKind,
} from './types.js';

/** 面の既定の塗り色(FR-310、§0.a-0.5)。 */
export const DEFAULT_FACE_COLOR = '#7aa2f7';

/**
 * フィーチャーの種類ごとの既定名。ドキュメントの既定データとしてここに置く。
 * UI 文字列(ja.json)とは別扱い。資源化するかは P2 のフィーチャーツリー実装時に判断する
 * (docs/報告記録.md 2026-09-02 14:59 の残件④と同じ扱い)。
 */
const KIND_LABELS: Readonly<Record<SketchFeatureKind, string>> = {
  point: '点',
  line: '線分',
  arc: '円弧',
  pointArray: '点列',
  face: '面',
};

/** 起動時の文書。空の履歴を持つ(§0.a-0.2)。作図面の既定は DEFAULT_WORK_PLANE_ID(XY)。 */
export function createEmptySketchDocument(): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features: [] };
}

/** 種類ごとに 1 から数えた名前を作る(「点1」「線分2」…)。 */
export function nextFeatureName(document: SketchDocument, kind: SketchFeatureKind): string {
  const used = document.features.filter((feature) => feature.kind === kind).length;
  return `${KIND_LABELS[kind]}${String(used + 1)}`;
}

/** 種類ごとに重ならない id を作る。 */
export function nextFeatureId(document: SketchDocument, kind: SketchFeatureKind): string {
  let serial = document.features.length + 1;
  let candidate = `${kind}-${String(serial)}`;
  while (document.features.some((feature) => feature.id === candidate)) {
    serial += 1;
    candidate = `${kind}-${String(serial)}`;
  }
  return candidate;
}

/** 履歴の末尾へ足す。元の文書は変えない(P2 の Undo の土台)。 */
export function appendFeature(document: SketchDocument, feature: SketchFeature): SketchDocument {
  return { ...document, features: [...document.features, feature] };
}

/** 1 つを差し替える。見つからなければ元の文書をそのまま返す。 */
export function replaceFeature(
  document: SketchDocument,
  featureId: string,
  next: SketchFeature,
): SketchDocument {
  return {
    ...document,
    features: document.features.map((feature) => (feature.id === featureId ? next : feature)),
  };
}

/** 1 つを取り除く。参照していた面が壊れるかどうかは解決のときに分かる(FR-504)。 */
export function removeFeature(document: SketchDocument, featureId: string): SketchDocument {
  return {
    ...document,
    features: document.features.filter((feature) => feature.id !== featureId),
  };
}

export function findFeature(
  document: SketchDocument,
  featureId: string,
): SketchFeature | undefined {
  return document.features.find((feature) => feature.id === featureId);
}

/** 絶対座標の指定を作る。ビューポートのクリックや既定値から使う(NFR-UX-4)。 */
export function absoluteCoordinate(x: number, y: number, z: number): CoordinateInput {
  return {
    mode: 'absolute',
    x: expressionValueFromNumber(x),
    y: expressionValueFromNumber(y),
    z: expressionValueFromNumber(z),
  };
}

/** 作図面を指定して点フィーチャーを作る。 */
export function createPointFeature(
  document: SketchDocument,
  at: CoordinateInput,
  planeId: WorkPlaneId = DEFAULT_WORK_PLANE_ID,
): SketchFeature {
  return {
    id: nextFeatureId(document, 'point'),
    name: nextFeatureName(document, 'point'),
    planeId,
    kind: 'point',
    at,
  };
}
