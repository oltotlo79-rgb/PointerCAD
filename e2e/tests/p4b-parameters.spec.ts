/// <reference lib="dom" />
import { statSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**パラメータ表**(FR-207、FR-201、FR-502)を
 * 実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * 期待値の出どころ: `docs/plans/P4b-スケッチの仕上げ.md` 「### タスク11」の検証表と
 * 「### タスク23」の (c)、`docs/報告記録.md` 2026-09-05 01:40 の追記(タスク11 完了の実測)。
 *
 * 補助関数は既存の E2E(`sketch-extended.spec.ts` / `solid.spec.ts`)と同じ作りで、
 * 共有ファイルを作らずここへ書き写す(P1〜P3 の作りに合わせる)。選択子は `data-testid` を
 * 足さず role / aria / class で引く。**ヘッドレスで実行する。**
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/* ========================================================================== *
 * 補助関数(sketch-extended.spec.ts と同じ作り)
 * ========================================================================== */

function collectErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}

async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
  });
}

function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

function fileAction(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name: label, exact: true });
}

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source === null) {
      continue;
    }
    await inputs.nth(index).fill(source);
  }
}

async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Enter');
    return;
  }
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
}

async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  } else {
    await page.locator('canvas.pcad-viewport__canvas').press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}

async function useAbsolute(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '絶対', exact: true }).first().click();
}

async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

async function drawRectangle(
  page: Page,
  corner1: readonly [string, string],
  corner2: readonly [string, string],
): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1], '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await useAbsolute(page);
  await fillFields(page, [corner2[0], corner2[1], '0']);
  await commitPopover(page);
  await cancelPopover(page);
}

async function makeFace(page: Page, elementNames: readonly string[]): Promise<void> {
  await treeRow(page, elementNames[0]).click();
  for (const name of elementNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

/** 面を 1 枚選んで押し出す。距離の式は好きな文字列を渡せる(FR-207 の変数を含めてよい)。 */
async function extrudeFace(page: Page, faceName: string, distanceSource: string): Promise<void> {
  await treeRow(page, faceName).click();
  /*
    P5 タスク51 で「押し出し」は「作る」の畳んだ一覧の中へ移った(§0.a-0.51)。
    検査の中身は変えず、道具に届くまでに一覧を開く手順が 1 つ増えただけ。
  */
  await page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: /^作る/ })
    .first()
    .click();
  await page.getByRole('group', { name: 'ソリッド' }).getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, [distanceSource]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
}

async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

/* ========================================================================== *
 * パラメータ表(プロパティ区画の「パラメータ」タブ)の補助関数
 * ========================================================================== */

/** 「プロパティ」「パラメータ」のタブを切り替える。 */
async function openParametersTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
}

async function openPropertiesTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
}

/** パラメータ表の行(0 始まりの表示順)。 */
function parameterRow(page: Page, index: number): Locator {
  return propertyPanel(page).locator('.pcad-parameter').nth(index);
}

/** 行の中の 3 つの式欄(名前・式・説明。単位は別の並び)。 */
function parameterField(row: Locator, which: 'name' | 'source' | 'description'): Locator {
  const index = which === 'name' ? 0 : which === 'source' ? 1 : 2;
  return row.locator('.pcad-field').nth(index).locator('input');
}

/** 行の下に出るメッセージ(値・断り)。 */
function parameterFieldMessage(row: Locator, which: 'name' | 'source' | 'description'): Locator {
  const index = which === 'name' ? 0 : which === 'source' ? 1 : 2;
  return row.locator('.pcad-field').nth(index).locator('.pcad-field__message');
}

/** 「+」で 1 行足す。 */
async function addParameterRow(page: Page): Promise<void> {
  await propertyPanel(page)
    .getByRole('button', { name: '名前を付けた数値を足します', exact: true })
    .click();
}

/** 行の「×」で消す。 */
async function removeParameterRow(row: Locator): Promise<void> {
  await row.getByRole('button', { name: 'この名前を消します', exact: true }).click();
}

/** 式欄・名前欄を打ち替えて Enter で確定する。 */
async function commitParameterField(
  row: Locator,
  which: 'name' | 'source' | 'description',
  value: string,
): Promise<void> {
  const input = parameterField(row, which);
  await input.fill(value);
  await input.press('Enter');
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4b パラメータ表(FR-207・FR-201・FR-502)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('板厚 = 3 を足すと押し出しの距離が追従し、改名でも式が追従して Undo で戻る', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) パラメータ表に「板厚 = 3」を足す(表の下の「+」→ 名前 → 式)。
    await openParametersTab(page);
    await expect(propertyPanel(page)).toContainText('名前を付けた数値はまだありません。');
    await addParameterRow(page);
    const row = parameterRow(page, 0);
    await expect(row).toBeVisible();
    await commitParameterField(row, 'name', '板厚');
    await commitParameterField(row, 'source', '3');
    await expect(parameterFieldMessage(row, 'source')).toHaveText('= 3');

    // 2) 40 × 30 の矩形を押し出す。距離はその場入力から「板厚 * 2」と打つ(= 6)。
    await openPropertiesTab(page);
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['矩形1']);
    await extrudeFace(page, '面1', '板厚 * 2');
    await treeRow(page, '押し出し1').click();
    await expect(propertyField(page, '距離')).toHaveValue('板厚 * 2');
    await expectVolume(page, 40 * 30 * 6);

    // 3) 表の板厚を 5 に変えると、押し出しの体積が 40×30×10 = 12000 へ追従する(FR-502)。
    await openParametersTab(page);
    await commitParameterField(row, 'source', '5');
    await expect(parameterFieldMessage(row, 'source')).toHaveText('= 5');
    await openPropertiesTab(page);
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 10);

    // 4) 「板厚」を「板の厚み」へ改名すると、押し出しの式が追従し、値は 10 のまま。
    await openParametersTab(page);
    await commitParameterField(row, 'name', '板の厚み');
    await openPropertiesTab(page);
    await treeRow(page, '押し出し1').click();
    await expect(propertyField(page, '距離')).toHaveValue('板の厚み * 2');
    await expectVolume(page, 40 * 30 * 10);

    // 5) Undo 1 回で改名だけが戻る(式は「板厚 * 2」、値は 10 のまま)。
    await page.keyboard.press('Control+z');
    await expect(propertyField(page, '距離')).toHaveValue('板厚 * 2');
    await expectVolume(page, 40 * 30 * 10);
    await openParametersTab(page);
    await expect(parameterField(parameterRow(page, 0), 'name')).toHaveValue('板厚');

    expect(errors).toEqual([]);
  });

  test('重複名は断られ、参照が残る名前は削除を断られる', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await openParametersTab(page);

    // 1) 板厚 = 3 を足す。
    await addParameterRow(page);
    const first = parameterRow(page, 0);
    await commitParameterField(first, 'name', '板厚');
    await commitParameterField(first, 'source', '3');

    // 2) もう 1 行足し、同じ名前「板厚」へ改名しようとすると断られる。
    await addParameterRow(page);
    const second = parameterRow(page, 1);
    await commitParameterField(second, 'name', '板厚');
    await expect(parameterFieldMessage(second, 'name')).toHaveText('その名前はすでにあります。');
    // 断られたので 2 行目はまだ既定の名前のまま(値は表に反映されていない)。
    await expect(parameterField(second, 'name')).toHaveValue('板厚');

    // 3) 2 行目を別名にしてから、押し出しの距離で「板厚」を使う。
    await commitParameterField(second, 'name', '板厚2');
    await openPropertiesTab(page);
    await drawRectangle(page, ['0', '0'], ['10', '10']);
    await makeFace(page, ['矩形1']);
    await extrudeFace(page, '面1', '板厚');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 10 * 10 * 3);

    /*
      4) 使われている「板厚」を消そうとすると断られる。**参照元のフィーチャー名が入る**
      (P4b タスク22b-(f)。件数だけでは利用者がどこを直せばよいか分からなかった、
      `docs/報告記録.md` 2026-09-05 実時計 01:05・01:40 の申し送り)。
    */
    await openParametersTab(page);
    await removeParameterRow(first);
    await expect(parameterFieldMessage(first, 'name')).toHaveText(
      'この名前は 押し出し1 から使われています。先にそちらを直してください。',
    );
    // 断られたので行は消えていない。
    await expect(propertyPanel(page).locator('.pcad-parameter')).toHaveCount(2);

    expect(errors).toEqual([]);
  });

  test('保存して開き直すとパラメータ表が残り、式のまま再編集できる', async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    acceptConfirms(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 板厚 = 3、押し出しの距離を「板厚 * 2」にする。
    await openParametersTab(page);
    await addParameterRow(page);
    const row = parameterRow(page, 0);
    await commitParameterField(row, 'name', '板厚');
    await commitParameterField(row, 'source', '3');

    await openPropertiesTab(page);
    await drawRectangle(page, ['0', '0'], ['40', '30']);
    await makeFace(page, ['矩形1']);
    await extrudeFace(page, '面1', '板厚 * 2');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 6);

    // 2) 保存 → 新規 → 開き直し。
    const downloadPromise = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    const download = await downloadPromise;
    const savedPath = testInfo.outputPath('p4b-parameters.pcad');
    await download.saveAs(savedPath);
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await expect(statusText(page)).toHaveText('保存しました');

    await fileAction(page, '新規').click();
    await expect(featureTree(page)).toContainText('まだ何もありません。');

    const chooserPromise = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    await (await chooserPromise).setFiles(savedPath);

    // 3) パラメータ表が残り、式のまま再編集できる。
    await expect(treeRow(page, '押し出し1')).toBeVisible();
    await openParametersTab(page);
    const reopened = parameterRow(page, 0);
    await expect(parameterField(reopened, 'name')).toHaveValue('板厚');
    await expect(parameterField(reopened, 'source')).toHaveValue('3');
    await commitParameterField(reopened, 'source', '7');

    await openPropertiesTab(page);
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 40 * 30 * 14);

    expect(errors).toEqual([]);
  });
});
