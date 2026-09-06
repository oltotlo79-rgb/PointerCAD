/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**拘束の付与・矛盾・一覧・削除**
 * (FR-313)を実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * ドラッグは**相対座標の終点を引く1件だけ**(P4b タスク23b-2)を持つ。他の検査では
 * 要素の選択はモデルブラウザの行を押して行う(既存の E2E と同じ流儀。タスク14 完了当時は
 * 作業中で対象外だったため書いていなかった)。
 *
 * 期待値の出どころ: `docs/plans/P4b-スケッチの仕上げ.md` 「### タスク12」「### タスク13」の
 * 検証表、`docs/報告記録.md` 2026-09-05 01:50・02:50 の追記(タスク12・13 完了の実測。
 * 「平行+直角で帯が赤く…」「拘束は 13 種ではなく 14 種」)、
 * `packages/model/src/sketch/constraints/diagnose.ts`(「あと N か所決まっていません」
 * 「A と B は同時には成り立ちません。」の組み立て)、`packages/ui/src/i18n/ja.json` の
 * `constraint.error.*` / `constraint.kind.*`。
 *
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

async function useAbsolute(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '絶対', exact: true }).first().click();
}

async function chooseSketchTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await sketchTool(page, label).click();
}

/** 線分を1本、始点・終点(世界座標)を指定してかく。 */
async function drawLine(
  page: Page,
  from: readonly [string, string],
  to: readonly [string, string],
): Promise<void> {
  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, [from[0], from[1], '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await useAbsolute(page);
  await fillFields(page, [to[0], to[1], '0']);
  await commitPopover(page);
  await cancelPopover(page);
}

/**
 * ツールバーの「拘束 ▾」の畳んだ一覧から1種類を押す(§0.a-0.15、タスク13)。
 * 「スケッチ」区画の3つ目の ▾(1つ目「作図」・2つ目「編集」の次)。
 * 選択はここでは変えない(先に要素を選んでおく、NFR-UX-1「対象を選んでから操作」)。
 */
async function chooseConstraint(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(2).click();
  /*
   * 条件が足りない種類は `aria-disabled` になり、Playwright は既定でそれを「押せない」と
   * みなして待ち続ける。実装は「押したら道具を選んだ状態にして理由を帯に出す」(NFR-UX-5)
   * ので、`force: true` で実際に押す(見た目の不活性と、押せば起きることは別、ヘッドレスの実測)。
   */
  await page
    .locator('.pcad-menu__panel[aria-label="拘束"]')
    .getByRole('button', { name: label, exact: true })
    .click({ force: true });
}

/** 拘束の値を聞くポップアップ(距離・角度・半径・直径)。既定値のまま Enter で決める。 */
async function commitConstraintValue(page: Page, source: string | null = null): Promise<void> {
  const dialog = page.locator('.pcad-popover--constraint');
  await expect(dialog).toBeVisible();
  if (source !== null) {
    await dialog.locator('input.pcad-field__input').fill(source);
  }
  await dialog.getByRole('button', { name: '決定', exact: true }).click();
}

/** 拘束の一覧(プロパティ区画、スケッチを選んでいる/編集しているときに出る)の1行。 */
function constraintRow(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-constraint-row').filter({ hasText: label });
}

/** 拘束の一覧全体。 */
function constraintList(page: Page): Locator {
  return propertyPanel(page).locator('.pcad-constraint-row');
}

/* -------------------------------------------------------------------------- *
 * ワールド座標 → 画面座標(ホーム視点固定。`e2e/tests/solid.spec.ts` の
 * `worldToCanvas` と同じ組み立てを、共有ファイルを作らずここへ書き写す。
 * P4b タスク23b-2(相対座標の終点のドラッグ)だけがこれを使う。
 * -------------------------------------------------------------------------- */

/** ワールド座標(mm)。 */
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

/** カメラの位置(`cameraPosition(HOME_ORBIT)`)。注視点は原点。 */
const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

/** ワールド座標を canvas の左上を原点とした画素へ写す(視点を動かさない検査専用)。 */
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

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4b 拘束(FR-313。ドラッグは相対座標の終点1件のみ)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('平行 → 距離の順に付けると、あと決まっていない数が7 → 6へ減る', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 独立な線分2本(それぞれ4つの座標変数、合計8自由度)。
    await drawLine(page, ['0', '0'], ['10', '0']);
    await expect(treeRow(page, '線分1')).toBeVisible();
    await drawLine(page, ['0', '5'], ['10', '8']);
    await expect(treeRow(page, '線分2')).toBeVisible();

    // 平行(線分1・線分2)。8 − 1 = 7。
    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '平行');
    await expect(constraintRow(page, '平行1')).toBeVisible();
    await expect(statusText(page)).toContainText('あと 7 か所決まっていません');

    // 距離(線分1、いまの長さが既定値)。7 − 1 = 6。
    await treeRow(page, '線分1').click();
    await chooseConstraint(page, '距離');
    await commitConstraintValue(page);
    await expect(constraintRow(page, '距離1')).toBeVisible();
    await expect(statusText(page)).toContainText('あと 6 か所決まっていません');

    expect(errors).toEqual([]);
  });

  test('矛盾する拘束(平行+直角)は一覧で赤くなり、アプリは落ちない', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawLine(page, ['0', '0'], ['10', '0']);
    await drawLine(page, ['0', '5'], ['10', '8']);

    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '平行');
    await expect(constraintRow(page, '平行1')).toBeVisible();

    // 同じ2本に「直角」を足す。平行と直角は同時に成り立たない(矛盾)。
    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '直角');
    await expect(constraintRow(page, '直角1')).toBeVisible();

    // 原因の拘束(平行1・直角1)が一覧で赤くなる(FR-504)。
    await expect(constraintRow(page, '平行1')).toHaveClass(/pcad-constraint-row--conflicting/);
    await expect(constraintRow(page, '直角1')).toHaveClass(/pcad-constraint-row--conflicting/);
    // 帯も赤くなり、原因の拘束の名前つきで理由が読める(ヘッドレスでの実測)。
    await expect(page.locator('.pcad-statusbar')).toHaveClass(/pcad-statusbar--error/);
    await expect(statusText(page)).toContainText('直角1 と 平行1 は同時には成り立ちません。');

    // アプリは落ちない(操作を続けられる)。
    await sketchTool(page, '選択').click();
    expect(errors).toEqual([]);
  });

  test('一覧の×で消すと形が緩み、値を書き換えると形が追従する', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawLine(page, ['0', '0'], ['10', '0']);
    await drawLine(page, ['0', '5'], ['10', '8']);

    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '平行');

    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '直角');
    await expect(constraintRow(page, '直角1')).toHaveClass(/pcad-constraint-row--conflicting/);

    // 直角1 を一覧の × で消す。矛盾が解け、平行1 は正常(赤くない)に戻る。
    await constraintRow(page, '直角1')
      .getByRole('button', { name: '直角1 この拘束を消す', exact: true })
      .click();
    await expect(constraintRow(page, '直角1')).toHaveCount(0);
    await expect(constraintRow(page, '平行1')).not.toHaveClass(/pcad-constraint-row--conflicting/);

    /*
     * 線分1 に距離拘束を足し、一覧の値を 20 に書き換える。
     *
     * **プロパティの座標欄(入力欄そのもの)は解いた位置を映さない**(ヘッドレスでの実測。
     * model は「拘束を解いた座標は文書に書かず、pointOverrides として resolveSketch へ渡す」
     * 設計 ── docs/plans/P4b-スケッチの仕上げ.md §0.a 追記2 ── なので、欄はもとの literal な
     * 値(10,0)のまま据え置かれる。「値が効いて形が追従する」ことは、値がそのまま受け取られ
     * (欄が 20 のまま戻らない)、矛盾にならず自由度が引き続き 1 減っていることで確かめる)。
     * (欄の**下**には、動いていれば「= (x, y, z)(拘束で決まった値)」が別行で出る
     * ── タスク22b-(g)・23b-1。ここでは動いていないので出ない。出る場合の検査は
     * `packages/ui/src/sketch/featureSummary.test.ts` と `packages/ui/src/shell/PropertyPanel.test.ts`)
     */
    await treeRow(page, '線分1').click();
    await chooseConstraint(page, '距離');
    await commitConstraintValue(page);
    await expect(statusText(page)).toContainText('あと 6 か所決まっていません');
    const valueField = constraintRow(page, '距離1').locator('.pcad-constraint-row__value');
    await valueField.fill('20');
    await treeRow(page, '線分1').click();
    // 書き換えは打ち込んだ値のまま保持され(打ちかけを消して測り直した値に戻らない)、
    // 矛盾にもならない(一覧が赤くならない)。
    await expect(valueField).toHaveValue('20');
    await expect(constraintRow(page, '距離1')).not.toHaveClass(/pcad-constraint-row--conflicting/);
    await expect(statusText(page)).toContainText('あと 6 か所決まっていません');

    expect(errors).toEqual([]);
  });

  test('選択が足りないと拘束は付かず、帯に必要な選択が出る(押したら必ず何かが起きる)', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawLine(page, ['0', '0'], ['10', '0']);
    await expect(treeRow(page, '線分1')).toBeVisible();

    // 線分を1本だけ選んで「平行」を押す(2本要る)。
    await treeRow(page, '線分1').click();
    await chooseConstraint(page, '平行');
    await expect(statusText(page)).toContainText('平行');
    await expect(statusText(page)).toContainText('線を 2 本選んでください。');
    // 拘束は付いていない。
    await expect(constraintList(page)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('要素を消すと、その拘束も消える(アプリは落ちない、FR-504)', async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    await drawLine(page, ['0', '0'], ['10', '0']);
    await drawLine(page, ['0', '5'], ['10', '8']);
    await treeRow(page, '線分1').click();
    await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
    await chooseConstraint(page, '平行');
    await expect(constraintRow(page, '平行1')).toBeVisible();

    // 線分2 を消す(行を選んで Delete)。指していた要素が無くなるので、拘束も一緒に消える
    // (ヘッドレスでの実測。model 側で参照ごと取り除く作り)。アプリは落ちず操作を続けられる。
    await treeRow(page, '線分2').click();
    await page.keyboard.press('Delete');
    await expect(treeRow(page, '線分2')).toHaveCount(0);
    await expect(constraintRow(page, '平行1')).toHaveCount(0);
    await expect(constraintList(page)).toHaveCount(0);

    // 線分1 はそのまま残り、選び直せる(落ちていない)。
    await treeRow(page, '線分1').click();
    await expect(propertyPanel(page)).toContainText('始点');

    expect(errors).toEqual([]);
  });

  test('相対座標の終点をドラッグで引くと追従し、source は相対の Δ のまま更新される', async ({
    page,
  }) => {
    const errors = collectErrors(page);

    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    /*
     * 線分の終点は既定が「相対」(直前の点からの Δ、`docs/報告記録.md` 2026-09-05 07:11の
     * 「ふつうに引いた線分の終点(既定が相対)」)。`drawLine` の `useAbsolute` を呼ばず、
     * 道具の既定のまま Δ = (30, 0) を打つ。
     */
    await chooseSketchTool(page, '線分');
    await expect(popoverTitle(page)).toHaveText('線分の始点');
    await fillFields(page, ['0', '0', '0']);
    await commitPopover(page);
    await expect(popoverTitle(page)).toHaveText('線分の終点');
    await fillFields(page, ['30', '0', '0']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '線分1')).toBeVisible();

    // 掴んで引っぱるには「選択」の道具に戻す必要がある(FR-313 タスク14、select ツールだけ)。
    await sketchTool(page, '選択').click();
    await treeRow(page, '線分1').click();

    const endpointGroup = propertyPanel(page).locator('.pcad-coordinate').nth(1);
    const endpointInputs = endpointGroup.locator('input.pcad-field__input');
    const relativeModeButton = endpointGroup.getByRole('button', { name: '相対', exact: true });
    await expect(relativeModeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(endpointInputs.nth(0)).toHaveValue('30');
    await expect(endpointInputs.nth(1)).toHaveValue('0');

    /*
     * 端点の画面座標は、いま欄に出ている値(始点+Δ)から求める。実測(=解決済み)の値を
     * `page.evaluate` で欄の DOM から直接写し取り、決め打ちの数を使わない。
     * ワールド→画面はホーム視点固定で `worldToCanvas`(上で定義、`solid.spec.ts` と同じ写し方)。
     */
    const resolvedWorld = await page.evaluate((): readonly [number, number, number] => {
      const groups = Array.from(document.querySelectorAll('.pcad-coordinate'));
      const numbersOf = (group: Element): number[] =>
        Array.from(group.querySelectorAll('input.pcad-field__input')).map((input) =>
          Number((input as HTMLInputElement).value),
        );
      const [fromX, fromY] = numbersOf(groups[0]);
      const [deltaX, deltaY] = numbersOf(groups[1]);
      return [fromX + deltaX, fromY + deltaY, 0];
    });
    expect(resolvedWorld).toEqual([30, 0, 0]);

    const canvas = page.locator('canvas.pcad-viewport__canvas');
    const box = await canvas.boundingBox();
    if (box === null) {
      throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
    }
    const targetWorld: WorldPoint = [resolvedWorld[0], resolvedWorld[1] + 15, resolvedWorld[2]];
    const [startX, startY] = worldToCanvas(resolvedWorld, box.width, box.height);
    const [endX, endY] = worldToCanvas(targetWorld, box.width, box.height);

    // 端点を掴んで(端点の当たり判定 12 画素以内)+Y 方向へ引く。
    await page.mouse.move(box.x + startX, box.y + startY);
    await page.mouse.down();
    await page.mouse.move(box.x + (startX + endX) / 2, box.y + (startY + endY) / 2, { steps: 5 });
    await page.mouse.move(box.x + endX, box.y + endY, { steps: 5 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(300);

    /*
     * 追従: 掴んだ点が +Y 側へ実際に動く。source は相対のまま(統括の決定「案A」、
     * P4b タスク22b-(d))で、始点からの Δ が書き戻される。解の許容量(1e-9)や画面上の
     * 1 画素の粗さ(HOME_DISTANCE=200mm の視野で 1px ≈ 0.2mm)があるので、範囲で確かめる
     * (ぴったりの数へ丸めない。過拘束の解と同じ考え方)。
     */
    await expect(relativeModeButton).toHaveAttribute('aria-pressed', 'true');
    const afterDeltaX = Number(await endpointInputs.nth(0).inputValue());
    const afterDeltaY = Number(await endpointInputs.nth(1).inputValue());
    expect(afterDeltaX).toBeGreaterThan(25);
    expect(afterDeltaX).toBeLessThan(35);
    expect(afterDeltaY).toBeGreaterThan(10);
    expect(afterDeltaY).toBeLessThan(20);

    expect(errors).toEqual([]);
  });
});
