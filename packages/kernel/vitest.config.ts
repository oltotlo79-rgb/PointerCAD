import { createPackageVitestConfig } from '../test-utils/src/vitest.package.testSupport.js';

const options = {
  include: ['src/**/*.test.ts'],
  // 初回の WASM コンパイルを待ち、OCCT を 1 プロセスで共有する。
  hookTimeout: 180_000,
  pool: 'forks' as const,
  // パイプ・CI でも OCCT の初期化時間を記録する。
  reporters: ['default'],
};

export default createPackageVitestConfig('kernel', options);
