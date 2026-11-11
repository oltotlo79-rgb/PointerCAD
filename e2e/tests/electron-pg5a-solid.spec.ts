import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { pg5aSolidPixels } from './pg5aSolidPixelsFlow.js';

test('PG5a real Electron ordinary Part at 0/1e6/1e9 mm renders within 1 physical pixel', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await pg5aSolidPixels(page, info, app);
  } finally { await app.close(); }
});
