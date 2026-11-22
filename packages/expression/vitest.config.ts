import { createPackageVitestConfig } from '../test-utils/src/vitest.package.testSupport.js';

const options = { include: ['src/**/*.test.ts'] };

// 実際の曲面を生成する検査は、Commit/CIでも同時実行の負荷を受けない。
export default createPackageVitestConfig('performance-serial', options);
