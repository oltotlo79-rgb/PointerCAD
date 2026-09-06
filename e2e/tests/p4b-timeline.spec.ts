/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**タイムライン**(FR-507、FR-506、FR-504)を
 * 実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * 期待値の出どころ: `docs/plans/P4b-スケッチの仕上げ.md` 「### タスク19」「### タスク20」の
 * 検証表、`docs/報告記録.md` 2026-09-05 01:05・01:35 の追記(タスク19・20 完了の実測)、
 * `packages/ui/src/shell/statusText.test.ts`(「R面取り1は穴1を使っているので、穴1より
 * 後ろでなければなりません。」の断り文)、`e2e/tests/solid.spec.ts` の穴・R面取りの体積
 * (φ6 貫通穴 = π·3²·10、R面取り既定半径2の縦辺 = 10·(4−π))。
 *
 * つまみの置き場は §0.a-0.18 案 B(モデルブラウザの行の左端のレール)。**行が増えると
 * 縦にあふれる**ので、「スケッチ」の節を畳んでから帯の行を操作する(タスク20 の申し送り)。
 *
 * 補助関数は既存の E2E(`solid.spec.ts`)と同じ作りで、共有ファイルを作らずここへ書き写す。
 * **ヘッドレスで実行する。**
 */

const KERNEL_TIMEOUT_MS = 60_000;

declare global {
  interface Window {
    /**
     * **検査専用**。再計算の様子を読む(`packages/ui/src/app/PointerCadApp.tsx` が
     * 差し出す口。アプリ自身はこれを 1 か所も呼ばない)。頁が載る前は `undefined`。
     */
    pcadRecomputeStats?: () => { readonly cacheHits: number; readonly isComputing: boolean };
  }
}

/* ========================================================================== *
 * 補助関数(solid.spec.ts と同じ作り)
 * ========================================================================== */

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

function sketchTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'スケッチ' }).getByRole('button', { name: label, exact: true });
}

function solidTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'ソリッド' }).getByRole('button', { name: label, exact: true });
}

function machiningTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: '加工' }).getByRole('button', { name: label, exact: true });
}

/**
 * ツールバーの畳んだ一覧(「作る」「合わせる」「加工」)を開く(P5 タスク51、§0.a-0.51)。
 *
 * ソリッドと加工の図柄ボタンは、この一覧の中へ移った(ツールバーを 1440 画素で 1 段に
 * 保つため)。**検査の中身は 1 つも変えていない**: 押せる/押せない、ツールチップの
 * 「名前: 理由」、押した結果はそのままで、道具に届くまでに一覧を開く手順が 1 つ増えただけ。
 *
 * 畳んだボタンの読み上げ名は、最後に使った道具があると「加工: 穴」のように後ろが付くので
 * 頭の一致で引く。開いた一覧そのものは、区画と同じ名前(「作る」など)の group になる。
 */
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

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
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
  /*
   * 図形の行が木に出る(= 文書に入った)時点と、その図形を面の境界に使える(= 再計算が
   * 終わって `resolved` に入った)時点は別である。矩形を描いた直後にここへ来ると、
   * Worker の往復がまだ終わっておらず「面」がその図形を知らない。落ちる場所を
   * 分けるためにも、行が見えることだけでなく**計算が終わったこと**を先に待つ。
   */
  await waitForRecompute(page);
  await treeRow(page, elementNames[0]).click();
  for (const name of elementNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

async function extrudeFace(page: Page, faceName: string, distance: string | null): Promise<void> {
  await treeRow(page, faceName).click();
  await openToolMenu(page, '作る');
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, [distance]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** 立体の行のまるごと(名前のボタン・つまみ・「⋮」を含む枠)。ソリッド節の中だけを見る。 */
function solidRowBox(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child').filter({ hasText: name });
}

/** その行のタイムラインのつまみ(FR-507)。押すとその段までロールバックする。 */
function timelineStop(page: Page, name: string): Locator {
  return solidRowBox(page, name).locator('.pcad-timeline__stop');
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
}

async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await waitForRecompute(page);
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

/** 「スケッチ」の節を畳む(行が増えると縦にあふれるため、タスク20 の申し送り)。 */
async function collapseSketchSection(page: Page): Promise<void> {
  const header = featureTree(page).locator('.pcad-tree__row--section').filter({ hasText: 'スケッチ' });
  if ((await header.getAttribute('aria-expanded')) === 'true') {
    await header.click();
  }
}

/* -------------------------------------------------------------------------- *
 * ワールド座標 → 画面の画素(solid.spec.ts の写し。視点を動かさないので成り立つ)
 * -------------------------------------------------------------------------- */

type WorldPoint = readonly [number, number, number];

// 既定(ホーム)の視点の方位角は −45°(利用者の指示 2026-09-06)。カメラは (+X, −Y, +Z) にあり、前・上・右の 3 面が見える。
const HOME_AZIMUTH = -Math.PI / 4;
const HOME_ELEVATION = Math.atan(Math.SQRT1_2);
const HOME_DISTANCE = 200;
const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;

function subtractPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dotPoints(a: WorldPoint, b: WorldPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizePoint(a: WorldPoint): WorldPoint {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

function worldToCanvas(
  world: WorldPoint,
  widthPixels: number,
  heightPixels: number,
): readonly [number, number] {
  const view = subtractPoints(world, CAMERA_EYE);
  const depth = -dotPoints(view, CAMERA_Z);
  const scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = (scale * dotPoints(view, CAMERA_X)) / (depth * (widthPixels / heightPixels));
  const ndcY = (scale * dotPoints(view, CAMERA_Y)) / depth;
  return [((ndcX + 1) / 2) * widthPixels, ((1 - ndcY) / 2) * heightPixels];
}

async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}

function topFaceCenter(thicknessMm: number): WorldPoint {
  return [20, 15, thicknessMm];
}

/** 板 40×30×10。 */
const BOARD_VOLUME = 40 * 30 * 10;
/** φ6 の貫通穴 1 つが取り除く量(π·3²·10)。 */
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 10;
/** R面取り(既定半径2)が長さ10の辺から取り除く量(10·(4−π))。 */
const FILLET_R2_ON_10MM_EDGE = 10 * (4 - Math.PI);

/**
 * 「押し出し1 → 穴1 → R面取り1」の 3 段を作る(帯 3 件)。
 * 体積: 12000 → 11717.2566612(穴) → 11708.6725877(R面取り、統括の指示書の実測値と一致)。
 */
async function buildThreeStepChain(page: Page): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['矩形1']);
  await extrudeFace(page, '面1', null);
  await treeRow(page, '押し出し1').click();
  await expectVolume(page, BOARD_VOLUME);

  // 穴の中心にする点を 1 つ打つ。
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['5', '15', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();

  // 「穴」: 上面 + 点1 を選び、直径の既定 6・貫通で決める。
  await openToolMenu(page, '加工');
  const holeButton = machiningTool(page, '穴');
  await holeButton.click({ force: true });
  await clickWorldPoint(page, topFaceCenter(10));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '穴1')).toBeVisible();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);

  // 「R面取り」: 手前の左(x = 0, y = 0)の縦の辺(長さ10)を選び、既定半径2で決める。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('2');
  await clickWorldPoint(page, [0, 0, 5]);
  await openToolMenu(page, '加工');
  await expect(machiningTool(page, 'R面取り')).toBeEnabled();
  await machiningTool(page, 'R面取り').click();
  await expect(popoverTitle(page)).toHaveText('角を丸める');
  await expect(popoverInputs(page).first()).toHaveValue('2');
  await commitPopover(page);
  await expect(treeRow(page, 'R面取り1')).toBeVisible();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH - FILLET_R2_ON_10MM_EDGE);
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4b タイムライン(FR-507・FR-506・FR-504)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('つまみを1段目へ戻すと穴が消え、末尾へ戻すと元どおりになる', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    await buildThreeStepChain(page);

    // 1) つまみを1段目(押し出し1)へ。穴・R面取りが消え、体積は 12000 のまま。
    await timelineStop(page, '押し出し1').click();
    await expect(page.locator('.pcad-statusbar__rollback')).toHaveText('途中まで戻しています(1 件目 / 3 件)');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, BOARD_VOLUME);
    // 穴1・R面取り1 の行はまだ木にあるが、つまみより後ろ(ahead)で薄く出る。
    await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--ahead/);
    await expect(solidRowBox(page, 'R面取り1')).toHaveClass(/pcad-tree__row--ahead/);

    // 2) つまみを末尾(R面取り1、もう一度押すと末尾へ戻る仕組み)へ戻す。
    await timelineStop(page, 'R面取り1').click();
    await expect(page.locator('.pcad-statusbar__rollback')).toHaveCount(0);
    await treeRow(page, 'R面取り1').click();
    await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH - FILLET_R2_ON_10MM_EDGE);
    await expect(solidRowBox(page, '穴1')).not.toHaveClass(/pcad-tree__row--ahead/);

    expect(errors).toEqual([]);
  });

  test('つまみを途中へ戻したまま作ると、その位置へ差し込まれる', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    await buildThreeStepChain(page);

    // つまみを1段目(押し出し1)へ戻す。
    await timelineStop(page, '押し出し1').click();
    await expect(page.locator('.pcad-statusbar__rollback')).toHaveText('途中まで戻しています(1 件目 / 3 件)');

    // 戻したまま、まったく独立な矩形を作って押し出す(押し出し2)。
    await drawRectangle(page, ['100', '0'], ['110', '10']);
    await makeFace(page, ['矩形2']);
    await extrudeFace(page, '面2', '5');
    await expect(treeRow(page, '押し出し2')).toBeVisible();

    // 押し出し2 は「押し出し1」の直後(つまみの位置)へ入り、穴1・R面取り1 より前に並ぶ。
    const names = await treeSection(page, 'ソリッド')
      .locator('.pcad-tree__row--child .pcad-tree__label')
      .allTextContents();
    expect(names).toEqual(['押し出し1', '押し出し2', '穴1', 'R面取り1']);

    // つまみは差し込んだ段(2番目)へ進む。穴1・R面取り1 はまだ ahead のまま。
    await expect(page.locator('.pcad-statusbar__rollback')).toHaveText('途中まで戻しています(2 件目 / 4 件)');
    await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--ahead/);
    await expect(solidRowBox(page, '押し出し2')).not.toHaveClass(/pcad-tree__row--ahead/);

    expect(errors).toEqual([]);
  });

  test('依存を壊す入れ替えは「⋮」の項目が押せず、理由が読める(順序は変わらない)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    await buildThreeStepChain(page);

    // 「穴1」を右クリックして「⋮」の一覧を開く。R面取り1 は穴1 の結果を使っているので、
    // 「1つ下へ」(R面取り1 の後ろへ)は依存を壊すため押せない。
    await treeRow(page, '穴1').click({ button: 'right' });
    const menu = page.locator('.pcad-tree__menu');
    await expect(menu).toBeVisible();
    const moveDown = menu.getByRole('menuitem', { name: '1 つ下へ', exact: true });
    await expect(moveDown).toBeDisabled();
    await expect(moveDown).toHaveAttribute(
      'title',
      'R面取り1は穴1を使っているので、穴1より後ろでなければなりません。',
    );
    await page.keyboard.press('Escape');

    // 順序は変わっていない。
    const names = await treeSection(page, 'ソリッド')
      .locator('.pcad-tree__row--child .pcad-tree__label')
      .allTextContents();
    expect(names).toEqual(['押し出し1', '穴1', 'R面取り1']);

    expect(errors).toEqual([]);
  });

  test('独立した2つの押し出しは「⋮」の1つ上へで入れ替えられ、Undo 1回で戻る', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 独立な 2 つの押し出し(重ならない位置)。
    await drawRectangle(page, ['0', '0'], ['10', '10']);
    await makeFace(page, ['矩形1']);
    await extrudeFace(page, '面1', '5');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 10 * 10 * 5);

    await drawRectangle(page, ['100', '0'], ['110', '10']);
    await expect(treeRow(page, '矩形2')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await makeFace(page, ['矩形2']);
    await expect(treeRow(page, '面2')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面2', '5');
    await expect(treeRow(page, '押し出し2')).toBeVisible();
    await collapseSketchSection(page);

    const orderOf = async (): Promise<readonly string[]> =>
      treeSection(page, 'ソリッド').locator('.pcad-tree__row--child .pcad-tree__label').allTextContents();
    await expect.poll(orderOf).toEqual(['押し出し1', '押し出し2']);

    // 「押し出し2」の「⋮」→「1つ上へ」で入れ替える。
    await treeRow(page, '押し出し2').click({ button: 'right' });
    const menu = page.locator('.pcad-tree__menu');
    const moveUp = menu.getByRole('menuitem', { name: '1 つ上へ', exact: true });
    await expect(moveUp).toBeEnabled();
    await moveUp.click();
    await expect.poll(orderOf).toEqual(['押し出し2', '押し出し1']);

    // 体積は互いに独立なので変わらない。
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 10 * 10 * 5);
    await treeRow(page, '押し出し2').click();
    await expectVolume(page, 10 * 10 * 5);

    // Undo 1 回で元の順序に戻る。
    await page.keyboard.press('Control+z');
    await expect.poll(orderOf).toEqual(['押し出し1', '押し出し2']);

    expect(errors).toEqual([]);
  });
});
