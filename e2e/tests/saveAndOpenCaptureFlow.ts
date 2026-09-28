/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { fileAction, PART_NAME, restoreCard, statusBar, writeAutoSaveRecord } from './fileCaptureSupport.js';

const AUTO_SAVE_SAVED_AT = '2026-09-24T04:00:00.000Z';

/**
 * 「保存する・開く」章の3枚(`packages/help-content/docs/ja/save-and-open.md`)。
 *
 * 1) save-and-open-buttons: 保存していない変更がある状態のファイルの3ボタン(§ボタンとキー)。
 * 2) save-and-open-restore: 自動保存の控えから「前回の作業が残っています」の案内(§自動保存)。
 * 3) save-and-open-file-error: 壊れたファイルを開こうとしたときの赤い帯(§開けなかったとき)。
 *
 * 「保存していない変更は失われます。続けますか。」の確認は、w91aでブラウザ既定の`window.confirm`
 * から画面内の確認窓(`role="alertdialog"`、`packages/ui/src/shell/AppShell.tsx`の
 * `DiscardConfirmDialog`)へ差し替わったが、この flow では未保存の変更を失う操作(新規・開く・
 * ひな形から新規など)を行わないため、いまも登場しない。この章の3枚目は同じ節が扱う
 * 「開けなかったとき」の赤い帯に差し替えた。
 */
export async function saveAndOpenCaptureFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 点を1つ打って保存していない変更を作り、ファイルの3ボタンとファイル名の「*」を撮る。
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of ['5', '5', '0'].entries()) await fields.nth(index).fill(value);
  const point = await beginRecompute(page);
  await fields.first().press('Enter'); await page.keyboard.press('Escape');
  await waitForRecompute(page, point);
  await expect(page.locator('.pcad-statusbar__file')).toContainText('*');
  await captureManualDetail(page, info, {
    name: 'save-and-open-buttons', dialog: page.getByRole('group', { name: 'ファイル', exact: true }),
    fixture: { step: 'unsaved-point' }, script: new URL(import.meta.url),
  });

  // 2) 保存し、その内容を控えとしてIndexedDBへ直に置いてから開き直し、復元カードを撮る。
  const savedPath = info.outputPath('save-and-open-before.pcad');
  if (app !== undefined) await saveTarget(app, savedPath);
  const download = app === undefined ? page.waitForEvent('download') : null;
  await fileAction(page, '保存').click();
  if (download !== null) await (await download).saveAs(savedPath); else await diskFile(savedPath);
  const savedBase64 = (await readFile(savedPath)).toString('base64');
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('保存しました');

  await writeAutoSaveRecord(page, savedBase64, AUTO_SAVE_SAVED_AT);
  await page.reload();
  await waitForStartupHealth(page, info);
  await expect(restoreCard(page)).toContainText('前回の作業が残っています');
  await captureManualDetail(page, info, {
    name: 'save-and-open-restore', dialog: restoreCard(page),
    fixture: { savedAt: AUTO_SAVE_SAVED_AT, documentName: PART_NAME }, script: new URL(import.meta.url),
  });
  await restoreCard(page).getByRole('button', { name: '破棄する', exact: true }).click();
  await expect(restoreCard(page)).toHaveCount(0);

  // 3) 壊れたファイル(.pcadを名乗るがZIPですらない)を開こうとして、赤い帯を撮る。
  const brokenPath = info.outputPath('save-and-open-broken.pcad');
  await writeFile(brokenPath, Buffer.from('これはPointerCADの部品ファイルではありません', 'utf8'));
  if (app !== undefined) await openTarget(app, brokenPath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  await fileAction(page, '開く').click();
  if (chooser !== null) await (await chooser).setFiles(brokenPath);
  await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('ファイルが壊れているため開けませんでした。');
  await captureManualDetail(page, info, {
    name: 'save-and-open-file-error', dialog: statusBar(page),
    fixture: { attemptedFile: 'save-and-open-broken.pcad' }, script: new URL(import.meta.url),
  });
}
