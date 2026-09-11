import { expect, test } from '@playwright/test';
import { dwgFlow } from './dwgFlow.js';
test('P11b DWGは選択前に変換手順へ案内し文書を変えない', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await dwgFlow(page, info); expect(errors).toEqual([]);
});
