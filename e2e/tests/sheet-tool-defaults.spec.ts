import { expect, test } from '@playwright/test';
import { sheetToolDefaultsFlow } from './sheetToolDefaultsFlow.js';
import { sheetBendDefaultsFlow, sheetReliefDefaultsFlow } from './sheetOperationDefaultsFlow.js';
import { sheetUnitDefaultsFlow } from './sheetUnitDefaultsFlow.js';

test('P12-8 板金の10初期値を設定し、既存形の保持・開始時の写し・継承・保存再開・Undo・展開を通す', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await sheetToolDefaultsFlow(page, info); expect(errors).toEqual([]);
});

for (const [name, flow] of [
  ['指定線曲げの初期角度を開始時に保持し、継承・取消・保存再編集・展開を通す', sheetBendDefaultsFlow],
  ['切欠きの初期値から実材料を除き、試し表示の取消・保存再編集・Undoを通す', sheetReliefDefaultsFlow],
  ['設定の25.4mmと手入力の1inchで同じ板を作り、保存再編集・Undoを通す', sheetUnitDefaultsFlow],
] as const) {
  test(`P12-8 ${name}`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
      }
    });
    await page.goto('/'); await flow(page, info); expect(errors).toEqual([]);
  });
}
