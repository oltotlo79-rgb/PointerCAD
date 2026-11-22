import { createPackageVitestConfig } from '../test-utils/src/vitest.package.testSupport.js';
import { appVersionDefine } from '../../scripts/vite/appVersion.mjs';

// Web・desktop の build と同じ名前・同じ値(根の package.json の version)。
const options = { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], define: appVersionDefine() };

export default createPackageVitestConfig('performance-strict', options);
