/**
 * 数の大きさを許容差と比べる共通の口(model の入口)。許容差の比較を製品のあちこちに手書きで足さず、ここへ集める
 * (規約の検査 toleranceBaseline)。許容差の値は呼ぶ側が名前のある定数で渡す。
 * 定義は kernel の読み込みの無い純粋な部分(`@pointercad/kernel/math/magnitude`)の 1 か所だけで、ここは橋
 * `kernelBridge/magnitudeMath.ts` から出し直す。どれも |value| を bound と比べた時と同じ真偽を返し、value か bound が NaN の時は false。
 */
export { belowMagnitude, exceedsMagnitude, magnitudeAtLeast, withinMagnitude } from './kernelBridge/magnitudeMath.js';
