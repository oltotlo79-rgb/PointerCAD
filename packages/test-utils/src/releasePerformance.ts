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
export const RECOMPUTE_TIMEOUT_MS = 90_000;

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

/** 元の時間目標を記録し、5倍（短い処理でも100ms）を超える遅延は拒否する。 */
export function reportDuration(actualMs: number, targetMs: number, label: string): PerformanceMeasurement {
  const practicalLimit = Math.max(100, targetMs * 5);
  return recordMeasurement({ label, actual: actualMs, target: targetMs, practicalLimit, unit: 'ms',
    meetsTarget: actualMs < targetMs, usable: actualMs <= practicalLimit });
}

/** 描画の改善目標は記録へ残す。毎秒10枚未満の大幅な遅延を許可しない。 */
export function reportViewportRate(actualFps: number, label: string): PerformanceMeasurement {
  return recordMeasurement({ label, actual: actualFps, target: SOFTWARE_VIEWPORT_TARGET_FPS,
    practicalLimit: MIN_PRACTICAL_VIEWPORT_FPS, unit: 'fps',
    meetsTarget: actualFps >= SOFTWARE_VIEWPORT_TARGET_FPS, usable: actualFps >= MIN_PRACTICAL_VIEWPORT_FPS });
}
