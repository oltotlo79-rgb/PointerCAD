import type { ExpressionValue } from '@pointercad/expression';

import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import { subShapeKindOf, type SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidFeatureBase } from './featureIdentity.js';

/**
 * 平らな面の移動(EX-18 の限られた一段)。読み込んだ立体や既存の立体の平らな面 1 枚を、
 * 外向き法線の向きへ符号付きの距離だけ平行に動かす。正は材料を足し、負は削る。
 *
 * **保存するのは「どの立体の・どの面か」(面の指紋)と「距離の式」だけ**(要件§8、
 * rules/04「導出できるものは保存しない」)。距離は式なので、変数を変えれば計算し直される
 * (reevaluatePart が `offset` を写し直し、鍵が変わってカーネルが作り直す)。
 * **対象を消費する**(動かした立体 1 つだけが残る。抜き勾配と同じ)。
 *
 * この段で扱えるのは「隣の面がすべて直角な平らな面」だけ(カーネル editSolidFace.ts の注釈)。
 * 斜め・曲面の隣、ほかの形に当たる距離はカーネルが断り、元の立体はそのまま残る。
 * 全体の移動や書き出し・読み直しでは代用しない。EX-18 の他の直接編集はこの段の外。
 */

/** フィーチャーの種類の名前。保存形・鍵・段の依頼で同じ文字列を使う。 */
export const FACE_OFFSET_KIND = 'faceOffset';

/** これ未満の距離(mm)は「動かさない」とみなして断る(カーネルの MIN_FACE_OFFSET_MM と同じ値)。 */
export const MIN_FACE_OFFSET_MM = 1e-6;

/**
 * その場入力で欄を空のまま決めたときの距離(mm)。外向きに 1mm(材料を足す向き)。
 * 道具の段の既定(ui の numericInput)とフィーチャーの既定(shapeEditCommands)が
 * 同じ数を使うよう、ここ 1 か所に置く(rules/04「同じ数を 2 か所に書かない」)。
 */
export const DEFAULT_FACE_OFFSET_MM = 1;

/** 面の移動のフィーチャー(保存形)。 */
export interface FaceOffsetFeature extends SolidFeatureBase {
  readonly kind: typeof FACE_OFFSET_KIND;
  /** 面を持つ立体を作ったフィーチャーの id。消費する。 */
  readonly targetFeatureId: string;
  /** 動かす平らな面。必ず `targetFeatureId` の立体の面。 */
  readonly face: SubShapeRef;
  /** 符号付きの距離(mm)の式。正で外向き(足す)、負で内向き(削る)。0 は断る。 */
  readonly offset: ExpressionValue;
}

/** 解決した段(SolidStepPlan の 1 種)。距離は評価済みの mm。 */
export interface FaceOffsetPlan {
  readonly kind: typeof FACE_OFFSET_KIND;
  readonly targetKey: string;
  readonly face: SubShapeRef;
  readonly offset: number;
}

/** 鍵の材料(cacheKey の SolidKeyMaterial の 1 種)。面は指紋の鍵文字列で持つ。 */
export interface FaceOffsetKeyMaterial {
  readonly kind: typeof FACE_OFFSET_KIND;
  readonly targetKey: string;
  readonly face: string;
  readonly offset: number;
}

export const FACE_OFFSET_NOT_FACE_MESSAGE = '動かせるのは立体の面だけです。平らな面を選び直してください。';
export const FACE_OFFSET_OTHER_BODY_MESSAGE = '動かす面は、編集するもとの立体の面にしてください。';
export const FACE_OFFSET_NOT_PLANAR_MESSAGE = '動かせるのは平らな面だけです。';
export const FACE_OFFSET_DISTANCE_MESSAGE = '面を動かす距離は 0 でない数で指定してください。';

/** 解決の前に model だけで確かめられる条件の結果。code は resolvePart の PartErrorCode の部分集合。 */
export type FaceOffsetCheck =
  | { readonly ok: true; readonly offset: number }
  | { readonly ok: false; readonly code: 'invalidValue' | 'degenerate'; readonly message: string };

/**
 * 面の移動の入力を、OCCT を呼ぶ前に確かめる(NFR-UX-5)。
 *
 * - 面以外(辺・頂点)の参照、別の立体の面は断る。
 * - 今の形で選び直せた面が平らでなければ断る(選び直せない参照〔null〕は、カーネルが
 *   「面が見つかりません」で断るのでここでは通す。抜き勾配の中立面と同じ扱い)。
 * - 距離の式が数でない(評価できない式は value が NaN で来る)・0 に近すぎるときは断る。
 */
export function checkFaceOffset(
  feature: FaceOffsetFeature,
  subShape: (reference: SubShapeRef) => ResolvedSubShape | null,
): FaceOffsetCheck {
  if (subShapeKindOf(feature.face) !== 'face') {
    return { ok: false, code: 'invalidValue', message: FACE_OFFSET_NOT_FACE_MESSAGE };
  }
  if (feature.face.bodyFeatureId !== feature.targetFeatureId) {
    return { ok: false, code: 'invalidValue', message: FACE_OFFSET_OTHER_BODY_MESSAGE };
  }
  const resolved = subShape(feature.face);
  if (resolved !== null && (resolved.surfaceKind !== 'plane' || resolved.axis === null)) {
    return { ok: false, code: 'degenerate', message: FACE_OFFSET_NOT_PLANAR_MESSAGE };
  }
  const offset = feature.offset.value;
  if (!Number.isFinite(offset) || Math.abs(offset) < MIN_FACE_OFFSET_MM) {
    return { ok: false, code: 'invalidValue', message: FACE_OFFSET_DISTANCE_MESSAGE };
  }
  return { ok: true, offset };
}

/** 段の計画を組む。対象の鍵は呼び出し側(resolvePart の resolveMachiningTarget)が引く。 */
export function faceOffsetPlan(feature: FaceOffsetFeature, targetKey: string, offset: number): FaceOffsetPlan {
  return { kind: FACE_OFFSET_KIND, targetKey, face: feature.face, offset };
}

/** 鍵の材料。指紋の鍵文字列への直し方は呼び出し側(solidPlanKeyMaterial)の既存の関数を渡す。 */
export function faceOffsetKeyMaterial(
  plan: FaceOffsetPlan,
  fingerprintKeyText: (reference: SubShapeRef) => string,
): FaceOffsetKeyMaterial {
  return { kind: FACE_OFFSET_KIND, targetKey: plan.targetKey, face: fingerprintKeyText(plan.face), offset: plan.offset };
}

/** 鍵の文字列。数の書き方は cacheKey の keyNumber を渡す(同じ数なら同じ文字列)。 */
export function faceOffsetKeyText(material: FaceOffsetKeyMaterial, keyNumber: (value: number) => string): string {
  return `faceOffset{targetKey=${material.targetKey};face=${material.face};offset=${keyNumber(material.offset)}}`;
}

/** 式の欄(距離)だけを写し直す。面の指紋と id はそのまま(reevaluatePart の他の種類と同じ)。 */
export function reevaluateFaceOffset(
  feature: FaceOffsetFeature,
  map: (value: ExpressionValue) => ExpressionValue,
): FaceOffsetFeature {
  return { ...feature, offset: map(feature.offset) };
}

/** 新しい面の移動を組む。抑制なしで作る(他の加工と同じ)。 */
export function createFaceOffsetFeature(input: {
  readonly id: string;
  readonly name: string;
  readonly targetFeatureId: string;
  readonly face: SubShapeRef;
  readonly offset: ExpressionValue;
}): FaceOffsetFeature {
  return { id: input.id, name: input.name, suppressed: false, kind: FACE_OFFSET_KIND,
    targetFeatureId: input.targetFeatureId, face: input.face, offset: input.offset };
}

/** 寸法の編集(距離の式の差し替え)。面の参照と対象は変えない。 */
export function withFaceOffsetDistance(feature: FaceOffsetFeature, offset: ExpressionValue): FaceOffsetFeature {
  return { ...feature, offset };
}

/** 面の参照の差し替え(選び直し)。対象の立体は変えない。別の立体の面は解決で断られる。 */
export function withFaceOffsetFace(feature: FaceOffsetFeature, face: SubShapeRef): FaceOffsetFeature {
  return { ...feature, face };
}
