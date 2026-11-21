/**
 * 面だけのボディの機能(厚み付け・面全体のオフセット J-05a、つなぎ面 J-05b)で、計算部が返す失敗の符号を、利用者へ見せる文にする一覧。
 * 計算部は理由の符号だけを返し、文は画面の側のここ 1 か所が持つ(2026-11-20 の利用者の回答)。
 * 符号の型を鍵にした Record なので、計算部が符号を足して文を書き漏らすと型検査で分かる。
 */
import type { PartRecomputeError, SurfaceBodyFailureReason } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';

const SURFACE_BODY_FAILURE_KEYS: Readonly<Record<SurfaceBodyFailureReason, MessageKey>> = {
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
};

const KEY_BY_REASON: ReadonlyMap<string, MessageKey> = new Map(Object.entries(SURFACE_BODY_FAILURE_KEYS));

function messageKeyOf(error: PartRecomputeError): MessageKey | undefined {
  return 'reason' in error && error.reason !== undefined ? KEY_BY_REASON.get(error.reason) : undefined;
}

/**
 * 再計算の失敗のうち、面だけのボディの機能の符号を持つ物の文を、この一覧の文に替える(ほかの失敗の文はそのまま)。
 * 替える物が無ければ同じ配列を返す(店の値の同一性を保つ)。
 */
export function localizedPartErrors(errors: readonly PartRecomputeError[]): readonly PartRecomputeError[] {
  if (!errors.some(error => messageKeyOf(error) !== undefined)) return errors;
  return errors.map(error => {
    const key = messageKeyOf(error);
    return key === undefined ? error : { ...error, message: t(key) };
  });
}
