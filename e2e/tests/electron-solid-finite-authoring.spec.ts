import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { solidFiniteAuthoringFlow } from './solidFiniteAuthoringFlow.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('大変形のCAD条件を実解析し保存・Undo・再開する', async ({ playwright }, info) => {
  // Two analyses and save/reopen each keep their existing finite wait; this is their total test budget, not a performance target.
  test.setTimeout(3 * KERNEL_TIMEOUT_MS);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await solidFiniteAuthoringFlow(page, info, app);
  } finally { await app.close(); }
});
