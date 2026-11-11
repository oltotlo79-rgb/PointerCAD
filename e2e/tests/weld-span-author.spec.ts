import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { weldSpanAuthorFlow, type WeldSpanAuthorCase } from './weldSpanAuthorFlow.js';

for (const mode of ['span-span', 'section-span', 'irregular-group'] satisfies readonly WeldSpanAuthorCase[]) {
  test(`Weld span author: ${mode}`, async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await weldSpanAuthorFlow(page, info, mode);
  });
}
