import { test } from '@playwright/test';
import { analysisEntries, analysisEntryFlow } from './analysisEntryFlow.js';

for (const entry of analysisEntries) {
  test(`analysis entry: ${entry.id} opens the existing input without running an analysis`, async ({ page }) => {
    await analysisEntryFlow(page, entry);
  });
}
