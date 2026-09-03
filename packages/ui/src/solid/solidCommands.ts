/**
 * 選択からソリッドフィーチャーを作る純関数(計画書 docs/plans/P2-ソリッド基礎.md タスク18)。
 *
 * 対応要件: FR-401(押し出し)、FR-402(回転)、FR-403(縫合)、FR-404(ブーリアン)、
 * NFR-UX-1(対象を選んでから操作)、NFR-UX-5(できない操作は理由を示す)。
 *
 * `packages/ui/src/sketch/sketchCommands.ts` と同じ流儀に揃える。ストアにも DOM にも
 * 触れない純関数だけを置き、操作の判断を Node の単体検査で固定できるようにする
 * (`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、確定できないときは
 * 元の文書をそのまま返す。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  DEFAULT_SEW_TOLERANCE_MM,
  findFeature,
  findSketch,
  liveBodyIds,
  nextSolidId,
  nextSolidName,
  type BooleanOperation,
  type ExtrudeFeature,
  type PartDocument,
  type RevolveAxis,
  type RevolveFeature,
  type SewFeature,
  type SketchFaceRef,
  type BooleanFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';

/** 縫合に要る面の最小枚数(§0.a-0.7)。 */
const MIN_SEW_FACES = 2;
/** ブーリアンに要るボディの選択数(§0.a-0.6)。 */
const REQUIRED_BODY_COUNT = 2;

/** 押し出し距離の既定値(§0.a-0.8)。 */
export const DEFAULT_EXTRUDE_DISTANCE: ExpressionValue = expressionValueFromNumber(10);
/** 回転角度の既定値(§0.a-0.9)。 */
export const DEFAULT_REVOLVE_ANGLE: ExpressionValue = expressionValueFromNumber(360);
/** 回転軸の既定値。world の Z 軸(§0.a-0.9)。 */
export const DEFAULT_REVOLVE_AXIS: RevolveAxis = { kind: 'world', axis: 'z' };
/** 縫合の許容量の既定値。model の DEFAULT_SEW_TOLERANCE_MM を式へ直したもの(§0.a-0.7)。 */
export const DEFAULT_SEW_TOLERANCE: ExpressionValue = expressionValueFromNumber(
  DEFAULT_SEW_TOLERANCE_MM,
);

/** ソリッドのフィーチャーを 1 つ作った結果。断ったときは文書を変えない。 */
export type SolidCommandOutcome =
  | { readonly ok: true; readonly document: PartDocument; readonly featureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択から面フィーチャーの参照を 1 つ拾った結果。 */
export type FaceRefOutcome =
  | { readonly ok: true; readonly ref: SketchFaceRef }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択から面フィーチャーの参照を複数拾った結果(縫合用)。 */
export type FaceRefsOutcome =
  | { readonly ok: true; readonly refs: readonly SketchFaceRef[] }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択からブーリアンの対象・相手を決めた結果。 */
export type BodyPairOutcome =
  | { readonly ok: true; readonly targetFeatureId: string; readonly toolFeatureId: string }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 要素 id が面フィーチャーを指しているかを、id の接頭辞ではなく文書を引いて判定する。
 * 見つからなければ undefined(面でない、または実在しない)。
 */
function faceRefById(document: PartDocument, elementId: string): SketchFaceRef | undefined {
  const featureId = featureIdOf(elementId);
  for (const sketch of document.sketches) {
    const feature = findFeature(sketch, featureId);
    if (feature !== undefined && feature.kind === 'face') {
      return { sketchId: sketch.id, faceFeatureId: featureId };
    }
  }
  return undefined;
}

/**
 * 選択中の要素から面フィーチャーの参照を 1 つ拾う(押し出し・回転用)。
 * 複数選ばれていても先頭の面を使う。面が 1 つも無ければ noFace。
 */
export function selectedFaceRef(
  document: PartDocument,
  selection: readonly string[],
): FaceRefOutcome {
  for (const elementId of selection) {
    const ref = faceRefById(document, elementId);
    if (ref !== undefined) {
      return { ok: true, ref };
    }
  }
  return { ok: false, reasonKey: 'solidError.noFace' };
}

/**
 * 選択中の要素から面フィーチャーの参照をすべて拾う(縫合用)。選んだ順を保つ。
 * 面でない要素は読み飛ばす。集まった面が 2 枚未満なら needTwoFaces。
 */
export function selectedFaceRefs(
  document: PartDocument,
  selection: readonly string[],
): FaceRefsOutcome {
  const refs: SketchFaceRef[] = [];
  for (const elementId of selection) {
    const ref = faceRefById(document, elementId);
    if (ref !== undefined) {
      refs.push(ref);
    }
  }
  if (refs.length < MIN_SEW_FACES) {
    return { ok: false, reasonKey: 'solidError.needTwoFaces' };
  }
  return { ok: true, refs };
}

/**
 * 選択中の要素からブーリアンの対象・相手を決める(§0.a-0.6)。
 * `selection` は面などとも混じり得るので、`liveBodyIds` に載っている id だけを数える。
 * 先に選んだものが対象、後(Shift で追加した方)が相手。ちょうど 2 つでなければ needTwoBodies。
 */
export function selectedBodyPair(
  selection: readonly string[],
  liveIds: readonly string[],
): BodyPairOutcome {
  const live = new Set(liveIds);
  const bodyIds = selection.filter((id) => live.has(id));
  if (bodyIds.length !== REQUIRED_BODY_COUNT) {
    return { ok: false, reasonKey: 'solidError.needTwoBodies' };
  }
  const [targetFeatureId, toolFeatureId] = bodyIds;
  return { ok: true, targetFeatureId, toolFeatureId };
}

/** `SketchFaceRef` が指す面フィーチャーが実在するか。 */
function faceRefExists(document: PartDocument, ref: SketchFaceRef): boolean {
  const sketch = findSketch(document, ref.sketchId);
  if (sketch === undefined) {
    return false;
  }
  const feature = findFeature(sketch, ref.faceFeatureId);
  return feature !== undefined && feature.kind === 'face';
}

/** 押し出しを 1 つ作る(FR-401)。面の参照先が無ければ noFace で断る。 */
export function commitExtrude(
  document: PartDocument,
  params: {
    readonly profile: SketchFaceRef;
    readonly distance: ExpressionValue;
    readonly reversed: boolean;
    readonly symmetric: boolean;
  },
): SolidCommandOutcome {
  if (!faceRefExists(document, params.profile)) {
    return { ok: false, reasonKey: 'solidError.noFace' };
  }
  const id = nextSolidId(document, 'extrude');
  const feature: ExtrudeFeature = {
    id,
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile: params.profile,
    distance: params.distance,
    reversed: params.reversed,
    symmetric: params.symmetric,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 回転を 1 つ作る(FR-402)。面の参照先が無ければ noFace で断る。 */
export function commitRevolve(
  document: PartDocument,
  params: {
    readonly profile: SketchFaceRef;
    readonly axis: RevolveAxis;
    readonly angle: ExpressionValue;
    readonly reversed: boolean;
  },
): SolidCommandOutcome {
  if (!faceRefExists(document, params.profile)) {
    return { ok: false, reasonKey: 'solidError.noFace' };
  }
  const id = nextSolidId(document, 'revolve');
  const feature: RevolveFeature = {
    id,
    name: nextSolidName(document, 'revolve'),
    suppressed: false,
    kind: 'revolve',
    profile: params.profile,
    axis: params.axis,
    angle: params.angle,
    reversed: params.reversed,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/** 縫合を 1 つ作る(FR-403)。面が 2 枚未満なら needTwoFaces、参照先が無ければ noFace。 */
export function commitSew(
  document: PartDocument,
  params: { readonly faces: readonly SketchFaceRef[]; readonly tolerance: ExpressionValue },
): SolidCommandOutcome {
  if (params.faces.length < MIN_SEW_FACES) {
    return { ok: false, reasonKey: 'solidError.needTwoFaces' };
  }
  for (const face of params.faces) {
    if (!faceRefExists(document, face)) {
      return { ok: false, reasonKey: 'solidError.noFace' };
    }
  }
  const id = nextSolidId(document, 'sew');
  const feature: SewFeature = {
    id,
    name: nextSolidName(document, 'sew'),
    suppressed: false,
    kind: 'sew',
    faces: params.faces,
    tolerance: params.tolerance,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}

/**
 * ブーリアンを 1 つ作る(FR-404、§0.a-0.5)。
 * 対象と相手は同じ id なら sameBody、`liveBodyIds` に無ければ noBody で断る。
 */
export function commitBoolean(
  document: PartDocument,
  params: {
    readonly operation: BooleanOperation;
    readonly targetFeatureId: string;
    readonly toolFeatureId: string;
  },
): SolidCommandOutcome {
  if (params.targetFeatureId === params.toolFeatureId) {
    return { ok: false, reasonKey: 'solidError.sameBody' };
  }
  const live = new Set(liveBodyIds(document));
  if (!live.has(params.targetFeatureId) || !live.has(params.toolFeatureId)) {
    return { ok: false, reasonKey: 'solidError.noBody' };
  }
  const id = nextSolidId(document, params.operation);
  const feature: BooleanFeature = {
    id,
    name: nextSolidName(document, params.operation),
    suppressed: false,
    kind: 'boolean',
    operation: params.operation,
    targetFeatureId: params.targetFeatureId,
    toolFeatureId: params.toolFeatureId,
  };
  return { ok: true, document: appendSolid(document, feature), featureId: id };
}
