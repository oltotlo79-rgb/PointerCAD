import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';

/** The same probability is selected, edited, saved and reopened in each supported host. */
export async function mathBinomialFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').nth(0).locator('input');
  await name.fill('二項確率'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await dialog.locator('textarea').fill('binomialpmf(4,1/2,2)');
  await expect(dialog.locator('[role="status"]')).toHaveText('= 0.375');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '統計' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('二項');
  await expect(dialog.getByRole('button', { name: /二項分布の確率（ちょうどk回）/u })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /二項分布の累積確率（x回以下）/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue('binomialpmf(4,1/2,2)');
  await apply.click();
  await expect(dialog).toHaveCount(0);
  const first = await savePart(page, info, 'math-binomial-probability.pcad', app);
  expect(first.parameters.find(parameter => parameter.name === '二項確率')?.value.value).toBe(0.375);

  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await dialog.locator('textarea').fill('binomialcdf(4,2,5)');
  await expect(dialog.locator('[role="status"]')).toContainText('成功確率pは0以上1以下');
  await expect(apply).toBeDisabled();
  const source = 'binomialcdf(4,1/2,5/2)';
  await dialog.locator('textarea').fill(source);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 0.6875');
  await apply.click();
  await expect(dialog).toHaveCount(0);
  const saved = await savePart(page, info, 'math-binomial-cumulative.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '二項確率')?.value.value).toBe(0.6875);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 0.375');
  await reopenPart(page, info, 'math-binomial-cumulative.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(source);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 0.6875');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('二項分布の確率を求める');
  await page.keyboard.press('Escape');
  await captureManualDetail(page, info, {
    name: 'math-binomial-cumulative', dialog, script: new URL(import.meta.url),
    fixture: { kind: 'mathematics-input-example', parameter: '二項確率', source,
      result: await dialog.locator('[role="status"]').innerText() },
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
}
