import { test } from '@playwright/test';
import { solidFiniteFieldFlow } from './solidFiniteFieldFlow.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

test.use({ viewport: { width: 1440, height: 900 }, screenshot: 'off' });
test('finite field changes and clears in the viewport', async ({ page }, info) => {
  // Two existing analyses and save/reopen: total wait budget, not a performance target.
  test.setTimeout(3 * KERNEL_TIMEOUT_MS);
  await solidFiniteFieldFlow(page, info);
});
