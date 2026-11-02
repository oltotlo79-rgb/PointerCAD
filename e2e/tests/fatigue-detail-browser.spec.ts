import { expect, test } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { fatigueDetailFlow } from './fatigueDetailFlow.js';

test.describe('Joint fatigue detail (Web)', () => {
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('weld and bolt input, independent result, persistence and history', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('/');
    await fatigueDetailFlow(page, info);
    expect(errors).toEqual([]);
  });
});
