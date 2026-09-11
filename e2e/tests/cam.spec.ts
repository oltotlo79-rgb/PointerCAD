import { expect, test } from '@playwright/test';
import { camFlow } from './camFlow.js';
test('P11b 加工先へSTEP・STL・3MFを渡し、形を送信せず手順を開く', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await camFlow(page, info); expect(errors).toEqual([]);
});
