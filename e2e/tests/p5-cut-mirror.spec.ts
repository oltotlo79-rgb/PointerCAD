/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 平面による切断(FR-432)とミラー(FR-419)を、ヘッドレスで通しで確かめる
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27f・52)。
 *
 * ここで押さえるのは 4 つ。
 *
 * 1. 立体を選んで「切断」を押すだけで、作図面(XY)で切れて体積が半分になる(NFR-UX-4)。
 * 2. **「反対側も残す」で 2 つのボディに分かれ、合計が元の体積へ戻る**(§0.a-0.58)。
 * 3. **プロパティの「切る面」の欄(距離)を書き換えると形が変わる**(FR-502)。
 * 4. ミラーは**元を消さずに**鏡像をもう 1 つ作る(§0.a-0.36)。
 *
 * 補助関数は `e2e/tests/p5-primitive-pick.spec.ts` と同じ作りで、共有ファイルを作らず
 * ここへ書き写す(P1 からの作りに合わせる)。選択子は `data-testid` を足さず
 * role / aria / class で引く。**ビューポートを 1 度も押さない**ので、当たり判定の
 * 画素計算は要らない(立体はモデルブラウザの行から選ぶ)。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** 既定の箱の 1 辺(`packages/model/src/part/createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
/** 既定の箱の体積。中心が原点なので各軸 −10〜+10 に広がる。 */
const BOX_VOLUME = BOX_SIZE_MM ** 3;
/** XY 面(z = 0)で切ったときに残る半分。20 × 20 × 10。 */
const HALF_VOLUME = BOX_VOLUME / 2;
/** 切る面を z = 5 へずらしたときに残る量。20 × 20 × 5。 */
const QUARTER_VOLUME = BOX_SIZE_MM * BOX_SIZE_MM * 5;
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';

/** コンソールのエラーとページの例外を集める。最後に 0 件であることを確かめる。 */
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

/**
 * File System Access API を無いことにしてから頁を開く。
 * ヘッドレスでは窓を出せないので、ダウンロードとファイル選択の代替経路へ落とす。
 */
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

/** ツールバーの畳んだ一覧(「作る」「合わせる」「加工」)の引き金。 */
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

/** 開いた一覧の中の道具。 */
function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

/** その場数値入力のポップアップ。開いていないときは 0 件になる。 */
function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/**
 * ポップアップを決定する。**欄を 1 つも持たない段**(ミラー・切断の既定)があるので、
 * Enter ではなく「決定」のボタンを押す(欄が無いと Enter を押す先が無いため)。
 */
async function commitPopover(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
}

/** ポップアップの入切のつまみ。 */
function popoverToggle(page: Page, label: string): Locator {
  return popover(page).getByRole('switch', { name: label, exact: true });
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** 「ソリッド」節の中の立体の行。 */
function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/** プロパティの「鍵と値」の値の側。 */
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

function propertyFieldBox(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) });
}

function propertyField(page: Page, label: string): Locator {
  return propertyFieldBox(page, label).locator('input.pcad-field__input');
}

/** プロパティの入切のつまみ。 */
function propertyToggle(page: Page, label: string): Locator {
  return propertyPanel(page).getByRole('switch', { name: label, exact: true });
}

/** その行を選び、体積がその値になるまで待つ。 */
async function expectVolume(page: Page, rowName: string, volume: number): Promise<void> {
  await solidRow(page, rowName).click();
  await expect(propertyValue(page, '体積')).toHaveText(`${String(volume)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
}

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置く(FR-429、NFR-UX-4)。 */
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await expect(popoverInputs(page).nth(0)).toHaveValue(String(BOX_SIZE_MM));
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toHaveCount(0);
  await expect(solidRow(page, '箱1')).toBeVisible();
  // 幾何カーネルが箱を作り終えるまで待つ。
  await expectVolume(page, '箱1', BOX_VOLUME);
}

test.describe('P5 平面による切断とミラー', () => {
  // 窓の大きさは他の P5 の検査と同じ 1440×900 に固定する(ツールバーが 1 段に収まる)。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('立体を選んで「切断」を押すと、作図面で切れて体積が半分になる(FR-432、NFR-UX-4)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    // 箱を選んだまま「加工」の一覧から「切断」を押す。平面の材料を何も選んでいないので
    // 作図面(XY)へ後退する(NFR-UX-4「Enter 連打で意味のある結果」)。
    await openToolMenu(page, '加工');
    await menuTool(page, '加工', '切断').click();
    await expect(popoverTitle(page)).toHaveText('切る面');
    await commitPopover(page);

    await expect(solidRow(page, '切断1')).toBeVisible();
    await expectVolume(page, '切断1', HALF_VOLUME);

    // 元の箱は切断に取り込まれて単独では出なくなる(§0.a-0.5)。
    await solidRow(page, '箱1').click();
    await expect(propertyValue(page, '体積')).toHaveText('統合済み');

    expect(errors).toEqual([]);
  });

  test('「反対側も残す」で 2 つのボディに分かれ、合計が元の体積へ戻る(§0.a-0.58)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    await openToolMenu(page, '加工');
    await menuTool(page, '加工', '切断').click();
    await expect(popoverTitle(page)).toHaveText('切る面');
    await popoverToggle(page, '反対側も残す(2 つに分ける)').click();
    await commitPopover(page);

    // 木に「切断1」「切断2」が並び、どちらも生きたボディとして残る。
    await expect(solidRow(page, '切断1')).toBeVisible();
    await expect(solidRow(page, '切断2')).toBeVisible();
    await expectVolume(page, '切断1', HALF_VOLUME);
    await expectVolume(page, '切断2', HALF_VOLUME);

    // 2 つ目には対の相手への案内が出る(タスク27f)。
    await expect(propertyValue(page, '対になっている切断')).toHaveText('切断1');

    expect(errors).toEqual([]);
  });

  test('プロパティの「切る面」の距離を書き換えると形が変わる(FR-502)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    await openToolMenu(page, '加工');
    await menuTool(page, '加工', '切断').click();
    await commitPopover(page);
    await expectVolume(page, '切断1', HALF_VOLUME);

    // 切る面の決め方は読み取り専用で出る(選び直しは「選び直す」のボタン)。
    await expect(propertyValue(page, '切る面の決め方')).toHaveText('作図面からずらす');
    await expect(propertyValue(page, '残す側')).toHaveText('面の表側');

    // 距離を 5 にすると、残るのは z = 5〜10 の 20 × 20 × 5。
    await propertyField(page, '距離').fill('5');
    await expect(propertyValue(page, '体積')).toHaveText(
      `${String(QUARTER_VOLUME)} ${VOLUME_UNIT}`,
      { timeout: KERNEL_TIMEOUT_MS },
    );

    // 「反対側を残す」を入れると、残るのは z = −10〜5 の 20 × 20 × 15。
    await propertyToggle(page, '反対側を残す').click();
    await expect(propertyValue(page, '体積')).toHaveText(
      `${String(BOX_VOLUME - QUARTER_VOLUME)} ${VOLUME_UNIT}`,
      { timeout: KERNEL_TIMEOUT_MS },
    );
    await expect(propertyValue(page, '残す側')).toHaveText('面の裏側');

    expect(errors).toEqual([]);
  });

  test('ミラーは元を消さずに鏡像をもう 1 つ作る(FR-419、§0.a-0.36)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    await openToolMenu(page, '作る');
    await menuTool(page, '作る', 'ミラー').click();
    await expect(popoverTitle(page)).toHaveText('面の向こうへ映す');
    await commitPopover(page);

    await expect(solidRow(page, 'ミラー1')).toBeVisible();
    // 鏡像の体積は元と同じで、**元の箱も生きたまま**(統合済みにならない)。
    await expectVolume(page, 'ミラー1', BOX_VOLUME);
    await expectVolume(page, '箱1', BOX_VOLUME);

    expect(errors).toEqual([]);
  });
});
