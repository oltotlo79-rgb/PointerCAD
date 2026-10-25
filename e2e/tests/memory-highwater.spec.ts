import { test } from '@playwright/test';
import { memoryHighwaterFlow, prepareMemoryHighwaterBrowser } from './memoryHighwaterFlow.js';

// functional/Firefoxの各既存projectへRootが登録する。GPU unknownはskip/成功にしない。
for (const kind of ['solid', 'assembly'] as const) {
  test(`全PID/GPU高水位 ${kind} 100更新・取消・再試行・文書切替・解放`, async ({ page }, info) => {
    await prepareMemoryHighwaterBrowser(page);
    await memoryHighwaterFlow(page, info, kind);
  });
}
