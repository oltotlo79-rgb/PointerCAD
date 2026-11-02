import { test } from '@playwright/test';
import { CUT_LIFECYCLE_CASES, cutLifecycleFlow, cutPlaneMaterialsFlow } from './cutPlaneMaterialsFlow.js';
import { launchDesktop } from './electronAppFlow.js';

test('EX-04 実Electron 切る面の材料(スケッチの点・座標の式・XYZ 軸・辺・作業平面)で切った体積が出て、元に戻す 1 回で箱へ戻る', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    // 製品の入口(apps/desktop/src/main/appProtocol.ts の APP_ENTRY_URL)を開き直す(electron-face-offset.spec.ts と同じ)。
    await cutPlaneMaterialsFlow(await app.firstWindow(), 'app://pointercad/index.html');
  } finally {
    await app.close();
  }
});

for (const kind of CUT_LIFECYCLE_CASES) {
  test(`EX-04 current lifecycle ${kind}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await cutLifecycleFlow(await app.firstWindow(), info, kind, app); }
    finally { await app.close(); }
  });
}
