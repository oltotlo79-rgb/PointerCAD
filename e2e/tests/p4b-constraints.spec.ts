/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P4b(スケッチの仕上げ)完了済み機能のうち、**拘束の付与・矛盾・一覧・削除**
 * (FR-313)を実際のブラウザで通しで確かめる(統括の指示書「P4b タスク23 の前半(23a)」)。
 *
 * **ドラッグは書かない**(タスク14 が作業中のため。統括の指示書の範囲外)。要素の選択は
 * モデルブラウザの行を押して行う(既存の E2E と同じ流儀)。
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

/* ========================================================================== *
 * 検査
 * ========================================================================== */

test.describe('P4b 拘束(FR-313。ドラッグは対象外)', () => {
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
     * **プロパティの座標欄は解いた位置を映さない**(ヘッドレスでの実測。model は
     * 「拘束を解いた座標は文書に書かず、pointOverrides として resolveSketch へ渡す」設計
     * ── docs/plans/P4b-スケッチの仕上げ.md §0.a 追記2 ── なので、欄はもとの literal な値
     * (10,0)のまま据え置かれる。「値が効いて形が追従する」ことは、値がそのまま受け取られ
     * (欄が 20 のまま戻らない)、矛盾にならず自由度が引き続き 1 減っていることで確かめる)。
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
});
