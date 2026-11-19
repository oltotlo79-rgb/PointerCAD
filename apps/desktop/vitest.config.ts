import { defaultExclude, defineConfig } from 'vitest/config';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../packages/test-utils/src/releasePerformance.js';

/**
 * 実際の組み立て・git の取り出し・本体の読み込み・PowerShell の後片付けを行う、負荷に弱い検査。
 * 全件の並列の中では、ほかの検査と CPU・ディスクを取り合って決まった上限を越えた
 * (2026-11-19: 全件 3 回が毎回ちがう 1 本で落ち、どれも単独では成功)。
 * 全件では、ほかの検査が全部終わった後に 1 本ずつ流す。上限と期待値は変えない。
 */
const LOAD_SENSITIVE_TESTS = [
  'src/main/startupBundle.test.ts',
  'src/main/webBuildSources.test.ts',
  'src/main/mainSecurity.test.ts',
  'src/main/portableCleanupScript.test.ts',
  'src/main/mathNoticeCheckout.test.ts',
];

const shared = { environment: 'node', testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS } as const;

export default defineConfig({
  test: {
    projects: [
      // 最初の組の対象はパッケージの全部(検査の取りこぼしの単体と diag の --all は、最初の対象の一覧を読む)。
      { test: { ...shared, name: 'desktop', include: ['src/**/*.test.ts'], exclude: [...defaultExclude, ...LOAD_SENSITIVE_TESTS] } },
      // groupOrder 1 は上の組が終わってから始まり、fileParallelism false で 1 本ずつ流れる。
      { test: { ...shared, name: 'desktop-serial', include: LOAD_SENSITIVE_TESTS, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
