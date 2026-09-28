import { expect, test } from '@playwright/test';

/**
 * 再現: パラメータの名前欄に文字を打った直後(Enter を押さず)に、同じ行の
 * 「数式で入力」ボタンを押すと、ボタンの押下で窓の showModal が焦点を奪い、
 * 名前欄の blur が確定処理(改名)を走らせる。改名が終わって文書が差し替わると、
 * MathExpressionDialog の購読が「別の文書になった」と判定し、開いたばかりの
 * 窓をすぐ閉じてしまう(w104a の報告、配布物の検査 (d-2) で確認)。
 */
test.use({ viewport: { width: 1440, height: 900 } });

test('パラメータ名を打った直後に数式で入力を押しても窓が閉じない', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'パラメータ', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const row = (index: number) => page.locator('.pcad-parameter').nth(index);
  const name = (index: number) => row(index).locator('.pcad-field').nth(0).locator('input');
  const source = (index: number) => row(index).locator('.pcad-field').nth(1).locator('input');
  const result = (index: number) => row(index).locator('.pcad-field').nth(1).locator('.pcad-field__message');
  const dialog = page.locator('.pcad-math-dialog');

  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const originalName = await name(0).inputValue();

  // 名前欄へ焦点を移し、新しい名前を打つ。Enter は押さない(打ちかけのまま)。
  await name(0).click();
  await name(0).fill('打ちかけの名前');
  await expect(name(0)).toHaveValue('打ちかけの名前');

  // 打ちかけのまま、同じ行の「数式で入力」を押す。
  await row(0).getByRole('button', { name: '数式で入力', exact: true }).click();

  // 窓は閉じずに残り、操作できること。
  await expect(dialog.locator('textarea')).toBeVisible({ timeout: 10_000 });
  await dialog.locator('textarea').fill('42');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // 名前の下書きは窓を開く前に確定しており、式も適用されている。
  await expect(name(0)).toHaveValue('打ちかけの名前');
  await expect(name(0)).not.toHaveValue(originalName);
  await expect(result(0)).toHaveText('= 42');
  await expect(source(0)).toHaveValue('42');

  expect(errors).toEqual([]);
});
