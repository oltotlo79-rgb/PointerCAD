/** 2026-09-14利用者指示: 正確性を優先し、速度目標は公開後の改善に使う。
 * 試験専用。実用上の大幅な遅延は拒否し、端末/CI/環境変数で判定を変えない。
 */
export const SOFTWARE_VIEWPORT_TARGET_FPS = 30;
export const DRAWING_OPEN_TARGET_MS = 5_000;
export const MIN_PRACTICAL_VIEWPORT_FPS = 10;
/** 機能検査を既定の5秒だけで打ち切らず、結果を確認する有限の待機枠。 */
export const FUNCTIONAL_TEST_TIMEOUT_MS = 60_000;
/** 初回のWASM取得・展開・初期化を含む画面検査の待機上限。
 * 実計算の時間目標の記録と、製品の中止・数式期限は別に保持する。
 */
// Windows全件確認の完了74.332秒と同時初期化での90秒超を受けた有限上限。60秒の改善目標は保持する。
export const RECOMPUTE_TIMEOUT_MS = 150_000;
/** 進捗と中止を持つ干渉計算は10秒を有限の待ち時間とする。描画・入力応答には使わない。 */
export const INTERFERENCE_PRACTICAL_LIMIT_MS = 10_000;
/** 対象の立体との共通部分を求める押し出し。500msの改善目標は維持する。 */
export const SOLID_END_PRACTICAL_LIMIT_MS = 5_000;
export type DurationProfile = 'general' | 'interference' | 'solid-end';

export interface PerformanceMeasurement {
  readonly label: string;
  readonly actual: number;
  readonly target: number;
  readonly practicalLimit: number;
  readonly unit: 'ms' | 'fps';
  readonly meetsTarget: boolean;
  readonly usable: boolean;
}

/** 速度目標の未達と、異常値・実用上の大幅な遅延を分けて記録する。 */
function recordMeasurement(measurement: PerformanceMeasurement): PerformanceMeasurement {
  const { label, actual, target, practicalLimit, unit, usable } = measurement;
  if (label.trim() === '' || !Number.isFinite(actual) || actual < 0
    || !Number.isFinite(target) || target <= 0 || !Number.isFinite(practicalLimit) || practicalLimit <= 0) {
    throw new Error('性能測定の名前・実測値・目標・実用上限が不正です');
  }
  console.log('[性能記録]', JSON.stringify(measurement));
  if (!usable) {
    throw new Error(`実用上の遅延: ${label}（実測${actual}${unit}、許容境界${practicalLimit}${unit}）`);
  }
  return measurement;
}

/** 元の時間目標を記録し、処理の種類ごとに共通の有限上限を適用する。 */
export function reportDuration(actualMs: number, targetMs: number, label: string, profile: DurationProfile = 'general'): PerformanceMeasurement {
  const minimum = profile === 'interference' ? INTERFERENCE_PRACTICAL_LIMIT_MS
    : profile === 'solid-end' ? SOLID_END_PRACTICAL_LIMIT_MS : 100;
  const practicalLimit = Math.max(minimum, targetMs * 5);
  return recordMeasurement({ label, actual: actualMs, target: targetMs, practicalLimit, unit: 'ms',
    meetsTarget: actualMs < targetMs, usable: actualMs <= practicalLimit });
}

/** 描画の改善目標は記録へ残す。毎秒10枚未満の大幅な遅延を許可しない。 */
export function reportViewportRate(actualFps: number, label: string): PerformanceMeasurement {
  return recordMeasurement({ label, actual: actualFps, target: SOFTWARE_VIEWPORT_TARGET_FPS,
    practicalLimit: MIN_PRACTICAL_VIEWPORT_FPS, unit: 'fps',
    meetsTarget: actualFps >= SOFTWARE_VIEWPORT_TARGET_FPS, usable: actualFps >= MIN_PRACTICAL_VIEWPORT_FPS });
}

/** 試験専用の時間観測。参考目標の未達だけでは機能検査を中断しない。 */
export interface DurationObservation {
  readonly label: string;
  readonly actualMs: number;
  readonly referenceTargetMs: number;
  readonly meetsTarget: boolean;
  readonly decisionUse: 'observation';
}

/** 2026-10-27利用者指示: 根拠のない速度境界を機能の合否へ転用せず、実測と目標達否を残す。 */
export function observeDuration(actualMs: number, referenceTargetMs: number, label: string): DurationObservation {
  if (label.trim() === '' || !Number.isFinite(actualMs) || actualMs < 0
    || !Number.isFinite(referenceTargetMs) || referenceTargetMs <= 0) {
    throw new Error('時間観測の名前・実測値・参考目標が不正です');
  }
  const observation: DurationObservation = { label, actualMs, referenceTargetMs,
    meetsTarget: actualMs <= referenceTargetMs, decisionUse: 'observation' };
  console.log('[性能観測]', JSON.stringify(observation));
  return observation;
}

/** 試験専用のcold/warm比較。元0.8は参考値であり、時間待機や機能失敗を受け取らない。 */
export interface StartupReuseObservation {
  readonly label: string;
  readonly cold: number;
  readonly warm: number;
  readonly ratio: number;
  readonly referenceRatio: number;
  readonly meetsTarget: boolean;
  readonly decisionUse: 'observation';
}

/** 5組すべての有限な正値を確認し、中央値と元の比較目標を記録する。 */
export function observeStartupReuse(coldMs: readonly number[], warmMs: readonly number[], label: string): StartupReuseObservation {
  const valid = (values: readonly number[]): boolean => Array.isArray(values) && values.length === 5
    && Array.from({ length: 5 }, (_, i) => Object.hasOwn(values, i)
      && typeof values[i] === 'number' && Number.isFinite(values[i]) && values[i] > 0).every(Boolean);
  if (label.trim() === '' || !valid(coldMs) || !valid(warmMs)) {
    throw new Error('起動比較には名前とcold/warm各5件の有限な正値が必要です');
  }
  const median = (values: readonly number[]): number => {
    const value = [...values].sort((a, b) => a - b)[2];
    if (value === undefined) throw new Error('起動比較の標本が欠けています');
    return value;
  };
  const cold = median(coldMs), warm = median(warmMs), ratio = warm/cold;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('起動比較の比率が不正です');
  const referenceRatio = 0.8;
  const observation: StartupReuseObservation = { label, cold, warm, ratio, referenceRatio,
    meetsTarget: ratio <= referenceRatio, decisionUse: 'observation' };
  console.log('[性能観測]', JSON.stringify(observation));
  return observation;
}

/** 正の経過時間を要するホスト操作だけを確認し、既存の参考時間観測へ渡す。 */
export function observePositiveDuration(actualMs: number, referenceTargetMs: number, label: string): DurationObservation {
  if (!Number.isFinite(actualMs) || actualMs <= 0) throw new Error('操作の時間観測には有限な正値が必要です');
  return observeDuration(actualMs, referenceTargetMs, label);
}

/** 実描画から得た参考FPS。ほかの操作の実用FPS判定は変更しない。 */
export interface ViewportRateObservation {
  readonly label: string;
  readonly actualFps: number;
  readonly completedRenders: number;
  readonly elapsedMs: number;
  readonly referenceTargetFps: number;
  readonly meetsTarget: boolean;
  readonly decisionUse: 'observation';
}

/** 完了描画回数と同じ実測窓のFPSだけを記録し、低い参考達否だけでは停止しない。 */
export function observeViewportRate(value: unknown, label: string): ViewportRateObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('実描画の観測がありません');
  const fps: unknown = Reflect.get(value, 'fps');
  const completedRenders: unknown = Reflect.get(value, 'completedRenders');
  const elapsedMs: unknown = Reflect.get(value, 'elapsedMs');
  if (label.trim() === '' || typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0
    || typeof completedRenders !== 'number' || !Number.isSafeInteger(completedRenders) || completedRenders <= 0
    || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0
    || fps !== completedRenders*1_000/elapsedMs) {
    throw new Error('実描画のFPS・完了回数・計測窓には整合した有限な正値が必要です');
  }
  const observation: ViewportRateObservation = { label, actualFps: fps, completedRenders, elapsedMs,
    referenceTargetFps: SOFTWARE_VIEWPORT_TARGET_FPS, meetsTarget: fps >= SOFTWARE_VIEWPORT_TARGET_FPS, decisionUse: 'observation' };
  console.log('[性能観測]', JSON.stringify(observation));
  return observation;
}
