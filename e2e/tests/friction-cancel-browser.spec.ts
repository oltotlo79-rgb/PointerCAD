import { expect, test } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { frictionCancelFlow } from './frictionCancelFlow.js';

test.describe('Friction cancellation and restart (Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('cancel running work, review and solve all four stages', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page); await page.goto('/');
    await frictionCancelFlow(page, name => info.outputPath(name));
    expect(errors).toEqual([]);
  });
});
