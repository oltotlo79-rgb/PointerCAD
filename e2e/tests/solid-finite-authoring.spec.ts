import { test } from '@playwright/test';
import { solidFiniteAuthoringFlow } from './solidFiniteAuthoringFlow.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('大変形のCAD条件を実解析し保存・Undo・再開する', async ({ page }, info) => {
  // Two analyses and save/reopen each keep their existing finite wait; this is their total test budget, not a performance target.
  test.setTimeout(3 * KERNEL_TIMEOUT_MS);
  await solidFiniteAuthoringFlow(page, info);
});
