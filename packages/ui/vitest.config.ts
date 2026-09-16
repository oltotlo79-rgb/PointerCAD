import { defineConfig } from 'vitest/config';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../test-utils/src/releasePerformance.js';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1',
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
