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

declare global {
  interface Window {
    /**
     * **検査専用**。再計算の様子を読む(`packages/ui/src/app/PointerCadApp.tsx` が
     * 差し出す口。アプリ自身はこれを 1 か所も呼ばない)。頁が載る前は `undefined`。
     */
    pcadRecomputeStats?: () => { readonly cacheHits: number; readonly isComputing: boolean };
  }
}

/**
 * 再計算が終わるのを待つ。**体積を確かめる前に必ずこれを通す。**
 *
 * 分ける理由は、落ちたときに原因が読めるようにするため(push #14 の赤 3 本、
 * docs/報告記録.md 2026-09-06 12:04)。体積だけを待つと「50MB の WASM の読み込みが
 * 間に合わなかった」のか「計算そのものが壊れて違う値になった」のかがログで区別できない。
 * ここで落ちれば前者、ここを通ってから体積で落ちれば後者と言い切れる。
 *
 * **待ちの上限(KERNEL_TIMEOUT_MS)は体積の待ちと同じで、緩めていない。**
 */
async function waitForRecompute(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const read = window.pcadRecomputeStats;
          if (read === undefined) {
            return '頁がまだ載っていません';
          }
          return read().isComputing ? '計算中' : '計算は終わっています';
        }),
      {
        timeout: KERNEL_TIMEOUT_MS,
        message: '幾何カーネルの再計算が終わること(初回は 50MB の WASM の読み込みを含む)',
      },
    )
    .toBe('計算は終わっています');
}

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

/** 確認の窓(`window.confirm`)に「はい」で答える(「新規」で出る)。 */
function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => {
    void dialog.accept();
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

/** ツールバーの「ファイル」区画のボタン(新規・開く・保存)。 */
function fileAction(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ファイル' })
    .getByRole('button', { name: label, exact: true });
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/** 外観の節の選択肢(材質など)の枠。見出しの語で 1 つに絞る。 */
function appearanceChoice(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: new RegExp(`^${label}$`) }) });
}

/** いま選ばれている選択肢の読み(引き金に出ている語)。 */
function appearanceChoiceValue(page: Page, label: string): Locator {
  return appearanceChoice(page, label).locator('.pcad-menu__count');
}

/** 選択肢を開いて 1 つ選ぶ。 */
async function chooseAppearance(page: Page, label: string, option: string): Promise<void> {
  const choice = appearanceChoice(page, label);
  await choice.locator('.pcad-menu__trigger').click();
  await choice.getByRole('menuitem', { name: option, exact: true }).click();
  await expect(appearanceChoiceValue(page, label)).toHaveText(option);
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

/** その行を選び、計算が終わるのを待ってから、体積がその値になるまで待つ。 */
async function expectVolume(page: Page, rowName: string, volume: number): Promise<void> {
  await solidRow(page, rowName).click();
  await waitForRecompute(page);
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

/** 「作る」の一覧から基本形状を既定のまま置く(箱以外にも使う)。 */
async function placePrimitive(page: Page, label: string, title: string): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', label).click();
  await expect(popoverTitle(page)).toHaveText(title);
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toHaveCount(0);
}

/**
 * 「新規」を押して空の部品からやり直す(FR-806)。**頁は読み込み直さない**ので、
 * カーネルの Worker も、入口(`PointerCadApp`)が持っている覚え書きもそのまま残る。
 * この検査が見張っているのはまさにそこ(下の回帰の注釈)。
 */
async function newDocument(page: Page): Promise<void> {
  await fileAction(page, '新規').click();
  await expect(featureTree(page)).toContainText('まだ何もありません。');
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
    await waitForRecompute(page);
    await expect(propertyValue(page, '体積')).toHaveText(
      `${String(QUARTER_VOLUME)} ${VOLUME_UNIT}`,
      { timeout: KERNEL_TIMEOUT_MS },
    );

    // 「反対側を残す」を入れると、残るのは z = −10〜5 の 20 × 20 × 15。
    await propertyToggle(page, '反対側を残す').click();
    await waitForRecompute(page);
    await expect(propertyValue(page, '体積')).toHaveText(
      `${String(BOX_VOLUME - QUARTER_VOLUME)} ${VOLUME_UNIT}`,
      { timeout: KERNEL_TIMEOUT_MS },
    );
    await expect(propertyValue(page, '残す側')).toHaveText('面の裏側');

    expect(errors).toEqual([]);
  });

  test('操作を重ねて「新規」を 3 回挟んだ後でも、箱の切断が成功する(§5.2 の目視の回帰)', async ({
    page,
  }) => {
    /*
     * 2026-09-06 の目視で「多くの操作を重ねた**同じ頁**で『新規』の後に切断が
     * 『立体を切れませんでした』で失敗し、頁を読み込み直すと回復する」が実測された
     * (docs/報告記録.md、scratchpad/shots/p5-visual/00-notes.txt)。
     *
     * 頁を読み込み直さない限り消えない状態が、入口(`PointerCadApp`)が 1 度だけ作る
     * 3 つの覚え書き(オフセット・投影・部分形状の選び直し)だった。フィーチャーの id は
     * 文書ごとに 1 から振り直されるので、前の文書の参照を抱えたままだと**別物の同じ id の
     * ボディ**へ照合し直してしまう(`subShapeCache.ts` の `clear` の注釈)。
     *
     * ここでは目視の操作列(外観 → 新規 → 基本形状 → 新規 → 測定 → 新規 → 箱 → 切断)を
     * 短くたどり、**最後の切断が半分の体積になる**ことだけを見る。頁は 1 度しか開かない。
     */
    const errors = collectErrors(page);
    acceptConfirms(page);
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 外観。立体を選んだまま材質を変える(形は変わらない、FR-1106)。
    await placeBox(page);
    await chooseAppearance(page, '材質', 'アルミ');

    // 2) 新規 #1 → 基本形状を 2 種。
    await newDocument(page);
    await placePrimitive(page, '球', '球を置く');
    await expect(solidRow(page, '球1')).toBeVisible();
    await placePrimitive(page, '円柱', '円柱を置く');
    await expect(solidRow(page, '円柱1')).toBeVisible();
    // 体積が出るまで待って、カーネルが 2 つとも作り終えたことを確かめる。
    await waitForRecompute(page);
    await expect(propertyValue(page, '体積')).toHaveText(new RegExp(`${VOLUME_UNIT}$`), {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 3) 新規 #2 → 測定(FR-1101、FR-1102)。立体を選んで「測る」を押すと体積と重さが出る。
    await newDocument(page);
    await placeBox(page);
    await openToolMenu(page, '見た目');
    await menuTool(page, '見た目', '測る').click();
    await expect(propertyValue(page, '結果')).not.toHaveText('まだ測っていません', {
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 4) 新規 #3 → 箱を置いて、切る面を 1 つも選ばずに既定(作図面・距離 0)のまま切断する。
    await newDocument(page);
    await placeBox(page);
    await openToolMenu(page, '加工');
    await menuTool(page, '加工', '切断').click();
    await expect(popoverTitle(page)).toHaveText('切る面');
    await commitPopover(page);

    // ここが本題。失敗する版では「立体を切れませんでした。」が出て体積が出なかった。
    await expect(solidRow(page, '切断1')).toBeVisible();
    await expectVolume(page, '切断1', HALF_VOLUME);

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
