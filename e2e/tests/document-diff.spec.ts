import { documentMaterialDiffFlow } from './documentMaterialDiffFlow.js';
import { expect, test } from '@playwright/test';
import { documentDiffFlow } from './documentDiffFlow.js';

test('P12-13 2つの実保存ファイルの追加・削除・原式を比較し、元ファイルと編集中の部品を保持する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await documentDiffFlow(page, info); expect(errors).toEqual([]);
});

test('P12-14 実ファイルの穴開け前後を形と体積で比較し、中止と元の部品の保持を通す', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await documentMaterialDiffFlow(page, info); expect(errors).toEqual([]);
});
