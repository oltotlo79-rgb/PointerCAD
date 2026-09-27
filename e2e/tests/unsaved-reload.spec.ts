/// <reference lib="dom" />
import { expect, test, type Dialog, type Locator, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

/** 取り消した読み直しの約束を待つ上限。確認の窓は読み直しの開始直後に出るので、その後の待ちは短くてよい。 */
const RELOAD_ABANDON_MS = 10_000;

/** 画面のいちばん下のファイル名。保存していない変更があると末尾に `*` が付く。 */
function statusFileName(page: Page): Locator {
  return page.locator('.pcad-statusbar__file');
}

/** 点ツールで点を1つ置き、再計算の終わりを待つ(保存していない変更を作る)。 */
async function addPoint(page: Page, values: readonly [string, string, string]): Promise<void> {
  // 点の道具は Escape の後も選ばれたまま残る。選択へ戻してから選び直し、入力欄を開く。
  const sketch = page.getByRole('group', { name: 'スケッチ', exact: true });
  await sketch.getByRole('button', { name: '選択', exact: true }).click();
  await sketch.getByRole('button', { name: '点', exact: true }).click();
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of values.entries()) await fields.nth(index).fill(value);
  const point = await beginRecompute(page);
  await fields.first().press('Enter');
  await page.keyboard.press('Escape');
  await waitForRecompute(page, point);
}

test('P12-24 保存していない変更があるときだけ読み直しの前に確認し、取り消すと変更が残る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // 保存はダウンロードに揃える(保存先を選ぶ窓を開かない)。
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);

  // 1) 何も変えていないうちは、画面を操作した後(ブラウザーが確認を出せる状態)でも確認せずに読み直す。
  const unexpected: string[] = [];
  const recordUnexpected = (dialog: Dialog): void => {
    unexpected.push(dialog.type()); void dialog.accept();
  };
  page.on('dialog', recordUnexpected);
  await page.locator('canvas.pcad-viewport__canvas').click({ position: { x: 20, y: 20 } });
  await expect(statusFileName(page)).toHaveText('名称未設定');
  await page.reload(); await waitForStartupHealth(page, info);
  expect(unexpected).toEqual([]);
  page.off('dialog', recordUnexpected);

  // 2) 点を置くと保存していない変更になる。読み直そうとするとブラウザーが確認し、
  //    「このページにとどまる」(取消し)を選ぶと読み直さず、変更がそのまま残る。
  await addPoint(page, ['1', '2', '3']);
  await expect(statusFileName(page)).toHaveText('名称未設定*');
  const pointRow = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(pointRow).toBeVisible();
  // 読み直されたかを、頁の中の印が消えるかで見分ける(読み直すと頁の記憶は作り直される)。
  await page.evaluate(() => { Reflect.set(globalThis, 'pcadUnsavedReloadMarker', true); });
  const asked = page.waitForEvent('dialog');
  // Chromium のヘッドレスでは、確認を取り消した読み直しの約束が決着せず "load" を待ち続ける
  // (13回目の全体検査の実測)。読み直しは待たずに始め、短い上限で打ち切って結果だけ控える。
  const reloading = page.reload({ timeout: RELOAD_ABANDON_MS }).then(() => 'reloaded', (error: unknown) => String(error));
  const dialog = await asked;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(await reloading, '取り消した読み直しが完了しないこと').not.toBe('reloaded');
  expect(await page.evaluate(() => Reflect.get(globalThis, 'pcadUnsavedReloadMarker') === true), '頁が読み直されていないこと').toBe(true);
  await expect(statusFileName(page)).toHaveText('名称未設定*');
  await expect(pointRow).toBeVisible();

  // 3) 取り消した後も続けて編集でき、保存すると確認は出なくなる。
  await addPoint(page, ['4', '5', '6']);
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '点2', exact: true })).toBeVisible();
  const saved = await savePart(page, info, 'unsaved-reload.pcad');
  expect(saved.sketches.flatMap(sketch => sketch.features)).toHaveLength(2);
  await expect(statusFileName(page)).not.toHaveText(/\*$/u);
  page.on('dialog', recordUnexpected);
  await page.reload(); await waitForStartupHealth(page, info);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
