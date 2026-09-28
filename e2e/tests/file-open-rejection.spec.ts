import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createEmptyPartDocument } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

/**
 * P12-26(全ファイル入口の保全と展開制限)。300MiB の実ファイルは作らず、
 * **正しい ZIP の形をした小さな `.pcad` の中身だけを壊す**(CRC不一致に近い壊れ方。
 * `packages/io/src/pcad/readArchive.ts` はどちらの壊れ方も同じ「ZIP を開く前に断る/
 * 展開した中身が合わない」経路で断り、`packages/ui/src/file/partFile.ts` の
 * `openPart` は検証を通った文書だけを差し替えるので、今の文書は変わらない、NFR-RE-1)。
 * 単体の検証は `packages/io/src/pcad/readArchive.test.ts` 等・
 * `packages/ui/src/file/partFile.test.ts`・`attachAutoSave.test.ts` の
 * 圧縮爆弾・虚偽サイズ・CRC不一致の各件で済んでいるので、ここでは画面から見える結果
 * (理由が出る・今の文書が残る)だけを確かめる。
 *
 * 共有の撮影補助(`fileCaptureSupport.ts` 等)はまだコミットされていない別担当(w37b)の
 * 作業中の台本なので使わず、この spec だけで完結させる(統括 2026-09-27 の指示)。
 */
test('P12-26 中身が壊れた.pcadを開いても理由が出て、今の文書は変わらない', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });

  // 正しい .pcad を作り、圧縮された document.json の中身だけを1バイト壊す
  // (中央目録・EOCD には触れず ZIP としての形は保つ。実際の壊れ方は
  //  `packages/ui/src/file/partFile.test.ts` の `crcMismatchPcad` 等と同じ考え方)。
  const goodBytes = writePcadFile(createEmptyPartDocument());
  const brokenBytes = Uint8Array.from(goodBytes);
  const middle = Math.floor(brokenBytes.length / 2);
  brokenBytes[middle] = (brokenBytes[middle] ?? 0) ^ 0xff;
  const brokenPath = info.outputPath('p12-26-broken.pcad');
  await writeFile(brokenPath, brokenBytes);

  await page.goto('/');

  // 保存していない変更(点を1つ)を作り、「今の文書」として区別できるようにする。
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of ['5', '5', '0'].entries()) await fields.nth(index).fill(value);
  const point = await beginRecompute(page);
  await fields.first().press('Enter'); await page.keyboard.press('Escape');
  await waitForRecompute(page, point);
  const pointRow = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(pointRow).toBeVisible();
  await expect(page.locator('.pcad-statusbar__file')).toContainText('*');

  // 壊れた .pcad を開こうとする。保存していない変更があるので、開く前の確認(画面の中の
  // 日本語の3択。w91a)に「保存せずに続ける」で答える(NFR-UX-3。答えるまで選ぶ窓は開かない)。
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  const discardConfirm = page.getByRole('alertdialog', { name: '保存していない変更があります' });
  await expect(discardConfirm).toContainText('保存していない変更は失われます。続けますか。');
  await discardConfirm.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  await (await chooser).setFiles(brokenPath);
  await expect(discardConfirm).toHaveCount(0);

  // 理由が赤い帯に出る。
  await expect(page.locator('.pcad-statusbar')).toHaveClass(/pcad-statusbar--error/);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('ファイルが壊れているため開けませんでした。');

  // 今の文書は変わらない(NFR-RE-1)。点はそのまま残り、未保存の印も消えない。
  await expect(pointRow).toBeVisible();
  await expect(page.locator('.pcad-statusbar__file')).toContainText('*');

  expect(errors).toEqual([]);
});
