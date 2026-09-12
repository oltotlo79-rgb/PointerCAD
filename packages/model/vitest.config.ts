import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 実OCCT・数値計算を含むため、Commit・CIでもファイル間のCPU競合を防ぐ。
    // 厳密/参考で実行条件を変えると、全体検査後のCommitだけが時間切れになる。
    // 判定値・テスト期限・各ケースは保ち、kernelと同じく1 workerで実行する。
    fileParallelism: false,
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
