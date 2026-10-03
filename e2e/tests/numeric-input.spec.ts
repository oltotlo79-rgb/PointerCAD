import { expect, test } from '@playwright/test';
import { numericInputCaptureFlow } from './numericInputCaptureFlow.js';
import { numericInputDragCaptureFlow } from './numericInputDragCaptureFlow.js';

test('P12 数値と式の入れ方章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await numericInputCaptureFlow(page, info);
  expect(errors).toEqual([]);
});

test('UX-03 入力の窓を見出しのドラッグで動かした画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await numericInputDragCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
