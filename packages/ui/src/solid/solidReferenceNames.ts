/** 文書の参照先から、プロパティへ表示する名前と選択先だけを作る。 */
import {
  findFeature, findReference, findSketch, findSolid,
  type ImportedSource, type ImportedSourceFormat, type LengthUnit,
  type PartDocument, type PointReference, type RuledSection,
  type SketchFaceRef, type SketchLineRef, type SketchPointRef, type SolidFeature,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { baseSummary } from '../sketch/featureSummary.js';
import type { SolidAxisSummary, SolidReferenceSummary } from './solidPropertyContracts.js';

/** 面の参照を「スケッチ名 / 面の名前」へ直す。見つからなければ id をそのまま出す(FR-504)。 */
export function profileReference(document: PartDocument, ref: SketchFaceRef): SolidReferenceSummary {
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
export function ruledSectionReference(
  document: PartDocument,
  section: RuledSection,
  labelKey: MessageKey,
): SolidReferenceSummary {
  switch (section.kind) {
    case 'sketchCurves': {
      const sketch = document.sketches.find((candidate) => candidate.id === section.ref.sketchId);
      const names = section.ref.curveIds.map((id) => sketch?.features.find((feature) => feature.id === id)?.name ?? id);
      return { labelKey, name: `${sketch?.name ?? section.ref.sketchId} / ${names.join('、')}`, elementId: section.ref.curveIds[0] ?? null };
    }
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
export function bodyReference(
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
export function importedSourceReferences(
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
export function lineReferenceName(document: PartDocument, ref: SketchLineRef): string {
  const sketch = findSketch(document, ref.sketchId);
  const found = sketch === undefined ? undefined : findFeature(sketch, ref.lineFeatureId);
  return found === undefined || found.kind !== 'line' ? ref.lineFeatureId : found.name;
}

/** 基準軸(FR-329)の名前。見つからなければ id をそのまま返す(FR-504)。 */
export function referenceAxisName(document: PartDocument, referenceFeatureId: string): string {
  const found = findReference(document, referenceFeatureId);
  return found === undefined || found.kind !== 'referenceAxis' ? referenceFeatureId : found.name;
}

/**
 * 回転軸の見え方。線分の軸と基準軸(FR-329)は名前を引いて読み取り専用で出す(§0.a-0.9)。
 * 基準軸も「名前を出すだけ」で扱いが同じなので `kind: 'line'`(= 読み取り専用の名前)にまとめる。
 */
export function axisSummary(document: PartDocument, feature: SolidFeature): SolidAxisSummary | null {
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
/** ばねの始点(スケッチの点)の参照名。見つからなければ id をそのまま出す(FR-504)。 */
export function springOriginReference(document: PartDocument, origin: SketchPointRef): SolidReferenceSummary {
  const sketch = findSketch(document, origin.sketchId);
  const point = sketch === undefined ? undefined : findFeature(sketch, origin.pointFeatureId);
  if (sketch === undefined || point === undefined || point.kind !== 'point') {
    return { labelKey: 'propertyPanel.springOrigin', name: origin.pointFeatureId, elementId: null };
  }
  return { labelKey: 'propertyPanel.springOrigin', name: point.name, elementId: point.id };
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
export function pointReferenceSummary(
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
