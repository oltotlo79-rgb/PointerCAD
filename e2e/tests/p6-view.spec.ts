/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

import { KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

/**
 * P6(入出力)の完了条件のうち、**見え方とひな形**を実際のブラウザで通しで確かめる
 * (要件 `docs/requirements.md` §9 P6、計画書 `docs/plans/P6-入出力.md` §0.59、タスク44)。
 *
 * ここで固定するのは §0.59 の (f)(g) と、タスク43b からの申し送り 2 件:
 *  - (f) 断面表示を入れる → **見え方が変わって中が見える** → **体積が変わらない**(形は切らない)
 *  - (g) ひな形として保存 → ひな形から新規 → **パラメータ表が入っている**
 *  - 追加 1: 選択セットは**空の名前を断り**、名前を付ければ**組の行が「1 件」で出る**
 *  - 追加 2: 書き出しのパネルで STL を選ぶと**「STL には色が付きません。」の 1 行**が出る
 *
 * 補助関数は既存の E2E(`p4b-parameters.spec.ts` / `p5-primitive-pick.spec.ts`)と同じ作りで
 * 書き写す(P1 からの作りに合わせる)。**再計算の待ちだけは共有の `recompute.ts` を使う。**
 * 選択子は `data-testid` を足さず role / aria / class で引く。**ヘッドレスで実行する。**
 */

/** 既定の箱の 1 辺(`packages/model/src/part/createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
const BOX_VOLUME = BOX_SIZE_MM ** 3;
const VOLUME_UNIT = 'mm³';

/* ========================================================================== *
 * 補助関数
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

/** ブラウザの確認窓(「保存していない変更を捨てますか」)に「はい」で答える(NFR-UX-3)。 */
function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}

async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });
}

function toolMenuTrigger(page: Page, menu: string): Locator {
  return page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: new RegExp(`^${menu}`) })
    .first();
}

function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}

function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

async function chooseFileMenu(page: Page, label: string): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await menuTool(page, 'ファイルのほかの操作', label).click();
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

async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  await popoverInputs(page).first().press('Enter');
}

async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function solidRows(page: Page): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child');
}

/** 「ソリッド」節を開く(畳んでいると中の行が描かれない)。 */
async function openSolidSection(page: Page): Promise<void> {
  const header = treeSection(page, 'ソリッド').locator('.pcad-tree__row--section').first();
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click();
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

function viewportCanvas(page: Page): Locator {
  return page.locator('canvas.pcad-viewport__canvas');
}

/** 「表示」の区画にある断面表示の入切ボタン(FR-111、タスク35)。 */
function sectionViewButton(page: Page): Locator {
  return page.locator('.pcad-toolbar').getByRole('button', { name: '断面表示', exact: true });
}

/** プロパティの節(見出しで引く)。 */
function propertySection(page: Page, title: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-section')
    .filter({ has: page.locator('.pcad-section__title', { hasText: new RegExp(`^${title}$`) }) });
}

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置く(FR-429)。 */
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await commitPopover(page);
  await cancelPopover(page);
  await openSolidSection(page);
  await solidRows(page).first().click();
  await waitForRecompute(page);
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
}

/** 作り直さずに済んだ段の数。**再計算が 1 度でも走れば必ず動く**(§2.3 と同じ使い方)。 */
async function readCacheHits(page: Page): Promise<number> {
  return page.evaluate(() => {
    const read = window.pcadRecomputeStats;
    return read === undefined ? -1 : read().cacheHits;
  });
}

/* パラメータ表(`p4b-parameters.spec.ts` と同じ作り)。 */

async function openParametersTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
}

function parameterRow(page: Page, index: number): Locator {
  return propertyPanel(page).locator('.pcad-parameter').nth(index);
}

function parameterField(row: Locator, which: 'name' | 'source'): Locator {
  return row.locator('.pcad-field').nth(which === 'name' ? 0 : 1).locator('input');
}

async function addParameterRow(page: Page): Promise<void> {
  await propertyPanel(page)
    .getByRole('button', { name: '名前を付けた数値を足します', exact: true })
    .click();
}

async function commitParameterField(
  row: Locator,
  which: 'name' | 'source',
  value: string,
): Promise<void> {
  const input = parameterField(row, which);
  await input.fill(value);
  await input.press('Enter');
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P6 断面表示とひな形(要件§9 P6、計画書 §0.59)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  test('(f) 断面表示を入れると中が見えるが、体積は変わらない(FR-111)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    // 切る前の見え方と、再計算の様子を控えておく。
    const before = await viewportCanvas(page).screenshot();
    const cacheHitsBefore = await readCacheHits(page);
    await expect(sectionViewButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(propertySection(page, '断面表示')).toContainText('切っていません。');

    // 断面表示を入れる。既定は今の作図面(XY)の 0 の位置なので、箱はちょうど半分で切れる。
    await sectionViewButton(page).click();
    await expect(sectionViewButton(page)).toHaveAttribute('aria-pressed', 'true');

    /*
      **見え方が変わったこと**を canvas の画素で確かめる(§0.59 の「中が見える」)。
      three.js のクリップは材質ごとの欄なので、頁の外から状態を読む口が無い。描き直しは
      次のフレームで起きるため、`expect.poll` で「前と違う絵になる」まで待つ。
    */
    await expect
      .poll(async () => (await viewportCanvas(page).screenshot()).equals(before), {
        message: '断面表示を入れるとビューポートの絵が変わること',
      })
      .toBe(false);

    // 切る面・切る位置・残す側が読める(タスク43b の節)。
    const section = propertySection(page, '断面表示');
    await expect(section).not.toContainText('切っていません。');
    await expect(propertyValue(page, '切る位置')).toHaveText('0 mm');

    /*
      **形は切らない**(FR-111)。体積は 1 文字も変わらず、再計算そのものが走っていない
      (`cacheHits` が動いていない = 段を 1 つも作り直していない。§2.14 の表)。
    */
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`);
    expect(await readCacheHits(page)).toBe(cacheHitsBefore);

    // やめると元の見た目に戻る。
    await sectionViewButton(page).click();
    await expect(sectionViewButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(propertySection(page, '断面表示')).toContainText('切っていません。');
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`);

    expect(errors).toEqual([]);
  });

  test('(g) ひな形として保存してひな形から新規で始めると、パラメータ表が入っている(FR-814)', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    acceptConfirms(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) パラメータ表に「板厚 = 3」を足す。
    await openParametersTab(page);
    await addParameterRow(page);
    const row = parameterRow(page, 0);
    await commitParameterField(row, 'name', '板厚');
    await commitParameterField(row, 'source', '3');
    await expect(parameterField(row, 'source')).toHaveValue('3');

    // 2) ひな形として保存する(置き場へ入れたあと `.pcadt` としても落ちてくる)。
    const download = page.waitForEvent('download');
    await chooseFileMenu(page, 'ひな形として保存');
    const templatePath = testInfo.outputPath('p6-view-g.pcadt');
    await (await download).saveAs(templatePath);
    await expect(statusText(page)).toHaveText('ひな形として保存しました');

    // 3) パラメータを消してから、そのひな形で新しい部品を始める。
    await propertyPanel(page).getByRole('button', { name: 'この名前を消します', exact: true }).click();
    await expect(propertyPanel(page)).toContainText('名前を付けた数値はまだありません。');

    const chooser = page.waitForEvent('filechooser');
    await chooseFileMenu(page, 'ひな形から新規');
    await (await chooser).setFiles(templatePath);

    // 4) ひな形のパラメータ表がそのまま入っている。
    await openParametersTab(page);
    const restored = parameterRow(page, 0);
    await expect(parameterField(restored, 'name')).toHaveValue('板厚', {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await expect(parameterField(restored, 'source')).toHaveValue('3');

    expect(errors).toEqual([]);
  });

  test('選択セットは空の名前を断り、名前を付ければ組の行が出る(FR-112、タスク43b)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    const sets = propertySection(page, '選択セット');
    await expect(sets).toContainText('覚えた組はまだありません。');

    // 1) 名前を入れずに「作る」を押すと断られ、行は増えない(NFR-UX-5)。
    await sets.getByRole('button', { name: '作る', exact: true }).click();
    await expect(sets).toContainText('名前を入れてください。');
    await expect(sets).toContainText('覚えた組はまだありません。');

    // 2) 名前を付ければ、いま選んでいる立体 1 つが「1 件」の組になる。
    await sets.getByRole('textbox', { name: '名前', exact: true }).fill('外側');
    await sets.getByRole('button', { name: '作る', exact: true }).click();
    await expect(sets.locator('.pcad-constraint-row')).toHaveCount(1);
    await expect(sets).toContainText('外側');
    await expect(sets).toContainText('1 件');

    expect(errors).toEqual([]);
  });

  test('書き出しのパネルで STL を選ぶと、色が付かないことを 1 行で断る(§0.15、タスク43b)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await placeBox(page);

    await chooseFileMenu(page, '書き出す');
    const panel = page.locator('.pcad-exchange');
    await expect(panel).toBeVisible();
    // STEP のうちは色の切替が出ていて、断りの 1 行は無い。
    await expect(panel).toContainText('色を含める');
    await expect(panel).not.toContainText('STL には色が付きません。');

    await panel.getByRole('radio', { name: 'STL', exact: true }).click();
    await expect(panel).toContainText('STL には色が付きません。');
    await expect(panel).not.toContainText('色を含める');
    // 単位の案内はどちらの形式でも出る(§0.7)。
    await expect(panel).toContainText('ファイルはミリメートルで書き出します。');

    await panel.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(panel).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
