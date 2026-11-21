/** スイープのねじれ・終わりの大きさ・肉厚(M-07)の右の欄を組み、書き戻す。既定のままの欄はフィーチャーに書かない。 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  DEFAULT_SWEEP_END_SCALE,
  DEFAULT_SWEEP_TWIST_DEGREES,
  DEFAULT_SWEEP_WALL_THICKNESS_MM,
  type SolidFeature,
  type SweepFeature,
} from '@pointercad/model';
import { isDefaultSweepShapeSource, type SweepShapeFieldKey } from '../sketch/numericInput.js';
import type { SolidFieldKey, SolidFieldSummary } from './solidPropertyContracts.js';
import { fieldSummary } from './solidPropertyFields.js';

function isSweepShapeKey(key: SolidFieldKey): key is SweepShapeFieldKey {
  return key === 'sweepTwist' || key === 'sweepEndScale' || key === 'sweepWall';
}

/** ねじれか終わりの大きさを使っているか。使う時は向きを自分の枠で決めるので、「曲がりに合わせて回す」を出さない。 */
export function sweepUsesLaw(feature: SweepFeature): boolean {
  return feature.twistDegrees !== undefined || feature.endScale !== undefined;
}

/**
 * 右の欄に出すスイープの形の欄。出す条件は作る時(その場入力)と同じで、ねじれと終わりの大きさは案内線が無い時だけ、肉厚はいつも出す。
 * 案内線と一緒に持ってしまった欄(model が理由を出して断る組み合わせ)は、直せるように出す。
 * 省いている欄は既定の値(model の定数。0・1・0)で出し、書き換えれば欄が生える。
 */
export function sweepShapeFieldSummaries(feature: SweepFeature): SolidFieldSummary[] {
  const wall = fieldSummary('sweepWall', feature.wallThickness ?? expressionValueFromNumber(DEFAULT_SWEEP_WALL_THICKNESS_MM));
  if (feature.guide !== undefined && !sweepUsesLaw(feature)) return [wall];
  return [
    fieldSummary('sweepTwist', feature.twistDegrees ?? expressionValueFromNumber(DEFAULT_SWEEP_TWIST_DEGREES)),
    fieldSummary('sweepEndScale', feature.endScale ?? expressionValueFromNumber(DEFAULT_SWEEP_END_SCALE)),
    wall,
  ];
}

/**
 * 欄の書き戻し。式が既定のまま(か空欄)なら欄を消す(省いた時と同じ形になり、使わない文書の版を上げない)。
 * 変数を使う式は、今の値が既定と同じでも残す(`isDefaultSweepShapeSource`)。
 */
export function setSweepShapeField(feature: SweepFeature, key: SolidFieldKey, value: ExpressionValue): SolidFeature {
  if (!isSweepShapeKey(key)) return feature;
  const next = isDefaultSweepShapeSource(key, value.source) ? undefined : value;
  const { twistDegrees, endScale, wallThickness, ...base } = feature;
  const twist = key === 'sweepTwist' ? next : twistDegrees;
  const scale = key === 'sweepEndScale' ? next : endScale;
  const wall = key === 'sweepWall' ? next : wallThickness;
  return {
    ...base,
    ...(twist === undefined ? {} : { twistDegrees: twist }),
    ...(scale === undefined ? {} : { endScale: scale }),
    ...(wall === undefined ? {} : { wallThickness: wall }),
  };
}
