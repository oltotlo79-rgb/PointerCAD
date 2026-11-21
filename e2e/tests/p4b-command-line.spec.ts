/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors } from './runtimeErrors.js';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**コマンドライン入力**(FR-208)を
 * 実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * 期待値の出どころ: `docs/plans/P4b-スケッチの仕上げ.md` 「### タスク17」「### タスク18」の
 * 検証表と「### タスク23」の (b)、`docs/報告記録.md` 2026-09-05 00:55 の追記(タスク18 完了の実測)。
 *
 * 補助関数は既存の E2E(`sketch-extended.spec.ts`)と同じ作りで、共有ファイルを作らずここへ
 * 書き写す。選択子は role / aria / class で引く。**ヘッドレスで実行する。**
 */

async function acceptConfirms(page: Page): Promise<void> {
  // 画面の中の確認(NFR-UX-3。ブラウザー標準の confirm から置き換えた)は、次の操作・確かめの前に答える。
  await page.addLocatorHandler(page.getByRole('alertdialog', { name: '保存していない変更があります' }), async (dialog) => {
    await dialog.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  });
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

/**
 * プロパティの座標の組(「始点」「終点」)。コマンドラインで相対 (@dx,dy) や極 (@距離<角度) を
 * 打つと、欄はその指定方法のまま(ΔX/ΔY や距離/角度)で出る(FR-202「式は文字列のまま保存」)。
 * モードの切替は既定値へ戻す作りなので、確かめるときは打ったとおりの指定方法で読む。
 */
function coordinateGroup(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-coordinate')
    .filter({ has: page.locator('.pcad-coordinate__title', { hasText: new RegExp(`^${label}$`) }) });
}

function coordinateFields(page: Page, label: string): Locator {
  return coordinateGroup(page, label).locator('.pcad-coordinate__fields input.pcad-field__input');
}

/** ポップアップが開いていれば Esc で閉じる(ポップアップ自身の欄へ Esc を送る)。 */
async function cancelPopoverIfOpen(page: Page): Promise<void> {
  const popoverInput = page.locator('.pcad-popover input.pcad-field__input').first();
  if ((await popoverInput.count()) === 0) {
    return;
  }
  await popoverInput.press('Escape');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
}

function fileAction(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name: label, exact: true });
}

/** コマンドラインの欄(`CommandLine.tsx`)。ステータスバーの左に 1 つだけある。 */
function commandLineInput(page: Page): Locator {
  return page.locator('#pcad-command-line-input');
}

/** 打って Enter(§0.a-0.9 の 3 つの行き先を経由する、マウス操作なし)。 */
async function typeCommand(page: Page, text: string): Promise<void> {
  const input = commandLineInput(page);
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

/** 「プロパティ」「パラメータ」のタブを切り替える(FR-207、タスク11)。 */
async function openParametersTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
}

async function openPropertiesTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
}

function parameterRow(page: Page, index: number): Locator {
  return propertyPanel(page).locator('.pcad-parameter').nth(index);
}

function parameterField(row: Locator, which: 'name' | 'source' | 'description'): Locator {
  const index = which === 'name' ? 0 : which === 'source' ? 1 : 2;
  return row.locator('.pcad-field').nth(index).locator('input');
}

async function addParameterRow(page: Page): Promise<void> {
  await propertyPanel(page)
    .getByRole('button', { name: '名前を付けた数値を足します', exact: true })
    .click();
}

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

test.describe('P4b コマンドライン入力(FR-208)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('L → 0,0 → @40,0 → @30<90 → Esc で L 字の線分 2 本ができる(マウスに触れない)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await typeCommand(page, 'L');
    await expect(page.locator('.pcad-popover__title')).toHaveText('線分の始点');

    await typeCommand(page, '0,0');
    await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');

    await typeCommand(page, '@40,0');
    // 連続描画(FR-307)なので、1 本目ができて次の線分の終点をすぐ聞かれる。
    await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');
    await expect(treeRow(page, '線分1')).toBeVisible();

    await typeCommand(page, '@30<90');
    await expect(treeRow(page, '線分2')).toBeVisible();

    // 3 本目の終点を聞く段が開いたままなので、ポップアップ自身へ Esc を送って閉じる。
    await cancelPopoverIfOpen(page);

    /*
     * 欄は打った指定方法のまま出る(FR-202「式は文字列のまま保存」)。
     * モード(絶対/相対/極)を切り替えると値は既定へ戻る(型を合わせてから入れる作り)ので、
     * 世界座標の代わりに、打ったとおりの指定(相対のΔ・極の距離と角度)で確かめる。
     */
    // 1 本目: 始点(0,0,0)は絶対のまま。終点は「@40,0」= 相対(ΔX=40, ΔY=0)。
    await treeRow(page, '線分1').click();
    await expect(coordinateFields(page, '始点').nth(0)).toHaveValue('0');
    await expect(coordinateFields(page, '始点').nth(1)).toHaveValue('0');
    await expect(coordinateFields(page, '終点').nth(0)).toHaveValue('40');
    await expect(coordinateFields(page, '終点').nth(1)).toHaveValue('0');

    // 2 本目: 終点は「@30<90」= 極(距離30, 角度90)。これで世界座標 (40,30,0) になる。
    await treeRow(page, '線分2').click();
    await expect(coordinateFields(page, '終点').nth(0)).toHaveValue('30');
    await expect(coordinateFields(page, '終点').nth(1)).toHaveValue('90');

    expect(errors).toEqual([]);
  });

  test('知らない道具名は断られ候補が出て、Tab で候補の語が入る', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 「LL」は道具として見つからず、断りと「もしかして: l」が帯に出る(FR-204 と同じ流儀)。
    await typeCommand(page, 'LL');
    await expect(statusText(page)).toContainText('そのような道具はありません');
    await expect(statusText(page)).toContainText('もしかして');
    await expect(statusText(page)).toContainText('l');

    // 2) 打っている途中は欄の上に候補が出る(最大 5 件)。「circulararray」(円形配列)も
    //    前方一致するので、「circle」だけに絞れる「circl」で試す。
    const input = commandLineInput(page);
    await input.fill('circl');
    const suggestions = page.locator('.pcad-commandline__suggestions');
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('option')).toHaveCount(1);

    // 3) Tab で 1 件目の語が欄へ入る(打ちかけと同じ書き方の語を優先する、FR-208)。
    await input.press('Tab');
    await expect(input).toHaveValue('circle');

    // 打ちかけを Esc で消し、道具を作らずに終える。
    await input.press('Escape');
    await expect(input).toHaveValue('');

    expect(errors).toEqual([]);
  });

  test('新規で開き直すと欄が空になる(書きかけの文字を持ち越さない)', async ({ page }) => {
    const errors = collectErrors(page);
    await acceptConfirms(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    const input = commandLineInput(page);
    await input.click();
    await input.fill('abc');
    await expect(input).toHaveValue('abc');

    // Enter を押さないまま「新規」を押す(NFR-UX-3 の確認は自動で「はい」)。
    await fileAction(page, '新規').click();
    await expect(featureTree(page)).toContainText('まだ何もありません。');
    await expect(input).toHaveValue('');

    expect(errors).toEqual([]);
  });

  test('パラメータ表の名前を使った座標をコマンドラインで置ける(FR-208・FR-207)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 板厚 = 3 を足す。
    await openParametersTab(page);
    await addParameterRow(page);
    const row = parameterRow(page, 0);
    await commitParameterField(row, 'name', '板厚');
    await commitParameterField(row, 'source', '3');
    await openPropertiesTab(page);

    // L → 板厚*2,0(= 6,0)→ @10,0 → Esc。
    await typeCommand(page, 'L');
    await expect(page.locator('.pcad-popover__title')).toHaveText('線分の始点');
    await typeCommand(page, '板厚*2,0');
    await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');
    await typeCommand(page, '@10,0');
    await expect(treeRow(page, '線分1')).toBeVisible();
    await cancelPopoverIfOpen(page);

    await treeRow(page, '線分1').click();
    await expect(coordinateFields(page, '始点').nth(0)).toHaveValue('6');
    await expect(coordinateFields(page, '始点').nth(1)).toHaveValue('0');
    // 終点は「@10,0」= 相対(ΔX=10, ΔY=0)。始点(6,0)+ΔX=10 で世界座標は (16,0)。
    await expect(coordinateFields(page, '終点').nth(0)).toHaveValue('10');
    await expect(coordinateFields(page, '終点').nth(1)).toHaveValue('0');

    expect(errors).toEqual([]);
  });

  test('立体の語と選びの語だけで、箱と円柱の和を作る(box → cyl → sel all → uni。マウスに触れない)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await typeCommand(page, 'box');
    await expect(page.locator('.pcad-popover__title')).toHaveText('箱を置く');
    await typeCommand(page, '');
    await expect(treeRow(page, '箱1')).toBeVisible();
    await typeCommand(page, 'cyl');
    await typeCommand(page, '');
    await expect(treeRow(page, '円柱1')).toBeVisible();

    await typeCommand(page, 'sel all');
    await expect(commandLineInput(page)).toHaveValue('');
    await typeCommand(page, 'uni');
    await expect(treeRow(page, '和1')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('座標の表を貼ると点を 1 回で作り、Ctrl+Z 1 回で全部戻る', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // クリップボードの許可に頼らず、貼り付けの出来事を欄へ直接送る(改行を含む貼り付けだけが表として扱われる)。
    // Firefox は作った出来事の clipboardData に、渡した DataTransfer を使わない。出来事そのものに持たせて、
    // 製品が読む event.clipboardData.getData('text/plain')(CommandLine.tsx の onPaste)を両方のブラウザで同じにする。
    await commandLineInput(page).evaluate((input, source) => {
      const data = new DataTransfer();
      data.setData('text/plain', source);
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: data });
      input.dispatchEvent(paste);
    }, ['x,y', '0,0', '10,0', '10,10'].join(String.fromCharCode(10)));
    await expect(page.getByRole('status').filter({ hasText: '表から 3 個の要素を作りました。' })).toBeVisible();
    for (const name of ['点1', '点2', '点3']) await expect(treeRow(page, name)).toBeVisible();

    // 貼った後、欄は 3D の表示へ焦点を移す(CommandLine.tsx の requestViewportFocus)。待たずに、3D の表示へ焦点を当ててから元に戻す。
    await page.locator('canvas.pcad-viewport__canvas').focus();
    await page.keyboard.press('Control+z');
    for (const name of ['点1', '点2', '点3']) await expect(treeRow(page, name)).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
