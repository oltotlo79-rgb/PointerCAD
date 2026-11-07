import { defineConfig } from 'vitest/config';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from './src/releasePerformance.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    // 検査ファイルを並列に流さない(rules/06 §10.468)。ここの検査はリポジトリ全体の走査と構文解析が主で、
    // 並列にすると互いに遅くなる。2026-11-07 の根の実測(ネイティブ node v25.9.0・12 コア、vitest run):
    // 既定の 11 本は 5 ファイルが時間切れ(137.7 秒)、4 本は p10ModuleBoundary の 1 件が 85.1 秒で時間切れ
    // (245.0 秒)、2 本は全件成功(189.8 秒)でも同じ 1 件が 49.4 秒(上限 60 秒の 82%)、1 本は全件成功
    // (316.4 秒)で同じ 1 件が 34.7 秒(58%)。時間の上限は変えず、並列だけを 1 本に固定する。
    // fileParallelism: false は CLI の --maxWorkers より優先されるので、gate・diag.py・CI で同じ 1 本になる。
    fileParallelism: false,
  },
});
