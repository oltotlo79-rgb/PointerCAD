import { createPackageVitestConfig } from '../test-utils/src/vitest.package.testSupport.js';

const options = { include: ['src/**/*.test.ts'] };

export default createPackageVitestConfig('default', options);
