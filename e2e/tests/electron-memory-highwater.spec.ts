import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { memoryHighwaterFlow } from './memoryHighwaterFlow.js';

for (const kind of ['solid', 'assembly'] as const) {
  test(`実Electron 全PID/GPU高水位 ${kind} 100更新・取消・再試行・文書切替・解放`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await memoryHighwaterFlow(await app.firstWindow(), info, kind, app); }
    finally { await app.close(); }
  });
}
