import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { sheetToolDefaultsFlow } from './sheetToolDefaultsFlow.js';
import { sheetBendDefaultsFlow, sheetReliefDefaultsFlow } from './sheetOperationDefaultsFlow.js';
import { sheetUnitDefaultsFlow } from './sheetUnitDefaultsFlow.js';

test('P12-8 板金初期値の設定と既存形保持・継承・実ファイル再開・Undoを実Electronで通す', async ({ playwright }, info) => {
  const launched = await launchDesktop(playwright, info);
  try {
    const page = await launched.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await sheetToolDefaultsFlow(page, info, launched.app); expect(errors).toEqual([]);
  } finally { await launched.app.close(); }
});

for (const [name, flow] of [
  ['指定線曲げの初期角度を保持し、継承・取消・実ファイル再編集・展開を通す', sheetBendDefaultsFlow],
  ['切欠きの初期値から実材料を除き、取消・実ファイル再編集・Undoを通す', sheetReliefDefaultsFlow],
  ['設定の25.4mmと手入力の1inchで同じ板を作り、実ファイル再編集・Undoを通す', sheetUnitDefaultsFlow],
] as const) {
  test(`P12-8 実Electronで${name}`, async ({ playwright }, info) => {
    const launched = await launchDesktop(playwright, info);
    try {
      const page = await launched.app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await flow(page, info, launched.app); expect(errors).toEqual([]);
    } finally { await launched.app.close(); }
  });
}
