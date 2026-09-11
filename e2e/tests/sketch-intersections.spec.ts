import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { intersectionEditingFlow, editReopenedIntersection, verifyIntersectionFile } from './intersectionsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

test('ADD-1 交点の自動接続から折曲げ・区間削除・保存再開まで操作できる', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/'); await intersectionEditingFlow(page, info);
  const download = page.waitForEvent('download');
  await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
  const path = info.outputPath('交点の編集.pcad'); await (await download).saveAs(path);
  verifyIntersectionFile(await readFile(path));
  await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '新規', exact: true }).click();
  const opening = page.waitForEvent('filechooser'), token = await beginRecompute(page);
  await page.getByRole('button', { name: '開く', exact: true }).click(); await (await opening).setFiles(path);
  await waitForRecompute(page, token); await editReopenedIntersection(page);
  expect(errors).toEqual([]);
});
