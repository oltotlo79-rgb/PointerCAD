import { expect, test } from '@playwright/test';
import { surfacesFlow } from './surfacesFlow.js';

test('P11b 曲面の自由曲線ロフト・平滑化・案内線・保存再編集・F1', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/'); await surfacesFlow(page, info); expect(errors).toEqual([]);
});
