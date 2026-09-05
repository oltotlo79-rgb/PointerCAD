/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4「スケッチ拡張」の完了条件のうち、**任意の作業平面・基準ジオメトリ・3D スケッチ**を
 * 実際のブラウザで通しで確かめる(計画書 docs/plans/P4-スケッチ拡張.md §5.5 の 7・8・17、
 * タスク34)。**ヘッドレスで実行する。**
 *
 * 作図面の上の図形と編集は `e2e/tests/sketch-extended.spec.ts` が受け持つ。
 * 補助関数はそちらと同じ作りで、共有ファイルを作らずここへ書き写す(P1〜P3 の作りに合わせる)。
 *
 * 待ちは Playwright の自動待機だけで行い、固定の sleep は置かない。幾何カーネル
 * (Worker + OCCT、約 50MB)の読み込みが挟まる待ちにだけ長めの上限を渡す。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/* ========================================================================== *
 * 補助関数
 * ========================================================================== */

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

/** ツールバーの「スケッチ」区画の道具(平置きの 6 つ)。 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

/** ツールバーの「ソリッド」区画の操作。 */
function solidTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ソリッド' })
    .getByRole('button', { name: label, exact: true });
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

/** その場数値入力のポップアップ。 */
function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/** 下端のステータスバーの 1 文(FR-905)。 */
function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

/** ステータスバー右端の札のうち、作図面を示すもの。 */
function planeBadge(page: Page): Locator {
  return page.locator('.pcad-statusbar__state', { hasText: '作図面' });
}

/** モデルブラウザの要素の行。 */
function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/**
 * 「スケッチ」節の中の、名前で選んだ 1 本のスケッチの塊(仕上げ (g) のスケッチの親行)。
 * 要素の名前(面1 など)はスケッチごとに振り直されるので、2 本目を足したら必ずここで絞る。
 */
function sketchGroup(page: Page, sketchName: string): Locator {
  return featureTree(page)
    .locator('.pcad-tree__children > li')
    .filter({
      has: page.locator('.pcad-tree__select--sketch .pcad-tree__label', {
        hasText: new RegExp(`^${sketchName}$`),
      }),
    });
}

/** 指定したスケッチの中の要素の行。 */
function sketchGroupRow(page: Page, sketchName: string, name: string): Locator {
  return sketchGroup(page, sketchName).getByRole('button', { name, exact: true });
}

/** モデルブラウザの節(「スケッチ」「ソリッド」「基準」)。 */
function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** プロパティの「鍵と値」の値の側。 */
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティの式の欄(並び順で引く)。円弧なら 0〜2 が中心。 */
function propertyInputs(page: Page): Locator {
  return propertyPanel(page).locator('input.pcad-field__input');
}

/** ポップアップの欄を埋める。null を渡した欄は既定値のままにする。 */
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

/** Enter で決定する。欄を持たない段は「決定」を押す。 */
async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Enter');
    return;
  }
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
}

/** Esc で取消して閉じる。開いていなければ何もしない。 */
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

/** ポップアップの中の選択肢を名前で押す。 */
async function pickInPopover(page: Page, label: string): Promise<void> {
  await popover(page).getByRole('button', { name: label, exact: true }).first().click();
}

/** 2 段目以降の座標の欄を「絶対」にする(既定は相対)。 */
async function useAbsolute(page: Page): Promise<void> {
  await pickInPopover(page, '絶対');
}

/**
 * 「作図 ▾」の畳んだ一覧から道具を選ぶ。同じ道具をもう一度押すと解除になるので、
 * 先に「選択」へ戻してから開く。
 */
async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/**
 * 「編集 ▾」の畳んだ一覧から道具を選ぶ。「編集」はスケッチ区画の **2 つ目**の ▾ ボタン。
 * 選択を残したまま道具だけ切り替えたいので、ここでは「選択」へ戻さない。
 */
async function chooseEditTool(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(1).click();
  await page
    .locator('.pcad-menu__panel[aria-label="編集"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** 作図面の畳んだ一覧から項目を選ぶ(基準の 3 面・任意の作業平面・3D・平面と基準の道具)。 */
async function choosePlaneMenuItem(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: '作図面' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図面"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** 矩形を 1 つかく(対角の 2 点を世界座標で入れる)。 */
async function drawRectangle(
  page: Page,
  corner1: readonly [string, string, string],
  corner2: readonly [string, string, string],
): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1], corner1[2]]);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await useAbsolute(page);
  await fillFields(page, [corner2[0], corner2[1], corner2[2]]);
  await commitPopover(page);
  await cancelPopover(page);
}

/** 要素を順に選んでから面の道具にして Enter で面を張る。 */
async function makeFace(page: Page, elementNames: readonly string[]): Promise<void> {
  await treeRow(page, elementNames[0]).click();
  for (const name of elementNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

/** 面を 1 枚選んで押し出す。 */
async function extrudeFace(page: Page, faceName: string, distance: string): Promise<void> {
  await treeRow(page, faceName).click();
  await openToolMenu(page, '作る');
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, [distance]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

/** プロパティに出ている体積を数で読む。まだ出ていなければ NaN。 */
async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
}

/** 体積が期待値どおりであることを、許容差(mm³)つきで確かめる。 */
async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

/* ========================================================================== *
 * ワールド座標 → 画面の画素(solid.spec.ts の写し。視点を動かさないので成り立つ)
 * ========================================================================== */

type WorldPoint = readonly [number, number, number];

const HOME_AZIMUTH = Math.PI / 4;
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

/** ビューポートの上で、ワールド座標の点が見えている場所を押す(FR-106)。 */
async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4 任意の作業平面・基準ジオメトリ・3D スケッチ', () => {
  /*
   * 窓の大きさを固定する。立体の頂点は画面上 6px の当たり判定で拾われるので、
   * 押す場所を計算するこの検査では窓の大きさが結果を左右する(solid.spec.ts と同じ理由)。
   */
  test.use({ viewport: { width: 1440, height: 900 } });

  test('3 点で作った任意の作業平面の上にかいて押し出せる(FR-328)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    /*
     * (0,0,0)(40,0,0)(0,0,40) を通る平面 = XZ 面。第 1 軸は 1 点目 → 2 点目の向き
     * (1,0,0) で、第 2 軸は (0,0,1) になる(`planeSpec.ts` の `resolveThreePoints`)。
     */
    await choosePlaneMenuItem(page, '作業平面(3 点)');
    await expect(popoverTitle(page)).toHaveText('作業平面の 1 点目');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('作業平面の 2 点目');
    await useAbsolute(page);
    await fillFields(page, ['40', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('作業平面の 3 点目');
    await useAbsolute(page);
    await fillFields(page, ['0', '0', '40']);
    await commitPopover(page);
    await cancelPopover(page);

    await expect(treeRow(page, '作業平面1')).toBeVisible();
    // 作った平面がそのまま作図面になる(帯の札で分かる)。
    await expect(planeBadge(page)).toContainText('作業平面1');

    /*
     * その平面の上に 40 × 40 の矩形をかいて 10 押し出す。角は世界座標で入れ、
     * 平面へ落とした長さが辺になる(u = 40、v = 40)。体積 40 × 40 × 10 = 16000
     * (docs/報告記録.md 2026-09-04 19:30 の t13 の実測と一致する)。
     */
    await drawRectangle(page, ['0', '0', '0'], ['40', '0', '40']);
    await expect(treeRow(page, '矩形1')).toBeVisible();
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 16000);

    expect(errors).toEqual([]);
  });

  test('基準面のオフセット平面と、基準軸・基準点・座標系を作れる(FR-328、FR-329)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) いまの作図面(XY)から 10 離した作業平面。距離の既定は 10。
    await choosePlaneMenuItem(page, '作業平面(オフセット)');
    await expect(popoverTitle(page)).toHaveText('面から離す');
    await expect(popoverInputs(page).first()).toHaveValue('10');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '作業平面1')).toBeVisible();
    await treeRow(page, '作業平面1').click();
    await expect(propertyValue(page, '決め方')).toHaveText('作図面からずらす');

    // 2) 基準軸(2 点)。
    await choosePlaneMenuItem(page, '基準軸');
    await expect(popoverTitle(page)).toHaveText('基準軸の決め方');
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('基準軸の 1 点目');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('基準軸の 2 点目');
    await useAbsolute(page);
    await fillFields(page, ['0', '0', '50']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '基準軸1')).toBeVisible();

    // 3) 基準点(座標)。
    await choosePlaneMenuItem(page, '基準点');
    await expect(popoverTitle(page)).toHaveText('基準点の決め方');
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('基準点の位置');
    await fillFields(page, ['20', '10', '5']);
    await commitPopover(page);
    await cancelPopover(page);

    // 4) 座標系(原点 + 2 軸)。
    await choosePlaneMenuItem(page, '座標系');
    await expect(popoverTitle(page)).toHaveText('座標系の原点');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('座標系の軸');
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '座標系1')).toBeVisible();

    /*
     * 5) 4 種とも「基準」の節に並ぶ。座標で入れた点は隠しの基準点として先に積まれるので
     *    (t13 の設計)、基準点の連番は決め打ちにせず「節に基準点がある」ことで確かめる。
     */
    const references = treeSection(page, '基準');
    await expect(references).toContainText('作業平面1');
    await expect(references).toContainText('基準軸1');
    await expect(references).toContainText('基準点');
    await expect(references).toContainText('座標系1');

    expect(errors).toEqual([]);
  });

  test('3D スケッチで立体の頂点を結んで面を張り、押し出せる(FR-330、§5.5-8)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 の板を 10 押し出す。頂点を拾えるようになるまで(体積が出るまで)待つ。
    await drawRectangle(page, ['0', '0', '0'], ['40', '30', '0']);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 12000);

    // 2) 作図面を 3D にすると、帯の札が「3D」になる(作図面なし)。
    await choosePlaneMenuItem(page, '3D');
    await expect(planeBadge(page)).toContainText('3D');

    /*
     * 3) 上面の頂点 3 つを押して点にする(立体の頂点に付く点、FR-330)。
     *    点の道具は座標の欄を開くので、まず Esc で閉じてから押す
     *    (docs/報告記録.md 2026-09-04 の撮影台本の申し送り)。
     */
    await sketchTool(page, '点').click();
    await cancelPopover(page);
    for (const [world, name] of [
      [[0, 0, 10], '点1'],
      [[40, 0, 10], '点2'],
      [[40, 30, 10], '点3'],
    ] as const) {
      await clickWorldPoint(page, world);
      await expect(treeRow(page, name)).toBeVisible();
      await cancelPopover(page);
    }

    // 4) その 3 点で面を張り、5 押し出す。40 × 30 / 2 × 5 = 3000。
    await makeFace(page, ['点1', '点2', '点3']);
    await expect(treeRow(page, '面2')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面2', '5');
    await treeRow(page, '押し出し2').click();
    await expectVolume(page, 3000);

    // 5) 3D スケッチでかけない形(矩形)は、理由を出して断る(FR-504)。
    await chooseShapeTool(page, '矩形');
    await expect(statusText(page)).toContainText('作図面を選んでから');
    await expect(popover(page)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('3D スケッチの 3 点の円弧と、任意平面の上の 2 点円弧(§5.5-17、タスク36)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    /*
     * 立方体の頂点どうしは、既定の窓ではその場入力のポップアップ(260 × 280px)より
     * 画面上の間隔が狭く、次のクリックがポップアップに当たる。大きい窓にして避ける
     * (docs/報告記録.md 2026-09-04 の撮影台本の申し送り)。
     */
    await page.setViewportSize({ width: 2400, height: 1400 });

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 10 角の立方体を作り、頂点 (10,0,0)(0,10,0)(0,0,10) を通る円弧を 3D スケッチでかく。
    await drawRectangle(page, ['0', '0', '0'], ['10', '10', '0']);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 1000);

    await choosePlaneMenuItem(page, '3D');
    await expect(planeBadge(page)).toContainText('3D');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 1000);

    await chooseShapeTool(page, '3点の円弧');
    await clickWorldPoint(page, [10, 0, 0]);
    await clickWorldPoint(page, [0, 10, 0]);
    await clickWorldPoint(page, [0, 0, 10]);

    await expect(treeRow(page, '円弧1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await treeRow(page, '円弧1').click();
    // 中心 (10/3, 10/3, 10/3)・半径 10√(2/3)・法線 (1,1,1)/√3(計画書タスク36 の検算表)。
    const arcText = await propertyPanel(page).innerText();
    expect(arcText).toContain('3.33333333333');
    expect(arcText).toContain('8.16496580928');
    expect(arcText).toContain('0.57735026919');

    expect(errors).toEqual([]);
  });

  test('45 度に傾けた作業平面の上の 2 点 + 半径の円弧は、その面の上に中心を持つ(FR-326、FR-328)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // (0,0,0)(20,0,0)(0,20,20) を通る平面。第 1 軸 (1,0,0)、第 2 軸 (0,1/√2,1/√2)。
    await choosePlaneMenuItem(page, '作業平面(3 点)');
    await expect(popoverTitle(page)).toHaveText('作業平面の 1 点目');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['20', '0', '0']);
    await commitPopover(page);
    await useAbsolute(page);
    await fillFields(page, ['0', '20', '20']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '作業平面1')).toBeVisible();

    // (0,0,0) と (20,0,0) を通る半径 20 の円弧。中心は傾いた面の上に出る。
    await chooseShapeTool(page, '2点円弧');
    await expect(popoverTitle(page)).toHaveText('円弧の 1 点目');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の 2 点目');
    await useAbsolute(page);
    await fillFields(page, ['20', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円弧の半径');
    await fillFields(page, ['20']);
    await commitPopover(page);
    await cancelPopover(page);

    await expect(treeRow(page, '円弧1')).toBeVisible();
    await treeRow(page, '円弧1').click();
    /*
     * 中心は面の第 2 軸ぶんだけ下がる: (10, −√300/√2, −√300/√2) = (10, −12.247…, −12.247…)。
     * 面を見ていなければ Z が 0 のまま(XY 面のときの値)になる。
     */
    expect(Number(await propertyInputs(page).nth(0).inputValue())).toBeCloseTo(10, 6);
    expect(Number(await propertyInputs(page).nth(1).inputValue())).toBeCloseTo(-12.2474487139, 6);
    expect(Number(await propertyInputs(page).nth(2).inputValue())).toBeCloseTo(-12.2474487139, 6);

    expect(errors).toEqual([]);
  });

  test('立体の面を別のスケッチへ投影して押し出せ、上流の形を変えると投影も追う(FR-325、§5.5-6)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) スケッチ1 で 40 × 30 の板を 10 押し出す。
    await drawRectangle(page, ['0', '0', '0'], ['40', '30', '0']);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 12000);

    /*
     * 2) スケッチを 1 本足して、そちらへ作図を切り替える。
     *    投影で取り込めるのは「このスケッチを使う立体より前に作られた立体」だけなので
     *    (`projection.error.laterBody`)、押し出し1 が使っているスケッチ1 では投影できない。
     */
    await featureTree(page).getByRole('button', { name: 'スケッチを追加', exact: true }).click();
    await expect(treeRow(page, 'スケッチ2')).toBeVisible();

    // 3) 板の上面を押すと、その輪郭がいまの作図面(XY)に線として現れる。
    await chooseEditTool(page, '投影');
    await expect(statusText(page)).toContainText('写したい立体の面か辺をクリック');
    await clickWorldPoint(page, [20, 15, 10]);
    await expect(sketchGroupRow(page, 'スケッチ2', '投影1')).toBeVisible({
      timeout: KERNEL_TIMEOUT_MS,
    });

    /*
     * 4) 取り込んだ輪郭で面を張って 5 押し出す。40 × 30 × 5 = 6000。
     *    投影の曲線は立体の解決を通ってから決まるので、線が 4 本そろうまで待つ。
     */
    await sketchTool(page, '選択').click();
    await sketchGroupRow(page, 'スケッチ2', '投影1').click();
    await expect(propertyValue(page, '線の数')).toHaveText('4', { timeout: KERNEL_TIMEOUT_MS });
    await sketchTool(page, '面').click();
    await page.locator('canvas.pcad-viewport__canvas').press('Enter');
    await expect(sketchGroupRow(page, 'スケッチ2', '面1')).toBeVisible({
      timeout: KERNEL_TIMEOUT_MS,
    });

    await sketchGroupRow(page, 'スケッチ2', '面1').click();
    await openToolMenu(page, '作る');
    await solidTool(page, '押し出し').click();
    await expect(popoverTitle(page)).toHaveText('押し出す');
    await fillFields(page, ['5']);
    await commitPopover(page);
    await treeRow(page, '押し出し2').click();
    await expectVolume(page, 6000);

    /*
     * 5) もとの矩形を 40 × 30 → 60 × 30 に広げると、投影も押し出し2 も追う(FR-311、FR-502)。
     *    プロパティは作図中のスケッチの要素を映すので、先に作図をスケッチ1 へ戻す。
     */
    await treeRow(page, 'スケッチ1').click();
    await expect(sketchGroup(page, 'スケッチ1')).toContainText('作図中');
    await sketchGroupRow(page, 'スケッチ1', '矩形1').click();
    await propertyInputs(page).nth(3).fill('60');
    await treeRow(page, '押し出し2').click();
    await expectVolume(page, 60 * 30 * 5);

    expect(errors).toEqual([]);
  });

  test('作業平面で切った断面の輪郭を取り込んで押し出せる(FR-325)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 20 × 20 の箱を 10 押し出す。
    await drawRectangle(page, ['0', '0', '0'], ['20', '20', '0']);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 4000);

    // 2) XY 面から 5 離した作業平面(箱の高さの半分)を作る。
    await choosePlaneMenuItem(page, '作業平面(オフセット)');
    await expect(popoverTitle(page)).toHaveText('面から離す');
    await fillFields(page, ['5']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '作業平面1')).toBeVisible();

    // 3) スケッチを足し、その作業平面の上で断面を取る。
    await featureTree(page).getByRole('button', { name: 'スケッチを追加', exact: true }).click();
    await expect(treeRow(page, 'スケッチ2')).toBeVisible();
    await choosePlaneMenuItem(page, '作業平面1');
    await expect(planeBadge(page)).toContainText('作業平面1');

    await chooseEditTool(page, '断面');
    await expect(statusText(page)).toContainText('断面をとりたい立体をクリック');
    await clickWorldPoint(page, [10, 10, 10]);
    await expect(sketchGroupRow(page, 'スケッチ2', '断面1')).toBeVisible({
      timeout: KERNEL_TIMEOUT_MS,
    });

    // 4) 断面の輪郭(20 × 20)で面を張って 5 押し出す。20 × 20 × 5 = 2000。
    await sketchTool(page, '選択').click();
    await sketchGroupRow(page, 'スケッチ2', '断面1').click();
    await expect(propertyValue(page, '線の数')).toHaveText('4', { timeout: KERNEL_TIMEOUT_MS });
    await sketchTool(page, '面').click();
    await page.locator('canvas.pcad-viewport__canvas').press('Enter');
    await expect(sketchGroupRow(page, 'スケッチ2', '面1')).toBeVisible({
      timeout: KERNEL_TIMEOUT_MS,
    });

    await sketchGroupRow(page, 'スケッチ2', '面1').click();
    await openToolMenu(page, '作る');
    await solidTool(page, '押し出し').click();
    await expect(popoverTitle(page)).toHaveText('押し出す');
    await fillFields(page, ['5']);
    await commitPopover(page);
    await treeRow(page, '押し出し2').click();
    await expectVolume(page, 2000);

    expect(errors).toEqual([]);
  });

  test('選んだ点を原点にすると、ほかの点が式のまま平行移動する(FR-331、§5.5-16)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 40 × 30 × 10 の板を作る。原点を移しても体積は変わらないことの土台。
    await drawRectangle(page, ['0', '0', '0'], ['40', '30', '0']);
    await makeFace(page, ['矩形1']);
    await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await extrudeFace(page, '面1', '10');
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 12000);

    // 2) 式で置いた点(x = 10 + π/2)と、整数で置いた点(x = 3)。
    await sketchTool(page, '選択').click();
    await sketchTool(page, '点').click();
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await fillFields(page, ['10 + π/2', '0', '0']);
    await commitPopover(page);
    // 「続けてかく」が入なので、次の点の欄が開いたまま残る(FR-307)。
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await useAbsolute(page);
    await fillFields(page, ['3', '0', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '点2')).toBeVisible();

    // 3) 点1 の行の「⋮」から「ここを原点にする」(FR-331 の入り口の 1 つ)。
    await featureTree(page)
      .locator('.pcad-tree__row--child')
      .filter({ hasText: '点1' })
      .locator('.pcad-tree__more')
      .click();
    await page
      .locator('.pcad-tree__menu')
      .getByRole('menuitem', { name: 'ここを原点にする', exact: true })
      .click();
    await expect(statusText(page)).toContainText('原点を');
    await expect(statusText(page)).toContainText('から移しました');

    // 4) 選んだ点自身は厳密に 0 になり、ほかの点の式は差の式のまま残る(小数へ丸めない)。
    await treeRow(page, '点1').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('0');
    await treeRow(page, '点2').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('3 - (10 + π/2)');
    // 欄の下の「計算した値」は 3 − (10 + π/2) = −8.5707963268(π = 3.14159265…)。
    const shownValue = await propertyPanel(page)
      .locator('.pcad-field__message')
      .first()
      .innerText();
    expect(Number.parseFloat(shownValue.replace('=', '').replace('−', '-').trim())).toBeCloseTo(
      3 - (10 + Math.PI / 2),
      9,
    );

    // 5) 模型ごと平行移動しただけなので、体積は変わらない。
    await treeRow(page, '押し出し1').click();
    await expectVolume(page, 12000);

    // 6) Undo 1 回で元の式に戻る(1 操作 = 1 段、FR-505)。
    await page.keyboard.press('Control+z');
    await treeRow(page, '点2').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('3');
    await treeRow(page, '点1').click();
    await expect(propertyInputs(page).nth(0)).toHaveValue('10 + π/2');

    expect(errors).toEqual([]);
  });
});
