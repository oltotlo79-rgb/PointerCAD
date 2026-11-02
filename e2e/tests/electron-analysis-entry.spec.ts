import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisEntries, analysisEntryFlow } from './analysisEntryFlow.js';

for (const entry of analysisEntries) {
  test(`analysis entry: ${entry.id} opens the existing input without running an analysis`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await analysisEntryFlow(await app.firstWindow(), entry, true); }
    finally { await app.close(); }
  });
}
