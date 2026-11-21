import { defineConfig } from 'vitest/config';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../test-utils/src/releasePerformance.js';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';
import { appVersionDefine } from '../../scripts/vite/appVersion.mjs';

export default defineConfig({
  // Web・desktop の build と同じ名前・同じ値(根の package.json の version)。
  define: appVersionDefine(),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1',
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
