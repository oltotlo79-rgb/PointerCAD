/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 基本形状 5 種(FR-429)・面をつなぐ立体(FR-430)・測る(FR-1101、FR-1102)を、
 * 実際のブラウザで通しで確かめる(計画書 docs/plans/P5-高度なソリッド・外観と測定.md
 * タスク56 の (c)(e)(f)、§0.a-0.53)。**ヘッドレスで実行する。**
 *
 * - (c) 球・箱・円柱・円錐・トーラスを 1 つずつ置き、プロパティの体積が §2.7.3 の値になる。
 * - (e) 球と円を「面をつなぐ」で結んで立体ができる(球には外接する直線でつながる)。
 * - (f) 2 点を選ぶと距離が出る / 立体の材質を「アルミ」にすると質量が出る。
 *
 * - (d) 球の案内線から点を 2 つ取り、球の半径を 10 → 20 に変えても点が球面に残る
 *   (P5 タスク21・22 で球面上の点を作る道ができたので、このファイルへ 1 本足した)。
 *
 * 補助関数は `e2e/tests/p5-primitive-pick.spec.ts` / `e2e/tests/p5-cut-mirror.spec.ts` と
 * 同じ作りで、共有ファイルを作らずここへ書き写す(P1 からの作りに合わせる)。
 * **CPU 絞りは使わない**(並列作業中の CPU 競合でゆらぐ検査を作らない)。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';

/**
 * 体積の照合の許容(mm³)。計画書 §2.7.3 の表と同じ ± 1e-6 にする。
 * 画面の値は有効数字 12 桁で丸めた表示(`formatVolume`)なので、丸めの誤差は
 * 1e-8 mm³ より小さく、この許容には収まる。
 */
const VOLUME_TOLERANCE = 1e-6;

/**
 * 球 r=10・円 r=20・距離 30 を外接直線でつないだ立体の体積(mm³)。
 * 手計算できる軸対称の値で、計画書 §2.9.3 と kernel タスク24 の検査が同じ数を使う
 * (計画書の表記は `24741.124688560`。末尾の 0 は倍精度で表せないので落としてある)。
 */
const RULED_VOLUME = 24741.12468856;

/** 既定の箱の 1 辺(`packages/model/src/part/createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
/** 既定の箱の体積。中心が原点なので各軸 −10〜+10 に広がる。 */
const BOX_VOLUME = BOX_SIZE_MM ** 3;

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

/** スケッチ区画の「作図 ▾」の畳んだ一覧から道具を選ぶ(`sketch-extended.spec.ts` と同じ)。 */
async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** ツールバーの畳んだ一覧(「作る」「合わせる」「加工」「見た目」)の引き金。 */
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

/** ポップアップの欄を埋める。null を渡した欄は既定値のままにする(NFR-UX-4)。 */
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

/** Enter で決定する(§2.9)。 */
async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}

/** 開いたままのポップアップを閉じる(次のクリックを奪われないように)。 */
async function closePopover(page: Page): Promise<void> {
  if ((await popover(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/** 「ソリッド」節の中の立体の行。 */
function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/**
 * プロパティの「鍵と値」の値の側。**同じ名前の鍵が 2 つ出る場面がある**
 * (測った後は「質量特性」の節にも「体積」が並ぶ)ので、先頭の 1 つを取る。
 * 先頭は必ず上の枠(選んでいる立体そのもの)の側になる。
 */
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .first()
    .locator('xpath=following-sibling::dd[1]');
}

/** ステータスバーの「選ぶもの」の札(§0.a-0.6)。 */
function selectionKindLabel(page: Page): Locator {
  return page.locator('.pcad-statusbar__state').first();
}

/** 外観の節の選択肢(材質)の枠。質量特性の「材料」と区別するため語を完全一致で見る。 */
function appearanceChoice(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: new RegExp(`^${label}$`) }) });
}

function appearanceChoiceValue(page: Page, label: string): Locator {
  return appearanceChoice(page, label).locator('.pcad-menu__count');
}

async function chooseAppearance(page: Page, label: string, option: string): Promise<void> {
  const choice = appearanceChoice(page, label);
  await choice.locator('.pcad-menu__trigger').click();
  await choice.getByRole('menuitem', { name: option, exact: true }).click();
  await expect(appearanceChoiceValue(page, label)).toHaveText(option);
}

/* ------------------------------------------------------------------ *
 * ビューポートの当たり判定(ホーム視点のまま押す)
 * ------------------------------------------------------------------ */

type WorldPoint = readonly [number, number, number];

/*
 * ホーム視点の見え方。数値は `packages/ui/src/viewport/cameraMath.ts` の `HOME_ORBIT` と
 * `VERTICAL_FIELD_OF_VIEW` そのままで、写し方は `createViewportScene.ts` の `worldToScreen`
 * と同じ。**この検査では視点を一度も動かさない。**
 */
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
async function clickWorldPoint(page: Page, world: WorldPoint, shift = false): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  if (shift) {
    await page.keyboard.down('Shift');
  }
  await page.mouse.click(box.x + x, box.y + y);
  if (shift) {
    await page.keyboard.up('Shift');
  }
}

/**
 * 箱の上面の、左右の角(y が +10 と −10)。この 2 つを測る。
 *
 * **手前(カメラ側)の角 `(10, 10, 10)` は使わない。** ホーム視点のカメラは
 * (1,1,1) の向きに置かれているので、手前の角と**向こう側の一番奥の角 `(−10, −10, −10)`
 * が画面のまったく同じ場所に重なる**(どちらも視線の軸の上にある)。そこを押すと
 * どちらが選ばれるかは押した場所では決まらない(2026-09-06 の実測では奥の角が選ばれ、
 * 距離が 20mm ではなく 28.28mm になった)。左右の角は視線の軸から外れているので、
 * 画面の同じ場所に来る頂点は 1 つしかない。
 */
const BOX_TOP_LEFT_CORNER: WorldPoint = [-BOX_SIZE_MM / 2, BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];
const BOX_TOP_RIGHT_CORNER: WorldPoint = [BOX_SIZE_MM / 2, -BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];
/** その 2 点の距離(mm)= 上面の対角線 20√2。表示は有効数字 12 桁(`formatLength`)。 */
const CORNER_DISTANCE = '28.2842712475 mm';

/* ------------------------------------------------------------------ *
 * 体積の照合
 * ------------------------------------------------------------------ */

/**
 * その行を選び、体積が期待どおりになるまで待ってから、**数として**照合する。
 *
 * 文字列の完全一致にしないのは、球やトーラスの体積が割り切れない数で、画面の表示が
 * 有効数字 12 桁に丸められるため(`formatVolume`)。§2.7.3 の表が ± 1e-6 で書かれている
 * のと同じ読み方をここでもする。**期待値そのものは 1 つも緩めていない。**
 */
async function expectVolumeNear(page: Page, rowName: string, expected: number): Promise<void> {
  await solidRow(page, rowName).click();
  const cell = propertyValue(page, '体積');
  await expect(cell).toHaveText(new RegExp(`${VOLUME_UNIT}$`), { timeout: KERNEL_TIMEOUT_MS });
  const text = (await cell.textContent()) ?? '';
  const value = Number.parseFloat(text);
  expect(
    Math.abs(value - expected),
    `${rowName} の体積 ${text}(期待 ${String(expected)})`,
  ).toBeLessThan(VOLUME_TOLERANCE);
}

/** 「作る」の一覧から基本形状を 1 つ置く。欄は渡した分だけ埋め、残りは既定のまま。 */
async function placePrimitive(
  page: Page,
  label: string,
  title: string,
  sources: readonly (string | null)[] = [],
): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', label).click();
  await expect(popoverTitle(page)).toHaveText(title);
  if (sources.length > 0) {
    await fillFields(page, sources);
  }
  await commitPopover(page);
  await closePopover(page);
}


/* ------------------------------------------------------------------ *
 * 球面上の点(FR-431、P5 タスク21・22)
 * ------------------------------------------------------------------ */

/** 球の半径 10 のときの、緯度 30・経度 45 の点(計画書 §2.8.3 の表)。 */
const SPHERE_POINT_A: readonly [number, number, number] = [
  6.123724356957945, 6.123724356957945, 5,
];

/** 同じく、緯度 60・経度 120 の点(計画書 §2.8.3 の表)。 */
const SPHERE_POINT_B: readonly [number, number, number] = [
  -2.5, 4.330127018922194, 8.660254037844387,
];

/** 半径 20 の球の体積(4/3·π·8000)。半径を変えたことを体積で確かめる。 */
const SPHERE_VOLUME_R20 = 33510.32163829113;

/**
 * 座標の照合の許容(mm)。画面の値は有効数字 12 桁の表示(`formatNumber`)なので、
 * 丸めの誤差は 1e-10 mm より小さく、この許容には収まる。**期待値は緩めていない。**
 */
const POINT_TOLERANCE = 1e-6;

/** プロパティの「計算した値」の節(読み取り専用の X・Y・Z が並ぶ)。 */
function computedValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-section')
    .filter({ has: page.locator('.pcad-section__title', { hasText: '計算した値' }) })
    .locator('dt.pcad-properties__key')
    .filter({ hasText: new RegExp(`^${key}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティの式の欄(見出しの文言で選ぶ)。 */
function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

/**
 * その点の行を選び、位置が期待どおりになるまで待ってから**数として**照合する。
 * 文字列の完全一致にしないのは、球面上の点の座標が割り切れない数で、画面の表示が
 * 有効数字 12 桁に丸められるため(体積の照合と同じ読み方)。
 */
async function expectPointNear(
  page: Page,
  rowName: string,
  expected: readonly [number, number, number],
): Promise<void> {
  await treeRow(page, rowName).click();
  const axes = ['X', 'Y', 'Z'] as const;
  for (const [index, axis] of axes.entries()) {
    await expect(computedValue(page, axis)).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await expect
      .poll(
        async () =>
          Math.abs(
            Number.parseFloat((await computedValue(page, axis).textContent()) ?? '') -
              expected[index],
          ),
        { timeout: KERNEL_TIMEOUT_MS, message: `${rowName} の ${axis}(期待 ${String(expected[index])})` },
      )
      .toBeLessThan(POINT_TOLERANCE);
  }
}

/** 球を選んでから「球面上の点」を開き、緯度・経度を打って決める。 */
async function placeSphereGridPoint(
  page: Page,
  sphereRow: string,
  latitude: string,
  longitude: string,
): Promise<void> {
  await solidRow(page, sphereRow).click();
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '球面上の点').click();
  await expect(popoverTitle(page)).toHaveText('球面上の点');
  await fillFields(page, [latitude, longitude]);
  await commitPopover(page);
  await closePopover(page);
}

test.describe('P5 基本形状・面をつなぐ・測る', () => {
  // 窓の大きさは他の P5 の検査と同じ 1440×900 に固定する(当たり判定は画素で決まる)。
  test.use({ viewport: { width: 1440, height: 900 } });

  test('球・箱・円柱・円錐・トーラスを置くと、体積が §2.7.3 の値になる(FR-429)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    /*
     * 5 つとも「何も選ばずに置く」ので中心は原点(`selectedPrimitiveOrigin` の既定)。
     * 途中で立体の行を押して体積を読むが、**立体そのものは中心にならない**(中心になるのは
     * 立体の頂点かスケッチの点だけ)ので、次の形もそのまま原点に置かれる。
     */

    // 1) 球(既定の半径 10)。体積 = 4/3·π·1000。
    await placePrimitive(page, '球', '球を置く');
    await expectVolumeNear(page, '球1', 4188.790204786391);

    // 2) 箱(10 × 20 × 30)。§2.7.3 の表と同じ寸法を打ち込む。
    await placePrimitive(page, '箱', '箱を置く', ['10', '20', '30']);
    await expectVolumeNear(page, '箱1', 6000);

    // 3) 円柱(既定の半径 10・高さ 20)。体積 = π·100·20。
    await placePrimitive(page, '円柱', '円柱を置く');
    await expectVolumeNear(page, '円柱1', 6283.185307179587);

    /*
     * 4) 円錐(既定の下半径 10・上半径 0・高さ 20 = 尖った円錐)。体積 = π/3·100·20。
     *    計画書 §2.7.3 の表記は `2094.3951023931953` だが、倍精度で表せる最も近い数は
     *    `2094.3951023931954`(= `Math.PI / 3 * 100 * 20`)なので、そちらを書く
     *    (値を変えたのではなく、同じ 1 つの数の書き方を直しただけ)。
     */
    await placePrimitive(page, '円錐', '円錐を置く');
    await expectVolumeNear(page, '円錐1', 2094.3951023931954);

    // 5) トーラス(既定の主半径 20・管半径 5)。体積 = 2π²·20·25。
    await placePrimitive(page, 'トーラス', 'トーラスを置く');
    await expectVolumeNear(page, 'トーラス1', 9869.604401089358);

    // 6) 5 つとも別々の立体として並んでいる(どれも他を消費しない「作る」フィーチャー)。
    await expect(treeSection(page, 'ソリッド').locator('.pcad-tree__children > li')).toHaveCount(5);

    expect(errors).toEqual([]);
  });

  test('球と円を「面をつなぐ」で結ぶと立体ができる(FR-430)', async ({ page }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 球の中心にする点を (0, 0, 30) へ置く(球の中心は座標かスケッチの点で決める。
    //    立体の頂点で決めた球は、まだ面をつなぐ相手にできない = `ruledError.sphereOrigin`)。
    await sketchTool(page, '点').click();
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await fillFields(page, ['0', '0', '30']);
    await commitPopover(page);
    await closePopover(page);
    await expect(treeRow(page, '点1')).toBeVisible();

    // 2) その点を中心に半径 10 の球を置く。
    await treeRow(page, '点1').click();
    await placePrimitive(page, '球', '球を置く');
    await expect(solidRow(page, '球1')).toBeVisible();

    // 3) 原点に半径 20 の円をかき、その円で面を張る(輪郭にできるのはスケッチの「面」)。
    await chooseShapeTool(page, '円');
    await expect(popoverTitle(page)).toHaveText('円の中心');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('円の半径');
    await fillFields(page, ['20']);
    await commitPopover(page);
    await closePopover(page);
    await expect(treeRow(page, '円弧1')).toBeVisible();

    /*
     * 木の行は文書ができた時点で出るが、**面の境界に選べるのは解決が済んでから**
     * (`sketchCommands.ts` の `boundaryElementKind` は解決済みの曲線の一覧を見る)。
     * 解決を待たずに面を張ると「面そのものは面の境界に使えません」で断られる
     * (2026-09-06 に実測。同じ待ち漏れが 2026-09-04 の E2E タスク34 でも起きている)。
     * プロパティの「弧の長さ」は解決した曲線からしか出ないので、これを待てばよい。
     */
    await treeRow(page, '円弧1').click();
    await expect(propertyValue(page, '弧の長さ')).toHaveText('125.663706144', {
      timeout: KERNEL_TIMEOUT_MS,
    });
    await sketchTool(page, '面').click();
    await page.locator('canvas.pcad-viewport__canvas').press('Enter');
    await expect(treeRow(page, '面1')).toBeVisible();

    /*
     * 4) 球と面を選んで「面をつなぐ」。**選ぶ種類は切り替わらない**(`keepsSelectionKind`)
     *    ので、立体の球とスケッチの面を並べて選んだまま押せる(§2.15)。
     */
    await solidRow(page, '球1').click();
    await treeRow(page, '面1').click({ modifiers: ['Shift'] });
    await openToolMenu(page, '作る');
    await menuTool(page, '作る', '面をつなぐ').click();
    await expect(popoverTitle(page)).toHaveText('面をつなぐ');
    await commitPopover(page);
    await closePopover(page);

    // 5) 立体ができ、体積が出る(球 r=10・円 r=20・距離 30 の外接直線でつないだ形)。
    await expect(solidRow(page, '面をつなぐ1')).toBeVisible();
    await solidRow(page, '面をつなぐ1').click();
    await expect(propertyValue(page, '体積')).toHaveText(new RegExp(`${VOLUME_UNIT}$`), {
      timeout: KERNEL_TIMEOUT_MS,
    });
    const volumeText = (await propertyValue(page, '体積').textContent()) ?? '';
    const volume = Number.parseFloat(volumeText);
    /*
     * 手計算できる軸対称の値は 24741.124688560(計画書 §2.9.3、kernel タスク24 の検査)。
     * ここは画面ごしの通しの確認なので、**球への外接点を何点で取るか(既定「ふつう」= 24 点)
     * による近似のぶん**だけ幅を持たせて照合する(§6.7 の 0.5% と同じ読み方)。
     * 期待値そのものは緩めていない。
     */
    expect(volume, `面をつなぐ1 の体積 ${volumeText}`).toBeGreaterThan(RULED_VOLUME * 0.995);
    expect(volume, `面をつなぐ1 の体積 ${volumeText}`).toBeLessThan(RULED_VOLUME * 1.005);

    // 6) 元の球は消えていない(§0.a-0.27「つなぐ立体は材料を消費しない」)。
    await expectVolumeNear(page, '球1', 4188.790204786391);

    expect(errors).toEqual([]);
  });

  test('2 点を選ぶと距離が出て、アルミの立体は質量が出る(FR-1101、FR-1102)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 既定の 20×20×20 の箱を原点へ置き、計算が終わるまで待つ。
    await placePrimitive(page, '箱', '箱を置く');
    await expectVolumeNear(page, '箱1', BOX_VOLUME);

    // 2) `1` で頂点にして、上面の角を 2 つ選ぶ(2 つ目は Shift で足す)。
    await sketchTool(page, '選択').click();
    await page.keyboard.press('1');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
    await clickWorldPoint(page, BOX_TOP_LEFT_CORNER);
    await clickWorldPoint(page, BOX_TOP_RIGHT_CORNER, true);
    await expect(propertyValue(page, '選んでいるもの')).toHaveText('頂点 / 頂点');
    await expect(propertyValue(page, '測れるもの')).toHaveText('2 点の距離');

    // 3) 「測る」を押すと、その場で測って結果が出る(押したら必ず何かが起きる、NFR-UX-5)。
    await openToolMenu(page, '見た目');
    await menuTool(page, '見た目', '測る').click();
    await expect(propertyValue(page, '結果')).toHaveText(`2 点の距離: ${CORNER_DISTANCE}`);

    /*
     * 4) 立体そのものを選び直して材質を「アルミ」にする。質量の材料は**外観の材質から
     *    始まる**(§0.a-0.31)ので、密度は 2.68 g/cm³ になる。
     */
    await solidRow(page, '箱1').click();
    await chooseAppearance(page, '材質', 'アルミ');

    /*
     * 質量の材料は**その立体を選んだ時点の外観**から始まる(§0.a-0.31。節は立体の id を
     * `key` にして作り直される)。**すでに選んでいる立体の材質を変えても材料は追いかけない**
     * ので、選び直してから測る(2026-09-06 の実測。選び直さないと鋼のままだった)。
     */
    await solidRow(page, '箱1').click({ modifiers: ['Shift'] });
    await expect(propertyPanel(page)).not.toContainText('質量特性');
    await solidRow(page, '箱1').click();

    // 5) もう一度「測る」。体積と重さが出る(8000 mm³ = 8 cm³ × 2.68 = 21.44 g)。
    await openToolMenu(page, '見た目');
    await menuTool(page, '見た目', '測る').click();
    await expect(appearanceChoiceValue(page, '材料')).toHaveText('アルミ(A5052)');
    await expect(propertyValue(page, '質量')).toHaveText('21.44 g');

    expect(errors).toEqual([]);
  });
  test('球の案内線から点を 2 つ取り、球を大きくしても点が球面に残る(FR-431)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await disableFilePickers(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 原点に半径 10 の球を置く(既定の半径。計算が終わるまで待つ)。
    await placePrimitive(page, '球', '球を置く');
    await expectVolumeNear(page, '球1', 4188.790204786391);

    /*
     * 2) 球を選んで「球面上の点」で 2 点取る。緯度・経度を打つ道(FR-431 の
     *    「緯度・経度の数値を直接入力して点を作ることもでき」)を通す。**ビューポートの
     *    座標に頼らない**ので、視線の軸に重なる場所を押してしまう取り違え
     *    (2026-09-06 の発見)は起こらない。
     */
    await placeSphereGridPoint(page, '球1', '30', '45');
    await expect(treeRow(page, '点1')).toBeVisible();
    await expectPointNear(page, '点1', SPHERE_POINT_A);

    await placeSphereGridPoint(page, '球1', '60', '120');
    await expect(treeRow(page, '点2')).toBeVisible();
    await expectPointNear(page, '点2', SPHERE_POINT_B);

    // 3) 点は「どの球の緯度・経度か」で覚えている(基準に球の名前が出る)。
    await treeRow(page, '点1').click();
    await expect(propertyPanel(page)).toContainText('球面上の点');
    await expect(propertyField(page, '緯度')).toHaveValue('30');
    await expect(propertyField(page, '経度')).toHaveValue('45');

    /*
     * 4) 球の半径を 10 → 20 に変える。**新しい体積になるまで待つ**のが要点で、
     *    `expectVolumeNear` は「mm³ で終わる文字が出ていること」しか待たないため、
     *    古い体積のまま読んでしまう(2026-09-06 の実測。1 回目はここで落ちた)。
     */
    await solidRow(page, '球1').click();
    await propertyField(page, '半径').fill('20');
    await expect
      .poll(
        async () =>
          Math.abs(
            Number.parseFloat((await propertyValue(page, '体積').textContent()) ?? '') -
              SPHERE_VOLUME_R20,
          ),
        { timeout: KERNEL_TIMEOUT_MS, message: '半径 20 の球の体積' },
      )
      .toBeLessThan(VOLUME_TOLERANCE);

    /*
     * 5) 2 点とも球面に残ったまま、原点からの距離が 2 倍になる(要件 FR-431 の太字
     *    「球の半径・中心を変えても球面上に留まったまま追従し」)。
     */
    await expectPointNear(page, '点1', [
      SPHERE_POINT_A[0] * 2,
      SPHERE_POINT_A[1] * 2,
      SPHERE_POINT_A[2] * 2,
    ]);
    await expectPointNear(page, '点2', [
      SPHERE_POINT_B[0] * 2,
      SPHERE_POINT_B[1] * 2,
      SPHERE_POINT_B[2] * 2,
    ]);

    expect(errors).toEqual([]);
  });
});
