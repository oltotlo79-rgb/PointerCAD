import { createPackageVitestConfig } from '../test-utils/src/vitest.package.testSupport.js';

const options = { include: ['src/**/*.test.ts'] };

// 実OCCT・数値計算を含むため、Commit・CIでもファイル間のCPU競合を防ぐ。
// 厳密/参考で実行条件を変えると、全体検査後のCommitだけが時間切れになる。
// ケースと精度は保ち、kernelと同じく1 workerで実行する。
export default createPackageVitestConfig('performance-serial', options);
