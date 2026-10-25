import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { saveCancelFlow, saveDocumentSwitchFlow, saveStatusDisplayFlow } from './saveResponsivenessFlow.js';

// 32/128MiB の保存中の入力応答とメモリーの実測は electron-save-performance.spec.ts(W05)で行う。
test('実Electron 32MiBの圧縮中の取消は1秒未満でWorkerを止め、ファイルを作らず保存し直せる', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await saveCancelFlow(await app.firstWindow(), info, app); }
  finally { await app.close(); }
});

test('実Electron 圧縮中の連打と文書切替で古い保存を書かず、新しい文書だけを保存する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await saveDocumentSwitchFlow(await app.firstWindow(), info, app); }
  finally { await app.close(); }
});

test('実Electron 状態欄の4表示を今の文書だけに出す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    // 最初の画面を読み直し、アプリのタイマーを作る前から同じ時計を使う(自動保存の間隔を進めるため)。
    const page = await app.firstWindow(); await page.clock.install(); await page.reload();
    await saveStatusDisplayFlow(page, info, app);
  } finally { await app.close(); }
});
