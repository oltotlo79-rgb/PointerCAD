/**
 * 面だけのボディの機能の失敗の文は画面の側の一覧が持つ(2026-11-20 の利用者の回答)。計算部は理由の符号だけを返す。
 * 期待の文は製品の一覧を読まずに書く(計算部の表にあった文と同じ)。
 */
import type { PartRecomputeError, SurfaceBodyFailureReason } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { localizedPartErrors } from './surfaceBodyFailureText.js';

const THICKEN = '閉じた立体を作れませんでした。厚さや厚みを付ける側を見直してください。';
const OFFSET = '面を離せませんでした。距離の大きさや向きを見直してください。';
const CASES: readonly (readonly [SurfaceBodyFailureReason, string])[] = [
  ['faceted-function-surface', '平らな三角形の集まりでできた関数曲面には厚みを付けられません。式か許容差を見直して滑らかな面にするか、平らな面は押し出しか箱で作ってください。'],
  ['invalid-surface-body', '面だけのボディを 1 つ選んでください。'],
  ['invalid-thickness', '厚さには 0 より大きい値を入力してください。'],
  ['invalid-side', '厚みを付ける側を選び直してください。'],
  ['invalid-offset-distance', '離す距離には 0 以外の値を入力してください。'],
  ['offset-failed', OFFSET],
  ['invalid-offset-surface', OFFSET],
  ['thicken-failed', THICKEN],
  ['open-thick-solid', THICKEN],
  ['invalid-thick-solid', THICKEN],
  ['non-positive-volume', THICKEN],
  ['boundary-required', '面の境界として一方の側だけに面がある辺を選んでください。'],
  ['no-tangent', '選んだ辺で面に沿う横の接線を求められません。'],
  ['blend-failed', 'つなぎ面を作れませんでした。'],
  ['invalid-blend-face', 'つなぎ面の形が不正です。'],
  ['outside-tolerance', '辺からの離れか、接線または接平面の角度が許容差を超えました。重みや選んだ辺を見直してください。'],
];

function failed(reason: SurfaceBodyFailureReason): PartRecomputeError {
  return { featureId: `feature-${reason}`, code: 'kernelFailed', message: reason, reason };
}

describe('面だけのボディの失敗の文(画面の側の一覧)', () => {
  it('計算部の符号ごとに、利用者へ見せる文に替える', () => {
    const errors = CASES.map(([reason]) => failed(reason));
    expect(localizedPartErrors(errors).map(error => error.message)).toEqual(CASES.map(([, text]) => text));
  });

  it('ほかの失敗の文はそのまま、替える物が無ければ同じ配列を返す', () => {
    const other: PartRecomputeError = { featureId: 'cut', code: 'kernelFailed', message: '面で切れませんでした。' };
    const untouched = [other];
    expect(localizedPartErrors(untouched)).toBe(untouched);
    expect(localizedPartErrors([other, failed('thicken-failed')]).map(error => error.message)).toEqual(['面で切れませんでした。', THICKEN]);
  });
});
