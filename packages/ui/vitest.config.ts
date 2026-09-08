import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1',
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
