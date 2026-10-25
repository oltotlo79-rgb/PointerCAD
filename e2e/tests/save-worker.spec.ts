import { test, type Page } from '@playwright/test';
import { browserSaveAbortFlow } from './browserSaveAbortFlow.js';
import { saveCancelFlow, saveDocumentSwitchFlow, saveStatusDisplayFlow } from './saveResponsivenessFlow.js';

test.use({ browserName: 'chromium' });

/** File System Access API の窓を出さず、製品のダウンロード代替・ファイル選択の経路を通す。 */
async function withoutPickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
  });
}

// 32/128MiB の保存中の入力応答とメモリーの実測は save-performance.spec.ts(W05)で行う。
test.describe('保存Worker chromium', () => {
  test('32MiBの圧縮中の取消は1秒未満でWorkerを止め、ファイルを作らず保存し直せる', async ({ page }, info) => {
    await withoutPickers(page); await page.goto('/'); await saveCancelFlow(page, info);
  });
  test('圧縮中の連打と文書切替で古い保存を書かず、新しい文書だけを保存する', async ({ page }, info) => {
    await withoutPickers(page); await page.goto('/'); await saveDocumentSwitchFlow(page, info);
  });
  test('状態欄の4表示を今の文書だけに出し、ダウンロード代替で部品とひな形を保存する', async ({ page }, info) => {
    await withoutPickers(page); await page.clock.install(); await page.goto('/'); await saveStatusDisplayFlow(page, info);
  });
  test('実OPFSへの書込み後のwrite/close失敗とabort後の再保存', async ({ page }, info) => {
    await withoutPickers(page); await page.goto('/'); await browserSaveAbortFlow(page, info);
  });
});
