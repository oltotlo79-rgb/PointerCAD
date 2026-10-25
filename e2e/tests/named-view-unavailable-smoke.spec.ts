import { test } from '@playwright/test';
import { namedViewUnavailableFlow } from './namedViewUnavailableFlow.js';
import { waitForStartupReady } from './startupHealth.js';

for (const kind of ['part', 'assembly'] as const) {
  test('V103 R20 camera resource failure refuses named-view actions and reload recovers ' + kind, async ({ page }, info) => {
    await page.goto('/');
    await waitForStartupReady(page);
    await namedViewUnavailableFlow(page, info, kind);
  });
}
