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
  SketchPointFeature,
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
  rectangle: '矩形',
  polygon: '正多角形',
  slot: '長穴',
};

/** 起動時の文書。空の履歴を持つ(§0.a-0.2)。作図面の既定は DEFAULT_WORK_PLANE_ID(XY)。 */
export function createEmptySketchDocument(): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features: [] };
}

/**
 * 「点1」「押し出し3」のような名前から末尾の連番を読む(§2.3、§0.a-0.19)。
 * `label` で始まらない、または残りが数字だけでなければ 0(まだ連番が無いものとして扱う)。
 */
export function nameSerial(name: string, label: string): number {
  if (!name.startsWith(label)) {
    return 0;
  }
  const rest = name.slice(label.length);
  if (!/^[0-9]+$/.test(rest)) {
    return 0;
  }
  const parsed = Number(rest);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `usedValues` の中で `label` から始まるものの連番の最大値。無ければ 0。 */
function maxSerial(usedValues: Iterable<string>, label: string): number {
  let max = 0;
  for (const value of usedValues) {
    const serial = nameSerial(value, label);
    if (serial > max) {
      max = serial;
    }
  }
  return max;
}

/**
 * 同じ種類の既存の名前の最大連番 + 1 の名前を作る(§2.3、§0.a-0.19)。
 * 「点1」「点2」から「点1」を消しても、残る「点2」の次は「点3」になり重複しない。
 * 全部消せば「点1」に戻るが、そのとき重複する相手はいない。
 */
export function nextSerialName(usedNames: Iterable<string>, label: string): string {
  return `${label}${String(maxSerial(usedNames, label) + 1)}`;
}

/** 同じ接頭辞の既存 id の最大連番 + 1 の id を作る(名前と同じ方式、§2.3)。 */
export function nextSerialId(usedIds: Iterable<string>, prefix: string): string {
  return `${prefix}${String(maxSerial(usedIds, prefix) + 1)}`;
}

/** 種類ごとに、既存の名前の最大連番 + 1 の名前を作る(「点1」「線分2」…、§0.a-0.19)。 */
export function nextFeatureName(document: SketchDocument, kind: SketchFeatureKind): string {
  const label = KIND_LABELS[kind];
  const usedNames = document.features
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.name);
  return nextSerialName(usedNames, label);
}

/** 種類ごとに、既存の id の最大連番 + 1 の id を作る(§0.a-0.19)。 */
export function nextFeatureId(document: SketchDocument, kind: SketchFeatureKind): string {
  const usedIds = document.features
    .filter((feature) => feature.kind === kind)
    .map((feature) => feature.id);
  return nextSerialId(usedIds, `${kind}-`);
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
): SketchPointFeature {
  return {
    id: nextFeatureId(document, 'point'),
    name: nextFeatureName(document, 'point'),
    planeId,
    kind: 'point',
    at,
  };
}
