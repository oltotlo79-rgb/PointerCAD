import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { saveResponsivenessFlow } from './saveResponsivenessFlow.js';

// 保存の実測(レビュー R06・W05)の実Electron(実ディスク)。ブラウザーの実OPFSは save-performance.spec.ts。
for (const mib of [32, 128] as const) for (let repeat = 0; repeat < 3; repeat++) {
  test(`実Electron 保存の実測 ${mib}MiB ${repeat + 1}/3 保存中の100入力・全PIDの追加メモリー・実ディスクの保存と再開`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await saveResponsivenessFlow(await app.firstWindow(), info, mib, repeat, app); }
    finally { await app.close(); }
  });
}
