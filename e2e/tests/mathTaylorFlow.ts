import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForMathEditorText } from './mathEditorReady.js';
import { savePart } from './scriptsFlow.js';

/** Series display cannot overwrite a scalar parameter or silently apply a truncated value. */
export async function mathTaylorFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('展開の確認'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('17'); await expect(result).toHaveText('= 17'); await apply.click();
  const before = await savePart(page, info, 'before-series.pcad', app);
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  for (const source of ['taylor((x-1)/(x-1),x,1,3)', 'taylor(abs(x),x,0,3)']) {
    await input.fill(source); await expectResult(result).toContainText('式の成立条件または計算結果');
    await expect(apply).toBeDisabled();
  }
  await input.fill('taylor(0*2^20000+x,x,0,3)');
  await expectResult(result).toContainText('計算量の上限に達しました'); await expect(apply).toBeDisabled();
  await input.fill('taylor((1+x)^1000000,x,0,3)');
  await expectResult(result).toContainText('166666166667000000');
  await expect(result).toContainText('499999500000'); await expect(result).toContainText('O(x^4)');
  await expect(result).not.toContainText('省略項は0'); await expect(apply).toBeDisabled();
  await input.fill('taylor(x^3,x,2,4)');
  await expectResult(result).toContainText('省略項は0'); await expect(result).toContainText('展開中心: 2');
  await expect(apply).toBeDisabled();
  await input.fill('taylor(ln(x),x,1,3)');
  await expectResult(result).toContainText('収束範囲は未確認'); await expect(apply).toBeDisabled();
  const source = 'maclaurin(1/(1-x),x,4)';
  await input.fill(source); await expectResult(result).toContainText('P4(x) = 1 + x + x^2 + x^3 + x^4');
  await expect(result).toContainText('数値誤差の上限ではありません'); await expect(result).toContainText('|x| < 1');
  await expect(apply).toBeDisabled();
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Taylor');
  await expect(dialog.getByRole('button', { name: /Taylor展開/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toContainText('P4(x)');
  await expect(apply).toBeDisabled();
  await captureManualDetail(page, info, { name: 'math-taylor', dialog, script: new URL(import.meta.url),
    fixture: { source, coefficients: [1, 1, 1, 1, 1], center: 0, degree: 4, coordinateAuthorized: false } });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Taylor展開・Maclaurin展開');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const after = await savePart(page, info, 'after-series.pcad', app);
  expect(after.parameters).toEqual(before.parameters);
  expect(after.parameters.find(parameter => parameter.name === '展開の確認')?.value).toMatchObject({ value: 17, source: '17' });
}
