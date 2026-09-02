/**
 * 部品(パート)文書の生成と履歴操作(計画書 docs/plans/P2-ソリッド基礎.md タスク9b)。
 *
 * 履歴を書き換えず、変更のたびに新しい配列を作る。Undo / Redo(FR-505)はこの不変性の上に乗る。
 * 参照は id で持ち、座標や形を複製しない(FR-311、FR-502)。
 * ここに置くのは文書そのものの操作だけで、解決(座標・向き・キャッシュの鍵の計算)は
 * part/resolvePart.ts の担当にする。
 */

import {
  createEmptySketchDocument,
  nextSerialId,
  nextSerialName,
} from '../sketch/createSketchDocument.js';
import type { SketchDocument } from '../sketch/types.js';
import type { BooleanOperation, PartDocument, SolidFeature } from './types.js';

/** 部品文書の保存形式の版(§0.a-0.3)。P2 で 2 になる。 */
export const PART_SCHEMA_VERSION = 2;

/** 縫合のつなぎ目の既定の許容量(mm、§0.a-0.7)。 */
export const DEFAULT_SEW_TOLERANCE_MM = 0.01;

/**
 * 連番を分ける単位。ブーリアンは演算ごとに別の連番にするので、
 * フィーチャーの種類そのもの(`boolean`)ではなく演算名を鍵にする(§2.3)。
 */
export type SolidLabelKey = 'extrude' | 'revolve' | 'sew' | BooleanOperation;

/**
 * ソリッドの種類ごとの既定名。ドキュメントの既定データとしてここに置く
 * (UI 文字列 ja.json とは別扱い。スケッチの KIND_LABELS と同じ考え方)。
 */
export const SOLID_LABELS: Readonly<Record<SolidLabelKey, string>> = {
  extrude: '押し出し',
  revolve: '回転',
  sew: '縫合',
  union: '和',
  subtract: '差',
  intersect: '積',
};

/** 起動時の部品。空のスケッチを1本だけ持ち、ソリッドは無い(NFR-UX-6)。 */
export function createEmptyPartDocument(): PartDocument {
  const sketch = createEmptySketchDocument();
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [sketch],
    activeSketchId: sketch.id,
    solids: [],
  };
}

export function findSketch(document: PartDocument, sketchId: string): SketchDocument | undefined {
  return document.sketches.find((sketch) => sketch.id === sketchId);
}

/**
 * スケッチを1本足す。編集中のスケッチは変えない(切り替えは setActiveSketch)。
 * 同じ id がすでにあれば、id の一意性を守るため元の文書をそのまま返す。
 */
export function addSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) !== undefined) {
    return document;
  }
  return { ...document, sketches: [...document.sketches, sketch] };
}

/** スケッチを1本差し替える。同じ id が無ければ元の文書をそのまま返す。 */
export function replaceSketch(document: PartDocument, sketch: SketchDocument): PartDocument {
  if (findSketch(document, sketch.id) === undefined) {
    return document;
  }
  return {
    ...document,
    sketches: document.sketches.map((current) => (current.id === sketch.id ? sketch : current)),
  };
}

/** 編集中のスケッチを切り替える。実在しない id なら元の文書をそのまま返す(§0.a-0.4)。 */
export function setActiveSketch(document: PartDocument, sketchId: string): PartDocument {
  if (findSketch(document, sketchId) === undefined) {
    return document;
  }
  return { ...document, activeSketchId: sketchId };
}

export function findSolid(document: PartDocument, featureId: string): SolidFeature | undefined {
  return document.solids.find((feature) => feature.id === featureId);
}

/**
 * ソリッドフィーチャーを履歴の末尾へ足す。
 * id はボディの id でもあり他のフィーチャーから参照されるので、
 * すでに同じ id があれば足さずに元の文書をそのまま返す(§0.a-0.5)。
 */
export function appendSolid(document: PartDocument, feature: SolidFeature): PartDocument {
  if (findSolid(document, feature.id) !== undefined) {
    return document;
  }
  return { ...document, solids: [...document.solids, feature] };
}

/**
 * 1つを差し替える。抑制(FR-503)と名前の変更もこれで行う。
 * 見つからなければ元の文書をそのまま返す。id は変えない前提(id はボディの識別子)。
 */
export function replaceSolid(
  document: PartDocument,
  featureId: string,
  next: SolidFeature,
): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.map((feature) => (feature.id === featureId ? next : feature)),
  };
}

/**
 * 1つを取り除く。これを参照していたブーリアンは履歴に残し、
 * 解決のときに理由つきで失敗させる(FR-504。止めずに警告する)。
 */
export function removeSolid(document: PartDocument, featureId: string): PartDocument {
  if (findSolid(document, featureId) === undefined) {
    return document;
  }
  return {
    ...document,
    solids: document.solids.filter((feature) => feature.id !== featureId),
  };
}

/**
 * 同じ種類の既存の名前の最大連番 + 1(§0.a-0.19)。削除しても重複しない。
 * 数えるのは履歴の全部の名前で、利用者が改名した名前とも重ならないようにする。
 */
export function nextSolidName(document: PartDocument, key: SolidLabelKey): string {
  const usedNames = document.solids.map((feature) => feature.name);
  return nextSerialName(usedNames, SOLID_LABELS[key]);
}

/** 同じ接頭辞の既存 id の最大連番 + 1(名前と同じ方式、§0.a-0.19)。 */
export function nextSolidId(document: PartDocument, key: SolidLabelKey): string {
  const usedIds = document.solids.map((feature) => feature.id);
  return nextSerialId(usedIds, `${key}-`);
}

/**
 * ブーリアンが消費したボディの id(§0.a-0.5)。
 *
 * 消費できるのは「履歴で自分より前にあり、抑制されていない」フィーチャーのボディだけ。
 * 抑制されたブーリアンは再計算で飛ばされるので何も消費しない。
 * 参照先が消えている場合(FR-504 で失敗させる場合)は消費に数えない。
 * ここは文書だけを見る判定で、実際に形が作れたかどうかは resolvePart が決める。
 */
export function consumedBodyIds(document: PartDocument): ReadonlySet<string> {
  const consumed = new Set<string>();
  const available = new Set<string>();
  for (const feature of document.solids) {
    if (feature.kind === 'boolean' && !feature.suppressed) {
      for (const id of [feature.targetFeatureId, feature.toolFeatureId]) {
        if (available.has(id)) {
          consumed.add(id);
        }
      }
    }
    if (!feature.suppressed) {
      available.add(feature.id);
    }
  }
  return consumed;
}

/**
 * いま画面に出るボディの id を履歴順に並べる(§0.a-0.5)。
 * 抑制されておらず、まだ消費されていないフィーチャーのボディ。
 * 作成に失敗したものを外すのは resolvePart の役目(文書だけでは分からない)。
 */
export function liveBodyIds(document: PartDocument): readonly string[] {
  const consumed = consumedBodyIds(document);
  return document.solids
    .filter((feature) => !feature.suppressed && !consumed.has(feature.id))
    .map((feature) => feature.id);
}
