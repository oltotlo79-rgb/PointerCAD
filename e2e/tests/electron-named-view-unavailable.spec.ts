import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { namedViewUnavailableFlow } from './namedViewUnavailableFlow.js';

for (const kind of ['part', 'assembly'] as const) {
  test('V103 R20 real Electron camera resource failure refuses named-view actions and reload recovers ' + kind, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await namedViewUnavailableFlow(await app.firstWindow(), info, kind); }
    finally { await app.close(); }
  });
}
