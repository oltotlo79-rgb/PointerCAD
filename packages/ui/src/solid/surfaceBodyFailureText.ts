/**
 * 面だけのボディの機能(厚み付け・面全体のオフセット J-05a、つなぎ面 J-05b)で、計算部が返す失敗の符号を、利用者へ見せる文にする一覧。
 * 計算部は理由の符号だけを返し、文は画面の側のここ 1 か所が持つ(2026-11-20 の利用者の回答)。
 * 符号の型を鍵にした Record なので、計算部が符号を足して文を書き漏らすと型検査で分かる。
 * 再計算の誤りの文を画面へ出す所は、全部 partErrorMessage(1 件)か localizedPartErrors(店の一覧)を通す(0b-2a)。
 * 誤りは文を持たず鍵と値(text)だけを持つので、ほかの書き方では画面へ出せない(0b-3a)。
 */
import type { PartRecomputeError, SolidFailureReason } from '@pointercad/model';
import { failureMessage } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';

/** 計算部が返す立体の失敗の符号の全部(SolidFailureReason)→ 文言の鍵。0b-2 で面による切断・面の縫い合わせ・辺からの距離の穴を足した。 */
const SOLID_FAILURE_KEYS: Readonly<Record<SolidFailureReason, MessageKey>> = {
  'faceted-function-surface': 'surfaceBody.failure.faceted',
  'invalid-surface-body': 'surfaceBody.select',
  'invalid-thickness': 'surfaceBody.positive',
  'invalid-side': 'surfaceBody.failure.side',
  'invalid-offset-distance': 'surfaceBody.nonzero',
  'offset-failed': 'surfaceBody.failure.offset',
  'invalid-offset-surface': 'surfaceBody.failure.offset',
  'thicken-failed': 'surfaceBody.failure.thicken',
  'open-thick-solid': 'surfaceBody.failure.thicken',
  'invalid-thick-solid': 'surfaceBody.failure.thicken',
  'non-positive-volume': 'surfaceBody.failure.thicken',
  'boundary-required': 'surfaceBlend.failure.boundary',
  'no-tangent': 'surfaceBlend.failure.tangent',
  'blend-failed': 'surfaceBlend.failure.build',
  'invalid-blend-face': 'surfaceBlend.failure.invalid',
  'outside-tolerance': 'surfaceBlend.failure.tolerance',
  'non-finite-input': 'solidFailure.surfaceCut.nonFiniteInput',
  'invalid-blade': 'solidFailure.surfaceCut.invalidBlade',
  'non-planar-profile': 'solidFailure.surfaceCut.nonPlanarProfile',
  'self-intersection': 'solidFailure.surfaceCut.selfIntersection',
  'no-intersection': 'solidFailure.surfaceCut.noIntersection',
  'touch-only': 'solidFailure.surfaceCut.touchOnly',
  'incomplete-cut': 'solidFailure.surfaceCut.incompleteCut',
  'ambiguous-side': 'solidFailure.surfaceCut.ambiguousSide',
  'invalid-target': 'solidFailure.surfaceCut.invalidTarget',
  'boolean-failed': 'solidFailure.surfaceCut.booleanFailed',
  'volume-mismatch': 'solidFailure.surfaceCut.volumeMismatch',
  'insufficient-faces': 'solidFailure.sewFaces.insufficientFaces',
  'invalid-tolerance': 'solidFailure.sewFaces.invalidTolerance',
  'invalid-face': 'solidFailure.sewFaces.invalidFace',
  'duplicate-face': 'solidFailure.sewFaces.duplicateFace',
  'open-shell': 'solidFailure.sewFaces.openShell',
  'non-manifold': 'solidFailure.sewFaces.nonManifold',
  'multiple-shells': 'solidFailure.sewFaces.multipleShells',
  'invalid-solid': 'solidFailure.sewFaces.invalidSolid',
  'sewing-failed': 'solidFailure.sewFaces.sewingFailed',
  'missing-face': 'solidFailure.sewFaces.missingFace',
  combination: 'solidFailure.edgeDistance.combination',
  distance: 'solidFailure.edgeDistance.distance',
  notLine: 'solidFailure.edgeDistance.notLine',
  notOnFace: 'solidFailure.edgeDistance.notOnFace',
  degenerate: 'solidFailure.edgeDistance.notOnFace',
  side: 'solidFailure.edgeDistance.notOnFace',
  parallel: 'solidFailure.edgeDistance.parallel',
  outside: 'solidFailure.edgeDistance.outside',
};

const KEY_BY_REASON: ReadonlyMap<string, MessageKey> = new Map(Object.entries(SOLID_FAILURE_KEYS));

function messageKeyOf(error: PartRecomputeError): MessageKey | undefined {
  return 'reason' in error && error.reason !== undefined ? KEY_BY_REASON.get(error.reason) : undefined;
}

/** 再計算の誤り 1 件を、画面に出す文にする。符号の一覧に文があればその文、無ければ誤りの鍵と値の文(計算部の文はそのまま。0b-2a・0b-3a)。 */
export function partErrorMessage(error: PartRecomputeError): string {
  const key = messageKeyOf(error);
  return key === undefined ? failureMessage(error.text) : t(key);
}

/**
 * 再計算の失敗のうち、面だけのボディの機能の符号を持つ物の文を、この一覧の文に替える(ほかの失敗の文はそのまま)。
 * 替える物が無ければ同じ配列を返す(店の値の同一性を保つ)。
 */
export function localizedPartErrors(errors: readonly PartRecomputeError[]): readonly PartRecomputeError[] {
  if (!errors.some(error => messageKeyOf(error) !== undefined)) return errors;
  return errors.map(error => {
    const key = messageKeyOf(error);
    return key === undefined ? error : { ...error, text: { key, parameters: {} } };
  });
}
