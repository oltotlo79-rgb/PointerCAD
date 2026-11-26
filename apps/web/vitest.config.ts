import { createPackageVitestConfig } from '../../packages/test-utils/src/vitest.package.testSupport.js';

// Vitest is pinned in the root tooling; Web-specific code remains under apps/web.
const options = { include: ['src/**/*.test.ts', 'build/**/*.test.ts'] };

export default createPackageVitestConfig('default', options);
