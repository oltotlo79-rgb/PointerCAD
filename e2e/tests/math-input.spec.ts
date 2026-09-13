import { expect, test } from '@playwright/test';
import { mathInputFlow } from './mathInputFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });
test('ADD-17 数学入力の実画面・係数追従・改名・Undo・保存再編集', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('[数学入力の画面例外]', error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathInputFlow(page, info);
  expect(errors).toEqual([]);
});

test('ADD-20 連立一次式とQR分解の分野検索・成分指定・非一意拒否・保存・F1を通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathLinearFlow(page, info);
  expect(errors).toEqual([]);
});
