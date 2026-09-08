import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 厳密な性能判定では、他ファイルの WASM・数値計算と CPU を取り合わないようにする。
    // 性能検査は複数ファイルにあるため、model 全体を1 workerで順番に実行する。
    // 参考判定(Commit・CI の既定)は従来どおり並列。合図は expectWithinBudget と同じ。
    fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1',
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
