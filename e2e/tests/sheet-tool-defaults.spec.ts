import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { withBrowserFailureDiagnostics } from './browserFailureDiagnostics.js';
import { sheetToolDefaultsFlow } from './sheetToolDefaultsFlow.js';
import { sheetBendDefaultsFlow, sheetReliefDefaultsFlow } from './sheetOperationDefaultsFlow.js';
import { sheetUnitDefaultsFlow } from './sheetUnitDefaultsFlow.js';
import { installStartupDiagnostics } from './startupHealth.js';

/**
 * 2026-09-29 の CI（run 36498422943）で、Firefox の画面が操作の途中で失われ、次の確認が
 * 「aria-invalid の値が空」という別の失敗に見えた。画面・文脈・ブラウザーの終了を段階と時刻付きで
 * 記録し、入力の検証の失敗や待ちの時間切れと区別する（rules/06 §10.177・§10.312 と同じ分類）。
 */
async function runWithDiagnostics(page: Page, info: TestInfo,
  flow: (page: Page, info: TestInfo) => Promise<void>): Promise<void> {
  await withBrowserFailureDiagnostics(page, info, async stage => {
    stage('画面を開く');
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // CI run 36562231295 failed before the first operation. Install before goto so
    // caught renderer errors and WebGL creation failures reach the startup log.
    await installStartupDiagnostics(page);
    const context = page.context(), browser = context.browser();
    console.log(`[板金初期値の起動] ${JSON.stringify({
      at: new Date().toISOString(), project: info.project.name, title: info.title,
      workerIndex: info.workerIndex, parallelIndex: info.parallelIndex,
      browserConnected: browser?.isConnected(), browserContexts: browser?.contexts().length,
      contextPages: context.pages().length,
    })}`);
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      }
    });
    await page.goto('/');
    stage('板金の初期値の操作');
    await flow(page, info);
    stage('画面の例外の確認');
    expect(errors).toEqual([]);
  });
}

test('P12-8 板金の10初期値を設定し、既存形の保持・開始時の写し・継承・保存再開・Undo・展開を通す', async ({ page }, info) => {
  await runWithDiagnostics(page, info, sheetToolDefaultsFlow);
});

for (const [name, flow] of [
  ['指定線曲げの初期角度を開始時に保持し、継承・取消・保存再編集・展開を通す', sheetBendDefaultsFlow],
  ['切欠きの初期値から実材料を除き、試し表示の取消・保存再編集・Undoを通す', sheetReliefDefaultsFlow],
  ['設定の25.4mmと手入力の1inchで同じ板を作り、保存再編集・Undoを通す', sheetUnitDefaultsFlow],
] as const) {
  test(`P12-8 ${name}`, async ({ page }, info) => {
    await runWithDiagnostics(page, info, flow);
  });
}
