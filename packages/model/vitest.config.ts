import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../test-utils/src/releasePerformance.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    // 実OCCT・数値計算を含むため、Commit・CIでもファイル間のCPU競合を防ぐ。
    // 厳密/参考で実行条件を変えると、全体検査後のCommitだけが時間切れになる。
    // ケースと精度は保ち、kernelと同じく1 workerで実行する。
    fileParallelism: false,
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
