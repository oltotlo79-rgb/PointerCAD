/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import {
  fileAction, restoreCard, writeAutoSaveRecord,
} from './fileCaptureSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

/** `packages/help-content/docs/ja/local-data.md` §「自動の控えだけに頼らず、文書を保存する」。 */
const AUTO_SAVE_SAVED_AT = '2026-09-03T09:30:00.000Z';

/**
 * 「作図したデータの保存場所と通信」章の1枚。
 *
 * local-data-restore: 異常終了のあとに開き直したときの「前回の作業が残っています」の案内
 * (`e2e/tests/solid.spec.ts` の「前回の作業の控えから復元でき…」検査と同じ作り方で控えを書く)。
 */
export async function localDataCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  await expect(restoreCard(page)).toHaveCount(0);

  // 1) 箱を1つ置いて保存し、アプリ自身が書いた `.pcad` を控えの中身に使う。
  await chooseToolMenuItem(page, '作る', '箱');
  const created = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, created);

  const downloadPromise = page.waitForEvent('download');
  await fileAction(page, '保存').click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  if (savedPath === null) throw new Error('保存したファイルの場所が取れませんでした');
  const savedBytes = readFileSync(savedPath);
  expect(savedBytes.byteLength).toBeGreaterThan(0);
  const savedBase64 = savedBytes.toString('base64');

  // 2) 控えを1件だけ直に書いて開き直す。異常終了のあとの起動と同じ状態にする。
  await writeAutoSaveRecord(page, savedBase64, AUTO_SAVE_SAVED_AT);
  await page.reload();
  await waitForStartupHealth(page, info);

  await expect(restoreCard(page)).toContainText('前回の作業が残っています');
  await captureManualDetail(page, info, {
    name: 'local-data-restore', dialog: restoreCard(page),
    fixture: { savedAt: AUTO_SAVE_SAVED_AT, savedByteLength: savedBytes.byteLength }, script: new URL(import.meta.url),
  });

  // 後片付け: 復元して通常の画面へ戻す(このあとの誤り検査に影響を残さない)。
  await restoreCard(page).getByRole('button', { name: '復元する', exact: true }).click();
  await expect(restoreCard(page)).toHaveCount(0);
}
