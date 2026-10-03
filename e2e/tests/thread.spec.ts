import { expect, test } from '@playwright/test';
import { threadCaptureFlow } from './threadCaptureFlow.js';
import { threadShaftCaptureFlow, threadShaftDesignationFlow } from './threadShaftCaptureFlow.js';

test('P12-17 ねじ穴をあけるの章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await threadCaptureFlow(page, info);
  expect(errors).toEqual([]);
});

test('FIX-06 円柱の側面を選んで外ねじの入力欄を開く画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await threadShaftCaptureFlow(page, info);
  expect(errors).toEqual([]);
});

test('外ねじの窓で呼びを M20 に選ぶとピッチに規格の 2.5 が入り、その値で作られる', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await threadShaftDesignationFlow(page, info);
  expect(errors).toEqual([]);
});
