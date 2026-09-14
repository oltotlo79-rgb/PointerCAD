import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../test-utils/src/releasePerformance.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    // 実際の曲面を生成する検査は、Commit/CIでも同時実行の負荷を受けない。
    fileParallelism: false,
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
