/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

/**
 * 基本形状(FR-429)を 1 つ置いた直後に、ビューポートを直接押して立体・面・頂点を
 * 選べることを確かめる(P5 仕上げ (j)、計画書 docs/plans/P5-高度なソリッド・外観と測定.md
 * タスク32 の担当の報告 2026-09-05 23:33)。**ヘッドレスで実行する。**
 *
 * 既存の `solid.spec.ts` の面クリックは「スケッチをかいて押し出した立体」しか通っておらず、
 * **スケッチを 1 本も持たない部品**(基本形状だけを置いた部品)を押す道が 1 件も無かった。
 * その差がそのまま不具合の隠れ場所になっていたので、ここで押さえる。
 *
 * ここで見つけて直した不具合は 2 つ(どちらも 2026-09-06 にヘッドレスで実測):
 *
 * 1. **外観・測るの道具のあいだ、立体そのものを押しても選べない**
 *    (`viewport/attachSketchInteraction.ts` の `picksBodies` が P5 の 2 道具を知らなかった)。
 *    「外観 → `4` で立体 → 箱を押す」でも「測る(選ぶものは立体のまま)→ 箱を押す」でも
 *    選択が空のままで、何も無いところを押しても選択が解けなかった。
 * 2. **頂点を選んでから基本形状の道具を押すと選択が消える**
 *    (`solid/subShapeSelection.ts` の `keepsSelectionKind` に基本形状が入っていなかった)。
 *    FR-429 の「立体の頂点を中心にする」が「選んでから道具」の順で成立しなかった。
 *
 * なお、タスク32 の担当が見た「基本形状の面・頂点がどうしても選べない」そのものは
 * **幾何カーネルの初回計算(約 50MB の読み込みを含む)が終わる前に押していた**ためで、
 * 計算が終わった後は面も頂点も立体も選べる(この検査の 1 本目)。だからこの検査は
 * **体積が出るまで待ってから**押す。
 *
 * 補助関数は `e2e/tests/solid.spec.ts` と同じ作りで、共有ファイルを作らずここへ書き写す
 * (P1 からの作りに合わせる)。選択子は `data-testid` を足さず role / aria / class で引く。
 */

/** 既定の箱の 1 辺(`packages/model/src/part/createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
/** 既定の箱の体積。中心が原点なので各軸 -10〜+10 に広がる。 */
const BOX_VOLUME = BOX_SIZE_MM ** 3;
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
 * File System Access API を無いことにしてから頁を開く(§0.a-0.10)。
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

/** ツールバーの「スケッチ」区画の道具。 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
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

/** Enter で決定する(§2.9)。焦点は必ずポップアップの欄に置いてから押す。 */
async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
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

/** ステータスバーの「選ぶもの」の札(§0.a-0.6)。右端の札のうち先頭。 */
function selectionKindLabel(page: Page): Locator {
  return page.locator('.pcad-statusbar__state').first();
}

/**
 * いま何を選んでいるかの読み取り口。プロパティの「測定」の節の「選んでいるもの」
 * (`PropertyPanel.tsx` の `MeasureSection`、`describeMeasureTargets`)を読む。
 *
 * 面・辺・立体は 1 つ選べば、頂点は 2 つ選べばこの節が出る(`solid/measure.ts` の
 * `measureReadiness`)。**種類の名前がそのまま出る**ので、「押した場所で何が選ばれたか」を
 * 検査の側から種類ごとに読み分けられる。選択が空なら節そのものが出ない。
 */
function selectedTargets(page: Page): Locator {
  return propertyValue(page, '選んでいるもの');
}

type WorldPoint = readonly [number, number, number];

/*
 * ホーム視点の見え方。数値は `packages/ui/src/viewport/cameraMath.ts` の `HOME_ORBIT` と
 * `VERTICAL_FIELD_OF_VIEW` そのままで、写し方は `createViewportScene.ts` の `worldToScreen`
 * (three.js の PerspectiveCamera + lookAt)と同じ。**この検査では視点を一度も動かさない。**
 */
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
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
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

/** ワールド座標を canvas の左上を原点とした画素へ写す。 */
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

/**
 * ビューポートの上で、ワールド座標の点が見えている場所を押す(FR-106)。
 *
 * Shift を足すときは `page.mouse.click` の引数では渡せない(`mouse.click` は修飾キーの
 * 選択肢を持たない。渡しても黙って無視される)ので、押している側で
 * `keyboard.down('Shift')` … `keyboard.up('Shift')` で挟む。
 */
async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}

/** 箱の上面の中心(0, 0, +10)。 */
const BOX_TOP_CENTER: WorldPoint = [0, 0, BOX_SIZE_MM / 2];
/**
 * 箱の上面の、画面の左右へ離れて見える 2 つの角。
 *
 * **視線の軸の上にある手前の角 `(10, −10, 10)` は使わない。** 既定のホーム視点のカメラは
 * `(1, −1, 1)` の向きにあり(2026-09-06 に「前・上・右が見える向き」へ変えた)、その角は
 * 向こう側の一番奥の角 `(−10, 10, −10)` と画面のまったく同じ場所に重なる
 * (2026-09-06 05:5x のタスク56 の発見)。頂点の当たり判定は深度を見ない 6px なので、
 * 重なった 2 つのどちらが選ばれるかは押した場所では決まらない。ここで使う 2 つは軸から
 * 外れていて、1440×900 の窓では画面上でいちばん近い別の頂点まで 79px 離れている。
 */
const BOX_TOP_LEFT_CORNER: WorldPoint = [-BOX_SIZE_MM / 2, -BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];
const BOX_TOP_RIGHT_CORNER: WorldPoint = [BOX_SIZE_MM / 2, BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];

/** 箱の外(何も無いところ)。選択を解くのに押す。 */
const EMPTY_SPOT: WorldPoint = [-60, -60, 0];

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置く(FR-429、NFR-UX-4)。 */
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await expect(popoverInputs(page).nth(0)).toHaveValue(String(BOX_SIZE_MM));
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(solidRow(page, '箱1')).toBeVisible();
  // 段が閉じていなければ閉じる(次のクリックをポップアップに奪われないため)。
  if ((await popover(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
  // 幾何カーネルが箱を作り終えるまで待つ(体積が出れば当たり判定の的も揃っている)。
  await solidRow(page, '箱1').click();
  await waitForRecompute(page, token);
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
}

test.describe('P5 基本形状の当たり判定', () => {
  /*
   * 窓の大きさは `solid.spec.ts` の P3 の塊と同じ 1440×900 に固定する。ビューポートの
   * 当たり判定は画面の画素で決まる(面は光線、辺・頂点は 6px)ので、押す場所を計算する
   * この検査では窓の大きさが結果を左右する。
   */
  test.use({ viewport: { width: 1440, height: 900 } });

  test('基本形状の箱を置いた直後に、立体・面・頂点をビューポートで選べる(FR-106、FR-429)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    // 1) 何も切り替えずに立体を押す(選ぶものは「立体」のまま)。
    await sketchTool(page, '選択').click();
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
    await clickWorldPoint(page, EMPTY_SPOT);
    await expect(selectedTargets(page)).toHaveCount(0);
    await clickWorldPoint(page, BOX_TOP_CENTER);
    await expect(selectedTargets(page)).toHaveText('立体');

    // 2) `3` で面にして上面の中心を押す。
    await page.keyboard.press('3');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await expect(selectedTargets(page)).toHaveCount(0);
    await clickWorldPoint(page, BOX_TOP_CENTER);
    await expect(selectedTargets(page)).toHaveText('面');

    // 3) `1` で頂点にして角を 2 つ押す(頂点 1 つでは測れるものが無いので節が出ない)。
    await page.keyboard.press('1');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
    await clickWorldPoint(page, BOX_TOP_LEFT_CORNER);
    await page.keyboard.down('Shift');
    await clickWorldPoint(page, BOX_TOP_RIGHT_CORNER);
    await page.keyboard.up('Shift');
    await expect(selectedTargets(page)).toHaveText('頂点 / 頂点');

    expect(errors).toEqual([]);
  });

  test('「外観」「測る」の道具のあいだも立体そのものを押して選べる(FR-1106、FR-1101、P5 仕上げ (j))', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    /*
     * 1) 外観は面から始まる(`selectionKindForTool`)。`4` キーで「立体」へ切り替えると
     *    立体ごとに色を付けられる、という案内どおりに押せる。直す前は `picksBodies` が
     *    外観を知らなかったため、押しても何も起きなかった。
     */
    await openToolMenu(page, '見た目');
    await menuTool(page, '見た目', '外観').click();
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await page.keyboard.press('4');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
    await expect(selectedTargets(page)).toHaveCount(0);
    await clickWorldPoint(page, BOX_TOP_CENTER);
    await expect(selectedTargets(page)).toHaveText('立体');

    /*
     * 2) 測るは選ぶ種類を切り替えない(§2.15)ので「立体」のまま。体積・質量特性・
     *    立体 2 つの隙間はどれも立体を選ぶ測り方なので、この道具のあいだも立体を押せる。
     *    直す前は押しても選べず、**何も無いところを押しても選択が解けなかった**。
     *
     *    「測る」を押した時点で、選んでおいた箱の体積が測られている(§0.a-0.29 の
     *    「結果はモデルを変えるまで残る」)ので、節そのものは選択を解いても出たままになる。
     *    選択が解けたかどうかは「選んでいるもの」の欄が断りの文へ変わることで見る。
     */
    await openToolMenu(page, '見た目');
    await menuTool(page, '見た目', '測る').click();
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
    await clickWorldPoint(page, EMPTY_SPOT);
    await expect(selectedTargets(page)).toHaveText('測りたいものを 1 つか 2 つ選んでください。');
    await clickWorldPoint(page, BOX_TOP_CENTER);
    await expect(selectedTargets(page)).toHaveText('立体');
    await expect(propertyValue(page, '測れるもの')).toHaveText('立体の体積 / 体積と重さ');

    expect(errors).toEqual([]);
  });

  test('頂点を選んでから基本形状を押すと、その頂点が中心になる(FR-429、P5 仕上げ (j))', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await placeBox(page);

    // `1` で頂点にして、置いた箱の上面の右の角を選ぶ。
    await page.keyboard.press('1');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
    await clickWorldPoint(page, BOX_TOP_RIGHT_CORNER);

    /*
     * その状態で「箱」を押す。基本形状は選ぶ種類を切り替えない(`keepsSelectionKind`)ので、
     * 選んだ頂点はそのまま残り、2 つ目の箱の中心になる。直す前は種類が「立体」へ戻り、
     * 選択が空になって原点に置かれていた(タスク18 の申し送り)。
     */
    await openToolMenu(page, '作る');
    await menuTool(page, '作る', '箱').click();
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
    await expect(popoverTitle(page)).toHaveText('箱を置く');
    const token = await beginRecompute(page);
    await commitPopover(page);

    await expect(solidRow(page, '箱2')).toBeVisible();
    await solidRow(page, '箱2').click();
    await waitForRecompute(page, token);
    await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, {
      timeout: KERNEL_TIMEOUT_MS,
    });
    // 中心の欄が座標 3 つではなく「立体の頂点」になっている(PropertyPanel の中心の節)。
    await expect(
      propertyPanel(page).locator('dt.pcad-properties__key', { hasText: '立体の頂点' }),
    ).toHaveCount(1);

    expect(errors).toEqual([]);
  });
});
