/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 要件§9 P1 の完了条件「座標入力で 2D/3D の下書きが描け、面が張れる」を、実際のブラウザで
 * 通しで確かめる(計画書 docs/plans/P1-式とスケッチ.md タスク23)。**ヘッドレスで実行する。**
 *
 * 待ちは Playwright の自動待機(toBeVisible / toHaveText / toHaveCount)だけで行い、
 * 固定の sleep は置かない。面を張るときだけは幾何カーネル(Worker + OCCT)の読み込みが
 * 挟まるので、その待ちにだけ長めの上限を渡す。
 */

/** 面を張るときの幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。 */
const KERNEL_TIMEOUT_MS = 60_000;

/** √2*10 の表示(有効数字 12 桁、計画書 §2.4 と §0.a-0.7)。 */
const SQRT2_TIMES_TEN = '14.1421356237';

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
 * ツールバーの「スケッチ」区画の道具。
 * 表示スタイルにも「面」という名前のボタンがあるので、区画で絞ってから名前で引く。
 */
function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

/** その場数値入力のポップアップ。開いていないときは 0 件になる。 */
function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

/** ポップアップの式の欄。並びは指定方法ごとに X/Y/Z、ΔX/ΔY/ΔZ、距離/角度/仰角。 */
function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** 欄の下の 1 行。妥当なら評価値、間違いなら理由が出る(FR-202、FR-204)。 */
function popoverMessages(page: Page): Locator {
  return page.locator('.pcad-popover .pcad-field__message');
}

/** 欄の下に出ている赤い理由(FR-204、NFR-UX-5)。 */
function popoverErrors(page: Page): Locator {
  return page.locator('.pcad-popover .pcad-field__message--error');
}

/** 左のモデルブラウザ。 */
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

/** 右のプロパティ。 */
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

/** モデルブラウザの要素の行。名前のボタンを押すとその要素を選ぶ(FR-106、FR-501)。 */
function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

/** モデルブラウザに並んでいる要素の数。「増えていない」を数で確かめるのに使う。 */
function treeItems(page: Page): Locator {
  return page.locator('.pcad-tree__children > li');
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

/** Enter で決定する(§2.9)。焦点は必ずポップアップの欄に置いてから押す。 */
async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}

/** Esc で取消して閉じる(§2.9、NFR-UX-3)。 */
async function cancelPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

test('座標と式で点・線分をかき、面を張れる(要件§9 P1 の完了条件)', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/');
  await expect(page).toHaveTitle('PointerCAD');

  // 1) 起動直後は空で、最初の一歩を案内している(NFR-UX-6、§0.a-0.2)。
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(featureTree(page)).toContainText('まだ何もありません。');
  // 画面が隔離状態で動いている(FR-1003)。Worker から SharedArrayBuffer を使う前提。
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  // 「続けてかく」は既定で入(FR-307)。この後の線分の連続入力はこれが前提。
  await expect(
    page.getByRole('group', { name: '補助' }).getByRole('button', { name: '続けてかく', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  // 2) 点を 1 つ打つ。Y は式で入れて、式が使えることと評価値が出ることを確かめる
  //    (FR-201、FR-202、FR-301)。
  await sketchTool(page, '点').click();
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');
  await fillFields(page, ['10', '√2*10', '0']);
  // 打った瞬間に評価値が欄の下へ出る(FR-202)。
  await expect(popoverMessages(page).nth(1)).toHaveText(`= ${SQRT2_TIMES_TEN}`);
  await commitPopover(page);
  // 続けてかくが入なので、次の点の欄が開いたままになる(FR-307)。
  await expect(popover(page)).toBeVisible();
  await cancelPopover(page);

  await expect(treeRow(page, '点1')).toBeVisible();
  await expect(page.locator('.pcad-viewport__empty-state')).toHaveCount(0);

  // 選ぶと、入れた式そのものが欄に戻り(FR-202)、評価値が「計算した値」に出る。
  await treeRow(page, '点1').click();
  await expect(propertyPanel(page).locator('input.pcad-field__input').nth(1)).toHaveValue('√2*10');
  await expect(propertyPanel(page)).toContainText(SQRT2_TIMES_TEN);

  // 3) 線分を 4 本、続けてかいて閉じた四角にする(FR-304、FR-307)。
  //    始点だけ絶対で入れ、終点は既定の相対のままずれで入れる。
  await sketchTool(page, '線分').click();
  await expect(page.locator('.pcad-popover__title')).toHaveText('線分の始点');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);

  // 終点の欄は既定が相対(FR-307、numericInput.ts の defaultModeForStep)。
  await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');
  await expect(popover(page).getByRole('button', { name: '相対', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // (0,0,0) → (40,0,0)
  await fillFields(page, ['40', null, null]);
  await commitPopover(page);
  await expect(treeRow(page, '線分1')).toBeVisible();

  // → (40,30,0)。式で入れる(30/2*2 = 30)。
  await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');
  await fillFields(page, [null, '30/2*2', null]);
  await commitPopover(page);
  await expect(treeRow(page, '線分2')).toBeVisible();

  // → (0,30,0)
  await fillFields(page, ['-40', null, null]);
  await commitPopover(page);
  await expect(treeRow(page, '線分3')).toBeVisible();

  // → (0,0,0) で閉じる。
  await fillFields(page, [null, '-30', null]);
  await commitPopover(page);
  await expect(treeRow(page, '線分4')).toBeVisible();

  await cancelPopover(page);
  await expect(treeItems(page)).toHaveCount(5);

  // 4) 4 本を順に選んでから面の道具にして Enter で面を張る(FR-106、FR-309)。
  //    面の道具を選ぶとビューポートへ焦点が戻るので、選択はその前に済ませる。
  await treeRow(page, '線分1').click();
  await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
  await treeRow(page, '線分3').click({ modifiers: ['Shift'] });
  await treeRow(page, '線分4').click({ modifiers: ['Shift'] });
  await expect(propertyPanel(page)).toContainText('選んだ数');

  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');

  await expect(treeRow(page, '面1')).toBeVisible();
  await expect(treeItems(page)).toHaveCount(6);

  // 幾何カーネル(Worker + OCCT)が面を張った証拠として、返ってきた三角形の数を見る。
  await treeRow(page, '面1').click();
  await expect(propertyPanel(page)).toContainText('三角形の数', { timeout: KERNEL_TIMEOUT_MS });
  const triangleText = await propertyPanel(page).locator('.pcad-properties__value').innerText();
  expect(Number(triangleText)).toBeGreaterThanOrEqual(2);

  expect(errors).toEqual([]);
});

test('間違った式は赤い理由が出て、決定しても要素が増えない(FR-204、NFR-UX-5)', async ({
  page,
}) => {
  const errors = collectErrors(page);

  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  await sketchTool(page, '点').click();
  await expect(popover(page)).toBeVisible();

  // 0 除算。打った瞬間に赤い理由が出て、決定のボタンも使えない状態になる。
  await fillFields(page, ['1/0', null, null]);
  await expect(popoverErrors(page)).toHaveText('0 で割ることはできません。');
  await expect(popover(page).getByRole('button', { name: '決定', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await commitPopover(page);
  // 決定させず、欄は開いたまま理由も残る。
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');
  await expect(popoverErrors(page)).toHaveText('0 で割ることはできません。');

  // 決まっていない名前。位置は名前の先頭の文字で示す(1 始まり、errors.ts の describePosition)。
  await fillFields(page, ['abc', null, null]);
  await expect(popoverErrors(page)).toHaveText('決まっていない名前です: 「abc」(1 文字目)');
  await commitPopover(page);
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');

  // 直せばそのまま決められる。ここで初めて 1 件目ができることが、
  // 上の 2 回の Enter が何も作っていない証拠になる(名前が「点1」で、行も 1 つだけ)。
  await fillFields(page, ['5', null, null]);
  await expect(popoverErrors(page)).toHaveCount(0);
  await commitPopover(page);
  await cancelPopover(page);

  await expect(treeRow(page, '点1')).toBeVisible();
  await expect(treeItems(page)).toHaveCount(1);

  expect(errors).toEqual([]);
});
