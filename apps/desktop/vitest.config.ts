import { createPackageVitestConfig } from '../../packages/test-utils/src/vitest.package.testSupport.js';

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

// 最初の include は全件検査と diag --all が読む対象一覧。
const options = { include: ['src/**/*.test.ts'], serialFiles: LOAD_SENSITIVE_TESTS };

export default createPackageVitestConfig('desktop', options);
