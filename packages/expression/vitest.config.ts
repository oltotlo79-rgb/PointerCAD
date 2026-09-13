import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 実際の曲面を生成する検査は、Commit/CIでも同時実行の負荷を受けない。
    fileParallelism: false,
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
