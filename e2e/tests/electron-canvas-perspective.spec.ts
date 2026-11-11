import { expect, test } from '@playwright/test';
import { canvasPerspectiveFlow } from './canvasPerspectiveFlow.js';
import { launchDesktop } from './electronAppFlow.js';

test('実Electronの下絵四隅補正・内部9点・保存再開', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    expect(page.url()).toBe('app://pointercad/index.html');
    await canvasPerspectiveFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
