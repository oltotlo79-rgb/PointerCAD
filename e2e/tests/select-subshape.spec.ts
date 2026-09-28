import { expect, test } from '@playwright/test';
import { selectSubshapeCaptureFlow } from './selectSubshapeCaptureFlow.js';

test('P12 面・辺・頂点を選ぶ章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await selectSubshapeCaptureFlow(page, info);
  expect(errors).toEqual([]);
});
