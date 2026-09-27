import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';
import { captureManualDetail } from './captureManualDetail.js';

/** Exact predicates are used explicitly as conditions, and their numeric result can drive a CAD coordinate. */
export async function mathIntegerFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').nth(0).locator('input');
  await name.fill('整数条件'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await expect(dialog.locator('textarea')).toBeFocused();
  await dialog.locator('textarea').fill('isprime(1.00000000000000001)');
  await expect(dialog.locator('[role="status"]')).toContainText('丸めることはありません');
  await expect(apply).toBeDisabled();
  await dialog.locator('textarea').fill('isprime(13)');
  await expect(dialog.locator('[role="status"]')).toHaveText(uiMessage('math', 'math.boolean.true'));
  await expect(apply).toBeDisabled();
  const original = 'which(isprime(13),5,true,0)';
  await dialog.locator('textarea').fill(original);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 5');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.locator('summary').filter({ hasText: '記号と演算を探す' }).click();
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('素数');
  await expect(dialog.getByRole('button', { name: /素数か判定する/u })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /次の素数/u })).toBeVisible();
  await page.screenshot({ path: info.outputPath('math-integer-condition.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(original);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 5');
  await captureManualDetail(page, info, {
    name: 'math-integer-condition', dialog, script: new URL(import.meta.url),
    fixture: { kind: 'mathematics-input-example', parameter: '整数条件',
      source: await dialog.locator('textarea').inputValue(), result: await dialog.locator('[role="status"]').innerText() },
  });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 5');

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover');
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  const coordinateSource = 'coef("整数条件")+integerquotient(-7,3)';
  await dialog.locator('textarea').fill(coordinateSource);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  const fields = popover.locator('input.pcad-field__input');
  await fields.nth(1).fill('3'); await fields.nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const point = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(point).toBeVisible();
  const saved = await savePart(page, info, 'integer-condition-point.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '整数条件')?.value).toMatchObject({ value: 5, source: original });
  expect(saved.sketches[0].features.find(item => item.kind === 'point')).toMatchObject({ at: {
    x: { value: 2, source: coordinateSource, mathDefinition: { format: 'pointercad-math/1' } } } });

  await reopenPart(page, info, 'integer-condition-point.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(original);
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('整数の商・約数・素数・合同');
  await page.keyboard.press('Escape');
  await dialog.locator('textarea').fill('which(isprime(14),5,true,0)');
  await expect(dialog.locator('[role="status"]')).toHaveText('= 0');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 0');
  await point.click();
  const properties = page.locator('.pcad-panel--right');
  await properties.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabProperties'), exact: true }).click();
  const xLabel = uiMessage('numericInput', 'numericInput.field.x');
  await properties.getByRole('button', { name: `${xLabel}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(coordinateSource);
  await expect(dialog.locator('[role="status"]')).toHaveText('= -3');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 5');
}
