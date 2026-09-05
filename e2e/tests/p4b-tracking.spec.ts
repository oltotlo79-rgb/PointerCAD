/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**直交・極トラッキング**(FR-110、NFR-UX-7)を
 * 実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * 期待値の出どころ: `docs/plans/P4b-スケッチの仕上げ.md` 「### タスク15」「### タスク16」の
 * 検証表(20∠17° → 15° への丸め、延長線の判定)と「### タスク23」の (e)、
 * `packages/ui/src/shell/statusText.ts` の `TRACK_GUIDE_KEYS` / `ja.json` の
 * `statusBar.track.*`(帯の文言はここが正本)。
 *
 * **画素は数えず、帯(ステータスバー)の文言だけで判定する**(統括の指示書)。
 * 補助関数は既存の E2E(`sketch-extended.spec.ts`)と同じ作りで、共有ファイルを作らず
 * ここへ書き写す。**ヘッドレスで実行する。**
 */

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

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
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
  await popoverInputs(page).first().press('Enter');
}

async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

async function chooseSketchTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await sketchTool(page, label).click();
}

/** 「吸着」の畳んだ一覧(種別の入切・角度の刻み)を開く。開いていれば何もしない。 */
async function openSnapMenu(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: '吸着の種別', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  return page.locator('.pcad-menu__panel[aria-label="吸着の種別"]');
}

/**
 * 角度の刻みを選ぶ(既定は 15°)。
 *
 * **`Escape` では閉じない**(ビューポートの Esc は道具の取り消しに使われており、開いている
 * その場入力を巻き込んで最初の段へ戻してしまう)。トリガーをもう一度押して畳む。
 */
async function selectTrackAngleStep(page: Page, step: number): Promise<void> {
  const menu = await openSnapMenu(page);
  await menu.getByRole('button', { name: `${String(step)}°`, exact: true }).click();
  await page.getByRole('button', { name: '吸着の種別', exact: true }).click();
}

/** 吸着の種別1つを切る(既定は9種すべて入)。点の吸着(方眼等)が向きの吸着より優先されるため、
 *  向きの吸着だけを確かめたいときは邪魔になる種別を切っておく。 */
async function disableSnapKind(page: Page, label: string): Promise<void> {
  const menu = await openSnapMenu(page);
  await menu.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: '吸着の種別', exact: true }).click();
}

/** 吸着そのものを切る/入れる。 */
async function setSnapEnabled(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByRole('button', { name: '吸着', exact: true });
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed !== enabled) {
    await toggle.click();
  }
}

/* -------------------------------------------------------------------------- *
 * ワールド座標 → 画面の画素(sketch-extended.spec.ts の写し。視点を動かさないので成り立つ)
 * -------------------------------------------------------------------------- */

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

/** ビューポート上の、ワールド座標の点が見えている場所へポインタを動かす(クリックしない)。 */
async function moveToWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
}

/** 20∠θ° を作図面 XY の (x, y, 0) へ直す(planeToWorld(XY, ...) と同じ)。 */
function polarPoint(distance: number, angleDegrees: number): WorldPoint {
  const radians = (angleDegrees * Math.PI) / 180;
  return [distance * Math.cos(radians), distance * Math.sin(radians), 0];
}

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4b 直交・極トラッキング(FR-110)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('起点から17°の向きへ動かすと、既定の15°刻みで吸着し帯に出る', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 線分の始点を (0,0,0) に置く(極の起点になる、§0.a-0.10)。
    await chooseSketchTool(page, '線分');
    await expect(popoverTitle(page)).toHaveText('線分の始点');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('線分の終点');

    // ポインタを 20∠17°(≈(19.126, 5.848, 0))へ動かす。7.5° 以上ずれているので 15° へ丸まる。
    await moveToWorldPoint(page, polarPoint(20, 17));
    await expect(statusText(page)).toContainText('15° に合わせています');

    await cancelPopover(page);
    expect(errors).toEqual([]);
  });

  test('刻みを90°に変えると、同じ向きが0°へ丸まる(15°は出ない)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // ツールバーの設定は、その場入力を開く前に済ませる(開いている間に触ると
    // ポップアップが閉じてしまう。ヘッドレスでの実測により、設定は描き始める前に行う)。
    await selectTrackAngleStep(page, 90);
    // 点の吸着(方眼)は向きの吸着より優先されるため、ここでは切っておく(FR-107 との優先順位)。
    await disableSnapKind(page, '方眼');

    await chooseSketchTool(page, '線分');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('線分の終点');

    /*
     * 判定は画面座標(近ければ吸着)なので、刻みが粗いと候補の向きと実際のポインタの
     * 向きの差が大きくなり、判定半径の外へ出て吸着そのものが起きなくなる
     * (§2.9、ヘッドレスでの実測)。17° では 15° 刻みの候補(15°、差2°)には乗るが
     * 90° 刻みの候補(0°、差17°)には乗らないため、ここでは 0° に近い 2° で確かめる。
     */
    await moveToWorldPoint(page, polarPoint(20, 2));
    await expect(statusText(page)).toContainText('0° に合わせています');
    await expect(statusText(page)).not.toContainText('15° に合わせています');

    await cancelPopover(page);
    expect(errors).toEqual([]);
  });

  test('吸着そのものを切ると、案内が帯に出ない', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await chooseSketchTool(page, '線分');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('線分の終点');

    await setSnapEnabled(page, false);
    await moveToWorldPoint(page, polarPoint(20, 17));
    await expect(statusText(page)).not.toContainText('に合わせています');

    await setSnapEnabled(page, true);
    await cancelPopover(page);
    expect(errors).toEqual([]);
  });

  test('すでにかいた線の延長線に吸着し、要素の名前が帯に出る', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 線分1: (0,0,0)-(10,0,0)。
    await chooseSketchTool(page, '線分');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await popover(page).getByRole('button', { name: '絶対', exact: true }).first().click();
    await fillFields(page, ['10', '0', '0']);
    await commitPopover(page);
    await cancelPopover(page);

    // 新しい線分の始点を線分1から離れた場所へ置き、終点の候補として延長線の近くへ動かす。
    await chooseSketchTool(page, '線分');
    await fillFields(page, ['0', '20', '0']);
    await commitPopover(page);
    await popover(page).getByRole('button', { name: '絶対', exact: true }).first().click();
    await moveToWorldPoint(page, [14, 0.3, 0]);
    await expect(statusText(page)).toContainText('線分1 の延長線');

    await cancelPopover(page);
    expect(errors).toEqual([]);
  });
});
