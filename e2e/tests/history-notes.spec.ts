import { expect, test } from '@playwright/test';
import { historyNotesFlow } from './historyNotesFlow.js';
import { openDocumentHistoryFlow } from './openDocumentHistoryFlow.js';

test('P12-11/P12-12 設計メモと履歴フォルダを再計算なしで編集・取消・Undo・保存再開し、F1を開く', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await historyNotesFlow(page, info); expect(errors).toEqual([]);
});

test('別の部品・最近使ったファイルを開いた後は元に戻すが押せず、前の文書の選択を持ち越さない', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await openDocumentHistoryFlow(page, info); expect(errors).toEqual([]);
});
