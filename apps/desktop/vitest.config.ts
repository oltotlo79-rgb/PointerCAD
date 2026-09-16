import { defineConfig } from 'vitest/config';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../packages/test-utils/src/releasePerformance.js';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS },
});
