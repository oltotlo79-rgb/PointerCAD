import { test, type Page } from '@playwright/test';
import { saveResponsivenessFlow } from './saveResponsivenessFlow.js';

/**
 * 保存の実測(レビュー R06・W05): 32/128MiB の原本を持つ部品を各3回保存し、保存中の100入力の p95<100ms と
 * 全PIDの追加 peak<512MiB(保存中・解放後)を確かめる。保存先は実OPFS(File System Access API の口)。
 * 測定値は各試験の出力 `save-<MiB>-<回>.json` に残る。Firefox は firefox-save-performance.spec.ts、
 * 実Electron(実ディスク)は electron-save-performance.spec.ts。
 */
test.use({ browserName: 'chromium' });

async function withoutPickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // 開くは製品のファイル選択の経路で行い、保存の口だけを実OPFSのファイルへ向ける(saveResponsivenessFlow)。
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
  });
}

test.describe('保存の実測 chromium(実OPFS)', () => {
  for (const mib of [32, 128] as const) for (let repeat = 0; repeat < 3; repeat++) {
    test(`${mib}MiB ${repeat + 1}/3 保存中の100入力・全PIDの追加メモリー・実OPFSの保存と再開`, async ({ page }, info) => {
      await withoutPickers(page); await page.goto('/');
      await saveResponsivenessFlow(page, info, mib, repeat, undefined, { target: 'opfs' });
    });
  }
});
