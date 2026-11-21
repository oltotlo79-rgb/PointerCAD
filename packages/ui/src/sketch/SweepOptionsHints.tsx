import { t } from '../i18n/t.js';
import { isDefaultSweepShapeSource, type NumericInputState } from './numericInput.js';

/** 段 sweepOptions の欄の中で、既定から変えると計算が重くなる欄の鍵(M-07)。 */
function usesSweepShape(state: NumericInputState): boolean {
  return state.fields.some((field) => (field.key === 'sweepTwist' || field.key === 'sweepEndScale' || field.key === 'sweepWall')
    && !isDefaultSweepShapeSource(field.key, field.source));
}

/**
 * スイープの段(sweepOptions)の欄の下の案内。案内線の選び方と、ねじれ・終わりの大きさ・肉厚(M-07)を既定から
 * 変えた時の「計算に数秒かかる事がある」(経路と肉厚によって 1〜5 秒かかる実測がある)。文書・履歴は変えない。
 */
export function SweepOptionsHints({ state }: { readonly state: NumericInputState }): React.JSX.Element {
  return <>
    <p className="pcad-popover__hint">{t('numericInput.sweepGuide.hint')}</p>
    {usesSweepShape(state) ? <p className="pcad-popover__hint" role="note">{t('numericInput.sweepShape.slowHint')}</p> : null}
  </>;
}
